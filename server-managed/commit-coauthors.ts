// Who made a commit beside its author, as the Commits tab shows them
// (repository-history.ts): its co-authors, as its `Co-authored-by:` trailers
// name them, and the agents its message marks.
import { agentSignals, trailerBlock } from '../common/managed/agent-tasks.ts'
import { GITHUB_AGENTS, type GithubAgentId, emailAgent, githubAgent } from '../common/managed/github-agents.ts'
import { APP_AGENTS } from './app-agents.ts'
import { type NamedAccount, commitAccount } from './github-accounts.ts'

export const MAX_COAUTHORS = 3
// The rules co-authors are read by, the agents' addresses and names among
// them: what was kept read by others (history pages, squashed pull requests)
// read again by these, once raised.
export const COAUTHORS_READ = 3
const MAX_NAME = 256
const textOf = (value: unknown, max: number) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null

// One who made a commit beside its author: by name and account, as its
// author is, and the agent it is where known, one GitHub knows by its account
// or its commits' address or name (common/managed/github-agents.ts) or one
// the server knows by its app (app-agents.ts), with its avatar.
export interface Coauthor { name: string | null; login: string | null; id: number | null; agent?: string; avatar?: string }

// `Co-authored-by: <name> <address>` trailers, GitHub matching the key
// regardless of case; Cursor's agents' links, as their work carries them;
// the app agents known by the fingerprints they leave.
const COAUTHOR_TRAILER = /^co-authored-by:[ \t]*([^<\n]*?)[ \t]*<([^<>\s]+)>[ \t]*$/gimu
const CURSOR_AGENT = /https:\/\/cursor\.com\/(?:agents\?id=|background-agent\?bcId=)bc-/u
const FINGERPRINTED = APP_AGENTS.filter(agent => agent.fingerprint)

// One named as a commit's author or co-author: by name, the address its
// commit gives (where it is read), and account.
export type Maker = { name: unknown; email?: unknown; account: NamedAccount }

// The agent one who made a commit is: by their account, else the address
// their commit names them by; else, GitHub naming no account for them, by
// their name.
const makerAgent = ({ name, email, account }: Maker): GithubAgentId | null => githubAgent(account.login, account.id) ?? emailAgent(email)
  ?? (account.login ? null : githubAgent(null, null, typeof name === 'string' ? name : null))

// Who made a commit, past its author (`author`), as its message names them:
// its co-authors, those GitHub's GraphQL API lists past the author (`listed`,
// the addresses its `Co-authored-by:` trailers give, by the accounts GitHub
// knows them by), else its trailers (agent-tasks.ts trailerBlock), an account's no-reply
// address naming it;
// then the agents it marks, Claude's and Codex's as the Agents tab reads them
// (agent-tasks.ts agentSignals: their sessions' and tasks' links, Claude's
// co-author and "Generated with" lines), the app agents' by their
// fingerprints, Cursor's by its agents' links. Each the agent it is where
// known, and once, the author none of them, as many as MAX_COAUTHORS: two
// are one by the first of their agent, account, address and name both name,
// two people of one name with accounts or addresses of their own two.
export function coauthorsOf(message: unknown, author: Maker, listed: Maker[] | null = null): Coauthor[] {
  const text = typeof message === 'string' ? message.replaceAll('\r\n', '\n') : ''
  const named = listed ?? [...trailerBlock(text).matchAll(COAUTHOR_TRAILER)].map(([, name, email]) => ({ name, email, account: commitAccount({ email }) }))
  const signals = agentSignals([text], FINGERPRINTED)
  const marked = [...signals.claude || signals.sessions.length > 0 ? ['claude'] : [], ...signals.tasks.length > 0 || signals.codex ? ['codex'] : [],
    ...CURSOR_AGENT.test(text) ? ['cursor'] : [], ...signals.agents]
  type Identity = { agent: string | null; login: string | null; email: string | null; name: string | null }
  const identity = (agent: string | null, login: string | null, name: string | null, email: unknown = null): Identity => ({ agent, login: login?.toLowerCase() ?? null,
    email: typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null, name: name?.toLowerCase() ?? null })
  const same = (a: Identity, b: Identity) => a.agent && b.agent ? a.agent === b.agent : a.login && b.login ? a.login === b.login
    : a.email && b.email ? a.email === b.email : a.name !== null && a.name === b.name
  const seen = [identity(makerAgent(author), author.account.login, textOf(author.name, MAX_NAME), author.email)]
  const coauthors: Coauthor[] = []
  const add = (coauthor: Coauthor, email: unknown = null) => {
    const who = identity(coauthor.agent ?? null, coauthor.login, coauthor.name, email)
    if (seen.some(other => same(other, who)) || coauthors.length >= MAX_COAUTHORS || (!coauthor.login && !coauthor.name && !coauthor.agent)) return
    seen.push(who)
    coauthors.push(coauthor)
  }
  for (const maker of named) {
    const agent = makerAgent(maker)
    // An agent known by its address where GitHub names someone else's
    // account for it (Codex's), as itself, not that account.
    const { login, id } = agent && maker.account.login && githubAgent(maker.account.login, maker.account.id) !== agent ? { login: null, id: null } : maker.account
    add({ name: textOf(maker.name, MAX_NAME), login, id, ...agent ? { agent } : {} }, maker.email)
  }
  for (const agent of marked) {
    const app = APP_AGENTS.find(known => known.id === agent && !Object.hasOwn(GITHUB_AGENTS, known.id))
    add({ name: app?.name ?? GITHUB_AGENTS[agent as GithubAgentId].name, login: null, id: null, agent, ...app?.avatar ? { avatar: app.avatar } : {} })
  }
  return coauthors
}
