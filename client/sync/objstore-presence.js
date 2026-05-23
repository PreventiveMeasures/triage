// Tracks which reports of an open workspace are present in the
// objstore remote inventory. Drives the header sync-status badge's
// "local" vs "cloud" indicator for each fileName.
//
// Lifecycle: `openWorkspace(id)` called from ingest.js when the
// workspace becomes active. Sessions STAY OPEN across switches —
// the shared transport multiplexes them, and the warm `remoteTags`
// cache means return-visits don't refetch via `fetchByTag`.
// Cleanup is event-driven: `onWorkspaceDeleted` tears the session
// down; `onWorkspacePrivateKeyChanged` tears down + re-opens
// against fresh keys.
//
// Tag mapping: the wire `resourceTag` is HMAC-SHA-256(tagKey,
// fileName) — deterministic + one-way, so the synchronous render
// path computes the same tag locally and compares it against the
// cached remote set without an await. Enumerating remote files BY
// name requires `fetchByTag` (decrypt + read embedded name).

import { computeBundleResourceTag, computeResourceTag, deriveObjstoreKeys } from './objstore-content-crypto.ts'
import { createObjstoreClient } from './objstore.ts'
import { getSharedTransport } from './sync-transport.ts'
import { triageSync } from './triage-sync.ts'
import { decodeUtf8 } from '../../common/utf8.js'
import { computeSha512Integrity } from '../../common/integrity.js'
import { onSyncHostInstalled } from './host.ts'

// Late-bound host accessors — populated by `onSyncHostInstalled` at
// the bottom of this file before any of the entry points below
// (`openWorkspace`, the workspace-listener callbacks, etc.) can fire.
// Direct references here read cleaner than `syncHost().listWorkspaces()`
// at every call site, but the actual binding is `syncHost()` once we
// know the host is installed.
let listWorkspaces
let addReportToWorkspace
let addBundleToWorkspace
let analyzeContent
let setCount
let gunzipBytes
let listBundles
let listFiles
let readBundle
let saveBundle
let saveFileBytes

const sessions = new Map()
const listeners = new Set()

// Persisted tag→name cache, keyed per-workspace in localStorage.
// Lets a page refresh skip `fetchByTag` for every remote tag we've
// already decoded — `fetchByTag` downloads the FULL encrypted blob
// over REST just to read the embedded name, so a workspace with N
// remote reports + bundles costs N REST round-trips on every boot
// without this cache.
//
// Shape: { names: { tag: fileName }, bundles: { tag: integrity },
//          bundleNames: { integrity: name } }
//
// Trust: this data is workspace-private (filenames, bundle names,
// HMAC tags); nothing here is secret material. localStorage is the
// same persistence tier the workspace blob (`deepview.workspaces`)
// uses for its plaintext `reports` / `bundles` arrays, so the cache
// doesn't widen the exposure surface.
//
// Invalidation: cleared on `onWorkspaceDeleted` and
// `onWorkspacePrivateKeyChanged` (where the cached HMACs were
// computed against an old `tagKey` and are now garbage). Pruned
// after each `session.list()` against the live remote inventory so
// stale entries from a peer-side delete don't linger.
const PRESENCE_CACHE_PREFIX = 'deepview.objstore-presence.'
function presenceCacheKey(workspaceId) { return PRESENCE_CACHE_PREFIX + workspaceId }
function loadPresenceCache(workspaceId) {
  try {
    const raw = localStorage.getItem(presenceCacheKey(workspaceId))
    if (!raw) return null
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return null
    return {
      names: obj.names && typeof obj.names === 'object' ? obj.names : {},
      bundles: obj.bundles && typeof obj.bundles === 'object' ? obj.bundles : {},
      bundleNames: obj.bundleNames && typeof obj.bundleNames === 'object' ? obj.bundleNames : {},
    }
  } catch { return null }
}
function savePresenceCache(workspaceId, entry) {
  try {
    const payload = {
      names: Object.fromEntries(entry.remoteNameByTag),
      bundles: Object.fromEntries(entry.remoteBundleByTag),
      bundleNames: Object.fromEntries(entry.remoteBundleNameByIntegrity),
    }
    localStorage.setItem(presenceCacheKey(workspaceId), JSON.stringify(payload))
  } catch (err) {
    // QuotaExceeded or similar. The in-memory cache still works for
    // this session; the next page refresh will repeat the
    // `fetchByTag` discovery cycle. Log so the operator sees why.
    console.warn(`objstore-presence: cache persist failed for ${workspaceId}:`, err)
  }
}
function clearPresenceCache(workspaceId) {
  try { localStorage.removeItem(presenceCacheKey(workspaceId)) } catch {}
}

// Shared multiplexed objstore client — one per page. The WebSocket
// itself lives on the shared `SocketTransport` from
// `client/sync/sync-transport.ts` so triage-sync and objstore share one
// TCP connection: one heartbeat, one `authenticate` round-trip, one
// reconnect schedule. The transport's `setServerUrl` is driven by
// triage-sync; the operator-side auth resolver is wired via
// `setSharedAuthResolver`. The HTTP origin (REST data-plane) is
// derived from the WS URL the first time we need a client and
// captured into the client — we never re-derive because in this
// app the user only ever has one server URL, and toggling sync
// off/on goes through the transport's acquire/release without
// touching this client.
//
// Known gap: the console-API path
// `DeepView.triageSync.setServerUrl('wss://different-host')` swaps
// the WS plane but leaves this client's captured httpOrigin
// pointing at the previous derivation — REST PUT/GET tokens issued
// by the new server would then hit the OLD origin. Accepted as
// out-of-scope: the supported flows (initial set, off-toggle,
// on-toggle) all use the same URL.
let client = null
function ensureClient(httpOrigin) {
  if (!client) {
    client = createObjstoreClient({
      // `serverUrl` only matters when the client builds its own
      // private transport (the path tests take when they pass no
      // `transport`); here the shared transport carries all WebSocket
      // traffic, so pass empty string to keep the deps shape valid
      // without pretending to drive the URL.
      serverUrl: '',
      httpOrigin,
      transport: getSharedTransport(),
      // Presence sends NO `workspace-subscribe` of its own (the objstore
      // client has no subscribe path at all). It relies on triage-sync's
      // single subscribe for the same tag on this shared socket (presence
      // and sync open a workspace together, so sync always owns it). That
      // one subscribe registers the socket for the tag's broadcasts —
      // including objstore-put/-deleted — so ours would be a pure
      // duplicate (and would trip triage-sync's continuity-break
      // re-subscribe via the full-chain replay).
    })
  }
  return client
}
// Fired after the auto-download worker saves a new report to OPFS
// + attaches it to the workspace. The UI bridge re-runs
// `switchToWorkspace` if the affected workspace is currently
// active so the new report joins state.reports without a manual
// refresh.
const autoDownloadListeners = new Set()
// Same shape for bundles — fires after `maybeAutoDownloadBundle` (or
// an explicit `fetchBundleFromRemote` followed by attach) lands a
// new bundle's bytes in OPFS + claims it under a workspace. The UI
// bridge re-renders the sidebar (so `state.bundles` picks up the
// new entry) and the bundles main view if active.
const bundleAutoDownloadListeners = new Set()

function notify() {
  for (const cb of listeners) {
    try { cb() } catch {}
  }
}

// triageSync.getServerUrl() returns `ws[s]://host[:port]/api/sync`.
// objstore's REST plane lives on the same origin (no path), so swap
// scheme + drop pathname. Returns null when sync isn't configured —
// in that case we keep an empty entry around so isInRemote can still
// answer false synchronously.
// Stringify `entry.err` for inclusion in user-facing Error messages.
// `entry.err` is typically an `Error` (e.g. `new Error('connect
// failed')`) so `.message` is the readable form. But the boot path
// captures rejection from `client.openWorkspace`, which can also
// reject with a non-Error value (Web Locks API throws plain
// `{ name, message }` DOMExceptions; `crypto.subtle.*` failures
// surface as DOMException too). Falling back to `String(err)`
// instead of bare `err` avoids producing `[object Object]` in the
// thrown message. Memory-lifecycle audit follow-up
// `client/sync/objstore-presence.js:374`.
//
// Edge cases:
//   - `new Error('')` (empty message) → Error branch skips empty
//     message, falls through to `String(err)` → ': Error' (the
//     prototype toString). Degraded but not misleading.
//   - `{ name: 'X' }` (object, no .message) → falls to `String(err)`
//     → ': [object Object]'. Same as the pre-fix shape — formally
//     a defense-in-depth gap, but no real-world thrower in the
//     codebase produces such shapes.
//   - `Symbol(...)` → `String(err)` throws on most engines; the
//     outer try/catch returns '' rather than propagating. Callers
//     end up with a less-informative composite ("Objstore session
//     is not connected" with no trailing reason) — acceptable for
//     this rare pathological case.
function formatEntryErr(err) {
  if (err == null) return ''
  if (err instanceof Error && err.message) return `: ${err.message}`
  if (typeof err === 'string' && err) return `: ${err}`
  if (typeof err === 'object' && typeof err.message === 'string' && err.message) return `: ${err.message}`
  try { return `: ${String(err)}` } catch { return '' }
}

// Receiver-side defensive cap on the user-friendly bundle name.
// The wire wrap allows up to 64 KiB (u16BE length prefix) — a
// misbehaving workspace member could ship a huge name to bloat the
// OPFS `_meta.json` blob and break the sidebar render. Clamp before
// passing to `saveBundle`. 256 bytes is comfortably past any
// reasonable filename. UTF-8 truncation at a non-codepoint boundary
// would produce mojibake but never a JSON-stringify failure, so we
// slice by JS string length (codepoints) rather than byte length
// to keep the cap easy to reason about.
const MAX_RECEIVED_BUNDLE_NAME_LEN = 256

function clampBundleName(name) {
  if (typeof name !== 'string') return ''
  if (name.length <= MAX_RECEIVED_BUNDLE_NAME_LEN) return name
  return name.slice(0, MAX_RECEIVED_BUNDLE_NAME_LEN)
}

function httpOriginFromWsUrl(wsUrl) {
  try {
    const u = new URL(wsUrl)
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
    u.pathname = '/'
    u.search = ''
    u.hash = ''
    return u.origin
  } catch {
    return null
  }
}

// Hold a single in-flight session per workspaceId. Calling
// openWorkspace twice with the same id is a no-op — the first call
// has already populated `fileTags` and the session boot resolves on
// its own. A subsequent close + open cycle (user leaves + re-enters
// the workspace) opens a new session.
export function openWorkspace(workspaceId) {
  if (sessions.has(workspaceId)) return
  const ws = listWorkspaces().find((w) => w.id === workspaceId)
  if (!ws) return
  // Couple this objstore session to a sync subscription up front: the
  // objstore client never sends its own `workspace-subscribe`, so it
  // rides triage-sync's. `ensureSubscription` opens (idempotently) the
  // sync session that owns the subscribe and returns the token the
  // objstore client requires — without it `c.openWorkspace` throws.
  // Bail if the workspace can't be subscribed (unknown to sync): we
  // must not open a presence session whose inventory nothing seeds and
  // whose ops run against a tag nobody is subscribed to.
  const subscription = triageSync.ensureSubscription(workspaceId)
  if (!subscription) return
  // `fileTags` mirrors the objstore's HMAC tags for every fileName
  // the workspace knows locally; `bundleTags` does the same for the
  // workspace's claimed bundle integrities. `remoteTags` is the
  // server-side inventory; we compare each tag against both forward
  // maps to classify (report vs. bundle). The reverse maps
  // (`remoteNameByTag` / `remoteBundleByTag`) are populated by the
  // background `fetchByTag` discovery worker AND by upload paths
  // that already know the name. `remoteBundleNameByIntegrity` carries
  // the user-friendly bundle name surfaced by `fetchByTag` so the
  // download dialog can render a meaningful label pre-fetch.
  const entry = {
    workspaceId,
    session: null, keys: null,
    remoteTags: new Set(),
    fileTags: new Map(),
    bundleTags: new Map(),
    remoteNameByTag: new Map(),
    remoteBundleByTag: new Map(),
    remoteBundleNameByIntegrity: new Map(),
    // `resourceTag → version` for every remote resource we know
    // about. Populated from `session.list()` at boot, kept in sync
    // by `onPut` (peer / sibling-tab writes) and by `putFile` /
    // `putBundleToRemote` after a successful local put. Drives the
    // version-bump detection in the `onPut` handler so a Replace
    // under an existing tag (same fileName, new content) forces
    // peers to re-download the bytes — the prior behavior treated
    // every onPut for a known tag as a no-op, leaving peers stuck
    // on the old content while new joiners fetched the fresh blob.
    remoteVersions: new Map(),
    inFlight: new Map(),
    err: null, disposed: false, ready: null,
  }
  sessions.set(workspaceId, entry)
  entry.ready = (async () => {
    entry.keys = await deriveObjstoreKeys(ws.privateKey, ws.id)
    if (entry.disposed) return
    // Pre-compute fileTags + bundleTags BEFORE opening the WS session
    // so a render racing the boot has its lookups resolve (to `false`)
    // rather than miss-and-return-false-with-no-cache. Stash an
    // inverse map (tag → name / integrity) for the post-list() step
    // below — for any remote tag that corresponds to an attached
    // local report/bundle we can fill `remoteNameByTag` /
    // `remoteBundleByTag` directly without a `fetchByTag` round-trip
    // (which would otherwise download the entire encrypted blob over
    // REST just to read the embedded name).
    const attachedTagToName = new Map()
    for (const name of ws.reports ?? []) {
      const tag = await computeResourceTag(entry.keys.tagKey, name)
      entry.fileTags.set(name, tag)
      attachedTagToName.set(tag, name)
    }
    if (entry.disposed) return
    const attachedTagToIntegrity = new Map()
    for (const integrity of ws.bundles ?? []) {
      const tag = await computeBundleResourceTag(entry.keys.tagKey, integrity)
      entry.bundleTags.set(integrity, tag)
      attachedTagToIntegrity.set(tag, integrity)
    }
    if (entry.disposed) return
    // Bundle names live in local OPFS metadata for attached bundles —
    // surface them so the download dialog has labels ready without
    // needing `fetchByTag` to peek inside the encrypted payload.
    try {
      const localBundles = await listBundles()
      if (entry.disposed) return
      for (const b of localBundles) {
        if (entry.bundleTags.has(b.integrity)) {
          entry.remoteBundleNameByIntegrity.set(b.integrity, b.name)
        }
      }
    } catch (err) {
      console.warn(`objstore-presence: listBundles failed during ${workspaceId} open:`, err)
    }
    notify()
    const serverUrl = triageSync.getServerUrl()
    if (!serverUrl) return
    const httpOrigin = httpOriginFromWsUrl(serverUrl)
    if (!httpOrigin) return
    try {
      const c = ensureClient(httpOrigin)
      const session = await c.openWorkspace(entry.keys, subscription)
      if (entry.disposed) {
        try { session.close() } catch {}
        return
      }
      entry.session = session
      const items = await session.list()
      if (entry.disposed) return
      for (const item of items) {
        entry.remoteTags.add(item.resourceTag)
        // Seed the version baseline so a later `onPut` for any of
        // these tags can detect whether the broadcast bumps the
        // version (replace) or arrives at parity (a self-echo
        // overlapping the boot list).
        entry.remoteVersions.set(item.resourceTag, item.version)
      }
      // Populate reverse maps from the two cheap sources before
      // `ensureRemoteNames` falls back to `fetchByTag`:
      //   (a) attached local reports/bundles (we know tag→name
      //       because we just computed both)
      //   (b) the persisted cache from a previous session (peer-
      //       uploaded blobs we already decoded last time)
      // Both are gated on the tag being in the live `remoteTags`
      // set — stale entries from a peer-side delete don't leak into
      // `remoteFileNames` / `remoteBundleIntegrities`.
      const cached = loadPresenceCache(workspaceId)
      let cacheMutated = false
      for (const tag of entry.remoteTags) {
        const attachedName = attachedTagToName.get(tag)
        if (attachedName !== undefined && !entry.remoteNameByTag.has(tag)) {
          entry.remoteNameByTag.set(tag, attachedName)
          cacheMutated = true
        }
        const attachedIntegrity = attachedTagToIntegrity.get(tag)
        if (attachedIntegrity !== undefined && !entry.remoteBundleByTag.has(tag)) {
          entry.remoteBundleByTag.set(tag, attachedIntegrity)
          cacheMutated = true
        }
        if (cached) {
          const cachedName = cached.names[tag]
          if (typeof cachedName === 'string' && !entry.remoteNameByTag.has(tag) && !entry.remoteBundleByTag.has(tag)) {
            entry.remoteNameByTag.set(tag, cachedName)
            // Mirror the auto-discovery side-effect: ensure
            // `isInRemote(fileName)` answers true for peer-uploaded
            // names we'd otherwise only learn about via fetchByTag.
            entry.fileTags.set(cachedName, tag)
            cacheMutated = true
          }
          const cachedIntegrity = cached.bundles[tag]
          if (typeof cachedIntegrity === 'string' && !entry.remoteBundleByTag.has(tag) && !entry.remoteNameByTag.has(tag)) {
            entry.remoteBundleByTag.set(tag, cachedIntegrity)
            entry.bundleTags.set(cachedIntegrity, tag)
            const cachedBundleName = cached.bundleNames[cachedIntegrity]
            if (typeof cachedBundleName === 'string' && !entry.remoteBundleNameByIntegrity.has(cachedIntegrity)) {
              entry.remoteBundleNameByIntegrity.set(cachedIntegrity, cachedBundleName)
            }
            cacheMutated = true
          }
        }
      }
      // Persist the up-to-date pruned cache: any cached entry whose
      // tag isn't in `remoteTags` was naturally excluded above, so
      // `savePresenceCache` writes only the still-valid mappings.
      if (cacheMutated || cached) savePresenceCache(workspaceId, entry)
      notify()
      // Background-fetch each remote tag's plaintext fileName so
      // the download dialog has names ready when it opens.
      // Best-effort — a tag that decrypts to a name we don't have
      // locally still adds to `fileTags` so isInRemote can answer
      // on subsequent fetches.
      ensureRemoteNames(entry)
      // Live updates — peer (or same-user-other-tab) puts / deletes
      // flow through workspace-subscribed broadcasts; flipping the
      // cached set re-renders the badge in place.
      session.onPut(({ resourceTag, version }) => {
        const previousVersion = entry.remoteVersions.get(resourceTag)
        const isReplace = entry.remoteTags.has(resourceTag)
          && typeof previousVersion === 'number'
          && version > previousVersion
        entry.remoteTags.add(resourceTag)
        entry.remoteVersions.set(resourceTag, version)
        notify()
        if (isReplace) {
          // A workspace member overwrote this resource. The prior
          // behaviour treated every onPut as either "new tag → run
          // discovery" or "known tag → no-op", so a Replace landed
          // on disk for new joiners (who would auto-download from
          // scratch) but stayed invisible to existing peers — their
          // local bytes kept the OLD content while the workspace
          // badge claimed cloud-sync. Re-fetch the new blob and
          // overwrite local under content validation; bundles are
          // content-addressed and a "replace under the same
          // integrity" would be byte-identical, so the helper
          // skips that case.
          maybeApplyRemoteReplace(entry, resourceTag).catch(() => {})
          return
        }
        // Kick a fetchByTag for the new tag so its name lands in
        // the cache; another notify will fire when it resolves.
        ensureRemoteNames(entry)
      })
      session.onDeleted(({ resourceTag }) => {
        entry.remoteTags.delete(resourceTag)
        // Drop the version too — a future Put at the same tag is a
        // brand-new resource (the incarnation changes inside the
        // session even when the version restarts), so leaving the
        // stale version pinned would let the next onPut's
        // version-bump comparison mis-fire as a Replace.
        entry.remoteVersions.delete(resourceTag)
        const name = entry.remoteNameByTag.get(resourceTag)
        entry.remoteNameByTag.delete(resourceTag)
        // Re-resolve the workspace's live `reports` / `bundles` at
        // each broadcast instead of reading the closure-captured `ws`.
        // The boot-time snapshot would miss any identifier the user
        // attached AFTER openWorkspace (via drag-drop, import, or
        // auto-download from another peer), and an onDeleted for
        // that fresh identifier would incorrectly drop its tag from
        // the local fileTags / bundleTags cache. Cost: one
        // localStorage parse (`listWorkspaces`) plus the
        // `savePresenceCache` write at the tail of this handler —
        // a peer-side bulk delete therefore drives N synchronous
        // localStorage writes. Acceptable for the typical
        // single-resource delete; a debounce is a follow-up if a
        // workspace-wipe scenario becomes common.
        const live = listWorkspaces().find((w) => w.id === workspaceId)
        const liveReports = live?.reports ?? []
        const liveBundles = live?.bundles ?? []
        // Drop fileTags only for names we ONLY learned via remote
        // discovery — if the workspace claims the name, the local
        // owner is keeping the tag fresh.
        if (name && !liveReports.includes(name)) entry.fileTags.delete(name)
        // Mirror the cleanup for bundles.
        const integrity = entry.remoteBundleByTag.get(resourceTag)
        entry.remoteBundleByTag.delete(resourceTag)
        if (integrity) {
          entry.remoteBundleNameByIntegrity.delete(integrity)
          if (!liveBundles.includes(integrity)) entry.bundleTags.delete(integrity)
        }
        // Persist the post-delete state so the dropped tag doesn't
        // resurrect from cache on the next page refresh.
        savePresenceCache(workspaceId, entry)
        notify()
      })
    } catch (err) {
      entry.err = err
    }
  })()
  // Swallow the boot rejection on the saved promise so callers
  // (putFile) can `await entry.ready` without an unhandled
  // rejection when the connection fails. The `err` field carries
  // the diagnostic.
  entry.ready.catch(() => {})
}

export function closeWorkspace(workspaceId) {
  const entry = sessions.get(workspaceId)
  if (!entry) return
  entry.disposed = true
  try { entry.session?.close() } catch {}
  // Zero the workspace's content + tag key material we hold. The
  // session's `close()` zeroes its OWN copy (`new Uint8Array(...)`
  // wrappers inside `client.openWorkspace`), but the original
  // `entry.keys` Uint8Arrays we passed in stay live until the entry
  // is GC'd. Match the wipe contract documented at
  // `client/sync/objstore.ts:close()`.
  if (entry.keys) {
    try { entry.keys.contentKey.fill(0) } catch {}
    try { entry.keys.tagKey.fill(0) } catch {}
    entry.keys = null
  }
  sessions.delete(workspaceId)
  notify()
}

// Pre-derive tags for newly-attached identifiers so the synchronous
// `isInRemote` / `isBundleInRemote` predicates can answer correctly
// immediately after a drag-drop / import without waiting for the
// next sidebar render to call `trackFile` / `trackBundle`. Without
// these subscriptions, `setReportWorkspace` / `setBundleWorkspace`
// mutates the workspace blob but the presence module's `fileTags`
// / `bundleTags` forward maps stay snapshotted at boot time — an
// `onDeleted` broadcast race for a freshly-attached identifier
// would then mis-classify whether the local owner is keeping the
// tag fresh.
onSyncHostInstalled((host) => {
  listWorkspaces = host.listWorkspaces
  addReportToWorkspace = host.addReportToWorkspace
  addBundleToWorkspace = host.addBundleToWorkspace
  analyzeContent = host.analyzeContent
  setCount = host.setCount
  gunzipBytes = host.gunzipBytes
  listBundles = host.listBundles
  listFiles = host.listFiles
  readBundle = host.readBundle
  saveBundle = host.saveBundle
  saveFileBytes = host.saveFileBytes

  host.onReportMembershipChanged((workspaceId) => {
    // Open the presence session if not already — without this, a drag
    // into a workspace the user hasn't navigated to never gets its
    // remote subscription / cache populated, so the badge stays
    // stale and a follow-up putFile / fetchFile races the lazy open.
    // `openWorkspace` is idempotent on already-open ids; the act of
    // dropping signals the workspace now wants this report tracked.
    if (!sessions.has(workspaceId)) openWorkspace(workspaceId)
    const entry = sessions.get(workspaceId)
    if (!entry) return
    const ws = listWorkspaces().find((w) => w.id === workspaceId)
    if (!ws) return
    for (const name of ws.reports ?? []) {
      if (!entry.fileTags.has(name)) trackFile(workspaceId, name).catch(() => {})
    }
  })
  host.onBundleMembershipChanged((workspaceId) => {
    // Mirror the report-side listener: bundles dragged into a
    // workspace the user hasn't navigated to also need the workspace
    // tracked in remote presence so the badge + upload affordances
    // wire up before the user navigates.
    if (!sessions.has(workspaceId)) openWorkspace(workspaceId)
    const entry = sessions.get(workspaceId)
    if (!entry) return
    const ws = listWorkspaces().find((w) => w.id === workspaceId)
    if (!ws) return
    for (const integrity of ws.bundles ?? []) {
      if (!entry.bundleTags.has(integrity)) trackBundle(workspaceId, integrity).catch(() => {})
    }
  })

  // Workspace teardown — `ingest.js` closes a presence session in
  // lockstep with its sync session on every workspace switch (presence
  // ⊆ sync; see openWorkspace). This listener is the OTHER teardown
  // trigger: a workspace removed from the store entirely. Fire on the
  // workspaces-store delete so any presence session bound to a vanished
  // id releases its transport acquire and zeroes its key material. Also
  // drop the persisted tag→name cache — the workspace is gone, the
  // mappings are dead weight.
  host.onWorkspaceDeleted((workspaceId) => {
    closeWorkspace(workspaceId)
    clearPresenceCache(workspaceId)
  })

  // Workspace privateKey rotation — the live session's
  // `keys.signingKey` / `keys.contentKey` / `keys.tagKey` are bound to
  // the OLD private key; subsequent objstore ops would sign with stale
  // material and decrypt remote blobs against the wrong contentKey.
  // Tear down and re-open so the next access derives fresh keys
  // against the new private key. Drop the persisted cache too — the
  // cached HMACs were computed under the OLD tagKey, so every entry
  // is garbage under the new one. Mirrors triage-sync's handler at
  // `client/sync/triage-sync.ts:onWorkspacePrivateKeyChanged`.
  host.onWorkspacePrivateKeyChanged((workspaceId) => {
    if (!sessions.has(workspaceId)) return
    closeWorkspace(workspaceId)
    clearPresenceCache(workspaceId)
    openWorkspace(workspaceId)
  })
})

// Enumerate workspaceIds with a live presence entry — used by
// `switchToWorkspace` to close out every prior session without
// having to coordinate with triageSync's session set (which can
// drift if a presence session was opened by a code path other
// than `switchTo*`). Mirrors the `triageSync.openSessions` shape
// the caller iterates today.
export function openWorkspaceIds() {
  return Array.from(sessions.keys())
}

// Synchronous: render path needs an immediate answer. Returns false
// for any workspace that hasn't been opened (or for a fileName whose
// tag hasn't been computed yet) — the worst case is a transient
// "local" reading that flips to "cloud" once the session settles
// and notify() re-runs the render.
export function isInRemote(workspaceId, fileName) {
  const entry = sessions.get(workspaceId)
  if (!entry) return false
  const tag = entry.fileTags.get(fileName)
  if (!tag) return false
  return entry.remoteTags.has(tag)
}

// Pre-warm the tag cache for a fileName not in workspace.reports
// (e.g., the user just dropped a file onto a workspace; the
// workspace blob hasn't been re-read yet). Best-effort — silently
// no-ops if the workspace isn't open or its keys haven't derived.
export async function trackFile(workspaceId, fileName) {
  const entry = sessions.get(workspaceId)
  if (!entry || entry.fileTags.has(fileName)) return
  if (entry.ready && !entry.keys) await entry.ready
  if (!entry.keys) return
  entry.fileTags.set(fileName, await computeResourceTag(entry.keys.tagKey, fileName))
  if (!entry.disposed) notify()
}

// Bundle counterpart of `isInRemote` — synchronous predicate the
// render path can use to flip a bundle row's `local` / `cloud` badge
// without an await. Worst case: returns `false` while the session is
// still booting, then notify() re-renders once the tag lands.
export function isBundleInRemote(workspaceId, integrity) {
  const entry = sessions.get(workspaceId)
  if (!entry) return false
  const tag = entry.bundleTags.get(integrity)
  if (!tag) return false
  return entry.remoteTags.has(tag)
}

// Pre-warm the bundle tag cache. Mirrors `trackFile` for bundles —
// called when a bundle is freshly attached to a workspace, so a
// follow-up `isBundleInRemote` check has the tag ready.
export async function trackBundle(workspaceId, integrity) {
  const entry = sessions.get(workspaceId)
  if (!entry || entry.bundleTags.has(integrity)) return
  if (entry.ready && !entry.keys) await entry.ready
  if (!entry.keys) return
  entry.bundleTags.set(integrity, await computeBundleResourceTag(entry.keys.tagKey, integrity))
  if (!entry.disposed) notify()
}

export function onChange(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// Subscribe to auto-download completions. Fires after the
// background discovery worker decrypts a peer-uploaded report,
// confirms it isn't already local, validates it as a recognized
// report, and persists it to OPFS + attaches it to the workspace.
// `cb(workspaceId, fileName)`. The UI bridge re-runs
// `switchToWorkspace` when the affected workspace is currently
// active so the new report joins state.reports without a
// user-driven refresh.
export function onAutoDownloaded(cb) {
  autoDownloadListeners.add(cb)
  return () => autoDownloadListeners.delete(cb)
}

// Bundle counterpart of `onAutoDownloaded`. Fires after a
// peer-uploaded bundle lands locally — either via the background
// `maybeAutoDownloadBundle` worker OR via an explicit user-driven
// `fetchBundleFromRemote`. `cb(workspaceId, integrity, name)`. The
// UI bridge re-renders the sidebar so `state.bundles` picks up the
// new entry; if the bundles main view is active, the view re-renders
// against the refreshed state.bundles too.
export function onBundleAutoDownloaded(cb) {
  bundleAutoDownloadListeners.add(cb)
  return () => bundleAutoDownloadListeners.delete(cb)
}

// Enumerate the workspace's remote inventory by fileName. The wire
// `resourceTag` is HMAC and one-way, so names are only known for
// tags we've successfully `fetchByTag`-ed. The presence module
// fires off those fetches in the background on workspace open + on
// every objstore-put broadcast (see `ensureRemoteNames`); the
// returned array reflects whatever's been decoded so far.
//
// Sync to keep the render path simple: the cloud-chunk count is
// pinned to `remoteCount` (which uses the full `remoteTags` set,
// including not-yet-decoded ones), while `remoteFileNames` drives
// the "downloadable" subset. Forged tags (decrypt-fails) never
// land in `remoteNameByTag` so they drop off this list silently.
export function remoteFileNames(workspaceId) {
  const entry = sessions.get(workspaceId)
  if (!entry) return []
  return Array.from(entry.remoteNameByTag.values())
}

// Total number of remote resources the relay holds for this
// workspace — sync, used by the badge to pin the cloud-count even
// while background name-decoding is in flight.
export function remoteCount(workspaceId) {
  const entry = sessions.get(workspaceId)
  if (!entry) return 0
  return entry.remoteTags.size
}

// Async — completes any pending `fetchByTag` discovery for the
// workspace's current remote inventory and returns the resulting
// names. The download dialog calls this on open so the UI doesn't
// race the background discovery.
export async function discoverRemoteFileNames(workspaceId) {
  const entry = sessions.get(workspaceId)
  if (!entry) return []
  if (entry.ready && !entry.session) await entry.ready
  if (!entry.session) return []
  await ensureRemoteNames(entry)
  return Array.from(entry.remoteNameByTag.values())
}

// Enumerate peer-uploaded bundle integrities discovered via
// `fetchByTag`. Like `remoteFileNames`, returns whatever the
// background discovery worker has classified so far. The workspace
// badge's "M cloud" bundle count uses this for the actionable
// (downloadable) subset; the total remote count via `remoteCount`
// covers ALL tags (reports + bundles + unclassified).
export function remoteBundleIntegrities(workspaceId) {
  const entry = sessions.get(workspaceId)
  if (!entry) return []
  return Array.from(entry.remoteBundleByTag.values())
}

// Total number of remote BUNDLES (classified subset of remoteTags).
// `remoteCount` covers everything; this narrows to the bundle slice
// for the workspace badge's bundles chunk.
export function remoteBundleCount(workspaceId) {
  const entry = sessions.get(workspaceId)
  if (!entry) return 0
  return entry.remoteBundleByTag.size
}

// Awaits discovery of every peer-uploaded bundle then returns the
// resulting integrities. The download-bundles dialog calls this on
// open so it doesn't race the background classification worker.
export async function discoverRemoteBundleIntegrities(workspaceId) {
  const entry = sessions.get(workspaceId)
  if (!entry) return []
  if (entry.ready && !entry.session) await entry.ready
  if (!entry.session) return []
  await ensureRemoteNames(entry)
  return Array.from(entry.remoteBundleByTag.values())
}

// Synchronous lookup of the user-friendly name for a remote bundle
// integrity, populated by the discovery worker from `fetchByTag`.
// Returns undefined if the integrity hasn't been discovered yet (or
// isn't in remote). Used by the download dialog to render a
// meaningful label instead of the integrity-prefix fallback.
export function remoteBundleName(workspaceId, integrity) {
  const entry = sessions.get(workspaceId)
  if (!entry) return undefined
  return entry.remoteBundleNameByIntegrity.get(integrity)
}

// Background discovery worker. For each remote tag we don't yet
// have a name for, kick a `fetchByTag` and stash the decrypted
// fileName + a fileTags entry. Multiple concurrent
// `ensureRemoteNames` calls for the same workspace coalesce on the
// `inFlight` Map (tag → in-flight promise) so we never issue
// duplicate fetches AND a later caller that wants to await
// discovery picks up the existing in-flight promise.
async function ensureRemoteNames(entry) {
  if (!entry.session || entry.disposed) return
  const pending = []
  for (const tag of entry.remoteTags) {
    if (entry.remoteNameByTag.has(tag)) continue
    // Bundles: skip only when we ALSO know the user-friendly name.
    // For attached bundles with no local OPFS metadata (synthetic
    // integrities, or a bundle whose `_meta.json` entry was lost),
    // the openWorkspace boot fills `remoteBundleByTag` but not
    // `remoteBundleNameByIntegrity` — still fetch so the download
    // dialog has a meaningful label instead of an integrity prefix.
    if (entry.remoteBundleByTag.has(tag)) {
      const integrity = entry.remoteBundleByTag.get(tag)
      if (entry.remoteBundleNameByIntegrity.has(integrity)) continue
    }
    let p = entry.inFlight.get(tag)
    if (!p) {
      p = entry.session.fetchByTag(tag).then(
        async (got) => {
          entry.inFlight.delete(tag)
          if (!got || entry.disposed) return null
          // Re-check the tag is still in the live remote set
          // before mutating local state. A user-initiated delete
          // (deleteFromRemote) that landed between `fetchByTag`
          // dispatch and resolution drops the tag from
          // `remoteTags` via the `objstore-deleted` broadcast
          // handler; without this gate the auto-download below
          // would race-restore the file the user just deleted.
          if (!entry.remoteTags.has(tag)) return null
          if (got.kind === 'bundle') {
            // Peer-uploaded bundle. Stash the integrity for the
            // workspace badge's "M cloud" count + reverse-lookup so
            // a future `isBundleInRemote(integrity)` check can short-
            // circuit. Then run the auto-download path: save the
            // bytes to OPFS, attach to the workspace. Mirrors the
            // report path below — same threat model (anyone with
            // the workspace key can PUT; we re-hash on download to
            // detect content forgery), same trust posture (a peer-
            // initiated drop lands silently in the workspace just
            // like triage changes do).
            entry.remoteBundleByTag.set(tag, got.integrity)
            entry.bundleTags.set(got.integrity, tag)
            if (got.name) entry.remoteBundleNameByIntegrity.set(got.integrity, got.name)
            await maybeAutoDownloadBundle(entry, tag, got.integrity, got.name, got.content)
            return null
          }
          // Report path (existing behavior).
          entry.remoteNameByTag.set(tag, got.fileName)
          entry.fileTags.set(got.fileName, tag)
          // Auto-download: if a peer-uploaded report isn't on local
          // disk yet, save the decrypted bytes through and attach
          // them to the workspace. The bytes hit `saveFileBytes`
          // verbatim — they're already gzipped (the upload path
          // ships the on-disk gzipped representation), so OPFS
          // ends up byte-identical to a fresh local drop without
          // re-compressing.
          await maybeAutoDownload(entry, tag, got.fileName, got.content)
          return null
        },
        () => { entry.inFlight.delete(tag); return null },
      )
      entry.inFlight.set(tag, p)
    }
    pending.push(p)
  }
  if (pending.length === 0) return
  await Promise.all(pending)
  if (entry.disposed) return
  // Persist any newly-decoded tag→name mappings so a page refresh
  // doesn't repeat the (REST-heavy) `fetchByTag` round-trips.
  savePresenceCache(entry.workspaceId, entry)
  notify()
}

// Reconcile a peer-uploaded report against local state. Three
// outcomes depending on what the local fileName resolves to:
//
//   1. Our workspace already claims the fileName (echo of our own
//      upload, or a sibling tab attached it) → skip.
//   2. The fileName exists locally — whether DETACHED (no workspace
//      owns it) or already attached to another workspace — →
//      additively attach the existing copy to OUR workspace
//      WITHOUT overwriting bytes and WITHOUT detaching from any
//      other workspace that lists it. Reports can be members of
//      multiple workspaces; "detached" means "listed in zero
//      workspaces". The peer's matching upload is the signal that
//      this workspace is one of the file's homes, so our
//      `reports` row grows; any other workspace that had the
//      fileName keeps it (`addReportToWorkspace` is additive).
//      Local bytes win on conflict (the user may have edits the
//      peer doesn't yet have); the cloud bytes stay reachable
//      through the download dialog.
//   3. The fileName is missing locally → gunzip + validate +
//      persist + attach (the original download path).
//
// `tag` is passed through so each await checkpoint can re-verify
// the remote-still-claims-this-file invariant: a delete (local OR
// peer-side) that races the fetchByTag → maybeAutoDownload chain
// drops the tag from `entry.remoteTags`, and we abort BEFORE
// committing the in-flight bytes back to OPFS. Without the
// per-await re-check a user-initiated `Delete (everywhere)` could
// be observably "undone" by a race-restored file moments later.
//
// Trust-model note: this path silently writes peer-uploaded bytes
// to local OPFS + attaches them to the workspace. Anyone with the
// workspace key (a workspace member) can therefore cause
// recognized-shape reports to land locally without an explicit
// dialog confirm — symmetric with how triage-sync silently
// applies peer-signed changesets. Existing local fileNames are
// never overwritten by peer bytes: branch 2 keeps local bytes
// as-is, and the new-file branch only writes when the fileName is
// absent on disk. The `analyzeContent` gate (new-file branch)
// refuses non-report blobs.
//
// Filename-oracle property (branch 2): a workspace member who
// guesses a fileName the victim has detached locally can PUT
// that fileName into the workspace and observe the attach via
// the next `list()`. They never read the victim's bytes (branch
// 2 doesn't echo them back; the cloud row holds the attacker's
// own placeholder), but they learn that the fileName exists on
// the victim's machine. Accepted as a workspace-member trust
// trade-off: any member could already learn this by uploading a
// dummy and asking the victim out-of-band; the convergence
// benefit (no two-client split between "cloud" and "detached")
// outweighs the disclosure.
async function maybeAutoDownload(entry, tag, fileName, bytes) {
  if (entry.disposed || !entry.remoteTags.has(tag)) return
  const ws = listWorkspaces().find((w) => w.id === entry.workspaceId)
  // Skip if our workspace already claims this fileName — either we
  // uploaded it ourselves (and the broadcast is the echo) or a
  // sibling tab already attached it.
  if (ws && Array.isArray(ws.reports) && ws.reports.includes(fileName)) return
  let existsLocally
  try {
    const existing = await listFiles()
    if (entry.disposed || !entry.remoteTags.has(tag)) return
    existsLocally = existing.includes(fileName)
  } catch (err) {
    // OPFS listFiles failure (rare — usually a permission / quota
    // issue). Log so the operator sees WHY the download didn't
    // appear; without this every subsequent ensureRemoteNames pass
    // retries silently. API ergonomics audit
    // `client/sync/objstore-presence.js:343`.
    console.warn(`auto-download: listFiles failed before saving "${fileName}":`, err)
    return
  }
  if (existsLocally) {
    // Local copy exists. Additively attach to our workspace; any
    // other workspace that already lists `fileName` keeps it
    // (multi-workspace membership). Local bytes are kept as-is
    // (no `saveFileBytes`) so a user with mid-edit local content
    // doesn't see it clobbered by the peer's upload.
    // Re-check the remote-still-claims-this-file invariant right
    // before the `addReportToWorkspace` Web-Lock await: a delete-
    // everywhere that lands inside the lock-acquisition window
    // would otherwise complete the attach for a file the user
    // just removed from remote.
    if (entry.disposed || !entry.remoteTags.has(tag)) return
    try {
      await addReportToWorkspace(fileName, entry.workspaceId)
    } catch (err) {
      console.warn(`auto-download: attaching local "${fileName}" to workspace "${entry.workspaceId}" failed:`, err)
      return
    }
    if (entry.disposed) return
    for (const cb of autoDownloadListeners) {
      try { cb(entry.workspaceId, fileName) } catch {}
    }
    return
  }
  // Validate the decompressed text against `analyzeContent`. A
  // peer with the workspace key could PUT arbitrary bytes; refuse
  // anything that isn't a recognized report shape.
  let text
  try { text = decodeUtf8(await gunzipBytes(bytes)) }
  catch (err) {
    // Gunzip / utf8 decode failure usually means the peer-supplied
    // bytes were corrupt or didn't go through saveFile/saveFileBytes
    // — a forged blob from a buggy / malicious peer. Log under
    // warn so it's visible without spamming for legitimate
    // mis-matches.
    console.warn(`auto-download: gunzip/decode of "${fileName}" failed (likely forged peer payload):`, err)
    return
  }
  if (entry.disposed || !entry.remoteTags.has(tag)) return
  const result = analyzeContent(text)
  if (!result.recognized) return
  try {
    await saveFileBytes(fileName, bytes)
    if (entry.disposed || !entry.remoteTags.has(tag)) return
    setCount(fileName, result.count, result.source)
    // Final re-check before the membership-mutate await — matches
    // the branch-2 guard. setCount is synchronous so the only
    // checkpoint that could race is the addReportToWorkspace lock-
    // acquisition itself.
    if (!entry.remoteTags.has(tag)) return
    await addReportToWorkspace(fileName, entry.workspaceId)
  } catch (err) {
    // OPFS quota-exceeded or workspace-blob lock failure. The user
    // sees nothing — bytes were decrypted and validated but never
    // persisted, and the next ensureRemoteNames pass repeats the
    // whole gunzip + validate cycle. Log so quota / persistence
    // failures surface in devtools. API ergonomics audit
    // `client/sync/objstore-presence.js:358`.
    console.warn(`auto-download: persisting "${fileName}" to workspace "${entry.workspaceId}" failed:`, err)
    return
  }
  if (entry.disposed) return
  for (const cb of autoDownloadListeners) {
    try { cb(entry.workspaceId, fileName) } catch {}
  }
}

// Fan-out for a peer's Replace under an existing resourceTag.
// Triggered from the `onPut` handler when the broadcast version
// strictly exceeds the previously-known version (a self-echo where
// `putFile` already advanced `remoteVersions` to the new value
// hits the parity branch and is skipped here). Three outcomes:
//
//   1. The fetchByTag returns a bundle. Bundles are content-
//      addressed by sha512, so a "replace" under the same
//      integrity is byte-identical and there's nothing for us to
//      apply locally — bail silently. (A genuinely different
//      bundle would land under a different integrity → different
//      tag → flow through the `ensureRemoteNames` /
//      `maybeAutoDownloadBundle` branch instead.)
//   2. Content fails the `analyzeContent` gate — refuse to
//      overwrite local with bytes that don't parse as a report.
//      Mirrors the forgery defence in `maybeAutoDownload`.
//   3. Validated report bytes: persist via `saveFileBytes`
//      (which evicts the in-memory text cache so a subsequent
//      readFile re-reads from disk), refresh the cached count,
//      then notify autoDownloadListeners so the UI bridge reloads
//      the active view if it was showing this file.
//
// Workspace attach is intentionally NOT touched here — the tag
// already existed in `remoteTags`, so the workspace's `reports`
// list either already lists this fileName or never will from this
// path (callers who want to attach on receipt of a peer upload go
// through `maybeAutoDownload`, which the new-tag branch of
// `onPut` still routes to).
async function maybeApplyRemoteReplace(entry, tag) {
  if (entry.disposed || !entry.remoteTags.has(tag)) return
  let got
  try { got = await entry.session.fetchByTag(tag) }
  catch (err) {
    console.warn(`replace-refetch: fetchByTag failed for tag in workspace "${entry.workspaceId}":`, err)
    return
  }
  if (!got || entry.disposed || !entry.remoteTags.has(tag)) return
  if (got.kind === 'bundle') return
  const fileName = got.fileName
  const bytes = got.content
  let text
  try { text = decodeUtf8(await gunzipBytes(bytes)) }
  catch (err) {
    console.warn(`replace-refetch: gunzip/decode of "${fileName}" failed (likely forged peer payload):`, err)
    return
  }
  if (entry.disposed || !entry.remoteTags.has(tag)) return
  const result = analyzeContent(text)
  if (!result.recognized) {
    console.warn(`replace-refetch: peer-uploaded replacement for "${fileName}" did not analyze as a recognized report — refusing to overwrite local copy`)
    return
  }
  try {
    await saveFileBytes(fileName, bytes)
    if (entry.disposed) return
    setCount(fileName, result.count, result.source)
  } catch (err) {
    console.warn(`replace-refetch: saveFileBytes failed for "${fileName}":`, err)
    return
  }
  if (entry.disposed) return
  // Reuse the existing auto-download bridge — the UI listener
  // already reloads `state.currentWorkspace` and renders the
  // sidebar; this PR's matching change in `ui/view.js` extends it
  // to also reload `state.currentFile` so a single-file view of
  // the replaced report flips to the new bytes without a manual
  // navigate.
  for (const cb of autoDownloadListeners) {
    try { cb(entry.workspaceId, fileName) } catch {}
  }
}

// Auto-download counterpart for bundles. Sibling of
// `maybeAutoDownload` (reports), with three key differences:
//   1. Bundles are content-addressed (sha512), so we re-hash the
//      decrypted bytes and refuse on mismatch — the same forgery
//      defense `fetchBundleFromRemote` uses for explicit downloads.
//   2. No `analyzeContent`-style format gate (bundles can be any
//      bytes; the sha512 match is the entire trust gate).
//   3. The local OPFS key is the integrity, not the user-friendly
//      name — `saveBundle` re-hashes and persists under the
//      canonical key, deduping if the same bytes already exist.
async function maybeAutoDownloadBundle(entry, tag, integrity, name, bytes) {
  if (entry.disposed || !entry.remoteTags.has(tag)) return
  // Skip if we already have this integrity locally (we uploaded it
  // ourselves and the broadcast is the echo, or a sibling tab
  // already downloaded it).
  let existing
  try { existing = await listBundles() }
  catch (err) {
    console.warn(`auto-download: listBundles failed before saving bundle "${integrity}":`, err)
    return
  }
  if (entry.disposed || !entry.remoteTags.has(tag)) return
  // Multi-workspace membership (mirrors the report-side maybeAutoDownload
  // shape): `addBundleToWorkspace` ADDS to our workspace without
  // detaching from any other workspace that already lists the
  // integrity. A peer of workspace B uploading a bundle the user
  // already had attached to workspace A no longer relocates the
  // bundle from A to B — both workspaces converge to listing it.
  if (existing.some((b) => b.integrity === integrity)) {
    // Already local — additively attach to this workspace (no-op when
    // already claimed here, thanks to the W-4 / aff-empty short-
    // circuits in setWorkspaceMembership).
    try { await addBundleToWorkspace(integrity, entry.workspaceId) }
    catch (err) {
      console.warn(`auto-download: attach pre-existing bundle failed:`, err)
      return
    }
    if (entry.disposed) return
    // Fire the auto-downloaded listeners so the UI bridge refreshes
    // the sidebar — symmetric with the report-side
    // `maybeAutoDownload` already-local branch. Without this, a
    // peer's broadcast that hits this path attaches the bundle to
    // the workspace but the sidebar stays stale until the next
    // unrelated render. The name comes from the local OPFS metadata
    // (the user's existing label) — for a peer-uploaded duplicate
    // the user's local name wins, which matches the "local bytes
    // win" trust posture on the report side.
    const localName = existing.find((b) => b.integrity === integrity)?.name ?? ''
    for (const cb of bundleAutoDownloadListeners) {
      try { cb(entry.workspaceId, integrity, localName) } catch {}
    }
    return
  }
  // Re-hash check. AAD-bound name binding catches a tag-name swap;
  // the re-hash is the SOLE defense against a workspace member
  // PUTting bytes that don't actually hash to the claimed integrity.
  const computed = await computeSha512Integrity(bytes)
  if (entry.disposed || !entry.remoteTags.has(tag)) return
  if (computed !== integrity) {
    console.warn(`auto-download: bundle integrity mismatch (claimed ${integrity}, got ${computed}) — refusing to save`)
    return
  }
  // Clamp the user-friendly name. The wire wrapper allows up to 64
  // KiB but bundle names in the sidebar / OPFS metadata expect
  // something filename-sized. A misbehaving workspace member could
  // ship a 64 KiB name to bloat localStorage metadata and break the
  // sidebar render — cap defensively at 256 bytes (filename-like).
  const rawName = name && name.length > 0
    ? name
    : `bundle-${integrity.slice('sha512-'.length, 'sha512-'.length + 8)}`
  const fallbackName = clampBundleName(rawName)
  try {
    await saveBundle(fallbackName, bytes)
    if (entry.disposed || !entry.remoteTags.has(tag)) return
    await addBundleToWorkspace(integrity, entry.workspaceId)
  } catch (err) {
    console.warn(`auto-download: persisting bundle "${integrity}" to workspace "${entry.workspaceId}" failed:`, err)
    return
  }
  if (entry.disposed) return
  for (const cb of bundleAutoDownloadListeners) {
    try { cb(entry.workspaceId, integrity, fallbackName) } catch {}
  }
}

// Block until a cached session entry finishes connecting, then assert
// it actually has a live session. Shared readiness gate for the
// put / delete / fetch wrappers below. (The discovery walkers above
// await `entry.ready` too but degrade to an empty result instead of
// throwing, so they deliberately don't use this.)
async function requireConnectedSession(entry) {
  if (entry.ready && !entry.session) await entry.ready
  if (!entry.session) throw new Error(`Objstore session is not connected${formatEntryErr(entry.err)}`)
}

// Optimistic-concurrency retry: run `op(null)` (the unconditional /
// "must not exist" precondition), and on a conflict run it once more
// rebased onto the server's reported current `{ version, incarnation }`.
// Rebasing onto the full token (not just the version) is what keeps the
// retry from re-overwriting a freshly-recreated incarnation. All four
// put / delete wrappers share this exact shape.
async function retryOnConflict(op) {
  let result = await op(null)
  if (!result.ok && result.reason === 'conflict' && result.current) {
    result = await op(result.current)
  }
  return result
}

// Fetch the plaintext content for a single remote report. Reuses
// the workspace's open objstore session so the call piggybacks on
// the existing signed connection rather than minting a one-shot
// REST token. Returns `{ content, version }` on success or `null`
// when the report is not present remotely.
export async function fetchFile(workspaceId, fileName) {
  const entry = sessions.get(workspaceId)
  if (!entry) throw new Error(`Workspace ${workspaceId} is not open`)
  await requireConnectedSession(entry)
  return entry.session.fetch(fileName)
}

// Upload plaintext `content` to objstore under the workspace's
// session, encoded for the given `fileName`. The objstore session
// derives the wire tag, encrypts the (fileName, content) plaintext,
// and PUTs against the current version (null for first upload, the
// live version for an in-place overwrite). Returns the underlying
// PutResult. The objstore-put broadcast from the server feeds back
// into our subscription and flips `isInRemote` for the file.
//
// Caller must have called openWorkspace() first; throws if the
// session isn't ready (which the dialog gates on by checking
// `triageSync.status === 'online'` + presence-readiness before
// offering the action).
export async function putFile(workspaceId, fileName, content) {
  const entry = sessions.get(workspaceId)
  if (!entry) throw new Error(`Workspace ${workspaceId} is not open`)
  await requireConnectedSession(entry)
  // Optimistic first-upload precondition. The objstore session
  // tracks version monotonically internally (`seenVersions` —
  // populated by every put/fetch/list/broadcast), so on a
  // conflict we read the server's current version off the result
  // and retry with the live `prevVersion`. Pre-fix this method
  // issued an extra `list()` per upload to compute prevVersion;
  // skipping it removes a round-trip and races (cf. review
  // r3242197772).
  const result = await retryOnConflict((prev) => entry.session.put({ fileName, content, prev }))
  // Advance the local version baseline so the matching `onPut`
  // self-echo (which arrives over the subscription with the same
  // version) hits the parity branch and skips the replace-refetch.
  // Without this, every replace would round-trip the just-uploaded
  // bytes back to ourselves (harmless but wasteful — the fetched
  // content is byte-identical to what we just wrote).
  if (result.ok && entry.keys && !entry.disposed) {
    try {
      const tag = entry.fileTags.get(fileName)
        ?? await computeResourceTag(entry.keys.tagKey, fileName)
      entry.fileTags.set(fileName, tag)
      entry.remoteVersions.set(tag, result.meta.version)
    } catch {}
  }
  return result
}

// Delete `fileName`'s remote copy. The objstore `delete` is gated
// on `prevVersion: number | null`; we try unconditional first
// (which the server treats as "idempotent on missing"), and on
// conflict (a row exists at some version) retry with the server's
// reported `currentVersion`. Returns the underlying DeleteResult:
//   `{ ok: true, deletedVersion: N }` — row was at version N, gone now
//   `{ ok: true, deletedVersion: 0 }` — nothing to delete (idempotent)
//   `{ ok: false, reason }` — conflict re-fired, or server error
//
// On success the presence module ALSO drops the tag from its own
// cache synchronously. The server's `objstore-deleted` broadcast
// now includes the originator (PR landing this comment) and the
// session's `onDeleted` handler will do the same cleanup when it
// arrives — but that's an async round-trip; the synchronous drop
// here ensures `isInRemote` / `remoteCount` return false BEFORE
// this function resolves. Without the synchronous drop, an
// in-flight `fetchByTag` whose response races our delete could
// race-restore the file via `maybeAutoDownload`.
//
// Opens a short-lived presence session for the workspace if one
// isn't already cached — drag-out from a non-active workspace, or
// any other call site that doesn't first switch to the workspace,
// would otherwise silently no-op. The auto-opened session is
// closed before this function returns; an already-open session is
// left intact for the active view (review r3251765881 /
// r3251765888).
//
// Used by the local Delete dialog AND by drag-out (when a report
// is dragged out of a workspace that holds it remotely). Without
// this, the next openWorkspace would `fetchByTag` the peer copy
// and silently re-download it via `maybeAutoDownload`.
export async function deleteFromRemote(workspaceId, fileName) {
  let openedHere = false
  if (!sessions.has(workspaceId)) {
    openWorkspace(workspaceId)
    openedHere = true
  }
  try {
    const entry = sessions.get(workspaceId)
    if (!entry) throw new Error(`Workspace ${workspaceId} could not be opened — not in listWorkspaces()?`)
    await requireConnectedSession(entry)
    if (!entry.keys) throw new Error('Objstore session keys missing — derivation failed during open')
    // Pre-compute the tag so we can drop it from the local cache
    // post-delete even if `fileTags` doesn't have an entry yet (a
    // peer-uploaded file whose `fetchByTag` discovery hasn't yet
    // resolved when the user deletes from remote). Mirrors what
    // session.delete does internally, but kept here for the local-
    // cache cleanup below.
    if (!entry.fileTags.has(fileName)) {
      entry.fileTags.set(fileName, await computeResourceTag(entry.keys.tagKey, fileName))
    }
    const tag = entry.fileTags.get(fileName)
    const result = await retryOnConflict((prev) => entry.session.delete(fileName, prev))
    if (result.ok) {
      // Drop the tag locally — the server's `objstore-deleted`
      // broadcast now includes the originator (PR symmetric-broadcast)
      // and `onDeleted` will do this same cleanup when it arrives.
      // The synchronous drop here ensures isInRemote / remoteCount
      // return false IMMEDIATELY (before the broadcast round-trip)
      // so an in-flight fetchByTag whose response is queued can't
      // race-restore the file via maybeAutoDownload.
      entry.remoteTags.delete(tag)
      entry.remoteNameByTag.delete(tag)
      entry.remoteVersions.delete(tag)
      notify()
    }
    return result
  } finally {
    if (openedHere) closeWorkspace(workspaceId)
  }
}

// Upload the bundle bytes addressed by `integrity` to the workspace's
// remote objstore. Reads from OPFS via `readBundle`, encrypts under
// the workspace's contentKey, PUTs with optimistic-concurrency retry
// on conflict. The objstore-put broadcast feeds back via our session's
// subscription and flips `isBundleInRemote` for the integrity.
//
// Caller must have called openWorkspace() first; throws if the
// session isn't ready (the upload dialog gates on
// `triageSync.status === 'online'` + presence readiness before
// offering the action).
export async function putBundleToRemote(workspaceId, integrity) {
  const entry = sessions.get(workspaceId)
  if (!entry) throw new Error(`Workspace ${workspaceId} is not open`)
  await requireConnectedSession(entry)
  const content = await readBundle(integrity)
  // Pull the user-friendly name from the local bundle metadata so the
  // peer downloading this bundle sees the original sidebar label
  // (vs. a `bundle-<integrity-prefix>` fallback). The metadata is
  // keyed by integrity; on a miss (race: bundle deleted between the
  // user clicking Upload and this read) we fall back to a synthetic
  // label rather than failing the upload entirely.
  const meta = await listBundles()
  const found = meta.find((b) => b.integrity === integrity)
  const name = found?.name ?? `bundle-${integrity.slice('sha512-'.length, 'sha512-'.length + 8)}`
  return await retryOnConflict((prev) => entry.session.putBundle({ integrity, name, content, prev }))
}

// Download a bundle from the workspace's remote objstore, save it to
// OPFS, and attach it to the workspace. Mirrors the report
// download flow (download-dialog.js → fetchFile → saveFileBytes →
// setReportWorkspace) but content-addressed: after decrypt we
// re-hash the bytes and verify the sha512 matches the requested
// integrity. The re-hash is the SOLE defense against content
// forgery — a workspace member (anyone with the contentKey + tagKey)
// can PUT a blob whose embedded `name` slot says integrity-X while
// the accompanying bytes hash to anything else, and AAD/AEAD/name-
// binding all pass cleanly. See the inline comment at the re-hash
// site for the full failure mode.
//
// Returns `{ ok: true, integrity }` on success or `{ ok: false,
// reason }` on a download / validation failure.
export async function fetchBundleFromRemote(workspaceId, integrity) {
  const entry = sessions.get(workspaceId)
  if (!entry) throw new Error(`Workspace ${workspaceId} is not open`)
  await requireConnectedSession(entry)
  const result = await entry.session.fetchBundle(integrity)
  if (!result) return { ok: false, reason: 'not-found' }
  // Verify integrity hash on download. This is the ONLY defense
  // against content forgery: the AAD-bound name check inside
  // `fetchBundle` verifies the encrypted plaintext's `name` slot
  // equals the requested integrity, but it does NOT verify that the
  // accompanying content bytes actually hash to that integrity. A
  // workspace member (anyone with the workspace's contentKey + tagKey)
  // can PUT a blob whose name slot says "sha512-X" but whose content
  // is arbitrary — AAD/AEAD/name-binding all pass. Without this
  // re-hash, the user would receive whatever-bytes under a label
  // that lies about their integrity, and `saveBundle` would store
  // them under whatever they ACTUALLY hash to — leaving the
  // workspace's `bundles` list pointing at a sha512 that never
  // landed locally.
  const computed = await computeSha512Integrity(result.content)
  if (computed !== integrity) {
    return { ok: false, reason: 'integrity-mismatch' }
  }
  // `saveBundle` takes (name, content) and computes its own integrity.
  // The user-friendly bundle name now rides in the encrypted payload
  // (carried by `fetchBundle` via the structured content wrap), so
  // peers see the original sidebar label. Fall back to a synthetic
  // label only if the peer somehow shipped an empty string (malformed
  // payload from a buggy peer).
  const rawName = result.name && result.name.length > 0
    ? result.name
    : `bundle-${integrity.slice('sha512-'.length, 'sha512-'.length + 8)}`
  const name = clampBundleName(rawName)
  await saveBundle(name, result.content)
  // Fire the auto-downloaded listeners so the UI bridge can
  // refresh the sidebar + bundles view — explicit dialog-driven
  // downloads need the same post-save UI refresh that
  // `maybeAutoDownloadBundle` triggers for background discovery.
  for (const cb of bundleAutoDownloadListeners) {
    try { cb(workspaceId, integrity, name) } catch {}
  }
  return { ok: true, integrity, name }
}

// Delete a bundle's remote copy. Mirrors `deleteFromRemote` for
// reports — idempotent on missing, drops the local cache entry
// synchronously to prevent a race-restore from an in-flight
// `fetchByTag` discovery.
//
// Used by the local Delete dialog (when the user explicitly deletes
// a bundle from remote) — bundle membership detach during workspace
// leave / drag-out does NOT touch remote (vs. reports, which DO drop
// remote on drag-out); bundle bytes are content-addressed and may be
// shared across workspaces, so dropping them from one workspace's
// remote could orphan another workspace that hadn't yet downloaded.
export async function deleteBundleFromRemote(workspaceId, integrity) {
  let openedHere = false
  if (!sessions.has(workspaceId)) {
    openWorkspace(workspaceId)
    openedHere = true
  }
  try {
    const entry = sessions.get(workspaceId)
    if (!entry) throw new Error(`Workspace ${workspaceId} could not be opened — not in listWorkspaces()?`)
    await requireConnectedSession(entry)
    if (!entry.keys) throw new Error('Objstore session keys missing — derivation failed during open')
    if (!entry.bundleTags.has(integrity)) {
      entry.bundleTags.set(integrity, await computeBundleResourceTag(entry.keys.tagKey, integrity))
    }
    const tag = entry.bundleTags.get(integrity)
    const result = await retryOnConflict((prev) => entry.session.deleteBundle(integrity, prev))
    if (result.ok) {
      entry.remoteTags.delete(tag)
      entry.remoteBundleByTag.delete(tag)
      notify()
    }
    return result
  } finally {
    if (openedHere) closeWorkspace(workspaceId)
  }
}

// `isInRemote` for bundles is exported above as `isBundleInRemote`.
// The unfiled-bundle-bytes path (`putBundleToRemote` from the user
// dragging a bundle into a workspace + then explicitly clicking
// upload) also exists above.
