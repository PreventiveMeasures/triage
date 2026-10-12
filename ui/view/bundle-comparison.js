import { layoutPackageDirs, treeLayout } from '@preventive/compare'
import { bundlePkgOf } from './bundle-pkg-of.js'
import { bundlePackageDirs, bundlePackageVersions } from './bundle-sources.js'
import { bundleFileMeta, comparePackages, computeBundleDiff, computeResolutionDiff, computeVersionUpdates } from './bundle-compare-diff.js'
import { bundleCompareFiles, bundleCompareResolutions } from './bundle-compare-inputs.js'
import { bundleLineCounts } from '../../common/bundle-metadata.js'

// One comparison model for Compare and Review: bytes, metadata, resolutions,
// dependency versions and line counts. Callers cache it for their selected pair.
export function prepareComparison(base, other, scope = null) {
  // Every file each side mounts, resources included: a diff of
  // source alone would call two bundles identical when only their
  // images differ, and total less than the Overview does.
  // From the bundle picked to the open one.
  const [from, to] = [base, other]
  const baseSources = bundleCompareFiles(from, scope)
  const otherSources = bundleCompareFiles(to, scope)
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
  diff.resolutions = computeResolutionDiff(
    bundleCompareResolutions(from, scope),
    bundleCompareResolutions(to, scope),
    new Map(diff.files.changed.filter(row => row.renamedFrom != null).map(row => [row.basePath, row.path])),
    diff.files.basePaths,
    diff.files.root,
  )
  // Dependency versions come from the stasis per-module `{ name,
  // version }` metadata, not the path/byte walk above, so they're
  // computed alongside and hung off the same memo: the package rows
  // join them to the sizes, the summary counts them. Empty for
  // sourcemap / v0 pairs (no version metadata), whose rows carry sizes
  // alone.
  // Keyed by install directory, as the sizes are (`bundlePkgOf`).
  const versionKey = dir => bundlePkgOf('', { packageDir: dir })
  const baseVersions = bundlePackageVersions(from, scope ? baseSources.keys() : null, versionKey)
  const otherVersions = bundlePackageVersions(to, scope ? otherSources.keys() : null, versionKey)
  diff.versionUpdates = computeVersionUpdates(baseVersions, otherVersions)
  diff.packageRows = comparePackages(diff.packages, baseVersions, otherVersions)
  return diff
}
