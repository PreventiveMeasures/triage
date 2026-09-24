import { bundleFileSizes, bundlePackageDirs, bundleSourcesAsMap } from '../view/bundle-sources.js'
import { bundleSourceLineCount } from '../view/bundle-metadata.js'
import { bundlePkgOf } from '../view/bundle-pkg-of.js'
import { bundleGraphReasons } from '../view/bundle-graph-inputs.js'
import { formatBytes } from './metrics.js'

// Storage currently records bundle identity and filename, without repository
// assignments. Keep these bundles explicitly Unattached; don't infer a repo
// from a filename or substitute managed fixtures.
export function storedScanSource(entries) {
  return {
    repositories: entries.length > 0 ? [{ id: 'unattached', label: 'Unattached' }] : [],
    bundles: entries.map(entry => ({
      id: entry.integrity, integrity: entry.integrity, filename: entry.name,
      repoId: 'unattached', repo: 'Unattached', files: null, reasons: [], size: '—',
    })),
    reports: [], scans: [],
  }
}

export function storedScanBundle(entry, details) {
  if (details.error) throw new Error(details.error)
  const packages = bundlePackageDirs(details)
  const lineCounts = details.lineCounts ?? new Map([...bundleSourcesAsMap(details)]
    .map(([path, content]) => [path, bundleSourceLineCount(content)]))
  const files = [...bundleFileSizes(details)].filter(([, bytes]) => bytes != null)
    .map(([path, bytes]) => ({ path, bytes, lines: lineCounts.get(path) ?? 0, size: formatBytes(bytes), module: bundlePkgOf(path, { splitOwnDirs: false, packageDir: packages?.get(path) }) }))
  const reasons = [{ id: 'all', label: 'All', filePaths: null }, ...[...bundleGraphReasons(details, files.map(file => file.path))]
    .map(([reason, paths]) => ({ id: `reason:${reason}`, label: reason, filePaths: [...paths] }))]
  return { ...entry, files, reasons, size: formatBytes(details.size) }
}
