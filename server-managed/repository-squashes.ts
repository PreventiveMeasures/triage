// The pull requests squashed into a repository's commits, as the code
// viewer's Commits tab draws them (repository-history.ts), each looked up
// with GraphQL once and kept by its commit.
import { COMMIT_FRAGMENT, type GraphCommit, type GraphqlError, type HistoryCommit, githubGraphql, graphCommit, inBatches, variablesOf } from './repository-history.ts'

const SHA = /^[a-f\d]{40}$/u

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
// in queries of as many commits, or pull requests (their commits' lines
// counted, as a history's are), as many at once.
export const MAX_SQUASH_LOOKUPS = 500
const SQUASH_COMMITS = 100
const SQUASH_PULLS = 5
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

// A pull request or commit GitHub has none of, as one deleted: its field null.
const notFound = (error: GraphqlError) => error?.type === 'NOT_FOUND'

// Each repository's lookup of squashed pull requests going on, by its full
// name: one at a time, those asking meanwhile waiting on it, and their
// commits it doesn't look up looked up once it is done.
const lookingUp = new Map<string, Promise<void>>()

// Whether `promise` settles within `ms`, waited on that long at most.
const within = (promise: Promise<unknown>, ms: number) => ms === Number.POSITIVE_INFINITY ? promise
  : new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    void promise.finally(() => { clearTimeout(timer); resolve() })
  })

// The pull requests squashed into `commits`, a merged pull request's merge
// commit of one parent, not one rebased (its commits copied onto the branch,
// told by their subjects), kept by each commit (`squashes`), those not yet
// kept looked up with GraphQL, as many as MAX_SQUASH_LOOKUPS an answer, each
// kept as it is found (lookUpSquashes). Answered with those kept once the
// repository's lookup is done, or `waitMs` on, that lookup going on behind:
// `behind`, one this started, for the caller to keep alive, and `pending`
// while one does. Another's lookup done within it, but not of all of these,
// those it left are looked up as this one's, within what is left of it.
export async function squashedPulls(fullName: string, token: string, commits: HistoryCommit[], squashes: Squashes,
  waitMs = Number.POSITIVE_INFINITY, fetchImpl: typeof fetch = globalThis.fetch): Promise<{ pulls: SquashedPull[]; pending: boolean; behind: Promise<void> | null }> {
  const single = commits.filter(commit => commit.parents.length === 1)
  const kept = await squashes.read(single.map(commit => commit.sha))
  let unknown = single.filter(commit => !kept.has(commit.sha))
  if (unknown.length === 0) return { pulls: single.flatMap(commit => kept.get(commit.sha) ?? []), pending: false, behind: null }
  const listed = new Map(commits.map(commit => [commit.sha, commit]))
  const deadline = Date.now() + waitMs
  const found = new Map<string, SquashedPull | null>()
  // Waited on, as long as is left, and those of `unknown` it kept found.
  const settle = async (looking: Promise<void>) => {
    await within(looking, Math.max(0, deadline - Date.now()))
    for (const [sha, pull] of await squashes.read(unknown.map(commit => commit.sha))) found.set(sha, pull)
    unknown = unknown.filter(commit => !found.has(commit.sha))
  }
  const another = lookingUp.get(fullName)
  if (another) await settle(another)
  let behind: Promise<void> | null = null
  if (!another || (unknown.length > 0 && !lookingUp.has(fullName))) {
    const lookup = lookUpSquashes(fullName, token, unknown.slice(0, MAX_SQUASH_LOOKUPS), listed, squashes, fetchImpl)
    const done: Promise<void> = lookup.catch(() => {}).finally(() => { if (lookingUp.get(fullName) === done) lookingUp.delete(fullName) })
    lookingUp.set(fullName, done)
    behind = lookup
    await settle(done)
  }
  return { pulls: single.flatMap(commit => kept.get(commit.sha) ?? found.get(commit.sha) ?? []), pending: lookingUp.has(fullName), behind }
}

// The pull requests squashed into `unknown`, of the commits `listed`, looked
// up, each kept as it is found (squashedPulls).
async function lookUpSquashes(fullName: string, token: string, unknown: HistoryCommit[], listed: Map<string, HistoryCommit>, squashes: Squashes,
  fetchImpl: typeof fetch) {
  const [owner, name] = fullName.split('/') as [string, string]
  const merged: { commit: HistoryCommit; number: number }[] = []
  await inBatches(unknown, SQUASH_COMMITS, SQUASH_PARALLEL, async batch => {
    const data = await githubGraphql(mergedPullsQuery(batch.length), { owner, name, ...Object.fromEntries(batch.map((commit, at) => [`o${at}`, commit.sha])) },
      token, fetchImpl, notFound) as MergedPulls
    for (const [at, commit] of batch.entries()) {
      const node = data?.repository?.[`c${at}`]
      if (!node) continue
      const pull = node.associatedPullRequests?.nodes?.[0]
      const number = pull?.mergeCommit?.oid === commit.sha && Number.isSafeInteger(pull.number) && (pull.number as number) > 0 ? pull.number as number : null
      if (number === null) await squashes.write(commit.sha, null)
      else merged.push({ commit, number })
    }
  })
  await inBatches(merged, SQUASH_PULLS, SQUASH_PARALLEL, async batch => {
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
      await squashes.write(commit.sha, squashed ? { merge: commit.sha, number, head, commits: own, more: Number(node.commits?.totalCount) > own.length } : null)
    }
  })
}
