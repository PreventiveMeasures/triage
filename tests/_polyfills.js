// Test-only polyfills for browser globals the client modules
// depend on. Importing this module from a test installs missing
// shims; importing it twice is safe (idempotent guards).
//
// Currently shims:
//   - localStorage  — a Map-backed approximation of the Storage
//     API (the tests don't exercise the cross-tab `storage` event,
//     so a synchronous in-memory shim is enough for the
//     deterministic-path checks).
//   - navigator.locks — a same-origin Web Locks shim. Sufficient
//     for unit-test verification of any code that depends on
//     `navigator.locks.request(name, fn)` to serialise async
//     work. Each lock keeps a per-name FIFO promise chain so
//     concurrent `request` calls run their callbacks in order;
//     individual callbacks may resolve out-of-order, just not
//     run interleaved. Node 24+ has native `navigator.locks`, so
//     this only takes effect on the older Node versions the
//     local test loop covers.

function createLocalStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    clear: () => { store.clear() },
    get length() { return store.size },
    key: (i) => Array.from(store.keys())[i] ?? null,
  }
}

if (globalThis.localStorage === undefined) {
  globalThis.localStorage = createLocalStorage()
}

// `navigator` exists on Node 22+ but with a tiny surface — no
// `locks`. Native `navigator.locks` lands in Node 24. The
// production code (`saveTriage`, `mutateAllSessions`,
// `mutateWorkspaces`, bundle `_meta.json` RMW) calls
// `navigator.locks.request` and would throw on the older Node.
// Polyfill only when missing — Node 24's native impl is the
// authoritative one in production and shouldn't be replaced.
if (typeof navigator !== 'undefined' && !navigator.locks) {
  const chains = new Map()
  const locksPolyfill = {
    request(name, ...rest) {
      // Match the spec's two call shapes:
      //   request(name, callback)
      //   request(name, options, callback)
      // We ignore `options` (no `mode: 'shared'` / `signal` /
      // `ifAvailable` / `steal` support — the production code
      // never uses them).
      const callback = rest[rest.length - 1]
      const prev = chains.get(name) ?? Promise.resolve()
      // Swallow the previous chain's rejection on the wait edge
      // so one failed callback doesn't poison subsequent ones.
      const work = (async () => {
        try { await prev } catch {}
        return callback({ name, mode: 'exclusive' })
      })()
      chains.set(name, work.catch(() => {}))
      return work
    },
  }
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: locksPolyfill,
  })
}
