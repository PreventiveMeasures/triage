// Brotli decompressor — native first, with a lazy-loaded JS
// fallback for browsers that don't ship brotli on the streams API.
//
//   1. `DecompressionStream('br')` / `'brotli'` — modern Chromium
//      (138+) ships brotli natively. No extra cost on those
//      browsers, and the decode runs inside the browser's stream
//      implementation, off the main thread already.
//   2. `brotli-fallback.js` — a separate esbuild entry point that
//      bundles the foliojs `brotli` decoder (~200KB after minify).
//      That decoder is synchronous and runs for seconds on a
//      multi-MB bundle, so it is spawned as a dedicated worker and
//      the main thread only waits on a message: the tab keeps
//      painting and answering input while a bundle decodes.
//      The worker starts only when the page actually hits a brotli
//      payload AND native detection failed. Its URL is built from a
//      runtime string so esbuild doesn't statically resolve the
//      chunk into the main bundle, and is resolved against
//      `import.meta.url` so a subdirectory deploy still finds the
//      sibling chunk.
//   3. `await import('./brotli-fallback.js')` on the main thread —
//      last resort for when no worker can be spawned at all (a CSP
//      without `worker-src`, a browser that can't run module
//      workers) or the worker died. Blocks the tab for the decode,
//      which still beats refusing to open the bundle.
//
// `unregisterSW()` runs on every init to clean up any leftover
// `/brotli-sw.js` from a prior SW-based fallback revision.

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

// Drop any leftover `/brotli-sw.js` registration. Idempotent — does
// nothing when no such SW is registered. Always awaited from init
// so callers don't observe the SW lingering in DevTools.
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

// The chunk that carries the JS decoder, used both as the worker
// script and — when no worker can run it — as a plain module import.
const FALLBACK_PATH = './brotli-fallback.js'

// Resolution value for "the worker didn't take this job" (never
// spawned, spawn refused, or it died before answering). Distinct
// from a rejection, which means the decoder itself threw: that is
// the payload's fault and re-running it on the main thread would
// only throw the same thing, slower.
const WORKER_UNAVAILABLE = Symbol('brotli worker unavailable')

// One worker per session, spawned on the first fallback decode and
// kept alive afterwards so the 200KB chunk is downloaded + parsed
// once and back-to-back bundle opens reuse it.
let worker = null
let workerUnusable = false
let nextJobId = 0
const jobs = new Map()

function loadFallback() {
  if (fallbackPromise) return fallbackPromise
  fallbackPromise = (async () => {
    // The path is held in a variable so esbuild can't statically
    // resolve it — that keeps `brotli-fallback.js` (and the
    // foliojs/brotli decoder it pulls in) out of the main view.js
    // bundle. The browser resolves the URL relative to the page,
    // so it works at any deploy path (root or subdirectory).
    const path = FALLBACK_PATH
    return await import(path)
  })()
  return fallbackPromise
}

// Give up on the worker for the rest of the session and hand every
// job it still owes back to the main-thread decoder. Called when the
// script fails to load or run (older browsers ignore `type:
// 'module'` and choke on the chunk's `export`), when a message can't
// be cloned, and when posting throws.
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
    // `type: 'module'` matches the ESM esbuild writes for the entry
    // point (see build.js). A browser that ignores the option loads
    // the chunk as a classic script, fails on its `export`, and
    // fires `error` below — which retires the worker and sends the
    // decode back to the main thread.
    worker = new Worker(new URL(FALLBACK_PATH, import.meta.url), { type: 'module' })
  } catch {
    workerUnusable = true
    return null
  }
  worker.addEventListener('message', onWorkerMessage)
  worker.addEventListener('error', retireWorker)
  worker.addEventListener('messageerror', retireWorker)
  return worker
}

// Decode off-thread. Resolves with `WORKER_UNAVAILABLE` when no
// worker ran the job; rejects only when the decoder itself threw.
function decompressInWorker(bytes) {
  const active = spawnWorker()
  if (!active) return Promise.resolve(WORKER_UNAVAILABLE)
  return new Promise((resolve, reject) => {
    const id = ++nextJobId
    jobs.set(id, { resolve, reject })
    try {
      // `bytes` is copied, not transferred: the caller still reads
      // `bytes.byteLength` after this resolves (bundle-load.js
      // reports it as the bundle's on-disk size) and transferring
      // would detach the buffer out from under it.
      // eslint-disable-next-line unicorn/require-post-message-target-origin
      active.postMessage({ id, bytes })
    } catch {
      jobs.delete(id)
      retireWorker()
      resolve(WORKER_UNAVAILABLE)
    }
  })
}

async function init() {
  // Always cleanup leftover SW first so a non-functional registration
  // from an earlier deploy is dropped regardless of which mode this
  // load picks. Cheap when there's nothing to unregister.
  await unregisterSW()
  const format = nativeAvailable()
  if (format) return { kind: 'native', format }
  return { kind: 'fallback' }
}

function ensure() {
  if (initPromise) return initPromise
  initPromise = init()
  return initPromise
}

export async function brotliDecompress(bytes, isCurrent = () => true) {
  const check = () => { if (!isCurrent()) throw new DOMException('Bundle decode cancelled', 'AbortError') }
  check()
  const m = await ensure()
  check()
  if (m.kind === 'native') return decompressNative(m.format, bytes)
  // Fallback path: run the JS decoder in the worker, which also
  // lazy-loads the bundle on first use — subsequent calls reuse the
  // same worker, so the chunk downloads + parses once per session.
  const decoded = await decompressInWorker(bytes)
  check()
  if (decoded !== WORKER_UNAVAILABLE) return decoded
  // No worker took it. Decode here and block, sharing one import so
  // the chunk still only downloads once.
  const fallback = await loadFallback()
  return fallback.brotliDecompress(bytes)
}

// Eager init at module-load — runs the SW cleanup + native
// detection without waiting for the first stasis bundle open. Does
// NOT start the worker or pre-load the fallback bundle: that only
// happens on demand when a brotli payload actually needs
// decompressing.
ensure().catch(() => {})
