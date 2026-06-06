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
  triageModifiedAt?: unknown
  baseState?: unknown
  savesSinceKeyframe?: unknown
}
export type PersistedSessionsMap = { [workspaceId: string]: PersistedSession | undefined }

// CURRENT state of persistence (was the last load an unknown-version
// blob?), not a one-way sticky flag, so a user who clears
// `localStorage[deepview.sync.sessions]` via DevTools recovers within
// the same page-load without a reload. Both flips (off→on AND on→off)
// fire listeners. Audit follow-up to round-15 / PR #61 latch-lifecycle.
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
      'triage-sync: can\'t persist the sessions blob — either it\'s an unrecognised future version (writes skipped to avoid clobbering a newer build\'s data) or the write itself failed (storage full / vault locked). ' +
      'Your in-memory triage state still works this session but will not persist across reload. ' +
      'Free up storage and/or clear localStorage[deepview.sync.sessions]; the badge clears on the next successful save.',
    )
  } else {
    // `warn` not `info` so operators correlating support tickets via
    // screenshares / DevTools paste don't miss the recovery transition —
    // Chrome/Firefox hide `info`-level logs in the default filter set.
    console.warn('triage-sync: persistence recovered; persisted-sessions blob is now writable.')
  }
  for (const cb of persistenceDegradedListeners) {
    try { cb(next) } catch (err) { console.warn('persistenceDegraded listener:', err) }
  }
}

// Subscribe to ALL degraded-state transitions (off↔on). The listener
// receives the new `degraded` value on every transition AND once on
// subscribe with the current state, so a lazily-mounted UI component
// (badge, toast) needn't poll. The on-subscribe fire is queued on a
// microtask so subscribe returns synchronously; unsubscribing before
// that microtask runs is safe (the listener is removed and skipped).
// Audit follow-up to PR #80 review.
export function onPersistenceDegraded(cb: (degraded: boolean) => void): () => void {
  // Wrap each subscription in a fresh closure so the Set keys on a
  // unique entry per call. Two subscriptions of the SAME `cb` reference
  // would otherwise collapse to one Set entry, and either returned
  // unsubscribe would silently remove the listener for BOTH subscribers
  // (and the on-subscribe fire would still run once per call, asymmetric).
  const wrapped = (degraded: boolean) => cb(degraded)
  persistenceDegradedListeners.add(wrapped)
  queueMicrotask(() => {
    if (!persistenceDegradedListeners.has(wrapped)) return
    try { wrapped(persistenceDegradedLatch) } catch (err) { console.warn('persistenceDegraded listener:', err) }
  })
  return () => persistenceDegradedListeners.delete(wrapped)
}

// Discriminated load result so `mutateAllSessions` can distinguish
// "doesn't exist / unparseable / legacy / current" from "future version
// we don't understand". The latter MUST skip the write — overwriting
// with a v1 shape would silently destroy what a future build persisted
// under the same key. Open-ended audit `client/triage-sync.ts:884`.
export type LoadAllSessionsResult =
  | { kind: 'v1' | 'legacy'; map: PersistedSessionsMap }
  | { kind: 'empty' }
  | { kind: 'unknown-version' }

export function loadAllSessionsResult(): LoadAllSessionsResult {
  try {
    // Read through the secure-storage cache so encrypted-at-rest session
    // state surfaces decrypted post-unlock. The cache is hydrated by
    // view.js's boot flow before any session-touching code runs.
    const raw = syncHost().getSecureItem(SESSION_STATE_KEY)
    if (!raw) return { kind: 'empty' }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { kind: 'empty' }
    const obj = parsed as { version?: unknown, sessions?: unknown }
    // Versioned shape we understand: { version === SESSIONS_VERSION,
    // sessions: map }. This version check is the gate distinguishing
    // "current build" from "future version we can't read" — the previous
    // shape returned `{}` for any unrecognised `version`, letting
    // `mutateAllSessions` overwrite a v2 blob with v1 entries.
    if (obj.version === SESSIONS_VERSION
      && obj.sessions && typeof obj.sessions === 'object' && !Array.isArray(obj.sessions)) {
      return { kind: 'v1', map: obj.sessions as PersistedSessionsMap }
    }
    // Matching version but malformed/missing `sessions` (crashed
    // mid-write, hand-edited corruption). Don't quarantine — the version
    // says "for our build", so empty start + clean rewrite on next save
    // is the right recovery. `'unknown-version'` is reserved for blobs
    // whose version we don't recognise (future data we mustn't
    // overwrite). Audit follow-up to round-15.
    if (obj.version === SESSIONS_VERSION) return { kind: 'empty' }
    if ('version' in obj) return { kind: 'unknown-version' }
    // Pre-version legacy (v0) shape: bare object keyed by workspaceId
    // (each value carried a `serverUrl` field), i.e. no `version` key.
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
    // Likely QuotaExceededError or vault-locked — sync falls back to the
    // "always start from null base" path on next reload.
    console.warn('Triage sync: could not persist session state:', err)
    return false
  }
}

export type RestoredSession = {
  baseRevision: string | null
  triageModifiedAt: number | null
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
    // Advisory display value; tolerate a missing field (older blob) by
    // defaulting to null — the next applied revision / save repopulates it.
    triageModifiedAt: typeof entry.triageModifiedAt === 'number' ? entry.triageModifiedAt : null,
    // Round-12 H6 defense-in-depth: normalise baseState into a
    // null-prototype object so a `__proto__` own key (from a prior
    // version's polluted save) doesn't trigger the Object.prototype
    // setter when downstream spreads/assigns from it. JSON.parse always
    // returns Object.prototype-having objects; convert at the trust boundary.
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
      // Future-build blob we don't recognize. Writing v1 over it would
      // silently destroy the future shape; skip. In-memory state still
      // updates via the caller's other paths, but on next page-load it's
      // lost (future blob re-read, no entries for our workspaceId → null
      // → fresh session, re-fetches keyframe from server). Flip
      // `persistenceDegraded` so the UI can hint
      // (`triageSync.persistenceDegraded` exposes it). Follow-up round-15.
      setPersistenceDegraded(true)
      return
    }
    const all = (r.kind === 'v1' || r.kind === 'legacy') ? r.map : {}
    const result = await mutator(all)
    if (result === false) return
    const wroteSuccessfully = await writeAllSessionsRaw(all)
    // Confirmed write clears the latch; a swallowed failure
    // (QuotaExceededError / vault-locked — writeAllSessionsRaw logs and
    // returns false) RAISES it. Such a failure is itself degraded
    // persistence: state isn't saved, won't survive reload, no other
    // signal. This is the producer half the hydrate handler's `empty`-case
    // comment in triage-sync.ts anticipated ("a pre-existing ON state
    // from a failed write should persist…").
    setPersistenceDegraded(!wroteSuccessfully)
  })
}

// Drop persisted entries that can no longer be applied. Two classes:
//   1. Workspace deleted while we were away. (Live deletions go through
//      the `onWorkspaceDeleted` listener; this handles the offline-tab
//      case.)
//   2. The entry's `serverUrl` doesn't match the relay we're about to
//      use. Revision IDs are per-server, so `loadPersistedSession`
//      already refuses such an entry (null on `serverUrl !==
//      currentServerUrl`) — pruning just stops dead bytes lingering in
//      localStorage. Older builds with a different WS path (e.g.
//      pre-`/api/sync`) are the typical source.
//
// `currentUrl=null` (default) skips the URL check — module load runs
// before the sidebar primes the URL, so a null check would nuke every
// entry. `setServerUrl` re-runs this with the URL once known.
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

// Drop the persisted-session entry for one workspace id (if any). Used
// by the workspace-deleted listener so the blob doesn't survive the
// deletion until the next page-load prune. Returns the lock-RMW promise
// so callers needing to observe the wipe before reading the blob (e.g.
// the privateKey-rotation listener, before reopening — audit H2) can
// `await` it; others can fire-and-forget.
export function dropPersistedSession(workspaceId: string): Promise<void> {
  return mutateAllSessions((all) => {
    if (!(workspaceId in all)) return false
    delete all[workspaceId]
    return undefined
  })
}
