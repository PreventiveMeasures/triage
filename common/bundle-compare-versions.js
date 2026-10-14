// Dependency versions two bundles record, compared: sorting versions as
// semver orders them, which way a package moved, and the Overview's package
// rows from computeBundleDiff's sizes. No @preventive/compare here, so a view
// that only orders versions loads none of the comparison's pairing.

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
