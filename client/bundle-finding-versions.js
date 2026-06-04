// Per-version sub-bucket helpers for the cross-report Packages
// view. Each package bucket in `bundle-finding-index.js` carries a
// `byVersion: Map<version | null, subBucket>` so the same package
// installed at multiple versions (pnpm's `.pnpm/<name>@<version>/`
// shape) surfaces as separate rows in the UI. `null` is the
// "unknown" slot — used for plain `node_modules/<pkg>/` paths
// where pnpm's version-encoded directory is absent.
//
// The helpers below own all reads / writes of `byVersion`. They
// live in their own module so the main index file (already at the
// lint line ceiling) can focus on the top-level hash / package /
// repo book-keeping; `findingDedupeKey` is threaded in from the
// index module to avoid a circular import. This module also hosts
// `isPlaceholderNpmPackage` — the shared npm-stamp sentinel check used
// by `packageVersionOf` here and `packageOf` in the index, and
// re-exported to the finding card via `#client/index.js`.

// The analyzer stamps `package.npm = { name: 'solidity-bundle', version:
// '0.0.0' }` as a synthetic placeholder on findings whose upstream npm
// package it couldn't determine. It's not a real registry entry, so
// callers treat a placeholder stamp as if it were absent: the Packages
// view falls back to file-path extraction (and drops the finding when
// the path is own-source) instead of opening a `solidity-bundle` row,
// and the finding card's npm chip renders nothing instead of linking to
// a 404 npm page.
//
// `solidity-bundle` is the sentinel NAME; the version is the analyzer's
// `0.0.0` default, but `package.npm.version` is documented optional (see
// the finding shape note in the index), so an absent / empty version
// under that name is treated as the placeholder too. A genuine
// `solidity-bundle` release at a real, concrete version is NOT
// suppressed — only the can't-determine sentinel is.
const PLACEHOLDER_NPM_NAME = 'solidity-bundle'
const PLACEHOLDER_NPM_VERSION = '0.0.0'
export function isPlaceholderNpmPackage(npm) {
  if (npm?.name !== PLACEHOLDER_NPM_NAME) return false
  const version = npm.version
  return !version || version === PLACEHOLDER_NPM_VERSION
}

// Version extractor — prefers the analyzer-stamped
// `f.package.npm.version` (the report finding shape carries
// `package: { npm: { name, version? } }` when the analyzer can
// identify the upstream package), unless that stamp is the
// "couldn't determine" placeholder above. Falls back to pnpm's
// `.pnpm/<encoded-name>@<version>/node_modules/<name>/...` shape on
// `f.file`. Scoped names are encoded with `+` (e.g. `@scope/name` →
// `@scope+name`), and a `_<peer-deps>` suffix may follow the version
// when pnpm pinned a peer-dep variant (e.g. `foo@1.2.3_react@18.0.0`).
// Peer-dep stripping has to happen BEFORE the last-`@` split —
// otherwise `lastIndexOf('@')` finds the peer's own `@`, not the
// package's, and the version comes back as the peer-dep major.
// Returns null when neither signal is available (plain
// `node_modules/<pkg>/` paths with no stamped version); the Packages
// view treats null as a single unversioned bucket.
export function packageVersionOf(f) {
  const npm = f?.package?.npm
  const stamped = npm?.version
  if (typeof stamped === 'string' && stamped && !isPlaceholderNpmPackage(npm)) return stamped
  const file = f?.file
  if (!file) return null
  const m = /(?:^|\/)node_modules\/\.pnpm\/([^/]+)\/node_modules\//u.exec(file)
  if (!m) return null
  let segment = m[1]
  const underIdx = segment.indexOf('_')
  if (underIdx > 0) segment = segment.slice(0, underIdx)
  const atIdx = segment.lastIndexOf('@')
  if (atIdx <= 0) return null
  const version = segment.slice(atIdx + 1)
  return version || null
}

// Shared bucket primitives. The package, repo, and per-version buckets
// all carry the same `{ keys, findings, files, reports, _keyReports }`
// shape: `keys`/`findings`/`files` are the public index, `_keyReports`
// maps each dedupe key to the set of reports that contributed it (so a
// prune can drop a key precisely), and `reports` is the recomputed
// union. Centralised here so the index module and this one share one
// implementation. (The byHash bucket has a different shape and is not
// covered.)
export function newBucket() {
  return { keys: new Set(), findings: [], files: new Map(), reports: new Set(), _keyReports: new Map() }
}

// Add finding `f` (dedupe `key`, from report `name`) to `bucket`.
// Returns `wasNewReport` — whether `name` is a freshly contributing
// report for `key` — so callers can fire a repaint even when the key
// itself already existed. The finding / file lists only grow on a
// genuinely new key. Audit round-12 M-A.
export function addFindingToBucket(bucket, key, name, f) {
  bucket.reports.add(name)
  let krSet = bucket._keyReports.get(key)
  if (!krSet) bucket._keyReports.set(key, krSet = new Set())
  const wasNewReport = !krSet.has(name)
  krSet.add(name)
  if (bucket.keys.has(key)) return wasNewReport
  bucket.keys.add(key)
  bucket.findings.push(f)
  if (!bucket.files.has(f.file)) bucket.files.set(f.file, [])
  bucket.files.get(f.file).push(f)
  return wasNewReport
}

// Remove dedupe `key` (contributed from `file`) from `bucket`'s public
// index — `_keyReports`, `keys`, `findings`, and the per-file list.
// `keyOf` resolves a finding back to its dedupe key. The caller decides
// whether the bucket is now empty and recomputes `reports`.
export function dropKeyFromBucket(bucket, key, file, keyOf) {
  bucket._keyReports.delete(key)
  bucket.keys.delete(key)
  const idx = bucket.findings.findIndex((f) => keyOf(f) === key)
  if (idx >= 0) bucket.findings.splice(idx, 1)
  const fileList = bucket.files.get(file)
  if (!fileList) return
  const fi = fileList.findIndex((f) => keyOf(f) === key)
  if (fi >= 0) fileList.splice(fi, 1)
  if (fileList.length === 0) bucket.files.delete(file)
}

// Recompute a bucket's public `reports` set as the union of every
// surviving `_keyReports` entry. Cheaper to recompute on prune than to
// maintain a refcount.
export function recomputeBucketReports(bucket) {
  const stillContributing = new Set()
  for (const set of bucket._keyReports.values()) {
    for (const r of set) stillContributing.add(r)
  }
  bucket.reports = stillContributing
}

// Per-version sub-bucket update — independent dedup so the same
// finding observed against two different installations (pnpm picked
// v1 in one report, v2 in another) surfaces under each version
// instead of collapsing. The top-level `keys` Set in the parent
// `indexFindingByPackage` still dedupes the aggregate; in practice
// file paths differ across versions (`.pnpm/foo@1.0.0/...` vs
// `.pnpm/foo@2.0.0/...`) so the two counts align.
export function indexFindingByVersion(pBucket, version, f, key, name) {
  let vBucket = pBucket.byVersion.get(version)
  if (!vBucket) {
    vBucket = newBucket()
    pBucket.byVersion.set(version, vBucket)
  }
  addFindingToBucket(vBucket, key, name, f)
}

// Drop one `(version, key, file, report)` slice from a package's
// per-version sub-bucket. An emptied slot is removed entirely so
// the Packages view doesn't surface a phantom version with zero
// findings; otherwise the public `reports` Set is recomputed
// against the surviving `_keyReports` entries. `keyOf` resolves a
// finding back to its dedupe key — passed in from the parent
// module so this file doesn't reach back into the index's private
// helpers.
export function pruneVersionSlot(pBucket, version, key, file, name, keyOf) {
  const vBucket = pBucket.byVersion.get(version)
  if (!vBucket) return
  const vKrSet = vBucket._keyReports.get(key)
  if (vKrSet) {
    vKrSet.delete(name)
    if (vKrSet.size === 0) dropKeyFromBucket(vBucket, key, file, keyOf)
  }
  if (vBucket._keyReports.size === 0) {
    pBucket.byVersion.delete(version)
    return
  }
  recomputeBucketReports(vBucket)
}

// Semver-ish descending comparator — `1.10.0` ranks above `1.2.0`
// (numeric segments compare numerically), versions WITHOUT a
// pre-release tag rank above those WITH one (so `1.0.0` beats
// `1.0.0-beta.2`), and `null` (unknown version from a plain
// `node_modules/<pkg>/` install) sorts last. Non-numeric segments
// fall back to localeCompare so weird tags still order
// deterministically. Used by the Packages view to pick the
// "latest" row for a multi-version package.
export function compareVersionsDesc(a, b) {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  const [aBase, aPre = ''] = splitOnce(a, '-')
  const [bBase, bPre = ''] = splitOnce(b, '-')
  const aParts = aBase.split('.')
  const bParts = bBase.split('.')
  const len = Math.max(aParts.length, bParts.length)
  for (let i = 0; i < len; i++) {
    const ap = aParts[i] ?? '0'
    const bp = bParts[i] ?? '0'
    const aNumeric = /^\d+$/u.test(ap)
    const bNumeric = /^\d+$/u.test(bp)
    if (aNumeric && bNumeric) {
      const d = Number(bp) - Number(ap)
      if (d !== 0) return d
    } else {
      const c = bp.localeCompare(ap)
      if (c !== 0) return c
    }
  }
  if (aPre === '' && bPre !== '') return -1
  if (aPre !== '' && bPre === '') return 1
  return bPre.localeCompare(aPre)
}

function splitOnce(s, sep) {
  const i = s.indexOf(sep)
  if (i < 0) return [s, '']
  return [s.slice(0, i), s.slice(i + 1)]
}
