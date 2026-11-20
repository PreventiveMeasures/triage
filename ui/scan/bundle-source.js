import { bundleFileSizes, bundlePackageDirs } from '../view/bundle-sources.js'
import { bundleLineCounts } from '../view/bundle-metadata.js'
import { bundlePkgOf } from '../view/bundle-pkg-of.js'
import { bundleScopeOptions, bundleScopes } from '../../common/bundle-reasons.js'
import { formatBytes } from './metrics.js'

// Preserve every workspace membership: one stored bundle can be selected from
// several workspaces. Only bundles without an owner appear under Unattached.
export function storedScanSource(entries, workspaces = []) {
  const repositories = new Map()
  const bundles = entries.flatMap(entry => {
    const owners = workspaces.filter(workspace => workspace.bundles?.includes(entry.integrity))
    const scopes = owners.length > 0 ? owners.map(workspace => ({ id: workspace.id, label: workspace.name })) : [{ id: 'unattached', label: 'Unattached' }]
    return scopes.map(scope => {
      repositories.set(scope.id, scope)
      return { id: entry.integrity, integrity: entry.integrity, filename: entry.name,
        repoId: scope.id, repo: scope.label, files: null, reasons: [], size: '—' }
    })
  })
  return {
    repositories: [...repositories.values()], bundles,
    reports: [], scans: [],
  }
}

export function storedScanBundle(entry, details) {
  if (details.error) throw new Error(details.error)
  const packages = bundlePackageDirs(details)
  const formats = details.kind === 'stasis' ? details.bundle?.formats : null
  const lineCounts = bundleLineCounts(details)
  const files = [...bundleFileSizes(details)].filter(([, bytes]) => bytes != null)
    .map(([path, bytes]) => ({ path, format: formats?.get(path) ?? null, bytes, lines: lineCounts.get(path) ?? 0, size: formatBytes(bytes), module: bundlePkgOf(path, { packageDir: packages?.get(path) }) }))
  const scopes = bundleScopes(details, files.map(file => file.path))
  const options = bundleScopeOptions(scopes)
  const reasons = [{ id: 'all', label: 'All', filePaths: null },
    ...options.reasons.map(({ id, label }) => ({ id, label, filePaths: [...scopes.reasons.get(label)] }))]
  // The scopes to scan instead of a reason's, where the bundle offers them
  // (bundleScopes). An entry point's files are read once it is chosen.
  const entries = options.entries.map(({ id, label }) => {
    let filePaths
    return { id, label, get filePaths() { return filePaths ??= [...scopes.files(id)] } }
  })
  return { ...entry, files, reasons, entries, size: formatBytes(details.size) }
}
