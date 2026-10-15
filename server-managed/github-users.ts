// The app's users where a repository's activity names their GitHub accounts
// (GET /api/admin/repositories/history, issues, item, agents and pulse): of
// the logins an answer names, as an author, one who merged or a contributor,
// those an approved user signs in with or linked to theirs (github-links.ts),
// each as that user shows in the app, linked accounts as their user. Resolved
// as each answer is sent, never kept with it, and only for the logins it
// names: a reader is never sent a list of users.
import type { ManagedDb } from './db.ts'
import type { AppUser } from './github-links.ts'

// Where answers name a login. A GitHub App's ([bot]) is never a user's.
const LOGIN_KEYS = new Set(['author', 'authorLogin', 'mergedBy', 'login'])
const LOGIN = /^[A-Za-z\d][A-Za-z\d-]{0,38}$/u
const MAX_DEPTH = 8

// The logins `answer` names, each once.
export function namedLogins(answer: unknown, found = new Set<string>(), depth = 0): Set<string> {
  if (depth > MAX_DEPTH || answer === null || typeof answer !== 'object') return found
  if (Array.isArray(answer)) {
    for (const value of answer) namedLogins(value, found, depth + 1)
    return found
  }
  for (const [key, value] of Object.entries(answer)) {
    if (LOGIN_KEYS.has(key) && typeof value === 'string' && LOGIN.test(value)) found.add(value)
    else namedLogins(value, found, depth + 1)
  }
  return found
}

// `answer` with the app's users its logins name (`users`, by login), as a new
// object: what was kept of it, every reader's, is left as it was.
export async function withAppUsers<T extends object>(db: ManagedDb, answer: T): Promise<T & { users: Record<string, AppUser> }> {
  return { ...answer, users: await db.listUsersByLogin([...namedLogins(answer)]) }
}
