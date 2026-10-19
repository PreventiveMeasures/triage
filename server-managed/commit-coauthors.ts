// Who made a commit beside its author, as the Commits tab shows them
// (repository-history.ts): its co-authors, as its `Co-authored-by:` trailers
// name them, and the agents its message marks.
import { agentSignals, trailerBlock } from '../common/managed/agent-tasks.ts'
import { GITHUB_AGENTS, type GithubAgentId, emailAgent, githubAgent } from '../common/managed/github-agents.ts'
import { APP_AGENTS } from './app-agents.ts'
import { type NamedAccount, commitAccount } from './github-accounts.ts'

export const MAX_COAUTHORS = 3
// The rules who a commit names beside its author is read by (coauthorFacts),
// and how they are kept: what was kept read by others (history pages,
// squashed pull requests) read again by these, once raised. The agents'
// accounts, addresses and names are none of them (coauthorsOf).
export const COAUTHORS_READ = 5
const MAX_NAME = 256
const textOf = (value: unknown, max: number) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null

// One who made a commit beside its author: by name and account, as its
// author is, and the agent it is where known (common/managed/github-agents.ts),
// by its account, its commits' address or name, or the marks it leaves.
export interface Coauthor { name: string | null; login: string | null; id: number | null; agent?: string }

// `Co-authored-by: <name> <address>` trailers, GitHub matching the key
// regardless of case; Cursor's agents' links, as their work carries them;
// the app agents known by the fingerprints they leave.
const COAUTHOR_TRAILER = /^co-authored-by:[ \t]*([^<\n]*?)[ \t]*<([^<>\s]+)>[ \t]*$/gimu
const CURSOR_AGENT = /https:\/\/cursor\.com\/(?:agents\?id=|background-agent\?bcId=)bc-/u
const FINGERPRINTED = APP_AGENTS.filter(agent => agent.fingerprint)

// One named as a commit's author or co-author: by name, the address its
// commit gives (where it is read), and account.
export type Maker = { name: unknown; email?: unknown; account: NamedAccount }

// Those a commit's message names in its `Co-authored-by:` trailers
// (agent-tasks.ts trailerBlock), each by name and address.
export const coauthorTrailers = (message: unknown) => typeof message === 'string'
  ? [...trailerBlock(message.replaceAll('\r\n', '\n')).matchAll(COAUTHOR_TRAILER)].map(([, name, email]) => ({ name: name!, email: email! })) : []

// The agent one who made a commit is: by their account, else the address
// their commit names them by; else, GitHub naming no account for them, by
// their name.
const makerAgent = ({ name, email, account }: Maker): GithubAgentId | null => githubAgent(account.login, account.id) ?? emailAgent(email)
  ?? (account.login ? null : githubAgent(null, null, typeof name === 'string' ? name : null))

// Who a commit names beside its author, as its history keeps them
// (repository-history.ts, `coauthorFacts`), its message never kept: its
// co-authors (`named`), those GitHub's GraphQL API lists past the author
// (`listed`, the addresses its `Co-authored-by:` trailers give, by the
// accounts GitHub knows them by), else its trailers (agent-tasks.ts
// trailerBlock), an account's no-reply address naming it, as many as
// MAX_NAMED, each by name, address and account; and the agents its message
// marks (`markedBy`), Claude's and Codex's as the Agents tab reads them
// (agent-tasks.ts agentSignals: their sessions' and tasks' links, Claude's
// co-author and "Generated with" lines), the app agents' by their
// fingerprints, Cursor's by its agents' links. Which of them are agents,
// and so the same as another, is told as they are answered (coauthorsOf), so
// that the agents' accounts, addresses and names change none kept.
export interface Named { name: string | null; email: string | null; login: string | null; id: number | null }
export const MAX_NAMED = 10
export function coauthorFacts(message: unknown, listed: Maker[] | null = null): { named: Named[]; markedBy: string[] } {
  const text = typeof message === 'string' ? message.replaceAll('\r\n', '\n') : ''
  const makers = listed ?? coauthorTrailers(text).map(({ name, email }) => ({ name, email, account: commitAccount({ email }) }))
  const signals = agentSignals([text], FINGERPRINTED)
  return {
    named: makers.slice(0, MAX_NAMED).map(({ name, email, account }) => ({ name: textOf(name, MAX_NAME), email: textOf(email, MAX_NAME), login: account.login, id: account.id })),
    markedBy: [...signals.claude || signals.sessions.length > 0 ? ['claude'] : [], ...signals.tasks.length > 0 || signals.codex ? ['codex'] : [],
      ...CURSOR_AGENT.test(text) ? ['cursor'] : [], ...signals.agents],
  }
}

// A commit as its history keeps it: its author by name, address and account,
// and who it names beside them (coauthorFacts), absent from pages kept before.
export interface CommitFacts { authorName: string | null; authorEmail?: string | null; authorLogin: string | null; authorId?: number | null; named?: Named[]
  markedBy?: string[] }

// Who made a commit, past its author, as its history keeps them
// (`commit`, coauthorFacts): its co-authors, then the agents its message
// marks, each the agent it is where known, by the agents the app knows now,
// and once, the author none of them, as many as MAX_COAUTHORS: two are one by
// the first of their agent, account, address and name both name, two people
// of one name with accounts or addresses of their own two.
export function coauthorsOf({ authorName, authorEmail = null, authorLogin, authorId = null, named = [], markedBy = [] }: CommitFacts): Coauthor[] {
  type Identity = { agent: string | null; login: string | null; email: string | null; name: string | null }
  const identity = (agent: string | null, login: string | null, name: string | null, email: unknown = null): Identity => ({ agent, login: login?.toLowerCase() ?? null,
    email: typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null, name: name?.toLowerCase() ?? null })
  const same = (a: Identity, b: Identity) => a.agent && b.agent ? a.agent === b.agent : a.login && b.login ? a.login === b.login
    : a.email && b.email ? a.email === b.email : a.name !== null && a.name === b.name
  const author: Maker = { name: authorName, email: authorEmail, account: { login: authorLogin, id: authorId } }
  const seen = [identity(makerAgent(author), authorLogin, textOf(authorName, MAX_NAME), authorEmail)]
  const coauthors: Coauthor[] = []
  const add = (coauthor: Coauthor, email: unknown = null) => {
    const who = identity(coauthor.agent ?? null, coauthor.login, coauthor.name, email)
    if (seen.some(other => same(other, who)) || coauthors.length >= MAX_COAUTHORS || (!coauthor.login && !coauthor.name && !coauthor.agent)) return
    seen.push(who)
    coauthors.push(coauthor)
  }
  for (const { name, email, ...account } of named) {
    const agent = makerAgent({ name, email, account })
    // An agent known by its address where GitHub names someone else's
    // account for it (Codex's), as itself, not that account.
    const { login, id } = agent && account.login && githubAgent(account.login, account.id) !== agent ? { login: null, id: null } : account
    add({ name, login, id, ...agent ? { agent } : {} }, email)
  }
  for (const agent of markedBy) if (Object.hasOwn(GITHUB_AGENTS, agent)) add({ name: GITHUB_AGENTS[agent as GithubAgentId].name, login: null, id: null, agent })
  return coauthors
}
