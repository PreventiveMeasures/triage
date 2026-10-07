import { splitMarkdownImport } from '../../common/markdown-import.js'
import { managedFetch } from '../../client/managed/request.js'

// Keep transport setup shared while endpoint-specific validation and messages
// remain next to the operation that owns them.
async function readJson(path, signal) {
  const res = await managedFetch(path, { signal, credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function postJson(path, csrfToken, body) {
  const headers = { 'content-type': 'application/json' }
  if (csrfToken) headers['x-csrf-token'] = csrfToken
  return managedFetch(path, { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify(body) })
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
  const res = await postJson('/api/admin/set-role', csrfToken, { userId, role })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

// The connected list is served from stored configuration; discovery runs only
// for the installed/public pickers. Search and organization filters use the full catalogue.
export async function fetchRepositories(scope, showAll, refresh, signal) {
  const params = new URLSearchParams({ scope })
  if (scope === 'installed') params.set('showAll', String(showAll))
  if (refresh) params.set('refresh', 'true')
  return await readJson(`/api/admin/repositories?${params}`, signal)
}

// Toggle whether a repo is active (the server verifies access + records the read
// context when activating, and deactivates without deleting stored data).
export async function selectRepository(repoId, selected, csrfToken) {
  const res = await postJson('/api/admin/repositories/select', csrfToken, { repoId, selected })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

export async function addPublicRepository(repository, csrfToken) {
  const res = await managedFetch('/api/admin/repositories/add-public', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ repository }),
  })
  if (!res.ok) {
    const messages = {
      400: 'Enter a repository as owner/repo or a GitHub repository URL.',
      403: 'You do not have permission to add arbitrary public repositories.',
      404: 'No public repository was found at that address.',
      409: 'Choose a public, non-archived repository.',
    }
    throw new Error(messages[res.status] ?? `GitHub lookup failed (HTTP ${res.status}). Try again.`)
  }
}

export async function fetchRepositoryImpact(repoId, signal) {
  const impact = await readJson(`/api/admin/repositories/impact?repoId=${encodeURIComponent(repoId)}`, signal)
  if (impact?.repoId !== repoId || !Array.isArray(impact.reports) || !Array.isArray(impact.bundles)
      || !Number.isSafeInteger(impact.triageCount) || impact.triageCount < 0) throw new Error('Invalid repository data')
  return impact
}

export async function connectRepositoryApp(repoId, csrfToken) {
  const res = await managedFetch('/api/admin/repositories/connect-app', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ repoId }),
  })
  const data = await res.json()
  if (!res.ok) {
    const messages = {
      'github-app-not-configured': 'The GitHub App is not configured on this server.',
      'repo-identity-changed': 'The repository has changed on GitHub. Refresh and check its connection.',
      'repo-connection-changed': 'The connection or your permissions changed. Refresh and try again.',
      'repo-not-connected': 'This repository is no longer connected.',
      'forbidden': 'Administrator access is required to connect the GitHub App.',
    }
    throw new Error(messages[data.error] ?? `Could not connect the GitHub App (HTTP ${res.status}). Try again.`)
  }
  if (data.connected === true) return data
  if (data.connected !== false || typeof data.installUrl !== 'string' || !/^https:\/\/github\.com\/apps\/[^/?#]+\/installations\/new$/u.test(data.installUrl)) throw new Error('Invalid GitHub installation response.')
  return data
}

export async function removeRepository(repoId, fullName, deleteTriage, csrfToken) {
  const res = await postJson('/api/admin/repositories/remove', csrfToken, { repoId, fullName, acknowledge: true, deleteTriage })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function fetchReports(signal) {
  return await readJson('/api/admin/reports', signal)
}

export async function createBundle(input, csrfToken, signal) {
  const res = await managedFetch('/api/admin/bundles/create', {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(input),
  })
  const data = await res.json()
  if (!res.ok) {
    const messages = {
      'unsupported-entries': 'Select JavaScript/TypeScript files (including JSX/TSX) or Solidity files. Stasis cannot mix languages or use JSON or Rust as remote entry points.',
      'bad-conditions': 'Check the export conditions and selected platforms.',
      'metro-conditions': 'Stasis’s Metro preset requires the react-native condition without manual changes.',
      'build-lockfile': 'Stasis needs a supported lockfile: pnpm-lock.yaml, yarn.lock (Yarn 1), package-lock.json, or soldeer.lock.',
      'build-scope': 'Your team needs access to the bundle’s project root, including its lockfile and dependencies.',
      'build-busy': 'A bundle is already being built, or the server is busy. Try again shortly.',
      'build-timeout': 'The bundle build timed out. Try a smaller selection or retry.',
      'too-large': 'This bundle exceeds the server’s size limit.',
      'github-rate-limited': 'GitHub’s API rate limit has been reached. Retry after the limit resets.',
      'github-build-failed': 'Could not fetch the repository from GitHub. Check access and retry.',
      'repository-changed': 'The repository connection changed during the build. Reload and try again.',
      'bundle-conflict': 'This bundle already exists but is outside your current access.',
      'build-failed': 'Stasis could not build this selection. Check that its lockfile is supported and all entry points and imports exist at this commit.',
    }
    throw new Error(messages[data.error] ?? (res.status === 401 ? 'Sign in again to create a bundle.'
      : res.status === 403 || res.status === 404 ? 'Repository access is required to create this bundle.' : 'Could not create the bundle. Try again.'))
  }
  return data
}

// Upload one report file: the raw bytes as the body and the display name in the
// X-Report-Filename header. Repository, directory, and analyzer metadata come
// from the report header; CSRF rides the double-submit token. The server stores
// the bytes + records the metadata/attribution + auto-links the bundle. Throws
// with the status word the row surfaces (e.g. 413 → too large).
export async function uploadReport(file, csrfToken, repoId = null, directory = '') {
  const maxBytes = (await readJson('/api/config')).managed?.uploadMaxBytes?.reports
  if (Number.isSafeInteger(maxBytes) && maxBytes > 0) {
    if (file.size > maxBytes) throw new Error('too large')
  } else if (file.size > 3 * 1024 * 1024) {
    // Without an advertised bound, leave large files on the raw upload path.
    return uploadSingleReport(file, csrfToken, repoId, directory)
  }
  const products = splitMarkdownImport(await file.text(), file.name)
  if (!products) return uploadSingleReport(file, csrfToken, repoId, directory)
  // One failed product does not stop the others; name every failure after all were tried.
  const failures = [], results = []
  for (const { name, content } of products) {
    try { results.push(await uploadSingleReport(new File([content], name, { type: 'application/json' }), csrfToken, repoId, directory)) }
    catch (err) { failures.push(`${name}: ${String(err?.message ?? err)}`) }
  }
  if (failures.length > 0) throw new Error(`${failures.length} of ${products.length} products failed (${failures.join('; ')})`)
  return results.at(-1)
}

async function uploadSingleReport(file, csrfToken, repoId, directory) {
  const headers = { 'content-type': file.type || 'application/json', 'x-report-filename': encodeURIComponent(file.name) }
  if (csrfToken) headers['x-csrf-token'] = csrfToken
  if (repoId != null) headers['x-repo-id'] = String(repoId)
  if (directory !== '') headers['x-repo-directory'] = encodeURIComponent(directory)
  const res = await managedFetch('/api/admin/reports', { method: 'POST', credentials: 'same-origin', headers, body: file })
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
  const res = await postJson('/api/admin/reports/set-visible', csrfToken, { reportId: id, visible })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
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

export async function deleteReport(id, csrfToken) {
  await deleteItem('reports', id, csrfToken)
}

export async function fetchBundles(signal) {
  return await readJson('/api/admin/bundles', signal)
}

// Upload one bundle file: raw bytes as the body, name in X-Bundle-Filename, an
// optional location in X-Repo-Id / X-Repo-Directory, CSRF token. The server content-addresses it
// (sha512) — re-uploading identical bytes dedupes — and auto-links any reports
// that declared its integrity.
export async function uploadBundle(file, csrfToken, repoId, directory = '') {
  const headers = { 'content-type': 'application/octet-stream', 'x-bundle-filename': encodeURIComponent(file.name) }
  if (csrfToken) headers['x-csrf-token'] = csrfToken
  if (repoId != null) headers['x-repo-id'] = String(repoId)
  if (directory) headers['x-repo-directory'] = encodeURIComponent(directory)
  const res = await managedFetch('/api/admin/bundles', { method: 'POST', credentials: 'same-origin', headers, body: file })
  if (!res.ok) throw new Error(res.status === 413 ? 'too large' : res.status === 403 ? await refusal(res) : `HTTP ${res.status}`)
  return res.json()
}

export async function deleteBundle(id, csrfToken) {
  await deleteItem('bundles', id, csrfToken)
}

export async function setBundleVisible(id, visible, csrfToken) {
  const res = await postJson('/api/admin/bundles/set-visible', csrfToken, { bundleId: id, visible })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

// Set a stored bundle's repository and directory, or detach it (null). CSRF token.
export async function setBundleRepo(id, repoId, directory, csrfToken) {
  const res = await postJson('/api/admin/bundles/set-repo', csrfToken, { bundleId: id, repoId, directory })
  if (!res.ok) throw new Error(res.status === 403 ? await refusal(res) : res.status === 400 ? 'invalid repository or directory' : `HTTP ${res.status}`)
}

export async function fetchTeams(signal) {
  return await readJson('/api/admin/teams', signal)
}

// POST a team mutation (create / delete / link / unlink). CSRF via the
// double-submit token. Surfaces 409 (duplicate name) as a friendly word.
export async function postTeam(path, csrfToken, body) {
  const res = await postJson(path, csrfToken, body)
  if (!res.ok) throw new Error(res.status === 409 ? 'name already taken' : `HTTP ${res.status}`)
}
