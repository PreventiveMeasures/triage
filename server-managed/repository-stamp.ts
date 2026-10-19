// A repository's change stamp: what moves as anything its tabs read of it
// changes, but the checks its pull requests run, which move no pull
// request's update time, read in one cheap GraphQL query: when it was last
// pushed to, how many branches and tags it has, and how many pull requests
// and issues it has and when the one updated last was. An answer kept of it
// is read again behind its readers only where its stamp moved since the
// answer was read (http.ts keptAnswer).
import { GithubApiError } from './github-errors.ts'
import { githubGraphql } from './github-graphql.ts'

// The rules a stamp is read by: its key's, so that a stamp read by others is
// none's (http.ts stampOf).
export const STAMP_READ = 1

const STAMP_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pushedAt
    heads: refs(refPrefix: "refs/heads/", first: 1) { totalCount }
    tags: refs(refPrefix: "refs/tags/", first: 1) { totalCount }
    pullRequests(first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) { totalCount nodes { updatedAt } }
    issues(first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) { totalCount nodes { updatedAt } }
  }
}`
type Counted = { totalCount?: unknown; nodes?: ({ updatedAt?: unknown } | null)[] | null } | null
type Stamped = { repository?: { pushedAt?: unknown; heads?: Counted; tags?: Counted; pullRequests?: Counted; issues?: Counted } | null } | null

// Repository `fullName`'s stamp, read with `token`, as text to compare.
export async function repositoryStamp(fullName: string, token: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<{ stamp: string }> {
  const [owner, name] = fullName.split('/') as [string, string]
  const repository = (await githubGraphql(STAMP_QUERY, { owner, name }, token, fetchImpl) as Stamped)?.repository
  if (!repository) throw new GithubApiError(404, 'github-not-found')
  // One missing a count tells nothing: none, never one that would move with nothing.
  const { heads, tags, pullRequests, issues } = repository
  if (![heads, tags, pullRequests, issues].every(connection => Number.isSafeInteger(connection?.totalCount))) throw new GithubApiError(502, 'github-malformed')
  const latest = (connection: Counted | undefined) => [connection?.totalCount, connection?.nodes?.[0]?.updatedAt ?? null]
  return { stamp: JSON.stringify([repository.pushedAt ?? null, heads?.totalCount, tags?.totalCount, ...latest(pullRequests), ...latest(issues)]) }
}
