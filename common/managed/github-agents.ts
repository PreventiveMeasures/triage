// Agents by their own GitHub accounts, where a repository's activity names
// them: each its name, and how the app draws it, by its mark, as the Agents
// tab does (ui/view/provider-icons.js), or by its avatar, which
// /api/avatar/<avatar> serves (server-managed/repository-agents.ts
// APP_AGENTS, the Agents tab's marks); its accounts, each by the logins GitHub's REST and GraphQL APIs
// name it by and its numeric id where known, which GitHub never gives
// another; and the names its commits carry where GitHub names no account for
// them. Claude Code's commits are authored as Claude <noreply@anthropic.com>,
// which GitHub names `claude`; the Claude GitHub App's as `claude[bot]`.
// Codex's GitHub connector's are its own; Codex otherwise commits as whoever
// ran it, and those commits are theirs, with a
// `Co-authored-by: Codex <codex@openai.com>` trailer, an address GitHub
// names someone else's account for, so Codex is known by the address, not
// that account. Copilot's coding agent authors its commits as its account,
// Copilot; Copilot's code review reviews as another, its bot, which GitHub
// names Copilot as well where it is asked to review and in its threads, and
// `copilot-pull-request-reviewer` (`[bot]` to GitHub's REST API) on its
// reviews, the accounts' ids telling the two apart: a login may so be more
// than one account's. Dependabot, its GitHub App, as its bot,
// `dependabot` to GitHub's GraphQL API, `dependabot[bot]` to its REST API and
// in its address. GitHub's Agentic Workflows (gh-aw) post, and approve or
// review pull requests, as GitHub Actions' bot, `github-actions` (41898282,
// `[bot]` to the REST API), its mark the GitHub Actions App's avatar; other
// workflows the bot runs are as much its own. Neo, its GitHub App (3115942),
// as its account (274065190), known by its id alone, whatever GitHub names
// it, and drawn by its App's avatar, as where its fingerprint names it
// (server-managed/app-agents.ts). Cursor's agents commit as whoever ran them, with a
// `Co-authored-by: Cursor Agent <cursoragent@cursor.com>` trailer; the app
// has no mark of Cursor's, and draws it by its name's letter. Each by the
// addresses (`emails`) its commits name it by, as author or co-author.
export interface GithubAgentAccount { id?: number; logins: readonly string[] }
export interface GithubAgent { name: string; mark?: 'anthropic' | 'openai' | 'github-copilot'; avatar?: string; accounts: readonly GithubAgentAccount[]; names: readonly string[]
  emails?: readonly string[] }

export const GITHUB_AGENTS = {
  claude: { name: 'Claude', mark: 'anthropic', accounts: [{ id: 81847, logins: ['claude'] }, { logins: ['claude[bot]'] }], names: ['Claude'], emails: ['noreply@anthropic.com'] },
  codex: { name: 'Codex', mark: 'openai', accounts: [{ id: 199175422, logins: ['chatgpt-codex-connector', 'chatgpt-codex-connector[bot]'] }], names: ['Codex'],
    emails: ['codex@openai.com'] },
  copilot: { name: 'Copilot', mark: 'github-copilot', accounts: [{ id: 198982749, logins: ['Copilot', 'copilot-swe-agent'] },
    { id: 175728472, logins: ['Copilot', 'copilot-pull-request-reviewer', 'copilot-pull-request-reviewer[bot]'] }], names: ['Copilot'] },
  dependabot: { name: 'Dependabot', avatar: 'app-29110', accounts: [{ id: 49699333, logins: ['dependabot', 'dependabot[bot]'] }], names: ['dependabot[bot]'] },
  actions: { name: 'GitHub Actions', avatar: 'app-15368', accounts: [{ id: 41898282, logins: ['github-actions', 'github-actions[bot]'] }], names: ['github-actions[bot]'] },
  neo: { name: 'Neo', avatar: 'app-3115942', accounts: [{ id: 274065190, logins: [] }], names: [] },
  cursor: { name: 'Cursor', accounts: [], names: ['Cursor Agent'], emails: ['cursoragent@cursor.com'] },
} as const satisfies Record<string, GithubAgent>
export type GithubAgentId = keyof typeof GITHUB_AGENTS

const agents = Object.entries(GITHUB_AGENTS) as [GithubAgentId, GithubAgent][]
// Each login's agent, and the ids of the accounts it names, undefined for
// one whose id the app doesn't know.
const byLogin = new Map<string, { agent: GithubAgentId; ids: (number | undefined)[] }>()
for (const [agent, { accounts }] of agents) {
  for (const { id, logins } of accounts) {
    for (const login of logins) byLogin.set(login.toLowerCase(), { agent, ids: [...byLogin.get(login.toLowerCase())?.ids ?? [], id] })
  }
}
// The accounts known by their ids alone, no login of theirs: each its agent.
const byId = new Map(agents.flatMap(([agent, { accounts }]) => accounts.flatMap(({ id, logins }) => id !== undefined && logins.length === 0 ? [[id, agent] as const] : [])))
const byName = new Map(agents.flatMap(([agent, { names }]) => names.map(name => [name.toLowerCase(), agent] as const)))
const byEmail = new Map(agents.flatMap(([agent, { emails = [] }]) => emails.map(email => [email, agent] as const)))

// The agent whose address `email` is, GitHub matching addresses regardless of
// case; null for anyone else's.
export const emailAgent = (email: unknown): GithubAgentId | null => typeof email === 'string' ? byEmail.get(email.trim().toLowerCase()) ?? null : null

// The agent an author is: by their login, GitHub matching logins regardless
// of case, their account's id the agent's where both are known, so another
// account GitHub names by the same login (a user's, the bot's GraphQL login
// may be) is not; an account known by its id alone, by that, whatever its
// login; for an author GitHub names no account for, by the name they carry.
// Null for anyone else: a human's account is theirs, whatever their commits
// name them.
export function githubAgent(login: string | null, account: number | null = null, name: string | null = null): GithubAgentId | null {
  if (typeof login !== 'string') return typeof name === 'string' ? byName.get(name.trim().toLowerCase()) ?? null : null
  const known = byLogin.get(login.toLowerCase())
  if (known && (account === null || known.ids.includes(undefined) || known.ids.includes(account))) return known.agent
  return account === null ? null : byId.get(account) ?? null
}

// Whether the accounts `ids` a login is named by are all one agent's, as
// Copilot's coding agent's and its code review's, both named Copilot, are:
// the login is that agent's whichever it is, rather than no one's.
export function oneAgent(login: string, ids: Iterable<number>): boolean {
  const theirs = new Set([...ids].map(id => githubAgent(login, id)))
  return theirs.size === 1 && !theirs.has(null)
}

// The accounts agents work as, a person's to GitHub, as the app is told of
// them, each by its id and logins: the pull requests they open and the
// commits they push to a branch directly are agents' (the Pulse's,
// server-managed/agent-merges.ts agentMerges, repository-pulse.ts
// commitStats), whatever their branches and labels, the rest of what they do
// theirs. Christopher Turing's.
export const AGENT_OPERATED = [{ id: 188797125, logins: ['ChristopherTuring'] }] as const satisfies readonly GithubAgentAccount[]

// Whether an author is an account agents work as (AGENT_OPERATED): by its id
// where GitHub gives it, whatever it is renamed to, else by its login,
// regardless of case.
export const agentOperated = (login: string | null, id: number | null = null): boolean => AGENT_OPERATED.some(account => id === null
  ? typeof login === 'string' && account.logins.some(name => name.toLowerCase() === login.toLowerCase()) : account.id === id)
