// The agents the server knows by their GitHub Apps or accounts (the Agents
// tab's, server-managed/repository-agents.ts, whose marks the Commits tab
// reads on commits too, repository-history.ts).
import type { AppAgent, AppAgentMarks } from '../common/managed/agent-tasks.ts'
import { GITHUB_AGENTS } from '../common/managed/github-agents.ts'

// The agents known by their GitHub Apps or accounts, beside Claude and
// Codex: each its id and name, its avatar (its mark, served by
// /api/avatar/<avatar>, for these alone: a GitHub App's, `app-<id>`, or
// account's, `user-<id>`), the fingerprint it leaves as a line of its pull
// requests' bodies and its commits' messages, the account its work is
// authored by (its id and the logins GitHub names it by, told by both), and
// its branches' prefix. Their work may carry Claude's or
// Codex's marks too, those its tools. Copilot's coding agent opens its pull
// requests and authors its commits as its account, Copilot (198982749), on
// `copilot/` branches; Dependabot, its GitHub App (29110), opens its pull
// requests as its account, `dependabot` (49699333, `dependabot[bot]` to
// GitHub's REST API and in its address), on `dependabot/<ecosystem>/…`
// branches. Their accounts and marks are those the app draws their work by
// wherever it shows it (common/managed/github-agents.ts): Copilot's its own,
// the app's to draw, no avatar.
const { copilot, dependabot } = GITHUB_AGENTS
export const APP_AGENTS: readonly (AppAgent & AppAgentMarks)[] = [
  { id: 'neo', name: 'Neo', avatar: 'app-3115942', fingerprint: '🤖 Generated with [Neo](', prefix: 'neo/' },
  { id: 'copilot', name: copilot.name, account: copilot.accounts[0], prefix: 'copilot/' },
  { id: 'dependabot', name: dependabot.name, avatar: dependabot.avatar, account: dependabot.accounts[0], prefix: 'dependabot/' },
]
// The prefixes of the branches agents work on: Claude Code's and Codex's,
// and the app agents'.
export const AGENT_BRANCH_PREFIXES = ['claude/', 'codex/', ...APP_AGENTS.map(agent => agent.prefix)]
