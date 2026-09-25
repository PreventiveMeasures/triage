import { Bundle } from '@exodus/stasis-core/bundle'
import { managedFetch } from '../../client/managed/request.js'
import { decodeUtf8 } from '../../common/utf8.js'
import { brotliDecompress } from '../view/brotli-decompress.js'
import { storedScanBundle } from '../scan/bundle-source.js'
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

// Read only the selected managed bundle. Reuse the scan inventory adapter,
// without writing server-owned contents into the local bundle store.
export async function loadManagedScanBundle(entry, signal) {
  const response = await managedFetch(`/api/admin/bundles/${encodeURIComponent(entry.id)}`, { signal, credentials: 'same-origin' })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  signal?.throwIfAborted()
  const details = { integrity: entry.integrity, size: bytes.byteLength }
  if (entry.filename.toLowerCase().endsWith('.map')) {
    details.kind = 'sourcemap'
    details.json = JSON.parse(decodeUtf8(bytes))
  } else {
    const decoded = await brotliDecompress(bytes)
    signal?.throwIfAborted()
    details.kind = 'stasis'
    details.bundle = Bundle.parse(decodeUtf8(decoded))
  }
  return storedScanBundle(entry, details)
}
