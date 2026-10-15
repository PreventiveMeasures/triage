// The app's users where a repository's activity names their GitHub accounts
// (GET /api/admin/repositories/history, issues, item, agents and pulse): of
// the logins an answer names (common/managed/github-logins.ts), those an
// approved user signs in with or linked to theirs (github-links.ts), each as
// that user shows in the app, linked accounts as their user. Resolved as each
// answer is sent, never kept with it, and only for the logins it names: a
// reader is never sent a list of users.
import { namedLogins } from '../common/managed/github-logins.ts'
import type { ManagedDb } from './db.ts'
import type { AppUser } from './github-links.ts'

// `answer` with the app's users its logins name (`users`, by login), as a new
// object: what was kept of it, every reader's, is left as it was.
export async function withAppUsers<T extends object>(db: ManagedDb, answer: T): Promise<T & { users: Record<string, AppUser> }> {
  return { ...answer, users: await db.listUsersByLogin([...namedLogins(answer)]) }
}
