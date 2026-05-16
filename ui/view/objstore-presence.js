// Tracks which reports of an open workspace are present in the
// objstore remote inventory. Used by the header sync-status badge
// to flip between "local" (default) and "cloud" (the workspace
// holds an objstore resource for this fileName).
//
// Lifecycle: openWorkspace(id) is called from `ingest.js` when a
// workspace becomes the active scope (switchToFile / switchToWorkspace
// hooks). The hook opens a single objstore WS session per workspace,
// snapshots `list()`, then subscribes to objstore-put / objstore-deleted
// broadcasts so the cached set follows the live inventory without
// polling. closeWorkspace(id) tears the session down when the user
// moves to a different workspace (or to no workspace).
//
// Tag mapping: the objstore session encrypts (fileName, content)
// internally and uses HMAC-SHA-256(tagKey, fileName) as the wire
// `resourceTag`. The presence module mirrors the HMAC so the
// synchronous render path can answer `isInRemote(workspaceId,
// fileName)` without an await — same key, same input → same tag,
// so the cached `remoteTags` set is comparable against the locally
// computed tag for any fileName the workspace knows.
//
// The HMAC is one-way (the relay can't reverse it; nor can a peer
// without the tagKey). To enumerate remote files by fileName (for
// the download dialog), the presence module fetches each remote
// tag via `session.fetchByTag(tag)` — which decrypts the inner
// blob, surfaces the encoded fileName, and verifies the
// tag-to-name rebinding.

import { createObjstoreSession, deriveObjstoreKeys } from '../../client/objstore.ts'
import { computeResourceTag } from '../../client/objstore-content-crypto.ts'
import { triageSync } from '../../client/triage-sync.ts'
import { listWorkspaces, setReportWorkspace } from '../../client/workspaces.js'
import { gunzipBytes, listFiles, saveFileBytes } from '../../client/storage.js'
import { analyzeContent, setCount } from '../../client/counts.js'
import { decodeUtf8 } from '../../common/utf8.js'

const sessions = new Map()
const listeners = new Set()
// Fired after the auto-download worker saves a new report to OPFS
// + attaches it to the workspace. The UI bridge re-runs
// `switchToWorkspace` if the affected workspace is currently
// active so the new report joins state.reports without a manual
// refresh.
const autoDownloadListeners = new Set()

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
// captures rejection from `createObjstoreSession`, which can also
// reject with a non-Error value (Web Locks API throws plain
// `{ name, message }` DOMExceptions; `crypto.subtle.*` failures
// surface as DOMException too). Falling back to `String(err)`
// instead of bare `err` avoids producing `[object Object]` in the
// thrown message. Memory-lifecycle audit follow-up
// `ui/view/objstore-presence.js:374`.
function formatEntryErr(err) {
  if (err == null) return ''
  if (err instanceof Error && err.message) return `: ${err.message}`
  if (typeof err === 'string' && err) return `: ${err}`
  if (typeof err === 'object' && typeof err.message === 'string' && err.message) return `: ${err.message}`
  try { return `: ${String(err)}` } catch { return '' }
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
  // `fileTags` mirrors the objstore's HMAC tags for every fileName
  // the workspace knows locally. `remoteTags` is the set of tags
  // the relay says the workspace holds; we compare them by HMAC.
  const entry = {
    workspaceId,
    session: null, keys: null,
    remoteTags: new Set(), fileTags: new Map(),
    remoteNameByTag: new Map(), inFlight: new Map(),
    err: null, disposed: false, ready: null,
  }
  sessions.set(workspaceId, entry)
  entry.ready = (async () => {
    entry.keys = await deriveObjstoreKeys(ws.privateKey, ws.id)
    if (entry.disposed) return
    // Pre-compute fileTags BEFORE opening the WS session so a render
    // racing the boot has its lookups resolve (to `false`) rather
    // than miss-and-return-false-with-no-cache.
    for (const name of ws.reports ?? []) {
      entry.fileTags.set(name, await computeResourceTag(entry.keys.tagKey, name))
    }
    if (entry.disposed) return
    notify()
    const serverUrl = triageSync.getServerUrl()
    if (!serverUrl) return
    const httpOrigin = httpOriginFromWsUrl(serverUrl)
    if (!httpOrigin) return
    try {
      const session = await createObjstoreSession({ serverUrl, httpOrigin, keys: entry.keys })
      if (entry.disposed) {
        try { session.close() } catch {}
        return
      }
      entry.session = session
      const items = await session.list()
      if (entry.disposed) return
      for (const item of items) entry.remoteTags.add(item.resourceTag)
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
      session.onPut(({ resourceTag }) => {
        entry.remoteTags.add(resourceTag)
        notify()
        // Kick a fetchByTag for the new tag so its name lands in
        // the cache; another notify will fire when it resolves.
        ensureRemoteNames(entry)
      })
      session.onDeleted(({ resourceTag }) => {
        entry.remoteTags.delete(resourceTag)
        const name = entry.remoteNameByTag.get(resourceTag)
        entry.remoteNameByTag.delete(resourceTag)
        // Drop fileTags only for names we ONLY learned via remote
        // discovery — if `ws.reports` contains the name, the local
        // owner is keeping the tag fresh.
        if (name && !(ws.reports ?? []).includes(name)) entry.fileTags.delete(name)
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
  // wrappers in `createObjstoreSession`), but the original
  // `entry.keys` Uint8Arrays we passed in stay live until the entry
  // is GC'd. Match the wipe contract documented at
  // `client/objstore.ts:close()`.
  if (entry.keys) {
    try { entry.keys.contentKey.fill(0) } catch {}
    try { entry.keys.tagKey.fill(0) } catch {}
    entry.keys = null
  }
  sessions.delete(workspaceId)
  notify()
}

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
  if (!entry.disposed) notify()
}

// Decompress + validate + persist a peer-uploaded report. Skipped
// when the workspace already lists the report (the user dragged it
// in locally and we're seeing our own broadcast echo), or when
// the file already exists on disk under a different workspace
// attachment, or when the bytes don't decompress to a recognized
// report format (a forged blob from a buggy / malicious peer).
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
// applies peer-signed changesets. The collision check below
// refuses to overwrite an existing local fileName; the
// `analyzeContent` gate refuses non-report blobs.
async function maybeAutoDownload(entry, tag, fileName, bytes) {
  if (entry.disposed || !entry.remoteTags.has(tag)) return
  // Skip if the workspace already claims this fileName — either we
  // uploaded it ourselves (and the broadcast is the echo) or a
  // sibling tab already attached it.
  const ws = listWorkspaces().find((w) => w.id === entry.workspaceId)
  if (ws && Array.isArray(ws.reports) && ws.reports.includes(fileName)) return
  // Skip if the fileName collides with a local report (in any
  // workspace OR unfiled). Auto-attaching to OUR workspace would
  // overwrite the prior owner's bytes; leave the dialog to do an
  // explicit overwrite if the user wants it.
  try {
    const existing = await listFiles()
    if (entry.disposed || !entry.remoteTags.has(tag)) return
    if (existing.includes(fileName)) return
  } catch (err) {
    // OPFS listFiles failure (rare — usually a permission / quota
    // issue). Log so the operator sees WHY the download didn't
    // appear; without this every subsequent ensureRemoteNames pass
    // retries silently. API ergonomics audit
    // `ui/view/objstore-presence.js:343`.
    console.warn(`auto-download: listFiles failed before saving "${fileName}":`, err)
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
    await setReportWorkspace(fileName, entry.workspaceId)
  } catch (err) {
    // OPFS quota-exceeded or workspace-blob lock failure. The user
    // sees nothing — bytes were decrypted and validated but never
    // persisted, and the next ensureRemoteNames pass repeats the
    // whole gunzip + validate cycle. Log so quota / persistence
    // failures surface in devtools. API ergonomics audit
    // `ui/view/objstore-presence.js:358`.
    console.warn(`auto-download: persisting "${fileName}" to workspace "${entry.workspaceId}" failed:`, err)
    return
  }
  if (entry.disposed) return
  for (const cb of autoDownloadListeners) {
    try { cb(entry.workspaceId, fileName) } catch {}
  }
}

// Fetch the plaintext content for a single remote report. Reuses
// the workspace's open objstore session so the call piggybacks on
// the existing signed connection rather than minting a one-shot
// REST token. Returns `{ content, version }` on success or `null`
// when the report is not present remotely.
export async function fetchFile(workspaceId, fileName) {
  const entry = sessions.get(workspaceId)
  if (!entry) throw new Error(`Workspace ${workspaceId} is not open`)
  if (entry.ready && !entry.session) await entry.ready
  if (!entry.session) throw new Error(`Objstore session is not connected${formatEntryErr(entry.err)}`)
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
  if (entry.ready && !entry.session) await entry.ready
  if (!entry.session) throw new Error(`Objstore session is not connected${formatEntryErr(entry.err)}`)
  // Optimistic first-upload precondition. The objstore session
  // tracks version monotonically internally (`seenVersions` —
  // populated by every put/fetch/list/broadcast), so on a
  // conflict we read the server's current version off the result
  // and retry with the live `prevVersion`. Pre-fix this method
  // issued an extra `list()` per upload to compute prevVersion;
  // skipping it removes a round-trip and races (cf. review
  // r3242197772).
  let result = await entry.session.put({ fileName, content, prevVersion: null })
  if (!result.ok && result.reason === 'conflict' && typeof result.currentVersion === 'number') {
    result = await entry.session.put({ fileName, content, prevVersion: result.currentVersion })
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
// cache, because the server's `objstore-deleted` broadcast
// excludes the originating socket (see
// `server/objstore/handlers.ts`'s `handleDelete`). Without the
// explicit drop here, isInRemote / remoteCount would lag the
// server's view until something else (peer broadcast, re-list)
// repaired it — and any in-flight `fetchByTag` would race-restore
// the file via `maybeAutoDownload`.
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
    if (entry.ready && !entry.session) await entry.ready
    if (!entry.session) throw new Error(`Objstore session is not connected${formatEntryErr(entry.err)}`)
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
    let result = await entry.session.delete(fileName, null)
    if (!result.ok && result.reason === 'conflict' && typeof result.currentVersion === 'number') {
      result = await entry.session.delete(fileName, result.currentVersion)
    }
    if (result.ok) {
      // Drop the tag locally — the server confirmed the delete but
      // its broadcast excludes the originator (this socket), so we
      // won't see the `objstore-deleted` event for our own delete.
      // Without this drop the auto-download race-guard in
      // maybeAutoDownload would see the still-present tag, the
      // local watermark would lag the server's view, and an
      // in-flight fetchByTag could race-restore the file.
      entry.remoteTags.delete(tag)
      entry.remoteNameByTag.delete(tag)
      notify()
    }
    return result
  } finally {
    if (openedHere) closeWorkspace(workspaceId)
  }
}
