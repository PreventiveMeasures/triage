import { bundleFileSizes, bundlePackageDirs } from '../view/bundle-sources.js'
import { bundleLineCounts } from '../view/bundle-metadata.js'
import { bundlePkgOf } from '../view/bundle-pkg-of.js'
import { bundleScopes, scopeOptions } from '../../common/bundle-reasons.js'
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
  // A scope's files are read once it is chosen: an entry point's are walked for.
  const reasons = [{ id: 'all', label: 'All', filePaths: null }, ...scopeOptions(scopes).map(scope => {
    let filePaths
    return { ...scope, get filePaths() { return filePaths ??= [...scopes.files(scope.id)] } }
  })]
  return { ...entry, files, reasons, size: formatBytes(details.size) }
}
