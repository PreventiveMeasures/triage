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
// index module to avoid a circular import.

// Version extractor — surfaces the installed version when the path
// carries pnpm's `.pnpm/<encoded-name>@<version>/node_modules/<name>/...`
// shape. Scoped names are encoded with `+` (e.g.
// `@scope/name` → `@scope+name`), and a `_<peer-deps>` suffix may
// follow the version when pnpm pinned a peer-dep variant (e.g.
// `foo@1.2.3_react@18.0.0`). Peer-dep stripping has to happen
// BEFORE the last-`@` split — otherwise `lastIndexOf('@')` finds
// the peer's own `@`, not the package's, and the version comes
// back as the peer-dep major. Returns null for plain
// `node_modules/<pkg>/` paths (no version available); the
// Packages view treats null as a single unversioned bucket.
export function packageVersionOf(file) {
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
    vBucket = { keys: new Set(), findings: [], files: new Map(), reports: new Set(), _keyReports: new Map() }
    pBucket.byVersion.set(version, vBucket)
  }
  vBucket.reports.add(name)
  let vKrSet = vBucket._keyReports.get(key)
  if (!vKrSet) {
    vKrSet = new Set()
    vBucket._keyReports.set(key, vKrSet)
  }
  vKrSet.add(name)
  if (vBucket.keys.has(key)) return
  vBucket.keys.add(key)
  vBucket.findings.push(f)
  if (!vBucket.files.has(f.file)) vBucket.files.set(f.file, [])
  vBucket.files.get(f.file).push(f)
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
    if (vKrSet.size === 0) dropVersionKey(vBucket, key, file, keyOf)
  }
  if (vBucket._keyReports.size === 0) {
    pBucket.byVersion.delete(version)
    return
  }
  const stillContributing = new Set()
  for (const set of vBucket._keyReports.values()) {
    for (const r of set) stillContributing.add(r)
  }
  vBucket.reports = stillContributing
}

function dropVersionKey(vBucket, key, file, keyOf) {
  vBucket._keyReports.delete(key)
  vBucket.keys.delete(key)
  const idx = vBucket.findings.findIndex((f) => keyOf(f) === key)
  if (idx >= 0) vBucket.findings.splice(idx, 1)
  const fileList = vBucket.files.get(file)
  if (!fileList) return
  const fi = fileList.findIndex((f) => keyOf(f) === key)
  if (fi >= 0) fileList.splice(fi, 1)
  if (fileList.length === 0) vBucket.files.delete(file)
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
