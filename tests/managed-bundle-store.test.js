import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { createDiskBlobStore } from '../server-managed/blob-store.ts'
import { createBundleStore, createDiskBundleStore } from '../server-managed/bundle-store.ts'

const source = Buffer.from(JSON.stringify({ sourcesContent: ['export default "hello €😀";\n'.repeat(100)] }))

function memoryStore() {
  const entries = new Map()
  return {
    put: (id, bytes) => { entries.set(id, bytes); return Promise.resolve() },
    get: id => Promise.resolve(entries.get(id) ?? null),
    delete: id => { entries.delete(id); return Promise.resolve() },
  }
}

test('sourcemaps have only .map.br storage, survive restart, and migrate legacy raw files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-bundle-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const id = randomUUID(), legacyId = randomUUID(), store = createDiskBundleStore(dir)
  await store.put(id, source, 'sourcemap')
  assert.deepEqual(await readdir(dir), [`${id}.map.br`])
  const encoded = await readFile(join(dir, `${id}.map.br`))
  assert.ok(encoded.length < source.length)
  assert.deepEqual(brotliDecompressSync(encoded), source)
  const restarted = createDiskBundleStore(dir)
  assert.deepEqual(await restarted.get(id, 'sourcemap'), encoded)
  const original = createDiskBlobStore(dir)
  await original.put(legacyId, source)
  const migrated = await restarted.get(legacyId, 'sourcemap')
  assert.deepEqual(brotliDecompressSync(migrated), source)
  assert.deepEqual((await readdir(dir)).toSorted(), [`${id}.map.br`, `${legacyId}.map.br`].toSorted())
  await restarted.delete(legacyId)
  assert.equal(await restarted.get(legacyId, 'sourcemap'), null)
  assert.deepEqual(await readdir(dir), [`${id}.map.br`])
})

test('failed compression publication keeps raw bytes; interrupted cleanup resumes without recompression', async t => {
  const originals = memoryStore(), sourcemaps = memoryStore()
  const store = createBundleStore(originals, sourcemaps)
  await originals.put('id', source)
  const publish = t.mock.method(sourcemaps, 'put', () => Promise.reject(new Error('disk full')))
  await assert.rejects(store.get('id', 'sourcemap'), /disk full/u)
  assert.deepEqual(await originals.get('id'), source)
  publish.mock.restore()
  const remove = t.mock.method(originals, 'delete', () => Promise.reject(new Error('cleanup failed')))
  await assert.rejects(store.get('id', 'sourcemap'), /cleanup failed/u)
  const encoded = await sourcemaps.get('id')
  assert.deepEqual(brotliDecompressSync(encoded), source)
  assert.deepEqual(await originals.get('id'), source)
  remove.mock.restore()
  t.mock.method(sourcemaps, 'put', () => Promise.reject(new Error('must reuse published bytes')))
  const restarted = createBundleStore(originals, sourcemaps)
  assert.deepEqual(await restarted.get('id', 'sourcemap'), encoded)
  assert.equal(await originals.get('id'), null)
})

test('concurrent migration reads share one encoding and deletion waits for publication', async t => {
  const originals = memoryStore(), sourcemaps = memoryStore()
  const store = createBundleStore(originals, sourcemaps)
  await originals.put('id', source)
  const gate = Promise.withResolvers(), publish = sourcemaps.put, started = Promise.withResolvers()
  const writes = t.mock.method(sourcemaps, 'put', async (...args) => {
    started.resolve(); await gate.promise; return publish(...args)
  })
  const first = store.get('id', 'sourcemap'), second = store.get('id', 'sourcemap')
  await started.promise
  const deleted = store.delete('id')
  gate.resolve()
  assert.deepEqual(await first, await second)
  await deleted
  assert.equal(writes.mock.callCount(), 1)
  assert.equal(await originals.get('id'), null)
  assert.equal(await sourcemaps.get('id'), null)
  assert.equal(await store.get('id', 'sourcemap'), null)
})
