import { splitMarkdownImport } from '../../common/markdown-import.js'
import { managedFetch } from '../../client/managed/request.js'

// Keep transport setup shared while endpoint-specific validation and messages
// remain next to the operation that owns them.
async function readJson(path, signal) {
  const res = await managedFetch(path, { signal, credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// The CSRF token is sent where there is one, or always (`token`).
function postJson(path, csrfToken, body, { signal, token = Boolean(csrfToken) } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers['x-csrf-token'] = csrfToken
  return managedFetch(path, { method: 'POST', credentials: 'same-origin', ...signal ? { signal } : {}, headers, body: JSON.stringify(body) })
}

async function post(path, csrfToken, body) {
  const res = await postJson(path, csrfToken, body)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res
}

// A JSON endpoint's requests (`path` and a `suffix`), failures named by
// `messages` for the error code the server answers.
export function jsonEndpoint(path, messages) {
  return async (suffix = '', options = {}) => {
    const response = await managedFetch(`${path}${suffix}`, { credentials: 'same-origin', ...options })
    const body = await response.json()
    if (!response.ok) throw new Error(messages[body?.error] ?? `HTTP ${response.status}`)
    return body
  }
}

// A 403 means the team access check refused the location only when the
// server says so. CSRF and origin refusals keep their code, and a 403 without
// one did not come from the managed server's own checks.
async function refusal(res) {
  const code = await res.json().then(body => typeof body?.error === 'string' ? body.error : '', () => '')
  return ['repo-forbidden', 'forbidden'].includes(code) ? 'choose a repository and directory within your team access' : `HTTP 403${code ? `: ${code}` : ''}`
}

async function deleteItem(collection, id, csrfToken) {
  const headers = csrfToken ? { 'x-csrf-token': csrfToken } : {}
  const res = await managedFetch(`/api/admin/${collection}/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin', headers })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

// An upload's raw bytes, its display name in `x-<kind>-filename`; repository,
// directory and analyzer metadata come from the file itself.
function uploadFile(kind, file, csrfToken, contentType) {
  const headers = { 'content-type': contentType, [`x-${kind}-filename`]: encodeURIComponent(file.name) }
  if (csrfToken) headers['x-csrf-token'] = csrfToken
  return managedFetch(`/api/admin/${kind}s`, { method: 'POST', credentials: 'same-origin', headers, body: file })
}

export async function fetchHistory(signal, page, kind, query, repo, actor) {
  const params = new URLSearchParams({ page: String(page), limit: '100', kind, q: query.trim() })
  if (repo) params.set('repo', repo)
  if (actor) params.set('actor', actor)
  const body = await readJson(`/api/admin/history?${params}`, signal)
  if (!Array.isArray(body?.history) || !Number.isSafeInteger(body.total) || body.total < 0
    || !Number.isSafeInteger(body.page) || body.page < 1) throw new Error('No history returned')
  return body
}

export async function fetchUsers(signal) {
  const body = await readJson('/api/admin/users', signal)
  return Array.isArray(body?.users) ? body.users : []
}

export async function setRole(userId, role, csrfToken) {
  await post('/api/admin/set-role', csrfToken, { userId, role })
}

// The connected list is served from stored configuration; discovery runs only
// for the installed/public pickers. Search and organization filters use the full catalogue.
export function fetchRepositories(scope, showAll, refresh, signal) {
  const params = new URLSearchParams({ scope })
  if (scope === 'installed') params.set('showAll', String(showAll))
  if (refresh) params.set('refresh', 'true')
  return readJson(`/api/admin/repositories?${params}`, signal)
}

// Activating verifies access and records the read context; deactivating keeps stored data.
export async function selectRepository(repoId, selected, csrfToken) {
  await post('/api/admin/repositories/select', csrfToken, { repoId, selected })
}

// `required` reviews per version; `since`, the commit whose lockfiles' versions
// need none (or null); `lockfiles` kept as they are where none are given.
export async function setRepositoryDependencyReview(repoId, { enabled, required, since, lockfiles }, csrfToken) {
  const res = await postJson('/api/admin/repositories/dependency-review', csrfToken, { repoId, enabled, required, since, ...lockfiles ? { lockfiles } : {} })
  if (!res.ok) {
    throw new Error(res.status === 400 ? 'Enter 1 to 10 required reviews, the commit as its full 40-character id, and at most 100 lockfiles by their paths in the repository; a stasis.config.json only among those reviewed alone.'
      : `HTTP ${res.status}`)
  }
  return (await res.json()).dependencyReview
}

// The default branch's lockfiles its dependency review reads (`paths`), and
// its stasis.config.json files (`configs`), which it may hold to instead.
export async function fetchRepositoryLockfiles(repoId, signal) {
  const body = await readJson(`/api/admin/repositories/lockfiles?repoId=${encodeURIComponent(repoId)}`, signal)
  return { paths: Array.isArray(body?.lockfiles) ? body.lockfiles.flatMap(one => typeof one?.path === 'string' ? [one.path] : []) : [],
    configs: Array.isArray(body?.configs) ? body.configs.filter(path => typeof path === 'string') : [] }
}

const PUBLIC_REPOSITORY_ERRORS = {
  400: 'Enter a repository as owner/repo or a GitHub repository URL.',
  403: 'You do not have permission to add arbitrary public repositories.',
  404: 'No public repository was found at that address.',
  409: 'Choose a public, non-archived repository.',
}

export async function addPublicRepository(repository, csrfToken) {
  const res = await postJson('/api/admin/repositories/add-public', csrfToken, { repository }, { token: true })
  if (!res.ok) throw new Error(PUBLIC_REPOSITORY_ERRORS[res.status] ?? `GitHub lookup failed (HTTP ${res.status}). Try again.`)
}

export async function fetchRepositoryImpact(repoId, signal) {
  const impact = await readJson(`/api/admin/repositories/impact?repoId=${encodeURIComponent(repoId)}`, signal)
  if (impact?.repoId !== repoId || !Array.isArray(impact.reports) || !Array.isArray(impact.bundles)
      || !Number.isSafeInteger(impact.triageCount) || impact.triageCount < 0) throw new Error('Invalid repository data')
  return impact
}

const CONNECT_APP_ERRORS = {
  'github-app-not-configured': 'The GitHub App is not configured on this server.',
  'repo-identity-changed': 'The repository has changed on GitHub. Refresh and check its connection.',
  'repo-connection-changed': 'The connection or your permissions changed. Refresh and try again.',
  'repo-not-connected': 'This repository is no longer connected.',
  'forbidden': 'Administrator access is required to connect the GitHub App.',
}

export async function connectRepositoryApp(repoId, csrfToken) {
  const res = await postJson('/api/admin/repositories/connect-app', csrfToken, { repoId }, { token: true })
  const data = await res.json()
  if (!res.ok) throw new Error(CONNECT_APP_ERRORS[data.error] ?? `Could not connect the GitHub App (HTTP ${res.status}). Try again.`)
  if (data.connected === true) return data
  if (data.connected !== false || typeof data.installUrl !== 'string' || !/^https:\/\/github\.com\/apps\/[^/?#]+\/installations\/new$/u.test(data.installUrl)) throw new Error('Invalid GitHub installation response.')
  return data
}

export async function removeRepository(repoId, fullName, deleteTriage, csrfToken) {
  return (await post('/api/admin/repositories/remove', csrfToken, { repoId, fullName, acknowledge: true, deleteTriage })).json()
}

export function fetchReports(signal) {
  return readJson('/api/admin/reports', signal)
}

const CREATE_BUNDLE_ERRORS = {
  'unsupported-entries': 'Select JavaScript/TypeScript files (including JSX/TSX) or Solidity files. Stasis cannot mix languages or use JSON or Rust as remote entry points.',
  'bad-conditions': 'Check the export conditions and selected platforms.',
  'metro-conditions': 'Stasis’s Metro preset requires the react-native condition without manual changes.',
  'config-invalid': 'Stasis can’t read the stasis.config.json these entry points are under, build them with the options it sets, or lay out the lockfiles it names. Check it at this revision.',
  'config-mixed': 'Entry points listed in a stasis.config.json are built with its options, alone. Select only those it lists, or only other files.',
  'config-conditions': 'These entry points are listed in stasis.config.json, which sets their options, so they take no conditions. Reload the directory and try again.',
  'config-runs-code': 'stasis.config.json sets an option for these entry points that runs the repository’s code, such as babel. Bundles built here never run it.',
  'config-policy': 'The bundle holds a path or package that stasis.config.json’s allowedPaths, disallowedPaths, allowedModules or disallowedModules refuses, or that its excludeModules excludes.',
  'stasis-lock': 'The build doesn’t agree with the repository’s stasis.lock.json, or stasis.config.json’s lock = frozen needs one that isn’t there. Update it at this revision.',
  'commit-not-own': 'Stasis can’t find this commit in the history of the repository’s branches or tags: it may be a fork’s, which GitHub serves through the repository too. Pick a commit of its default branch, a branch or a tag.',
  'build-lockfile': 'Stasis needs a supported lockfile: pnpm-lock.yaml, yarn.lock (Yarn 1), package-lock.json, or soldeer.lock.',
  'build-scope': 'Your team needs access to the bundle’s project root, including its lockfile and dependencies.',
  'build-busy': 'A bundle is already being built, or the server is busy. Try again shortly.',
  'build-timeout': 'The bundle build timed out. Try a smaller selection or retry.',
  'too-large': 'This bundle exceeds the server’s size limit.',
  'build-memory': 'Building this selection needs more memory than the server gives a build. Select fewer entry points, or build it with stasis github-bundle and upload the bundle.',
  'github-rate-limited': 'GitHub’s API rate limit has been reached. Retry after the limit resets.',
  'github-build-failed': 'Could not fetch the repository from GitHub. Check access and retry.',
  'repository-changed': 'The repository connection changed during the build. Reload and try again.',
  'bundle-conflict': 'This bundle already exists but is outside your current access.',
  'build-failed': 'Stasis could not build this selection. Check that its lockfile is supported and all entry points and imports exist at this commit.',
}

export async function createBundle(input, csrfToken, signal) {
  const res = await postJson('/api/admin/bundles/create', csrfToken, input, { signal, token: true })
  const data = await res.json()
  if (!res.ok) {
    throw new Error(CREATE_BUNDLE_ERRORS[data.error] ?? (res.status === 401 ? 'Sign in again to create a bundle.'
      : res.status === 403 || res.status === 404 ? 'Repository access is required to create this bundle.' : 'Could not create the bundle. Try again.'))
  }
  return data
}

// The server stores the bytes, records the attribution and links the bundle
// the report names. Throws the word the row shows (e.g. 413 → too large).
export async function uploadReport(file, csrfToken) {
  const maxBytes = (await readJson('/api/config')).managed?.uploadMaxBytes?.reports
  if (Number.isSafeInteger(maxBytes) && maxBytes > 0) {
    if (file.size > maxBytes) throw new Error('too large')
  } else if (file.size > 3 * 1024 * 1024) {
    // Without an advertised bound, leave large files on the raw upload path.
    return uploadSingleReport(file, csrfToken)
  }
  const products = splitMarkdownImport(await file.text(), file.name)
  if (!products) return uploadSingleReport(file, csrfToken)
  // One failed product does not stop the others; name every failure after all were tried.
  const failures = [], results = []
  for (const { name, content } of products) {
    try { results.push(await uploadSingleReport(new File([content], name, { type: 'application/json' }), csrfToken)) }
    catch (err) { failures.push(`${name}: ${String(err?.message ?? err)}`) }
  }
  if (failures.length > 0) throw new Error(`${failures.length} of ${products.length} products failed (${failures.join('; ')})`)
  return results.at(-1)
}

async function uploadSingleReport(file, csrfToken) {
  const res = await uploadFile('report', file, csrfToken, file.type || 'application/json')
  if (!res.ok) {
    if (res.status === 413) throw new Error('too large')
    if (res.status === 403) throw new Error(await refusal(res))
    const body = await res.json().catch(() => null)
    if (body?.error === 'storage-encryption-required') throw new Error('Link reports require managed storage encryption. Configure MANAGED_STORAGE_ENCRYPTION_KEY.')
    if (body?.error === 'invalid-report') {
      throw new Error(typeof body.reason === 'string' && body.reason
        ? `This file is not a report: ${body.reason}` : 'This file is not a recognized report.')
    }
    const detail = body?.error === 'repo-not-connected' && typeof body.repo === 'string' ? `: ${body.repo} is not connected` : ''
    throw new Error(`HTTP ${res.status}${detail}`)
  }
  return res.json()
}

export async function setReportVisible(id, visible, csrfToken) {
  await post('/api/admin/reports/set-visible', csrfToken, { reportId: id, visible })
}

// Switch a report to open on Confirmed whatever Confirmed hides, or back to
// the outcome its view works out. Only a report the server offers it for
// (`confirmedOffered`) can be switched on.
export async function setReportOpening(id, confirmedDefault, csrfToken) {
  const res = await postJson('/api/admin/reports/set-opening', csrfToken, { reportId: id, confirmedDefault })
  if (!res.ok) throw new Error(res.status === 409 ? 'this report already opens as an App view, or has no Confirmed findings' : `HTTP ${res.status}`)
}

export async function setReportRepo(id, repoId, directory, csrfToken) {
  const res = await postJson('/api/admin/reports/set-repo', csrfToken, { reportId: id, repoId, directory })
  if (!res.ok) {
    if (res.status === 409) throw new Error('this report already defines its repository')
    if (res.status === 403) throw new Error(await refusal(res))
    throw new Error(res.status === 400 ? 'invalid repository or directory' : `HTTP ${res.status}`)
  }
  return res.json()
}

// A live suggestion for the location editor; only Save assigns a location.
export async function fetchReportLocation(id, signal) {
  const res = await managedFetch(`/api/admin/reports/${encodeURIComponent(id)}/location`, { signal, credentials: 'same-origin' })
  if (!res.ok) throw new Error(`Report location suggestion request failed (${res.status})`)
  return (await res.json())?.location ?? null
}

export function deleteReport(id, csrfToken) {
  return deleteItem('reports', id, csrfToken)
}

export function fetchBundles(signal) {
  return readJson('/api/admin/bundles', signal)
}

// The server content-addresses it (sha512), so identical bytes dedupe, and
// links any reports that declared its integrity.
export async function uploadBundle(file, csrfToken) {
  const res = await uploadFile('bundle', file, csrfToken, 'application/octet-stream')
  if (!res.ok) throw new Error(res.status === 413 ? 'too large' : res.status === 403 ? await refusal(res) : `HTTP ${res.status}`)
  return res.json()
}

// The reports that name a bundle, asked before deleting it: those the caller
// can read (`linked` when their findings show its code), and how many others.
export async function fetchBundleUsage(id, signal) {
  const usage = await readJson(`/api/admin/bundles/${encodeURIComponent(id)}/usage`, signal)
  if (usage?.bundleId !== id || !Array.isArray(usage.reports) || !usage.reports.every(report => typeof report?.filename === 'string')
      || !Number.isSafeInteger(usage.otherReports) || usage.otherReports < 0) throw new Error('Invalid bundle usage')
  return usage
}

export function deleteBundle(id, csrfToken) {
  return deleteItem('bundles', id, csrfToken)
}

export async function setBundleVisible(id, visible, csrfToken) {
  await post('/api/admin/bundles/set-visible', csrfToken, { bundleId: id, visible })
}

// A stored bundle's repository and directory, or detached (null).
export async function setBundleRepo(id, repoId, directory, csrfToken) {
  const res = await postJson('/api/admin/bundles/set-repo', csrfToken, { bundleId: id, repoId, directory })
  if (!res.ok) throw new Error(res.status === 403 ? await refusal(res) : res.status === 400 ? 'invalid repository or directory' : `HTTP ${res.status}`)
}

export function fetchTeams(signal) {
  return readJson('/api/admin/teams', signal)
}

// A team change (`path` under /api/admin/teams); 409 is a duplicate name.
export async function postTeam(path, csrfToken, body) {
  const res = await postJson(`/api/admin/teams${path}`, csrfToken, body)
  if (!res.ok) throw new Error(res.status === 409 ? 'name already taken' : `HTTP ${res.status}`)
}
