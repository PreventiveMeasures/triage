// Agents by their own GitHub accounts, where a repository's activity names
// them: each its name, and how the app draws it, by its provider's mark
// (ui/view/provider-icons.js) or by its avatar, which /api/avatar/<avatar>
// serves (server-managed/repository-agents.ts APP_AGENTS, the Agents tab's
// marks); its accounts, each by the logins GitHub's REST and GraphQL APIs
// name it by and its numeric id where known, which GitHub never gives
// another; and the names its commits carry where GitHub names no account for
// them. Claude Code's commits are authored as Claude <noreply@anthropic.com>,
// which GitHub names `claude`; the Claude GitHub App's as `claude[bot]`.
// Codex's GitHub connector's are its own; Codex otherwise commits as whoever
// ran it, and those commits are theirs. Copilot's coding agent authors its
// commits as its account, Copilot; Dependabot, its GitHub App, as its bot,
// `dependabot` to GitHub's GraphQL API, `dependabot[bot]` to its REST API and
// in its address.
export interface GithubAgentAccount { id?: number; logins: readonly string[] }
export interface GithubAgent { name: string; mark?: 'anthropic' | 'openai'; avatar?: string; accounts: readonly GithubAgentAccount[]; names: readonly string[] }

export const GITHUB_AGENTS = {
  claude: { name: 'Claude', mark: 'anthropic', accounts: [{ id: 81847, logins: ['claude'] }, { logins: ['claude[bot]'] }], names: ['Claude'] },
  codex: { name: 'Codex', mark: 'openai', accounts: [{ id: 199175422, logins: ['chatgpt-codex-connector', 'chatgpt-codex-connector[bot]'] }], names: ['Codex'] },
  copilot: { name: 'Copilot', avatar: 'user-198982749', accounts: [{ id: 198982749, logins: ['Copilot', 'copilot-swe-agent'] }], names: ['Copilot'] },
  dependabot: { name: 'Dependabot', avatar: 'app-29110', accounts: [{ id: 49699333, logins: ['dependabot', 'dependabot[bot]'] }], names: ['dependabot[bot]'] },
} as const satisfies Record<string, GithubAgent>
export type GithubAgentId = keyof typeof GITHUB_AGENTS

const agents = Object.entries(GITHUB_AGENTS) as [GithubAgentId, GithubAgent][]
const byLogin = new Map(agents.flatMap(([agent, { accounts }]) => accounts.flatMap(({ id, logins }) => logins.map(login => [login.toLowerCase(), { agent, id }] as const))))
const byName = new Map(agents.flatMap(([agent, { names }]) => names.map(name => [name.toLowerCase(), agent] as const)))

// The agent an author is: by their login, GitHub matching logins regardless
// of case, their account's id the agent's where both are known, so another
// account GitHub names by the same login (a user's, the bot's GraphQL login
// may be) is not; for an author GitHub names no account for, by the name
// they carry. Null for anyone else: a human's account is theirs, whatever
// their commits name them.
export function githubAgent(login: string | null, account: number | null = null, name: string | null = null): GithubAgentId | null {
  if (typeof login !== 'string') return typeof name === 'string' ? byName.get(name.trim().toLowerCase()) ?? null : null
  const known = byLogin.get(login.toLowerCase())
  return known && (known.id === undefined || account === null || known.id === account) ? known.agent : null
}
