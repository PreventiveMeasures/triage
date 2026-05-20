// Per-workspace session persistence, split out of triage-sync.ts. Owns
// the localStorage-backed sessions blob (load / write / read-modify-write
// under a Web Lock, version discrimination) and the "persistence
// degraded" latch the UI surfaces when the blob is a future version we
// must not clobber. Secure-storage + workspace access go through
// `syncHost()` (the host's identity-shared accessors). The session
// machinery in triage-sync.ts drives this: `persistSession` (which owns
// the live serverUrl) and the boot hydration handler call in here.

import { syncHost } from './host.ts'
import type { TriageStateMap } from './triage-changeset.ts'

const SESSION_STATE_KEY = 'deepview.sync.sessions'
const SESSION_STATE_LOCK = SESSION_STATE_KEY
const SESSIONS_VERSION = 1

// Per-workspace-id persisted blob — what `loadAllSessions` hands
// out and `mutateAllSessions`'s mutator manipulates. Untrusted
// (loaded from localStorage / cross-tab writes), so every reader
// re-validates the shape it cares about.
type PersistedSession = {
  serverUrl?: unknown
  baseRevision?: unknown
  baseState?: unknown
  savesSinceKeyframe?: unknown
}
export type PersistedSessionsMap = { [workspaceId: string]: PersistedSession | undefined }

// CURRENT state of persistence (was the last load result an
// unknown-version blob?), not just a one-way sticky flag, so a user
// who clears `localStorage[deepview.sync.sessions]` via DevTools
// can recover within the same page-load without a reload. Both
// flips (off→on AND on→off) fire registered listeners. Audit
// follow-up to round-15 / PR #61 latch-lifecycle review.
let persistenceDegradedLatch = false
const persistenceDegradedListeners = new Set<(degraded: boolean) => void>()

export function persistenceDegraded(): boolean {
  return persistenceDegradedLatch
}

export function setPersistenceDegraded(next: boolean): void {
  if (persistenceDegradedLatch === next) return
  persistenceDegradedLatch = next
  if (next) {
    console.warn(
      'triage-sync: persisted-sessions blob has an unrecognised version; skipping writes to avoid clobbering a future build\'s data. ' +
      'Your in-memory triage state still works this session but will not persist across reload. ' +
      'Clear localStorage[deepview.sync.sessions] to recover (note: same-tab DevTools removeItem doesn\'t fire the cross-tab `storage` event, so the badge clears on the NEXT successful save).',
    )
  } else {
    // `warn` rather than `info` so operators correlating support
    // tickets via screenshares / DevTools paste don't miss the
    // recovery transition — Chrome/Firefox hide `info`-level logs
    // by default in the standard filter set.
    console.warn('triage-sync: persistence recovered; persisted-sessions blob is now writable.')
  }
  for (const cb of persistenceDegradedListeners) {
    try { cb(next) } catch (err) { console.warn('persistenceDegraded listener:', err) }
  }
}

// Subscribe to ALL degraded-state transitions (off↔on, both
// directions). The listener receives the new `degraded` value on every
// transition AND once on subscribe with the current state — so a
// lazily-mounted UI component (badge, toast) doesn't have to separately
// poll. The on-subscribe fire is queued on a microtask so the subscribe
// call returns synchronously; calling the returned unsubscribe before
// the queued microtask runs is safe (the listener is removed before the
// dispatch and skipped). Audit follow-up to PR #80 review.
export function onPersistenceDegraded(cb: (degraded: boolean) => void): () => void {
  persistenceDegradedListeners.add(cb)
  queueMicrotask(() => {
    if (!persistenceDegradedListeners.has(cb)) return
    try { cb(persistenceDegradedLatch) } catch (err) { console.warn('persistenceDegraded listener:', err) }
  })
  return () => persistenceDegradedListeners.delete(cb)
}

// Discriminated load result so `mutateAllSessions` can distinguish
// "blob doesn't exist / is unparseable / is legacy / is current"
// from "blob is a future version we don't understand". The latter
// MUST skip the write — overwriting with a v1 shape would silently
// destroy whatever a future build persisted under the same key.
// Open-ended audit `client/triage-sync.ts:884`.
export type LoadAllSessionsResult =
  | { kind: 'v1' | 'legacy'; map: PersistedSessionsMap }
  | { kind: 'empty' }
  | { kind: 'unknown-version' }

export function loadAllSessionsResult(): LoadAllSessionsResult {
  try {
    // Read through the secure-storage cache so encrypted-at-rest
    // session state surfaces decrypted post-unlock. Cache is
    // hydrated by view.js's boot flow before any session-touching
    // code runs.
    const raw = syncHost().getSecureItem(SESSION_STATE_KEY)
    if (!raw) return { kind: 'empty' }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { kind: 'empty' }
    const obj = parsed as { version?: unknown, sessions?: unknown }
    // Versioned shape we understand: { version === SESSIONS_VERSION,
    // sessions: map }. The `version === SESSIONS_VERSION` check is
    // the gate that distinguishes "current build" from "future
    // version we don't know how to read" — the previous shape
    // returned `{}` for any unrecognised `version`, which let
    // `mutateAllSessions` overwrite a v2 blob with v1 entries.
    if (obj.version === SESSIONS_VERSION
      && obj.sessions && typeof obj.sessions === 'object' && !Array.isArray(obj.sessions)) {
      return { kind: 'v1', map: obj.sessions as PersistedSessionsMap }
    }
    // Matching version but malformed/missing `sessions` (e.g. crashed
    // mid-write, hand-edited corruption). Don't quarantine the
    // localStorage entry — the version says "this is for our build",
    // so an empty start + clean rewrite on next save is the right
    // recovery. `'unknown-version'` is reserved for blobs whose
    // version we don't recognise (future build's data we mustn't
    // overwrite). Audit follow-up to round-15.
    if (obj.version === SESSIONS_VERSION) return { kind: 'empty' }
    if ('version' in obj) return { kind: 'unknown-version' }
    // Pre-version legacy shape: bare object keyed by workspaceId.
    // The legacy entries had a `serverUrl` field on each value, so
    // a flat object without a `version` key is the v0 shape.
    return { kind: 'legacy', map: obj as PersistedSessionsMap }
  } catch { return { kind: 'empty' } }
}

function loadAllSessions(): PersistedSessionsMap {
  const r = loadAllSessionsResult()
  return (r.kind === 'v1' || r.kind === 'legacy') ? r.map : {}
}

// Returns true on a successful write, false on a swallowed
// persist error (QuotaExceededError, vault-locked-cannot-save).
// Callers gate `persistenceDegraded` clear-on-success on this — a
// quota-exceeded write that the user can't see ("disk full" with
// no surfaced error) is itself a form of degraded persistence and
// the UI hint should stay on.
async function writeAllSessionsRaw(map: PersistedSessionsMap): Promise<boolean> {
  try {
    await syncHost().setSecureItem(SESSION_STATE_KEY, JSON.stringify({
      version: SESSIONS_VERSION,
      sessions: map,
    }))
    return true
  } catch (err) {
    // Likely QuotaExceededError or vault-locked-cannot-save — sync
    // just falls back to the "always start from null base" path on
    // next reload.
    console.warn('Triage sync: could not persist session state:', err)
    return false
  }
}

export type RestoredSession = {
  baseRevision: string | null
  baseState: TriageStateMap
  savesSinceKeyframe: number
}

// Read-only — used by `openSession` to restore on module load /
// re-open. No lock: the read alone can't corrupt anything, and a
// concurrent writer's blob is whatever it serialized atomically
// anyway. Callers that read-then-write go through `mutateAllSessions`.
export function loadPersistedSession(workspaceId: string, currentServerUrl: string): RestoredSession | null {
  if (!currentServerUrl) return null
  const all = loadAllSessions()
  const entry = all[workspaceId]
  if (!entry || entry.serverUrl !== currentServerUrl) return null
  return {
    baseRevision: typeof entry.baseRevision === 'string' ? entry.baseRevision : null,
    // Round-12 H6 defense-in-depth: normalise the persisted blob's
    // baseState into a null-prototype object so a `__proto__` own
    // key (from a prior version's polluted save) doesn't trigger
    // the Object.prototype setter when downstream code spreads or
    // assigns from it. JSON.parse always returns Object.prototype-
    // having objects; convert here at the trust boundary.
    baseState: (entry.baseState && typeof entry.baseState === 'object')
      ? Object.assign(Object.create(null), entry.baseState)
      : Object.create(null),
    savesSinceKeyframe: typeof entry.savesSinceKeyframe === 'number' ? entry.savesSinceKeyframe : 0,
  }
}

type SessionsMutator = (all: PersistedSessionsMap) => Promise<unknown> | unknown

// Apply `mutator(map)` to the persisted-sessions blob under the
// SESSION_STATE_LOCK Web Lock. The mutator runs on a freshly-read
// copy so a concurrent tab's writes are visible. Setting `false` as
// the mutator's return value skips the write (no-op when the mutator
// didn't actually change anything).
export async function mutateAllSessions(mutator: SessionsMutator): Promise<void> {
  await navigator.locks.request(SESSION_STATE_LOCK, async () => {
    const r = loadAllSessionsResult()
    if (r.kind === 'unknown-version') {
      // The persisted blob is from a future build we don't recognize.
      // Writing v1 over it would silently destroy the future shape;
      // skip the mutation. In-memory session state still updates via
      // the caller's other paths, but on next page-load it's lost
      // (the future blob is read again, sees no entries for our
      // workspaceId, returns null → fresh session, re-fetches
      // keyframe from server). Flip `persistenceDegraded` so the UI
      // can surface a hint to the user; `triageSync.persistenceDegraded`
      // exposes it. Audit follow-up to round-15.
      setPersistenceDegraded(true)
      return
    }
    const all = (r.kind === 'v1' || r.kind === 'legacy') ? r.map : {}
    const result = await mutator(all)
    if (result === false) return
    const wroteSuccessfully = await writeAllSessionsRaw(all)
    // Clear the degraded latch ONLY on a confirmed successful
    // write. A quota-exceeded / vault-locked write would silently
    // fail (the catch in writeAllSessionsRaw logs but returns
    // false) — if we cleared the latch unconditionally, the UI
    // hint would disappear while persistence is still broken. The
    // latch staying ON keeps the user informed that their state
    // isn't being persisted. Audit follow-up to PR #80 cross-tab
    // review.
    if (wroteSuccessfully) setPersistenceDegraded(false)
  })
}

// Drop persisted entries that can no longer be applied. Two
// classes:
//   1. Workspace was deleted while we were away. (Live deletions go
//      through the `onWorkspaceDeleted` listener; this handles the
//      offline-tab case.)
//   2. The entry's `serverUrl` doesn't match the relay we're about
//      to use. Revision IDs are per-server, so `loadPersistedSession`
//      already refuses to apply such an entry (returns null on
//      `entry.serverUrl !== currentServerUrl`) — pruning here just
//      stops the dead bytes from sitting in localStorage forever.
//      Older builds with a different WS path (e.g. pre-`/api/sync`)
//      are the typical source.
//
// Pass `currentUrl=null` (default) to skip the URL check — module
// load runs before the sidebar primes the URL, so a null check
// there would nuke every entry. `setServerUrl` re-runs this with
// the new URL once it's known.
export function prunePersistedSessions(currentUrl: string | null = null): void {
  mutateAllSessions((all) => {
    const ids = Object.keys(all)
    if (ids.length === 0) return false
    const live = new Set(syncHost().listWorkspaces().map((w) => w.id))
    let changed = false
    for (const id of ids) {
      const entry = all[id]
      const stale = !live.has(id)
        || (currentUrl != null && entry?.serverUrl !== currentUrl)
      if (stale) {
        delete all[id]
        changed = true
      }
    }
    return changed ? undefined : false
  }).catch((err) => { console.warn('Triage sync: prunePersistedSessions lock failed:', err) })
}

// Drop the persisted-session entry for one workspace id (if any).
// Used by the workspace-deleted listener so the live persistence
// blob doesn't survive the deletion until the next page-load prune.
// Returns the underlying lock-RMW promise so callers that need to
// observe the wipe before they read the blob (e.g. the privateKey-
// rotation listener, before reopening the session — audit H2)
// can `await` it. Other callers can fire-and-forget.
export function dropPersistedSession(workspaceId: string): Promise<void> {
  return mutateAllSessions((all) => {
    if (!(workspaceId in all)) return false
    delete all[workspaceId]
    return undefined
  })
}
