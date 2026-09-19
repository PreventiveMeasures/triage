import './_polyfills.js'
import assert from 'node:assert/strict'
import { beforeEach, it } from 'node:test'
import { gunzipBytes } from '../common/gzip.js'
import { hasEnvelopeMagic, importContentKey, openEnvelope, sealEnvelope } from '../client/passkey-crypto.ts'
import * as vault from '../client/passkey-vault.js'
import * as storage from '../client/storage.js'

const files = new Map()
const missing = () => new DOMException('Missing', 'NotFoundError')
const dir = {
  getFileHandle(name, { create = false } = {}) {
    if (!files.has(name)) { if (!create) throw missing(); files.set(name, new Uint8Array()) }
    return {
      getFile: () => ({ size: files.get(name).length, arrayBuffer: () => files.get(name).slice().buffer }),
      createWritable: () => {
        let pending
        return { write: (bytes) => { pending = bytes.slice() }, close: () => files.set(name, pending), abort: () => {} }
      },
    }
  },
  removeEntry(name) { if (!files.delete(name)) throw missing() },
  *entries() { for (const name of [...files.keys()]) yield [name, null] },
}
navigator.storage = { getDirectory: () => ({ getDirectoryHandle: () => dir }) }
const indexKey = (integrity) => integrity.replaceAll('/', '_') + '.index-v1'
const sample = { version: 1, files: Array.from({ length: 100 }, (_, i) => [`src/module${i}.js`, 200, 'hash']) }
beforeEach(() => { files.clear(); vault.__test__.reset(); localStorage.clear() })

it('stores gzipped metadata separately under bundle integrity and removes it with the bundle', async () => {
  const { integrity } = await storage.saveBundle('example.map', '{"sources":[]}')
  assert.equal(await storage.readBundleIndex(integrity), null)
  await storage.saveBundleIndex(integrity, sample)
  const bytes = files.get(indexKey(integrity))
  assert.deepEqual([...bytes.slice(0, 2)], [0x1f, 0x8b])
  assert.ok(bytes.length < JSON.stringify(sample).length / 2)
  assert.deepEqual(await storage.readBundleIndex(integrity), sample)
  assert.equal((await storage.listBundles()).length, 1, 'derived index is not a bundle list entry')
  await storage.deleteBundle(integrity)
  assert.equal(files.has(indexKey(integrity)), false)
  await assert.rejects(storage.saveBundleIndex(integrity, sample), { name: 'NotFoundError' })
  assert.equal(files.has(indexKey(integrity)), false, 'late index write cannot resurrect a deleted bundle')
})

it('compresses before encryption and binds the envelope to the integrity and index slot', async () => {
  const key = await importContentKey(new Uint8Array(32).fill(42))
  vault.__test__.setSessionKeyForTesting(key)
  const { integrity } = await storage.saveBundle('example.map', '{"sources":[]}')
  await storage.saveBundleIndex(integrity, sample)
  const envelope = files.get(indexKey(integrity))
  assert.ok(hasEnvelopeMagic(envelope))
  const compressed = await vault.openForBundle(envelope, integrity + '.index-v1')
  assert.deepEqual([...compressed.slice(0, 2)], [0x1f, 0x8b])
  assert.deepEqual(JSON.parse(new TextDecoder().decode(await gunzipBytes(compressed))), sample)
  assert.deepEqual(await storage.readBundleIndex(integrity), sample)
  await assert.rejects(vault.openForBundle(envelope, integrity), /./u)
  files.set(indexKey('sha512-other'), envelope)
  assert.equal(await storage.readBundleIndex('sha512-other'), null, 'swapped integrity fails authentication')
  files.set(indexKey(integrity), envelope.map((byte, i) => i === envelope.length - 1 ? byte ^ 1 : byte))
  assert.equal(await storage.readBundleIndex(integrity), null, 'corrupt cache falls back to rebuilding')
})

it('includes the compressed index in both encryption migrations', async () => {
  const { integrity } = await storage.saveBundle('example.map', '{"sources":[]}')
  await storage.saveBundleIndex(integrity, sample)
  const compressed = files.get(indexKey(integrity)).slice()
  const key = await importContentKey(new Uint8Array(32).fill(42))
  vault.__test__.setSessionKeyForTesting(key)
  await navigator.locks.request('deepview.passkey.v1.write', () => storage.migrateOpfsBundlesEncrypt({ seal: (bytes, aad) => sealEnvelope(key, bytes, aad) }))
  assert.ok(hasEnvelopeMagic(files.get(indexKey(integrity))))
  assert.deepEqual(await storage.readBundleIndex(integrity), sample)
  await navigator.locks.request('deepview.passkey.v1.write', () => storage.migrateOpfsBundlesDecrypt({ open: (bytes, aad) => openEnvelope(key, bytes, aad) }))
  assert.deepEqual(files.get(indexKey(integrity)), compressed)
  vault.__test__.reset()
  assert.deepEqual(await storage.readBundleIndex(integrity), sample)
})

it('refuses reads and plaintext writes while encryption is enabled but locked', async () => {
  const { integrity } = await storage.saveBundle('example.map', '{"sources":[]}')
  await storage.saveBundleIndex(integrity, sample)
  const before = files.get(indexKey(integrity)).slice()
  localStorage.setItem('deepview.passkey.v1', JSON.stringify({ enabled: true, credentialId: 'test', prfSalt: 'test', userId: 'test' }))
  assert.equal(await storage.readBundleIndex(integrity), null)
  await assert.rejects(storage.saveBundleIndex(integrity, sample), /locked/u)
  assert.deepEqual(files.get(indexKey(integrity)), before)
})
