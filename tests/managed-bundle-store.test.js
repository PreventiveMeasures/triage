import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { createDiskBlobStore } from '../server-managed/blob-store.ts'
import { createBundleStore, createDiskBundleStore } from '../server-managed/bundle-store.ts'

const source = Buffer.from(JSON.stringify({ sourcesContent: ['export default "hello €😀";\n'.repeat(100)] }))

test('sourcemaps have only .map.br storage and survive restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-bundle-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const id = randomUUID(), store = createDiskBundleStore(dir)
  await store.put(id, source, 'sourcemap')
  assert.deepEqual(await readdir(dir), [`${id}.map.br`])
  const encoded = await readFile(join(dir, `${id}.map.br`))
  assert.ok(encoded.length < source.length)
  assert.deepEqual(brotliDecompressSync(encoded), source)
  const restarted = createDiskBundleStore(dir)
  assert.deepEqual(await restarted.get(id, 'sourcemap'), encoded)
  await restarted.delete(id)
  assert.equal(await restarted.get(id, 'sourcemap'), null)
  assert.deepEqual(await readdir(dir), [])
})

test('parallel opens of large stored bundles use paused file streams without buffered reads', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-bundle-stream-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const originals = createDiskBlobStore(dir), sourcemaps = createDiskBlobStore(dir, '.map.br')
  const store = createBundleStore(originals, sourcemaps)
  t.mock.method(originals, 'get', () => { throw new Error('must not buffer source bytes') })
  t.mock.method(sourcemaps, 'get', () => { throw new Error('must not buffer source bytes') })
  for (const kind of ['stasis', 'sourcemap']) {
    const id = randomUUID(), size = 256 * 1024 * 1024
    const file = await open(join(dir, id + (kind === 'sourcemap' ? '.map.br' : '')), 'w')
    await file.truncate(size); await file.close()
    const streams = await Promise.all(Array.from({ length: 8 }, () => store.open(id, kind)))
    for (const stored of streams) {
      assert.equal(stored.size, size)
      assert.equal(stored.stream.bytesRead, 0)
      assert.equal(stored.stream.readableLength, 0)
      const closed = once(stored.stream, 'close')
      stored.stream.destroy()
      await closed
      assert.equal(stored.stream.bytesRead, 0, 'HEAD-style close never reads the body')
    }
    const stored = await store.open(id, kind)
    const readable = once(stored.stream, 'readable')
    stored.stream.read(1)
    await readable
    assert.ok(stored.stream.bytesRead > 0)
    assert.ok(stored.stream.bytesRead <= stored.stream.readableHighWaterMark, 'paused reader bounds read-ahead')
    const closed = once(stored.stream, 'close')
    stored.stream.destroy()
    await closed
  }
})
