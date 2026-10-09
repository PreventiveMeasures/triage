// Pure bundle comparison — no Lit, no DOM, no `state`. Given two
// `Map<path, content>` file maps (the shape `bundleFilesAsMap` returns
// for either a sourcemap or a stasis bundle: every file the terminal
// mounts, source or resource, with no directory captures) plus a
// `pkgOf(path)` bucketing function, it computes a structural diff:
// which files exist only in one side, which exist in both but changed,
// per-package size deltas, and the roll-up totals.
//
// Kept free of Lit, the DOM and the OPFS parse pipeline on purpose, so
// `<bundle-compare>` (the Compare slide in the bundles view) and its
// unit test can both consume the same logic — the test exercises this
// module directly. Its one import is the file sizer the Overview uses,
// itself pure. The component is a thin rendering shell around
// `computeBundleDiff`.
//
// `base` is the currently-open bundle (the tab you're viewing);
// `other` is the bundle picked to compare against. The result names
// the two sides `onlyBase` / `onlyOther` rather than added / removed
// so the UI can label them with each bundle's actual name — "added"
// is ambiguous without knowing which side is newer.

import { bundleFileByteLength } from './bundle-sources.js'

// Resolutions compare independently from file bytes: identical files can be
// wired together differently. Inputs are keyed by importer, specifier,
// conditions (including import attributes), and platform. Only existing
// resolutions whose targets changed are reported; additions/removals are omitted.
export function computeResolutionDiff(base, other) {
  const changed = []
  for (const [key, before] of base) {
    const after = other.get(key)
    if (after && before.target !== after.target) {
      const { target: baseTarget, ...identity } = before
      changed.push({ ...identity, baseTarget, otherTarget: after.target })
    }
  }
  changed.sort((a, b) => a.key.localeCompare(b.key))
  return { changed, totalChanges: changed.length }
}

// A file's size, by the measure the Overview and Treemap use: text by the
// UTF-8 it encodes to, a base64 resource by the bytes it decodes to. A
// file with no size to give (a base64 spelling that does not decode)
// counts as zero bytes, but is still compared.
function byteLen(content) {
  return bundleFileByteLength(content) ?? 0
}

// Whether two sides hold the same file. Text compares as text; a base64
// resource arrives as a fresh `{ format: 'base64', data }` on each side,
// so it compares by its spelling — identity would call every image
// changed. A file that is text on one side and base64 on the other has
// changed.
function sameContent(a, b) {
  return a === b || (a?.format === 'base64' && b?.format === 'base64' && a.data === b.data)
}

// Comparator: largest absolute delta first, then path/label ascending
// so equal-magnitude rows stay stably ordered. Used for the changed
// file + package lists, where the biggest mover is the most
// interesting row.
function byAbsDeltaThenKey(key) {
  return (a, b) => {
    const d = Math.abs(b.delta) - Math.abs(a.delta)
    // `d || …` falls through to the tiebreak only when the magnitudes
    // match (d === 0); a non-zero d is returned as-is.
    return d || a[key].localeCompare(b[key])
  }
}

// Largest byte size first, then key ascending — for the only-in-one-
// side lists, where there's no delta to rank by.
function byBytesThenKey(key) {
  return (a, b) => {
    const d = b.bytes - a.bytes
    return d || a[key].localeCompare(b[key])
  }
}

// Script and style sources keep their kind across a rename (`a.js` →
// `a.ts`, `a.css` → `a.scss`); any other file keeps its extension.
const EXTENSION_FAMILIES = new Map([
  ...['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx'].map(ext => [ext, 'script']),
  ...['.css', '.scss', '.sass', '.less'].map(ext => [ext, 'style']),
])

// The keys a file meets a rename partner on: its package, its name less
// the extension, the extension's family, and its directory — as it is (the
// extension changed) or with one directory past the last node_modules
// swapped for another (`src/a.js` → `lib/a.js`, `node_modules/a/src/x.ts`
// → `node_modules/a/lib/x.js`). `\0` separates; no path holds one.
function renameKeys(path, pkg) {
  const dirs = path.split('/')
  const name = dirs.pop()
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot) : ''
  const head = [pkg, dot > 0 ? name.slice(0, dot) : name, EXTENSION_FAMILIES.get(ext) ?? ext].join('\0')
  const keys = [`${head}\0${dirs.join('/')}`]
  for (let i = dirs.lastIndexOf('node_modules') + 1; i < dirs.length; i++) keys.push(`${head}\0${i}\0${dirs.toSpliced(i, 1, '').join('/')}`)
  return keys
}

// The files of `removed` (only in base) renamed to one of `added` (only in
// other): `Map<base path, other path>`. A pair counts only when it is clear
// — each file the other's one candidate, no alternative on either side —
// so `src/a.js` with both `lib/a.js` and `src/a.ts` added stays removed.
export function detectRenames(removed, added, pkgOf) {
  const buckets = new Map()
  const keysOf = side => new Map(side.paths.map(path => {
    const keys = renameKeys(path, pkgOf(path))
    for (const key of keys) {
      if (!buckets.has(key)) buckets.set(key, { removed: [], added: [] })
      buckets.get(key)[side.name].push(path)
    }
    return [path, keys]
  }))
  const removedKeys = keysOf({ name: 'removed', paths: removed })
  const addedKeys = keysOf({ name: 'added', paths: added })
  // The one file of `side` a file's keys meet, or null for none or several.
  const partner = (side, keys) => {
    let found = null
    for (const key of keys) {
      const list = buckets.get(key)[side]
      if (list.length > 1 || (list.length === 1 && found !== null && found !== list[0])) return null
      if (list.length === 1) found = list[0]
    }
    return found
  }
  const renames = new Map()
  for (const [path, keys] of removedKeys) {
    const to = partner('added', keys)
    if (to !== null && partner('removed', addedKeys.get(to)) === path) renames.set(path, to)
  }
  return renames
}

// A rename the way `git diff --stat` writes one: the directories both
// paths share, then the part that changed (`src/{a.js → a.ts}`,
// `{src → lib}/a.js`).
export function renameLabel(from, to) {
  const a = from.split('/'), b = to.split('/')
  let head = 0
  while (head < a.length - 1 && head < b.length - 1 && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head - 1 && tail < b.length - head - 1 && a.at(-1 - tail) === b.at(-1 - tail)) tail++
  const prefix = a.slice(0, head).join('/'), suffix = tail ? a.slice(-tail).join('/') : ''
  const middle = `{${a.slice(head, a.length - tail).join('/')} → ${b.slice(head, b.length - tail).join('/')}}`
  return `${prefix ? `${prefix}/` : ''}${middle}${suffix ? `/${suffix}` : ''}`
}

// Per-package accumulator factory. Tracks each side's byte total plus
// per-bucket file counts so a package is flagged `changed` whenever
// ANY of its files moved — not only when the byte total happens to
// differ (two versions can shuffle content while landing on the same
// size).
function emptyPkgAcc() {
  return {
    baseBytes: 0,
    otherBytes: 0,
    onlyBaseFiles: 0,
    onlyOtherFiles: 0,
    changedFiles: 0,
  }
}

// Compare two bundle source maps. Returns:
//   {
//     totals: { baseFiles, baseBytes, otherFiles, otherBytes,
//               onlyBaseFiles, onlyBaseBytes, onlyOtherFiles,
//               onlyOtherBytes, changedFiles, changedDelta,
//               unchangedFiles, fileDelta, byteDelta, identical },
//     files: {
//       onlyBase:  [{ path, bytes }],
//       onlyOther: [{ path, bytes }],
//       changed:   [{ path, baseBytes, otherBytes, delta, basePath? }],
//     },
//     packages: {
//       onlyBase:  [{ pkg, bytes }],
//       onlyOther: [{ pkg, bytes }],
//       changed:   [{ pkg, baseBytes, otherBytes, delta }],
//     },
//   }
//
// `delta` is always `other − base` (positive = the compared bundle is
// larger). A file clearly renamed (see detectRenames) is changed, not
// removed and added: its row's `path` is the other side's, `basePath` the
// base's, and it counts in `renamedFiles` too, its contents moved or not.
// `identical` is true when the two bundles carry the exact same set of
// paths with byte-identical content, resources included.
export function computeBundleDiff(base, other, pkgOf) {
  const onlyBase = []
  const onlyOther = []
  const changed = []
  let baseBytes = 0
  let otherBytes = 0
  let onlyBaseBytes = 0
  let onlyOtherBytes = 0
  let changedDelta = 0
  let unchangedFiles = 0
  const pkgs = new Map()
  const pkgAcc = (path) => {
    const key = pkgOf(path)
    let acc = pkgs.get(key)
    if (!acc) { acc = emptyPkgAcc(); pkgs.set(key, acc) }
    return acc
  }

  const allPaths = new Set([...base.keys(), ...other.keys()])
  for (const path of allPaths) {
    const inBase = base.has(path)
    const inOther = other.has(path)
    const acc = pkgAcc(path)
    if (inBase && inOther) {
      const bC = base.get(path)
      const oC = other.get(path)
      const same = sameContent(bC, oC)
      const bB = byteLen(bC)
      // Identical content shares the byte count, so only measure the
      // other side when the files actually differ.
      const oB = same ? bB : byteLen(oC)
      baseBytes += bB
      otherBytes += oB
      acc.baseBytes += bB
      acc.otherBytes += oB
      if (same) {
        unchangedFiles++
      } else {
        const delta = oB - bB
        changed.push({ path, baseBytes: bB, otherBytes: oB, delta })
        changedDelta += delta
        acc.changedFiles++
      }
    } else if (inBase) {
      const bB = byteLen(base.get(path))
      baseBytes += bB
      onlyBaseBytes += bB
      acc.baseBytes += bB
      acc.onlyBaseFiles++
      onlyBase.push({ path, bytes: bB })
    } else {
      const oB = byteLen(other.get(path))
      otherBytes += oB
      onlyOtherBytes += oB
      acc.otherBytes += oB
      acc.onlyOtherFiles++
      onlyOther.push({ path, bytes: oB })
    }
  }

  const renames = detectRenames(onlyBase.map(row => row.path), onlyOther.map(row => row.path), pkgOf)
  if (renames.size > 0) {
    const renamedTo = new Set(renames.values())
    for (const [from, to] of renames) {
      const bC = base.get(from), oC = other.get(to)
      const bB = byteLen(bC), oB = sameContent(bC, oC) ? bB : byteLen(oC)
      onlyBaseBytes -= bB
      onlyOtherBytes -= oB
      changed.push({ path: to, basePath: from, baseBytes: bB, otherBytes: oB, delta: oB - bB })
      changedDelta += oB - bB
      // Both in one package (its key is in the rename's).
      const acc = pkgAcc(from)
      acc.onlyBaseFiles--
      acc.onlyOtherFiles--
      acc.changedFiles++
    }
    onlyBase.splice(0, onlyBase.length, ...onlyBase.filter(row => !renames.has(row.path)))
    onlyOther.splice(0, onlyOther.length, ...onlyOther.filter(row => !renamedTo.has(row.path)))
  }

  // Classify each package from its accumulator: present on exactly one
  // side → onlyBase / onlyOther; present on both with any moved file →
  // changed; otherwise unchanged (dropped — the lists surface only
  // what differs).
  const pkgOnlyBase = []
  const pkgOnlyOther = []
  const pkgChanged = []
  const pkgUnchanged = []
  for (const [pkg, acc] of pkgs) {
    // Present on a side if any of its files contributed there — its
    // byte total, an only-this-side file, or a changed file (which
    // exists on both). A changed file alone is enough to count as
    // present even when that side's bytes net to zero.
    const onBase = acc.baseBytes > 0 || acc.onlyBaseFiles > 0 || acc.changedFiles > 0
    const onOther = acc.otherBytes > 0 || acc.onlyOtherFiles > 0 || acc.changedFiles > 0
    const movedFiles = acc.onlyBaseFiles + acc.onlyOtherFiles + acc.changedFiles
    if (onBase && !onOther) {
      pkgOnlyBase.push({ pkg, bytes: acc.baseBytes })
    } else if (onOther && !onBase) {
      pkgOnlyOther.push({ pkg, bytes: acc.otherBytes })
    } else if (movedFiles > 0 || acc.baseBytes !== acc.otherBytes) {
      pkgChanged.push({
        pkg,
        baseBytes: acc.baseBytes,
        otherBytes: acc.otherBytes,
        delta: acc.otherBytes - acc.baseBytes,
      })
    } else {
      pkgUnchanged.push({ pkg, bytes: acc.baseBytes })
    }
  }

  onlyBase.sort(byBytesThenKey('path'))
  onlyOther.sort(byBytesThenKey('path'))
  changed.sort(byAbsDeltaThenKey('path'))
  pkgOnlyBase.sort(byBytesThenKey('pkg'))
  pkgOnlyOther.sort(byBytesThenKey('pkg'))
  pkgChanged.sort(byAbsDeltaThenKey('pkg'))

  return {
    totals: {
      baseFiles: base.size,
      baseBytes,
      otherFiles: other.size,
      otherBytes,
      onlyBaseFiles: onlyBase.length,
      onlyBaseBytes,
      onlyOtherFiles: onlyOther.length,
      onlyOtherBytes,
      changedFiles: changed.length,
      renamedFiles: renames.size,
      changedDelta,
      unchangedFiles,
      fileDelta: other.size - base.size,
      byteDelta: otherBytes - baseBytes,
      identical: onlyBase.length === 0 && onlyOther.length === 0 && changed.length === 0,
    },
    files: { onlyBase, onlyOther, changed },
    // `unchanged` lends a version-only change its (equal) sizes.
    packages: { onlyBase: pkgOnlyBase, onlyOther: pkgOnlyOther, changed: pkgChanged, unchanged: pkgUnchanged },
  }
}

// The Overview's package rows: each package that differs, once, from its
// sizes (computeBundleDiff's `packages`) and the versions each bundle
// records for it (`bundlePackageVersions`). A package only one side has is
// removed or added, with its size and versions there; one both have is
// changed when its size or its versions moved, with both sides of each —
// own source and workspace modules carry sizes alone.
export function comparePackages(packages, baseVersions, otherVersions) {
  const sizes = new Map()
  for (const r of packages.onlyBase) sizes.set(r.pkg, { base: r.bytes, other: null })
  for (const r of packages.onlyOther) sizes.set(r.pkg, { base: null, other: r.bytes })
  for (const r of packages.changed) sizes.set(r.pkg, { base: r.baseBytes, other: r.otherBytes })
  for (const r of packages.unchanged ?? []) sizes.set(r.pkg, { base: r.bytes, other: r.bytes })
  const versionsOf = (map, pkg) => [...map.get(pkg) ?? []].toSorted(compareSemver)
  const moved = new Set([...packages.onlyBase, ...packages.onlyOther, ...packages.changed].map(r => r.pkg))
  for (const pkg of new Set([...baseVersions.keys(), ...otherVersions.keys()])) {
    if (!sameVersions(versionsOf(baseVersions, pkg), versionsOf(otherVersions, pkg))) moved.add(pkg)
  }
  const added = [], changed = [], removed = []
  for (const pkg of moved) {
    const size = sizes.get(pkg) ?? { base: null, other: null }
    const after = versionsOf(otherVersions, pkg), before = versionsOf(baseVersions, pkg)
    const onBase = size.base !== null || before.length > 0
    const onOther = size.other !== null || after.length > 0
    if (onBase && !onOther) removed.push({ pkg, bytes: size.base, versions: before })
    else if (onOther && !onBase) added.push({ pkg, bytes: size.other, versions: after })
    else {
      changed.push({
        pkg, baseBytes: size.base, otherBytes: size.other,
        delta: size.base !== null && size.other !== null ? size.other - size.base : null,
        baseVersions: before, otherVersions: after,
        direction: before.length > 0 && after.length > 0 && !sameVersions(before, after) ? versionDirection(before, after) : null,
      })
    }
  }
  const byPkg = (a, b) => a.pkg.localeCompare(b.pkg)
  return { removed: removed.toSorted(byPkg), added: added.toSorted(byPkg), changed: changed.toSorted(byPkg) }
}

// Split a version into its dotted-numeric core and its prerelease tail,
// dropping any `+build` metadata (semver ignores it for precedence).
// `1.2.3-rc.1+sha` → { core: '1.2.3', pre: 'rc.1' }.
function splitVersion(v) {
  const s = String(v).trim()
  const noBuild = s.split('+', 1)[0]
  const dash = noBuild.indexOf('-')
  return dash === -1
    ? { core: noBuild, pre: '' }
    : { core: noBuild.slice(0, dash), pre: noBuild.slice(dash + 1) }
}

// Lightweight semver-ish comparison, enough to sort versions ascending
// and label an update ↑/↓. Compares the dotted-numeric core part by
// part (a missing part counts as 0); on an equal core a release ranks
// above a prerelease (`1.0.0` > `1.0.0-rc.1`) and two prereleases
// compare by their dot identifiers (numeric where both are numeric,
// else lexical) per the semver precedence rules. NOT a full
// implementation — a non-numeric core segment falls back to a string
// compare of the whole version so ordering stays total and stable.
export function compareSemver(a, b) {
  if (a === b) return 0
  const A = splitVersion(a)
  const B = splitVersion(b)
  const ap = A.core.split('.')
  const bp = B.core.split('.')
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    const x = Number(ap[i] ?? 0)
    const y = Number(bp[i] ?? 0)
    if (Number.isNaN(x) || Number.isNaN(y)) return a < b ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  if (A.pre === B.pre) return 0
  // A core with no prerelease is the higher (released) version.
  if (!A.pre) return 1
  if (!B.pre) return -1
  const ai = A.pre.split('.')
  const bi = B.pre.split('.')
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    const x = ai[i]
    const y = bi[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xNum = /^\d+$/u.test(x)
    const yNum = /^\d+$/u.test(y)
    // Numeric identifiers always rank below non-numeric ones (semver),
    // and compare numerically against each other.
    if (xNum && yNum) return Number(x) < Number(y) ? -1 : 1
    if (xNum !== yNum) return xNum ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

// True when two ascending-sorted version arrays hold the same members.
function sameVersions(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// Direction of a version move, from the versions dropped and the versions
// taken on: 'up' when everything dropped is older than everything taken
// on (`1.0.0` → `2.0.0`), or, with only drops or only additions, than the
// versions kept (`1.0.0, 2.0.0` → `2.0.0` drops the older copy, and a newer
// copy added beside the old is up too); 'down' the other way round; and
// 'changed' when the moves fall between (`1.0.0, 1.2.0, 2.0.0` → `1.0.0,
// 2.0.0`).
export function versionDirection(baseVersions, otherVersions) {
  const dropped = baseVersions.filter(v => !otherVersions.includes(v)).toSorted(compareSemver)
  const taken = otherVersions.filter(v => !baseVersions.includes(v)).toSorted(compareSemver)
  const kept = baseVersions.filter(v => otherVersions.includes(v)).toSorted(compareSemver)
  const [from, to] = dropped.length > 0 && taken.length > 0 ? [dropped, taken]
    : dropped.length > 0 ? [dropped, kept] : [kept, taken]
  if (from.length === 0 || to.length === 0) return 'changed'
  // Every version of `a` older than every version of `b`.
  const before = (a, b) => compareSemver(a.at(-1), b[0]) < 0
  return before(from, to) ? 'up' : before(to, from) ? 'down' : 'changed'
}

// Diff two `Map<packageName, Set<version>>` inventories (as
// `bundlePackageVersions` returns for each bundle) into the dependency
// version changes between them. Mirrors the file/package diff framing:
// `base` is the open bundle, `other` the one compared against.
//
//   {
//     updated: [{ pkg, baseVersions: [...], otherVersions: [...],
//                 direction: 'up' | 'down' | 'changed' }],
//     added:   [{ pkg, versions: [...] }],   // dependency only in other
//     removed: [{ pkg, versions: [...] }],   // dependency only in base
//     totals:  { baseDeps, otherDeps },      // distinct package counts
//   }
//
// `updated` is the headline — a package present on BOTH sides whose set
// of versions changed (the "what did this bump pull in?" answer);
// packages whose versions are byte-for-byte the same are dropped.
// Version arrays are sorted ascending; the three lists are sorted by
// package name so the dependency list reads alphabetically.
export function computeVersionUpdates(baseVersions, otherVersions) {
  const updated = []
  const added = []
  const removed = []
  const names = new Set([...baseVersions.keys(), ...otherVersions.keys()])
  for (const pkg of names) {
    const bSet = baseVersions.get(pkg)
    const oSet = otherVersions.get(pkg)
    if (bSet && oSet) {
      const b = [...bSet].toSorted(compareSemver)
      const o = [...oSet].toSorted(compareSemver)
      if (sameVersions(b, o)) continue
      updated.push({ pkg, baseVersions: b, otherVersions: o, direction: versionDirection(b, o) })
    } else if (bSet) {
      removed.push({ pkg, versions: [...bSet].toSorted(compareSemver) })
    } else {
      added.push({ pkg, versions: [...oSet].toSorted(compareSemver) })
    }
  }
  const byPkg = (a, b) => a.pkg.localeCompare(b.pkg)
  updated.sort(byPkg)
  added.sort(byPkg)
  removed.sort(byPkg)
  return {
    updated,
    added,
    removed,
    totals: { baseDeps: baseVersions.size, otherDeps: otherVersions.size },
  }
}
