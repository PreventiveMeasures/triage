import { isManagedUiMode, listBundles } from '#client/index.js'
import { buildBundleDetails } from './bundle-load.js'
import { storedScanBundle, storedScanSource } from '../scan/bundle-source.js'

function checkLocal(signal) {
  signal?.throwIfAborted()
  if (isManagedUiMode()) throw new DOMException('Local scan closed', 'AbortError')
}

export async function loadLocalScanSource(signal) {
  checkLocal(signal)
  const entries = await listBundles()
  checkLocal(signal)
  return storedScanSource(entries)
}

export async function loadLocalScanBundle(entry, signal) {
  checkLocal(signal)
  // Reuse the existing private metadata cache; read/decode the stored bundle
  // only when an index is missing. No source bytes are sent to the service.
  const details = await buildBundleDetails(entry.integrity, { name: entry.filename }, { sources: false })
  checkLocal(signal)
  return storedScanBundle(entry, details)
}
