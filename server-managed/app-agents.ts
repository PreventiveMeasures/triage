// The agents the server knows by their GitHub Apps or accounts (the Agents
// tab's, server-managed/repository-agents.ts, whose marks the Commits tab
// reads on commits too, repository-history.ts).
import type { AppAgent, AppAgentMarks } from '../common/managed/agent-tasks.ts'
import { GITHUB_AGENTS, type GithubAgent } from '../common/managed/github-agents.ts'

// The agents known by their GitHub Apps or accounts, beside Claude and
// Codex: those of GITHUB_AGENTS with branches of their own, in its order
// (common/managed/github-agents.ts, where each is told, its accounts among
// it), each its id and name, its avatar (its mark, served by
// /api/avatar/<avatar>, a GitHub App's, `app-<id>`), the fingerprint it
// leaves, and its branches' prefix.
export const APP_AGENTS: readonly (AppAgent & AppAgentMarks)[] = Object.entries<GithubAgent>(GITHUB_AGENTS)
  .flatMap(([id, { name, avatar, prefix, fingerprint }]) => prefix ? [{ id, name, prefix, ...avatar ? { avatar } : {}, ...fingerprint ? { fingerprint } : {} }] : [])
// The prefixes of the branches agents work on: Claude Code's and Codex's,
// and the app agents'.
export const AGENT_BRANCH_PREFIXES = ['claude/', 'codex/', ...APP_AGENTS.map(agent => agent.prefix)]
// What the marks agents leave on commits are read by, as the history keeps
// them (repository-history.ts commitMarks), and branches' tips and the
// commits the app agents' accounts authored (repository-agents.ts): bumped
// as how they are told changes, so that the Agents tab reads again those
// kept by older rules.
export const AGENT_MARKS_READ = 1
