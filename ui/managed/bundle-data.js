import { managedFetch } from '../../client/managed/request.js'
import { managedAppState } from './state.js'

// Metadata may survive navigation in managed app memory. Source bodies belong
// only to the active view; neither is persisted to browser storage.
async function requestBundle(id, part, signal) {
  const generation = managedAppState.generation
  const response = await managedFetch(`/api/bundles/${encodeURIComponent(id)}/${part}`, { credentials: 'same-origin', signal })
  if (!response.ok) throw new Error(`Bundle ${part} request failed (${response.status})`)
  const data = part === 'metadata' ? await response.json() : await response.text()
  signal?.throwIfAborted()
  if (generation !== managedAppState.generation) throw new DOMException('Managed session changed', 'AbortError')
  return data
}
export function fetchBundleMetadata(id, { signal } = {}) {
  return managedAppState.load(`bundle-metadata:${id}`, 'bundle metadata', requestSignal => requestBundle(id, 'metadata', requestSignal), { signal })
}
export async function fetchBundleContents(id, { signal } = {}) {
  signal = signal ? AbortSignal.any([signal, managedAppState.sessionController.signal]) : managedAppState.sessionController.signal
  try { return await requestBundle(id, 'contents', signal) }
  catch (err) {
    if (err.name !== 'AbortError') managedAppState.notify(`Couldn't load bundle contents: ${err.message}`)
    throw err
  }
}
