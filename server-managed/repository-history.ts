// The commit history the code viewer's History tab draws
// (GET /api/admin/repositories/history), as `git log --oneline --decorate
// --graph` shows it: each commit's id, parents, subject, author and time, and
// the branches and tags pointing at commits. From a revision, a page at a
// time, of the whole repository or of the commits touching a directory, as
// GitHub's REST API lists them, for any reader; or, as `--all`, across the
// repository's most recently committed to branches at once, then on from where
// those stop, in GraphQL queries, which need a token. A whole repository's is
// read a page from a commit at a time, each page kept by the commit it starts
// at (historyFrom): a commit's history never changes, and where a commit read
// starts a page kept, that page glues on, and those after it.
import { GithubApiError, githubJson } from './github-app.ts'

export const HISTORY_PAGE = 100
// The deepest page read, as far as Older commits goes.
export const MAX_HISTORY_PAGE = 100
// `--all`: the branches most recently committed to, of as many as ten pages
// of them list, the latest commits of each (as many as a GraphQL connection
// gives), and the latest tags.
export const ALL_BRANCHES = 25
const MAX_HEAD_PAGES = 10
const ALL_DEPTH = 100
const ALL_TAGS = 100
const REF_TIPS = 100
const MAX_PARENTS = 8
const MAX_SUBJECT = 1000
const MAX_NAME = 256
const SHA = /^[a-f\d]{40}$/u
const LOGIN = /^[A-Za-z\d][A-Za-z\d-]{0,38}(?:\[bot\])?$/u

// A commit, with the lines it adds and removes and when it was authored in its
// author's own time zone (`authorZone`, minutes east of UTC), where GitHub's
// GraphQL API tells them (null where its REST API lists it).
export interface HistoryCommit { sha: string; parents: string[]; subject: string; authorName: string | null; authorLogin: string | null; committedAt: number | null
  additions?: number | null; deletions?: number | null; authoredAt?: number | null; authorZone?: number | null }
export interface HistoryRef { name: string; sha: string }

const textOf = (value: unknown, max: number) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
const timeOf = (value: unknown) => {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isSafeInteger(at) ? at : null
}

const lineCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null
// The minutes east of UTC an ISO 8601 time is given in: `Z` none.
const zoneOf = (value: unknown) => {
  const zone = typeof value === 'string' ? /(?:Z|([+-])(\d{2}):?(\d{2}))$/u.exec(value) : null
  return zone ? zone[1] ? (zone[1] === '-' ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3])) : 0 : null
}

// A commit as the Commits tab reads it, its subject the message's first
// line, as `--oneline` shows; null for one GitHub names no commit id for.
// With `stats`, the GraphQL API's, its lines and its author's time.
function historyCommit(sha: unknown, parents: unknown[], message: unknown, authorName: unknown, authorLogin: unknown, committedAt: unknown,
  stats: { additions?: unknown; deletions?: unknown; authoredAt?: unknown } | null = null): HistoryCommit | null {
  if (typeof sha !== 'string' || !SHA.test(sha)) return null
  const lines = stats ? { additions: lineCount(stats.additions), deletions: lineCount(stats.deletions), authoredAt: timeOf(stats.authoredAt),
    authorZone: zoneOf(stats.authoredAt) } : { additions: null, deletions: null, authoredAt: null, authorZone: null }
  return {
    sha,
    parents: parents.filter((parent): parent is string => typeof parent === 'string' && SHA.test(parent)).slice(0, MAX_PARENTS),
    subject: typeof message === 'string' ? message.replaceAll('\r\n', '\n').split('\n', 1)[0]!.trim().slice(0, MAX_SUBJECT) : '',
    authorName: textOf(authorName, MAX_NAME),
    authorLogin: typeof authorLogin === 'string' && LOGIN.test(authorLogin) ? authorLogin : null,
    committedAt: timeOf(committedAt),
    ...lines,
  }
}

type RestCommit = { sha?: unknown; parents?: { sha?: unknown }[]; author?: { login?: unknown } | null
  commit?: { message?: unknown; author?: { name?: unknown } | null; committer?: { date?: unknown } | null } }
const restCommit = (item: RestCommit) => historyCommit(item?.sha, Array.isArray(item?.parents) ? item.parents.map(parent => parent?.sha) : [],
  item?.commit?.message, item?.commit?.author?.name, item?.author?.login, item?.commit?.committer?.date)

const repoApi = (fullName: string) => `https://api.github.com/repos/${fullName.split('/').map(encodeURIComponent).join('/')}`

// A page of the commits `commit` reaches, newest first as GitHub lists them,
// those touching `path` alone where it names a directory; `more` where a
// full page leaves some for the next, one that may be read.
export async function repositoryHistory(fullName: string, token: string | null, commit: string, path: string, page: number, fetchImpl: typeof fetch = globalThis.fetch) {
  const params = new URLSearchParams({ sha: commit, per_page: String(HISTORY_PAGE), page: String(page), ...path ? { path } : {} })
  const data = await githubJson(`${repoApi(fullName)}/commits?${params}`, token, fetchImpl)
  if (!Array.isArray(data)) throw new GithubApiError(502, 'github-malformed')
  return { commits: data.flatMap(item => restCommit(item as RestCommit) ?? []), more: data.length >= HISTORY_PAGE && page < MAX_HISTORY_PAGE }
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

export type GraphqlError = { type?: unknown; path?: unknown }

// One GraphQL query with `token`, answered with its `data`: one GitHub answers
// with errors, but for those the caller reads past (`tolerated`, the fields
// they name then null), is rate limited, names what isn't there, is refused,
// as one a GitHub App lacks the permission for is, or else is malformed.
export async function githubGraphql(query: string, variables: Record<string, unknown>, token: string, fetchImpl: typeof fetch,
  tolerated: (error: GraphqlError) => boolean = () => false) {
  const body = await githubJson('https://api.github.com/graphql', token, fetchImpl, 'POST', { query, variables }) as { data?: unknown; errors?: GraphqlError[] } | null
  const errors = Array.isArray(body?.errors) ? body.errors.filter(error => !tolerated(error)) : []
  if (errors.length > 0) {
    if (errors.some(error => error?.type === 'RATE_LIMITED')) throw new GithubApiError(429, 'github-rate-limited', 60)
    if (errors.some(error => error?.type === 'NOT_FOUND')) throw new GithubApiError(404, 'github-not-found')
    if (errors.some(error => error?.type === 'FORBIDDEN')) throw new GithubApiError(502, 'github-status-403')
    throw new GithubApiError(502, 'github-malformed')
  }
  return body?.data
}

// A tag's target, an annotated tag's own target in turn, through as many as
// MAX_TAG_DEPTH annotated tags, each object's type naming what it is.
const MAX_TAG_DEPTH = 4
const tagTarget = (tags: number): string => `target { __typename oid${tags > 0 ? ` ... on Tag { ${tagTarget(tags - 1)} }` : ''} }`

// The branches' tips, a page at a time, each with its commit's date (GitHub
// orders heads by name alone), and, on the first page, the default branch's
// tip, wherever its name sorts, and the latest tags.
const HEADS_QUERY = `query($owner: String!, $name: String!, $after: String, $tags: Int!, $first: Boolean!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name target { oid ... on Commit { committedDate } } }
    branches: refs(refPrefix: "refs/heads/", first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { name target { oid ... on Commit { committedDate } } }
    }
    tags: refs(refPrefix: "refs/tags/", first: $tags, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) @include(if: $first) {
      nodes { name ${tagTarget(MAX_TAG_DEPTH)} }
    }
  }
}`

// As many commits as gluing kept pages on goes to, in as many rounds of
// looking them up, each looking up as many commits as tops.
export const HISTORY_GLUED = 2000
const MAX_GLUE_ROUNDS = 20
const GLUE_LOOKUP = 50

// The pages of a repository's history kept, each by the commit it starts at
// (its top): the first page of the history from that commit, which never
// changes.
export interface HistoryPages {
  read(tops: string[]): Promise<Map<string, HistoryCommit[]>>
  write(top: string, commits: HistoryCommit[]): Promise<void>
}

// The latest commits of each tip, by its id, `b<n>` the `n`th's.
const historiesQuery = (count: number) => `query($owner: String!, $name: String!, ${Array.from({ length: count }, (_, at) => `$o${at}: GitObjectID!`).join(', ')}) {
  repository(owner: $owner, name: $name) {
    ${Array.from({ length: count }, (_, at) => `b${at}: object(oid: $o${at}) { ... on Commit { history(first: ${ALL_DEPTH}) { pageInfo { hasNextPage } nodes { ...historyCommit } } } }`).join('\n    ')}
  }
}
fragment historyCommit on Commit { oid messageHeadline committedDate additions deletions author { name date user { login } } parents(first: ${MAX_PARENTS}) { nodes { oid } } }`

type GraphCommit = { oid?: unknown; messageHeadline?: unknown; committedDate?: unknown; additions?: unknown; deletions?: unknown
  author?: { name?: unknown; date?: unknown; user?: { login?: unknown } | null } | null
  parents?: { nodes?: { oid?: unknown }[] } }
type GraphTarget = { __typename?: unknown; oid?: unknown; committedDate?: unknown; target?: GraphTarget | null }
type GraphRef = { name?: unknown; target?: GraphTarget | null }
type HeadsPage = { repository?: { defaultBranchRef?: GraphRef | null
  branches?: { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }; nodes?: GraphRef[] }; tags?: { nodes?: GraphRef[] } } | null }
type Histories = { repository?: Record<string, { history?: { pageInfo?: { hasNextPage?: unknown }; nodes?: GraphCommit[] } } | null> | null }

// The repository's branches, as many as MAX_HEAD_PAGES of them list, each
// with its tip's time, its default branch and latest tags (an annotated tag
// by the commit it tags), and whether any branch is left out.
async function repositoryHeads(owner: string, name: string, token: string, fetchImpl: typeof fetch) {
  const heads: (HistoryRef & { at: number | null })[] = []
  let first: HeadsPage['repository'] = null
  let after: string | null = null
  for (let page = 0; page < MAX_HEAD_PAGES; page++) {
    const data = await githubGraphql(HEADS_QUERY, { owner, name, after, tags: ALL_TAGS, first: page === 0 }, token, fetchImpl) as HeadsPage
    const repository = data?.repository
    if (!repository) throw new GithubApiError(404, 'github-not-found')
    first ??= repository
    for (const ref of repository.branches?.nodes ?? []) {
      const sha = ref?.target?.oid
      if (typeof ref?.name === 'string' && ref.name && typeof sha === 'string' && SHA.test(sha)) heads.push({ name: ref.name.slice(0, MAX_NAME), sha, at: timeOf(ref.target?.committedDate) })
    }
    const next = repository.branches?.pageInfo
    if (next?.hasNextPage !== true || typeof next.endCursor !== 'string') return { heads, repository: first, cut: false }
    after = next.endCursor
  }
  return { heads, repository: first, cut: true }
}

// The first page of the history from each of `tops`, by its top: with a
// token, in one GraphQL query; without, a REST list each.
async function readPages(fullName: string, token: string | null, tops: string[], fetchImpl: typeof fetch) {
  if (!token) {
    return new Map(await Promise.all(tops.map(async top => [top, (await repositoryHistory(fullName, null, top, '', 1, fetchImpl)).commits] as const)))
  }
  const [owner, name] = fullName.split('/') as [string, string]
  const data = await githubGraphql(historiesQuery(tops.length), { owner, name, ...Object.fromEntries(tops.map((sha, at) => [`o${at}`, sha])) }, token, fetchImpl) as Histories
  return new Map(tops.map((top, at) => [top, (data?.repository?.[`b${at}`]?.history?.nodes ?? []).flatMap(node => historyCommit(node?.oid,
    (node?.parents?.nodes ?? []).map(parent => parent?.oid), node?.messageHeadline, node?.author?.name, node?.author?.user?.login, node?.committedDate,
    { additions: node?.additions, deletions: node?.deletions, authoredAt: node?.author?.date }) ?? [])]))
}

// The history from each of `starts`, a page of each, kept (`pages`), or read
// and then kept by its top; glued on to it, the pages kept that start at a
// parent of a commit listed not listed, or at a commit listed, the oldest
// first (where each goes on furthest), GLUE_LOOKUP looked up at a time, and
// those that start where those go on, till HISTORY_GLUED are listed. The
// pages from `starts` are listed whole, however many that is (all branches'
// first, as many as ALL_BRANCHES of them): the cap is gluing's. Each commit
// once, whether any goes on past those listed (`more`), and how many pages
// were read of GitHub (`read`).
export async function historyFrom(fullName: string, token: string | null, starts: string[], pages: HistoryPages, fetchImpl: typeof fetch = globalThis.fetch) {
  const kept = await pages.read(starts)
  const unread = starts.filter(top => !kept.has(top))
  const read = unread.length > 0 ? await readPages(fullName, token, unread, fetchImpl) : new Map<string, HistoryCommit[]>()
  // Kept only as GitHub listed it from its top: none for a commit it named nothing of.
  await Promise.all([...read].flatMap(([top, commits]) => commits[0]?.sha === top ? [pages.write(top, commits)] : []))
  const listed = new Map<string, HistoryCommit>()
  const add = (commits: HistoryCommit[]) => { for (const commit of commits) if (!listed.has(commit.sha)) listed.set(commit.sha, commit) }
  for (const top of starts) add(kept.get(top) ?? read.get(top) ?? [])
  const looked = new Set(starts)
  for (let round = 0; round < MAX_GLUE_ROUNDS && listed.size < HISTORY_GLUED; round++) {
    const parents = [...listed.values()].flatMap(commit => commit.parents.filter(parent => !listed.has(parent)))
    const tops = [...new Set([...parents, ...[...listed.keys()].toReversed()])].filter(sha => !looked.has(sha)).slice(0, GLUE_LOOKUP)
    if (tops.length === 0) break
    for (const sha of tops) looked.add(sha)
    const glued = await pages.read(tops)
    for (const commit of [...glued.values()].flat()) {
      if (listed.size >= HISTORY_GLUED) break
      if (!listed.has(commit.sha)) listed.set(commit.sha, commit)
    }
  }
  const commits = [...listed.values()]
  return { commits, more: commits.some(commit => commit.parents.some(parent => !listed.has(parent))), read: unread.length }
}

export type AllHeads = { heads: (HistoryRef & { at: number | null })[]; defaultBranch: string | null; tags: HistoryRef[]; cut: boolean }

// `--all`'s branches: the repository's, as many as MAX_HEAD_PAGES of them
// list, each with its tip's time, its default branch among them wherever its
// name sorts; its latest tags, each by the commit it tags; and whether
// branches past those listed are left out (`cut`).
export async function repositoryAllHeads(fullName: string, token: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<AllHeads> {
  const [owner, name] = fullName.split('/') as [string, string]
  const { heads, repository, cut } = await repositoryHeads(owner, name, token, fetchImpl)
  const defaultBranch = textOf(repository?.defaultBranchRef?.name, MAX_NAME)
  // The default branch, where its name sorts past the heads read.
  const defaultTip = repository?.defaultBranchRef?.target?.oid
  if (defaultBranch && typeof defaultTip === 'string' && SHA.test(defaultTip) && !heads.some(head => head.name === defaultBranch)) {
    heads.push({ name: defaultBranch, sha: defaultTip, at: timeOf(repository?.defaultBranchRef?.target?.committedDate) })
  }
  // A tag by the commit it tags, through the annotated tags between; one
  // ending at no commit names none.
  const tags = (repository?.tags?.nodes ?? []).flatMap(ref => {
    let target = ref?.target
    while (target?.__typename === 'Tag') target = target.target
    const sha = target?.__typename === 'Commit' ? target.oid : null
    return typeof ref?.name === 'string' && typeof sha === 'string' && SHA.test(sha) ? [{ name: ref.name.slice(0, MAX_NAME), sha }] : []
  })
  return { heads, defaultBranch, tags, cut }
}

// `--all`: the latest commits of the most recently committed to of `heads`
// (repositoryAllHeads), the default branch's among them, each commit once
// (historyFrom); the branches naming them and the latest tags; the branches
// not read, newest first, whose tips none of those is (`unread`), where
// reading on goes; whether branches past those listed are left out, never to
// be read (`cut`); and whether any is left out (`more`).
export async function repositoryAllHistory(fullName: string, token: string, { heads, defaultBranch, tags, cut }: AllHeads, pages: HistoryPages,
  fetchImpl: typeof fetch = globalThis.fetch) {
  const newest = heads.toSorted((a, b) => Number(b.name === defaultBranch) - Number(a.name === defaultBranch) || (b.at ?? 0) - (a.at ?? 0))
  const shown = newest.slice(0, ALL_BRANCHES)
  const read = await historyFrom(fullName, token, [...new Set(shown.map(head => head.sha))], pages, fetchImpl)
  const listed = new Set(read.commits.map(commit => commit.sha))
  const more = cut || heads.length > shown.length || read.more
  // Every branch naming a commit listed, those not read among them.
  const branches = heads.flatMap(({ name: branch, sha }) => listed.has(sha) ? [{ name: branch, sha }] : [])
  const unread = newest.slice(ALL_BRANCHES).filter(head => !listed.has(head.sha))
  return { commits: read.commits, branches, tags, defaultBranch, unread, cut, more }
}

// Where `--all` reads on from, as a request names them (`from`): as many
// commit ids, each once, as branches are read at first; null for none, or
// for one that isn't a commit id.
export function historyStarts(from: string): string[] | null {
  const starts = [...new Set(from.split(','))]
  return starts.length <= ALL_BRANCHES && starts.every(sha => SHA.test(sha)) ? starts : null
}
