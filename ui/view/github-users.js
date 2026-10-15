// GitHub accounts as the app shows them. A repository's activity (its
// commits, issues, pull requests, agents and pulse) names GitHub accounts;
// the server answers with the app's users and agents among them
// (server-managed/github-users.ts), a linked account's as its user, which are
// kept here as they come for each tab to show, a user by their avatar and the
// name they chose, an agent as the Agents tab draws it, for the session they
// came to.
import { html } from 'lit'
import { GITHUB_AGENTS, githubAgent } from '../../common/managed/github-agents.ts'
import { namedAccounts } from '../../common/managed/github-logins.ts'
import { providerIcon } from './provider-icons.js'

// By login, lowercased: a user (`id`, `login`, `name`) or an agent (`agent`).
const known = new Map()
// The account id answers name each login by, lowercased; those they name by
// more than one, as what was kept of a repository's history may name a login
// by an account GitHub named by it once, are no one's.
const accounts = new Map()
const ambiguous = new Set()

// Keep what an answer says of each login it names, GitHub matching them
// regardless of case: its user or agent (`users`, by login), or none, one
// unlinked, whose user lost access or that another user claims since, or one
// this session's answers name by more than one account; answered as it came.
export function knowGithubUsers(answer) {
  const { users: told, ...rest } = answer ?? {}
  const users = told ?? {}
  for (const [login, id] of namedAccounts(rest)) {
    const key = login.toLowerCase()
    if (id === 'ambiguous' || (id !== null && accounts.has(key) && accounts.get(key) !== id)) ambiguous.add(key)
    else if (id !== null) accounts.set(key, id)
    if (!Object.hasOwn(users, login) || ambiguous.has(key)) known.delete(key)
  }
  for (const [login, user] of Object.entries(users)) {
    if (ambiguous.has(login.toLowerCase())) continue
    if (typeof user?.agent === 'string' && Object.hasOwn(GITHUB_AGENTS, user.agent)) known.set(login.toLowerCase(), { agent: user.agent })
    else if (typeof user?.id === 'string' && typeof user.login === 'string') {
      known.set(login.toLowerCase(), { id: user.id, login: user.login, name: typeof user.name === 'string' && user.name.trim() ? user.name.trim() : null })
    } else known.delete(login.toLowerCase())
  }
  return answer
}

// Forget them all, for another session, whose answers say who they are.
let generation = 0
export function forgetGithubUsers() {
  known.clear()
  accounts.clear()
  ambiguous.clear()
  unlinked.clear()
  unlinkedIds.clear()
  generation++
}

// What `read` answers, its users kept as knowGithubUsers keeps them, unless
// they were forgotten while it was read: it was another session's. A profile
// change saved while it was read is newer than what it says of that user.
export async function knowingGithubUsers(read) {
  const at = generation, changes = profileChanges
  const answer = await read()
  if (at !== generation) return answer
  knowGithubUsers(answer)
  if (changes !== profileChanges) applyProfile(latestProfile.userId, latestProfile.profile)
  return answer
}

// How many times each user changed their avatar in this page: their avatar's
// address changes with it, as the page would show its image as first loaded.
const avatarRevisions = new Map()

// The signed-in user's latest profile change in this page, and how many;
// the accounts they unlinked in it, by login, lowercased, and GitHub id.
let latestProfile = null
let profileChanges = 0
const unlinked = new Set()
const unlinkedIds = new Set()

// The signed-in user (`userId`) changed their profile in this session, as
// `profile` now is: what was kept of them takes it, before an answer kept a
// while is asked again, under every login of theirs, those they signed in
// or linked with before renaming on GitHub among them (the server knows them
// by their account's id). The account they unlinked (`unlinkedAccount`, its
// login and GitHub id) is no longer theirs, by any login this session's
// answers named it by.
export function knowProfile(userId, profile, avatarChanged = false, unlinkedAccount = null) {
  if (avatarChanged) avatarRevisions.set(userId, (avatarRevisions.get(userId) ?? 0) + 1)
  if (unlinkedAccount) unlinked.add(unlinkedAccount.login.toLowerCase())
  if (Number.isSafeInteger(unlinkedAccount?.githubId)) unlinkedIds.add(unlinkedAccount.githubId)
  latestProfile = { userId, profile }
  profileChanges++
  applyProfile(userId, profile)
}

function applyProfile(userId, profile) {
  for (const [login, user] of known) {
    if (user.id !== userId) continue
    if (unlinked.has(login) || unlinkedIds.has(accounts.get(login))) known.delete(login)
    else known.set(login, { ...user, login: profile.login, name: profile.name?.trim() || null })
  }
}

// The app's user signing in with, or having linked, `login`; null for one
// the app does not know.
export function appUser(login) {
  const user = typeof login === 'string' ? known.get(login.toLowerCase()) : null
  return user?.id ? user : null
}

// The agent `login` is, as the server answered (by its login, its account's
// id confirming it where named); null for anyone else.
const accountAgent = login => known.get(login.toLowerCase())?.agent ?? null

// An agent as the Agents tab draws it, its mark or avatar bare, and its name.
function agentBadge(agent, tooltip) {
  const { name, mark, avatar } = GITHUB_AGENTS[agent]
  return html`<span class="app-user" data-tooltip=${tooltip}><span class=${`app-user-mark is-${agent}`} aria-hidden="true">${mark ? providerIcon(mark)
    : html`<img src=${`/api/avatar/${avatar}`} alt="" loading="lazy" decoding="async" @error=${e => e.currentTarget.remove()}>`}</span><span
    class="app-user-name">${name}</span></span>`
}

// What `login` shows as: its agent's or user's name, else their login; else
// itself.
export function githubUserName(login) {
  const agent = typeof login === 'string' ? accountAgent(login) : null
  if (agent) return GITHUB_AGENTS[agent].name
  const user = appUser(login)
  return user ? user.name ?? user.login : login
}

// Who `login` is: an agent as the Agents tab draws it; a user by their avatar
// and name; the login GitHub names in its tooltip. `fallback` (the login
// itself) for one the app does not know.
export function githubUser(login, fallback = login) {
  const agent = typeof login === 'string' ? accountAgent(login) : null
  if (agent) return agentBadge(agent, `@${login} on GitHub`)
  const user = appUser(login)
  if (!user) return fallback
  return html`<span class="app-user" data-tooltip=${`@${login} on GitHub`}><span class="app-user-avatar" aria-hidden="true">${(user.name ?? user.login)[0].toUpperCase()}<img
    src=${`/api/avatar/${encodeURIComponent(user.id)}${avatarRevisions.has(user.id) ? `?v=${avatarRevisions.get(user.id)}` : ''}`} alt="" loading="lazy" decoding="async" @error=${e => e.currentTarget.remove()}></span><span class="app-user-name">${user.name ?? user.login}</span></span>`
}

// The users `logins` name, each once, in their order: a user's sign-in and
// linked accounts as the one user they are, an agent's accounts as it;
// logins the app does not know as themselves.
export function githubUsers(logins) {
  const seen = new Map()
  for (const login of logins) {
    const agent = accountAgent(login)
    const key = agent ? `agent:${agent}` : appUser(login)?.id ?? `login:${login.toLowerCase()}`
    if (!seen.has(key)) seen.set(key, login)
  }
  return [...seen.values()]
}

// The agent that authored a commit, by its author's account (accountAgent),
// else, for one GitHub names no account for, by the name it carries
// (common/managed/github-agents.ts); null for one an agent didn't.
export function commitAgent(login, name = null) {
  return typeof login === 'string' ? accountAgent(login) : githubAgent(null, null, name)
}

// A commit's author as the app shows them: an agent as the Agents tab draws
// it; a user of the app as githubUser does; else `fallback`, their name, else
// login.
export function commitAuthor(login, name = null, fallback = name ?? login ?? '') {
  if (typeof login === 'string') return githubUser(login, fallback)
  const agent = commitAgent(null, name)
  return agent ? agentBadge(agent, name) : fallback
}

// What a commit's author shows as, in words.
export function commitAuthorName(login, name = null) {
  if (typeof login === 'string') return githubUserName(login)
  const agent = commitAgent(null, name)
  return agent ? GITHUB_AGENTS[agent].name : name
}
