// One comparison model for Compare and Review: bytes, metadata, resolutions,
// dependency versions and line counts, its files paired by
// @preventive/compare (computeBundleDiff, treeLayout). Worked out by the
// server for two managed bundles or two versions of a package
// (server-managed/comparison.ts), and by the viewer only for bundles it opened
// itself, which no server holds (ui/view/bundle-comparison.js): a managed
// viewer loads none of it.
import { layoutPackageDirs, treeLayout } from '@preventive/compare'
import { bundlePkgOf } from './bundle-pkg-of.js'
import { bundlePackageDirs, bundlePackageVersions } from './bundle-sources.js'
import { bundleFileMeta, computeBundleDiff, computeResolutionDiff } from './bundle-compare-diff.js'
import { comparePackages, computeVersionUpdates } from './bundle-compare-versions.js'
import { bundleCompareFiles, bundleCompareResolutions, bundleCompareSideScopes } from './bundle-compare-inputs.js'
import { bundleLineCounts } from './bundle-metadata.js'

export function prepareComparison(base, other, scope = null) {
  // Every file each side mounts, resources included: a diff of
  // source alone would call two bundles identical when only their
  // images differ, and total less than the Overview does.
  // From the bundle picked to the open one.
  const [from, to] = [base, other]
  // Each side within its scope (bundleCompareSideScopes).
  const [baseScope, otherScope] = bundleCompareSideScopes(from, to, scope)
  const baseSources = bundleCompareFiles(from, baseScope)
  const otherSources = bundleCompareFiles(to, otherScope)
  // Classify original paths and preserve recorded Stasis package
  // boundaries from either side, as the open one lays its files out
  // where their roots differ. Own source has one identity.
  const layout = treeLayout(baseSources.keys(), otherSources.keys())
  const packageDirs = layoutPackageDirs(bundlePackageDirs(from), bundlePackageDirs(to), layout)
  const pkgOf = (p) => bundlePkgOf(p, { packageDir: packageDirs?.get(p) })
  const diff = computeBundleDiff(baseSources, otherSources, pkgOf, layout, [bundleFileMeta(from), bundleFileMeta(to)])
  // Each side's lines of code (bundleLineCounts), on its rows and in
  // the totals; a file that isn't text has none.
  const baseLines = bundleLineCounts(from), otherLines = bundleLineCounts(to)
  const linesOf = (lines, paths) => { let total = 0; for (const path of paths) total += lines.get(path) ?? 0; return total }
  Object.assign(diff.totals, { baseLines: linesOf(baseLines, baseSources.keys()), otherLines: linesOf(otherLines, otherSources.keys()) })
  for (const row of diff.files.onlyBase) row.lines = baseLines.get(row.basePath ?? row.path) ?? 0
  for (const row of diff.files.onlyOther) row.lines = otherLines.get(row.path) ?? 0
  for (const row of diff.files.changed) Object.assign(row, { baseLines: baseLines.get(row.basePath ?? row.path) ?? 0, otherLines: otherLines.get(row.path) ?? 0 })
  // A file both sides hold with the same contents, renamed or recorded
  // otherwise or not: an import resolution one side records alone is told
  // only of these.
  const differs = new Set([...diff.files.onlyOther, ...diff.files.changed.filter(row => row.modified !== false)].map(row => row.path))
  diff.resolutions = computeResolutionDiff(
    bundleCompareResolutions(from, baseScope),
    bundleCompareResolutions(to, otherScope),
    new Map(diff.files.changed.filter(row => row.renamedFrom != null).map(row => [row.basePath, row.path])),
    diff.files.basePaths,
    diff.files.root,
    path => otherSources.has(path) && !differs.has(path),
  )
  // Dependency versions come from the stasis per-module `{ name,
  // version }` metadata, not the path/byte walk above, so they're
  // computed alongside and hung off the same memo: the package rows
  // join them to the sizes, the summary counts them. Empty for
  // sourcemap / v0 pairs (no version metadata), whose rows carry sizes
  // alone.
  // Keyed by install directory, as the sizes are (`bundlePkgOf`).
  const versionKey = dir => bundlePkgOf('', { packageDir: dir })
  const baseVersions = bundlePackageVersions(from, baseScope ? baseSources.keys() : null, versionKey)
  const otherVersions = bundlePackageVersions(to, otherScope ? otherSources.keys() : null, versionKey)
  diff.versionUpdates = computeVersionUpdates(baseVersions, otherVersions)
  diff.packageRows = comparePackages(diff.packages, baseVersions, otherVersions)
  // The reason scope its files are within, for what the server works out of
  // them alike (rename-diff.js, type-only.js).
  diff.scope = scope ?? ''
  return diff
}
