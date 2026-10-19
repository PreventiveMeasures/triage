// The commits agents' pull requests brought to a repository's default
// branch, for its Pulse (repository-pulse.ts commitStats): an agent that
// commits as whoever ran it (Codex's own) leaves its commits no mark, its
// pull request's branch alone naming it (app-agents.ts
// AGENT_BRANCH_PREFIXES), or a label one who ran it gave it naming the agent
// (agent-tasks.ts labelAgents), as the Agents tab tells an agent's work; or
// its author, an account agents work as (github-agents.ts AGENT_OPERATED),
// or any GitHub App's bot.
import { labelAgents } from '../common/managed/agent-tasks.ts'
import { GITHUB_AGENTS, agentOperated } from '../common/managed/github-agents.ts'
import { AGENT_BRANCH_PREFIXES } from './app-agents.ts'
import { type HistoryCommit, githubGraphql } from './repository-history.ts'

// The merged pull requests read an answer, a page a query, as many queries
// as MERGED_QUERIES, the rest left for the next to ask; of each, as many of
// its latest commits as MERGED_COMMITS.
const MERGED_PAGE = 100
const MERGED_QUERIES = 5
const MERGED_COMMITS = 100
// Of each, as many labels as MERGED_LABELS, GitHub's most a page, a label
// naming any agent the app knows making it an agent's.
const MERGED_LABELS = 100
// How long before or after a pull request rebased onto the branch was merged
// its copies are committed.
const REBASE_SKEW_MS = 10 * 60_000
const LABEL_AGENTS = Object.keys(GITHUB_AGENTS)
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
// it reads to (`stop`) and how many it has read (`read`). And of every pull
// request merged, an agent's or not, its merge commit and when (`pulls`),
// and one rebased so (`pullRebases`), for the commits pushed to the branch
// directly to be told (directCommits).
export interface AgentMerges { merges: [string, number][]; rebases: Rebase[]; through: number | null
  next: { after: string; from: number; stop: number; read: number } | null; pulls?: [string, number][]; pullRebases?: Rebase[] }
// A pull request rebased onto the branch: its last commit there, when it was
// merged, its latest commits' subjects, the oldest first, and how many more
// it had than those read (`more`).
type Rebase = [sha: string, at: number, subjects: string[], more?: number]

const MERGED_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: ${MERGED_PAGE}, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { updatedAt mergedAt headRefName author { __typename login ... on User { databaseId } } labels(first: ${MERGED_LABELS}) { nodes { name } }
        mergeCommit { oid parents { totalCount } }
        commits(last: ${MERGED_COMMITS}) { totalCount nodes { commit { oid messageHeadline changedFilesIfAvailable } } } }
    }
  }
}`
type MergedPage = { repository?: { pullRequests?: { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }
  nodes?: ({ updatedAt?: unknown; mergedAt?: unknown; headRefName?: unknown; author?: { __typename?: unknown; login?: unknown; databaseId?: unknown } | null
    labels?: { nodes?: ({ name?: unknown } | null)[] } | null
    mergeCommit?: { oid?: unknown; parents?: { totalCount?: unknown } | null } | null
    commits?: { totalCount?: unknown; nodes?: ({ commit?: { oid?: unknown; messageHeadline?: unknown; changedFilesIfAvailable?: unknown } | null } | null)[] } | null
  } | null)[] } | null } | null }
const agentBranch = (name: unknown) => typeof name === 'string' && AGENT_BRANCH_PREFIXES.some(prefix => name.startsWith(prefix))
type MergedNode = NonNullable<NonNullable<NonNullable<NonNullable<MergedPage['repository']>['pullRequests']>['nodes']>[number]>
// Whether a pull request is an agent's: by its branch, a label naming one,
// or its author, an account agents work as or a bot (GitHub's GraphQL API
// naming a bot by its app's login alone, its type telling it).
const agentPull = ({ headRefName, labels, author }: MergedNode) => agentBranch(headRefName)
  || labelAgents((labels?.nodes ?? []).map(label => label?.name), LABEL_AGENTS).length > 0 || author?.__typename === 'Bot'
  || agentOperated(typeof author?.login === 'string' ? author.login : null, Number.isSafeInteger(author?.databaseId) ? author!.databaseId as number : null)

// The commits the pull requests merged since `since` from an agent's branch,
// labelled for one, or opened by an account agents work as, brought: each its merge commit, a squash merge's one
// commit; where it was
// merged with a merge commit, which a year counts none of, its own commits,
// its latest MERGED_COMMITS; and of one of more commits whose merge commit
// has one parent, its commits' subjects, for those it was rebased as to be
// told by (agentCommits), those of its empty commits left out, as a rebase
// leaves them. Those merged are read the most recently updated
// first (a pull request is updated when merged, or after), on from what was
// `kept`: till one updated before the year, or before the newest read before
// was, as many queries an answer as MERGED_QUERIES, a read not finished
// going on from where it was left by the next; one read again whose label
// no longer names an agent, what it was read to bring forgotten.
export async function agentMerges(fullName: string, token: string, since: number, kept: AgentMerges | null,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<AgentMerges> {
  const [owner, name] = fullName.split('/') as [string, string]
  const merges = new Map((kept?.merges ?? []).filter(([, at]) => at >= since))
  const rebases = new Map((kept?.rebases ?? []).filter(([, at]) => at >= since).map(([sha, at, subjects, more = 0]) => [sha, [at, subjects, more] as const]))
  const pulls = new Map((kept?.pulls ?? []).filter(([, at]) => at >= since))
  const pullRebases = new Map((kept?.pullRebases ?? []).filter(([, at]) => at >= since).map(([sha, at, subjects, more = 0]) => [sha, [at, subjects, more] as const]))
  const stop = kept?.next?.stop ?? Math.max(since, kept?.through ?? since)
  const listed = (map: typeof rebases) => [...map].map(([sha, [at, subjects, more]]): Rebase => more > 0 ? [sha, at, subjects, more] : [sha, at, subjects])
  const result = (through: number | null, next: AgentMerges['next']): AgentMerges => ({ merges: [...merges], rebases: listed(rebases), through, next,
    pulls: [...pulls], pullRebases: listed(pullRebases) })
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
      if (!node || merged === null || merged < since || typeof merge !== 'string' || !SHA.test(merge)) continue
      const own = (node.commits?.nodes ?? []).map(item => item?.commit)
      const merging = count(node.mergeCommit?.parents?.totalCount) > 1
      const brought = [merge, ...merging ? own.map(commit => commit?.oid) : []].filter((oid): oid is string => typeof oid === 'string' && SHA.test(oid))
      const copied = own.filter(commit => commit?.changedFilesIfAvailable !== 0)
      // Of one of more commits than its latest read, how many more it had.
      const more = Math.max(0, count(node.commits?.totalCount) - own.length)
      const subjects = !merging && (copied.length > 1 || more > 0) && copied.length > 0 && copied.every(commit => typeof commit?.messageHeadline === 'string')
        ? copied.map(commit => commit!.messageHeadline as string) : null
      pulls.set(merge, merged)
      if (subjects) pullRebases.set(merge, [merged, subjects, more])
      // One an agent's no more, its label taken off (which updates it), what
      // it was read to bring none of an agent's.
      if (!agentPull(node)) {
        for (const oid of brought.filter(sha => merges.get(sha) === merged)) merges.delete(oid)
        if (rebases.get(merge)?.[0] === merged) rebases.delete(merge)
        continue
      }
      for (const oid of brought) merges.set(oid, merged)
      if (subjects) rebases.set(merge, [merged, subjects, more])
    }
    if (done) return result(from ?? stop, null)
    after = page!.pageInfo!.endCursor as string
  }
  return result(kept?.through ?? null, { after: after!, from: from ?? stop, stop, read })
}

// Whether two reads of the pull requests merged (agentMerges) bring the
// same commits, the agents' and every one's (`pulls`, `pullRebases`, which
// tell those pushed directly), whatever order each read them in.
export function sameMerges(a: AgentMerges, b: AgentMerges) {
  const sorted = (entries: unknown[] = []) => entries.map(entry => JSON.stringify(entry)).toSorted()
  const brought = (read: AgentMerges) => JSON.stringify([read.merges, read.rebases, read.pulls, read.pullRebases].map(sorted))
  return brought(a) === brought(b)
}

// A commit's subject as GitHub heads its message: whole, or, past what it
// shows, cut short before an ellipsis.
const headed = (subject: string, headline: string) => headline.endsWith('…') ? subject.startsWith(headline.slice(0, -1)) : subject === headline

// The commits of `commits` (a year's) the agents' pull requests brought
// (`read`, agentMerges): those it names, and of one rebased, its commits'
// copies, the last and those below it on their first parents, as long as
// each one's subject is that of one of its commits older than the last
// matched, as Commits tells a rebase (repository-squashes.ts squashedPulls),
// past those of its commits the rebase left none of (an empty one GitHub
// counted no files of), and, past them all, as many more as it had before
// its latest read; a squash merge's one commit alone, its subject the pull
// request's own.
export function agentCommits(read: AgentMerges, commits: HistoryCommit[]): Set<string> {
  const shas = new Set(read.merges.map(([sha]) => sha))
  const bySha = new Map(commits.map(commit => [commit.sha, commit]))
  for (const [last, merged, subjects, more = 0] of read.rebases) {
    let commit = bySha.get(last)
    let at = subjects.length - 1
    for (; commit && at >= 0; commit = bySha.get(commit.parents[0] ?? '')) {
      const [copied, upTo] = [commit, at]
      const found = subjects.findLastIndex((subject, index) => index <= upTo && headed(copied.subject, subject))
      if (found < 0) break
      shas.add(commit.sha)
      at = found - 1
    }
    // Each of its latest commits read copied, as many as it had before them
    // the commits below, on their first parents, as long as each was
    // committed as it was merged, as a rebase commits its copies: not past
    // its first, its empty ones, which a rebase leaves out, counted too.
    const copiedAsMerged = (when: number | null) => when !== null && Math.abs(when - merged) <= REBASE_SKEW_MS
    for (let rest = at < 0 ? more : 0; commit && rest > 0 && copiedAsMerged(commit.committedAt); rest--, commit = bySha.get(commit.parents[0] ?? '')) {
      shas.add(commit.sha)
    }
  }
  return shas
}

// The commits of `commits` (a year's, from the branch's `head`) pushed to
// it directly: on its first parents from the head, none a merge, none a
// pull request brought (`read.pulls`: its merge commit, a squash's one
// commit, or the copies of one rebased onto it, as agentCommits tells
// them); those a merge brought from its other parents, not.
export function directCommits(read: AgentMerges, commits: HistoryCommit[], head: string): Set<string> {
  const pulled = agentCommits({ ...read, merges: read.pulls ?? [], rebases: read.pullRebases ?? [] }, commits)
  const bySha = new Map(commits.map(commit => [commit.sha, commit]))
  const direct = new Set<string>()
  for (let commit = bySha.get(head); commit; commit = bySha.get(commit.parents[0] ?? '')) {
    if (commit.parents.length <= 1 && !pulled.has(commit.sha)) direct.add(commit.sha)
  }
  return direct
}
