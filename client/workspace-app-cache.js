import { getItem, mutate, onAfterHydrate } from './secure-storage.js'
import { listWorkspaces } from './workspaces.js'
import { onReportMembershipChanged, onWorkspaceDeleted } from './workspace-listeners.js'
import { onFileMutated } from './storage.js'
import { linkFiles, subscribeToLinkedFindings } from './linked-findings-index.js'

const KEY = 'deepview.workspaceApp'
const VERSION = 1
const listeners = new Set()
const dirty = new Set()
let allDirty = 0
let epoch = 0
let pending = Promise.resolve()
let observed = null

function parse(raw = getItem(KEY)) {
  try {
    const value = JSON.parse(raw)
    if (value?.version === VERSION && value.entries && typeof value.entries === 'object') return value
  } catch {}
  return { version: VERSION, revision: '', links: '[]', entries: {} }
}
function notify() {
  for (const cb of listeners) cb()
}
function enqueue(update) {
  const task = pending.then(() => mutate(KEY, (raw) => update(parse(raw))))
  pending = task.catch((err) => console.warn('workspace App cache:', err))
  return task
}
function membership(workspace) { return JSON.stringify(workspace.reports.toSorted()) }

export function getWorkspaceAppMetadata(workspace) {
  if (allDirty || dirty.has(workspace.id)) return null
  const entry = parse().entries[workspace.id]
  if (!entry || entry.reports !== membership(workspace) || typeof entry.appMode !== 'boolean') return null
  if (entry.appMode && (!Number.isSafeInteger(entry.appFindings) || entry.appFindings < 0)) return null
  return entry
}

// Capture before reading reports; both same-tab and sibling-tab mutations can
// invalidate a calculation while its OPFS reads are still in flight.
export async function workspaceAppCacheToken() {
  let drained
  do { drained = pending; await drained } while (drained !== pending)
  return { epoch, revision: parse().revision }
}
export async function cacheWorkspaceAppMetadata(workspace, metadata, token) {
  let stored = false
  await enqueue((cache) => {
    if (token.epoch !== epoch || token.revision !== cache.revision) return
    const current = listWorkspaces().find((w) => w.id === workspace.id)
    if (!current || membership(current) !== membership(workspace)) return
    cache.entries[workspace.id] = { ...metadata, reports: membership(workspace) }
    stored = true
    return JSON.stringify(cache)
  })
  if (stored) notify()
  return stored
}

// null means every workspace (links are global). Mark dirty synchronously so
// sidebar renders cannot show a stale count while the secure write is queued.
export function invalidateWorkspaceAppMetadata(ids = null, links) {
  epoch++
  if (ids === null) allDirty++
  else for (const id of ids) dirty.add(id)
  notify()
  return enqueue((cache) => {
    cache.revision = crypto.randomUUID()
    if (ids === null) cache.entries = {}
    else for (const id of ids) delete cache.entries[id]
    if (links !== undefined) cache.links = links
    return JSON.stringify(cache)
  }).finally(() => {
    if (ids === null) allDirty--
    else for (const id of ids) dirty.delete(id)
    notify()
  })
}

export function onWorkspaceAppMetadataChanged(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

onAfterHydrate(() => {
  const raw = getItem(KEY)
  if (raw === observed) return
  observed = raw
  notify()
})
onReportMembershipChanged((id) => { invalidateWorkspaceAppMetadata([id]).catch(() => {}) })
onWorkspaceDeleted((id) => { invalidateWorkspaceAppMetadata([id]).catch(() => {}) })
onFileMutated((name) => {
  const ids = listWorkspaces().filter((w) => w.reports.includes(name)).map((w) => w.id)
  invalidateWorkspaceAppMetadata(ids).catch(() => {})
})
subscribeToLinkedFindings(() => {
  // Comparing the actual links preserves cached headers across a reload, when
  // the same index is reconstructed from disk for the first time in this tab.
  const links = JSON.stringify(linkFiles().map(({ name, groups }) => ({ name, groups })))
  if (parse().links !== links) invalidateWorkspaceAppMetadata(null, links).catch(() => {})
})
