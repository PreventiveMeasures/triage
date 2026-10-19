// GitHub's GraphQL API, a query at a time, as the repository readers ask it
// (repository-history.ts, repository-agents.ts, repository-pulse.ts and the rest).
import { GithubApiError, githubJson } from './github-app.ts'

export type GraphqlError = { type?: unknown; path?: unknown; message?: unknown }

const NAMED_ERRORS = new Set(['RATE_LIMITED', 'NOT_FOUND', 'FORBIDDEN'])
// GitHub's own words for a query it stopped past its time (ten seconds):
// "Something went wrong while executing your query. This may be the result
// of a timeout, …", with no type.
const TIMED_OUT = /\btimeout\b/iu

// One GraphQL query with `token`, answered with its `data`: one GitHub answers
// with errors, but for those the caller reads past (`tolerated`, the fields
// they name then null), is rate limited, names what isn't there, is refused,
// as one a GitHub App lacks the permission for is, or a token the scope for
// (`INSUFFICIENT_SCOPES`, a sign-in's having none), took GitHub too long, or
// else is malformed, as one GitHub rejects unread is (a field or type its API
// doesn't know). GitHub's words for errors of none of those first three types
// are logged, those read past too.
export async function githubGraphql(query: string, variables: Record<string, unknown>, token: string, fetchImpl: typeof fetch,
  tolerated: (error: GraphqlError) => boolean = () => false) {
  const body = await githubJson('https://api.github.com/graphql', token, fetchImpl, 'POST', { query, variables }, true) as { data?: unknown; errors?: GraphqlError[] } | null
  const all = Array.isArray(body?.errors) ? body.errors : []
  const unnamed = all.filter(error => !NAMED_ERRORS.has(String(error?.type)))
  if (unnamed.length > 0) {
    console.warn('managed: GitHub answered a query with errors:', JSON.stringify(unnamed.slice(0, 3)
      .map(error => ({ type: error?.type, message: String(error?.message).slice(0, 300), path: error?.path }))))
  }
  const errors = all.filter(error => !tolerated(error))
  if (errors.length > 0) {
    if (errors.some(error => error?.type === 'RATE_LIMITED')) throw new GithubApiError(429, 'github-rate-limited', 60)
    if (errors.some(error => error?.type === 'NOT_FOUND')) throw new GithubApiError(404, 'github-not-found')
    if (errors.some(error => error?.type === 'FORBIDDEN' || error?.type === 'INSUFFICIENT_SCOPES')) throw new GithubApiError(502, 'github-status-403')
    if (errors.some(error => typeof error?.message === 'string' && TIMED_OUT.test(error.message))) throw new GithubApiError(502, 'github-timeout')
    throw new GithubApiError(502, 'github-malformed')
  }
  return body?.data
}
