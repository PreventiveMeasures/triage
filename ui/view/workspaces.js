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

export function deleteWorkspace(id) {
  const list = readRaw().filter((w) => w.id !== id)
  writeRaw(list)
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
