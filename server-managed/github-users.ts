// The app's users and agents where a repository's activity names their
// GitHub accounts (GET /api/admin/repositories/history, issues, item, agents
// and pulse): of the accounts an answer names (common/managed/github-logins.ts),
// the agents' (common/managed/github-agents.ts), and those an approved user
// signs in with or linked to theirs (github-links.ts), each as that user
// shows in the app, linked accounts as their user; each by its numeric id
// where the answer names it, else by its login. Resolved as each answer is
// sent, never kept with it, and only for the accounts it names: a reader is
// never sent a list of users.
import { type GithubAgentId, githubAgent } from '../common/managed/github-agents.ts'
import { namedAccounts } from '../common/managed/github-logins.ts'
import type { ManagedDb } from './db.ts'
import type { AppUser } from './github-links.ts'

// An agent, as the app draws it (GITHUB_AGENTS).
export interface AppAgentUser { agent: GithubAgentId }

// `answer` with the app's users and agents its accounts are (`users`, by
// login), as a new object: what was kept of it, every reader's, is left as
// it was.
export async function withAppUsers<T extends object>(db: ManagedDb, answer: T): Promise<T & { users: Record<string, AppUser | AppAgentUser> }> {
  const agents: Record<string, AppAgentUser> = {}
  const accounts = [...namedAccounts(answer)].flatMap(([login, githubId]) => {
    const agent = githubAgent(login, githubId)
    if (agent) agents[login] = { agent }
    return agent ? [] : [{ login, githubId }]
  })
  return { ...answer, users: { ...await db.listUsersByAccount(accounts), ...agents } }
}
