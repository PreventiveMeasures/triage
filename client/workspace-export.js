import { loadRepoUrlFor, state } from './state.ts'
import { normalizeEntry } from './triage-entry.ts'
import { listBundles, readBundle, readFile } from './storage.js'
import { setReportWorkspace } from './workspaces.js'
import { backfillFindingIds, flattenFindings, parseReport } from '../report/index.js'
import { gzipText } from '../common/gzip.js'
import { encryptBundle } from './workspace-bundle-crypto.js'

// Pure-logic side of workspace export. The DOM-touching layer
// (export dialog + anchor-click download) lives in
// `ui/view/workspace-export.js` and calls the public dispatcher
// `buildWorkspaceExportBundle(workspace, { password })`. Split so the
// payload-building logic can be exercised from
// `tests/workspace-roundtrip.test.js` directly.
//
// Triage filters by report-membership: only entries whose id appears
// in one of the workspace's reports ride along, so the export stays a
// clean self-contained slice. Always emits the new
// `triage: 'inprogress'|'fixed'|'invalid'|'deleted'` shape; legacy `deleted: true`
// is never written here.

const EXPORT_VERSION = 1

async function reportFindingIds(content) {
  const ids = new Set()
  const data = parseReport(content)
  // `findings` must be an array — a malformed report (object,
  // string, number) would otherwise abort the whole export. Skip so
  // one bad report doesn't strand the rest. Audit round-13 W-Export-2.
  if (!Array.isArray(data?.findings)) return ids
  const all = flattenFindings(data.findings)
  await backfillFindingIds(all)
  for (const f of all) if (f.id) ids.add(f.id)
  return ids
}

// Filename-safe workspace name for the download. Falls back to
// `workspace` when the name reduces to nothing after sanitization.
function safeFilename(name) {
  const cleaned = (name ?? '').replaceAll(/[^a-zA-Z0-9._-]+/gu, '_').replaceAll(/^_+|_+$/gu, '')
  return cleaned || 'workspace'
}

// Best-effort fetch of bundle bytes for the workspace's `bundles`
// integrity list. Skips pointers that don't resolve locally (cross-
// workspace orphans, pre-migration entries, or bundles a peer auto-
// attached without shipping the bytes) so the export is a snapshot of
// what THIS device can actually hand off. `readBundle` returns
// uncompressed bytes (storage peels gzip / envelope), so the
// recipient's `saveBundle` recomputes the same SHA-512 integrity from
// the round-tripped bytes — content-addressed by design.
async function readBundleBlobs(integrities) {
  if (!Array.isArray(integrities) || integrities.length === 0) return []
  const meta = await listBundles()
  const nameByIntegrity = new Map(meta.map((b) => [b.integrity, b.name]))
  const blobs = []
  for (const integrity of integrities) {
    const name = nameByIntegrity.get(integrity)
    if (!name) continue
    let bytes
    try {
      bytes = await readBundle(integrity)
    } catch (err) {
      // Per-blob best effort: one failed read (sealed bundle under a
      // locked vault, transient OPFS hiccup, partial-write corruption)
      // shouldn't abort the export — the orphan pointer still rides in
      // `bundles`, and the recipient can drop the bytes later.
      console.warn(`Workspace export: failed to read bundle ${integrity}: ${err?.message ?? err}`)
      continue
    }
    blobs.push({ integrity, name, data: bytes.toBase64() })
  }
  return blobs
}

// Build the export payload. Reads the workspace's reports from OPFS,
// derives finding ids per report, filters in-memory triage by id-
// membership, and bundles per-report repo URLs. Side effect: drops
// stale workspace report references when their OPFS entry is gone
// (defensive prune).
//
// `includeBundleBytes: true` also ships the bundle bytes alongside
// the integrity pointers — useful for a recipient who doesn't have
// the bundles locally. Bytes ride as `bundleBlobs:
// [{ integrity, name, data }]`, `data` base64 of the raw uncompressed
// bytes. The integrities still ride in `bundles` (back-compat), so a
// receiver that ignores `bundleBlobs` sees the same orphan-pointer
// shape as a pre-bytes export.
export async function buildWorkspaceExportPayload(workspace, { includeBundleBytes = false } = {}) {
  const reports = []
  const claimedIds = new Set()
  for (const name of workspace.reports ?? []) {
    let content
    try {
      content = await readFile(name)
    } catch (err) {
      console.warn(`Workspace export: skipping ${name}: ${err?.message ?? err}`)
      // Defensive prune: stale references otherwise live in the
      // workspace JSON forever. Only prune on the GENUINE "file not
      // found" case, which the two backends report differently: OPFS
      // raises a DOMException 'NotFoundError' (from `getFileHandle`),
      // the LS fallback throws `Error: File not found: <name>`. Accept
      // BOTH — matching only the LS message would never fire under
      // OPFS (the production backend), so orphans would accumulate.
      // Other error classes (UTF-8 decode failure on corrupt bytes,
      // transient I/O, future types) aren't deterministic "file gone"
      // signals — don't permanently detach on a transient. Audit
      // round-13 W-Export-3.
      const isNotFound = (err instanceof DOMException && err.name === 'NotFoundError') ||
        (typeof err?.message === 'string' && err.message.startsWith('File not found:'))
      if (isNotFound) {
        await setReportWorkspace(name, null)
      }
      continue
    }
    reports.push({ name, content })
    for (const id of await reportFindingIds(content)) claimedIds.add(id)
  }

  // Triage filter — keep only entries whose id appears in this
  // workspace's reports, and normalize each into the wire shape
  // (migrate legacy `deleted`, prune empties).
  //
  // Per-report ignore is also filtered against the workspace's
  // reports: the same content-derived id can carry ignore entries
  // from reports OUTSIDE this workspace (user opens multiple
  // workspaces referencing shared findings). Without the filter those
  // foreign report names leak into the export's `ignoredReports`,
  // breaking the clean-self-contained-slice guarantee. Audit round-13
  // W-Export-1.
  const workspaceReportSet = new Set(workspace.reports ?? [])
  const triage = {}
  for (const [id, entry] of state.triage) {
    if (!claimedIds.has(id)) continue
    const scopedIgnored = (entry.ignoredReports ?? []).filter((r) => workspaceReportSet.has(r))
    const out = normalizeEntry({ ...entry, ignoredReports: scopedIgnored })
    if (out) triage[id] = out
  }

  // Per-report repo URLs — each report carries its own user-typed URL
  // (see state.js / loadRepoUrlFor). Only THIS workspace's reports'
  // URLs go in the bundle; unrelated entries are dropped so the
  // export stays a clean self-contained slice.
  const repoUrls = {}
  for (const r of reports) {
    const url = loadRepoUrlFor(r.name)
    if (url) repoUrls[r.name] = url
  }

  // Bundle membership rides as a top-level list of sha512 integrities
  // — symmetric with `reports`. Bytes-free by default: blobs can be
  // tens of MB and content-addressed by SHA-512, so shipping bytes
  // would balloon the export when the recipient already has them. A
  // receiver with the matching bundle in OPFS auto-claims it into the
  // workspace on import (same address = same bytes); one without gets
  // a pointer the sidebar skips at render. Inline hand-off opts into
  // the `bundleBlobs` field below. Filter to strings in case the in-
  // memory blob got a junk entry — the import side checks the same.
  const bundles = (workspace.bundles ?? []).filter((b) => typeof b === 'string' && b.length > 0)

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
    bundles,
    repoUrls,
    triage,
  }

  // Optional bundle bytes — only when the caller opts in AND the
  // workspace has bundles that resolve locally. Omitted (not an empty
  // array) when there's nothing to ship, so the validator's
  // `bundleBlobs === undefined` short-circuit stays the common path
  // for back-compat exports.
  if (includeBundleBytes) {
    const blobs = await readBundleBlobs(bundles)
    if (blobs.length > 0) payload.bundleBlobs = blobs
  }

  return payload
}

// Returns `{ blob, filename }` ready for the UI download wrapper.
// Filename uses the workspace name sanitized to a portable charset.
export async function buildWorkspaceExportGzip(workspace, { includeBundleBytes = false } = {}) {
  const payload = await buildWorkspaceExportPayload(workspace, { includeBundleBytes })
  const blob = new Blob([await gzipText(JSON.stringify(payload))])
  return { blob, filename: `${safeFilename(workspace.name)}.deepview-workspace.json.gz` }
}

// AES-GCM-wrapped variant of the gzipped bundle. The `.enc` suffix
// pairs with the import path's filename + magic-byte routing.
export async function buildWorkspaceExportEncrypted(workspace, password, { includeBundleBytes = false } = {}) {
  if (typeof password !== 'string' || !password) {
    throw new TypeError('buildWorkspaceExportEncrypted: password required')
  }
  const { blob: gzipBlob } = await buildWorkspaceExportGzip(workspace, { includeBundleBytes })
  const plaintext = new Uint8Array(await gzipBlob.arrayBuffer())
  const encrypted = await encryptBundle(plaintext, password)
  const blob = new Blob([encrypted], { type: 'application/octet-stream' })
  return { blob, filename: `${safeFilename(workspace.name)}.deepview-workspace.enc` }
}

// Dispatches on `password`: empty → plaintext gzip, set → encrypted.
// Caller owns the explicit opt-out UX when calling without one.
// `includeBundleBytes: true` ships base64'd bundle bytes alongside
// the integrity pointers — see `buildWorkspaceExportPayload`.
export async function buildWorkspaceExportBundle(workspace, { password, includeBundleBytes = false } = {}) {
  if (typeof password === 'string' && password) {
    return await buildWorkspaceExportEncrypted(workspace, password, { includeBundleBytes })
  }
  return await buildWorkspaceExportGzip(workspace, { includeBundleBytes })
}
