// Pure bundle comparison — no Lit, no DOM, no `state`. Given two
// `Map<path, content>` source maps (the shape `bundleSourcesAsMap`
// returns for either a sourcemap or a stasis bundle) plus a
// `pkgOf(path)` bucketing function, it computes a structural diff:
// which source files exist only in one side, which exist in both but
// changed, per-package size deltas, and the roll-up totals.
//
// Kept dependency-free on purpose so `<bundle-compare>` (the Compare
// slide in the bundles view) and its unit test can both consume the
// same logic — the test exercises this module directly without
// standing up Lit or the OPFS parse pipeline. The component is a thin
// rendering shell around `computeBundleDiff`.
//
// `base` is the currently-open bundle (the tab you're viewing);
// `other` is the bundle picked to compare against. The result names
// the two sides `onlyBase` / `onlyOther` rather than added / removed
// so the UI can label them with each bundle's actual name — "added"
// is ambiguous without knowing which side is newer.

const enc = new TextEncoder()

// UTF-8 byte length of a source string. Non-strings (a stasis
// resource entry that slipped through, or a missing sourcemap
// `sourcesContent[i]`) count as zero bytes — the same convention the
// treemap + size-distribution use.
function byteLen(content) {
  return typeof content === 'string' ? enc.encode(content).byteLength : 0
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
//       changed:   [{ path, baseBytes, otherBytes, delta }],
//     },
//     packages: {
//       onlyBase:  [{ pkg, bytes }],
//       onlyOther: [{ pkg, bytes }],
//       changed:   [{ pkg, baseBytes, otherBytes, delta }],
//     },
//   }
//
// `delta` is always `other − base` (positive = the compared bundle is
// larger). `identical` is true when the two bundles carry the exact
// same set of paths with byte-identical content.
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
      const bB = byteLen(bC)
      // Identical content shares the byte count, so only measure the
      // other side when the strings actually differ.
      const oB = bC === oC ? bB : byteLen(oC)
      baseBytes += bB
      otherBytes += oB
      acc.baseBytes += bB
      acc.otherBytes += oB
      if (bC === oC) {
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

  // Classify each package from its accumulator: present on exactly one
  // side → onlyBase / onlyOther; present on both with any moved file →
  // changed; otherwise unchanged (dropped — the lists surface only
  // what differs).
  const pkgOnlyBase = []
  const pkgOnlyOther = []
  const pkgChanged = []
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
      changedDelta,
      unchangedFiles,
      fileDelta: other.size - base.size,
      byteDelta: otherBytes - baseBytes,
      identical: onlyBase.length === 0 && onlyOther.length === 0 && changed.length === 0,
    },
    files: { onlyBase, onlyOther, changed },
    packages: { onlyBase: pkgOnlyBase, onlyOther: pkgOnlyOther, changed: pkgChanged },
  }
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

// Direction of a version move, from the highest version on each side
// (last after the ascending sort): a newer max → 'up', an older max →
// 'down', an equal max with a different set (a pnpm dedupe, or an added
// duplicate major) → 'changed'.
function versionDirection(baseSorted, otherSorted) {
  const cmp = compareSemver(otherSorted.at(-1), baseSorted.at(-1))
  return cmp > 0 ? 'up' : cmp < 0 ? 'down' : 'changed'
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
