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

// GET /api/teams → the signed-in user's team memberships ([{ id, name }]), or
// [] when unauthenticated / on any failure. Kept on `state.managedTeams` and
// shown in the sidebar's per-user Teams section (above Workspaces). Never
// throws, so a probe failure can't break the session refresh.
export async function probeTeams() {
  const body = await getJson('/api/teams')
  const teams = body?.teams
  if (!Array.isArray(teams)) return []
  return teams
    .filter((t) => t != null && typeof t.id === 'string' && typeof t.name === 'string')
    .map((t) => ({ id: t.id, name: t.name }))
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
