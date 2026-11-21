// Brotli decompressor, in order of preference:
//   1. native `DecompressionStream('br' | 'brotli')` (Chromium 138+);
//   2. `brotli-fallback.js`, a separate esbuild entry bundling the foliojs
//      decoder (~200KB), run in a dedicated worker: it is synchronous and
//      takes seconds on a multi-MB bundle, so the tab keeps painting. Only
//      started when a brotli payload arrives and native detection failed;
//      its URL is built at runtime (so esbuild doesn't bundle the chunk)
//      against `import.meta.url` (so a subdirectory deploy finds it);
//   3. the same chunk imported on the main thread, when no worker can run
//      it (CSP without `worker-src`, no module workers, worker died).
// Init also drops any `/brotli-sw.js` left by an earlier SW-based fallback.

import { trustedScriptURL } from './trusted-types.js'

let initPromise = null
let fallbackPromise = null

function nativeAvailable() {
  for (const fmt of ['br', 'brotli']) {
    try {
      // eslint-disable-next-line no-new
      new DecompressionStream(fmt)
      return fmt
    } catch {}
  }
  return null
}

async function decompressNative(format, bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function unregisterSW() {
  if (!('serviceWorker' in navigator)) return
  try {
    const regs = await navigator.serviceWorker.getRegistrations()
    for (const reg of regs) {
      const url = reg.active?.scriptURL ?? reg.installing?.scriptURL ?? reg.waiting?.scriptURL
      if (url && url.endsWith('/brotli-sw.js')) await reg.unregister()
    }
  } catch {}
}

// The worker script, and the module imported when no worker can run it.
const FALLBACK_PATH = './brotli-fallback.js'

// "The worker didn't take this job" (never spawned, refused, or died) —
// unlike a rejection, which is the decoder throwing on the payload, and
// would only throw again on the main thread.
const WORKER_UNAVAILABLE = Symbol('brotli worker unavailable')

// One worker per session, kept alive so the chunk loads once.
let worker = null
let workerUnusable = false
let nextJobId = 0
const jobs = new Map()

function loadFallback() {
  // Through a variable, so esbuild can't resolve it into view.js.
  const path = FALLBACK_PATH
  return (fallbackPromise ??= import(path))
}

// Give up on the worker for the session (the script failed to load or run
// — older browsers ignore `type: 'module'` and choke on its `export` — or
// a message couldn't be cloned or posted) and hand its jobs back.
function retireWorker() {
  workerUnusable = true
  if (worker) {
    worker.terminate()
    worker = null
  }
  const pending = [...jobs.values()]
  jobs.clear()
  for (const job of pending) job.resolve(WORKER_UNAVAILABLE)
}

function onWorkerMessage(event) {
  const { id, bytes, error } = event.data ?? {}
  const job = jobs.get(id)
  if (!job) return
  jobs.delete(id)
  if (error) job.reject(new Error(error))
  else job.resolve(bytes)
}

function spawnWorker() {
  if (worker) return worker
  if (workerUnusable || typeof Worker === 'undefined') return null
  try {
    // A module worker, as esbuild writes the entry (build.js). The URL goes
    // through the app's Trusted Types policy: index.html's CSP refuses a
    // plain one.
    worker = new Worker(trustedScriptURL(new URL(FALLBACK_PATH, import.meta.url)), { type: 'module' })
  } catch {
    workerUnusable = true
    return null
  }
  worker.addEventListener('message', onWorkerMessage)
  worker.addEventListener('error', retireWorker)
  worker.addEventListener('messageerror', retireWorker)
  return worker
}

function decompressInWorker(bytes) {
  const active = spawnWorker()
  if (!active) return Promise.resolve(WORKER_UNAVAILABLE)
  return new Promise((resolve, reject) => {
    const id = ++nextJobId
    jobs.set(id, { resolve, reject })
    try {
      // Copied, not transferred: the caller still reads `bytes.byteLength`
      // after (bundle-load.js reports it as the on-disk size).
      // eslint-disable-next-line unicorn/require-post-message-target-origin
      active.postMessage({ id, bytes })
    } catch {
      jobs.delete(id)
      retireWorker()
      resolve(WORKER_UNAVAILABLE)
    }
  })
}

// The native format, or null for the fallback.
function ensure() {
  return (initPromise ??= unregisterSW().then(nativeAvailable))
}

export async function brotliDecompress(bytes, isCurrent = () => true) {
  const check = () => { if (!isCurrent()) throw new DOMException('Bundle decode cancelled', 'AbortError') }
  check()
  const format = await ensure()
  check()
  if (format) return decompressNative(format, bytes)
  const decoded = await decompressInWorker(bytes)
  check()
  if (decoded !== WORKER_UNAVAILABLE) return decoded
  const fallback = await loadFallback()
  return fallback.brotliDecompress(bytes)
}

// Eager detection at load; the worker and the fallback chunk stay on demand.
ensure().catch(() => {})
