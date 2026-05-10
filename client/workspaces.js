// Workspaces — named scopes a user creates from the sidebar. Each
// workspace gets a uuid (`crypto.randomUUID`) and a freshly generated
// 32-byte private key on creation. Persisted as a versioned JSON
// object under `deepview.workspaces` in localStorage; the private
// key rides along base64-encoded so the JSON stays a string.
//
// Persisted shape (round-10 — pre-v1 freeze):
//   { version: 1, workspaces: [...] }
//
// Pre-version blobs were a bare JSON array; `readRaw` accepts both
// shapes so a user upgrading from a pre-version build doesn't lose
// their workspaces on first load. The next `writeRaw` rewrites in
// the versioned form.
//
// Storage is small and synchronous-friendly (a handful of entries, a
// few hundred bytes each), so localStorage is the right tier — same
// pattern as triage / view-mode state. OPFS is reserved for the
// per-report blobs.
const STORAGE_KEY = 'deepview.workspaces'
const WORKSPACES_VERSION = 1

function readRaw() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    // Versioned shape: { version, workspaces }. Read forward-compat:
    // a future version we don't recognise still hands us the array
    // (callers operate on `workspaces` only); the next `writeRaw`
    // would downgrade it back to v1, so callers running an older
    // build can lose newer fields. Acceptable for v1; revisit when
    // a v2 actually exists.
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.workspaces)) {
      return parsed.workspaces
    }
    // Pre-version legacy shape: bare array of workspace records.
    if (Array.isArray(parsed)) return parsed
    return []
  } catch {
    return []
  }
}

function writeRaw(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: WORKSPACES_VERSION,
      workspaces: list,
    }))
  } catch (err) {
    console.warn('Failed to save workspaces:', err)
  }
}

// Apply `mutator(list)` to the workspaces blob under the same-origin
// Web Lock. The list is freshly read inside the lock so a concurrent
// tab's writes are visible; if the mutator returns `false` the write
// is skipped. Pattern mirrors `mutateAllSessions` in triage-sync.js.
//
// Round-8 follow-up: the read-modify-write pattern in every public
// mutation function (createWorkspace / deleteWorkspace / etc.) used
// to do `readRaw → modify → writeRaw` synchronously, so two tabs
// writing concurrently would each read the pre-write blob, modify
// independently, and the second writer would clobber the first.
// Web Locks serialize the RMW across tabs on the same origin so
// every mutator sees the previous tab's write.
const WORKSPACE_LOCK = STORAGE_KEY
function mutateWorkspaces(mutator) {
  return navigator.locks.request(WORKSPACE_LOCK, async () => {
    const list = readRaw()
    const result = await mutator(list)
    if (result === false) return undefined
    writeRaw(list)
    return result
  })
}

// Defensive shallow clone of the fields we diff on. Keeps the
// cache stable even if a caller hands us mutable `reports` arrays.
function snapshotForCache(w) {
  return {
    id: w.id,
    privateKey: w.privateKey,
    reports: Array.isArray(w.reports) ? [...w.reports] : [],
  }
}

// `lastSeen` tracks the per-id state that listeners have already
// observed (= "what callbacks have fired about"). The propagate
// handler diffs the current blob against this and fires for any
// id whose state in the blob differs from what's been observed.
//
// Round-8 M4: the previous design updated lastSeen to the FULL
// blob inside `writeRaw`, so a local mutation that read a sibling's
// concurrent change (via readRaw, post-sibling-write, pre-handler-
// fire) would mark that sibling change as "already observed" —
// the queued storage event then ran with prev == next and the
// sibling's create / privateKey-change / reports-change silently
// dropped its listener fire. Fix: writeRaw no longer touches
// lastSeen; each public mutation calls `markObservedFor(workspace)`
// or `markObservedDeleted(id)` for the ids IT touched. A sibling-
// only change that came in via readRaw stays unmarked, so the
// handler still fires for it on the next run.
let lastSeen = readRaw().map(snapshotForCache)
function markObservedFor(workspace) {
  lastSeen = lastSeen.filter((w) => w.id !== workspace.id)
  lastSeen.push(snapshotForCache(workspace))
}
// Pin only the `reports` field of an existing observed snapshot,
// leaving `privateKey` at its previously-observed value. Used by
// `setReportWorkspace`, which only mutates `reports` — without the
// field-scoped variant, a sibling tab's concurrent privateKey
// rotation would be absorbed into lastSeen by the full-snapshot
// `markObservedFor` and its listener fire silently dropped on the
// next storage-event handler run (`prev == next` for privateKey).
// Audit round-12 H5.
function markObservedReportsFor(workspace) {
  const reports = Array.isArray(workspace.reports) ? [...workspace.reports] : []
  const existing = lastSeen.find((w) => w.id === workspace.id)
  if (existing) {
    existing.reports = reports
    return
  }
  // No prior snapshot — push a fresh one. setReportWorkspace operates
  // on workspaces already in the blob (so lastSeen has them via
  // createWorkspace / upsertWorkspace / propagate), but cover the
  // no-existing case for defense in depth.
  lastSeen.push(snapshotForCache(workspace))
}
function markObservedDeleted(id) {
  lastSeen = lastSeen.filter((w) => w.id !== id)
}

export function listWorkspaces() {
  const list = readRaw()
  // Backfill `reports` for entries persisted before report-membership
  // existed — keeps the rest of the renderer free of `?? []` checks.
  for (const w of list) {
    if (!Array.isArray(w.reports)) w.reports = []
  }
  return list
}

// Cap so a runaway paste / scripted input doesn't blow the
// `localStorage` quota with one giant name. 200 chars is comfortably
// past any sensible display label and short enough to keep the JSON
// blob small. Audit round-8 L3.
const MAX_WORKSPACE_NAME_LEN = 200

// `\0` is the separator inside `state.ignoredIds` keys
// (`${reportName}\0${id}`); a workspace name is never used in that
// position, but a control-char-bearing name still pollutes display
// layers and cross-tab logs. Strip control chars (incl. NUL) and
// cap length. Returns the cleaned string or null when nothing
// usable remains.
function sanitizeWorkspaceName(raw) {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  // eslint-disable-next-line no-control-regex
  const cleaned = trimmed.replace(/[\u0000-\u001F\u007F]/gu, "").slice(0, MAX_WORKSPACE_NAME_LEN)
  return cleaned || null
}

export async function createWorkspace(name) {
  const cleaned = sanitizeWorkspaceName(name)
  if (!cleaned) return null
  const keyBytes = new Uint8Array(32)
  crypto.getRandomValues(keyBytes)
  const workspace = {
    id: crypto.randomUUID(),
    name: cleaned,
    privateKey: keyBytes.toBase64(),
    reports: [],
    createdAt: Date.now(),
  }
  await mutateWorkspaces((list) => {
    list.push(workspace)
  })
  // Mark the new workspace as observed so the next propagate
  // handler doesn't fire createListener for it. createWorkspace
  // is a local-only affordance whose UI caller manages the new
  // workspace directly; the create-listener path is reserved for
  // upsertWorkspace's first-insert + cross-tab propagation. M4
  // round-8: importantly, we do NOT mark workspaces that came
  // through readRaw without local mutation — those may reflect a
  // sibling's queued change that still needs to fire its own
  // listener via the propagate handler.
  markObservedFor(workspace)
  return workspace
}

// Listeners notified after a new workspace is added via
// `upsertWorkspace` (first-insert) or via cross-tab propagation.
// Symmetric with `onWorkspaceDeleted`; nothing in triage-sync
// auto-subscribes to fresh workspaces today, but registries that
// repaint UI affordances or seed per-workspace caches can hook
// here without polling.
const createListeners = new Set()

export function onWorkspaceCreated(cb) {
  createListeners.add(cb)
  return () => createListeners.delete(cb)
}

// Listeners notified after a workspace is removed via
// `deleteWorkspace`. The triage-sync layer subscribes here so its
// in-memory + persisted session for the deleted workspace tears
// down immediately, instead of waiting for the next page-load
// prune (`prunePersistedSessions`). Listener errors are swallowed
// so one bad subscriber can't strand the rest.
const deleteListeners = new Set()

export function onWorkspaceDeleted(cb) {
  deleteListeners.add(cb)
  return () => deleteListeners.delete(cb)
}

// Listeners notified after a workspace's `privateKey` changes (via
// `upsertWorkspace`, e.g. import of a re-keyed bundle, or a future
// "rotate workspace key" affordance). The triage-sync layer
// subscribes so the in-flight session — whose cached
// `signingKey` / `workspaceTag` were derived from the OLD key —
// tears down and re-opens with fresh keys; otherwise saves keep
// going to the old chain under a now-orphan workspaceTag and
// silently drift away from the new identity. Listener errors are
// swallowed so one bad subscriber can't strand the rest.
const privateKeyChangeListeners = new Set()

export function onWorkspacePrivateKeyChanged(cb) {
  privateKeyChangeListeners.add(cb)
  return () => privateKeyChangeListeners.delete(cb)
}

// Listeners notified after a workspace's `reports` membership
// changes (via `setReportWorkspace`). Fired with each affected
// workspace id (an attach + detach pair fires for both old and
// new owners). The triage-sync layer subscribes so it can refresh
// `session.ids` AND hydrate state.* from baseState for ids that
// just entered scope — without that hydration, the next save's
// `effectiveLocalState` would emit deletes for ids whose triage
// was carried in baseState but never echoed into state.* (because
// the previous applyToReactiveState was scoped to the OLD
// session.ids). See the H1 audit finding.
const reportMembershipListeners = new Set()

export function onReportMembershipChanged(cb) {
  reportMembershipListeners.add(cb)
  return () => reportMembershipListeners.delete(cb)
}

export async function deleteWorkspace(id) {
  const removed = await mutateWorkspaces((list) => {
    const idx = list.findIndex((w) => w.id === id)
    if (idx < 0) return false
    list.splice(idx, 1)
    return true
  })
  if (!removed) return
  for (const cb of deleteListeners) {
    try { cb(id) } catch (err) { console.warn('workspace delete listener failed:', err) }
  }
  markObservedDeleted(id)
}

// Rename a workspace in place. Empty / whitespace-only names are
// rejected (returns false) so the sidebar caller can revert the
// inline edit; otherwise the trimmed value replaces the existing
// name and the helper returns true.
export async function renameWorkspace(id, name) {
  const cleaned = sanitizeWorkspaceName(name)
  if (!cleaned) return false
  const renamed = await mutateWorkspaces((list) => {
    const ws = list.find((w) => w.id === id)
    if (!ws || ws.name === cleaned) return false
    ws.name = cleaned
    return ws
  })
  if (!renamed) return false
  // No `markObservedFor` here — `name` isn't part of the diff (no
  // name listener; `snapshotForCache` excludes the field), so the
  // rename has nothing to advance lastSeen for. The pre-fix shape
  // pinned the FULL post-rename snapshot, which absorbed any
  // sibling-introduced privateKey / reports change that arrived via
  // readRaw inside the lock — the queued storage event then
  // computed prev == next and silently dropped the listener fire.
  // Audit round-12 H4.
  return true
}

// Insert or replace a workspace by id. Used by the import path so a
// re-import of the same workspace (same id) updates in place rather
// than producing a duplicate entry. Fires:
//   - `onWorkspaceCreated` on first-insert (new id);
//   - `onWorkspacePrivateKeyChanged` when an existing id's privateKey
//     changes (re-import of a re-keyed bundle, or a future "rotate
//     workspace key" affordance);
//   - `onReportMembershipChanged` when an existing id's `reports`
//     list changes (set-equal compare so reordering is a no-op) —
//     audit H1: a re-import that adds reports via upsertWorkspace
//     used to skip the eager hydration / conflict-dialog path the
//     rest of the membership listeners drive.
export async function upsertWorkspace(workspace) {
  const result = await mutateWorkspaces((list) => {
    const idx = list.findIndex((w) => w.id === workspace.id)
    const previous = idx >= 0 ? list[idx] : null
    // Sanitize the incoming name — `workspace` may come from an
    // imported bundle whose author put control chars or unbounded
    // length in `workspace.name`. Fall back to the previous name
    // (on update) or 'Workspace' (on first insert) when sanitization
    // empties the string. Audit round-8 L3.
    const cleanedName = sanitizeWorkspaceName(workspace.name)
      ?? previous?.name
      ?? 'Workspace'
    const next = {
      id: workspace.id,
      name: cleanedName,
      privateKey: workspace.privateKey,
      reports: Array.isArray(workspace.reports) ? workspace.reports : [],
      createdAt: workspace.createdAt ?? Date.now(),
    }
    if (idx >= 0) list[idx] = next
    else list.push(next)
    return { previous, next }
  })
  const { previous, next } = result
  if (previous == null) {
    for (const cb of createListeners) {
      try { cb(next.id) } catch (err) { console.warn('workspace create listener failed:', err) }
    }
  } else {
    if (previous.privateKey !== next.privateKey) {
      for (const cb of privateKeyChangeListeners) {
        try { cb(next.id) } catch (err) { console.warn('workspace privateKey listener failed:', err) }
      }
    }
    if (!reportsSetEqual(previous.reports ?? [], next.reports)) {
      for (const cb of reportMembershipListeners) {
        try { cb(next.id) } catch (err) { console.warn('workspace membership listener failed:', err) }
      }
    }
  }
  markObservedFor(next)
  return next
}

function reportsSetEqual(a, b) {
  if (a.length !== b.length) return false
  const set = new Set(a)
  for (const x of b) if (!set.has(x)) return false
  return true
}

// Move a report to `workspaceId` (or detach it back to the unfiled
// list when `workspaceId` is null). A report belongs to at most one
// workspace at a time; the prior assignment, if any, is dropped first.
// No-ops cleanly when the target workspace doesn't exist. Fires
// `onReportMembershipChanged` for every workspace whose `reports`
// list actually changed (so an attach + detach pair notifies both
// the old owner and the new one); a no-op call (filename is already
// where it should be) fires nothing.
export async function setReportWorkspace(filename, workspaceId) {
  const { affected, snapshot } = await mutateWorkspaces((list) => {
    const aff = new Set()
    for (const w of list) {
      if (!Array.isArray(w.reports)) w.reports = []
      if (w.reports.includes(filename)) {
        w.reports = w.reports.filter((r) => r !== filename)
        aff.add(w.id)
      }
    }
    if (workspaceId) {
      const target = list.find((w) => w.id === workspaceId)
      if (target && !target.reports.includes(filename)) {
        target.reports.push(filename)
        aff.add(target.id)
      }
    }
    // Snapshot the affected workspaces' post-mutation state so the
    // post-lock listener-fire path can call markObservedFor against
    // the canonical state — without holding the lock for the
    // listener fires.
    const snap = new Map()
    for (const id of aff) {
      const ws = list.find((w) => w.id === id)
      if (ws) snap.set(id, ws)
    }
    return { affected: aff, snapshot: snap }
  })
  for (const id of affected) {
    for (const cb of reportMembershipListeners) {
      try { cb(id) } catch (err) { console.warn('workspace membership listener failed:', err) }
    }
    // Mark only the `reports` field of this workspace as observed
    // so the propagate handler doesn't re-fire the membership
    // listener for the local change. `markObservedFor` (full
    // snapshot) would also pin the post-mutation `privateKey`,
    // absorbing a concurrent sibling privateKey rotation that
    // arrived via readRaw inside the lock — the queued storage
    // event would then compute prev == next on privateKey and
    // silently drop its listener fire. Audit round-12 H5.
    //
    // M4 round-8 still applies: only mark workspaces THIS call
    // modified — sibling changes to OTHER workspaces in the same
    // blob stay unmarked and still get a listener fire on the next
    // handler run.
    const ws = snapshot.get(id)
    if (ws) markObservedReportsFor(ws)
  }
}


// Cross-tab propagation: a sibling tab's `deleteWorkspace` /
// `upsertWorkspace` (key rotation, re-import) / `setReportWorkspace`
// fires a `storage` event in this tab. Diff the new blob against
// our cached view and re-fire the matching local listeners so the
// sync layer (which wires those listeners up) cleans up its
// in-memory + persisted session state without waiting for a page
// reload. Audit M-1.
//
// `lastSeen` represents per-id state that listeners have observed.
// Local mutations update it incrementally (only for the ids THIS
// mutation touched) via `markObservedFor` / `markObservedDeleted`;
// the propagate handler diffs the current blob against this and
// fires for any id whose blob state differs from the observed one.
// Round-8 M4: previously `writeRaw` snapshotted the FULL blob on
// every local mutation, so a sibling change that came in via
// `readRaw` (post-sibling-write, pre-handler-fire) was marked
// "observed" and silently dropped its listener fire.
//
// Exposed (not just registered) so node:test environments can
// drive the diff path directly — `window` doesn't exist in tests
// and the storage event never fires there.
export function propagateWorkspaceChangesFromStorage() {
  const next = readRaw().map(snapshotForCache)
  const prev = lastSeen
  const prevById = new Map(prev.map((w) => [w.id, w]))
  const nextById = new Map(next.map((w) => [w.id, w]))
  // Deletions
  for (const id of prevById.keys()) {
    if (nextById.has(id)) continue
    for (const cb of deleteListeners) {
      try { cb(id) } catch (err) { console.warn('workspace delete listener failed:', err) }
    }
  }
  for (const [id, w] of nextById) {
    const p = prevById.get(id)
    if (!p) {
      // Sibling-tab create — symmetric with the delete branch above.
      // Audit M3 round-3.
      for (const cb of createListeners) {
        try { cb(id) } catch (err) { console.warn('workspace create listener failed:', err) }
      }
      continue
    }
    if (p.privateKey !== w.privateKey) {
      for (const cb of privateKeyChangeListeners) {
        try { cb(id) } catch (err) { console.warn('workspace privateKey listener failed:', err) }
      }
    }
    // Set-equal compare on `reports` — reordering doesn't change
    // session.ids so it shouldn't fire spurious membership listeners.
    // Audit M2 round-3.
    if (!reportsSetEqual(p.reports, w.reports)) {
      for (const cb of reportMembershipListeners) {
        try { cb(id) } catch (err) { console.warn('workspace membership listener failed:', err) }
      }
    }
  }
  // Update lastSeen AFTER firing listeners so a re-entrant handler
  // call (storage event during a listener's work) doesn't see a
  // stale prev. The diff is the source of truth for what listeners
  // know; updating in lockstep with the fires keeps that property.
  lastSeen = next
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return
    propagateWorkspaceChangesFromStorage()
  })
}
