// A repository's pull requests, the most recently updated first, as kept
// once for both of those that read them so (http.ts keptPulls): the Pulse,
// telling whose its year's commits are by those merged (agent-merges.ts
// agentMerges), and the Agents tab, its pages of them (repository-agents.ts
// agentPulls). Those updated since its year's start, a few queries an
// answer, the rest read by the next, and those updated since read as they
// are. Each kept as the Agents tab shows it (repository-agents.ts pull: the
// marks an agent left in its texts, never the texts) and, one merged, what
// it brought the default branch, as the Pulse tells it: an agent that
// commits as whoever ran it (Codex's own) leaves its commits no mark, its
// pull request's branch alone naming it (app-agents.ts
// AGENT_BRANCH_PREFIXES), or a label one who ran it gave it naming the agent
// (agent-tasks.ts labelAgents), as the Agents tab tells an agent's work; or
// its author, an account agents work as (github-agents.ts AGENT_OPERATED),
// or any GitHub App's bot.
import { type AgentPull, labelAgents } from '../common/managed/agent-tasks.ts'
import { GITHUB_AGENTS, agentOperated } from '../common/managed/github-agents.ts'
import { AGENT_BRANCH_PREFIXES } from './app-agents.ts'
import { AGENT_PULL_FIELDS, type PullNode, pull } from './repository-agents.ts'
import { githubGraphql } from './repository-history.ts'

// What the pull requests kept are read by, its version: bumped as what a
// page reads, or how one is told, changes, its pull requests read again
// (http.ts keptPulls keys them by AGENTS_READ_VERSION and the Pulse's
// PULSE_YEAR_VERSION too, as either changes how it tells an agent's).
export const PULLS_READ_VERSION = 1
// The pull requests read an answer, a page a query, as many queries as
// PULLS_QUERIES, the rest left for the next to ask; of each merged, as many
// of its latest commits as MERGED_COMMITS.
const PULLS_PAGE = 100
const PULLS_QUERIES = 5
const MERGED_COMMITS = 100
const LABEL_AGENTS = Object.keys(GITHUB_AGENTS)
const SHA = /^[a-f\d]{40}$/u

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0
const timeOf = (value: unknown) => {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isSafeInteger(at) ? at : null
}

// A pull request as read: its row on the Agents tab, and one merged, what
// it brought the default branch (`merged`).
export type KeptPull = AgentPull & { merged?: Merged }
// What a merged pull request brought: its merge commit (`sha`), when it was
// merged (`at`) and whether it was an agent's (agentPull); an agent's merged
// with a merge commit, which a year counts none of, its own commits too
// (`own`, its latest MERGED_COMMITS); and of one of more commits whose merge
// commit has one parent, its commits' subjects, the oldest first, for those
// it was rebased as to be told by (agent-merges.ts agentCommits), those of
// its empty commits left out, as a rebase leaves them, and how many more it
// had than those read (`more`).
export interface Merged { sha: string; at: number; agent: boolean; own?: string[]; subjects?: string[]; more?: number }
// The pull requests updated since a year's start (`since`) as read so far
// (readPulls), the most recently updated first; when the newest read was
// last updated, those updated since read again (`through`, null till all
// are read once), and where those read reach back no further than was
// needed, when the oldest of them was updated (`reach`); whether every one
// the repository has is read (`all`); and a read not finished: where it goes
// on (`after`), when the newest it began with was updated (`from`), the
// oldest it reads to (`stop`), how many it has read (`read`) and when the
// oldest of them was updated (`to`).
export interface PullList { pulls: KeptPull[]; since: number; through: number | null; reach?: number; all?: true
  next: { after: string; from: number; stop: number; read: number; to?: number } | null }

// Since when every pull request updated is read: all of them since the
// year's start, -∞; none yet, ∞.
export const pullsReadTo = (list: Pick<PullList, 'next' | 'reach'>) => list.next ? list.next.to ?? Number.POSITIVE_INFINITY : list.reach ?? Number.NEGATIVE_INFINITY

const PULLS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: ${PULLS_PAGE}, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { ${AGENT_PULL_FIELDS} mergedAt mergeCommit { oid parents { totalCount } }
        commits(last: ${MERGED_COMMITS}) { totalCount nodes { commit { oid messageHeadline changedFilesIfAvailable } } } }
    }
  }
}`
type MergedNode = PullNode & { mergedAt?: unknown; mergeCommit?: { oid?: unknown; message?: unknown; parents?: { totalCount?: unknown } | null } | null
  author?: PullNode['author'] & { __typename?: unknown }
  commits?: { totalCount?: unknown; nodes?: ({ commit?: { oid?: unknown; messageHeadline?: unknown; changedFilesIfAvailable?: unknown } | null } | null)[] } | null }
type PullsPage = { repository?: { pullRequests?: { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }; nodes?: (MergedNode | null)[] } | null } | null }

const agentBranch = (name: unknown) => typeof name === 'string' && AGENT_BRANCH_PREFIXES.some(prefix => name.startsWith(prefix))
// Whether a pull request is an agent's: by its branch, a label naming one,
// or its author, an account agents work as or a bot (GitHub's GraphQL API
// naming a bot by its app's login alone, its type telling it).
const agentPull = ({ headRefName, labels, author }: MergedNode) => agentBranch(headRefName)
  || labelAgents((labels?.nodes ?? []).map(label => label?.name), LABEL_AGENTS).length > 0 || author?.__typename === 'Bot'
  || agentOperated(typeof author?.login === 'string' ? author.login : null, Number.isSafeInteger(author?.databaseId) ? author!.databaseId as number : null)

// What a pull request merged brought (Merged); null for one not merged.
function mergedOf(node: MergedNode): Merged | null {
  const [at, sha] = [timeOf(node.mergedAt), node.mergeCommit?.oid]
  if (at === null || typeof sha !== 'string' || !SHA.test(sha)) return null
  const commits = (node.commits?.nodes ?? []).map(item => item?.commit)
  const merging = count(node.mergeCommit?.parents?.totalCount) > 1
  const copied = commits.filter(commit => commit?.changedFilesIfAvailable !== 0)
  // Of one of more commits than its latest read, how many more it had.
  const more = Math.max(0, count(node.commits?.totalCount) - commits.length)
  const subjects = !merging && (copied.length > 1 || more > 0) && copied.length > 0 && copied.every(commit => typeof commit?.messageHeadline === 'string')
    ? copied.map(commit => commit!.messageHeadline as string) : null
  const agent = agentPull(node)
  const own = agent && merging ? commits.flatMap(commit => typeof commit?.oid === 'string' && SHA.test(commit.oid) ? [commit.oid] : []) : []
  return { sha, at, agent, ...own.length > 0 ? { own } : {}, ...subjects ? { subjects, ...more > 0 ? { more } : {} } : {} }
}

// The most recently updated first, the higher number first of those
// updated together.
const newestFirst = (a: AgentPull, b: AgentPull) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || b.number - a.number

// The pull requests updated since `since`, read the most recently updated
// first (a pull request is updated when merged, or after), on from what was
// `kept`: till one updated before the year, or before the newest read before
// was, as many queries an answer as PULLS_QUERIES, a read not finished going
// on from where it was left by the next, or once those updated since `need`
// are all read; where those read reached no further back than they needed,
// and `need` is further, read again from the newest on, as far back as it
// needs. Each kept as last read, one updated before the year forgotten.
export async function readPulls(fullName: string, token: string, since: number, kept: PullList | null,
  fetchImpl: typeof fetch = globalThis.fetch, need = since): Promise<PullList> {
  const [owner, name] = fullName.split('/') as [string, string]
  const pulls = new Map((kept?.pulls ?? []).filter(item => (item.updatedAt ?? 0) >= since).map(item => [item.number, item]))
  // Every one read, as long as none was forgotten, the year begun since.
  const whole = kept?.all === true && pulls.size === kept.pulls.length
  const further = !kept?.next && kept?.reach !== undefined && kept.reach > need
  const stop = kept?.next?.stop ?? (further ? since : Math.max(since, kept?.through ?? since))
  const result = (through: number | null, next: PullList['next'], reach: number | undefined, all = whole): PullList => ({
    pulls: [...pulls.values()].toSorted(newestFirst), since, through, ...reach === undefined ? {} : { reach }, ...all ? { all: true as const } : {}, next })
  let { after = null, from = null, read = 0, to = null }: { after?: string | null; from?: number | null; read?: number; to?: number | null } = kept?.next ?? {}
  for (let queries = 0; queries < PULLS_QUERIES; queries++) {
    const page = (await githubGraphql(PULLS_QUERY, { owner, name, after }, token, fetchImpl) as PullsPage | null)?.repository?.pullRequests
    const end = page?.pageInfo?.hasNextPage !== true || typeof page.pageInfo.endCursor !== 'string'
    let crossed = false
    for (const node of page?.nodes ?? []) {
      const updated = timeOf(node?.updatedAt)
      if (!node || updated === null) continue
      if (updated < stop) { crossed = true; break }
      from ??= updated
      to = updated
      read++
      const row = pull(node)
      const merged = mergedOf(node)
      if (row) pulls.set(row.number, merged ? { ...row, merged } : row)
    }
    // Read as far back as it reads to: the year's start, every one since
    // read; else as far as those read before reached. Read to the last
    // the repository has, every one of them.
    if (crossed || end) return result(from ?? stop, null, stop > since ? kept?.reach : undefined, (end && !crossed) || (whole && stop > since))
    after = page!.pageInfo!.endCursor as string
    // Read as far back as `need`: finished, so far back, those updated
    // since read by the next as ever.
    if (need > since && to !== null && to < need) return result(Math.max(from ?? stop, kept?.through ?? Number.NEGATIVE_INFINITY), null, to)
  }
  return result(kept?.through ?? null, { after: after!, from: from ?? stop, stop, read, ...to === null ? {} : { to } }, kept?.reach)
}
