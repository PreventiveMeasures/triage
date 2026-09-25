import { formatBytes } from '../scan/metrics.js'

// Use the same catalogue as Manage → Bundles, including repositories with no
// bundles yet. Retain assigned repositories missing from the selectable list.
export function managedScanSource(catalogue) {
  const repositories = new Map((catalogue.repos ?? []).map(repo => [repo.repoId, { id: repo.repoId, label: repo.fullName }]))
  const bundles = (catalogue.bundles ?? []).map(bundle => {
    const repoId = bundle.repoId ?? 'unattached'
    if (!repositories.has(repoId)) {
      repositories.set(repoId, {
        id: repoId, label: repoId === 'unattached' ? 'Unattached' : bundle.repoFullName ?? String(repoId),
      })
    }
    return {
      ...bundle, repoId, repo: repositories.get(repoId).label,
      size: formatBytes(bundle.byteSize), files: null, reasons: [],
    }
  })
  return { repositories: [...repositories.values()], bundles, scans: [] }
}
