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

const NPM_ERRORS = {
  400: 'Not an npm package name and version.',
  404: 'No such package version, or it is not available to you.',
  413: 'This package is too large to open here.',
  429: 'Too many packages are loading. Try again shortly.',
  502: "The npm registry couldn't be reached.",
}

// A read that a session change aborts, its failures named by `errors`, by
// their error code or else their status.
async function request(url, errors, read, signal) {
  signal = signal ? AbortSignal.any([signal, managedAppState.sessionController.signal]) : managedAppState.sessionController.signal
  const generation = managedAppState.generation
  const response = await managedFetch(url, { credentials: 'same-origin', signal })
  signal.throwIfAborted()
  if (!response.ok) {
    const code = (await response.json().catch(() => null))?.error ?? null
    throw Object.assign(new Error(errors[code] ?? errors[response.status] ?? `Request failed (${response.status})`), { status: response.status, code })
  }
  const data = await read(response)
  signal.throwIfAborted()
  if (generation !== managedAppState.generation) throw new DOMException('Managed session changed', 'AbortError')
  return data
}

// npm package reads are never kept: the server checks access, against the
// registry, on every one.
const requestNpm = (part, params, signal) => request(`/api/npm/${part}?${new URLSearchParams(params)}`, NPM_ERRORS, response => response.json(), signal)

export function fetchNpmPackage(name, version, { signal } = {}) {
  return requestNpm('package', { name, version }, signal)
}

export function fetchNpmVersions(name, { signal } = {}) {
  return requestNpm('versions', { name }, signal)
}

export function fetchNpmStats(name, { signal } = {}) {
  return requestNpm('stats', { name }, signal)
}

// Its commas as they are, not `%2C`: the request line is what a long list
// is bound by (npm-overview.js askDownloadCounts).
export function fetchNpmDownloadCounts(names, { signal } = {}) {
  return request(`/api/npm/download-counts?names=${names.map(encodeURIComponent).join(',')}`, NPM_ERRORS, response => response.json(), signal)
}

export function fetchNpmAdvisories(name, { signal } = {}) {
  return requestNpm('advisories', { name }, signal)
}

export function fetchNpmTags(name, version, { signal } = {}) {
  return requestNpm('tags', { name, version }, signal)
}

export function fetchNpmSocket(name, version, { signal } = {}) {
  return requestNpm('socket', { name, version }, signal)
}

export function fetchNpmProvenance(name, version, { signal } = {}) {
  return requestNpm('provenance', { name, version }, signal)
}

const PRETTY_ERRORS = {
  404: 'This file is no longer available.',
  409: 'This file has changed since it was opened.',
  413: 'This file is too large to pretty-print.',
  422: "This file couldn't be read as code.",
  'pretty-mismatch': 'Pretty-printing would change more than its layout, so it is shown as published.',
  unsupported: "This kind of file can't be checked once pretty-printed, so it is shown as published.",
  429: 'Too many files are being pretty-printed. Try again shortly.',
  502: "The npm registry couldn't be reached.",
}

// A file pretty-printed by the server, which keeps the copy; the viewer
// keeps it only while the file is open (pretty-source.js). `{ text, source }`,
// `source` the hash of the file the server formatted it from, as it names it.
const requestPretty = (url, signal) => request(url, PRETTY_ERRORS, async response => ({ text: await response.text(), source: response.headers.get('x-source-hash') }), signal)

export function fetchPrettyBundleFile(id, path, hash, { signal } = {}) {
  return requestPretty(`/api/bundles/${encodeURIComponent(id)}/pretty?${new URLSearchParams({ path, hash })}`, signal)
}

export function fetchPrettyNpmFile(name, version, path, hash, { signal } = {}) {
  return requestPretty(`/api/npm/pretty?${new URLSearchParams({ name, version, path, hash })}`, signal)
}

const RENAME_DIFF_ERRORS = {
  ...PRETTY_ERRORS,
  413: 'This file is too large to compare with renamed names hidden.',
  422: "This file couldn't be compared as code.",
  'diff-busy': 'Too many files are being compared. Try again shortly.',
  504: 'Comparing this file took too long.',
}

// A JavaScript file diffed by the server with one of another bundle or
// version, both pretty-printed, renamed names hidden: its change blocks and
// the removed lines left out as renamed (rename-diff.js). `params` name both
// files, a base's `path` and `hash`, the other's `otherPath` and `otherHash`.
const requestRenameDiff = (url, signal) => request(url, RENAME_DIFF_ERRORS, response => response.json(), signal)

export function fetchBundleRenameDiff(id, other, { path, hash, otherPath, otherHash, ignoreWhitespace }, { signal } = {}) {
  const params = new URLSearchParams({ path, hash, other, otherPath, otherHash, ignoreWhitespace: String(ignoreWhitespace) })
  return requestRenameDiff(`/api/bundles/${encodeURIComponent(id)}/rename-diff?${params}`, signal)
}

export function fetchNpmRenameDiff(name, version, otherVersion, { path, hash, otherPath, otherHash, ignoreWhitespace }, { signal } = {}) {
  const params = new URLSearchParams({ name, version, path, hash, otherVersion, otherPath, otherHash, ignoreWhitespace: String(ignoreWhitespace) })
  return requestRenameDiff(`/api/npm/rename-diff?${params}`, signal)
}
