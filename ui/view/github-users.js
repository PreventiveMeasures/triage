// GitHub logins as the app shows their users. A repository's activity (its
// commits, issues, pull requests, agents and pulse) names GitHub logins; the
// server answers with the app's users among them (server-managed/github-users.ts),
// a linked account's as its user, which are kept here as they come for each
// tab to show by their avatar and the name they chose.
import { html } from 'lit'
import { providerIcon } from './provider-icons.js'

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

// Agents by their own GitHub identities: Claude Code's commits, authored as
// Claude <noreply@anthropic.com>, which GitHub names `claude`, the Claude
// GitHub App's and Codex's; one GitHub names no account for, authored as
// Claude or Codex by name alone. Codex otherwise commits as whoever ran it,
// and those commits are theirs.
const AGENT_LOGINS = new Map([['claude', 'claude'], ['claude[bot]', 'claude'], ['chatgpt-codex-connector[bot]', 'codex']])
const AGENT_NAMES = new Map([['claude', 'claude'], ['codex', 'codex']])
// Each agent's name and mark, as the Agents tab draws it (provider-icons.js).
const AGENTS = { claude: ['Claude', 'anthropic'], codex: ['Codex', 'openai'] }

// The agent that authored a commit, by its author's login and name; null for
// one an agent didn't.
export function commitAgent(login, name = null) {
  if (typeof login === 'string') return AGENT_LOGINS.get(login.toLowerCase()) ?? null
  return typeof name === 'string' ? AGENT_NAMES.get(name.trim().toLowerCase()) ?? null : null
}

// A commit's author as the app shows them: an agent by its bare mark, as the
// Agents tab's header draws it, and its name; a
// user of the app as githubUser does; else `fallback`, their name, else login.
export function commitAuthor(login, name = null, fallback = name ?? login ?? '') {
  const agent = commitAgent(login, name)
  if (!agent) return githubUser(login, fallback)
  const [title, mark] = AGENTS[agent]
  return html`<span class="app-user" data-tooltip=${login ? `@${login} on GitHub` : name}><span class=${`app-user-mark is-${agent}`}
    aria-hidden="true">${providerIcon(mark)}</span><span class="app-user-name">${title}</span></span>`
}

// What a commit's author shows as, in words.
export function commitAuthorName(login, name = null) {
  const agent = commitAgent(login, name)
  return agent ? AGENTS[agent][0] : login ? githubUserName(login) : name
}
