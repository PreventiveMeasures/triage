import { state, loadRepoUrlFor } from './state.js'
import { readFile } from './storage.js'
import { toGroup } from './group.js'
import { deriveFindingId } from '../../common/finding-id.js'
import { parseMarkdownFindings } from '../../common/parse-md.js'
import { parseDeepsecFindings } from '../../common/parse-deepsec.js'

// Workspace export — bundle the workspace's metadata, every report
// belonging to it, the per-report repo URLs that the user has typed,
// and the subset of triage entries (markers + deletions) keyed by a
// finding id that lives in one of those reports. The output is one
// JSON.stringified object piped through gzip and offered as a
// download.
//
// Filtering triage by report-membership requires knowing each report's
// finding ids. Native ids ride along inside the JSON; markdown imports
// derive theirs from content via deriveFindingId — same algorithm
// ingest.js runs at drop time, so the ids match. Reports that fail to
// parse contribute no ids; their content still ships in the bundle.

const EXPORT_VERSION = 1

async function reportFindingIds(content) {
  const ids = new Set()
  let data
  try {
    data = JSON.parse(content)
  } catch {
    data = parseDeepsecFindings(content) ?? parseMarkdownFindings(content)
  }
  if (!data?.findings) return ids
  const all = data.findings.flatMap(toGroup)
  for (const f of all) {
    if (f.id) ids.add(f.id)
  }
  const idLess = all.filter((f) => !f.id)
  if (idLess.length === 0) return ids
  const derived = await Promise.all(idLess.map(deriveFindingId))
  for (const id of derived) if (id) ids.add(id)
  return ids
}

async function gzip(text) {
  const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('gzip'))
  return await new Response(stream).blob()
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// Filename-safe workspace name for the download. Falls back to
// `workspace` when the name reduces to nothing after sanitization.
function safeFilename(name) {
  const cleaned = (name ?? '').replace(/[^a-zA-Z0-9._-]+/gu, '_').replace(/^_+|_+$/gu, '')
  return cleaned || 'workspace'
}

export async function exportWorkspace(workspace) {
  const reports = []
  const claimedIds = new Set()
  for (const name of workspace.reports ?? []) {
    let content
    try {
      content = await readFile(name)
    } catch (err) {
      console.warn(`Workspace export: skipping ${name}: ${err.message}`)
      continue
    }
    reports.push({ name, content })
    for (const id of await reportFindingIds(content)) claimedIds.add(id)
  }

  // Triage filter — only keep entries whose id appears in this
  // workspace's reports. A single id may carry both color and
  // deleted; merge into one entry.
  const triage = {}
  for (const [id, color] of state.markers) {
    if (!claimedIds.has(id)) continue
    triage[id] = { ...(triage[id] ?? {}), color }
  }
  for (const id of state.deletedIds) {
    if (!claimedIds.has(id)) continue
    triage[id] = { ...(triage[id] ?? {}), deleted: true }
  }

  // Per-report repo URLs — each report carries its own user-typed URL
  // (see state.js / loadRepoUrlFor). Only the URLs for THIS workspace's
  // reports go in the bundle; entries for unrelated reports are
  // dropped so the export stays a clean self-contained slice.
  const repoUrls = {}
  for (const r of reports) {
    const url = loadRepoUrlFor(r.name)
    if (url) repoUrls[r.name] = url
  }

  const payload = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    workspace: {
      id: workspace.id,
      name: workspace.name,
      privateKey: workspace.privateKey,
      createdAt: workspace.createdAt,
    },
    reports,
    repoUrls,
    triage,
  }

  const blob = await gzip(JSON.stringify(payload))
  downloadBlob(blob, `${safeFilename(workspace.name)}.deepview-workspace.json.gz`)
}
