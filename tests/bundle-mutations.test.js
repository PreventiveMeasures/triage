import './_polyfills.js'
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { createManagedLocalImportSource } from '../client/managed/local-import.js'
import * as storage from '../client/storage.js'
import * as vault from '../client/passkey-vault.js'

const files = new Map()
const missing = () => new DOMException('Missing', 'NotFoundError')
let failMetadata, failRemove, heldMetadata, heldRead
const dir = {
  getFileHandle(name, { create = false } = {}) {
    if (!files.has(name)) { if (!create) throw missing(); files.set(name, new Uint8Array()) }
    return {
      getFile() {
        // OPFS File objects retain the bytes captured before a later deletion.
        const snapshot = files.get(name).slice()
        return { size: snapshot.length, arrayBuffer() {
          if (heldRead?.name === name) {
            heldRead.started.resolve()
            return heldRead.resume.promise.then(() => snapshot.buffer)
          }
          return snapshot.buffer
        } }
      },
      createWritable() {
        let pending
        return {
          write(bytes) { pending = bytes.slice() },
          async close() {
            if (name === '_meta.json') {
              if (heldMetadata) { heldMetadata.started.resolve(); await heldMetadata.resume.promise }
              if (failMetadata) throw new Error('metadata write failed')
            }
            files.set(name, pending)
          },
          abort() {},
        }
      },
    }
  },
  removeEntry(name) {
    if (name === failRemove) throw new DOMException('Cannot remove', 'NoModificationAllowedError')
    if (!files.delete(name)) throw missing()
  },
  *entries() { for (const name of [...files.keys()]) yield [name, null] },
}
navigator.storage = { getDirectory: () => ({ getDirectoryHandle: () => dir }) }
const key = integrity => integrity.replaceAll('/', '_')
beforeEach(() => {
  files.clear()
  vault.__test__.reset()
  localStorage.clear()
  heldRead = heldMetadata = failRemove = failMetadata = null
})

async function pendingImport() {
  const { integrity } = await storage.saveBundle('example.stasis', 'original bytes')
  const source = createManagedLocalImportSource()
  heldRead = { name: key(integrity), started: Promise.withResolvers(), resume: Promise.withResolvers() }
  let uploaded
  const promise = source.importItem('bundle', integrity, file => { uploaded = file })
  await heldRead.started.promise
  return { integrity, promise, source, uploaded: () => uploaded }
}

test('bundle save, rename and deletion notify by integrity, and subscriptions detach', async (t) => {
  const events = []
  const off = storage.onBundleMutated((integrity, kind) => events.push({ integrity, kind }))
  t.after(off)
  const a = await storage.saveBundle('first.map', 'original bytes')
  assert.deepEqual(events, [{ integrity: a.integrity, kind: 'save' }])
  const b = await storage.saveBundle('renamed.map', 'original bytes')
  assert.equal(a.integrity, b.integrity)
  assert.deepEqual(await storage.listBundles(), [b])
  assert.deepEqual(events.at(-1), { integrity: b.integrity, kind: 'save' })
  await storage.deleteBundle(a.integrity)
  assert.deepEqual(await storage.listBundles(), [])
  assert.deepEqual(events.at(-1), { integrity: a.integrity, kind: 'delete' })
  assert.equal(events.every(event => event.integrity === a.integrity), true)
  const count = events.length
  off()
  await storage.saveBundle('another.map', 'different bytes')
  assert.equal(events.length, count)
})

test('deleting bundle bytes cancels an OPFS snapshot import before metadata cleanup finishes', async () => {
  const current = await pendingImport()
  heldMetadata = { started: Promise.withResolvers(), resume: Promise.withResolvers() }
  const deleting = storage.deleteBundle(current.integrity)
  await heldMetadata.started.promise
  try {
    assert.equal(files.has(key(current.integrity)), false)
    heldRead.resume.resolve()
    await assert.rejects(current.promise, /bundle changed/u)
    assert.equal(current.uploaded(), undefined)
  } finally { heldMetadata.resume.resolve(); await deleting }
  assert.deepEqual(await current.source.list('bundle'), [])
})

test('metadata cleanup failure cannot allow a deleted bundle snapshot to upload', async () => {
  const current = await pendingImport()
  failMetadata = true
  await assert.rejects(storage.deleteBundle(current.integrity), /metadata write failed/u)
  heldRead.resume.resolve()
  await assert.rejects(current.promise, /bundle changed/u)
  assert.equal(current.uploaded(), undefined)
})

test('a rejected bundle deletion that leaves the bytes intact does not cancel import', async () => {
  const current = await pendingImport()
  failRemove = key(current.integrity)
  await assert.rejects(storage.deleteBundle(current.integrity), { name: 'NoModificationAllowedError' })
  heldRead.resume.resolve()
  await current.promise
  assert.equal(await current.uploaded().text(), 'original bytes')
})
