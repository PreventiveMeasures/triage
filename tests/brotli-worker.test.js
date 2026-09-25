// Browsers without native `DecompressionStream('br')` decode stasis
// bundles with the bundled foliojs decoder, which is synchronous and
// spends seconds on a multi-MB bundle — on the main thread that is
// seconds of frozen tab. `ui/view/brotli-decompress.js` runs it in a
// dedicated worker instead; this covers the dispatch contract around
// that worker: one worker for the session, decoder errors surfaced
// rather than retried, and a dead worker handing the payload back to
// the main thread.
//
// The cases run in order: the "worker died" case latches the module's
// give-up flag for the rest of the file, so it has to come last.

import assert from 'node:assert/strict'
import { it } from 'node:test'

// Force the fallback path. Node has no brotli on DecompressionStream
// either, but pin the failure so this can't start testing the native
// branch on a runtime that grows one. Detection runs once, eagerly,
// at module load — hence before the import below.
globalThis.DecompressionStream = class {
  constructor(format) { throw new TypeError(`unsupported format: ${format}`) }
}

const spawned = []
// Per-test worker behaviour: given the posted job, returns the message
// to answer with, or 'die' to fail the worker the way a chunk that
// won't load or run does.
let answer = null

globalThis.Worker = class FakeWorker {
  constructor(url, options) {
    this.url = String(url)
    this.options = options
    this.listeners = new Map()
    this.posted = []
    this.terminated = false
    spawned.push(this)
  }

  addEventListener(type, fn) {
    const forType = this.listeners.get(type) ?? []
    forType.push(fn)
    this.listeners.set(type, forType)
  }

  emit(type, event) {
    for (const fn of this.listeners.get(type) ?? []) fn(event)
  }

  postMessage(job) {
    this.posted.push(job)
    queueMicrotask(() => {
      const reply = answer(job)
      if (reply === 'die') this.emit('error', { message: 'worker failed to load' })
      else this.emit('message', { data: reply })
    })
  }

  terminate() { this.terminated = true }
}

const { brotliDecompress } = await import('../ui/view/brotli-decompress.js')

const decoded = (job) => ({ id: job.id, bytes: new TextEncoder().encode(`decoded:${job.bytes.byteLength}`) })
const payload = () => new Uint8Array([0x1b, 0x2e, 0x00, 0x00, 0x24])

it('does not load the decoder after its caller stops allowing local bundle reads', async () => {
  await assert.rejects(brotliDecompress(payload(), () => false), { name: 'AbortError' })
  let current = true
  const pending = brotliDecompress(payload(), () => current)
  current = false
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(spawned.length, 0)
})

it('decodes in a worker, and keeps using the same one', async () => {
  answer = decoded
  const bytes = payload()
  assert.deepEqual(await brotliDecompress(bytes), new TextEncoder().encode('decoded:5'))
  assert.equal(spawned.length, 1)
  const worker = spawned[0]
  // The chunk sits beside the bundle that loaded it, and is a module
  // (esbuild writes ESM for every entry point — see build.js).
  assert.match(worker.url, /\/brotli-fallback\.js$/u)
  assert.deepEqual(worker.options, { type: 'module' })
  // The compressed bytes are handed over by copy: bundle-load.js still
  // reports `bytes.byteLength` as the bundle's size once this resolves,
  // so transferring the buffer would leave it reading a detached zero.
  assert.equal(bytes.byteLength, 5)
  assert.equal(worker.posted[0].bytes, bytes)

  await brotliDecompress(payload())
  assert.equal(spawned.length, 1, 'the 200KB decoder chunk loads once per session')
  assert.equal(worker.posted.length, 2)
})

it('surfaces a decode failure instead of repeating it on the main thread', async () => {
  answer = (job) => ({ id: job.id, error: 'brotli: invalid symbols' })
  await assert.rejects(brotliDecompress(payload()), /brotli: invalid symbols/u)
  // A corrupt payload says nothing about the worker, which stays up
  // for the next bundle.
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].terminated, false)
  answer = decoded
  assert.deepEqual(await brotliDecompress(payload()), new TextEncoder().encode('decoded:5'))
  assert.equal(spawned.length, 1)
})

it('falls back to the main thread when the worker dies', async () => {
  let current = true
  answer = () => { current = false; return 'die' }
  await assert.rejects(brotliDecompress(payload(), () => current), { name: 'AbortError' })
  assert.equal(spawned[0].terminated, true, 'a cancelled worker failure does not start the main-thread fallback')
  answer = () => 'die'
  // In-flight work is re-run by the main-thread decoder, which imports
  // the chunk as a sibling of the page bundle — a path that only
  // exists in a built deploy, so reaching this error is what proves
  // the in-page decoder, not the worker, was asked to finish the job.
  await assert.rejects(brotliDecompress(payload()), (err) => {
    assert.equal(err.code, 'ERR_MODULE_NOT_FOUND')
    assert.match(err.message, /brotli-fallback\.js/u)
    return true
  })
  assert.equal(spawned[0].terminated, true)
  // And the worker isn't retried for every later bundle.
  await assert.rejects(brotliDecompress(payload()), { code: 'ERR_MODULE_NOT_FOUND' })
  assert.equal(spawned.length, 1)
})
