import { state, loadRepoUrlFor, saveRepoUrlFor } from './state.js'
import { saveFile } from './storage.js'
import { upsertWorkspace } from './workspaces.js'
import { saveTriage } from './triage.js'
import { setCount, analyzeContent } from './counts.js'

// Workspace import — the inverse of workspace-export.js. The dropped
// `.gz` blob is gunzipped, parsed as JSON, validated against the
// export shape (version 1), then unpacked:
//   - the workspace metadata is upserted by id, so re-importing the
//     same workspace merges instead of duplicating;
//   - each `reports[]` entry is written to OPFS verbatim (collisions
//     overwrite, matching saveFile's existing semantics);
//   - the bundled triage is folded into in-memory `state.markers`
//     / `state.deletedIds` and persisted via saveTriage();
//   - the bundled per-report `repoUrls` are adopted ONLY for reports
//     that don't already have a URL set locally — so an import never
//     silently clobbers the user's existing entries.
//
// Detection happens upstream in `addFiles` (any `.gz` drop is routed
// here); this module is the place that decides whether the payload
// is actually a workspace and throws if not.

async function gunzipText(file) {
  const buf = await file.arrayBuffer()
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))
  return await new Response(stream).text()
}

function isWorkspaceExport(data) {
  return Boolean(
    data
    && typeof data === 'object'
    && data.version === 1
    && data.workspace
    && typeof data.workspace.id === 'string'
    && typeof data.workspace.name === 'string'
    && typeof data.workspace.privateKey === 'string'
    && Array.isArray(data.reports),
  )
}

export async function importWorkspaceFromGzip(file) {
  let text
  try {
    text = await gunzipText(file)
  } catch (err) {
    throw new Error(`gzip decompression failed: ${err.message}`)
  }
  let data
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new Error(`payload is not JSON: ${err.message}`)
  }
  if (!isWorkspaceExport(data)) {
    throw new Error('not a deepview workspace export')
  }

  // Save reports first so the workspace's reports[] only references
  // the names that landed successfully.
  const savedNames = []
  for (const r of data.reports) {
    if (typeof r?.name !== 'string' || typeof r?.content !== 'string') continue
    try {
      await saveFile(r.name, r.content)
      const { count, source } = analyzeContent(r.content)
      setCount(r.name, count, source)
      savedNames.push(r.name)
    } catch (err) {
      console.warn(`Workspace import: failed to save ${r.name}: ${err.message}`)
    }
  }

  const ws = upsertWorkspace({
    id: data.workspace.id,
    name: data.workspace.name,
    privateKey: data.workspace.privateKey,
    reports: savedNames,
    createdAt: data.workspace.createdAt,
  })

  // Merge triage. Color and `deleted` mutations on the observed
  // Map / Set propagate through the state proxy; saveTriage then
  // persists the union back to localStorage.
  if (data.triage && typeof data.triage === 'object') {
    for (const [id, entry] of Object.entries(data.triage)) {
      if (!entry || typeof entry !== 'object') continue
      if (typeof entry.color === 'string') state.markers.set(id, entry.color)
      if (entry.deleted) state.deletedIds.add(id)
    }
    await saveTriage()
  }

  // Per-report repo URLs round-trip in `data.repoUrls` (keyed by the
  // OPFS filename). Only adopt entries that map to reports we actually
  // saved AND that have no URL set locally — overwriting the user's
  // existing entry would be surprising. If the imported workspace
  // contains the currently-active report and we adopted its URL, sync
  // `state.repoUrl` so the header chip refreshes immediately.
  const savedSet = new Set(savedNames)
  if (data.repoUrls && typeof data.repoUrls === 'object') {
    for (const [name, url] of Object.entries(data.repoUrls)) {
      if (!savedSet.has(name) || typeof url !== 'string' || !url) continue
      if (loadRepoUrlFor(name)) continue
      saveRepoUrlFor(name, url)
      if (state.currentFile === name) state.repoUrl = url
    }
  }

  return ws
}
