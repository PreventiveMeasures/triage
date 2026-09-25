import { getItem, mutate, onAfterHydrate } from './secure-storage.js'
import { listWorkspaces } from './workspaces.js'
import { onReportMembershipChanged, onWorkspaceDeleted } from './workspace-listeners.js'
import { onFileMutated } from './storage.js'
import { isLinkedFindingsIndexReady, linkFiles, subscribeToLinkedFindings } from './linked-findings-index.js'

const KEY = 'deepview.workspaceApp'
// v2 uses canonical corrected severity, independent of the active display lens.
const VERSION = 2
const listeners = new Set()
const dirty = new Set()
let allDirty = 0
let epoch = 0
let reportEpoch = 0
// Report changes invalidate only their member workspaces. Keep both a local
// generation (immediate invalidation) and a persisted revision (sibling tabs).
const workspaceEpochs = new Map()
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
function indexedLinks() { return JSON.stringify(linkFiles().map(({ name, groups }) => ({ name, groups }))) }
function linksMatch(cache) { return isLinkedFindingsIndexReady() && cache.links === indexedLinks() }
function workspaceRevision(cache, id) { return cache.workspaceRevisions?.[id] ?? '' }
function workspaceUnchanged(cache, workspace, token) {
  return token.workspaceId === workspace?.id
    && token.workspaceEpoch === (workspaceEpochs.get(workspace?.id) ?? 0)
    && token.workspaceRevision === workspaceRevision(cache, workspace?.id)
}

export function getWorkspaceAppMetadata(workspace) {
  if (allDirty || dirty.has(workspace.id)) return null
  const cache = parse()
  const entry = cache.entries[workspace.id]
  if (!entry || entry.reports !== membership(workspace) || typeof entry.appMode !== 'boolean') return null
  if (entry.appMode && (!Number.isSafeInteger(entry.appFindings) || entry.appFindings < 0)) return null
  // Hydrated metadata may be newer than the index this tab uses to group
  // findings. Only expose it once those duplicate relationships agree.
  if (!linksMatch(cache)) return null
  return entry
}

// Capture before reading reports; both same-tab and sibling-tab mutations can
// invalidate this workspace's calculation while its OPFS reads are in flight.
export async function workspaceAppCacheToken(workspace, reportsToken = null) {
  let drained
  do { drained = pending; await drained } while (drained !== pending)
  const cache = parse()
  const reportRevision = cache.reportRevision ?? cache.revision
  // A background links walk may finish after the workspace has loaded. Its
  // new links can be applied to those reports, but changed report bytes or
  // membership in this workspace require a fresh load. A sibling tab can also
  // invalidate links without updating this tab's in-memory index: don't accept that revision
  // until the indexed links match the persisted snapshot.
  if (reportsToken && (reportsToken.reportEpoch !== reportEpoch
      || reportsToken.reportRevision !== reportRevision
      || !workspaceUnchanged(cache, workspace, reportsToken)
      || !linksMatch(cache))) return null
  return {
    epoch, revision: cache.revision, reportEpoch, reportRevision,
    workspaceId: workspace?.id,
    workspaceEpoch: workspaceEpochs.get(workspace?.id) ?? 0,
    workspaceRevision: workspaceRevision(cache, workspace?.id),
  }
}
export async function cacheWorkspaceAppMetadata(workspace, metadata, token) {
  let stored = false
  await enqueue((cache) => {
    if (token.epoch !== epoch || token.revision !== cache.revision) return
    if (!workspaceUnchanged(cache, workspace, token)) return
    if (!linksMatch(cache)) return
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
  if (ids?.length === 0) return Promise.resolve()
  if (ids === null) {
    epoch++
    if (links === undefined) reportEpoch++
    allDirty++
  } else {
    for (const id of ids) {
      workspaceEpochs.set(id, (workspaceEpochs.get(id) ?? 0) + 1)
      dirty.add(id)
    }
  }
  notify()
  return enqueue((cache) => {
    cache.reportRevision ??= cache.revision
    if (ids === null) {
      cache.revision = crypto.randomUUID()
      if (links === undefined) cache.reportRevision = cache.revision
      cache.entries = {}
    } else {
      cache.workspaceRevisions ??= {}
      for (const id of ids) {
        cache.workspaceRevisions[id] = crypto.randomUUID()
        delete cache.entries[id]
      }
    }
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
  // Never publish a partial walk as the shared snapshot. In particular, an
  // initially empty index must not replace a verified no-links cache.
  if (!isLinkedFindingsIndexReady()) { notify(); return }
  // Comparing the actual links preserves cached headers across a reload, when
  // the same index is reconstructed from disk for the first time in this tab.
  const links = indexedLinks()
  if (parse().links === links) {
    // A reload can make an existing entry readable without changing its value.
    notify()
  } else invalidateWorkspaceAppMetadata(null, links).catch(() => {})
})
