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
export async function request(url, errors, read, signal) {
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

const REPOSITORY_CODE_ERRORS = {
  'no-repository': 'This repository is not available to you.',
  'no-directory': 'This directory is not at that commit, or not available to you.',
  'directory-too-large': 'This directory is too large to open here. Open one of its directories instead.',
  'repository-busy': 'Too many directories and packages are loading. Try again shortly.',
  'repository-changed': 'The repository changed while it was read. Try again.',
  'github-rate-limited': 'GitHub’s API rate limit has been reached. Try again later.',
  'github-unauthorized': 'GitHub authentication has expired or was revoked. Sign in again.',
  'github-status-403': 'GitHub denied this request. Check repository access and the GitHub App’s read permissions.',
  'github-malformed': 'GitHub’s archive of this directory could not be verified against its commit.',
  'github-unreachable': 'Could not connect to GitHub. Try again shortly.',
  400: 'Not a repository directory and commit.',
  403: 'Repository access is required to read its files.',
  404: 'This repository, commit or directory is unavailable.',
  413: 'This directory is too large to open here.',
  429: 'Too many directories and packages are loading. Try again shortly.',
  502: 'GitHub couldn’t be reached.',
}

// A repository's directory at a commit, for the code viewer: never kept, as
// the server checks access, against GitHub, on every read.
export function fetchRepositoryCode(repoId, commit, path, { signal } = {}) {
  return request(`/api/admin/repositories/code?${new URLSearchParams({ repoId, ref: commit, path })}`, REPOSITORY_CODE_ERRORS, response => response.json(), signal)
}

export function fetchNpmPackage(name, version, { signal } = {}) {
  return requestNpm('package', { name, version }, signal)
}

export function fetchNpmVersions(name, { signal } = {}) {
  return requestNpm('versions', { name }, signal)
}

export function fetchNpmStats(name, { signal } = {}) {
  return requestNpm('stats', { name }, signal)
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

// What calls for a look at a version, against `otherVersion` where given, as
// the server's risk tells it (server-managed/npm-risk.ts): the viewer reads
// risk from here alone, telling none of it itself.
export function fetchNpmRisk(name, version, otherVersion = null, { signal } = {}) {
  return requestNpm('risk', { name, version, ...otherVersion === null ? {} : { otherVersion } }, signal)
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

// A bundle's file pretty-printed by the server, which keeps the copy; the
// viewer keeps it only while the file is open (pretty-source.js).
// `{ text, source }`, `source` the hash of the file the server formatted it
// from, as it names it.
export function fetchPrettyBundleFile(id, path, hash, { signal } = {}) {
  return request(`/api/bundles/${encodeURIComponent(id)}/pretty?${new URLSearchParams({ path, hash })}`, PRETTY_ERRORS, prettyFile, signal)
}

// One of an npm version's files pretty-printed, as a bundle's is.
export function fetchPrettyNpmFile(name, version, path, hash, { signal } = {}) {
  return request(`/api/npm/pretty?${new URLSearchParams({ name, version, path, hash })}`, { ...NPM_ERRORS, ...PRETTY_ERRORS }, prettyFile, signal)
}

const prettyFile = async response => ({ text: await response.text(), source: response.headers.get('x-source-hash') })

// A response's lines of JSON, as the server sends them (http.ts sendLines),
// each as it comes.
export async function* responseLines(response) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  // The line being read, in the chunks it came in.
  let parts = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    let start = 0
    for (let end = value.indexOf('\n'); end !== -1; start = end + 1, end = value.indexOf('\n', start)) {
      parts.push(value.slice(start, end))
      yield JSON.parse(parts.join(''))
      parts = []
    }
    parts.push(value.slice(start))
  }
}

// Every file of an npm version that needs pretty-printing, pretty-printed by
// the server in one request, which keeps the copies of a public one: `onLine`
// called with each as it comes, in path order, `{ path, source, text }`, or
// `{ path, source, status, message }` where it has none, `source` as above.
// Resolves once the server sent them all; refused as the version's files are.
export function fetchPrettyNpmFiles(name, version, onLine, { signal } = {}) {
  return requestPrettyLines(`/api/npm/pretty?${new URLSearchParams({ name, version })}`, NPM_ERRORS, onLine, signal)
}

// The files that changed between two bundles, or two versions of a package,
// both sides' pretty-printed by the server in one request, those it kept
// first: `onLine` called with each as it comes, as above, with the `side` it
// is of, `base` (the one asked about) or `other`.
export function fetchPrettyBundleChanges(id, other, onLine, { signal } = {}) {
  return requestPrettyLines(`/api/bundles/${encodeURIComponent(id)}/pretty?${new URLSearchParams({ other })}`, PRETTY_ERRORS, onLine, signal)
}

export function fetchPrettyNpmChanges(name, version, otherVersion, onLine, { signal } = {}) {
  return requestPrettyLines(`/api/npm/pretty?${new URLSearchParams({ name, version, otherVersion })}`, NPM_ERRORS, onLine, signal)
}

// Pretty-printed files' lines, each told to `onLine` as it comes, a failed
// one's error told as `message`, as `told` names it; refused as `errors` name it.
function requestPrettyLines(url, errors, onLine, signal, told = PRETTY_ERRORS) {
  return request(url, errors, async response => {
    const generation = managedAppState.generation
    for await (const { error, status, ...line } of responseLines(response)) {
      if (generation !== managedAppState.generation) throw new DOMException('Managed session changed', 'AbortError')
      await onLine(error ? { ...line, status, message: told[error] ?? told[status] ?? `Request failed (${status})` } : line)
    }
  }, signal)
}

const RENAME_DIFF_ERRORS = {
  ...PRETTY_ERRORS,
  413: 'This file is too large to compare with renamed names hidden.',
  422: "This file couldn't be compared as code.",
  'diff-busy': 'Too many files are being compared. Try again shortly.',
  504: 'Comparing this file took too long.',
}

// A JavaScript file diffed by the server with one of another bundle or
// version, both pretty-printed, renamed names hidden, whitespace changes shown
// and hidden: its change blocks and the removed lines left out as renamed
// (rename-diff.js). `params` name both files, a base's `path` and `hash`, the
// other's `otherPath` and `otherHash`.
const requestRenameDiff = (url, signal) => request(url, RENAME_DIFF_ERRORS, response => response.json(), signal)

export function fetchBundleRenameDiff(id, other, { path, hash, otherPath, otherHash }, { signal } = {}) {
  return requestRenameDiff(`/api/bundles/${encodeURIComponent(id)}/rename-diff?${new URLSearchParams({ path, hash, other, otherPath, otherHash })}`, signal)
}

export function fetchNpmRenameDiff(name, version, otherVersion, { path, hash, otherPath, otherHash }, { signal } = {}) {
  return requestRenameDiff(`/api/npm/rename-diff?${new URLSearchParams({ name, version, path, hash, otherVersion, otherPath, otherHash })}`, signal)
}

// Every pair of JavaScript files two bundles, or two versions of a package,
// are diffed by so, in one request: `onLine` called with each as it is worked
// out, in path order, the answer for one asked about alone with both files'
// paths, or `{ path, hash, otherPath, otherHash, status, message }` where it
// has none. Two bundles' within a reason `scope` where given.
const scoped = (other, scope) => new URLSearchParams({ other, ...scope ? { scope } : {} })

export function fetchBundleRenameDiffs(id, other, onLine, { signal, scope = '' } = {}) {
  return requestPrettyLines(`/api/bundles/${encodeURIComponent(id)}/rename-diff?${scoped(other, scope)}`, PRETTY_ERRORS, onLine, signal, RENAME_DIFF_ERRORS)
}

export function fetchNpmRenameDiffs(name, version, otherVersion, onLine, { signal } = {}) {
  return requestPrettyLines(`/api/npm/rename-diff?${new URLSearchParams({ name, version, otherVersion })}`, NPM_ERRORS, onLine, signal, RENAME_DIFF_ERRORS)
}

// The files that changed between two bundles, or two versions of a package,
// in types alone, as the server proves them (@preventive/compare's
// compareTrees `typeOnly`), in one request: `onLine` called with each, `{
// path, hash, otherPath, otherHash }`, a side not there null; two bundles'
// within a reason `scope` where given.
export function fetchBundleTypeOnly(id, other, onLine, { signal, scope = '' } = {}) {
  return requestPrettyLines(`/api/bundles/${encodeURIComponent(id)}/type-only?${scoped(other, scope)}`, PRETTY_ERRORS, onLine, signal)
}

export function fetchNpmTypeOnly(name, version, otherVersion, onLine, { signal } = {}) {
  return requestPrettyLines(`/api/npm/type-only?${new URLSearchParams({ name, version, otherVersion })}`, NPM_ERRORS, onLine, signal)
}

const COMPARISON_ERRORS = {
  404: 'This bundle is no longer available.',
  422: "This bundle couldn't be read.",
  429: 'Too many bundles are being compared. Try again shortly.',
}

// A comparison as the server works it out (server-managed/comparison.ts), its
// files paired as Compare and Review read them: the viewer pairs none of a
// managed bundle's or a package's itself. Its `files.basePaths` a Map again.
const readComparison = async response => {
  const comparison = await response.json()
  comparison.files.basePaths = new Map(comparison.files.basePaths)
  return comparison
}

// Two bundles', the one `id` names the base, within a reason `scope` where given.
export function fetchBundleComparison(id, other, { signal, scope = '' } = {}) {
  return request(`/api/bundles/${encodeURIComponent(id)}/comparison?${scoped(other, scope)}`, COMPARISON_ERRORS, readComparison, signal)
}

// Two versions' of a package: `version` the one shown, compared with
// `otherVersion`, of `otherName` where another package's, or with none as `(empty)`.
export function fetchNpmComparison(name, version, otherVersion, { signal, otherName = name } = {}) {
  const params = new URLSearchParams({ name, version, otherVersion, ...otherName === name ? {} : { otherName } })
  return request(`/api/npm/comparison?${params}`, NPM_ERRORS, readComparison, signal)
}
