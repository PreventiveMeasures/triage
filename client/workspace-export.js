import { loadRepoUrlFor, state } from './state.js'
import { readFile } from './storage.js'
import { setReportWorkspace } from './workspaces.js'
import { deriveFindingId } from '../common/finding-id.js'
import { parseMarkdownFindings } from '../common/parse-md.js'
import { parseDeepsecFindings } from '../common/parse-deepsec.js'
import { encodeUtf8 } from '../common/utf8.js'

// Pure-logic side of workspace export. The DOM-touching layer
// (anchor-click download trigger) lives in
// `ui/view/workspace-export.js` and calls into `buildWorkspaceGzip`.
// Split this way so the payload-building logic can be exercised
// from `tests/workspace-roundtrip.test.js` directly.
//
// Triage filtering is by report-membership: only entries whose id
// appears in one of the workspace's reports ride along, so a
// workspace export stays a clean self-contained slice of the user's
// triage. Always emits the new `triage: 'fixed'|'invalid'|'deleted'`
// shape; legacy `deleted: true` is never written by this path.

const EXPORT_VERSION = 1

function toGroup(entry) { return Array.isArray(entry) ? entry : [entry] }

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

// Filename-safe workspace name for the download. Falls back to
// `workspace` when the name reduces to nothing after sanitization.
export function safeFilename(name) {
  const cleaned = (name ?? '').replace(/[^a-zA-Z0-9._-]+/gu, '_').replace(/^_+|_+$/gu, '')
  return cleaned || 'workspace'
}

// Build the export payload object. Reads the workspace's reports
// from OPFS, derives finding ids per report, filters in-memory
// triage by id-membership, and bundles per-report repo URLs.
// Side effect: drops stale workspace report references when their
// OPFS entry is gone (defensive prune — matches the original
// inline behaviour).
export async function buildWorkspaceExportPayload(workspace) {
  const reports = []
  const claimedIds = new Set()
  for (const name of workspace.reports ?? []) {
    let content
    try {
      content = await readFile(name)
    } catch (err) {
      console.warn(`Workspace export: skipping ${name}: ${err.message}`)
      // Defensive prune: stale references from before deleteCurrent
      // started cleaning up workspaces (or from external OPFS
      // tampering) live in the workspace JSON forever otherwise.
      // Remove the ghost from any workspace that pins it so the
      // next export is clean and the next workspace-import on
      // another machine doesn't re-resurrect a name that points at
      // nothing.
      setReportWorkspace(name, null)
      continue
    }
    reports.push({ name, content })
    for (const id of await reportFindingIds(content)) claimedIds.add(id)
  }

  // Triage filter — only keep entries whose id appears in this
  // workspace's reports. A single id may carry color, triage,
  // comment, and/or fix; merge into one entry per id.
  const triage = {}
  for (const [id, color] of state.markers) {
    if (!claimedIds.has(id)) continue
    triage[id] = { ...(triage[id] ?? {}), color }
  }
  for (const [id, triageVal] of state.triageState) {
    if (!claimedIds.has(id)) continue
    triage[id] = { ...(triage[id] ?? {}), triage: triageVal }
  }
  for (const [id, comment] of state.comments) {
    if (!claimedIds.has(id)) continue
    if (comment) triage[id] = { ...(triage[id] ?? {}), comment }
  }
  for (const [id, fix] of state.fixes) {
    if (!claimedIds.has(id)) continue
    if (fix) triage[id] = { ...(triage[id] ?? {}), fix }
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

  return {
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
}

async function gzip(text) {
  const stream = new Blob([encodeUtf8(text)]).stream().pipeThrough(new CompressionStream('gzip'))
  return await new Response(stream).blob()
}

// Returns `{ blob, filename }` ready for the UI download wrapper.
// Filename uses the workspace name sanitized to a portable charset.
export async function buildWorkspaceExportGzip(workspace) {
  const payload = await buildWorkspaceExportPayload(workspace)
  const blob = await gzip(JSON.stringify(payload))
  return { blob, filename: `${safeFilename(workspace.name)}.deepview-workspace.json.gz` }
}
