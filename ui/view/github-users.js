// GitHub logins as the app shows their users. A repository's activity (its
// commits, issues, pull requests, agents and pulse) names GitHub logins; the
// server answers with the app's users among them (server-managed/github-users.ts),
// a linked account's as its user, which are kept here as they come for each
// tab to show by their avatar and the name they chose.
import { html } from 'lit'

const known = new Map()

// Keep the users an answer names (its `users`, by login), whose own logins
// GitHub matches regardless of case; answered as it came.
export function knowGithubUsers(answer) {
  for (const [login, user] of Object.entries(answer?.users ?? {})) {
    if (typeof user?.id === 'string' && typeof user.login === 'string') {
      known.set(login.toLowerCase(), { id: user.id, login: user.login, name: typeof user.name === 'string' && user.name.trim() ? user.name.trim() : null })
    }
  }
  return answer
}

// The app's user signing in with, or having linked, `login`; null for one
// the app does not know.
export const appUser = login => typeof login === 'string' ? known.get(login.toLowerCase()) ?? null : null

// What `login` shows as: its user's name, else their login; else itself.
export function githubUserName(login) {
  const user = appUser(login)
  return user ? user.name ?? user.login : login
}

// Who `login` is, by their user's avatar and name, the login GitHub names in
// its tooltip; `fallback` (the login itself) for one the app does not know.
export function githubUser(login, fallback = login) {
  const user = appUser(login)
  if (!user) return fallback
  return html`<span class="app-user" data-tooltip=${`@${login} on GitHub`}><span class="app-user-avatar" aria-hidden="true">${(user.name ?? user.login)[0].toUpperCase()}<img
    src=${`/api/avatar/${encodeURIComponent(user.id)}`} alt="" loading="lazy" decoding="async" @error=${e => e.currentTarget.remove()}></span><span class="app-user-name">${user.name ?? user.login}</span></span>`
}

// The users `logins` name, each once, in their order: a user's sign-in and
// linked accounts as the one user they are; logins the app does not know as
// themselves.
export function githubUsers(logins) {
  const seen = new Map()
  for (const login of logins) {
    const key = appUser(login)?.id ?? `login:${login.toLowerCase()}`
    if (!seen.has(key)) seen.set(key, login)
  }
  return [...seen.values()]
}
