// The agents the server knows by their GitHub Apps or accounts (the Agents
// tab's, server-managed/repository-agents.ts, whose marks the Commits tab
// reads on commits too, repository-history.ts).
import type { AppAgent, AppAgentMarks } from '../common/managed/agent-tasks.ts'
import { GITHUB_AGENTS, type GithubAgent } from '../common/managed/github-agents.ts'

// The agents known by their GitHub Apps or accounts, beside Claude and
// Codex: those of GITHUB_AGENTS with branches of their own, in its order
// (common/managed/github-agents.ts, where each is told), each its id and
// name, its avatar (its mark, served by /api/avatar/<avatar>, a GitHub
// App's, `app-<id>`), the fingerprint it leaves, the account its work is
// authored by (its id and the logins GitHub names it by, told by both, or by
// its id alone where it names none), and its branches' prefix.
export const APP_AGENTS: readonly (AppAgent & AppAgentMarks)[] = (Object.entries(GITHUB_AGENTS) as [string, GithubAgent][])
  .flatMap(([id, { name, avatar, accounts: [account], prefix, fingerprint }]) => prefix ? [{ id, name, prefix, ...avatar ? { avatar } : {},
    ...account?.id === undefined ? {} : { account: { id: account.id, logins: account.logins } }, ...fingerprint ? { fingerprint } : {} }] : [])
// The prefixes of the branches agents work on: Claude Code's and Codex's,
// and the app agents'.
export const AGENT_BRANCH_PREFIXES = ['claude/', 'codex/', ...APP_AGENTS.map(agent => agent.prefix)]
