// OPFS-wide finding index — loads every report stored in OPFS
// (not just the currently-active state.reports) and caches its
// findings under two complementary indexes:
//
//   - byHash: keyed by `fileHash` so the bundle details panel
//     (Issues tab + Graph view) can match a bundle's source
//     fingerprints against findings from every report the user
//     has ever dropped.
//   - byPackage: keyed by `packageOf(file)` so the cross-report
//     Packages view can render aggregate counts without depending
//     on the small subset of reports loaded into state.reports.
//
// Indexing is incremental and idempotent: the first call kicks a
// background walk of `listFiles()`; each report is JSON.parsed and
// scanned for findings. Subsequent calls re-scan the OPFS file
// list so newly-dropped reports get indexed without restart, but
// already-indexed reports skip the readFile. Reports that don't
// JSON.parse (DeepSec / Claude Security markdown, Codex CSV
// imports — they're parsed at ingest time, not on disk) are
// silently skipped.
//
// Subscribers fire after each report finishes indexing so any
// open view (Bundles' Issues tab, Packages page) can repaint
// progressively as findings come in.

import { listFiles, readFile } from './storage.js'

const byHash = new Map()
const byPackage = new Map()

// Package extractor — matches `node_modules/<pkg>/...` and
// `dependencies/<pkg>/...` (both conventions are common); whichever
// the report uses, the matched name surfaces. Walks past pnpm's
// synthetic `.pnpm/<name>@<ver>/node_modules/<name>` shim so
// `@noble/hashes` / `ws` / etc. surface as themselves rather than
// under `.pnpm`. Returns null when the path is OWN source
// (`src/...`, `tests/...`, repo-root files) — the Packages view
// only aggregates third-party deps; own source clutters the page
// with "src" / "tests" / "playground" pseudo-packages that aren't
// what the user thinks of as a package.
function packageOf(file) {
  if (!file) return null
  const re = /(?:^|\/)(?:node_modules|dependencies)\/(@[^/]+\/[^/]+|[^/]+)/gu
  let m
  while ((m = re.exec(file)) !== null) {
    if (m[1] !== '.pnpm') return m[1]
  }
  return null
}
const indexed = new Set()
const listeners = new Set()
let activeRun = null

export function subscribeToBundleFindingIndex(callback) {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

function notify() {
  for (const cb of listeners) {
    try { cb() } catch {}
  }
}

// Synchronous lookup for the open bundle's hash → findings join.
// Returns the same Finding objects we cached during indexing — id /
// severity / description / file / line / repo all preserved so the
// Issues tab and graph dim logic can read them as-is. The bucket's
// internal Set is hidden from callers; just the deduped list is
// exposed.
export function findingsForFileHash(hash) {
  return byHash.get(hash)?.list ?? []
}

// Snapshot of the OPFS-wide package index for the cross-report
// Packages view. Returns Map<pkg, { findings, files, reports }>;
// findings is the deduped Finding[] (one entry per dedupe key),
// files is Map<file, Finding[]> for the package, and reports is
// Set<reportName>. Mutating the returned objects is safe — the
// index uses internal storage, callers see the live structure
// (don't need to copy on read since the views just iterate).
export function getPackagesIndex() {
  return byPackage
}

// Companion lookup: list of OPFS report names that contain a given
// finding (deduped — a finding present in N reports returns all N
// names). Keyed by the dedupe id under findingDedupeKey, so callers
// pass a finding object and get back the reports its dedupe key
// matched during indexing. Empty array when the finding wasn't
// indexed (shouldn't happen for findings returned by
// findingsForFileHash, but a defensive default keeps the UI safe).
export function reportsForFinding(hash, finding) {
  const bucket = byHash.get(hash)
  if (!bucket) return []
  const reports = bucket.reports.get(findingDedupeKey(finding))
  return reports ? [...reports] : []
}

// Run-level meta keys mirrored from ingest.js's META_FIELDS. The
// bundle viewer's source panel reads these through prettyModel +
// the meta chain — without inheritance from the report header, the
// chain stays empty for every finding that doesn't carry per-
// finding meta inline (most do not).
const META_FIELDS = ['type', 'model', 'think', 'effort', 'exportsMode']

// Inherit run-level meta from the report header onto a finding
// that carries none of its own — same rule ingest.js follows.
// In-place mutation is safe: bucket dedupe + index pass don't
// rely on the absence of meta fields, and callers haven't held
// onto the finding before this point.
function inheritReportMeta(f, data) {
  if (META_FIELDS.some((k) => f[k] !== undefined)) return
  for (const key of META_FIELDS) {
    if (data[key] !== undefined) f[key] = data[key]
  }
}

function extractFindings(data) {
  // DeepView-native dumps carry findings under `groups` (array of
  // Finding[]) or a flat `findings` array. Either shape works.
  // Other formats (deepsec / claude-security / codex) get parsed
  // at ingest time, not from raw OPFS — they fail JSON.parse here
  // and the caller silently skips them.
  //
  // We return EVERY finding (including those without `fileHash`)
  // so the cross-report Packages view picks them up. The hash-
  // keyed bucket below filters on fileHash separately.
  //
  // Run-level meta (type / model / effort / mode / think) is
  // inherited from the report header. Source-marked formats
  // (those with `data.source` set) opt out: their report-level
  // `type` is a category label, not a per-finding analyzer
  // descriptor.
  const list = Array.isArray(data?.findings)
    ? data.findings
    : Array.isArray(data?.groups) ? data.groups : null
  if (!list) return []
  const inheritMeta = !data?.source
  const out = []
  for (const entry of list) {
    const members = Array.isArray(entry) ? entry : [entry]
    for (const f of members) {
      if (!f) continue
      if (inheritMeta) inheritReportMeta(f, data)
      out.push(f)
    }
  }
  return out
}

// Dedupe key — preferred form is the analyzer's stable `id`; falls
// back to a (severity, description, file, line, fileHash) tuple
// when the report doesn't carry ids (older / hand-rolled inputs).
// Same hash bucket: same source content; same key = same finding,
// so we drop the second copy.
function findingDedupeKey(f) {
  if (f.id) return `id:${f.id}`
  return `c:${f.severity ?? ''}|${f.description ?? ''}|${f.file ?? ''}|${f.line ?? ''}`
}

// Hash-keyed bucket update. Returns true when the bucket gained
// new content (either a fresh dedupe key or a new origin report
// against an existing key — both cases warrant a subscriber
// repaint so dependent UI picks up the change).
function indexFindingByHash(f, key, name) {
  let bucket = byHash.get(f.fileHash)
  if (!bucket) {
    bucket = { keys: new Set(), list: [], reports: new Map() }
    byHash.set(f.fileHash, bucket)
  }
  let reportSet = bucket.reports.get(key)
  if (!reportSet) {
    reportSet = new Set()
    bucket.reports.set(key, reportSet)
  }
  const wasNewReport = !reportSet.has(name)
  reportSet.add(name)
  if (bucket.keys.has(key)) return wasNewReport
  bucket.keys.add(key)
  bucket.list.push(f)
  return true
}

// Package-keyed bucket update. Independent of fileHash so all
// findings inside `node_modules/` / `dependencies/` paths surface
// in the Packages view, even when the analyzer didn't stamp a
// content hash. Findings outside those dirs (own source) are
// skipped — the page only aggregates third-party deps. Returns
// false when the file isn't part of a package.
function indexFindingByPackage(f, key, name) {
  const pkg = packageOf(f.file)
  if (!pkg) return false
  let pBucket = byPackage.get(pkg)
  if (!pBucket) {
    pBucket = { keys: new Set(), findings: [], files: new Map(), reports: new Set() }
    byPackage.set(pkg, pBucket)
  }
  pBucket.reports.add(name)
  if (pBucket.keys.has(key)) return false
  pBucket.keys.add(key)
  pBucket.findings.push(f)
  if (!pBucket.files.has(f.file)) pBucket.files.set(f.file, [])
  pBucket.files.get(f.file).push(f)
  return true
}

async function indexOne(name) {
  if (indexed.has(name)) return false
  // Mark up front so concurrent ensureBundleFindingsIndexed calls
  // don't double-process the same report.
  indexed.add(name)
  try {
    const content = await readFile(name)
    const data = JSON.parse(content)
    const findings = extractFindings(data)
    if (findings.length === 0) return false
    let added = false
    for (const f of findings) {
      const key = findingDedupeKey(f)
      if (f.fileHash && indexFindingByHash(f, key, name)) added = true
      if (f.file && indexFindingByPackage(f, key, name)) added = true
    }
    return added
  } catch {
    return false
  }
}

// Kicks a background walk of every OPFS report. Idempotent — a
// concurrent caller waits on the same in-flight promise; subsequent
// calls after that resolves walk listFiles again to pick up any
// newly-dropped reports without re-parsing the ones already
// indexed. Returns when every (currently-listed) report is
// indexed.
export function ensureBundleFindingsIndexed() {
  if (activeRun) return activeRun
  activeRun = (async () => {
    try {
      const names = await listFiles()
      for (const name of names) {
        const added = await indexOne(name)
        if (added) notify()
      }
    } finally {
      activeRun = null
    }
  })()
  return activeRun
}
