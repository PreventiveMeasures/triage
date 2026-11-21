// Lazy loader for the sync surface, as for prism / terminal / the brotli
// fallback: a runtime-string dynamic import keeps `ui/client-sync.js` (with
// the websocket transport, objstore crypto and triage-sync persistence) out
// of the main bundle. It loads on online intent only, never at boot: the
// sync toggle switched on (`triageSync.setEnabled(true)`), an explicit
// remote action (`fetchFile`, `putFile`, `openWorkspace`, …), or the
// sidebar's renderSyncStatus once the button shows (a usable URL, a
// workspace) for a user who hadn't turned sync off. Boot-time wiring
// (`setRedraw`, the resolvers, subscriptions) only queues, drained into the
// real module once it loads; until then the UI reads "sync is off".
//
// `applyDefaultSyncHost` comes from the MAIN bundle (#client/sync-host.js),
// so the `setTriageChangeNotifier` slot it wires is the one `saveTriage`
// writes through; installed from the chunk, its duplicated
// `client/triage.js` would get the notifier and no change would fan out.

import { getSecureItem, readCachedServerInfo, state } from '#client/index.js'
import { applyDefaultSyncHost } from '#client/sync-host.js'

let realModule = null
let loadPromise = null

// Unless the user turned sync off (the persisted flag is '0'), as in
// triage-sync.ts. Before hydration this reads "wants sync": at worst one
// unwanted chunk load, which the sidebar can switch off.
function userWantsSync() {
  try { return getSecureItem('deepview.sync.userEnabled') !== '0' }
  catch { return true }
}

// Only the active e2e surface may load or use e2e sync. In a combined
// deployment the cached advertisement permits both protocols, so the current
// in-memory mode must also gate loadSync and every data-method wrapper.
let syncForceDisabled = false

// Runtime hard-disable used while transitioning away from the e2e surface.
export function setSyncForceDisabled(disabled) { syncForceDisabled = Boolean(disabled) }

function syncBlockedByMode() {
  if (syncForceDisabled || state.serverMode !== 'e2e') return true
  try { return readCachedServerInfo()?.mode === 'managed' }
  catch { return false }
}

export function loadSync() {
  if (loadPromise) return loadPromise
  if (syncBlockedByMode() && !realModule) return Promise.resolve(null)
  loadPromise = (async () => {
    // In a variable, so esbuild can't resolve it statically; the browser
    // resolves it against the page URL.
    const path = './client-sync.js'
    try {
      const mod = await import(path)
      applyDefaultSyncHost(mod)
      realModule = mod
      drainPending()
      return mod
    } catch (err) {
      // Not pinned to a rejection: a transient failure (offline, a stale SW
      // cache) retries on the next call.
      loadPromise = null
      throw err
    }
  })()
  return loadPromise
}

// Deferred calls, each applying itself to the loaded module.
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

// The unsubscriber cancels a queued subscription, or unsubscribes a live one.
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

// "No remote" until the module lands; templates re-check every render.
export function isInRemote(workspaceId, fileName) {
  return realModule ? realModule.isInRemote(workspaceId, fileName) : false
}
export function isBundleInRemote(workspaceId, integrity) {
  return realModule ? realModule.isBundleInRemote(workspaceId, integrity) : false
}
// Also the persisted presence cache, for the delete and drag-out paths
// deciding whether a workspace's remote tag must go: the live answer is
// false for a workspace whose session isn't open (sync off at boot, never
// opened, mid-boot before `session.list()`), and leaving it out of the
// fan-out resurrects the file via `maybeAutoDownload(Bundle)` on its next
// open. The key and `{ names, bundles }` schema are `savePresenceCache`'s
// (client/sync/objstore-presence.js).
const PRESENCE_CACHE_PREFIX = 'deepview.objstore-presence.'
function readPresenceCache(workspaceId) {
  try {
    const raw = localStorage.getItem(PRESENCE_CACHE_PREFIX + workspaceId)
    if (!raw) return null
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? obj : null
  } catch { return null }
}
export function isInRemoteOrCached(workspaceId, fileName) {
  if (realModule && realModule.isInRemote(workspaceId, fileName)) return true
  const cache = readPresenceCache(workspaceId)
  if (!cache || typeof cache.names !== 'object') return false
  return Object.values(cache.names).includes(fileName)
}
export function isBundleInRemoteOrCached(workspaceId, integrity) {
  if (realModule && realModule.isBundleInRemote(workspaceId, integrity)) return true
  const cache = readPresenceCache(workspaceId)
  if (!cache || typeof cache.bundles !== 'object') return false
  return Object.values(cache.bundles).includes(integrity)
}
export function remoteCount(workspaceId) {
  return realModule ? realModule.remoteCount(workspaceId) : 0
}
export function differingReports(workspaceId) {
  return realModule ? realModule.differingReports(workspaceId) : []
}

// Subscriptions queue without loading: no events while sync is off.
export function onAutoDownloaded(cb) {
  return deferSubscription(cb, (m, fn) => m.onAutoDownloaded(fn))
}
export function onBundleAutoDownloaded(cb) {
  return deferSubscription(cb, (m, fn) => m.onBundleAutoDownloaded(fn))
}
export function onChange(cb) {
  return deferSubscription(cb, (m, fn) => m.onChange(fn))
}

// The module's single-slot setters, queued without loading; the last call
// wins, as there.
function deferredSetter(method) {
  let pending = null
  return (fn) => {
    if (realModule) { realModule[method](fn); return }
    pending = fn
    deferApply((m) => { if (pending === fn) m[method](fn) })
  }
}
export const setRedraw = deferredSetter('setRedraw')
export const setAuthenticationResolver = deferredSetter('setAuthenticationResolver')
export const setHydrationConflictResolver = deferredSetter('setHydrationConflictResolver')

// The presence sessions `setEnabled(false)` tore down, for the matching
// `setEnabled(true)` to reopen: each reopen re-sends the `objstore-list`
// that refreshes `isInRemote`.
let presenceToReopen = []

// Explicit remote actions load sync when it's wanted, and no-op when the
// user opted out (the upload / download / discovery UIs key on
// `triageSync.status`, which stays 'off' unloaded); mostly that skips
// ingest.js's `openPresence(id)` on every workspace switch.
async function callIfWanted(method, args) {
  if (syncBlockedByMode()) return undefined
  if (!userWantsSync() && !realModule) return undefined
  const mod = await loadSync()
  if (!mod || syncBlockedByMode()) return undefined
  return mod[method](...args)
}

export function fetchFile(...args) { return callIfWanted('fetchFile', args) }
export function downloadFileFromRemote(...args) { return callIfWanted('downloadFileFromRemote', args) }
export function fetchBundleFromRemote(...args) { return callIfWanted('fetchBundleFromRemote', args) }
export function putFile(...args) { return callIfWanted('putFile', args) }
// Resolves to the release function (undefined while sync isn't wanted).
export function holdLocalChangeChecks(...args) { return callIfWanted('holdLocalChangeChecks', args) }
export function putBundleToRemote(...args) { return callIfWanted('putBundleToRemote', args) }
export function deleteFromRemote(...args) { return callIfWanted('deleteFromRemote', args) }
export function deleteBundleFromRemote(...args) { return callIfWanted('deleteBundleFromRemote', args) }
export function openWorkspace(...args) { return callIfWanted('openWorkspace', args) }
// Teardown must still run after a switch to managed; it never loads sync.
export async function closeWorkspace(...args) {
  const mod = realModule ?? (loadPromise ? await loadPromise : null)
  return mod?.closeWorkspace(...args)
}
export function recheckRemoteStorage(...args) { return callIfWanted('recheckRemoteStorage', args) }
export function resolveReportDifference(...args) { return callIfWanted('resolveReportDifference', args) }

// The `triageSync` proxy, in the real object's shape: getters read safe
// defaults, and calls queue without loading — silent no-ops if sync never
// loads, replayed in order if it does — save `setEnabled(true)`.
function deferCall(method, args) {
  if (realModule) return realModule.triageSync[method](...args)
  deferApply((m) => { m.triageSync[method](...args) })
}

export const triageSync = {
  get status() { return realModule ? realModule.triageSync.status : 'off' },
  get openSessions() { return realModule ? realModule.triageSync.openSessions : [] },
  get persistenceDegraded() { return realModule ? realModule.triageSync.persistenceDegraded : false },
  get proxyAuthRequired() { return realModule ? realModule.triageSync.proxyAuthRequired : false },

  // `true` is the canonical switch to online, loading sync.
  //
  // `false` first closes every presence session, releasing its transport
  // acquire, so the socket actually drops: ingest.js keeps presence open
  // across workspace switches, and otherwise "Sync off" would leave it up.
  // Never loaded, it queues — so the persisted flag still flips to '0' on a
  // later load, and a reload doesn't auto-resume.
  setEnabled(value) {
    if (value === true) {
      if (syncBlockedByMode()) return Promise.resolve(null)
      return loadSync().then((m) => {
        m.triageSync.setEnabled(true)
        // The socket reconnects without a live presence session, so no
        // `objstore-list` would refresh `isInRemote` until a navigation:
        // reopen what disabling closed. `openWorkspace` is idempotent and
        // lists once the socket re-subscribes.
        const ids = presenceToReopen
        presenceToReopen = []
        for (const id of ids) {
          try { m.openWorkspace(id) } catch (err) {
            console.warn(`client-sync: openWorkspace(${id}) failed during re-enable:`, err)
          }
        }
        return null
      }).catch((err) => {
        console.warn('client-sync: setEnabled load failed:', err)
        return null
      })
    }
    if (realModule) {
      // `openWorkspaceIds()` is a fresh array; closeWorkspace mutates the map.
      presenceToReopen = realModule.openWorkspaceIds()
      for (const id of presenceToReopen) {
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
    // The persisted flag, so renderSyncStatus doesn't load the chunk for a
    // user who opted out.
    return userWantsSync()
  },

  openSession(id) { deferCall('openSession', [id]) },
  closeSession(id) { deferCall('closeSession', [id]) },
  refreshSession(id) { deferCall('refreshSession', [id]) },
  dismissError(id) { deferCall('dismissError', [id]) },
  setForcedOff(v) { deferCall('setForcedOff', [v]) },
  setProtocolLocked(v) { deferCall('setProtocolLocked', [v]) },
  setServerUrl(url) { deferCall('setServerUrl', [url]) },
  getServerUrl() { return realModule ? realModule.triageSync.getServerUrl() : null },
  notify() { deferCall('notify', []) },

  onStatusChange(cb) {
    return deferSubscription(cb, (m, fn) => m.triageSync.onStatusChange(fn))
  },
  onServerInfo(cb) {
    return deferSubscription(cb, (m, fn) => m.triageSync.onServerInfo(fn))
  },
  onPersistenceDegraded(cb) {
    return deferSubscription(cb, (m, fn) => m.triageSync.onPersistenceDegraded(fn))
  },
  onProxyAuthRequired(cb) {
    return deferSubscription(cb, (m, fn) => m.triageSync.onProxyAuthRequired(fn))
  },
}
