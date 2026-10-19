// GitHub accounts as GitHub's REST and GraphQL APIs name them, where a
// repository's activity names its authors (repository-history.ts and the
// Commits, Issues, Agents and Pulse tabs' readers).
import { githubGraphql } from './github-graphql.ts'

const LOGIN = /^[A-Za-z\d][A-Za-z\d-]{0,38}(?:\[bot\])?$/u

// An account as GitHub names it: its login, else null, and its numeric id
// where GitHub names one with it.
export interface NamedAccount { login: string | null; id: number | null }
export function accountOf(account: { login?: unknown; id?: unknown } | null | undefined): NamedAccount {
  const login = typeof account?.login === 'string' && LOGIN.test(account.login) ? account.login : null
  const id = account?.id
  return { login, id: login && Number.isSafeInteger(id) && (id as number) > 0 ? id as number : null }
}

// An actor (the author of an issue or a pull request, one who merged one) as
// GitHub's GraphQL API names it: its login, and its account's numeric id, a
// user's or a GitHub App's bot's.
export const ACTOR = 'login ... on User { databaseId } ... on Bot { databaseId }'
export type GraphAccount = { login?: unknown; databaseId?: unknown } | null | undefined
export const actorOf = (actor: GraphAccount) => accountOf({ login: actor?.login, id: actor?.databaseId })

// A commit's author's account, as GitHub's GraphQL API names it: the user
// GitHub knows its address for; else, as GitHub's REST API does, the account
// whose noreply address its address is, `<id>+<login>@users.noreply.github.com`:
// a GitHub App's bot's, which is no user (GraphQL's `user` is a User's, never
// a bot's). One by GitHub's older no-reply address, `<login>@users.noreply.github.com`,
// naming no id, its user looked up by its login (repository-history.ts linkNoreplyUsers).
const NOREPLY = /^([1-9]\d{0,11})\+([^@]+)@users\.noreply\.github\.com$/iu
export type GraphActor = { email?: unknown; user?: GraphAccount | null }
export function commitAccount(author: GraphActor | null | undefined): NamedAccount {
  const user = actorOf(author?.user)
  const noreply = user.id === null && typeof author?.email === 'string' ? NOREPLY.exec(author.email) : null
  return noreply ? accountOf({ login: noreply[2], id: Number(noreply[1]) }) : user
}

// GitHub's no-reply address of old, `<login>@users.noreply.github.com`, which
// names no id: GitHub links the commits it authors to the account of its
// login, as its REST API names them, but its GraphQL API names no user for it.
const NOREPLY_LOGIN = /^([A-Za-z\d][A-Za-z\d-]{0,38})@users\.noreply\.github\.com$/iu
const MAX_NOREPLY_LOGINS = 100

// Commits' authors and co-authors (`actors`), as GitHub's GraphQL API names
// them, those it names no user for by such an address named the user of its
// login, as GitHub links them: those logins, as many as MAX_NOREPLY_LOGINS,
// looked up in one query, where any is.
export async function linkNoreplyUsers(actors: (GraphActor | null | undefined)[], token: string, fetchImpl: typeof fetch): Promise<void> {
  const unnamed = actors.flatMap(actor => {
    const login = actor && !actor.user && typeof actor.email === 'string' ? NOREPLY_LOGIN.exec(actor.email)?.[1]?.toLowerCase() : undefined
    return login ? [{ actor: actor!, login }] : []
  })
  const logins = [...new Set(unnamed.map(({ login }) => login))].slice(0, MAX_NOREPLY_LOGINS)
  if (logins.length === 0) return
  const query = `query(${logins.map((_, at) => `$l${at}: String!`).join(', ')}) { ${logins.map((_, at) => `u${at}: user(login: $l${at}) { login databaseId }`).join(' ')} }`
  const data = await githubGraphql(query, Object.fromEntries(logins.map((login, at) => [`l${at}`, login])), token, fetchImpl,
    error => error?.type === 'NOT_FOUND') as Record<string, GraphAccount> | null
  const users = new Map(logins.map((login, at) => [login, data?.[`u${at}`] ?? null]))
  for (const { actor, login } of unnamed) actor.user = users.get(login) ?? null
}
