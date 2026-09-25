import './_polyfills.js'
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createManagedLocalImportSource } from '../client/managed/local-import.js'
import * as storage from '../client/storage.js'
import * as vault from '../client/passkey-vault.js'

// Independent module registries, as in a sibling tab, sharing only persisted
// bytes and origin-wide Web Locks. No focus/blur/storage event is dispatched.
const sibling = await import('../client/storage.js?background-tab')
const files = new Map()
const missing = () => new DOMException('Missing', 'NotFoundError')
let heldRead, heldWrite
const dir = {
  *entries() { for (const name of files.keys()) yield [name, { kind: 'file' }] },
  getFileHandle(name, { create = false } = {}) {
    if (!files.has(name)) { if (!create) throw missing(); files.set(name, new Uint8Array()) }
    return {
      getFile() {
        const snapshot = files.get(name).slice()
        return { size: snapshot.length, async arrayBuffer() {
          if (heldRead?.name === name) { heldRead.started.resolve(); await heldRead.resume.promise }
          return snapshot.buffer
        } }
      },
      createWritable() {
        let pending
        return { write(bytes) { pending = bytes.slice() }, async close() {
          if (heldWrite?.name === name) { heldWrite.started.resolve(); await heldWrite.resume.promise }
          files.set(name, pending)
        }, abort() {} }
      },
    }
  },
  removeEntry(name) { if (!files.delete(name)) throw missing() },
}
navigator.storage = { getDirectory: () => ({ getDirectoryHandle: () => dir }) }
const key = value => value.replaceAll('/', '_')
const hold = name => ({ name, started: Promise.withResolvers(), resume: Promise.withResolvers() })
beforeEach(() => { files.clear(); localStorage.clear(); vault.__test__.reset(); heldRead = heldWrite = null })

const operations = ['saveFile', 'saveFileBytes', 'deleteFile', 'saveBundle', 'deleteBundle']
operations.forEach(operation => {
  test(`a sibling ${operation} cannot change an import snapshot before handoff`, async () => {
    const kind = operation.endsWith('Bundle') ? 'bundle' : 'report'
    const value = kind === 'report' ? 'selected.json' : (await storage.saveBundle('selected.stasis', 'original bytes')).integrity
    if (kind === 'report') await storage.saveFile(value, 'original bytes')
    const original = files.get(key(value)).slice()
    heldRead = hold(key(value))
    const network = Promise.withResolvers()
    let uploaded
    const importing = createManagedLocalImportSource().importItem(kind, value, file => {
      assert.deepEqual(files.get(key(value)), original, 'disk still matches the snapshot at upload handoff')
      uploaded = file
      return network.promise
    })
    await heldRead.started.promise
    let changed = false
    const mutation = operation === 'saveFile' ? sibling.saveFile(value, 'replacement bytes')
      : operation === 'saveFileBytes' ? sibling.saveFileBytes(value, new TextEncoder().encode('replacement bytes'))
      : operation === 'saveBundle' ? sibling.saveBundle('renamed.stasis', 'original bytes')
      : sibling[operation](value)
    const writing = mutation.then(() => { changed = true; return changed })
    try {
      // An unrelated item completes while the selected item's writer waits.
      await sibling.saveFile('unrelated.json', 'unrelated bytes')
      assert.equal(changed, false)
      assert.equal(uploaded, undefined)
      heldRead.resume.resolve()
      await writing
      assert.equal(await uploaded.text(), 'original bytes')
      if (operation.startsWith('delete')) assert.equal(files.has(key(value)), false)
      // Awaiting the writer before resolving the server response proves the
      // import lock was released at handoff, not after the network operation.
    } finally { heldRead.resume.resolve(); network.resolve(); await importing; await writing }
  })
})

test('an import waits for an already-running sibling replacement and reads its new bytes', async () => {
  const value = 'selected.json'
  await storage.saveFile(value, 'original bytes')
  heldWrite = hold(value)
  const writing = sibling.saveFileBytes(value, new TextEncoder().encode('replacement bytes'))
  await heldWrite.started.promise
  let uploaded
  const importing = createManagedLocalImportSource().importItem('report', value, file => { uploaded = file })
  try {
    await setImmediate()
    assert.equal(uploaded, undefined)
  } finally { heldWrite.resume.resolve(); await writing; await importing }
  assert.equal(await uploaded.text(), 'replacement bytes')
})

test('read, upload and abort failures release the selected item lock', async () => {
  for (const failure of ['corrupt', 'upload', 'abort']) {
    const value = `failure-${failure}.json`
    await storage.saveFile(value, 'original bytes')
    const source = createManagedLocalImportSource()
    const abort = new AbortController()
    if (failure === 'corrupt') files.set(value, new Uint8Array())
    if (failure === 'abort') abort.abort()
    await assert.rejects(source.importItem('report', value, () => Promise.reject(new Error('upload failed')), { signal: abort.signal }))
    await sibling.saveFile(value, 'replacement bytes')
    assert.equal(await storage.readFileFresh(value), 'replacement bytes')
  }
})
