// What the code viewer's Pulse tab shows of a repository
// (GET /api/admin/repositories/pulse): how its default branch moves, week by
// week over the last year: its commits each day, the lines they add and
// remove, those an agent made or co-authored, who made them and when in the
// week, counted from its commits as the Commits tab reads and keeps them
// (repository-history.ts historyFrom), so that only those not kept yet are
// read of GitHub, a few queries an answer, the client asking again for the
// rest; a year past YEAR_COMMITS is counted by GitHub's statistics instead,
// which GitHub computes when first asked and again once the default branch
// moves, answering 202 till they are (told pending, StatsPending, for the
// client to ask again). And, since
// the start of the week `weeks` weeks back, and over the same days of the
// week `weeks` weeks earlier, the pull requests merged and opened and the
// issues closed and opened, how many and the latest of each.
import { githubAgent } from '../common/managed/github-agents.ts'
import { GithubApiError, githubJson } from './github-app.ts'
import { ACTOR, type GraphAccount, type HistoryCommit, type HistoryPages, accountOf, actorOf, githubGraphql, historyFrom } from './repository-history.ts'

export const PULSE_WEEKS = [1, 4, 13, 52]
// What a year counted from its commits holds, its version: kept years of
// another are counted again.
export const PULSE_YEAR_VERSION = 4
const WEEK_MS = 7 * 24 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000
const MAX_CONTRIBUTORS = 100
const LISTED = 10
// Merged pull requests and closed issues are searched by when each was last
// updated, GitHub sorting by no merge or close: as many as this are read, and
// the latest merged or closed of them listed.
const SEARCHED = 50
// A year of more commits than this is counted by GitHub's statistics: read a
// page at a time, it would take a hundred queries. Of those not kept, as
// many queries are made an answer as YEAR_QUERIES, each reading on from as
// many commits as YEAR_STARTS.
export const YEAR_COMMITS = 10_000
const YEAR_QUERIES = 5
const YEAR_STARTS = 10
// Commits are read on from as far as this before the year, a commit's clock
// not always later than its parents': one dated before the year may have a
// parent dated in it.
const YEAR_SKEW_MS = 30 * DAY_MS
const MAX_TITLE = 1000
const SHA = /^[a-f\d]{40}$/u

// GitHub still computing a statistic.
export class StatsPending extends Error {
  constructor() { super('github-stats-pending') }
}

// A week: its commits each day (Sunday first) and in all, the lines they
// added and removed, and, counted from its commits, each day's lines
// (`dayLines`, `[added, removed]`) and the commits an agent made or
// co-authored each day (`agentDays`), which GitHub's statistics don't count.
export interface PulseWeek { week: number; days: number[]; commits: number; additions: number | null; deletions: number | null; dayLines?: [number, number][]
  agentDays?: number[] }
// A contributor, by their login and their account's numeric id (`id`, where
// GitHub named it), else by the name their commits carry, and their weeks,
// each `[week, commits, additions, deletions]`, those with any; counted from
// their commits, their days too, each `[day, commits, additions, deletions]`.
export interface PulseContributor { login: string | null; id?: number | null; name: string | null; weeks: [number, number, number, number][]
  days?: [number, number, number, number][] }
// Commits by day of the week and hour (`punch[day][hour]`, Sunday first), in
// each commit's own time zone, and, counted from its commits, each period's
// (`punches`, by its weeks); `lines` false where GitHub counts none, null
// while it is counting them.
export interface PulseStats { weeks: PulseWeek[]; contributors: PulseContributor[]; punch: number[][]; punches?: Record<number, number[][]>; lines: boolean | null }
// The lines added and removed a week, and each contributor's, as GitHub's
// statistics count them, `lines` false where it counts none.
export interface PulseLines { weeks: [number, number, number][]; contributors: { login: string; weeks: [number, number, number][] }[]; lines: boolean }
// The year's commits read so far: all of them (`commits`), else how many
// (`read`), and whether past YEAR_COMMITS (`tooMany`).
export type YearCommits = { complete: true; commits: HistoryCommit[] } | { complete: false; read: number; tooMany: boolean }

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0
const timeOf = (value: unknown) => {
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isSafeInteger(at) ? at : null
}
const repoApi = (fullName: string) => `https://api.github.com/repos/${fullName.split('/').map(encodeURIComponent).join('/')}`
const emptyPunch = () => Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0))

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

// `kinds` of GitHub's statistics, each asked once, together; any still
// computed, StatsPending.
async function statistics(fullName: string, token: string | null, kinds: string[], fetchImpl: typeof fetch) {
  const read = await Promise.all(kinds.map(kind => statistic(fullName, token, kind, fetchImpl)))
  if (read.includes('pending')) throw new StatsPending()
  return read.map(rows => rows === 'too-large' ? null : rows as unknown[])
}

type ActivityRow = { week?: unknown; days?: unknown; total?: unknown }
type ContributorRow = { author?: { login?: unknown; id?: unknown } | null; weeks?: { w?: unknown; a?: unknown; d?: unknown; c?: unknown }[] }

// The default branch's commits over the last year as GitHub's statistics
// count them, for a year past YEAR_COMMITS: a week a row, the oldest first,
// its commits each day (Sunday first) and in all; its contributors (as many
// as MAX_CONTRIBUTORS, the most commits that year first) and their weeks;
// and its commits by day of the week and hour, in each commit's own time
// zone. Lines are GitHub's to count apart (repositoryLines).
export async function repositoryStats(fullName: string, token: string | null, fetchImpl: typeof fetch = globalThis.fetch): Promise<PulseStats> {
  const [activityRows = null, contributorRows = null, punchRows = null] = await statistics(fullName, token, ['commit_activity', 'contributors', 'punch_card'], fetchImpl)
  const weeks = ((activityRows ?? []) as ActivityRow[]).flatMap(row => {
    if (!Number.isSafeInteger(row?.week)) return []
    const days = Array.from({ length: 7 }, (_, day) => count(Array.isArray(row.days) ? row.days[day] : 0))
    return [{ week: (row.week as number) * 1000, days, commits: count(row.total), additions: null, deletions: null }]
  }).toSorted((a, b) => a.week - b.week)
  const first = weeks[0]?.week ?? Number.POSITIVE_INFINITY
  const contributors = ((contributorRows ?? []) as ContributorRow[]).flatMap(row => {
    const { login, id } = accountOf(row?.author)
    const theirs = (row?.weeks ?? []).flatMap(item => {
      const week = count(item?.w) * 1000
      return week >= first && count(item?.c) > 0 ? [[week, count(item?.c), 0, 0] as [number, number, number, number]] : []
    })
    return login && theirs.length > 0 ? [{ login, id, name: null, weeks: theirs, commits: theirs.reduce((sum, item) => sum + item[1], 0) }] : []
  }).toSorted((a, b) => b.commits - a.commits).slice(0, MAX_CONTRIBUTORS).map(({ login, id, name, weeks: theirs }) => ({ login, id, name, weeks: theirs }))
  const punch = emptyPunch()
  for (const row of (punchRows ?? []) as unknown[][]) {
    if (Array.isArray(row) && Number.isSafeInteger(row[0]) && Number.isSafeInteger(row[1]) && punch[row[0] as number]?.[row[1] as number] !== undefined) {
      punch[row[0] as number]![row[1] as number] = count(row[2])
    }
  }
  return { weeks, contributors, punch, lines: null }
}

// The lines added and removed each week since `since`, and each
// contributor's, as GitHub's statistics count them; none, `lines` false,
// where it counts none (past 10,000 commits, where it counts each
// contributor's as none too).
export async function repositoryLines(fullName: string, token: string | null, since: number, fetchImpl: typeof fetch = globalThis.fetch): Promise<PulseLines> {
  const [frequency = null, contributorRows = null] = await statistics(fullName, token, ['code_frequency', 'contributors'], fetchImpl)
  if (frequency === null) return { weeks: [], contributors: [], lines: false }
  const weeks = frequency.flatMap(row => Array.isArray(row) && Number.isSafeInteger(row[0]) && (row[0] as number) * 1000 >= since
    ? [[(row[0] as number) * 1000, count(row[1]), count(Math.abs(Number(row[2])))] as [number, number, number]] : [])
  const contributors = ((contributorRows ?? []) as ContributorRow[]).flatMap(row => {
    const { login } = accountOf(row?.author)
    const theirs = (row?.weeks ?? []).flatMap(item => count(item?.w) * 1000 >= since && count(item?.a) + count(item?.d) > 0
      ? [[count(item?.w) * 1000, count(item?.a), count(item?.d)] as [number, number, number]] : [])
    return login && theirs.length > 0 ? [{ login, weeks: theirs }] : []
  })
  return { weeks, contributors, lines: true }
}

// The default branch's head, null for a repository with none.
export async function defaultHead(fullName: string, token: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<string | null> {
  const [owner, name] = fullName.split('/') as [string, string]
  const data = await githubGraphql('query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { defaultBranchRef { target { oid } } } }',
    { owner, name }, token, fetchImpl) as { repository?: { defaultBranchRef?: { target?: { oid?: unknown } | null } | null } | null } | null
  if (!data?.repository) throw new GithubApiError(404, 'github-not-found')
  const oid = data.repository.defaultBranchRef?.target?.oid
  return typeof oid === 'string' && SHA.test(oid) ? oid : null
}

// The commits from `head` made since `since`, as the Commits tab reads and
// keeps them (`pages`, historyFrom): on from the parents of those since (or
// as much as YEAR_SKEW_MS before), not yet listed, YEAR_STARTS at a time,
// till none is left; the pages kept read
// of the store, those not of GitHub, as many queries of them as
// YEAR_QUERIES, the rest left for the next to ask (`complete` false, how
// many are `read`); more than YEAR_COMMITS, too many (`tooMany`).
export async function yearCommits(fullName: string, token: string, head: string, since: number, pages: HistoryPages,
  fetchImpl: typeof fetch = globalThis.fetch): Promise<YearCommits> {
  const found = new Map<string, HistoryCommit>()
  const tried = new Set<string>()
  const within = (commit: HistoryCommit) => commit.committedAt === null || commit.committedAt >= since - YEAR_SKEW_MS
  const read = () => [...found.values()].filter(commit => commit.committedAt !== null && commit.committedAt >= since).length
  let queries = 0
  let starts = [head]
  while (starts.length > 0) {
    if (queries >= YEAR_QUERIES) return { complete: false, read: read(), tooMany: false }
    const batch = starts.slice(0, YEAR_STARTS)
    for (const sha of batch) tried.add(sha)
    const got = await historyFrom(fullName, token, batch, pages, fetchImpl)
    if (got.read > 0) queries++
    for (const commit of got.commits) if (!found.has(commit.sha)) found.set(commit.sha, commit)
    if (read() > YEAR_COMMITS) return { complete: false, read: read(), tooMany: true }
    starts = [...new Set([...found.values()].filter(within).flatMap(commit => commit.parents))].filter(sha => !found.has(sha) && !tried.has(sha))
  }
  return { complete: true, commits: [...found.values()].filter(commit => commit.committedAt !== null && commit.committedAt >= since) }
}

// Whether an agent made `commit` or co-authored it: its author one of
// GitHub's agents (common/managed/github-agents.ts githubAgent), or any of
// its co-authors an agent (commit-coauthors.ts coauthorsOf), as Commits
// marks them; or one an agent's pull request brought (`merges`,
// agent-merges.ts agentCommits).
const withAgent = (commit: HistoryCommit, merges: ReadonlySet<string>) => merges.has(commit.sha)
  || githubAgent(commit.authorLogin, commit.authorId ?? null, commit.authorName) !== null || (commit.coauthors ?? []).some(coauthor => coauthor.agent)

// The year from `first` (pulseSince(52, …)) of `commits`, as GitHub's
// statistics count them, merges left out: a week a row, its commits each day
// (UTC) and in all and the lines they added and removed, in all and each day,
// and those an agent made or co-authored, or merged from an agent's pull
// request (`merges`, withAgent), each day;
// its contributors,
// by account (its id, by the login it committed as first listed, the newest,
// whatever it was renamed from; a login's commits read before ids were, the
// one account's that committed as it, where only one did), else login, each
// matched as GitHub matches logins, regardless of case, else name (as many
// as MAX_CONTRIBUTORS, the most commits first),
// and their weeks and days; and its commits by day of the week and hour, in
// each author's own time zone (else UTC, where GitHub told none), the year's
// and each period's (PULSE_WEEKS, its last weeks).
export function commitStats(commits: HistoryCommit[], first: number, merges: ReadonlySet<string> = new Set()): PulseStats {
  const weeks = Array.from({ length: 52 }, (_, at) => ({ week: first + at * WEEK_MS, days: Array.from({ length: 7 }, () => 0), commits: 0, additions: 0, deletions: 0,
    dayLines: Array.from({ length: 7 }, () => [0, 0] as [number, number]), agentDays: Array.from({ length: 7 }, () => 0) }))
  type Counts = Map<number, [number, number, number]>
  const people = new Map<string, { login: string | null; logins: Set<string>; id: number | null; name: string | null; weeks: Counts; days: Counts; commits: number }>()
  const punches = Object.fromEntries(PULSE_WEEKS.map(span => [span, emptyPunch()]))
  const add = (counts: Counts, at: number, [made, added, removed]: [number, number, number]) => {
    const theirs = counts.get(at) ?? [0, 0, 0]
    counts.set(at, [theirs[0] + made, theirs[1] + added, theirs[2] + removed])
  }
  for (const commit of commits) {
    if (commit.parents.length > 1 || commit.committedAt === null || commit.committedAt < first) continue
    const at = Math.floor((commit.committedAt - first) / WEEK_MS)
    const week = weeks[at]
    if (!week) continue
    const [additions, deletions] = [commit.additions ?? 0, commit.deletions ?? 0]
    const weekday = new Date(commit.committedAt).getUTCDay()
    week.days[weekday]!++
    week.dayLines[weekday]![0] += additions
    week.dayLines[weekday]![1] += deletions
    week.commits++
    week.additions += additions
    week.deletions += deletions
    if (withAgent(commit, merges)) week.agentDays[weekday]!++
    const local = new Date(commit.authoredAt != null && commit.authorZone != null ? commit.authoredAt + commit.authorZone * 60_000 : commit.committedAt)
    for (const span of PULSE_WEEKS) if (at >= 52 - span) punches[span]![local.getUTCDay()]![local.getUTCHours()]!++
    const key = commit.authorLogin && commit.authorId != null ? `#${commit.authorId}` : commit.authorLogin ? `@${commit.authorLogin.toLowerCase()}`
      : commit.authorName ? `=${commit.authorName}` : null
    if (!key) continue
    const person = people.get(key) ?? { login: commit.authorLogin, logins: new Set<string>(), id: commit.authorId ?? null, name: commit.authorName,
      weeks: new Map(), days: new Map(), commits: 0 }
    if (commit.authorLogin) person.logins.add(commit.authorLogin.toLowerCase())
    add(person.weeks, week.week, [1, additions, deletions])
    add(person.days, Math.floor(commit.committedAt / DAY_MS) * DAY_MS, [1, additions, deletions])
    person.commits++
    people.set(key, person)
  }
  // A login one account committed as, those of its commits read before ids
  // were that account's; one more did, theirs apart, no one's.
  const accounts = Map.groupBy([...people.values()].filter(person => person.id !== null).flatMap(person => [...person.logins].map(login => ({ login, person }))),
    ({ login }) => login)
  for (const [key, person] of people) {
    const [owner, ...others] = person.login !== null && person.id === null ? accounts.get(person.login.toLowerCase()) ?? [] : []
    if (!owner || others.length > 0) continue
    const account = owner.person
    for (const [week, counts] of person.weeks) add(account.weeks, week, counts)
    for (const [day, counts] of person.days) add(account.days, day, counts)
    account.commits += person.commits
    people.delete(key)
  }
  const rows = (counts: Counts) => [...counts].toSorted(([a], [b]) => a - b).map(([at, [made, added, removed]]) => [at, made, added, removed] as [number, number, number, number])
  const contributors = [...people.values()].toSorted((a, b) => b.commits - a.commits).slice(0, MAX_CONTRIBUTORS).map(({ login, id, name, weeks: theirs, days }) => ({
    login, id, name, weeks: rows(theirs), days: rows(days) }))
  return { weeks, contributors, punch: punches[52]!, punches, lines: true }
}

// The year's statistics as a period of `weeks` weeks shows them: when its
// commits are made, the period's where they were counted from its commits
// (`periodPunch`), else the year's or more, as GitHub's statistics count it.
export function periodStats(stats: PulseStats, weeks: number) {
  const { punches, ...rest } = stats
  const punch = punches?.[weeks]
  return { ...rest, punch: punch ?? rest.punch, periodPunch: Boolean(punch) }
}

// GitHub's statistics of a year past YEAR_COMMITS (repositoryStats) with
// its `lines` added in, each week's and each contributor's, by login; null
// while GitHub is counting them, `lines` null.
export function withLines(stats: PulseStats, lines: PulseLines | null): PulseStats {
  if (!lines) return { ...stats, lines: null }
  if (!lines.lines) return { ...stats, lines: false }
  const weekly = new Map(lines.weeks.map(([week, additions, deletions]) => [week, [additions, deletions]]))
  const theirs = new Map(lines.contributors.map(person => [person.login, new Map(person.weeks.map(([week, additions, deletions]) => [week, [additions, deletions]]))]))
  return {
    ...stats,
    weeks: stats.weeks.map(week => ({ ...week, additions: weekly.get(week.week)?.[0] ?? 0, deletions: weekly.get(week.week)?.[1] ?? 0 })),
    contributors: stats.contributors.map(person => ({ ...person, weeks: person.weeks.map(([week, made]) => {
      const added = person.login ? theirs.get(person.login)?.get(week) : undefined
      return [week, made, added?.[0] ?? 0, added?.[1] ?? 0] as [number, number, number, number]
    }) })),
    lines: true,
  }
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
fragment pull on PullRequest { number title pullState: state isDraft createdAt mergedAt author { ${ACTOR} } }
fragment issue on Issue { number title issueState: state stateReason createdAt closedAt author { ${ACTOR} } }`

type SearchNode = { number?: unknown; title?: unknown; pullState?: unknown; issueState?: unknown; isDraft?: unknown; stateReason?: unknown
  createdAt?: unknown; mergedAt?: unknown; closedAt?: unknown; author?: GraphAccount } | null
type Search = { issueCount?: unknown; nodes?: SearchNode[] } | null | undefined
const REASONS: Record<string, string> = { COMPLETED: 'completed', NOT_PLANNED: 'not-planned', DUPLICATE: 'duplicate' }

// An issue or pull request a search lists, as the popup's preview of it
// takes one, `at` when it was merged, opened or closed.
function listed(node: SearchNode, at: unknown) {
  if (!node || !Number.isSafeInteger(node.number) || (node.number as number) <= 0) return null
  const title = typeof node.title === 'string' ? node.title.trim().slice(0, MAX_TITLE) : ''
  const author = actorOf(node.author)
  const common = { number: node.number as number, title, author: author.login, authorId: author.id, at: timeOf(at), createdAt: timeOf(node.createdAt) }
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
