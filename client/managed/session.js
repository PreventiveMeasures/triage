import { managedFetch } from './request.js'
import { getPublicShare, publicShareBootstrapPath } from './public-share.js'
import { reportEntries } from '../../report/index.js'
// Managed-mode client auth. Loaded lazily (see ui/view/client-managed.js) so
// this managed-only code stays out of the main view bundle, mirroring
// client/sync. For now it covers the session lifecycle against the managed
// server (server-managed/): probe the current session, hand off to the GitHub
// OAuth login, and log out. Future managed-client features can grow here.

// Same-origin JSON, clearing revoked access and retaining an optional cached
// value when a background request fails.
async function getJson(url, fallback = null, options = {}) {
  let res
  try {
    res = await managedFetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' }, ...options })
  } catch { return fallback }
  if (res.status === 401 || res.status === 403) return null
  if (!res.ok) return fallback
  try { return await res.json() } catch { return fallback }
}

// GET /api/auth/session → the signed-in user + CSRF token, or null when the
// request is unauthenticated. A known session can survive transient failures
// during background revalidation. The returned shape is what the sidebar
// keeps on `state.managedSession` (renderAuthStatus reads `.login`; logout
// reads `.csrfToken`).
export async function probeSession({ fallback = null } = {}) {
  let body
  try {
    const share = getPublicShare()
    const res = await managedFetch(share ? publicShareBootstrapPath(share) : '/api/auth/session', { credentials: 'same-origin', headers: { accept: 'application/json' } })
    if (res.status === 401 || res.status === 403) return null
    if (!res.ok) return fallback
    body = await res.json()
  } catch { return fallback }
  const user = body?.user
  if (user === null) return null
  if (user === undefined) return fallback
  if (typeof user.login !== 'string') return fallback
  return {
    id: user.id,
    login: user.login,
    name: typeof user.name === 'string' ? user.name : null,
    avatarUrl: typeof user.avatarUrl === 'string' ? user.avatarUrl : null,
    role: typeof user.role === 'string' ? user.role : 'none',
    csrfToken: typeof body.csrfToken === 'string' ? body.csrfToken : null,
    ...(getPublicShare() ? { publicShare: true } : {}),
  }
}

// GET /api/teams → the signed-in user's teams, each with the reports and bundles
// attached to the team's repos ([{ id, slug, name, reports: [{ id, slug, filename, repoFullName, repoDirectory }],
// bundles: [{ id, slug, integrity, filename, byteSize, repoId, repoDirectory, repoFullName }] }]), or [] when
// unauthenticated. A failed background refresh keeps the provided fallback.
// Kept on `state.managedTeams` and shown in the
// sidebar's per-user Teams section. Never throws, so a probe failure can't break
// the session refresh.
export async function probeTeams({ fallback = [], signal, onRevision } = {}) {
  const share = getPublicShare()
  const shared = share ? await getJson(publicShareBootstrapPath(share), null, { signal }) : null
  const body = share ? { teams: shared?.team ? [shared.team] : [] } : await getJson('/api/teams', { teams: fallback }, { signal })
  const teams = body?.teams
  if (!Array.isArray(teams)) return body == null ? [] : fallback
  onRevision?.(typeof body.revision === 'string' ? body.revision : null)
  return teams
    .filter((t) => t != null && typeof t.id === 'string' && typeof t.name === 'string')
    .map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      ...(typeof t.cacheKey === 'string' ? { cacheKey: t.cacheKey } : {}),
      reports: Array.isArray(t.reports)
        ? t.reports
          .filter((r) => r != null && typeof r.id === 'string' && typeof r.filename === 'string')
          .map((r) => ({ id: r.id, slug: r.slug, filename: r.filename,
            repoFullName: typeof r.repoFullName === 'string' ? r.repoFullName : '',
            repoDirectory: typeof r.repoDirectory === 'string' ? r.repoDirectory : '',
            ...(typeof r.cacheKey === 'string' ? { cacheKey: r.cacheKey } : {}),
          }))
        : [],
      bundles: Array.isArray(t.bundles)
        ? t.bundles
          .filter((b) => b != null && typeof b.id === 'string' && typeof b.filename === 'string')
          .map((b) => ({
            id: b.id,
            slug: b.slug,
            integrity: b.integrity,
            byteSize: b.byteSize,
            repoId: b.repoId,
            filename: b.filename,
            repoDirectory: typeof b.repoDirectory === 'string' ? b.repoDirectory : '',
            repoFullName: typeof b.repoFullName === 'string' ? b.repoFullName : '',
          }))
        : [],
    }))
}

// GET /api/reports/<id> → parsed, filtered data and the authoritative server repo.
// Keep them together so viewing does not depend on a stale sidebar catalogue.
// The caller renders it WITHOUT caching to OPFS. null on failure / no access.
function reportContent(body) {
  if (reportEntries(body?.data) === null || typeof body.repo?.directory !== 'string') return null
  if (body.repo.github !== null && typeof body.repo.github !== 'string') return null
  return { data: body.data, repo: body.repo }
}

export async function fetchReport(id, { signal } = {}) {
  return reportContent(await getJson(`/api/reports/${encodeURIComponent(id)}`, null, { signal }))
}

// One read-only query for the missing reports in a workspace. Validate the
// entire answer before exposing any content; a partial answer is a failure.
export async function fetchReports(ids, { signal } = {}) {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []
  const body = await getJson('/api/reports/query', null, {
    method: 'POST', signal,
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ ids: unique }),
  })
  if (!Array.isArray(body?.reports) || body.reports.length !== unique.length) return null
  const reports = new Map()
  for (const entry of body.reports) {
    const content = reportContent(entry)
    if (!content || !unique.includes(entry.id) || reports.has(entry.id)) return null
    reports.set(entry.id, content)
  }
  return ids.map(id => reports.get(id))
}

// A workspace is selected by team, never by a caller-provided report subset.
export async function fetchTeamReports(teamId, { signal } = {}) {
  const body = await getJson(`/api/teams/${encodeURIComponent(teamId)}/reports`, null, { signal })
  if (!Array.isArray(body?.reports)) return null
  const reports = [], seen = new Set()
  for (const entry of body.reports) {
    const content = reportContent(entry)
    if (!content || typeof entry.id !== 'string' || typeof entry.filename !== 'string' || seen.has(entry.id)) return null
    seen.add(entry.id)
    reports.push({ id: entry.id, filename: entry.filename, ...content })
  }
  return reports
}

export function teamQuery(teamId) { return teamId ? `?team=${encodeURIComponent(teamId)}` : '' }

// GET /api/reports/<id>/triage → the server's triage entries for a team
// report's findings, as `{ <findingId>: { color?, triage?, fix?,
// flagged? } | null }` — null for an entry cleared server-side (its
// tombstone), an absent id for one the server has never seen — restricted
// server-side to the findings this viewer may see; null on any failure / no
// access. `ignoredReports` never rides this wire — the per-report ignore stays
// a client-local concept.
export async function fetchReportTriage(id, teamId, options) {
  const body = await getJson(`/api/reports/${encodeURIComponent(id)}/triage${teamQuery(teamId)}`, null, options)
  const entries = body?.entries
  return entries != null && typeof entries === 'object' && !Array.isArray(entries) ? entries : null
}

export async function fetchFixes(teamId, signal) {
  if (getPublicShare()) return []
  const body = await getJson(`/api/teams/${encodeURIComponent(teamId)}/fixes`, null, { signal })
  return Array.isArray(body?.fixes) ? body.fixes : null
}

export async function fetchReportComments(id, teamId, options) {
  const body = await getJson(`/api/reports/${encodeURIComponent(id)}/comments${teamQuery(teamId)}`, null, options)
  return Array.isArray(body?.comments) ? body.comments : null
}

export async function saveReportComment(reportId, { findingId, body, commentId = null, version }, csrfToken, teamId) {
  const suffix = commentId == null ? '' : `/${encodeURIComponent(commentId)}`
  try {
    const res = await managedFetch(`/api/reports/${encodeURIComponent(reportId)}/comments${suffix}${teamQuery(teamId)}`, {
      method: commentId == null ? 'POST' : 'PATCH',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
      body: JSON.stringify(commentId == null ? { findingId, body } : { body, version }),
    })
    return { status: res.status, comment: res.ok ? (await res.json()).comment : null }
  } catch { return { status: 0, comment: null } }
}

export async function deleteReportComment(reportId, commentId, version, csrfToken, teamId) {
  try {
    const res = await managedFetch(`/api/reports/${encodeURIComponent(reportId)}/comments/${encodeURIComponent(commentId)}${teamQuery(teamId)}`, {
      method: 'DELETE', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
      body: JSON.stringify({ version }),
    })
    return res.status
  } catch { return 0 }
}

// POST /api/reports/<id>/triage → push locally-changed triage entries
// (`{ <findingId>: entry | null }`; null clears the server's row), sending the
// double-submit CSRF token the server requires for mutations. Resolves with
// the HTTP status — 0 on a network failure — so the caller can tell a batch
// the server refused as sent (4xx) from one that may land on a retry.
export async function pushReportTriage(id, entries, csrfToken, teamId) {
  try {
    const res = await managedFetch(`/api/reports/${encodeURIComponent(id)}/triage${teamQuery(teamId)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      },
      body: JSON.stringify({ entries }),
    })
    return res.status
  } catch { return 0 }
}

// Hand off to the server's OAuth entry — a top-level navigation to GitHub and
// back to the app (callback sets the session cookie).
export function login(loginPath) {
  if (loginPath) location.href = loginPath
}

// Clear the server session, sending the double-submit CSRF token the server
// requires for the logout mutation, then reload so the app re-probes and
// repaints logged-out.
export async function logout(csrfToken) {
  if (getPublicShare()) { location.href = '/'; return }
  try {
    await managedFetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : {},
    })
  } catch {}
  location.reload()
}

export async function listWorkspaceShares(teamId) {
  const response = await managedFetch(`/api/teams/${encodeURIComponent(teamId)}/share`, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Could not load public links (${response.status})`)
  return (await response.json()).shares
}

export async function changeWorkspaceShare(teamId, csrfToken, { id, revoke = false, dependencies = false, security = false } = {}) {
  const suffix = id ? `/${encodeURIComponent(id)}` : ''
  const response = await managedFetch(`/api/teams/${encodeURIComponent(teamId)}/share${suffix}`, {
    method: revoke ? 'DELETE' : id ? 'PATCH' : 'POST', credentials: 'same-origin',
    headers: { 'x-csrf-token': csrfToken, 'content-type': 'application/json' },
    ...(revoke ? {} : { body: JSON.stringify({ dependencies, security }) }),
  })
  if (!response.ok) throw new Error(`Could not ${revoke ? 'revoke' : id ? 'update' : 'create'} public link (${response.status})`)
  return response.json()
}

export async function downloadManagedBundle(id, filename) {
  const response = await managedFetch(`/api/bundles/${encodeURIComponent(id)}/download`, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`Could not download bundle (${response.status})`)
  const url = URL.createObjectURL(await response.blob())
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
