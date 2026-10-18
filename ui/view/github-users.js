// GitHub accounts as the app shows them. A repository's activity (its
// commits, issues, pull requests, agents and pulse) names GitHub accounts;
// the server answers with the app's users and agents among them
// (server-managed/github-users.ts), a linked account's as its user, which are
// kept here as they come for each tab to show, a user by their avatar and the
// name they chose, an agent as the Agents tab draws it, for the session they
// came to.
import { html, nothing } from 'lit'
import { GITHUB_AGENTS, githubAgent, oneAgent } from '../../common/managed/github-agents.ts'
import { namedAccounts } from '../../common/managed/github-logins.ts'
import { providerIcon } from './provider-icons.js'

// By login, lowercased: a user (`id`, `login`, `name`) or an agent (`agent`).
const known = new Map()
// The account id answers name each login by, lowercased; those they name by
// more than one, as what was kept of a repository's history may name a login
// by an account GitHub named by it once, are no one's, unless those are all
// one agent's (oneAgent).
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
    if (id === 'ambiguous' || (id !== null && accounts.has(key) && accounts.get(key) !== id && !oneAgent(login, [id, accounts.get(key)]))) ambiguous.add(key)
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

// An account unlinked by the id answers named its login by, else by its
// login: one that another account of theirs had before is still theirs.
function applyProfile(userId, profile) {
  for (const [login, user] of known) {
    if (user.id !== userId) continue
    if (accounts.has(login) ? unlinkedIds.has(accounts.get(login)) : unlinked.has(login)) known.delete(login)
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

// An image the server serves at `src`, gone where it fails to load.
const avatarImage = src => html`<img src=${src} alt="" loading="lazy" decoding="async" @error=${e => e.currentTarget.remove()}>`
// A user's avatar, as they chose it, the address changing with it.
const userImage = user => avatarImage(`/api/avatar/${encodeURIComponent(user.id)}${avatarRevisions.has(user.id) ? `?v=${avatarRevisions.get(user.id)}` : ''}`)

// An agent as the Agents tab draws it, its mark or avatar bare, and its name;
// one the app has neither of by its name's letter, on a disc.
function agentBadge(agent, tooltip) {
  const { name, mark, avatar } = GITHUB_AGENTS[agent]
  return html`<span class="app-user" data-tooltip=${tooltip}>${mark || avatar ? html`<span class=${`app-user-mark is-${agent}`} aria-hidden="true">${mark
    ? providerIcon(mark) : avatarImage(`/api/avatar/${avatar}`)}</span>` : html`<span class="app-user-avatar" aria-hidden="true">${name[0]}</span>`}<span
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
  return html`<span class="app-user" data-tooltip=${`@${login} on GitHub`}><span class="app-user-avatar" aria-hidden="true">${(user.name ?? user.login)[0].toUpperCase()}${
    userImage(user)}</span><span class="app-user-name">${user.name ?? user.login}</span></span>`
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

const MAX_COAUTHORS = 3
const agentOf = agent => typeof agent === 'string' && Object.hasOwn(GITHUB_AGENTS, agent) ? agent : null
const listed = names => names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? ''

// One who made a commit, on a disc in Commits' stack of them: an agent by its
// mark, solid as its app's icon is (app-user.css), or avatar, one the app
// has neither of by its name's letter; a user of the app by theirs, their
// name's letter under it; anyone else by their name's letter.
function commitAvatar({ login = null, name = null, agent = null }) {
  const drawn = agentOf(agent) ?? commitAgent(login, name)
  if (drawn) {
    const { name: called, mark, avatar: image } = GITHUB_AGENTS[drawn]
    return html`<span class=${`commit-avatar is-${drawn}`}>${mark ? providerIcon(mark) : image ? avatarImage(`/api/avatar/${image}`) : called[0]}</span>`
  }
  const user = appUser(login)
  const letter = (user?.name ?? user?.login ?? name ?? login ?? '').trim()[0]?.toUpperCase() ?? '?'
  return html`<span class="commit-avatar">${letter}${user ? userImage(user) : nothing}</span>`
}

// What one who made a commit shows as: an agent the commit names by the
// name it gives it; a user of the app or an agent by their account as the
// app shows them; anyone else by the name their commit gives them, else
// their login.
function makerName(login, name, agent = null) {
  if (agentOf(agent) && name) return name
  if (typeof login === 'string' && (appUser(login) || accountAgent(login))) return githubUserName(login)
  return name ?? commitAuthorName(login, name) ?? login ?? ''
}

// A commit's author and those who made it with them (`coauthors`, as the
// server read them: server-managed/repository-history.ts coauthorsOf), as
// GitHub shows them: the author's avatar, their name's letter where the app
// has none of theirs, those of the others tucked behind it in turn, and the
// author's name, all of them named in its tooltip; without others, the
// author as commitAuthor shows them. An agent by the name the commit gives it.
export function commitAuthors(login, name = null, coauthors = []) {
  const others = (Array.isArray(coauthors) ? coauthors : []).filter(other => typeof other?.name === 'string' || typeof other?.login === 'string')
    .slice(0, MAX_COAUTHORS)
  if (others.length === 0) return commitAuthor(login, name)
  const author = makerName(login, name)
  const names = others.map(other => makerName(other.login ?? null, other.name ?? null, other.agent))
  return html`<span class="app-user commit-authors" data-tooltip=${listed([author, ...names])}><span class="commit-avatars" aria-hidden="true">${[{ login, name },
    ...others].map(commitAvatar)}</span><span class="app-user-name">${author}</span><span class="sr-only"> with ${listed(names)}</span></span>`
}
