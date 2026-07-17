// Managed-mode client auth. Loaded lazily (see ui/view/client-managed.js) so
// this managed-only code stays out of the main view bundle, mirroring
// client/sync. For now it covers the session lifecycle against the managed
// server (server-managed/): probe the current session, hand off to the GitHub
// OAuth login, and log out. Future managed-client features can grow here.

// One same-origin GET → parsed JSON, or null on any failure (network, non-2xx,
// or a malformed body). The single place the probes' fetch policy lives.
async function getJson(url) {
  let res
  try {
    res = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
  } catch { return null }
  if (!res.ok) return null
  try { return await res.json() } catch { return null }
}

// GET /api/auth/session → the signed-in user + CSRF token, or null when the
// request is unauthenticated / fails. The returned shape is what the sidebar
// keeps on `state.managedSession` (renderAuthStatus reads `.login`; logout
// reads `.csrfToken`).
export async function probeSession() {
  const body = await getJson('/api/auth/session')
  const user = body?.user
  if (user == null || typeof user.login !== 'string') return null
  return {
    id: user.id,
    login: user.login,
    name: typeof user.name === 'string' ? user.name : null,
    avatarUrl: typeof user.avatarUrl === 'string' ? user.avatarUrl : null,
    role: typeof user.role === 'string' ? user.role : 'none',
    csrfToken: typeof body.csrfToken === 'string' ? body.csrfToken : null,
  }
}

// GET /api/teams → the signed-in user's teams, each with the reports attached to
// the team's repos ([{ id, name, reports: [{ id, filename }] }]), or [] when
// unauthenticated / on any failure. Kept on `state.managedTeams` and shown in the
// sidebar's per-user Teams section. Never throws, so a probe failure can't break
// the session refresh.
export async function probeTeams() {
  const body = await getJson('/api/teams')
  const teams = body?.teams
  if (!Array.isArray(teams)) return []
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
    }))
}

// GET /api/reports/<id> → a team report's raw text content for in-app viewing.
// The caller renders it WITHOUT caching to OPFS. null on failure / no access.
export async function fetchReport(id) {
  let res
  try {
    res = await fetch(`/api/reports/${encodeURIComponent(id)}`, { credentials: 'same-origin' })
  } catch { return null }
  if (!res.ok) return null
  try { return await res.text() } catch { return null }
}

// GET /api/reports/<id>/triage → the server's per-finding triage entries for a
// team report, as `{ <findingId>: { color?, triage?, comment?, fix?, flagged? } }`
// (already restricted server-side to the findings this viewer may see), or
// null on any failure / no access. `ignoredReports` never rides this wire —
// the per-report ignore stays a client-local concept.
export async function fetchReportTriage(id) {
  const body = await getJson(`/api/reports/${encodeURIComponent(id)}/triage`)
  const entries = body?.entries
  return entries != null && typeof entries === 'object' && !Array.isArray(entries) ? entries : null
}

// POST /api/reports/<id>/triage → push locally-changed triage entries
// (`{ <findingId>: entry | null }`; null clears the server's row), sending the
// double-submit CSRF token the server requires for mutations. Resolves true on
// success, false on any failure (network / auth / validation) — pushes are
// best-effort, the caller retries via its diff on the next change.
export async function pushReportTriage(id, entries, csrfToken) {
  let res
  try {
    res = await fetch(`/api/reports/${encodeURIComponent(id)}/triage`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      },
      body: JSON.stringify({ entries }),
    })
  } catch { return false }
  return res.ok
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
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: csrfToken ? { 'x-csrf-token': csrfToken } : {},
    })
  } catch {}
  location.reload()
}
