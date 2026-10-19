// The commits agents' pull requests brought to a repository's default
// branch, for its Pulse (repository-pulse.ts commitStats), as the pull
// requests kept tell them (repository-pulls.ts readPulls: whose each is,
// and what one merged brought).
import type { PullList } from './repository-pulls.ts'
import type { HistoryCommit } from './repository-history.ts'

// How long before or after a pull request rebased onto the branch was merged
// its copies are committed.
const REBASE_SKEW_MS = 10 * 60_000

// The agents' pull requests merged since a year's start, as read so far
// (agentMerges): the commits each brought, and when it was merged; those
// rebased onto the branch by their last commit there, when merged, and
// their commits' subjects, the oldest first (agentCommits); and how far the
// pull requests are read, as the list tells (repository-pulls.ts PullList:
// `through`, `reach`, `next`). And of every pull request merged, an agent's
// or not, its merge commit, when and its number (`pulls`, by which the
// Commits tab tells those squashed too, http.ts pulseMerges; none of one
// kept before numbers were), and one rebased so (`pullRebases`), for the
// commits pushed to the branch directly to be told (directCommits).
export interface AgentMerges { merges: [string, number][]; rebases: Rebase[]; through: number | null; reach?: number
  next: { after: string; from: number; stop: number; read: number; to?: number } | null; pulls?: [sha: string, at: number, number?: number][]; pullRebases?: Rebase[] }
// A pull request rebased onto the branch: its last commit there, when it was
// merged, its latest commits' subjects, the oldest first, and how many more
// it had than those read (`more`).
type Rebase = [sha: string, at: number, subjects: string[], more?: number]

// What the pull requests merged since `since` of those read (`list`) brought:
// an agent's, its merge commit, a squash merge's one commit, and one merged
// with a merge commit, its own commits too; and every one's merge commit,
// those rebased by their commits' subjects.
export function agentMerges(list: PullList, since: number): AgentMerges {
  const merges = new Map<string, number>()
  const [rebases, pulls, pullRebases]: [Rebase[], [string, number, number][], Rebase[]] = [[], [], []]
  for (const { number, merged } of list.pulls) {
    if (!merged || merged.at < since) continue
    const { sha, at, subjects, more = 0 } = merged
    const rebase: Rebase | null = subjects ? more > 0 ? [sha, at, subjects, more] : [sha, at, subjects] : null
    pulls.push([sha, at, number])
    if (rebase) pullRebases.push(rebase)
    if (!merged.agent) continue
    for (const oid of [sha, ...merged.own ?? []]) merges.set(oid, at)
    if (rebase) rebases.push(rebase)
  }
  return { merges: [...merges], rebases, through: list.through, ...list.reach === undefined ? {} : { reach: list.reach }, next: list.next, pulls, pullRebases }
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
  const pulled = agentCommits({ ...read, merges: (read.pulls ?? []).map(([sha, at]) => [sha, at]), rebases: read.pullRebases ?? [] }, commits)
  const bySha = new Map(commits.map(commit => [commit.sha, commit]))
  const direct = new Set<string>()
  for (let commit = bySha.get(head); commit; commit = bySha.get(commit.parents[0] ?? '')) {
    if (commit.parents.length <= 1 && !pulled.has(commit.sha)) direct.add(commit.sha)
  }
  return direct
}
