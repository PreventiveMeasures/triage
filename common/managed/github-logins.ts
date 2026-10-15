// The GitHub accounts an answer about a repository's activity names (its
// commits', issues', pull requests', agents' and pulse's): as an author, one
// who merged or a contributor, by login, and by the account's numeric id
// where the answer names it beside the login. The server resolves them to the
// app's users and agents (server-managed/github-users.ts), and the client
// keeps those it answered with in place of what it held for them
// (ui/view/github-users.js).

// Where answers name a login, each with where the account's id is named
// beside it.
const LOGIN_KEYS = new Map([['author', 'authorId'], ['authorLogin', 'authorId'], ['mergedBy', 'mergedById'], ['login', 'id']])
const LOGIN = /^[A-Za-z\d][A-Za-z\d-]{0,38}(?:\[bot\])?$/u
const MAX_DEPTH = 8
const accountId = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null

// The logins `answer` names, each once, with the numeric id of the account
// named beside it, the first named (null where none is).
export function namedAccounts(answer: unknown, found = new Map<string, number | null>(), depth = 0): Map<string, number | null> {
  if (depth > MAX_DEPTH || answer === null || typeof answer !== 'object') return found
  if (Array.isArray(answer)) {
    for (const value of answer) namedAccounts(value, found, depth + 1)
    return found
  }
  const named = answer as Record<string, unknown>
  for (const [key, value] of Object.entries(named)) {
    const idKey = LOGIN_KEYS.get(key)
    if (idKey && typeof value === 'string' && LOGIN.test(value)) found.set(value, found.get(value) ?? accountId(named[idKey]))
    else namedAccounts(value, found, depth + 1)
  }
  return found
}
