// What the code viewer's Pulse tab shows of a repository
// (GET /api/admin/repositories/pulse): how its default branch moves, week by
// week over the last year, as GitHub's statistics give it (its commits each
// day, its lines added and removed, each contributor's commits and lines,
// and when in the week commits are made); and, since the start of the week
// `weeks` weeks back, and over the same days of the week `weeks` weeks
// earlier, the pull requests merged and opened and the issues closed and
// opened, how many and the latest of each. GitHub computes its statistics when first asked,
// answering 202 till they are: asked again a few times, then they are told
// pending (StatsPending), for the client to ask again.
import { GithubApiError, githubJson } from './github-app.ts'
import { githubGraphql } from './repository-history.ts'

export const PULSE_WEEKS = [1, 4, 13, 52]
const WEEK_MS = 7 * 24 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000
const MAX_CONTRIBUTORS = 100
const LISTED = 10
// Merged pull requests and closed issues are searched by when each was last
// updated, GitHub sorting by no merge or close: as many as this are read, and
// the latest merged or closed of them listed.
const SEARCHED = 50
const STATS_TRIES = 3
const STATS_WAIT_MS = 1500
const MAX_TITLE = 1000
const LOGIN = /^[A-Za-z\d][A-Za-z\d-]{0,38}(?:\[bot\])?$/u

// GitHub still computing a statistic, after asking again.
export class StatsPending extends Error {
  constructor() { super('github-stats-pending') }
}

export interface PulseWeek { week: number; days: number[]; commits: number; additions: number | null; deletions: number | null }
// A contributor's weeks, each `[week, commits, additions, deletions]`, those
// with any.
export interface PulseContributor { login: string; weeks: [number, number, number, number][] }
export interface PulseStats { weeks: PulseWeek[]; contributors: PulseContributor[]; punch: number[][]; lines: boolean }

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0
const timeOf = (value: unknown) => {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isSafeInteger(at) ? at : null
}
const loginOf = (author: { login?: unknown } | null | undefined) => typeof author?.login === 'string' && LOGIN.test(author.login) ? author.login : null
const repoApi = (fullName: string) => `https://api.github.com/repos/${fullName.split('/').map(encodeURIComponent).join('/')}`
const sleep = (ms: number) => new Promise(resolve => { setTimeout(resolve, ms) })

// One statistic: its rows once GitHub has computed it, 'pending' while it
// computes them (202), none for a repository with no commits (204, no body),
// 'too-large' where it counts none (lines past 10,000 commits, 422).
async function statistic(fullName: string, token: string | null, kind: string, fetchImpl: typeof fetch): Promise<unknown[] | 'pending' | 'too-large'> {
  let status = 0
  const answered: typeof fetch = async (input, init) => {
    const res = await fetchImpl(input, init)
    status = res.status
    return res
  }
  try {
    const data = await githubJson(`${repoApi(fullName)}/stats/${kind}`, token, answered)
    if (status === 202) return 'pending'
    if (!Array.isArray(data)) throw new GithubApiError(502, 'github-malformed')
    return data
  } catch (err) {
    if (status === 202) return 'pending'
    if (status === 204) return []
    if (err instanceof GithubApiError && err.message === 'github-status-422') return 'too-large'
    throw err
  }
}

type ActivityRow = { week?: unknown; days?: unknown; total?: unknown }
type ContributorRow = { author?: { login?: unknown } | null; weeks?: { w?: unknown; a?: unknown; d?: unknown; c?: unknown }[] }

// The default branch's statistics over the last year, a week a row, the
// oldest first: its commits each day (Sunday first, as GitHub counts weeks)
// and in all, its lines added and removed (null where GitHub counts none,
// `lines` false); its contributors (as many as MAX_CONTRIBUTORS, the most
// commits that year first) and their weeks; and its commits by day of the
// week and hour (`punch[day][hour]`).
export async function repositoryStats(fullName: string, token: string | null, fetchImpl: typeof fetch = globalThis.fetch,
  wait: (ms: number) => Promise<unknown> = sleep): Promise<PulseStats> {
  const kinds = ['commit_activity', 'code_frequency', 'contributors', 'punch_card']
  const read = new Map<string, unknown[] | 'pending' | 'too-large'>()
  for (let attempt = 0; attempt < STATS_TRIES; attempt++) {
    const pending = kinds.filter(kind => (read.get(kind) ?? 'pending') === 'pending')
    if (pending.length === 0) break
    if (attempt > 0) await wait(STATS_WAIT_MS * attempt)
    await Promise.all(pending.map(async kind => { read.set(kind, await statistic(fullName, token, kind, fetchImpl)) }))
  }
  const rows = (kind: string) => {
    const got = read.get(kind)
    if (got === 'pending' || got === undefined) throw new StatsPending()
    return got === 'too-large' ? null : got
  }
  const activity = (rows('commit_activity') ?? []) as ActivityRow[]
  const frequency = rows('code_frequency') as unknown[][] | null
  const contributors = (rows('contributors') ?? []) as ContributorRow[]
  const punchRows = (rows('punch_card') ?? []) as unknown[][]
  const lines = new Map((frequency ?? []).flatMap(row => Array.isArray(row) && Number.isSafeInteger(row[0])
    ? [[(row[0] as number) * 1000, [count(row[1]), count(Math.abs(Number(row[2])))]] as const] : []))
  const weeks = activity.flatMap(row => {
    if (!Number.isSafeInteger(row?.week)) return []
    const week = (row.week as number) * 1000
    const days = Array.from({ length: 7 }, (_, day) => count(Array.isArray(row.days) ? row.days[day] : 0))
    const [additions, deletions] = frequency ? lines.get(week) ?? [0, 0] : [null, null]
    return [{ week, days, commits: count(row.total), additions, deletions }]
  }).toSorted((a, b) => a.week - b.week)
  const first = weeks[0]?.week ?? Number.POSITIVE_INFINITY
  const year = contributors.flatMap(row => {
    const login = loginOf(row?.author)
    const theirs = (row?.weeks ?? []).flatMap(item => {
      const week = count(item?.w) * 1000
      const [commits, additions, deletions] = [count(item?.c), count(item?.a), count(item?.d)]
      return week >= first && commits + additions + deletions > 0 ? [[week, commits, additions, deletions] as [number, number, number, number]] : []
    })
    return login && theirs.length > 0 ? [{ login, weeks: theirs, commits: theirs.reduce((sum, item) => sum + item[1], 0) }] : []
  }).toSorted((a, b) => b.commits - a.commits).slice(0, MAX_CONTRIBUTORS).map(({ login, weeks: theirs }) => ({ login, weeks: theirs }))
  const punch = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))
  for (const row of punchRows) {
    if (Array.isArray(row) && Number.isSafeInteger(row[0]) && Number.isSafeInteger(row[1]) && punch[row[0] as number]?.[row[1] as number] !== undefined) {
      punch[row[0] as number]![row[1] as number] = count(row[2])
    }
  }
  return { weeks, contributors: year, punch, lines: frequency !== null }
}

// Where a period of `weeks` weeks starts, as GitHub's statistics count weeks:
// the Sunday (UTC) that many weeks back, this week the last of them.
export function pulseSince(weeks: number, now: number) {
  const today = Math.floor(now / DAY_MS) * DAY_MS
  const sunday = today - new Date(today).getUTCDay() * DAY_MS
  return sunday - (weeks - 1) * WEEK_MS
}

const SEARCH = (name: string, fragment: string, first = 0) => `${name}: search(type: ISSUE, query: $${name}, first: ${Math.max(first, 1)}) {
    issueCount${first > 0 ? ` nodes { ...${fragment} }` : ''}
  }`
const ACTIVITY_QUERY = `query($merged: String!, $mergedBefore: String!, $opened: String!, $openedBefore: String!,
  $closed: String!, $closedBefore: String!, $created: String!, $createdBefore: String!) {
  ${SEARCH('merged', 'pull', SEARCHED)}
  ${SEARCH('mergedBefore', 'pull')}
  ${SEARCH('opened', 'pull', LISTED)}
  ${SEARCH('openedBefore', 'pull')}
  ${SEARCH('closed', 'issue', SEARCHED)}
  ${SEARCH('closedBefore', 'issue')}
  ${SEARCH('created', 'issue', LISTED)}
  ${SEARCH('createdBefore', 'issue')}
}
fragment pull on PullRequest { number title pullState: state isDraft createdAt mergedAt author { login } }
fragment issue on Issue { number title issueState: state stateReason createdAt closedAt author { login } }`

type SearchNode = { number?: unknown; title?: unknown; pullState?: unknown; issueState?: unknown; isDraft?: unknown; stateReason?: unknown
  createdAt?: unknown; mergedAt?: unknown; closedAt?: unknown; author?: { login?: unknown } | null } | null
type Search = { issueCount?: unknown; nodes?: SearchNode[] } | null | undefined
const REASONS: Record<string, string> = { COMPLETED: 'completed', NOT_PLANNED: 'not-planned', DUPLICATE: 'duplicate' }

// An issue or pull request a search lists, as the popup's preview of it
// takes one, `at` when it was merged, opened or closed.
function listed(node: SearchNode, at: unknown) {
  if (!node || !Number.isSafeInteger(node.number) || (node.number as number) <= 0) return null
  const title = typeof node.title === 'string' ? node.title.trim().slice(0, MAX_TITLE) : ''
  const common = { number: node.number as number, title, author: loginOf(node.author), at: timeOf(at), createdAt: timeOf(node.createdAt) }
  return node.pullState === undefined
    ? { ...common, kind: 'issues', state: node.issueState === 'OPEN' ? 'open' : 'closed', reason: REASONS[String(node.stateReason)] ?? null }
    : { ...common, kind: 'pulls', state: node.pullState === 'MERGED' ? 'merged' : node.pullState === 'OPEN' ? 'open' : 'closed', draft: node.isDraft === true }
}

// The pull requests merged and opened and the issues closed and opened since
// the start of the week `weeks` weeks back (`since`), and over the same days
// of the week `weeks` weeks earlier (`previous`, its count: a week's Sunday to
// Thursday beside the week before's, not the days just before, whose days of
// the week differ), the latest of each listed, as many as LISTED: those
// opened as GitHub sorts them, those merged or closed the latest of the
// SEARCHED most recently updated, which are the latest of all where the
// period holds no more, or the last listed was merged or closed after the
// SEARCHED-th was last updated. A search counts by the day (UTC).
export async function repositoryActivity(fullName: string, token: string, weeks: number, now: number = Date.now(), fetchImpl: typeof fetch = globalThis.fetch) {
  const since = pulseSince(weeks, now)
  const back = weeks * WEEK_MS
  const day = (at: number) => new Date(at).toISOString().slice(0, 10)
  const current = `>=${day(since)}`
  const previous = `${day(since - back)}..${day(now - back)}`
  const repo = `repo:${fullName}`
  const asked = (what: string, range: string, sort: string) => `${repo} ${what}${range} sort:${sort}`
  const kinds = {
    merged: ['is:pr is:merged merged:', 'updated-desc'], opened: ['is:pr created:', 'created-desc'],
    closed: ['is:issue is:closed closed:', 'updated-desc'], created: ['is:issue created:', 'created-desc'],
  } as const
  const variables = Object.fromEntries(Object.entries(kinds).flatMap(([name, [what, sort]]) => [[name, asked(what, current, sort)],
    [`${name}Before`, asked(what, previous, sort)]]))
  const data = await githubGraphql(ACTIVITY_QUERY, variables, token, fetchImpl) as Record<string, Search> | null
  const at = { merged: 'mergedAt', opened: 'createdAt', closed: 'closedAt', created: 'createdAt' } as const
  const told = Object.fromEntries((Object.keys(kinds) as (keyof typeof kinds)[]).map(name => [name, {
    count: count(data?.[name]?.issueCount),
    previous: count(data?.[`${name}Before`]?.issueCount),
    items: (data?.[name]?.nodes ?? []).flatMap(node => listed(node, node?.[at[name]]) ?? []).toSorted((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, LISTED),
  }]))
  return { since, previousSince: since - back, ...told }
}
