import { managedFetch } from './request.js'
import { getPublicShare, publicShareBootstrapPath } from './public-share.js'
import { reportEntries } from '@preventive/report'
import { MANAGED_PAGES } from '../../common/managed/routes.js'
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
// reads `.csrfToken`). While an admin views as another user, it is that
// user's, with the admin as `viewer`.
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
    ...(typeof body.viewer?.login === 'string' ? { viewer: {
      id: body.viewer.id, login: body.viewer.login, name: typeof body.viewer.name === 'string' ? body.viewer.name : null,
    } } : {}),
  }
}

// The server's App classification of a team's published workspace: App teams
// open collapsed to their findings. An unknown one is left out (expanded).
function teamApp(app) {
  if (app?.appMode === false) return { appMode: false }
  return app?.appMode === true && Number.isSafeInteger(app.appFindings) && app.appFindings >= 0
    ? { appMode: true, appFindings: app.appFindings } : null
}

// The cached details and tags of the commit a bundle records, in the repository
// it is stored at (server-managed/bundle-commits.ts), or null.
function bundleCommitInfo(info) {
  if (typeof info?.sha !== 'string' || typeof info.github !== 'string' || !Array.isArray(info.tags)) return null
  const details = info.details
  const text = value => typeof value === 'string' ? value : null
  const time = value => Number.isSafeInteger(value) ? value : null
  return { sha: info.sha, github: info.github, tags: info.tags.filter(tag => typeof tag === 'string'),
    details: typeof details?.subject === 'string' ? { subject: details.subject, authorName: text(details.authorName),
      authorLogin: text(details.authorLogin), authoredAt: time(details.authoredAt), committedAt: time(details.committedAt) } : null }
}

// GET /api/teams → the signed-in user's teams, each with the reports and bundles
// attached to the team's repos ([{ id, slug, name, reports: [{ id, slug, filename, analyzer, repoFullName, repoDirectory }],
// bundles: [{ id, slug, integrity, filename, byteSize, repoId, repoDirectory, repoFullName, commitInfo }] }]), or [] when
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
      ...(t.permissions ? { permissions: { dependencies: t.permissions.dependencies === true, security: t.permissions.security === true } } : {}),
      ...(typeof t.cacheKey === 'string' ? { cacheKey: t.cacheKey } : {}),
      ...(teamApp(t.app) ? { app: teamApp(t.app) } : {}),
      reports: Array.isArray(t.reports)
        ? t.reports
          .filter((r) => r != null && typeof r.id === 'string' && typeof r.filename === 'string')
          .map((r) => ({ id: r.id, slug: r.slug, filename: r.filename, visible: r.visible !== false,
            ...(r.analyzer === null || typeof r.analyzer === 'string' ? { analyzer: r.analyzer } : {}),
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
            kind: b.kind,
            visible: b.visible !== false,
            summary: b.summary ?? null,
            summaryRetryAt: Number.isSafeInteger(b.summaryRetryAt) && b.summaryRetryAt > 0 ? b.summaryRetryAt : null,
            repoDirectory: typeof b.repoDirectory === 'string' ? b.repoDirectory : '',
            repoFullName: typeof b.repoFullName === 'string' ? b.repoFullName : '',
            commitInfo: bundleCommitInfo(b.commitInfo),
          }))
        : [],
    }))
}

// GET /api/reports/<id> → parsed, filtered data and the authoritative server repo.
// Keep them together so viewing does not depend on a stale sidebar catalogue.
// The caller renders it WITHOUT caching to OPFS. null on failure / no access.
function responseLinks(body) {
  if (body?.links === undefined) return []
  return Array.isArray(body.links) && body.links.every(row => Array.isArray(row) && row.length >= 2 && row.every(id => typeof id === 'string')) ? body.links : null
}
function reportContent(body) {
  if (reportEntries(body?.data) === null || typeof body.repo?.directory !== 'string') return null
  if (body.repo.github !== null && typeof body.repo.github !== 'string') return null
  if (responseLinks(body) === null) return null
  return { data: body.data, repo: body.repo, ...(body.links ? { links: body.links } : {}) }
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
  const links = responseLinks(body)
  if (links === null) return null
  return ids.map(id => ({ ...reports.get(id), ...(links.length > 0 ? { links } : {}) }))
}

// Published report selections keep the full workspace for classification.
// An authorized hidden report opens independently of the published workspace.
export async function fetchTeamReports(teamId, { signal, reportId = null } = {}) {
  const query = reportId === null ? '' : `?reportId=${encodeURIComponent(reportId)}`
  const body = await getJson(`/api/teams/${encodeURIComponent(teamId)}/reports${query}`, null, { signal })
  if (!Array.isArray(body?.reports)) return null
  const reports = [], seen = new Set()
  for (const entry of body.reports) {
    const content = reportContent(entry)
    if (!content || typeof entry.id !== 'string' || typeof entry.filename !== 'string' || seen.has(entry.id)) return null
    seen.add(entry.id)
    reports.push({ id: entry.id, filename: entry.filename, ...content })
  }
  const links = responseLinks(body)
  if (links === null) return null
  Object.defineProperty(reports, 'links', { value: links })
  return reports
}

export function teamQuery(teamId) { return teamId ? `?team=${encodeURIComponent(teamId)}` : '' }

// Keep shared annotation bodies normalized until a consumer asks for one
// report. Projections preserve each report's visibility and server comment order.
export async function fetchTeamAnnotations(teamId, { reportId: selectedReportId, ...options } = {}) {
  const query = selectedReportId == null ? '' : `?reportId=${encodeURIComponent(selectedReportId)}`
  const body = await getJson(`/api/teams/${encodeURIComponent(teamId)}/annotations${query}`, null, options)
  const { reports, entries, comments, issues = {} } = body ?? {}
  if (!reports || typeof reports !== 'object' || Array.isArray(reports)
      || !entries || typeof entries !== 'object' || Array.isArray(entries) || !Array.isArray(comments)
      || !issues || typeof issues !== 'object' || Array.isArray(issues)) return null
  if (Object.values(reports).some(ids => !Array.isArray(ids) || ids.some(id => typeof id !== 'string'))
      || comments.some(comment => !comment || typeof comment.findingId !== 'string')) return null
  const commentIndices = new Map()
  for (const [index, comment] of comments.entries()) {
    const findingId = comment.findingId
    const indices = commentIndices.get(findingId) ?? []
    indices.push(index)
    commentIndices.set(findingId, indices)
  }
  const byFindings = new Map(), byReport = new Map()
  return reportId => {
    if (!Object.hasOwn(reports, reportId)) return null
    if (byReport.has(reportId)) return byReport.get(reportId)
    // Repeated scans can have identical finding references. Share their arrays
    // too, so caching does not recreate the normalized batch's duplication.
    const key = JSON.stringify(reports[reportId])
    let projection = byFindings.get(key)
    if (!projection) {
      const ids = [...new Set(reports[reportId])]
      const indices = ids.flatMap(id => commentIndices.get(id) ?? [])
      projection = {
        entries: Object.fromEntries(ids.filter(id => Object.hasOwn(entries, id)).map(id => [id, entries[id]])),
        comments: indices.toSorted((a, b) => a - b).map(index => comments[index]),
        issues: Object.fromEntries(ids.filter(id => Object.hasOwn(issues, id)).map(id => [id, issues[id]])),
      }
      byFindings.set(key, projection)
    }
    byReport.set(reportId, projection)
    return projection
  }
}

// GET /api/reports/<id>/triage returns this report's visible annotations.
// Null entries are tombstones; absent IDs have never been written. Local
// ignoredReports never rides the wire. A failed or unauthorized read is null.
export async function fetchReportTriage(id, teamId, options) {
  const body = await getJson(`/api/reports/${encodeURIComponent(id)}/triage${teamQuery(teamId)}`, null, options)
  const entries = body?.entries
  return entries != null && typeof entries === 'object' && !Array.isArray(entries) ? entries : null
}

export async function fetchFixes(teamId, signal, reportId = null) {
  if (getPublicShare()) return []
  const query = reportId === null ? '' : `?reportId=${encodeURIComponent(reportId)}`
  const body = await getJson(`/api/teams/${encodeURIComponent(teamId)}/fixes${query}`, null, { signal })
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

// Admins can view the app as another user to check that user's access; the
// server refuses every write meanwhile. Both directions reload into the new
// session so nothing loaded for one account is shown as the other.
export async function viewAs(userId, csrfToken) {
  const res = await managedFetch('/api/auth/view-as', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
    body: JSON.stringify({ userId }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  location.assign('/')
}

// An ended view (its admin session or role is gone) cannot be deleted; the
// reload's session probe clears it instead.
export async function stopViewing(csrfToken) {
  try {
    await managedFetch('/api/auth/view-as', {
      method: 'DELETE', credentials: 'same-origin', headers: csrfToken ? { 'x-csrf-token': csrfToken } : {},
    })
  } catch {}
  location.assign(MANAGED_PAGES['admin-users'])
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
