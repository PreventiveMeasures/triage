// The commit history the code viewer's History tab draws
// (GET /api/admin/repositories/history), as `git log --oneline --decorate
// --graph` shows it: each commit's id, parents, subject, author and time, and
// the branches and tags pointing at commits. From a revision, a page at a
// time, of the whole repository or of the commits touching a directory, as
// GitHub's REST API lists them, for any reader; or, as `--all`, across the
// repository's most recently updated branches at once, in one GraphQL query,
// which needs a token.
import { GithubApiError, githubJson } from './github-app.ts'

export const HISTORY_PAGE = 100
// `--all`: the branches most recently committed to, the latest commits of
// each (as many as a GraphQL connection gives), and the latest tags.
export const ALL_BRANCHES = 25
const ALL_DEPTH = 100
const ALL_TAGS = 100
const REF_TIPS = 100
const MAX_PARENTS = 8
const MAX_SUBJECT = 1000
const MAX_NAME = 256
const SHA = /^[a-f\d]{40}$/u
const LOGIN = /^[A-Za-z\d][A-Za-z\d-]{0,38}(?:\[bot\])?$/u

export interface HistoryCommit { sha: string; parents: string[]; subject: string; authorName: string | null; authorLogin: string | null; committedAt: number | null }
export interface HistoryRef { name: string; sha: string }

const textOf = (value: unknown, max: number) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
const timeOf = (value: unknown) => {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isSafeInteger(at) ? at : null
}

// A commit as the History tab reads it, its subject the message's first line,
// as `--oneline` shows; null for one GitHub names no commit id for.
function historyCommit(sha: unknown, parents: unknown[], message: unknown, authorName: unknown, authorLogin: unknown, committedAt: unknown): HistoryCommit | null {
  if (typeof sha !== 'string' || !SHA.test(sha)) return null
  return {
    sha,
    parents: parents.filter((parent): parent is string => typeof parent === 'string' && SHA.test(parent)).slice(0, MAX_PARENTS),
    subject: typeof message === 'string' ? message.replaceAll('\r\n', '\n').split('\n', 1)[0]!.trim().slice(0, MAX_SUBJECT) : '',
    authorName: textOf(authorName, MAX_NAME),
    authorLogin: typeof authorLogin === 'string' && LOGIN.test(authorLogin) ? authorLogin : null,
    committedAt: timeOf(committedAt),
  }
}

type RestCommit = { sha?: unknown; parents?: { sha?: unknown }[]; author?: { login?: unknown } | null
  commit?: { message?: unknown; author?: { name?: unknown } | null; committer?: { date?: unknown } | null } }
const restCommit = (item: RestCommit) => historyCommit(item?.sha, Array.isArray(item?.parents) ? item.parents.map(parent => parent?.sha) : [],
  item?.commit?.message, item?.commit?.author?.name, item?.author?.login, item?.commit?.committer?.date)

const repoApi = (fullName: string) => `https://api.github.com/repos/${fullName.split('/').map(encodeURIComponent).join('/')}`

// A page of the commits `commit` reaches, newest first as GitHub lists them,
// those touching `path` alone where it names a directory; `more` where a
// full page leaves some for the next.
export async function repositoryHistory(fullName: string, token: string | null, commit: string, path: string, page: number, fetchImpl: typeof fetch = globalThis.fetch) {
  const params = new URLSearchParams({ sha: commit, per_page: String(HISTORY_PAGE), page: String(page), ...path ? { path } : {} })
  const data = await githubJson(`${repoApi(fullName)}/commits?${params}`, token, fetchImpl)
  if (!Array.isArray(data)) throw new GithubApiError(502, 'github-malformed')
  return { commits: data.flatMap(item => restCommit(item as RestCommit) ?? []), more: data.length >= HISTORY_PAGE }
}

// The commits the repository's branches and tags point at, as GitHub's
// first page of each lists them, to name commits by.
export async function repositoryRefTips(fullName: string, token: string | null, fetchImpl: typeof fetch = globalThis.fetch) {
  const tips = (list: unknown): HistoryRef[] => Array.isArray(list) ? list.flatMap((item: { name?: unknown; commit?: { sha?: unknown } }) =>
    typeof item?.name === 'string' && item.name && typeof item.commit?.sha === 'string' && SHA.test(item.commit.sha)
      ? [{ name: item.name.slice(0, MAX_NAME), sha: item.commit.sha }] : []) : []
  const [branches, tags] = await Promise.all(['branches', 'tags'].map(kind => githubJson(`${repoApi(fullName)}/${kind}?per_page=${REF_TIPS}`, token, fetchImpl)))
  return { branches: tips(branches), tags: tips(tags) }
}

// One GraphQL query with `token`, answered with its `data`: one GitHub answers
// with errors is rate limited, names what isn't there, or else is malformed.
async function githubGraphql(query: string, variables: Record<string, unknown>, token: string, fetchImpl: typeof fetch) {
  const body = await githubJson('https://api.github.com/graphql', token, fetchImpl, 'POST', { query, variables }) as { data?: unknown; errors?: { type?: unknown }[] } | null
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    if (body.errors.some(error => error?.type === 'RATE_LIMITED')) throw new GithubApiError(429, 'github-rate-limited', 60)
    if (body.errors.some(error => error?.type === 'NOT_FOUND')) throw new GithubApiError(404, 'github-not-found')
    throw new GithubApiError(502, 'github-malformed')
  }
  return body?.data
}

const ALL_QUERY = `query($owner: String!, $name: String!, $branches: Int!, $depth: Int!, $tags: Int!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    branches: refs(refPrefix: "refs/heads/", first: $branches, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
      totalCount
      nodes { name target { ... on Commit { oid history(first: $depth) { pageInfo { hasNextPage } nodes { ...historyCommit } } } } }
    }
    tags: refs(refPrefix: "refs/tags/", first: $tags, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) {
      nodes { name target { oid ... on Tag { target { oid } } } }
    }
  }
}
fragment historyCommit on Commit { oid messageHeadline committedDate author { name user { login } } parents(first: ${MAX_PARENTS}) { nodes { oid } } }`

type GraphCommit = { oid?: unknown; messageHeadline?: unknown; committedDate?: unknown; author?: { name?: unknown; user?: { login?: unknown } | null } | null
  parents?: { nodes?: { oid?: unknown }[] } }
type GraphRef = { name?: unknown; target?: { oid?: unknown; target?: { oid?: unknown }; history?: { pageInfo?: { hasNextPage?: unknown }; nodes?: GraphCommit[] } } | null }

// `--all`: the latest commits of the repository's most recently updated
// branches, each commit once, its branches and latest tags (an annotated tag
// by the commit it tags), and whether any is left out (`more`).
export async function repositoryAllHistory(fullName: string, token: string, fetchImpl: typeof fetch = globalThis.fetch) {
  const [owner, name] = fullName.split('/')
  const data = await githubGraphql(ALL_QUERY, { owner, name, branches: ALL_BRANCHES, depth: ALL_DEPTH, tags: ALL_TAGS }, token, fetchImpl) as {
    repository?: { defaultBranchRef?: { name?: unknown } | null; branches?: { totalCount?: unknown; nodes?: GraphRef[] }; tags?: { nodes?: GraphRef[] } } | null
  }
  const repository = data?.repository
  if (!repository) throw new GithubApiError(404, 'github-not-found')
  const commits = new Map<string, HistoryCommit>()
  const branches: HistoryRef[] = []
  let more = typeof repository.branches?.totalCount === 'number' && repository.branches.totalCount > ALL_BRANCHES
  for (const ref of repository.branches?.nodes ?? []) {
    const target = ref?.target
    if (typeof ref?.name !== 'string' || typeof target?.oid !== 'string' || !SHA.test(target.oid)) continue
    branches.push({ name: ref.name.slice(0, MAX_NAME), sha: target.oid })
    if (target.history?.pageInfo?.hasNextPage === true) more = true
    for (const node of target.history?.nodes ?? []) {
      const commit = historyCommit(node?.oid, (node?.parents?.nodes ?? []).map(parent => parent?.oid), node?.messageHeadline, node?.author?.name,
        node?.author?.user?.login, node?.committedDate)
      if (commit && !commits.has(commit.sha)) commits.set(commit.sha, commit)
    }
  }
  const tags = (repository.tags?.nodes ?? []).flatMap(ref => {
    const sha = ref?.target?.target?.oid ?? ref?.target?.oid
    return typeof ref?.name === 'string' && typeof sha === 'string' && SHA.test(sha) ? [{ name: ref.name.slice(0, MAX_NAME), sha }] : []
  })
  const defaultBranch = textOf(repository.defaultBranchRef?.name, MAX_NAME)
  return { commits: [...commits.values()], branches, tags, defaultBranch, more }
}
