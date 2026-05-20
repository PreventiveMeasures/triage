// Lazy loader for the sync surface. Mirrors the prism / terminal /
// brotli-fallback pattern: a runtime-string dynamic import keeps
// `ui/client-sync.js` (and the transitive websocket transport +
// objstore crypto + triage-sync persistence) out of the main
// `view.js` bundle.
//
// Loading is gated to "online intent" rather than fired at boot:
//   - User clicks the sync-status toggle to enable
//     (`triageSync.setEnabled(true)`).
//   - Explicit user actions that touch remote (`fetchFile`,
//     `putFile`, `openWorkspace`, etc.) — these can't no-op
//     usefully, so they trigger the load.
//   - Auto-resume on boot: ui/view.js's `continueBoot` calls
//     `loadSync()` directly if the persisted `userEnabled` flag
//     in secure-storage is not '0' (i.e., the user had sync on
//     in their last session).
//
// Boot-time wiring that the UI registers eagerly (`setRedraw`,
// `setHydrationConflictResolver`, `triageSync.onStatusChange`,
// `onAutoDownloaded`, ...) does NOT trigger the load. Those calls
// stash their callbacks in module-private slots; once the load
// resolves (via any of the triggers above), the slots are drained
// into the real sync module. If the load never happens, the
// callbacks just sit there — the UI degrades to "sync is off",
// which is exactly the user's intent.
//
// `applyDefaultSyncHost` is statically imported from `#client/
// sync-host.js` — that module lives in the MAIN bundle alongside
// the rest of `client/*`, so the `setTriageChangeNotifier` slot it
// wires is the same one `saveTriage` writes through. If the host
// install happened from inside the sync chunk instead, the chunk's
// duplicated `client/triage.js` would receive the notifier and the
// main bundle's `saveTriage` would never fan the change out.

import { getSecureItem } from '#client/index.js'
import { applyDefaultSyncHost } from '#client/sync-host.js'

let realModule = null
let loadPromise = null

// True when the user hasn't explicitly disabled sync. Defaults to
// true (matches `triage-sync.ts`'s `userEnabled` default), and is
// only false when the persisted flag is the literal '0'. Read
// through `getSecureItem` so a hydrated cache returns the user's
// actual choice — pre-hydrate reads return null and default to
// "wants sync", which is the safe fallback (worst case: a single
// unwanted chunk load that the user can disable from the sidebar).
function userWantsSync() {
  try { return getSecureItem('deepview.sync.userEnabled') !== '0' }
  catch { return true }
}

function loadSyncOnce() {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    // Path held in a variable so esbuild can't statically resolve
    // it — keeps `ui/client-sync.js` (and its transitive sync /
    // crypto / transport payload) out of the main view bundle.
    // Browser resolves it against the page URL.
    const path = './client-sync.js'
    try {
      const mod = await import(path)
      // Apply the host wiring from the MAIN bundle so the
      // triageChangeNotifier slot saveTriage flips is the live one
      // (see module-top comment).
      applyDefaultSyncHost(mod)
      realModule = mod
      drainPending()
      return mod
    } catch (err) {
      // Don't pin the module to a rejected promise — a transient
      // failure (offline, stale SW cache) would otherwise replay
      // forever. Reset so the next call retries from scratch.
      loadPromise = null
      throw err
    }
  })()
  return loadPromise
}

export function loadSync() { return loadSyncOnce() }

// Pending boot-wiring registrations. Each is a function that takes
// the loaded module and applies the deferred call.
const pendingApplies = []

function deferApply(apply) {
  if (realModule) apply(realModule)
  else pendingApplies.push(apply)
}

function drainPending() {
  const applies = pendingApplies.splice(0)
  for (const apply of applies) {
    try { apply(realModule) } catch (err) { console.warn('client-sync: deferred apply failed:', err) }
  }
}

// Subscription helper. The returned unsubscriber is a cancellation
// flag pre-load; the real unsubscriber once the apply runs.
function deferSubscription(cb, register) {
  const sub = { cancelled: false, unsub: null }
  deferApply((mod) => {
    if (sub.cancelled) return
    sub.unsub = register(mod, cb)
  })
  return () => {
    sub.cancelled = true
    if (sub.unsub) sub.unsub()
  }
}

// Synchronous stubs — return the "no remote" defaults until the
// real module lands. Render templates re-check on every render, so
// the post-load redraw flips the displayed values.
export function isInRemote(workspaceId, fileName) {
  return realModule ? realModule.isInRemote(workspaceId, fileName) : false
}
export function isBundleInRemote(workspaceId, integrity) {
  return realModule ? realModule.isBundleInRemote(workspaceId, integrity) : false
}
export function remoteCount(workspaceId) {
  return realModule ? realModule.remoteCount(workspaceId) : 0
}
export function remoteBundleName(workspaceId, integrity) {
  return realModule ? realModule.remoteBundleName(workspaceId, integrity) : null
}

// Subscription wrappers — pure queue, no load trigger. The sync
// module fires these once it lands; in the meantime the UI sees
// no events (which is correct: sync is off).
export function onAutoDownloaded(cb) {
  return deferSubscription(cb, (m, fn) => m.onAutoDownloaded(fn))
}
export function onBundleAutoDownloaded(cb) {
  return deferSubscription(cb, (m, fn) => m.onBundleAutoDownloaded(fn))
}
export function onChange(cb) {
  return deferSubscription(cb, (m, fn) => m.onChange(fn))
}

// Boot-wiring resolver setters — pure queue, no load trigger. The
// last call wins if a consumer re-installs; matches the underlying
// `setRedraw` / `setAuthenticationResolver` /
// `setHydrationConflictResolver` semantics (each is a single slot).
let pendingRedraw = null
let pendingAuthResolver = null
let pendingConflictResolver = null

export function setRedraw(fn) {
  if (realModule) { realModule.setRedraw(fn); return }
  pendingRedraw = fn
  deferApply((m) => { if (pendingRedraw === fn) m.setRedraw(fn) })
}
export function setAuthenticationResolver(fn) {
  if (realModule) { realModule.setAuthenticationResolver(fn); return }
  pendingAuthResolver = fn
  deferApply((m) => { if (pendingAuthResolver === fn) m.setAuthenticationResolver(fn) })
}
export function setHydrationConflictResolver(fn) {
  if (realModule) { realModule.setHydrationConflictResolver(fn); return }
  pendingConflictResolver = fn
  deferApply((m) => { if (pendingConflictResolver === fn) m.setHydrationConflictResolver(fn) })
}

// Async wrappers for explicit-action endpoints — these trigger the
// load when sync is wanted. When the user has opted out
// (`userWantsSync()` is false), the call no-ops: the upload /
// download / discovery UIs are gated on `triageSync.status` which
// stays `'off'` while sync isn't loaded, so the only way these
// wrappers fire from the "wants sync = false" state is incidental
// (ingest.js's `openPresence(id)` on every workspace switch is
// the main one). No-op'ing avoids dragging the lazy chunk in just
// to immediately discard it.
async function callIfWanted(method, args) {
  if (!userWantsSync() && !realModule) return undefined
  return (await loadSyncOnce())[method](...args)
}

export function fetchFile(...args) { return callIfWanted('fetchFile', args) }
export function fetchBundleFromRemote(...args) { return callIfWanted('fetchBundleFromRemote', args) }
export function putFile(...args) { return callIfWanted('putFile', args) }
export function putBundleToRemote(...args) { return callIfWanted('putBundleToRemote', args) }
export function deleteFromRemote(...args) { return callIfWanted('deleteFromRemote', args) }
export function openWorkspace(...args) { return callIfWanted('openWorkspace', args) }
export function closeWorkspace(...args) { return callIfWanted('closeWorkspace', args) }
export function discoverRemoteFileNames(...args) { return callIfWanted('discoverRemoteFileNames', args) }
export function discoverRemoteBundleIntegrities(...args) { return callIfWanted('discoverRemoteBundleIntegrities', args) }

// `triageSync` proxy — mirrors the real object's shape. Methods that
// represent "online intent" (`setEnabled(true)`) trigger the load;
// the rest queue without loading. Getters return safe defaults.
function deferCall(method, args) {
  if (realModule) return realModule.triageSync[method](...args)
  deferApply((m) => { m.triageSync[method](...args) })
}

export const triageSync = {
  get status() { return realModule ? realModule.triageSync.status : 'off' },
  get openSessions() { return realModule ? realModule.triageSync.openSessions : [] },
  get persistenceDegraded() { return realModule ? realModule.triageSync.persistenceDegraded : false },

  // `setEnabled(true)` is the canonical "switch to online" trigger.
  // Always loads sync — even if the user is enabling for the first
  // time mid-session.
  //
  // `setEnabled(false)` is "switch to offline": it closes every
  // objstore-presence session (release the transport acquires they
  // hold) BEFORE calling triage-sync's setEnabled, so the WS
  // actually disconnects instead of staying open behind the
  // surviving presence acquires. Without this, the user toggles
  // "Sync off" but the socket lingers as long as any workspace has
  // an open presence session — and ingest.js keeps presence open
  // across workspace switches by design.
  //
  // If sync was never loaded, disable is a fast path: nothing to
  // tear down; we still hand `false` to a queue-able `deferCall`
  // so the persisted `userEnabled` flag flips to '0' once a future
  // load lands (otherwise the persisted flag would stay at its
  // default and the next reload would auto-resume).
  setEnabled(value) {
    if (value === true) {
      return loadSyncOnce().then((m) => m.triageSync.setEnabled(true)).catch((err) => {
        console.warn('client-sync: setEnabled load failed:', err)
        return null
      })
    }
    if (realModule) {
      // Close every presence session so its transport acquire
      // releases. `openWorkspaceIds()` snapshots the keys; iterate
      // a copy because `closeWorkspace` mutates the live map.
      for (const id of realModule.openWorkspaceIds()) {
        try { realModule.closeWorkspace(id) } catch (err) {
          console.warn(`client-sync: closeWorkspace(${id}) failed during disable:`, err)
        }
      }
      realModule.triageSync.setEnabled(false)
      return
    }
    deferCall('setEnabled', [value])
  },
  isEnabled() {
    if (realModule) return realModule.triageSync.isEnabled()
    // Pre-load: reflect the persisted user-enabled flag so callers
    // that decide whether to load the chunk (sidebar's
    // renderSyncStatus) don't treat an opted-out user as enabled
    // and pull sync in. Defaults to true (matches triage-sync.ts).
    return userWantsSync()
  },

  // Session / queue / config methods — all defer without loading.
  // If sync never loads, they're silent no-ops. If sync does load,
  // the queue replays in registration order.
  openSession(id) { deferCall('openSession', [id]) },
  closeSession(id) { deferCall('closeSession', [id]) },
  refreshSession(id) { deferCall('refreshSession', [id]) },
  dismissError(id) { deferCall('dismissError', [id]) },
  setForcedOff(v) { deferCall('setForcedOff', [v]) },
  setServerUrl(url) { deferCall('setServerUrl', [url]) },
  getServerUrl() { return realModule ? realModule.triageSync.getServerUrl() : null },
  notify() { deferCall('notify', []) },

  // Subscriptions — pure queue, no load trigger.
  onStatusChange(cb) {
    return deferSubscription(cb, (m, fn) => m.triageSync.onStatusChange(fn))
  },
  onPersistenceDegraded(cb) {
    return deferSubscription(cb, (m, fn) => m.triageSync.onPersistenceDegraded(fn))
  },
}
