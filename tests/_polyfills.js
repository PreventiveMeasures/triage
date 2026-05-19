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

// `--js-base-64` is set for the base64 methods (Uint8Array.fromBase64
// / .toBase64) the client relies on, but on some Node 24.x hosts the
// same flag turns on a buggy native `Uint8Array.prototype.toHex` that
// emits 'O'..'V' for nibbles ≥ 8 instead of '8'..'9' / 'a'..'f'.
// @noble/hashes routes ed25519 key derivation through that method, so
// triage-sync derivation throws `Cannot convert 0x…O…V… to a BigInt`.
// Overwrite (not delete) so the result is timing-independent —
// @noble/hashes captures `hasHexBuiltin` at module load and the test
// runner can land that capture before _polyfills.js runs; replacing
// in place keeps `typeof === 'function'` but routes every call to a
// correct JS implementation. Fixed and unflagged in Node 25, so the
// probe is a no-op there.
if (typeof Uint8Array.prototype.toHex === 'function'
    && new Uint8Array(32).fill(255).toHex() !== 'ff'.repeat(32)) {
  const hexes = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))
  // eslint-disable-next-line no-extend-native -- intentionally patching the broken native
  Object.defineProperty(Uint8Array.prototype, 'toHex', {
    configurable: true,
    writable: true,
    value: function toHex() {
      let s = ''
      for (let i = 0; i < this.length; i++) s += hexes[this[i]]
      return s
    },
  })
}

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

// EventTarget on globalThis: in browsers `globalThis === window` is
// already an EventTarget (`window.addEventListener('storage', ...)`
// is the cross-tab notification path). Node's globalThis is a plain
// object — no addEventListener / dispatchEvent — so client modules
// that register a `'storage'` listener at module-load time would
// silently skip registration in tests. Mount a minimal EventTarget
// proxy so the listener attaches and the test can dispatch a
// synthesised storage event. Idempotent guard for repeat imports.
if (typeof globalThis.addEventListener !== 'function') {
  const target = new EventTarget()
  globalThis.addEventListener = target.addEventListener.bind(target)
  globalThis.removeEventListener = target.removeEventListener.bind(target)
  globalThis.dispatchEvent = target.dispatchEvent.bind(target)
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
      const callback = rest.at(-1)
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

// Install the default `SyncHost` wiring for `client/sync/*` modules.
// Tests import the sync modules directly (no `ui/view.js` boot), so
// the install hook has to run here to fire the deferred listener
// registrations + persisted-flag restore. Idempotent: the install
// passes the same module-scoped host instance on every call, and
// `installSyncHost` no-ops on a same-instance re-install. Runs LAST
// so the localStorage + navigator.locks shims above are in place
// for the install's bootstrap path (`getSecureItem`,
// `prunePersistedSessions`).
const { installDefaultSyncHost } = await import('../client/sync.js')
installDefaultSyncHost()
