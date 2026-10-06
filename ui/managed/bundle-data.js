import { managedFetch } from '../../client/managed/request.js'
import { managedAppState } from './state.js'
import { reportRepoGithub } from '@preventive/report'
import { commonFileDirectory } from '../../common/managed/repository-alias.ts'

export async function fetchManagedBundleCatalog({ signal } = {}) {
  signal = signal ? AbortSignal.any([signal, managedAppState.sessionController.signal]) : managedAppState.sessionController.signal
  signal.throwIfAborted()
  const response = await managedFetch('/api/admin/bundles', { credentials: 'same-origin', signal })
  signal.throwIfAborted()
  if (!response.ok) throw Object.assign(new Error(`Bundle catalogue request failed (${response.status})`), { status: response.status })
  const data = await response.json()
  signal.throwIfAborted()
  return data.bundles ?? []
}

// Metadata may survive navigation in managed app memory. Source bodies belong
// only to the active view; neither is persisted to browser storage.
async function requestBundle(id, part, signal) {
  const generation = managedAppState.generation
  const response = await managedFetch(`/api/bundles/${encodeURIComponent(id)}/${part}`, { credentials: 'same-origin', signal })
  signal?.throwIfAborted()
  if (!response.ok) throw Object.assign(new Error(`Bundle ${part} request failed (${response.status})`), { status: response.status })
  const data = part === 'contents' ? await response.text() : await response.json()
  signal?.throwIfAborted()
  if (generation !== managedAppState.generation) throw new DOMException('Managed session changed', 'AbortError')
  return data
}
export function fetchBundleMetadata(id, { signal } = {}) {
  return managedAppState.load(`bundle-metadata:${id}`, 'bundle metadata', requestSignal => requestBundle(id, 'metadata', requestSignal), { signal, retryInvalidated: true })
}

// The location editor handles failures inline. Its reference read must stop
// with that editor instead of leaving a shared request that can raise a toast.
export async function fetchBundleOrigin(id, { signal } = {}) {
  signal = signal ? AbortSignal.any([signal, managedAppState.sessionController.signal]) : managedAppState.sessionController.signal
  const data = await requestBundle(id, 'metadata', signal)
  const repo = data?.bundle?.repo ?? null
  const github = reportRepoGithub({ repo })
  if (!github) return repo
  const params = new URLSearchParams({ repo: github, directory: repo.directory ?? '' })
  // The metadata already has file paths; resources count, directory captures
  // do not. No source bodies need to be requested to refine this suggestion.
  const unsized = new Set(data.unsized ?? [])
  const filePrefix = commonFileDirectory((data.files ?? []).filter(([path, size]) => size != null || unsized.has(path)).map(([path]) => path))
  if (filePrefix) params.set('filePrefix', filePrefix)
  const response = await managedFetch(`/api/admin/repositories/resolve?${params}`, { credentials: 'same-origin', cache: 'no-store', signal })
  signal.throwIfAborted()
  if (!response.ok) throw new Error(`Repository suggestion request failed (${response.status})`)
  const { location } = await response.json()
  signal.throwIfAborted()
  if (!location) return repo
  return { ...repo, github: location.github, ...(location.mapped ? { directory: location.directory } : {}), repoId: location.repoId }
}

export async function fetchBundleContents(id, { signal } = {}) {
  signal = signal ? AbortSignal.any([signal, managedAppState.sessionController.signal]) : managedAppState.sessionController.signal
  try { return await requestBundle(id, 'contents', signal) }
  catch (err) {
    if (err.name !== 'AbortError') managedAppState.notify(`Couldn't load bundle contents: ${err.message}`)
    throw err
  }
}

// Advisory queries send only the bundle identity; inventory stays server-owned.
export function fetchBundleAdvisories(id, teamId, reason = '', repoAdvisories = false, details = false) {
  const params = [teamId ? `team=${encodeURIComponent(teamId)}` : '', reason ? `reason=${encodeURIComponent(reason)}` : '', repoAdvisories ? 'repoAdvisories=true' : '', details ? 'details=true' : ''].filter(Boolean).join('&')
  const part = `advisories${params ? `?${params}` : ''}`
  return requestBundle(id, part, managedAppState.sessionController.signal)
}
