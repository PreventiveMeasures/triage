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

import { listFiles, onFileMutated, readFile } from './storage.js'

const byHash = new Map()
const byPackage = new Map()
// Mirror of `byPackage` for own-source findings (anything whose
// path doesn't sit under `node_modules/` / `dependencies/`),
// keyed by the finding's repo URL — `f.repo?.github` when the
// analyzer stamped one, else the per-report `_repoFallback`
// the user typed. Powers the cross-report Repositories view,
// which complements Packages: most findings end up in exactly
// one of the two (third-party deps in Packages, own source in
// Repositories). Findings without any repo signal aren't
// indexed here — there's nothing to bucket them under.
const byRepo = new Map()
// Reverse index: which (hash, key), (pkg, key), and (repo, key)
// pairs did each report contribute? Lets `invalidateName` prune
// precisely on a file delete / overwrite without re-scanning
// every report. Audit round-8 H1.
const contributionsByName = new Map()

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

// Extracts the repo "key" the Repositories view buckets under.
// Prefers the analyzer-stamped `repo.github` (a `user/repo` slug
// or full URL) so findings from the same upstream repo merge
// regardless of which report dropped them. Falls back to the
// per-report `_repoFallback` (the URL the user typed for that
// report) so reports whose findings don't carry per-finding
// repo metadata still surface under their typed URL. Returns
// null when neither is present — those findings simply don't
// appear in Repositories.
function repoOf(f) {
  if (typeof f.repo?.github === 'string' && f.repo.github) return f.repo.github
  if (typeof f._repoFallback === 'string' && f._repoFallback) return f._repoFallback
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

// Snapshot of the OPFS-wide repository index for the cross-report
// Repositories view. Same shape as the Packages index (Map<repoKey,
// { findings, files, reports, … }>), but only own-source findings
// (those NOT in node_modules / dependencies) get indexed; deps
// already surface in Packages, so Repositories is the
// complementary view. Repo key comes from `repoOf(f)` above.
export function getRepositoriesIndex() {
  return byRepo
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

function rememberContribution(name, kind, ref) {
  let entry = contributionsByName.get(name)
  if (!entry) {
    entry = { hash: [], pkg: [], repo: [] }
    contributionsByName.set(name, entry)
  }
  entry[kind].push(ref)
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
  if (wasNewReport) rememberContribution(name, 'hash', { hash: f.fileHash, key })
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
    // `keyReports` tracks which reports contributed each key so
    // `invalidateName` can prune precisely. `reports` (Set) is the
    // public summary; we keep both forms because callers iterate
    // `reports` directly. Audit round-8 H1.
    pBucket = { keys: new Set(), findings: [], files: new Map(), reports: new Set(), keyReports: new Map() }
    byPackage.set(pkg, pBucket)
  }
  pBucket.reports.add(name)
  let krSet = pBucket.keyReports.get(key)
  if (!krSet) {
    krSet = new Set()
    pBucket.keyReports.set(key, krSet)
  }
  const wasNewReport = !krSet.has(name)
  krSet.add(name)
  if (wasNewReport) rememberContribution(name, 'pkg', { pkg, key, file: f.file })
  if (pBucket.keys.has(key)) return false
  pBucket.keys.add(key)
  pBucket.findings.push(f)
  if (!pBucket.files.has(f.file)) pBucket.files.set(f.file, [])
  pBucket.files.get(f.file).push(f)
  return true
}

// Repository-keyed bucket update. Mirror of indexFindingByPackage
// but for own-source findings (those NOT inside a deps dir),
// keyed by `repoOf(f)`. Findings with no repo signal AT ALL
// (no `repo.github`, no `_repoFallback`) are skipped — there's
// nowhere to bucket them. Returns true on a fresh dedupe key,
// matching the package path's contract.
function indexFindingByRepo(f, key, name) {
  if (packageOf(f.file) !== null) return false
  const repo = repoOf(f)
  if (!repo) return false
  let rBucket = byRepo.get(repo)
  if (!rBucket) {
    rBucket = { keys: new Set(), findings: [], files: new Map(), reports: new Set(), keyReports: new Map() }
    byRepo.set(repo, rBucket)
  }
  rBucket.reports.add(name)
  let krSet = rBucket.keyReports.get(key)
  if (!krSet) {
    krSet = new Set()
    rBucket.keyReports.set(key, krSet)
  }
  const wasNewReport = !krSet.has(name)
  krSet.add(name)
  if (wasNewReport) rememberContribution(name, 'repo', { repo, key, file: f.file })
  if (rBucket.keys.has(key)) return false
  rBucket.keys.add(key)
  rBucket.findings.push(f)
  if (!rBucket.files.has(f.file)) rBucket.files.set(f.file, [])
  rBucket.files.get(f.file).push(f)
  return true
}

// Drop everything `name` contributed to byHash / byPackage / byRepo
// and clear it from `indexed` so the next `ensureBundleFindingsIndexed`
// re-processes it (after `saveFile` overwrite) or skips it (after
// `deleteFile`). Per-file invalidation walks the reverse-index
// `contributionsByName`; no full re-scan. Audit round-8 H1.
function invalidateName(name) {
  const contrib = contributionsByName.get(name)
  contributionsByName.delete(name)
  indexed.delete(name)
  if (!contrib) return false
  let dirty = false
  for (const { hash, key } of contrib.hash) {
    const bucket = byHash.get(hash)
    if (!bucket) continue
    const reportSet = bucket.reports.get(key)
    if (!reportSet) continue
    if (reportSet.delete(name)) dirty = true
    if (reportSet.size === 0) {
      bucket.reports.delete(key)
      bucket.keys.delete(key)
      const idx = bucket.list.findIndex((f) => findingDedupeKey(f) === key)
      if (idx >= 0) bucket.list.splice(idx, 1)
    }
    if (bucket.keys.size === 0) byHash.delete(hash)
  }
  for (const { pkg, key, file } of contrib.pkg) {
    const pBucket = byPackage.get(pkg)
    if (!pBucket) continue
    const krSet = pBucket.keyReports.get(key)
    if (!krSet) continue
    if (krSet.delete(name)) dirty = true
    if (krSet.size === 0) {
      pBucket.keyReports.delete(key)
      pBucket.keys.delete(key)
      const idx = pBucket.findings.findIndex((f) => findingDedupeKey(f) === key)
      if (idx >= 0) pBucket.findings.splice(idx, 1)
      const fileList = pBucket.files.get(file)
      if (fileList) {
        const fi = fileList.findIndex((f) => findingDedupeKey(f) === key)
        if (fi >= 0) fileList.splice(fi, 1)
        if (fileList.length === 0) pBucket.files.delete(file)
      }
    }
    // Recompute the public `reports` set: any report still appearing
    // in any keyReports entry stays. Cheaper to recompute on prune
    // than to maintain a refcount.
    if (pBucket.keyReports.size === 0) {
      byPackage.delete(pkg)
    } else {
      const stillContributing = new Set()
      for (const set of pBucket.keyReports.values()) {
        for (const r of set) stillContributing.add(r)
      }
      pBucket.reports = stillContributing
    }
  }
  // Same shape for the repository index — own-source findings only,
  // keyed by repo URL. See the package path above for the rationale.
  for (const { repo, key, file } of contrib.repo) {
    const rBucket = byRepo.get(repo)
    if (!rBucket) continue
    const krSet = rBucket.keyReports.get(key)
    if (!krSet) continue
    if (krSet.delete(name)) dirty = true
    if (krSet.size === 0) {
      rBucket.keyReports.delete(key)
      rBucket.keys.delete(key)
      const idx = rBucket.findings.findIndex((f) => findingDedupeKey(f) === key)
      if (idx >= 0) rBucket.findings.splice(idx, 1)
      const fileList = rBucket.files.get(file)
      if (fileList) {
        const fi = fileList.findIndex((f) => findingDedupeKey(f) === key)
        if (fi >= 0) fileList.splice(fi, 1)
        if (fileList.length === 0) rBucket.files.delete(file)
      }
    }
    if (rBucket.keyReports.size === 0) {
      byRepo.delete(repo)
    } else {
      const stillContributing = new Set()
      for (const set of rBucket.keyReports.values()) {
        for (const r of set) stillContributing.add(r)
      }
      rBucket.reports = stillContributing
    }
  }
  return dirty
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
      if (f.file && indexFindingByRepo(f, key, name)) added = true
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

// Subscribe to the storage layer's mutation events so file-level
// changes prune (delete) or evict-then-re-index-on-next-walk (save)
// without the caller having to invoke us. Audit round-8 H1.
//
// Every save (including overwrites) goes through `invalidateName` to
// drop the OLD content's contributions; the next
// `ensureBundleFindingsIndexed` walk re-processes the file because
// it's no longer in the `indexed` Set. Deletes prune in place — no
// re-index because the file is gone.
//
// `notify()` after a successful invalidate so subscribers (Bundles
// Issues tab, Packages page) repaint immediately rather than
// waiting for the next index walk.
onFileMutated((name) => {
  if (invalidateName(name)) notify()
})
