import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { diskStores } from './_managed-storage.js'

const source = Buffer.from(JSON.stringify({ sourcesContent: ['export default "hello €😀";\n'.repeat(100)] }))

test('sourcemaps have only .map.br storage and survive restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-bundle-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const id = randomUUID(), { bundleStore: store } = await diskStores(t, dir)
  await store.put(id, source, 'sourcemap')
  assert.deepEqual(await readdir(join(dir, 'bundles')), [`${id}.map.br`])
  const encoded = await readFile(join(dir, 'bundles', `${id}.map.br`))
  assert.ok(encoded.length < source.length)
  assert.deepEqual(brotliDecompressSync(encoded), source)
  const { bundleStore: restarted } = await diskStores(t, dir)
  assert.deepEqual(await restarted.get(id, 'sourcemap'), encoded)
  await restarted.delete(id)
  assert.equal(await restarted.get(id, 'sourcemap'), null)
  assert.deepEqual(await readdir(join(dir, 'bundles')), [])
})

test('parallel opens of large bundles inspect only a bounded prefix and keep the payload streaming', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-bundle-stream-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { bundleStore: store, raw } = await diskStores(t, dir)
  t.mock.method(store, 'get', () => { throw new Error('must not buffer source bytes') })
  const openRaw = raw.open.bind(raw), sources = []
  t.mock.method(raw, 'open', async (...args) => {
    const stored = await openRaw(...args)
    sources.push(stored.stream)
    return stored
  })
  await mkdir(join(dir, 'bundles'))
  for (const kind of ['stasis', 'sourcemap']) {
    const id = randomUUID(), size = 256 * 1024 * 1024
    const path = `bundles/${id}${kind === 'sourcemap' ? '.map.br' : ''}`
    const file = await open(join(dir, path), 'w')
    await file.truncate(size); await file.close()
    const untouched = await openRaw(path)
    assert.equal(untouched.stream.bytesRead, 0, 'the raw backend stays paused until header inspection')
    const untouchedClosed = once(untouched.stream, 'close')
    untouched.stream.destroy()
    await untouchedClosed
    assert.equal(untouched.stream.bytesRead, 0)

    sources.length = 0
    const streams = await Promise.all(Array.from({ length: 8 }, () => store.open(id, kind)))
    for (const stored of streams) {
      assert.equal(stored.size, size)
      assert.equal(stored.stream.readableLength, 0)
      const closed = once(stored.stream, 'close')
      stored.stream.destroy()
      await closed
    }
    for (const input of sources) {
      if (!input.closed) await once(input, 'close')
      assert.ok(input.bytesRead > 0, 'the encryption boundary inspected the header')
      assert.ok(input.bytesRead <= input.readableHighWaterMark * 2, 'header inspection and read-ahead stay bounded')
    }
    const stored = await store.open(id, kind)
    const readable = once(stored.stream, 'readable')
    stored.stream.read(1)
    await readable
    assert.ok(stored.stream.readableLength > 0)
    assert.ok(stored.stream.readableLength <= sources.at(-1).readableHighWaterMark, 'paused reader bounds read-ahead')
    const finished = once(stored.stream, 'close')
    stored.stream.destroy()
    await finished
  }
})
