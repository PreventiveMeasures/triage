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
import { type Coauthor, MAX_COAUTHORS, type Maker, coauthorsOf } from './commit-coauthors.ts'
import { GithubApiError, githubJson } from './github-app.ts'
import { type GraphActor, accountOf, commitAccount } from './github-accounts.ts'

export { ACTOR, type GraphAccount, type GraphActor, type NamedAccount, accountOf, actorOf, commitAccount } from './github-accounts.ts'

export const HISTORY_PAGE = 100
// The deepest page read, as far as Older commits goes.
export const MAX_HISTORY_PAGE = 100
// `--all`: the branches most recently committed to, of as many as fifty
// pages of them list, the latest commits of each (as many as a GraphQL connection
// gives), and the latest tags.
export const ALL_BRANCHES = 25
const MAX_HEAD_PAGES = 50
const ALL_DEPTH = 100
const ALL_TAGS = 100
const REF_TIPS = 100
const MAX_PARENTS = 8
const MAX_SUBJECT = 1000
const MAX_NAME = 256
const SHA = /^[a-f\d]{40}$/u

// A commit, its author by name and by their account's login and numeric id
// (`authorId`, absent from pages kept before it was read), its co-authors
// (coauthorsOf, absent from pages kept before they were read), with the lines
// it adds and removes and when it was authored in its author's own time zone
// (`authorZone`, minutes east of UTC), where GitHub's GraphQL API tells them
// (null where its REST API lists it).
export interface HistoryCommit { sha: string; parents: string[]; subject: string; authorName: string | null; authorLogin: string | null; authorId?: number | null
  coauthors?: Coauthor[]; committedAt: number | null; additions?: number | null; deletions?: number | null; authoredAt?: number | null; authorZone?: number | null }
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
// line, as `--oneline` shows, its author by name and account, and its
// co-authors (coauthorsOf, `listed` as GitHub's GraphQL API lists them); null
// for one GitHub names no commit id for. With `stats`, the GraphQL API's, its
// lines and its author's time.
function historyCommit(sha: unknown, parents: unknown[], message: unknown, author: Maker, committedAt: unknown,
  stats: { additions?: unknown; deletions?: unknown; authoredAt?: unknown } | null = null, listed: Maker[] | null = null): HistoryCommit | null {
  if (typeof sha !== 'string' || !SHA.test(sha)) return null
  const lines = stats ? { additions: lineCount(stats.additions), deletions: lineCount(stats.deletions), authoredAt: timeOf(stats.authoredAt),
    authorZone: zoneOf(stats.authoredAt) } : { additions: null, deletions: null, authoredAt: null, authorZone: null }
  return {
    sha,
    parents: parents.filter((parent): parent is string => typeof parent === 'string' && SHA.test(parent)).slice(0, MAX_PARENTS),
    subject: typeof message === 'string' ? message.replaceAll('\r\n', '\n').split('\n', 1)[0]!.trim().slice(0, MAX_SUBJECT) : '',
    authorName: textOf(author.name, MAX_NAME),
    authorLogin: author.account.login,
    authorId: author.account.id,
    coauthors: coauthorsOf(message, author, listed),
    committedAt: timeOf(committedAt),
    ...lines,
  }
}

type RestCommit = { sha?: unknown; parents?: { sha?: unknown }[]; author?: { login?: unknown; id?: unknown } | null
  commit?: { message?: unknown; author?: { name?: unknown; email?: unknown } | null; committer?: { date?: unknown } | null } }
const restCommit = (item: RestCommit) => historyCommit(item?.sha, Array.isArray(item?.parents) ? item.parents.map(parent => parent?.sha) : [],
  item?.commit?.message, { name: item?.commit?.author?.name, email: item?.commit?.author?.email, account: accountOf(item?.author) }, item?.commit?.committer?.date)

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
  const body = await githubJson('https://api.github.com/graphql', token, fetchImpl, 'POST', { query, variables }) as { data?: unknown; errors?: GraphqlError[] } | null
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
  // The pages kept of `first`; where none is, those of `then`, in one read
  // (`first` whether they are `first`'s). Without it, both are read together.
  readFirst?(first: string[], then: string[]): Promise<{ first: boolean; pages: Map<string, HistoryCommit[]> }>
  write(top: string, commits: HistoryCommit[]): Promise<void>
}

// What a commit is read by in GraphQL.
const COMMIT_FRAGMENT = `fragment historyCommit on Commit { oid message committedDate additions deletions author { name email date user { login databaseId } }
  authors(first: ${MAX_COAUTHORS + 1}) { nodes { name email user { login databaseId } } } parents(first: ${MAX_PARENTS}) { nodes { oid } } }`
// A query's variables `$<prefix><n>` of `type`, as many as `count`.
const variablesOf = (prefix: string, count: number, type: string) => Array.from({ length: count }, (_, at) => `$${prefix}${at}: ${type}`).join(', ')

// The latest commits of each tip, by its id, `b<n>` the `n`th's.
const historiesQuery = (count: number) => `query($owner: String!, $name: String!, ${variablesOf('o', count, 'GitObjectID!')}) {
  repository(owner: $owner, name: $name) {
    ${Array.from({ length: count }, (_, at) => `b${at}: object(oid: $o${at}) { ... on Commit { history(first: ${ALL_DEPTH}) { pageInfo { hasNextPage } nodes { ...historyCommit } } } }`).join('\n    ')}
  }
}
${COMMIT_FRAGMENT}`

type GraphCommit = { oid?: unknown; message?: unknown; committedDate?: unknown; additions?: unknown; deletions?: unknown
  author?: ({ name?: unknown; date?: unknown } & GraphActor) | null; authors?: { nodes?: (({ name?: unknown } & GraphActor) | null)[] } | null
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
  return new Map(tops.map((top, at) => [top, (data?.repository?.[`b${at}`]?.history?.nodes ?? []).flatMap(node => graphCommit(node) ?? [])]))
}

// Its authors past the first, the git author, GitHub lists from its
// `Co-authored-by:` trailers.
const graphCommit = (node: GraphCommit | null | undefined) => historyCommit(node?.oid, (node?.parents?.nodes ?? []).map(parent => parent?.oid),
  node?.message, { name: node?.author?.name, email: node?.author?.email, account: commitAccount(node?.author) }, node?.committedDate,
  { additions: node?.additions, deletions: node?.deletions, authoredAt: node?.author?.date },
  Array.isArray(node?.authors?.nodes) ? node.authors.nodes.slice(1).map(actor => ({ name: actor?.name, email: actor?.email, account: commitAccount(actor) })) : null)

// The history from each of `starts`, a page of each, kept (`pages`), or read
// and then kept by its top; glued on to it, the pages kept that start at a
// parent of a commit listed not listed, each adding commits none listed has,
// and, where any of those has none kept and readable, at a commit listed, the
// oldest first (where each goes on furthest; a page at a commit listed lists
// mostly commits listed already), GLUE_LOOKUP of each looked up at a time, in
// one read where none of those parents' is kept, else two, and
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
    const parents = [...new Set([...listed.values()].flatMap(commit => commit.parents.filter(parent => !listed.has(parent) && !looked.has(parent))))].slice(0, GLUE_LOOKUP)
    const within = [...listed.keys()].toReversed().filter(sha => !looked.has(sha)).slice(0, GLUE_LOOKUP)
    if (parents.length === 0 && within.length === 0) break
    // Without readFirst, GLUE_LOOKUP of both at once, the parents first.
    const asked = pages.readFirst ? null : [...parents, ...within].slice(0, GLUE_LOOKUP)
    let { first, pages: glued } = asked ? { first: false, pages: await pages.read(asked) } : await pages.readFirst!(parents, within)
    // A parent with no page kept, or none readable (one GitHub's REST API
    // listed, read with GraphQL), its line going on only by a page at a
    // commit listed: those read too, apart, the others' lines notwithstanding.
    if (first && glued.size < parents.length && within.length > 0) {
      glued = new Map([...glued, ...await pages.read(within)])
      first = false
    }
    // Those at commits listed, unread where a parent's answered, are looked up again.
    for (const sha of asked ?? (first ? parents : [...parents, ...within])) looked.add(sha)
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

// A pull request squashed into a commit of the default branch's history
// (`merge`): its number, the commit its head was at when merged (`head`,
// GitHub's own of it, which a branch reused or pushed over since never
// moves), and its own commits, the latest MAX_SQUASHED of them, `more`
// where it had more. Drawn as the merge it was, its commits on a lane of
// their own (repository-history.js).
export interface SquashedPull { merge: string; number: number; head: string; commits: HistoryCommit[]; more: boolean }
// The pull requests squashed into commits, kept by each commit (a merged pull
// request's commits never change); null for a commit none was.
export interface Squashes {
  read(shas: string[]): Promise<Map<string, SquashedPull | null>>
  write(sha: string, pull: SquashedPull | null): Promise<void>
}

const MAX_SQUASHED = 100
// Looked up of an answer's commits not yet kept, at most, the newest first;
// in queries of as many commits, or pull requests, as many at once.
export const MAX_SQUASH_LOOKUPS = 500
const SQUASH_COMMITS = 100
const SQUASH_PULLS = 20
const SQUASH_PARALLEL = 4

// The merged pull request that brought each commit in, `c<n>` the `n`th's.
const mergedPullsQuery = (count: number) => `query($owner: String!, $name: String!, ${variablesOf('o', count, 'GitObjectID!')}) {
  repository(owner: $owner, name: $name) {
    ${Array.from({ length: count }, (_, at) => `c${at}: object(oid: $o${at}) { ... on Commit { associatedPullRequests(first: 1) { nodes { number mergeCommit { oid } } } } }`).join('\n    ')}
  }
}`
// Each pull request's head when merged and its latest commits, `p<n>` the `n`th's.
const squashedQuery = (count: number) => `query($owner: String!, $name: String!, ${variablesOf('n', count, 'Int!')}) {
  repository(owner: $owner, name: $name) {
    ${Array.from({ length: count }, (_, at) => `p${at}: pullRequest(number: $n${at}) { headRefOid commits(last: ${MAX_SQUASHED}) { totalCount nodes { commit { ...historyCommit } } } }`).join('\n    ')}
  }
}
${COMMIT_FRAGMENT}`

type MergedPulls = { repository?: Record<string, { associatedPullRequests?: { nodes?: ({ number?: unknown; mergeCommit?: { oid?: unknown } | null } | null)[] } } | null> | null }
type SquashedPage = { repository?: Record<string, { headRefOid?: unknown; commits?: { totalCount?: unknown; nodes?: ({ commit?: GraphCommit | null } | null)[] } } | null> | null }

const chunked = <T>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, at) => items.slice(at * size, (at + 1) * size))
// `run` for each of `items`, as many at once as `parallel`.
async function eachOf<T>(items: T[], parallel: number, run: (item: T) => Promise<void>) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, async () => { while (next < items.length) await run(items[next++]!) }))
}
// A pull request or commit GitHub has none of, as one deleted: its field null.
const notFound = (error: GraphqlError) => error?.type === 'NOT_FOUND'

// The pull requests squashed into `commits`, a merged pull request's merge
// commit of one parent, not one rebased (its commits copied onto the branch,
// told by their subjects), kept by each commit (`squashes`), those not yet
// kept looked up with GraphQL, as many as MAX_SQUASH_LOOKUPS an answer.
export async function squashedPulls(fullName: string, token: string, commits: HistoryCommit[], squashes: Squashes,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<SquashedPull[]> {
  const [owner, name] = fullName.split('/') as [string, string]
  const single = commits.filter(commit => commit.parents.length === 1)
  const listed = new Map(commits.map(commit => [commit.sha, commit]))
  const kept = await squashes.read(single.map(commit => commit.sha))
  const unknown = single.filter(commit => !kept.has(commit.sha)).slice(0, MAX_SQUASH_LOOKUPS)
  const merged: { commit: HistoryCommit; number: number }[] = []
  const found = new Map<string, SquashedPull | null>()
  await eachOf(chunked(unknown, SQUASH_COMMITS), SQUASH_PARALLEL, async batch => {
    const data = await githubGraphql(mergedPullsQuery(batch.length), { owner, name, ...Object.fromEntries(batch.map((commit, at) => [`o${at}`, commit.sha])) },
      token, fetchImpl, notFound) as MergedPulls
    for (const [at, commit] of batch.entries()) {
      const node = data?.repository?.[`c${at}`]
      if (!node) continue
      const pull = node.associatedPullRequests?.nodes?.[0]
      const number = pull?.mergeCommit?.oid === commit.sha && Number.isSafeInteger(pull.number) && (pull.number as number) > 0 ? pull.number as number : null
      if (number === null) { found.set(commit.sha, null); await squashes.write(commit.sha, null) }
      else merged.push({ commit, number })
    }
  })
  await eachOf(chunked(merged, SQUASH_PULLS), SQUASH_PARALLEL, async batch => {
    const data = await githubGraphql(squashedQuery(batch.length), { owner, name, ...Object.fromEntries(batch.map(({ number }, at) => [`n${at}`, number])) },
      token, fetchImpl, notFound) as SquashedPage
    for (const [at, { commit, number }] of batch.entries()) {
      const node = data?.repository?.[`p${at}`]
      if (!node) continue
      const own = (node.commits?.nodes ?? []).flatMap(item => graphCommit(item?.commit) ?? [])
      const head = typeof node.headRefOid === 'string' && SHA.test(node.headRefOid) ? node.headRefOid : own.at(-1)?.sha
      // Fast-forwarded, its last commit the merge's own; or rebased, its
      // commits, more than one, copied onto the branch: the merge and those
      // below it on their first parents, by their subjects, its commits'
      // (one squashed is told by its commit's title too, by default, and
      // drawn as it was either way).
      const below = [commit]
      for (let next = listed.get(commit.parents[0] ?? ''); next && below.length < own.length; next = listed.get(next.parents[0] ?? '')) below.push(next)
      const copies = own.toReversed().slice(0, below.length).every((item, step) => below[step]!.subject === item.subject)
      // Its commits' copies as far as those listed go, but not all of them
      // listed: told, and kept, once they are.
      if (own.length > 1 && copies && below.length < own.length) continue
      const rebased = own.length > 1 && copies
      const squashed = head !== undefined && head !== commit.sha && own.length > 0 && !own.some(item => item.sha === commit.sha) && !rebased
      const pull = squashed ? { merge: commit.sha, number, head, commits: own, more: Number(node.commits?.totalCount) > own.length } : null
      found.set(commit.sha, pull)
      await squashes.write(commit.sha, pull)
    }
  })
  return single.flatMap(commit => kept.get(commit.sha) ?? found.get(commit.sha) ?? [])
}

// The open pull requests most recently updated, each by the commit its head
// is at, to name commits by.
const OPEN_PULLS = 100
const OPEN_PULLS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: ${OPEN_PULLS}, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number headRefOid } }
  }
}`
export async function openPullHeads(fullName: string, token: string, fetchImpl: typeof fetch = globalThis.fetch) {
  const [owner, name] = fullName.split('/') as [string, string]
  const data = await githubGraphql(OPEN_PULLS_QUERY, { owner, name }, token, fetchImpl) as
    { repository?: { pullRequests?: { nodes?: ({ number?: unknown; headRefOid?: unknown } | null)[] } } | null }
  return { pulls: (data?.repository?.pullRequests?.nodes ?? []).flatMap(node => Number.isSafeInteger(node?.number) && (node!.number as number) > 0
    && typeof node!.headRefOid === 'string' && SHA.test(node!.headRefOid) ? [{ number: node!.number as number, sha: node!.headRefOid }] : []) }
}

// Where `--all` reads on from, as a request names them (`from`): as many
// commit ids, each once, as branches are read at first; null for none, or
// for one that isn't a commit id.
export function historyStarts(from: string): string[] | null {
  const starts = [...new Set(from.split(','))]
  return starts.length <= ALL_BRANCHES && starts.every(sha => SHA.test(sha)) ? starts : null
}
