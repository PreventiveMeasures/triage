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
    const hasBase = acc.baseBytes > 0 || acc.onlyBaseFiles > 0 || acc.changedFiles > 0
    const hasOther = acc.otherBytes > 0 || acc.onlyOtherFiles > 0 || acc.changedFiles > 0
    const onBase = hasBase || acc.onlyBaseFiles > 0
    const onOther = hasOther || acc.onlyOtherFiles > 0
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
