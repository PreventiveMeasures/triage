// The commits agents' pull requests brought to a repository's default
// branch, for its Pulse (repository-pulse.ts commitStats): an agent that
// commits as whoever ran it (Codex's own) leaves its commits no mark, its
// pull request's branch alone naming it (app-agents.ts
// AGENT_BRANCH_PREFIXES), as the Agents tab tells an agent's work.
import { AGENT_BRANCH_PREFIXES } from './app-agents.ts'
import { type HistoryCommit, githubGraphql } from './repository-history.ts'

// The merged pull requests read an answer, a page a query, as many queries
// as MERGED_QUERIES, the rest left for the next to ask; of each, as many of
// its latest commits as MERGED_COMMITS.
const MERGED_PAGE = 100
const MERGED_QUERIES = 5
const MERGED_COMMITS = 100
const SHA = /^[a-f\d]{40}$/u

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0
const timeOf = (value: unknown) => {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isSafeInteger(at) ? at : null
}

// The agents' pull requests merged since a year's start, as read so far
// (agentMerges): the commits each brought, and when it was merged; those
// rebased onto the branch by their last commit there, when merged, and
// their commits' subjects, the oldest first (agentCommits); when the newest
// read was last updated, those updated since read again (`through`, null
// till all are read once); and a read not finished: where it goes on
// (`after`), when the newest it began with was updated (`from`), the oldest
// it reads to (`stop`) and how many it has read (`read`).
export interface AgentMerges { merges: [string, number][]; rebases: [string, number, string[]][]; through: number | null
  next: { after: string; from: number; stop: number; read: number } | null }

const MERGED_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: ${MERGED_PAGE}, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { updatedAt mergedAt headRefName mergeCommit { oid parents { totalCount } } commits(last: ${MERGED_COMMITS}) {
        nodes { commit { oid messageHeadline changedFilesIfAvailable } } } }
    }
  }
}`
type MergedPage = { repository?: { pullRequests?: { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }
  nodes?: ({ updatedAt?: unknown; mergedAt?: unknown; headRefName?: unknown; mergeCommit?: { oid?: unknown; parents?: { totalCount?: unknown } | null } | null
    commits?: { nodes?: ({ commit?: { oid?: unknown; messageHeadline?: unknown; changedFilesIfAvailable?: unknown } | null } | null)[] } | null } | null)[] } | null } | null }
const agentBranch = (name: unknown) => typeof name === 'string' && AGENT_BRANCH_PREFIXES.some(prefix => name.startsWith(prefix))

// The commits the pull requests merged since `since` from an agent's branch
// brought: each its merge commit, a squash merge's one commit; where it was
// merged with a merge commit, which a year counts none of, its own commits,
// its latest MERGED_COMMITS; and of one of more commits whose merge commit
// has one parent, its commits' subjects, for those it was rebased as to be
// told by (agentCommits), those of its empty commits left out, as a rebase
// leaves them. Those merged are read the most recently updated
// first (a pull request is updated when merged, or after), on from what was
// `kept`: till one updated before the year, or before the newest read before
// was, as many queries an answer as MERGED_QUERIES, a read not finished
// going on from where it was left by the next.
export async function agentMerges(fullName: string, token: string, since: number, kept: AgentMerges | null,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<AgentMerges> {
  const [owner, name] = fullName.split('/') as [string, string]
  const merges = new Map((kept?.merges ?? []).filter(([, at]) => at >= since))
  const rebases = new Map((kept?.rebases ?? []).filter(([, at]) => at >= since).map(([sha, at, subjects]) => [sha, [at, subjects] as const]))
  const stop = kept?.next?.stop ?? Math.max(since, kept?.through ?? since)
  const result = (through: number | null, next: AgentMerges['next']): AgentMerges => ({ merges: [...merges],
    rebases: [...rebases].map(([sha, [at, subjects]]) => [sha, at, subjects]), through, next })
  let { after = null, from = null, read = 0 }: { after?: string | null; from?: number | null; read?: number } = kept?.next ?? {}
  for (let queries = 0; queries < MERGED_QUERIES; queries++) {
    const page = (await githubGraphql(MERGED_QUERY, { owner, name, after }, token, fetchImpl) as MergedPage | null)?.repository?.pullRequests
    let done = page?.pageInfo?.hasNextPage !== true || typeof page.pageInfo.endCursor !== 'string'
    for (const node of page?.nodes ?? []) {
      const updated = timeOf(node?.updatedAt)
      if (updated === null) continue
      if (updated < stop) { done = true; break }
      from ??= updated
      read++
      const [merged, merge] = [timeOf(node?.mergedAt), node?.mergeCommit?.oid]
      if (merged === null || merged < since || !agentBranch(node?.headRefName) || typeof merge !== 'string' || !SHA.test(merge)) continue
      const own = (node?.commits?.nodes ?? []).map(item => item?.commit)
      const merging = count(node?.mergeCommit?.parents?.totalCount) > 1
      for (const oid of [merge, ...merging ? own.map(commit => commit?.oid) : []]) if (typeof oid === 'string' && SHA.test(oid)) merges.set(oid, merged)
      const rebased = own.filter(commit => commit?.changedFilesIfAvailable !== 0)
      if (!merging && rebased.length > 1 && rebased.every(commit => typeof commit?.messageHeadline === 'string')) {
        rebases.set(merge, [merged, rebased.map(commit => commit!.messageHeadline as string)])
      }
    }
    if (done) return result(from ?? stop, null)
    after = page!.pageInfo!.endCursor as string
  }
  return result(kept?.through ?? null, { after: after!, from: from ?? stop, stop, read })
}

// A commit's subject as GitHub heads its message: whole, or, past what it
// shows, cut short before an ellipsis.
const headed = (subject: string, headline: string) => headline.endsWith('…') ? subject.startsWith(headline.slice(0, -1)) : subject === headline

// The commits of `commits` (a year's) the agents' pull requests brought
// (`read`, agentMerges): those it names, and of one rebased, its commits'
// copies, the last and those below it on their first parents, as long as
// their subjects are its commits', from its last back, as Commits tells a
// rebase (repository-history.ts squashedPulls); a squash merge's one commit
// alone, its subject the pull request's own.
export function agentCommits(read: AgentMerges, commits: HistoryCommit[]): Set<string> {
  const shas = new Set(read.merges.map(([sha]) => sha))
  const bySha = new Map(commits.map(commit => [commit.sha, commit]))
  for (const [last, , subjects] of read.rebases) {
    let commit = bySha.get(last)
    for (let at = subjects.length - 1; commit && at >= 0 && headed(commit.subject, subjects[at]!); at--) {
      shas.add(commit.sha)
      commit = bySha.get(commit.parents[0] ?? '')
    }
  }
  return shas
}
