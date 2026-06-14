// Managed-mode client auth. Loaded lazily (see ui/view/client-managed.js) so
// this managed-only code stays out of the main view bundle, mirroring
// client/sync. For now it covers the session lifecycle against the managed
// server (server-managed/): probe the current session, hand off to the GitHub
// OAuth login, and log out. Future managed-client features can grow here.

// GET /api/auth/session → the signed-in user + CSRF token, or null when the
// request is unauthenticated / fails. The returned shape is what the sidebar
// keeps on `state.managedSession` (renderAuthStatus reads `.login`; logout
// reads `.csrfToken`).
export async function probeSession() {
  let res
  try {
    res = await fetch('/api/auth/session', { credentials: 'same-origin', headers: { accept: 'application/json' } })
  } catch { return null }
  if (!res.ok) return null
  let body
  try { body = await res.json() } catch { return null }
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
