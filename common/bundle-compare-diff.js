// Shared bundle comparison — no Lit, no DOM, no `state`. Given two
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
// module directly. Its imports are the file sizer the Overview uses and
// @preventive/compare's renames and layout, all pure. The component is a
// thin rendering shell around `computeBundleDiff`.
//
// `base` is the currently-open bundle (the tab you're viewing);
// `other` is the bundle picked to compare against. The result names
// the two sides `onlyBase` / `onlyOther` rather than added / removed
// so the UI can label them with each bundle's actual name — "added"
// is ambiguous without knowing which side is newer.

import { compareTrees, treeLayout } from '@preventive/compare'
import { bundleFileByteLength } from './bundle-sources.js'
import { resolutionKey } from './bundle-compare-inputs.js'

// Resolutions compare independently from file bytes: identical files can be
// wired together differently. Inputs are keyed by importer, specifier,
// conditions (including import attributes), and platform. Only existing
// resolutions whose targets changed are reported; additions/removals are omitted.
// `renames` (base path → other path, see renamesOf) names base files as
// the other bundle does: a renamed importer's resolutions pair with its new
// path's, reported under it, and a target renamed is the same target.
// `basePaths` and `root` (computeBundleDiff's `files`) name the rest where
// the bundles' roots differ, a base target shown as the other bundle would
// lay it out; a path no file has (an importer the bundle didn't capture, a
// builtin) may read either as it is or through the root.
export function computeResolutionDiff(base, other, renames = new Map(), basePaths = new Map(), root = null) {
  const names = path => {
    const known = renames.get(path) ?? basePaths.get(path)
    return known === undefined ? [...new Set([path, through(root, path) ?? path])] : [known]
  }
  const changed = []
  for (const before of base.values()) {
    const after = names(before.parent).map(parent => other.get(resolutionKey(parent, before.specifier, before.conditions, before.platform))).find(Boolean)
    if (after && !names(before.target).includes(after.target)) {
      const { target: otherTarget, ...identity } = after
      changed.push({ ...identity, baseTarget: basePaths.get(before.target) ?? before.target, otherTarget })
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
// changed. An npm package's binary file compares by its digest.
function sameContent(a, b) {
  return a === b || (a?.format === 'base64' && b?.format === 'base64' && a.data === b.data)
    || (a?.format === 'digest' && b?.format === 'digest' && a.digest === b.digest)
}

// What a stasis bundle records of a file beside its bytes: the format it
// loads it in (a resource is carried as data, the rest run as code), whether
// it carries an execute bit, and whether the bundle starts from it. A
// function of the file's path; null for another kind of bundle, which
// records none of it.
export function bundleFileMeta(details) {
  if (details?.kind !== 'stasis' || !details.bundle) return null
  const { formats, executable, entries } = details.bundle
  return path => ({ format: formats?.get(path), executable: executable?.has(path) ?? false, entry: entries?.has(path) ?? false })
}

// How a file's record changed from one stasis bundle to the other, as
// `{ field, from, to }` (bundleFileMeta's fields): none where either side
// records nothing. A format left unsaid is one too: stasis runs such a
// file as code, so a resource whose format is dropped runs.
function metaChanges(before, after) {
  if (!before || !after) return []
  return ['format', 'executable', 'entry'].filter(field => before[field] !== after[field]).map(field => ({ field, from: before[field], to: after[field] }))
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

// A file's content as compareTrees reads it to find renames, each kind tagged
// apart: text as it is (a lone surrogate, which no UTF-8 holds, as U+FFFD); a
// resource by its spelling or its digest; and one with none, by its place in
// its list alone, so that only its path pairs it.
function treeData(content, at) {
  if (typeof content === 'string') return `\0text\0${content.toWellFormed()}`
  if (content?.format === 'base64') return `\0base64\0${content.data}`
  return content?.format === 'digest' ? `\0digest\0${content.digest}` : `\0none\0${at}`
}

// git's diff.renameLimit for a package's renames: past this many removed files
// by added ones, squared, no pair is scored, as that would hold the page for
// seconds, and only identical content and paths pair them.
const RENAME_LIMIT = 250

// The files of `onlyBase` renamed to one of `onlyOther`, both by path as the
// other bundle lays them out, within a package: `Map<base path, other path>`,
// as @preventive/compare's compareTrees finds them, by content as git diff -M
// does and where their paths say so. Whether a renamed file changed is
// sameContent's to say, not this reading's. A path no UTF-8 holds is left out.
function renamesOf(onlyBase, onlyOther, base, other, pkgOf) {
  const entries = (rows, files, side) => rows.filter(({ path }) => path !== '' && path.isWellFormed())
    .map(({ path }, at) => ({ name: path, data: treeData(files.get(path), `${side}${at}`) }))
  const options = { paths: 'keys', renameGroup: pkgOf, renameLimit: RENAME_LIMIT, lines: false }
  const changes = compareTrees(entries(onlyBase, base, 'a'), entries(onlyOther, other, 'b'), options)
  return new Map(changes.filter(({ status }) => status === 'renamed').map(change => [change.old.path, change.new.path]))
}

// A base path through `root` as treeLayout reads it, or null for one outside
// a base root.
function through(root, path) {
  if (!root) return path
  if (root.base === '') return `${root.other}${path}`
  return path.startsWith(root.base) ? path.slice(root.base.length) : null
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
//       changed:   [{ path, baseBytes, otherBytes, delta, basePath?, modified?, meta? }],
//     },
//     packages: {
//       onlyBase:  [{ pkg, bytes }],
//       onlyOther: [{ pkg, bytes }],
//       changed:   [{ pkg, baseBytes, otherBytes, delta }],
//     },
//   }
//
// `delta` is always `other − base` (positive = the compared bundle is
// larger). A file renamed (see renamesOf) is changed, not
// removed and added: its row's `path` is the other side's, `renamedFrom`
// the base's, `modified` whether its contents changed too, and it counts in
// `renamedFiles` as well, its contents moved or not.
// Where one bundle's files sit under a directory of the other's (`root`, see
// treeLayout), the base's are compared as the other lays them out: a row's
// `path` (and `renamedFrom`) reads that way, and `basePath` names the file
// in the base bundle wherever that differs from `path`. `files.basePaths`
// maps every base file to how it reads. `layout` (treeLayout) may come
// from the caller, to key `pkgOf` by the same paths: it is asked of files
// as the other bundle lays them out.
// `meta`, each side's bundleFileMeta where it has one, compares what two
// stasis bundles record of a file beside its bytes: a row whose record
// changed carries how (`meta`, metaChanges), and a file whose record alone
// changed is changed too, `modified: false`, its bytes the same.
// `identical` is true when the two bundles carry the same files with
// byte-identical content, resources included, each recorded alike.
export function computeBundleDiff(base, other, pkgOf, layout = treeLayout(base.keys(), other.keys()), meta = []) {
  const { root, paths: basePaths } = layout
  // The base's files as the other lays them out, and back.
  const baseFile = new Map([...basePaths].map(([from, to]) => [to, from]))
  base = new Map([...base].map(([path, content]) => [basePaths.get(path), content]))
  const atBase = path => baseFile.get(path) === path ? {} : { basePath: baseFile.get(path) }
  // How a file's record changed, by its base path and its path, as a row's fields.
  const recorded = (from, to) => {
    const changes = metaChanges(meta[0]?.(from), meta[1]?.(to))
    return changes.length > 0 ? { meta: changes } : {}
  }
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
      const record = recorded(baseFile.get(path), path)
      const bB = byteLen(bC)
      // Identical content shares the byte count, so only measure the
      // other side when the files actually differ.
      const oB = same ? bB : byteLen(oC)
      baseBytes += bB
      otherBytes += oB
      acc.baseBytes += bB
      acc.otherBytes += oB
      if (same && !record.meta) {
        unchangedFiles++
      } else {
        const delta = oB - bB
        changed.push({ path, ...atBase(path), baseBytes: bB, otherBytes: oB, delta, ...record, ...same ? { modified: false } : {} })
        changedDelta += delta
        acc.changedFiles++
      }
    } else if (inBase) {
      const bB = byteLen(base.get(path))
      baseBytes += bB
      onlyBaseBytes += bB
      acc.baseBytes += bB
      acc.onlyBaseFiles++
      onlyBase.push({ path, ...atBase(path), bytes: bB })
    } else {
      const oB = byteLen(other.get(path))
      otherBytes += oB
      onlyOtherBytes += oB
      acc.otherBytes += oB
      acc.onlyOtherFiles++
      onlyOther.push({ path, bytes: oB })
    }
  }

  const renames = renamesOf(onlyBase, onlyOther, base, other, pkgOf)
  if (renames.size > 0) {
    const renamedTo = new Set(renames.values())
    for (const [from, to] of renames) {
      const bC = base.get(from), oC = other.get(to)
      const same = sameContent(bC, oC)
      const bB = byteLen(bC), oB = same ? bB : byteLen(oC)
      onlyBaseBytes -= bB
      onlyOtherBytes -= oB
      changed.push({ path: to, renamedFrom: from, basePath: baseFile.get(from), baseBytes: bB, otherBytes: oB, delta: oB - bB, modified: !same, ...recorded(baseFile.get(from), to) })
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
    files: { onlyBase, onlyOther, changed, root, basePaths },
    // `unchanged` lends a version-only change its (equal) sizes.
    packages: { onlyBase: pkgOnlyBase, onlyOther: pkgOnlyOther, changed: pkgChanged, unchanged: pkgUnchanged },
  }
}

// The versions' part (bundle-compare-versions.js), as one comparison reads it.
export { comparePackages, compareSemver, computeVersionUpdates, versionDirection } from './bundle-compare-versions.js'
