import { managedFetch } from './request.js'
// Managed-mode client auth. Loaded lazily (see ui/view/client-managed.js) so
// this managed-only code stays out of the main view bundle, mirroring
// client/sync. For now it covers the session lifecycle against the managed
// server (server-managed/): probe the current session, hand off to the GitHub
// OAuth login, and log out. Future managed-client features can grow here.

// Same-origin JSON, clearing revoked access and retaining an optional cached
// value when a background request fails.
async function getJson(url, fallback = null) {
  let res
  try {
    res = await managedFetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
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
    const res = await managedFetch('/api/auth/session', { credentials: 'same-origin', headers: { accept: 'application/json' } })
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
  }
}

// GET /api/teams → the signed-in user's teams, each with the reports and bundles
// attached to the team's repos ([{ id, name, reports: [{ id, filename }],
// bundles: [{ id, filename, repoFullName }] }]), or [] when
// unauthenticated. A failed background refresh keeps the provided fallback.
// Kept on `state.managedTeams` and shown in the
// sidebar's per-user Teams section. Never throws, so a probe failure can't break
// the session refresh.
export async function probeTeams({ fallback = [] } = {}) {
  const body = await getJson('/api/teams', { teams: fallback })
  const teams = body?.teams
  if (!Array.isArray(teams)) return body == null ? [] : fallback
  return teams
    .filter((t) => t != null && typeof t.id === 'string' && typeof t.name === 'string')
    .map((t) => ({
      id: t.id,
      name: t.name,
      reports: Array.isArray(t.reports)
        ? t.reports
          .filter((r) => r != null && typeof r.id === 'string' && typeof r.filename === 'string')
          .map((r) => ({ id: r.id, filename: r.filename }))
        : [],
      bundles: Array.isArray(t.bundles)
        ? t.bundles
          .filter((b) => b != null && typeof b.id === 'string' && typeof b.filename === 'string')
          .map((b) => ({
            id: b.id,
            filename: b.filename,
            repoFullName: typeof b.repoFullName === 'string' ? b.repoFullName : '',
          }))
        : [],
    }))
}

// GET /api/reports/<id> → filtered text and the authoritative server repo.
// Keep them together so viewing does not depend on a stale sidebar catalogue.
// The caller renders it WITHOUT caching to OPFS. null on failure / no access.
export async function fetchReport(id) {
  const body = await getJson(`/api/reports/${encodeURIComponent(id)}`)
  if (typeof body?.content !== 'string' || typeof body.repo?.directory !== 'string') return null
  if (body.repo.github !== null && typeof body.repo.github !== 'string') return null
  return { content: body.content, repo: body.repo }
}

// GET /api/reports/<id>/triage → the server's triage entries for a team
// report's findings, as `{ <findingId>: { color?, triage?, comment?, fix?,
// flagged? } | null }` — null for an entry cleared server-side (its
// tombstone), an absent id for one the server has never seen — restricted
// server-side to the findings this viewer may see; null on any failure / no
// access. `ignoredReports` never rides this wire — the per-report ignore stays
// a client-local concept.
export async function fetchReportTriage(id) {
  const body = await getJson(`/api/reports/${encodeURIComponent(id)}/triage`)
  const entries = body?.entries
  return entries != null && typeof entries === 'object' && !Array.isArray(entries) ? entries : null
}

export async function fetchPullRequests(urls, csrfToken, signal) {
  try {
    const res = await managedFetch('/api/github/pull-requests', {
      method: 'POST', credentials: 'same-origin', signal,
      headers: { 'content-type': 'application/json', ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) },
      body: JSON.stringify({ urls }),
    })
    if (!res.ok) return null
    const body = await res.json()
    return Array.isArray(body?.pullRequests) ? body.pullRequests : null
  } catch { return null }
}

// POST /api/reports/<id>/triage → push locally-changed triage entries
// (`{ <findingId>: entry | null }`; null clears the server's row), sending the
// double-submit CSRF token the server requires for mutations. Resolves with
// the HTTP status — 0 on a network failure — so the caller can tell a batch
// the server refused as sent (4xx) from one that may land on a retry.
export async function pushReportTriage(id, entries, csrfToken) {
  try {
    const res = await managedFetch(`/api/reports/${encodeURIComponent(id)}/triage`, {
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
  try {
    await managedFetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : {},
    })
  } catch {}
  location.reload()
}
