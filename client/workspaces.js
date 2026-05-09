// Workspaces — named scopes a user creates from the sidebar. Each
// workspace gets a uuid (`crypto.randomUUID`) and a freshly generated
// 32-byte private key on creation. The list is persisted as a single
// JSON array under `deepview.workspaces` in localStorage; the private
// key rides along base64-encoded so the JSON stays a string.
//
// Storage is small and synchronous-friendly (a handful of entries, a
// few hundred bytes each), so localStorage is the right tier — same
// pattern as triage / view-mode state. OPFS is reserved for the
// per-report blobs.
const STORAGE_KEY = 'deepview.workspaces'

function readRaw() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeRaw(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch (err) {
    console.warn('Failed to save workspaces:', err)
  }
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

export function createWorkspace(name) {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return null
  const keyBytes = new Uint8Array(32)
  crypto.getRandomValues(keyBytes)
  const workspace = {
    id: crypto.randomUUID(),
    name: trimmed,
    privateKey: keyBytes.toBase64(),
    reports: [],
    createdAt: Date.now(),
  }
  const list = readRaw()
  list.push(workspace)
  writeRaw(list)
  return workspace
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

export function deleteWorkspace(id) {
  const list = readRaw()
  const next = list.filter((w) => w.id !== id)
  if (next.length === list.length) return
  writeRaw(next)
  for (const cb of deleteListeners) {
    try { cb(id) } catch (err) { console.warn('workspace delete listener failed:', err) }
  }
}

// Rename a workspace in place. Empty / whitespace-only names are
// rejected (returns false) so the sidebar caller can revert the
// inline edit; otherwise the trimmed value replaces the existing
// name and the helper returns true.
export function renameWorkspace(id, name) {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return false
  const list = readRaw()
  const ws = list.find((w) => w.id === id)
  if (!ws || ws.name === trimmed) return false
  ws.name = trimmed
  writeRaw(list)
  return true
}

// Insert or replace a workspace by id. Used by the import path so a
// re-import of the same workspace (same id) updates in place rather
// than producing a duplicate entry.
export function upsertWorkspace(workspace) {
  const list = readRaw()
  const idx = list.findIndex((w) => w.id === workspace.id)
  const next = {
    id: workspace.id,
    name: workspace.name,
    privateKey: workspace.privateKey,
    reports: Array.isArray(workspace.reports) ? workspace.reports : [],
    createdAt: workspace.createdAt ?? Date.now(),
  }
  if (idx >= 0) list[idx] = next
  else list.push(next)
  writeRaw(list)
  return next
}

// Move a report to `workspaceId` (or detach it back to the unfiled
// list when `workspaceId` is null). A report belongs to at most one
// workspace at a time; the prior assignment, if any, is dropped first.
// No-ops cleanly when the target workspace doesn't exist.
export function setReportWorkspace(filename, workspaceId) {
  const list = readRaw()
  for (const w of list) {
    if (!Array.isArray(w.reports)) w.reports = []
    w.reports = w.reports.filter((r) => r !== filename)
  }
  if (workspaceId) {
    const target = list.find((w) => w.id === workspaceId)
    if (target && !target.reports.includes(filename)) target.reports.push(filename)
  }
  writeRaw(list)
}
