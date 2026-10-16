// The GitHub accounts an answer about a repository's activity names (its
// commits', issues', pull requests', agents' and pulse's): as an author, one
// who merged or a contributor, by login, and by the account's numeric id
// where the answer names it beside the login. The server resolves them to the
// app's users and agents (server-managed/github-users.ts), and the client
// keeps those it answered with in place of what it held for them
// (ui/view/github-users.js).
import { oneAgent } from './github-agents.ts'

// Where answers name a login, each with where the account's id is named
// beside it.
const LOGIN_KEYS = new Map([['author', 'authorId'], ['authorLogin', 'authorId'], ['mergedBy', 'mergedById'], ['login', 'id']])
const LOGIN = /^[A-Za-z\d][A-Za-z\d-]{0,38}(?:\[bot\])?$/u
const MAX_DEPTH = 8
const accountId = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null

// The logins `answer` names, each once, with the numeric id of the account
// named beside them (null where none is, or where those named are all one
// agent's, oneAgent); `ambiguous` where a login, GitHub matching logins
// regardless of case, is named beside more than one: by an account GitHub
// named by it once, as what was kept of the history says, and one it names by
// it now, which is no telling whose each is.
export function namedAccounts(answer: unknown): Map<string, number | 'ambiguous' | null> {
  const named = new Map<string, Set<number>>()
  collect(answer, named, 0)
  const ids = new Map<string, Set<number>>()
  for (const [login, theirs] of named) ids.set(login.toLowerCase(), new Set([...ids.get(login.toLowerCase()) ?? [], ...theirs]))
  return new Map([...named.keys()].map((login): [string, number | 'ambiguous' | null] => {
    const theirs = ids.get(login.toLowerCase())!
    if (theirs.size <= 1) return [login, [...theirs][0] ?? null]
    return [login, oneAgent(login, theirs) ? null : 'ambiguous']
  }))
}

function collect(answer: unknown, named: Map<string, Set<number>>, depth: number): void {
  if (depth > MAX_DEPTH || answer === null || typeof answer !== 'object') return
  if (Array.isArray(answer)) {
    for (const value of answer) collect(value, named, depth + 1)
    return
  }
  const fields = answer as Record<string, unknown>
  for (const [key, value] of Object.entries(fields)) {
    const idKey = LOGIN_KEYS.get(key)
    if (idKey && typeof value === 'string' && LOGIN.test(value)) {
      const id = accountId(fields[idKey])
      named.set(value, new Set([...named.get(value) ?? [], ...id === null ? [] : [id]]))
    } else collect(value, named, depth + 1)
  }
}
