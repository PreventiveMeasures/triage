// The GitHub logins an answer about a repository's activity names (its
// commits', issues', pull requests', agents' and pulse's): as an author, one
// who merged or a contributor. The server resolves them to the app's users
// (server-managed/github-users.ts), and the client keeps those it answered
// with in place of what it held for them (ui/view/github-users.js).

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
