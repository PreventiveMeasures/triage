// The code viewer's Pulse tab (render-bundle.js): how the repository moves,
// as the server reads it (GET /api/admin/repositories/pulse) for the week,
// month, quarter or year the reader picks, each a run of whole weeks to
// today as GitHub counts them (Sunday first, UTC). Its figures first, each
// beside what the same days of the week a period earlier gave, where
// counted by the day: the default branch's commits, who made them, the pull
// requests merged and the issues closed, the lines added and removed, and
// the share of commits an agent made or co-authored, or merged from an
// agent's pull request, where counted. Then the period alone, a column a
// day in a week or a month, else a week: commits, releases and those with
// agents apart,
// and lines added over removed, a week's
// days each its figures written on it, a column's figures and who made its
// commits shown as it is hovered or read with the keyboard, a click picking
// it for its contributors; the period's contributors ranked by their
// commits, one clicked the plots theirs alone; the pull requests merged or
// opened and the issues closed or opened in it, each opening its popup; and
// when in the week its commits are made. A year whose commits are not all read yet is asked for again, a
// second apart, as long as each answer reads more, and so the pull requests
// merged in it, for those from agents' branches; statistics GitHub is
// still computing, a few times, a while apart. What was read is kept a
// while, for the session that read it. Every answer holds the whole year,
// so a period read anew, or one whose year is being read again, is shown
// at once from the year last read, only its pull requests and issues
// waited for; with no year read yet, the last period read is shown, faded,
// till it is.
import { LitElement, html, nothing, svg } from 'lit'
import { styleMap } from './style-map.js'
import { state } from '#client/index.js'
import { fetchRepositoryPulse, fetchRepositoryPulseItems } from './client-managed.js'
import { compactTime } from './repository-history.js'
import { openRepositoryItemDialog } from './lazy-dialogs.js'
import { STATE_ICONS, icon, issueState, plainClick } from './repository-tiles.js'
import { PULSE_PERIODS, activityPicker, pickActivitySubtab, pulseWeeks, watchActivitySubtabs } from './repository-activity.js'
import { appUser, commitAgent, commitAuthor, commitAuthorName, githubUser } from './github-users.js'
import { heldRead } from './held-read.js'

const KEEP_MS = 5 * 60_000
const RETRY_MS = 30_000
// The year's commits not all read yet: asked again this long apart, as long
// as each answer reads more, else as many times as READING_STALLS. GitHub
// computing its statistics (of a year too large to read): asked again this
// long apart, this many times. Then left to the reader to ask again.
const READING_MS = 1_000
const READING_STALLS = 5
const PENDING_MS = 5_000
const PENDING_TRIES = 12
const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
const TOP_CONTRIBUTORS = 8
// Who made a column's commits, as many as its figures name.
const COLUMN_CONTRIBUTORS = 3
// The periods, each its weeks, its name, and the same days a period earlier.
const PERIODS = PULSE_PERIODS
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
// The punch card's rows, Monday first, the weekend under the working week.
const PUNCH_DAYS = [1, 2, 3, 4, 5, 6, 0]
const PUNCH_STEPS = 6

const reads = new Map()
// Each narrowing's pull requests and issues read (narrowedRead).
const narrowedReads = new Map()
const lastShown = new Map()
// Each repository's year last read, the answer holding it.
const lastYear = new Map()
const shownElements = new Set()
let keptFor = null
// The period shown, by its name, its route's sub-tab (repository-activity.js),
// a month where it names none; and the pull requests and issues the reader
// last picked.
const shownWeeks = pulseWeeks
const shownLists = { pulls: 'merged', issues: 'closed' }
// Each list: its title, and its kinds, each its name and GitHub's search.
const LISTS = {
  pulls: ['Pull requests', [['merged', 'Merged', 'is:pr is:merged merged:'], ['opened', 'Opened', 'is:pr created:']]],
  issues: ['Issues', [['closed', 'Closed', 'is:issue is:closed closed:'], ['created', 'Opened', 'is:issue created:']]],
}
const LIST_KINDS = ['merged', 'opened', 'closed', 'created']
// A commit's mark, as the activity tabs draw Commits'.
const COMMIT_ICON = icon(svg`<circle cx="8" cy="8" r="2.75"/><path d="M8 1v4.25M8 10.75V15"/>`)
// What a commit pushed directly is, each its mark's name: one with agents,
// one without, or a release, as the plots tell them.
const DIRECT_KINDS = { agent: 'Commit with agents', without: 'Commit without agents', release: 'Release' }
const DIRECT_SHOWN = 10
// A narrowing's most authors, as the server takes them.
const NARROWED_AUTHORS = 10

function sessionReads() {
  const session = state.managedSession ? `${state.managedSession.id}\0${state.managedSession.role}` : null
  if (session !== keptFor) {
    reads.clear()
    narrowedReads.clear()
    lastShown.clear()
    lastYear.clear()
    keptFor = session
  }
  return reads
}

const repaint = () => { for (const element of shownElements) element.requestUpdate() }
// Another period shown, as its route names it, Back giving one.
watchActivitySubtabs(tab => { if (tab === 'pulse') for (const element of shownElements) element.periodShown() })
const counted = value => Number.isSafeInteger(value) && value >= 0 ? value : 0

// The pull requests merged or opened, or issues closed or opened (`kind`),
// a server's answer tells: how many, as many a period earlier, and those it
// lists, each by number.
const toldOf = (answer, kind) => ({ count: counted(answer?.[kind]?.count), previous: Number.isSafeInteger(answer?.[kind]?.previous) ? answer[kind].previous : null,
  items: Array.isArray(answer?.[kind]?.items) ? answer[kind].items.filter(item => Number.isSafeInteger(item?.number) && typeof item.title === 'string') : [] })

// A server's answer, what it lists those it names by number and period.
function checked(answer) {
  if (!Number.isSafeInteger(answer?.since) || !PERIODS.some(([weeks]) => weeks === answer.weeks)) throw new Error('The server answered with no period.')
  const told = kind => toldOf(answer, kind)
  // A week's lines each day, where counted: seven `[added, removed]`; and
  // its releases and commits with agents each day, where counted.
  const dayLines = lines => Array.isArray(lines) && lines.length === 7 && lines.every(Array.isArray) ? lines.map(([added, removed]) => [counted(added), counted(removed)]) : null
  const dayCounts = days => Array.isArray(days) && days.length === 7 ? days.map(counted) : null
  const weeks = Array.isArray(answer.stats?.weeks) ? answer.stats.weeks.filter(week => Number.isSafeInteger(week?.week) && Array.isArray(week.days))
    .map(week => ({ ...week, dayLines: dayLines(week.dayLines), agentDays: dayCounts(week.agentDays), releaseDays: dayCounts(week.releaseDays),
      directDays: dayCounts(week.directDays) })) : []
  const stats = answer.stats && Array.isArray(answer.stats.weeks) && Array.isArray(answer.stats.contributors) && Array.isArray(answer.stats.punch) ? {
    weeks,
    contributors: answer.stats.contributors.filter(person => (typeof person?.login === 'string' || typeof person?.name === 'string') && Array.isArray(person.weeks))
      .map(person => ({ login: typeof person.login === 'string' ? person.login : null, id: Number.isSafeInteger(person.id) ? person.id : null,
        name: typeof person.name === 'string' ? person.name : null, weeks: person.weeks, days: Array.isArray(person.days) ? person.days : null })),
    punch: PUNCH_DAYS.map(day => Array.from({ length: 24 }, (_, hour) => counted(answer.stats.punch[day]?.[hour]))),
    periodPunch: answer.stats.periodPunch === true,
    // When from the year is counted whole, read no further back than a
    // period needed; null, all of it.
    from: Number.isSafeInteger(answer.stats.from) ? answer.stats.from : null,
    lines: typeof answer.stats.lines === 'boolean' ? answer.stats.lines : null,
    // Whether the commits agents took part in, and the releases, are counted,
    // each day of the year.
    agents: weeks.length > 0 && weeks.every(week => week.agentDays !== null),
    releases: weeks.length > 0 && weeks.every(week => week.releaseDays !== null),
    // And those pushed to the branch directly, each day, the latest listed.
    direct: weeks.length > 0 && weeks.every(week => week.directDays !== null) && Array.isArray(answer.stats.directCommits),
    directCommits: Array.isArray(answer.stats.directCommits) ? answer.stats.directCommits.filter(item => typeof item?.sha === 'string'
      && Number.isSafeInteger(item.at)).map(item => ({ sha: item.sha, at: item.at, subject: typeof item.subject === 'string' ? item.subject : '',
      login: typeof item.login === 'string' ? item.login : null, id: Number.isSafeInteger(item.id) ? item.id : null, name: typeof item.name === 'string' ? item.name : null,
      kind: typeof item.kind === 'string' && Object.hasOwn(DIRECT_KINDS, item.kind) ? item.kind : null }))
      : [],
  } : null
  return { weeks: answer.weeks, since: answer.since, merged: told('merged'), opened: told('opened'), closed: told('closed'), created: told('created'),
    stats, reading: Number.isSafeInteger(answer.reading) ? answer.reading : null, pulls: Number.isSafeInteger(answer.pulls) ? answer.pulls : null,
    pending: answer.pending === true }
}

// A period read, the last shown of its repository, and its year the last
// read where it holds one.
function keep(repoId, entry) {
  lastShown.set(repoId, entry)
  if (entry.answer.stats) lastYear.set(repoId, entry.answer)
}

// How far the year is read: its commits, or the pull requests updated in
// it (those merged in it among them), read so far; null, read whole.
const progress = answer => answer.reading ?? answer.pulls
// How long after an answer to ask again, and how many times: while the year
// is read, while GitHub computes its statistics; null, not again.
const waitFor = answer => progress(answer) === null ? answer.pending ? [PENDING_MS, PENDING_TRIES] : null : [READING_MS, READING_STALLS]

// The pulse of repository `repoId` over `weeks` weeks, as held, else read:
// `{ status }` 'loading', then 'ready' with its `answer`, or 'error' with its
// `error`; read again once old, or an error's retry is due, shown meanwhile
// (held-read.js). One whose year is not read whole yet, or whose statistics
// GitHub is still computing, is asked again (askAgain).
function pulseRead(repoId, weeks) {
  const key = `${repoId}\0${weeks}`
  return heldRead(sessionReads(), key, () => fetchRepositoryPulse(repoId, weeks).then(checked), {
    ready: answer => ({ status: 'ready', until: Date.now() + KEEP_MS, answer, tries: 0, asking: false }),
    settled: entry => {
      keep(repoId, entry)
      if (waitFor(entry.answer)) askAgain(key, entry, repoId, weeks, waitFor(entry.answer)[0])
    },
    failed: err => err?.name === 'AbortError' ? null : { status: 'error', until: Date.now() + RETRY_MS, error: err?.message || 'The repository’s pulse could not be read.' },
    retryMs: RETRY_MS, repaint,
  })
}

// The year, or GitHub's statistics, asked for again `wait` later, again and
// again as waitFor says: each time more of the year is read, as many times
// again; what else the pulse told shown meanwhile.
function askAgain(key, entry, repoId, weeks, wait) {
  entry.asking = true
  setTimeout(() => {
    if (sessionReads().get(key) !== entry) return
    fetchRepositoryPulse(repoId, weeks).then(checked).then(answer => {
      if (sessionReads().get(key) !== entry) return null
      const further = progress(answer) !== null && progress(entry.answer) !== null && progress(answer) > progress(entry.answer)
      entry.answer = answer
      entry.until = Date.now() + KEEP_MS
      entry.tries = further ? 0 : entry.tries + 1
      const next = waitFor(answer)
      if (next && entry.tries < next[1]) askAgain(key, entry, repoId, weeks, next[0])
      else entry.asking = false
      return null
    }, () => {
      entry.asking = false
      return null
    }).finally(repaint)
  }, wait)
}

// The period's pull requests and issues narrowed (`narrowing`: its days
// `from` to `to`, YYYY-MM-DD, none, on, and any of its `authors`' GitHub
// logins), as held, else read: `{ status }` 'loading', then 'ready' with its
// `answer`, each kind as toldOf tells it, or 'error' with its `error`; read
// again once old, or an error's retry is due, shown meanwhile (held-read.js).
function narrowedRead(repoId, weeks, narrowing) {
  sessionReads()
  const key = [repoId, weeks, narrowing.from, narrowing.to ?? '', narrowing.authors.join(',')].join('\0')
  return heldRead(narrowedReads, key, () => fetchRepositoryPulseItems(repoId, weeks, narrowing), {
    ready: answer => ({ status: 'ready', until: Date.now() + KEEP_MS, answer: Object.fromEntries(LIST_KINDS.map(kind => [kind, toldOf(answer, kind)])) }),
    failed: err => ({ status: 'error', until: Date.now() + RETRY_MS, error: err?.message || 'These couldn’t be read.' }),
    retryMs: RETRY_MS, repaint,
  })
}

// Whether a year's commits with agents are counted and any of them made with
// one: the plots split each column's, and the figures say their share.
const withAgents = stats => stats.agents === true && stats.weeks.some(week => week.agentDays.some(count => count > 0))
// Whether a year's releases are counted and it holds any: the plots set them
// apart.
const withReleases = stats => stats.releases === true && stats.weeks.some(week => week.releaseDays.some(count => count > 0))

// The commits weeks' days hold from `from` to `to` (both days, UTC): all
// of them, or `of` each week's, its `agentDays` those with agents.
const commitsBetween = (weeks, from, to, of = 'days') => weeks.reduce((sum, week) => sum + week[of].reduce((days, count, day) => {
  const at = week.week + day * DAY_MS
  return at >= from && at <= to ? days + counted(count) : days
}, 0), 0)

// Where a period of `weeks` weeks starts, `now` in its last day, as the
// server counts it (repository-pulse.ts pulseSince): the Sunday (UTC) that
// many weeks back, this week the last of them.
export function periodSince(weeks, now = Date.now()) {
  const today = Math.floor(now / DAY_MS) * DAY_MS
  return today - new Date(today).getUTCDay() * DAY_MS - (weeks - 1) * WEEK_MS
}

// Whether a year's statistics are counted whole from `since` on: all of
// it, or read as far back.
export const wholeSince = (stats, since) => stats.from === null || stats.from === undefined || stats.from < since

// A period of `weeks` weeks as the year another answer holds (`year`) shows
// it, `own` its own answer where read: its pull requests and issues, none
// while it reads, and how its own year is read; when commits are made the
// other period's, said so (`otherPunch`).
export function withYear(own, year, weeks, now = Date.now()) {
  return { weeks, since: own?.since ?? periodSince(weeks, now), merged: own?.merged ?? null, opened: own?.opened ?? null, closed: own?.closed ?? null,
    created: own?.created ?? null, stats: { ...year.stats, otherPunch: year.weeks !== weeks }, reading: own?.reading ?? null, pulls: own?.pulls ?? null,
    pending: own?.pending ?? false }
}

// The period's figures, `now` in its last day: its commits, and those of the
// same days of the week a period earlier (a week's Sunday to Thursday beside
// the week before's), where the year's weeks reach that far back; those of
// each an agent made or co-authored, and the releases, where counted; its
// lines added and removed, where GitHub counts them; and how many made
// commits.
export function pulseSummary(answer, now = Date.now()) {
  const { stats, since } = answer
  if (!stats) {
    return { commits: null, previous: null, agents: null, previousAgents: null, releases: null, previousReleases: null, additions: null, deletions: null, authors: null }
  }
  const today = Math.floor(now / DAY_MS) * DAY_MS
  const back = answer.weeks * WEEK_MS
  const period = stats.weeks.filter(week => week.week >= since)
  const reaches = stats.weeks.length > 0 && stats.weeks[0].week <= since - back && wholeSince(stats, since - back)
  const lines = kind => stats.lines === true ? period.reduce((sum, week) => sum + counted(week[kind]), 0) : null
  return { commits: commitsBetween(stats.weeks, since, today), previous: reaches ? commitsBetween(stats.weeks, since - back, today - back) : null,
    agents: stats.agents ? commitsBetween(stats.weeks, since, today, 'agentDays') : null,
    previousAgents: stats.agents && reaches ? commitsBetween(stats.weeks, since - back, today - back, 'agentDays') : null,
    releases: stats.releases ? commitsBetween(stats.weeks, since, today, 'releaseDays') : null,
    previousReleases: stats.releases && reaches ? commitsBetween(stats.weeks, since - back, today - back, 'releaseDays') : null,
    additions: lines('additions'), deletions: lines('deletions'), authors: periodContributors(stats.contributors, since).length }
}

// Who a contributor the server counted is (`key`): an agent whichever of
// its identities, a user of the app whichever of their GitHub accounts
// committed, else their account, login or name.
export function contributorKey({ id = null, login, name }) {
  const agent = commitAgent(login, name)
  if (agent) return `agent:${agent}`
  const user = appUser(login)?.id
  if (user != null) return `user:${user}`
  if (id !== null) return `#${id}`
  return login ? `@${login.toLowerCase()}` : `=${name}`
}

// Who made commits from `since` till `until`, each by contributorKey, the
// most first: how many, and the lines they added and removed, by their days
// where the server counted them, else by their weeks (the two then a week's
// starts); each named by the first of their identities listed.
export function periodContributors(contributors, since, until = Number.POSITIVE_INFINITY) {
  const people = new Map()
  for (const contributor of contributors) {
    const { login, name } = contributor
    const key = contributorKey(contributor)
    people.set(key, (contributor.days ?? contributor.weeks).reduce((sum, [at, commits, additions, deletions]) => at >= since && at < until
      ? { ...sum, commits: sum.commits + counted(commits), additions: sum.additions + counted(additions), deletions: sum.deletions + counted(deletions) } : sum,
    people.get(key) ?? { key, login, name, commits: 0, additions: 0, deletions: 0 }))
  }
  return [...people.values()].filter(person => person.commits > 0)
    .toSorted((a, b) => b.commits - a.commits || (a.login ?? a.name).localeCompare(b.login ?? b.name))
}

// The year's statistics as one contributor's commits fill them (`key`,
// contributorKey): each week's commits and lines, and each day's and those
// with agents, releases and those pushed directly where the server counted
// their days (`byDays`), else none of
// a week's days.
export function contributorStats(stats, key) {
  const theirs = stats.contributors.filter(person => contributorKey(person) === key)
  const byDays = theirs.length > 0 && theirs.every(person => person.days)
  const weeks = stats.weeks.map(({ week }) => ({ week, days: Array.from({ length: 7 }, () => 0), dayLines: Array.from({ length: 7 }, () => [0, 0]),
    agentDays: Array.from({ length: 7 }, () => 0), releaseDays: Array.from({ length: 7 }, () => 0), directDays: Array.from({ length: 7 }, () => 0), commits: 0,
    additions: 0, deletions: 0 }))
  for (const [at, commits, additions, deletions, agents, releases, direct] of theirs.flatMap(person => byDays ? person.days : person.weeks)) {
    const week = weeks[Math.floor((at - (weeks[0]?.week ?? 0)) / WEEK_MS)]
    if (!week) continue
    week.commits += counted(commits)
    week.additions += counted(additions)
    week.deletions += counted(deletions)
    if (!byDays) continue
    const weekday = Math.floor((at - week.week) / DAY_MS)
    week.days[weekday] += counted(commits)
    week.dayLines[weekday] = [week.dayLines[weekday][0] + counted(additions), week.dayLines[weekday][1] + counted(deletions)]
    week.agentDays[weekday] += counted(agents)
    week.releaseDays[weekday] += counted(releases)
    week.directDays[weekday] += counted(direct)
  }
  const agents = stats.agents === true && byDays && theirs.every(person => person.days.every(row => row.length > 4))
  const releases = stats.releases === true && byDays && theirs.every(person => person.days.every(row => row.length > 5))
  const direct = stats.direct === true && byDays && theirs.every(person => person.days.every(row => row.length > 6))
  return { ...stats, weeks, agents, releases, direct, byDays }
}

// The commits pushed to the branch directly from `from` till `until`
// (`now` in the last day, none dated past it listed either), and of one
// contributor alone (`person`, by contributorKey) where one is: how many, by
// the days they were counted on, and the latest of them listed; null where
// they aren't counted.
export function directIn(stats, from, until, person = null, now = Date.now()) {
  const scope = person === null ? stats : contributorStats(stats, person)
  if (!stats?.direct || !scope.direct) return null
  const last = Math.min(until - DAY_MS, Math.floor(now / DAY_MS) * DAY_MS)
  const items = stats.directCommits.filter(item => item.at >= from && item.at < last + DAY_MS && (person === null || contributorKey(item) === person))
  return { count: commitsBetween(scope.weeks, from, last, 'directDays'), items }
}

// The period's columns, `now` in its last day: a day each in a week or a
// month, else a week each; each from when till when (`from`, `to`), its
// commits, its releases and, of the rest, those an agent made or co-authored
// (each null where not counted),
// the lines added and removed (null where they are not counted so, a day's
// where GitHub counts lines a week), and whether it is yet to come.
export function pulseColumns(answer, now = Date.now()) {
  const { stats, since, weeks: span } = answer
  const lines = stats.lines === true
  if (span > 4) {
    return stats.weeks.filter(week => week.week >= since).map(week => ({ from: week.week, to: week.week + WEEK_MS, day: false, commits: counted(week.commits),
      agents: stats.agents ? week.agentDays.reduce((sum, count) => sum + count, 0) : null,
      releases: stats.releases ? week.releaseDays.reduce((sum, count) => sum + count, 0) : null,
      additions: lines ? counted(week.additions) : null, deletions: lines ? counted(week.deletions) : null, future: false }))
  }
  const today = Math.floor(now / DAY_MS) * DAY_MS
  return Array.from({ length: span * 7 }, (_, at) => {
    const from = since + at * DAY_MS
    // The week the day is in, and which of its days it is.
    const week = stats.weeks.find(item => from >= item.week && from < item.week + WEEK_MS)
    const weekday = week ? Math.floor((from - week.week) / DAY_MS) : 0
    const added = lines ? week?.dayLines?.[weekday] ?? null : null
    return { from, to: from + DAY_MS, day: true, commits: counted(week?.days[weekday]), agents: stats.agents ? counted(week?.agentDays[weekday]) : null,
      releases: stats.releases ? counted(week?.releaseDays[weekday]) : null,
      additions: added?.[0] ?? null, deletions: added?.[1] ?? null, future: from > today }
  })
}

// Whose a column's commits are counted by: a day's by their days, where the
// server counted them, else its week's; from and till when, and whether its
// week's.
export function columnSpan(column, contributors) {
  if (!column.day || contributors.every(person => person.days)) return [column.from, column.to, false]
  const from = column.from - new Date(column.from).getUTCDay() * DAY_MS
  return [from, from + WEEK_MS, true]
}

// A scale for counts as high as `max`: its top and the ticks to it, a round
// step apart, three at most past naught.
export function niceScale(max) {
  if (!(max > 0)) return { top: 1, ticks: [0, 1] }
  const rough = max / 3
  const power = 10 ** Math.floor(Math.log10(rough))
  const step = Math.max(1, [1, 2, 5, 10].map(times => times * power).find(value => value >= rough))
  const top = Math.ceil(max / step) * step
  return { top, ticks: Array.from({ length: top / step + 1 }, (_, at) => at * step) }
}

const number = value => value.toLocaleString('en-US')
const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
const compact = value => compactNumber.format(value)
const plural = (count, one, many = `${one}s`) => `${number(count)} ${count === 1 ? one : many}`
const day = (at, year = false) => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...year ? { year: 'numeric' } : {}, timeZone: 'UTC' })
const isoDay = at => new Date(at).toISOString().slice(0, 10)
const otherYear = (at, now) => new Date(at).getUTCFullYear() !== new Date(now).getUTCFullYear()
// A period's days, the years named where they differ.
const rangeName = (since, now) => {
  const today = Math.floor(now / DAY_MS) * DAY_MS
  const years = otherYear(since, today)
  return since >= today ? day(today, years) : `${day(since, years)} – ${day(today, years)}`
}
// A column's day, or week, the year named where it is not this one's.
const columnName = (column, now) => column.day
  ? new Date(column.from).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...otherYear(column.from, now) ? { year: 'numeric' } : {}, timeZone: 'UTC' })
  : `Week of ${day(column.from, otherYear(column.from, now))}`
// A column's figures, in words: with agents, and releases, where the plots
// set them apart (`apart`).
const columnText = (column, now, apart = {}) => `${columnName(column, now)}: ${plural(column.commits, 'commit')}${apart.agents
  ? `, ${number(column.agents)} with agents` : ''}${apart.releases ? `, ${plural(column.releases, 'release')}` : ''}${column.additions === null ? ''
  : `, +${number(column.additions)} −${number(column.deletions)} lines`}`
// What names a column under the plots: in a week, each day; in a month, each
// week's Sunday; in a quarter, every other week; in a year, each month where
// it starts, January by its year.
function columnLabel(columns, at, span) {
  const date = new Date(columns[at].from)
  if (span === 1) return `${date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })} ${date.getUTCDate()}`
  if (span === 4) return date.getUTCDay() === 0 ? day(columns[at].from) : ''
  if (span === 13) return at % 2 === 0 ? day(columns[at].from) : ''
  const month = date.getUTCMonth()
  const starts = at === 0 ? columns.length > 3 && new Date(columns[3].from).getUTCMonth() === month : new Date(columns[at - 1].from).getUTCMonth() !== month
  return starts ? month === 0 ? String(date.getUTCFullYear()) : date.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) : ''
}
// A figure beside what the same days a period earlier gave, how much more
// or less where that was any.
const versus = (count, previous, before) => previous === null || count === null ? null
  : count === previous ? `Same as ${before}`
  : `${count > previous ? '↑' : '↓'}${previous > 0 ? ` ${Math.max(1, Math.round(Math.abs(count - previous) / previous * 100))}%` : ''} from ${number(previous)} ${before}`
// `part` of `whole`, in whole percents: none and all alone 0 and 100.
const share = (part, whole) => part === 0 ? 0 : part === whole ? 100 : Math.min(99, Math.max(1, Math.round(part / whole * 100)))
// What a year being read, or counted by GitHub, says as it is asked again
// and after: its commits read so far, or the pull requests updated in it;
// `latest`, the year shown meanwhile as it was before.
function waitingTexts(answer, latest = false) {
  const [what, shown] = latest ? ['latest ', ': the year shown is as it was before.'] : ['', '.']
  if (answer.reading !== null) {
    return [`Reading this repository’s ${what}commits… ${number(answer.reading)} of the last year so far`,
      `${number(answer.reading)} of this repository’s commits of the last year read so far${shown}`, 'Read on']
  }
  return answer.pulls === null
    ? [`GitHub is still counting this repository’s ${what}commits…`, `GitHub hasn’t counted this repository’s ${what}commits yet.`, 'Ask again']
    : [`Reading this repository’s pull requests… ${number(answer.pulls)} so far`,
      `${number(answer.pulls)} of this repository’s pull requests read so far${shown}`, 'Read on']
}
// A share beside the one the same days a period earlier gave.
const versusShare = (now, then, before) => now === then ? `Same as ${before}` : `${now > then ? '↑' : '↓'} from ${then}% ${before}`
// A profile link's mark, the page opening elsewhere.
const PROFILE_ICON = html`<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true"><path d="M3 13 13 3M5 3h8v8"/></svg>`
const profile = login => login.endsWith('[bot]') ? `https://github.com/apps/${encodeURIComponent(login.slice(0, -5))}` : `https://github.com/${encodeURIComponent(login)}`
// A contributor as the app shows them: an agent, a user of the app, else
// their login or name.
const contributor = person => person.login ? commitAuthor(person.login, person.name, person.login) : commitAuthor(null, person.name)

// The tab's body, for the repository a directory shown (`repository`, an
// entry's) is in, by its full name (`repo`, repository-code.js
// repositoryFullName, once known).
class RepositoryPulse extends LitElement {
  static properties = {
    repository: { attribute: false }, repo: { attribute: false },
    // The column pointed at or read with the keyboard (`typed`), and the one
    // picked for its contributors, by when it starts; all the contributors
    // shown, or the first of them; and the one whose commits alone the plots
    // show, by contributorKey, whatever the period.
    _column: { state: true }, _typed: { state: true }, _picked: { state: true }, _everyone: { state: true }, _person: { state: true },
    // All the commits pushed directly listed, or the first of them.
    _allDirect: { state: true },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.repository = null
    this.repo = null
    this._column = null
    this._typed = false
    this._picked = null
    this._everyone = false
    this._person = null
    this._allDirect = false
  }

  connectedCallback() {
    super.connectedCallback()
    shownElements.add(this)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    shownElements.delete(this)
  }

  // Another repository's pulse, none of its columns pointed at or picked,
  // its contributors the first of them, its plots everyone's: the element is
  // kept as the reader goes from one repository's to another's.
  willUpdate(changed) {
    if (!changed.has('repository') || changed.get('repository')?.repoId === this.repository?.repoId) return
    this._column = null
    this._picked = null
    this._everyone = false
    this._person = null
    this._allDirect = false
  }

  pick(weeks) {
    pickActivitySubtab(this.repository, 'pulse', PERIODS.find(([shown]) => shown === weeks)[1].toLowerCase())
    this.periodShown()
  }

  // Another period shown, picked or as its route names it: none of its
  // columns pointed at or picked, its contributors and the commits pushed
  // directly the first of them.
  periodShown() {
    this._column = null
    this._picked = null
    this._everyone = false
    this._allDirect = false
    this.requestUpdate()
  }

  showList(kind, shown) {
    shownLists[kind] = shown
    repaint()
  }

  // The shown period's year, or statistics, asked for anew, as many times
  // again.
  askAgain() {
    const { repoId } = this.repository
    const weeks = shownWeeks()
    const key = `${repoId}\0${weeks}`
    const entry = sessionReads().get(key)
    if (entry?.status !== 'ready' || entry.asking) return
    entry.tries = 0
    askAgain(key, entry, repoId, weeks, 0)
    repaint()
  }

  render() {
    if (!this.repository) return nothing
    const { repoId } = this.repository
    const weeks = shownWeeks()
    const entry = pulseRead(repoId, weeks)
    if (entry.status === 'ready') keep(repoId, entry)
    const now = Date.now()
    // The period's answer where it holds its year, counted whole as far back
    // as the period starts, else as the year last read shows it, where read
    // so far back; with none read, while it reads, the last period read,
    // faded.
    const own = entry.status === 'ready' ? entry.answer : null
    const year = lastYear.get(repoId)
    const answer = own?.stats && wholeSince(own.stats, own.since) ? own : year && entry.status !== 'error' && wholeSince(year.stats, periodSince(weeks, now))
      ? withYear(own, year, weeks, now) : own && { ...own, stats: null }
    const faded = !answer && entry.status === 'loading' ? lastShown.get(repoId) ?? null : null
    const shown = answer ? { answer, asking: entry.asking === true } : faded
    // The year shown while a later one is read, said at the bar's end.
    const updating = shown?.answer.stats && (progress(shown.answer) !== null || shown.answer.pending)
    return html`<div class="history-bar">
        ${activityPicker('pulse')}
        <div class="history-modes" role="group" aria-label="Period">
          ${PERIODS.map(([period, name]) => html`<button type="button" aria-pressed=${String(weeks === period)} @click=${() => this.pick(period)}>${name}</button>`)}
        </div>
        ${shown ? html`<span class="pulse-range">${rangeName(shown.answer.since, now)}</span>` : nothing}
        ${updating ? html`<span class="pulse-updating" role="status">${this.renderWaiting(shown, waitingTexts(shown.answer, true))}</span>` : nothing}
      </div>
      ${shown ? html`<div class=${`pulse-scroll${faded ? ' is-reading' : ''}`} aria-busy=${String(entry.status !== 'ready')}>${this.renderPulse(shown, now)}</div>`
        : entry.status === 'error' ? html`<div class="bundles-slide-placeholder is-error"><p role="alert">${entry.error}</p>
            <button type="button" @click=${() => { sessionReads().delete(`${repoId}\0${weeks}`); repaint() }}>Retry</button></div>`
        : html`<div class="bundles-slide-placeholder" role="status">Reading the repository’s pulse…</div>`}`
  }

  renderPulse(entry, now) {
    const { answer } = entry
    const before = PERIODS.find(([weeks]) => weeks === answer.weeks)[2]
    const summary = pulseSummary(answer, now)
    const narrowing = this.narrowing(answer, now)
    const counting = answer.stats ? null : answer.reading === null ? answer.pulls === null ? 'Counting…' : 'Reading pull requests…' : 'Reading commits…'
    const linesCounting = counting ?? (answer.stats?.lines === null ? 'Counting…' : null)
    // Pull requests merged or issues closed, beside those opened; none while
    // the period reads.
    const told = (label, kind, opened) => answer[kind] ? this.renderTile(label, number(answer[kind].count), versus(answer[kind].count, answer[kind].previous, before),
      `${number(answer[opened].count)} opened`) : this.renderTile(label, '–', 'Reading…', '')
    // The lists, three of them (commits pushed directly, and issues) a row
    // with when commits are made where the pulse is wide enough.
    const lists = this.renderLists(answer, narrowing, now)
    return html`<section class="pulse-tiles" aria-label="Figures">
        ${this.renderTile('Commits', summary.commits === null ? '–' : number(summary.commits), counting ?? versus(summary.commits, summary.previous, before), 'to the default branch')}
        ${this.renderTile('Contributors', summary.authors === null ? '–' : number(summary.authors), counting, 'who made them')}
        ${told('Pull requests merged', 'merged', 'opened')}
        ${told('Issues closed', 'closed', 'created')}
        ${answer.stats?.lines === false ? nothing : this.renderTile('Lines', summary.additions === null ? '–'
          : html`<span class="is-added">+${number(summary.additions)}</span> <span class="is-removed">−${number(summary.deletions)}</span>`, linesCounting,
        'added and removed', summary.additions === null ? nothing : this.renderRatio(summary.additions, summary.deletions))}
        ${summary.agents === null || !withAgents(answer.stats) ? nothing : this.renderAgentsTile(summary, before)}
      </section>
      <div class=${`pulse-grid${lists.length > 2 ? ' is-lists' : ''}`}>
        ${answer.stats ? html`${this.renderActivity(entry, now)}${this.renderContributors(answer, now)}`
          : html`<div class="pulse-pending pulse-wide" role="status">${this.renderWaiting(entry, waitingTexts(answer))}</div>`}
        ${lists}
        ${answer.stats ? this.renderPunch(answer.stats) : nothing}
      </div>`
  }

  // The share of the period's commits an agent took part in, beside the
  // same days a period earlier's, releases counted in neither.
  renderAgentsTile(summary, before) {
    const own = summary.commits - (summary.releases ?? 0)
    const earlier = summary.previous === null ? null : summary.previous - (summary.previousReleases ?? 0)
    const releases = summary.releases > 0 ? `, ${plural(summary.releases, 'release')} apart` : ''
    return this.renderTile(html`<span data-tooltip=${'Commits an agent made or co-authored, or merged from an agent’s branch or a pull request labelled for one; '
      + 'releases, tagged commits changing only package.json, lockfiles and changelogs, counted in neither'}>With agents</span>`,
    own === 0 ? '–' : `${share(summary.agents, own)}%`, summary.previousAgents === null || own === 0 || !earlier
      ? null : versusShare(share(summary.agents, own), share(summary.previousAgents, earlier), before),
    own === 0 ? `no commits${releases}` : `${number(summary.agents)} of ${plural(own, 'commit')}${releases}`)
  }

  // What a pulse waits for: while it is asked again, `asking`; after, `left`,
  // and a button asking again (`again`).
  renderWaiting(entry, [asking, left, again]) {
    return entry.asking ? asking : html`${left} <button type="button" class="history-link" @click=${() => this.askAgain()}>${again}</button>`
  }

  renderTile(label, value, note, detail, more = nothing) {
    return html`<div class="pulse-tile">
      <span class="pulse-tile-label">${label}</span>
      <span class="pulse-tile-value">${value}</span>
      ${more}
      <span class="pulse-tile-note">${note ?? detail}</span>
      ${note ? html`<span class="pulse-tile-note">${detail}</span>` : nothing}
    </div>`
  }

  // Lines added beside those removed, a bar each as long as its share.
  renderRatio(additions, deletions) {
    return additions + deletions === 0 ? nothing : html`<span class="pulse-ratio" aria-hidden="true">${[['is-added', additions], ['is-removed', deletions]]
      .map(([kind, count]) => count > 0 ? html`<span class=${kind} style=${styleMap({ '--share': `${count / (additions + deletions)}` })}></span>` : nothing)}</span>`
  }

  // The period alone, a column a day or a week: commits over a scale of
  // counts, those an agent made or co-authored atop the rest, releases at
  // their foot, where the year holds any, and under them lines added above
  // a line and removed below it, one scale for both; each column named under them, today's
  // marked. A week's days each their figures written on them; a month's
  // weekends shaded. A column pointed at, or read with the arrow keys, is
  // marked in both, its figures and who made its commits beside it; clicked,
  // or picked with Enter, it is the one the contributors are of, till it is
  // again, or Escape. A contributor picked, their commits alone, named over
  // them, till they are left; a day's where the server counted their days.
  renderActivity(entry, now) {
    const { answer } = entry
    const person = this._person === null ? null : answer.stats.contributors.find(item => contributorKey(item) === this._person) ?? null
    const stats = person ? contributorStats(answer.stats, this._person) : answer.stats
    const columns = pulseColumns({ ...answer, stats }, now)
    const unit = columns[0]?.day ? 'day' : 'week'
    const named = person ? commitAuthorName(person.login, person.name) : null
    const whose = person ? html`<span>a ${unit} by</span><button type="button" class="pulse-picked is-person" aria-label=${`${named}’s: show everyone’s`}
      @click=${() => this.showPerson(null)}>${contributor(person)}<span aria-hidden="true">×</span></button>` : html`<span>a ${unit}</span>`
    const empty = person && !stats.byDays && unit === 'day'
      ? 'GitHub counts each contributor’s commits a week, not a day, in a repository this large: the quarter and the year show theirs.'
      : columns.some(column => column.commits > 0) ? null : `No commits${person ? ` by ${named}` : ''} in the period.`
    if (empty) {
      return html`<figure class="pulse-panel pulse-activity"><figcaption class="pulse-head"><h3>Commits</h3>${whose}</figcaption>
        <p class="pulse-note">${empty}</p></figure>`
    }
    const commits = niceScale(Math.max(...columns.map(column => column.commits)))
    const lines = stats.lines === true && columns.every(column => column.additions !== null)
      ? niceScale(Math.max(...columns.flatMap(column => [column.additions, column.deletions]))) : null
    // Commits with agents apart wherever they are counted, the year holding
    // any: a period, or a contributor, with none all without; and releases
    // so too.
    const apart = { agents: withAgents(answer.stats) && columns.some(column => column.agents !== null),
      releases: withReleases(answer.stats) && columns.some(column => column.releases !== null) }
    const split = apart.agents || apart.releases
    const written = answer.weeks === 1
    const today = Math.floor(now / DAY_MS) * DAY_MS
    const at = columns[this._column] && !columns[this._column].future ? this._column : null
    const picked = columns.findIndex(column => column.from === this._picked)
    const column = (item, index, labelled, bars) => html`<span class=${`pulse-column${index === at ? ' is-at' : ''}${index === picked ? ' is-picked' : ''}${item.future
      ? ' is-future' : ''}${item.day && answer.weeks === 4 && [0, 6].includes(new Date(item.from).getUTCDay()) ? ' is-weekend' : ''}`} role=${labelled ? 'img' : nothing}
      aria-label=${labelled ? columnText(item, now, apart) : nothing} aria-hidden=${labelled ? nothing : 'true'}
      @pointerenter=${() => this.point(item.future ? null : index)} @click=${() => this.pickColumn(columns, index)}>${bars}</span>`
    // A day's figure written on its bar, in a week.
    const figure = (item, text) => written && !item.future ? html`<span class="pulse-figure">${text}</span>` : nothing
    const bar = (kind, value, parts = nothing) => html`<span class=${`pulse-bar${kind}`} style=${styleMap({ '--value': `${value}` })}>${parts}</span>`
    // Commits with agents atop a column's, those without them under them,
    // releases at its foot, as the legend names them left to right; commits
    // with agents not apart, the rest over releases.
    const parts = item => {
      const releases = apart.releases ? item.releases : 0
      const rest = item.commits - releases
      return [...apart.agents ? [['', item.agents], [' is-without', rest - item.agents]] : [['', rest]], [' is-release', releases]].map(([kind, count]) => count > 0
        ? html`<span class=${`pulse-part${kind}`} style=${styleMap({ '--part': `${count}` })}></span>` : nothing)
    }
    return html`<figure class=${`pulse-panel pulse-activity${written ? ' is-written' : ''}`} tabindex="0"
        aria-label=${`Commits${lines ? ' and lines' : ''} a ${unit}${person ? ` by ${named}` : ''}: the arrow keys read each ${unit}, Enter picks it for its contributors`}
        @keydown=${event => this.readColumns(event, columns)} @focus=${event => this.focusColumns(event, columns)} @blur=${() => this.point(null)}>
      <figcaption class="pulse-head"><h3>Commits</h3>${whose}${split ? html`<span class="pulse-legend">${apart.agents ? html`<span
        class="pulse-key"></span>With agents<span class="pulse-key is-without"></span>Without` : nothing}${apart.releases ? html`<span
        class="pulse-key is-release"></span>Releases` : nothing}</span>` : nothing}</figcaption>
      <div class="pulse-plots" @pointerleave=${() => this.point(null)}>
        <div class="pulse-plot">
          ${this.renderTicks(commits.ticks.map(tick => [tick / commits.top, compact(tick), tick === 0]))}
          <div class="pulse-columns">${columns.map((item, index) => column(item, index, true,
            html`${figure(item, number(item.commits))}${split ? bar(' is-split', item.commits / commits.top, parts(item)) : bar('', item.commits / commits.top)}`))}</div>
        </div>
        ${lines ? html`<div class="pulse-head is-sub"><h3>Lines</h3><span>added and removed a ${unit}</span>
            <span class="pulse-legend"><span class="pulse-key is-added"></span>Added<span class="pulse-key is-removed"></span>Removed</span></div>
          <div class="pulse-plot is-diverging">
            ${this.renderTicks([[1, `+${compact(lines.top)}`], [0.5, '0', true], [0, `−${compact(lines.top)}`]])}
            <div class="pulse-columns">${columns.map((item, index) => column(item, index, false, html`
              <span class="pulse-half">${figure(item, `+${compact(item.additions)}`)}${bar(' is-added', item.additions / lines.top)}</span>
              <span class="pulse-half is-below">${bar(' is-removed', item.deletions / lines.top)}${figure(item, `−${compact(item.deletions)}`)}</span>`))}</div>
          </div>` : stats.lines === false ? html`<p class="pulse-note">GitHub doesn’t count lines added and removed in a repository of 10,000 commits or more.</p>`
          : stats.lines === true ? html`<p class="pulse-note">GitHub counts this repository’s lines a week, not a day: the quarter and the year show them.</p>`
          : html`<p class="pulse-note" role="status">${this.renderWaiting(entry, ['GitHub is still counting lines added and removed…', 'GitHub hasn’t counted lines added and removed yet.', 'Ask again'])}</p>`}
        <div class=${`pulse-axis${written ? ' is-each' : ''}`} aria-hidden="true">${columns.map((item, index) => html`<span
          class=${item.future ? 'is-future' : item.day && item.from === today ? 'is-today' : ''}>${columnLabel(columns, index, answer.weeks)}</span>`)}</div>
        ${at === null ? nothing : this.renderTip(answer, columns, at, now, apart, !person)}
      </div>
      <span class="sr-only" aria-live="polite">${this._typed && at !== null ? columnText(columns[at], now, apart) : ''}</span>
    </figure>`
  }

  // A column's figures beside it, on the side with more room: its day or
  // week, its commits, those with agents and the releases where the plots
  // set them apart (`apart`), lines
  // and, where they are everyone's (`everyone`), who made the most of them
  // (its week's, where a day's are not counted).
  renderTip(answer, columns, at, now, apart, everyone) {
    const column = columns[at]
    const today = Math.floor(now / DAY_MS) * DAY_MS
    const [from, to, week] = columnSpan(column, answer.stats.contributors)
    const people = everyone ? periodContributors(answer.stats.contributors, from, to).slice(0, COLUMN_CONTRIBUTORS) : []
    const middle = (at + 0.5) / columns.length
    return html`<div class=${`pulse-tip${middle > 0.6 ? ' is-left' : ''}`} style=${styleMap({ '--x': `${middle}` })} aria-hidden="true">
      <span class="pulse-tip-when">${columnName(column, now)}${column.day ? column.from === today ? html` <span>today</span>` : nothing
        : now < column.to ? html` <span>so far</span>` : nothing}</span>
      <span class="pulse-tip-row"><span class=${`pulse-tip-key${apart.agents || apart.releases ? ' is-none' : ''}`}></span><strong>${number(column.commits)}</strong> ${
  column.commits === 1 ? 'commit' : 'commits'}</span>
      ${apart.agents ? html`<span class="pulse-tip-row"><span class="pulse-tip-key"></span><strong>${number(column.agents)}</strong> with agents</span>` : nothing}
      ${apart.releases ? html`<span class="pulse-tip-row"><span class="pulse-tip-key is-release"></span><strong>${number(column.releases)}</strong> ${column.releases === 1
        ? 'release' : 'releases'}</span>` : nothing}
      ${column.additions === null ? nothing : html`<span class="pulse-tip-row"><span class="pulse-tip-key is-added"></span><strong>+${number(column.additions)}</strong> added</span>
        <span class="pulse-tip-row"><span class="pulse-tip-key is-removed"></span><strong>−${number(column.deletions)}</strong> removed</span>`}
      ${people.length > 0 ? html`<span class="pulse-tip-people">${week ? html`<span class="pulse-tip-note">Its week’s</span>` : nothing}
        ${people.map(person => html`<span class="pulse-tip-person">${contributor(person)}<strong>${number(person.commits)}</strong></span>`)}</span>` : nothing}
    </div>`
  }

  point(at) {
    this._column = at
    this._typed = false
  }

  // A contributor clicked is the one whose commits alone the plots show;
  // again, or `key` null, everyone's are.
  showPerson(key) {
    this._person = key === this._person ? null : key
    this._column = null
    this._allDirect = false
  }

  // A column clicked, or picked with Enter, is the one the contributors are
  // of; again, none is.
  pickColumn(columns, at) {
    const column = columns[at]
    if (!column || column.future) return
    this._picked = this._picked === column.from ? null : column.from
    this._everyone = false
    this._allDirect = false
  }

  // The plots focused with the keyboard read the column picked, else the
  // latest.
  focusColumns(event, columns) {
    if (!event.target.matches?.(':focus-visible')) return
    const picked = columns.findIndex(column => column.from === this._picked)
    this._column = picked >= 0 ? picked : columns.findLastIndex(column => !column.future)
    this._typed = true
  }

  // The arrow keys read the column before or after, Home and End the first
  // and the latest; Enter, or Space, picks it; Escape leaves it.
  readColumns(event, columns) {
    const shown = columns.flatMap((column, at) => column.future ? [] : [at])
    if (shown.length === 0) return
    const picked = columns.findIndex(column => column.from === this._picked)
    const at = shown.indexOf(shown.includes(this._column) ? this._column : shown.includes(picked) ? picked : shown.at(-1))
    const to = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: shown.length - 1 }[event.key]
    if (to !== undefined) this._column = shown[Math.min(Math.max(to, 0), shown.length - 1)]
    else if (event.key === 'Enter' || event.key === ' ') {
      this._column = shown[at]
      this.pickColumn(columns, shown[at])
    } else if (event.key === 'Escape' && (this._picked !== null || this._column !== null)) {
      this._picked = null
      this._column = null
    } else return
    this._typed = true
    event.preventDefault()
  }

  // A plot's scale: a hairline at each tick, its label beside, naught's
  // the baseline.
  renderTicks(ticks) {
    return html`<div class="pulse-ticks" aria-hidden="true">${ticks.map(([at, label, zero]) => html`<span class=${zero ? 'is-zero' : nothing}
      style=${styleMap({ '--at': `${at}` })}><span>${label}</span></span>`)}</div>`
  }

  // Who made the period's commits, or the picked column's, the most first,
  // as many as eight, the rest a click away; each clicked, their commits
  // alone in the plots, the rest faded, till clicked again; their profile on
  // GitHub, where they have one, a link beside their name.
  renderContributors(answer, now) {
    const { contributors } = answer.stats
    const column = pulseColumns(answer, now).find(item => item.from === this._picked) ?? null
    const [from, to, week] = column ? columnSpan(column, contributors) : [answer.since, Number.POSITIVE_INFINITY, false]
    const people = periodContributors(contributors, from, to)
    const top = people[0]?.commits ?? 1
    const lines = answer.stats.lines === true
    const when = column ? week ? `Week of ${day(from, otherYear(from, now))}` : columnName(column, now) : null
    return html`<figure class="pulse-panel pulse-people">
      <figcaption class="pulse-head"><h3>Contributors</h3>${when
        ? html`<button type="button" class="pulse-picked" aria-label=${`${when}: show the whole period’s`} @click=${() => { this._picked = null; this._everyone = false }}>${when}<span
          aria-hidden="true">×</span></button>`
        : html`<span>by their commits in the period</span>`}</figcaption>
      ${people.length === 0 ? html`<p class="pulse-note">No commits ${column ? week || !column.day ? 'that week' : 'that day' : 'in the period'}.</p>` : html`<ol
        class=${`pulse-ranks${this._person === null ? '' : ' is-picking'}`}>${(this._everyone ? people : people.slice(0, TOP_CONTRIBUTORS)).map(person => html`<li
        class=${person.key === this._person ? 'is-person' : nothing}>
        <span class="pulse-rank-who"><button type="button" class="pulse-rank-name" aria-pressed=${String(person.key === this._person)}
          @click=${() => this.showPerson(person.key)}>${contributor(person)}</button>
          ${person.login ? html`<a class="pulse-rank-profile" href=${profile(person.login)} target="_blank" rel="noopener noreferrer"
            aria-label=${`${commitAuthorName(person.login, person.name)} on GitHub`}>${PROFILE_ICON}</a>` : nothing}</span>
        <span class="pulse-rank-bar"><span style=${styleMap({ '--value': `${person.commits / top}` })}></span><span class="pulse-rank-value">${number(person.commits)}</span></span>
        ${lines ? html`<span class="pulse-rank-lines"><span class="is-added">+${compact(person.additions)}</span> <span
          class="is-removed">−${compact(person.deletions)}</span></span>` : nothing}
      </li>`)}</ol>
      ${people.length > TOP_CONTRIBUTORS ? html`<button type="button" class="history-link pulse-more" @click=${() => { this._everyone = !this._everyone }}>${this._everyone
        ? 'Fewer' : `and ${plural(people.length - TOP_CONTRIBUTORS, 'more', 'more')}`}</button>` : nothing}`}
    </figure>`
  }

  // Commits by day of the week, a row each, Monday first, and hour, a cell
  // each, each a step darker or lighter the more it holds, as the scale
  // under them shows; an hour of none plain. The period's, where counted
  // from its commits; another period's faded, while the period reads.
  renderPunch(stats) {
    const { punch } = stats
    const most = Math.max(1, ...punch.flat())
    return html`<figure class=${`pulse-panel${stats.otherPunch ? ' is-reading' : ''}`} aria-busy=${String(stats.otherPunch === true)}>
      <figcaption class="pulse-head"><h3>When commits are made</h3><span>by day and hour, in each author’s own time zone${stats.periodPunch ? '' : ', not only the period’s'}</span></figcaption>
      <div class="pulse-punch">
        ${punch.map((hours, row) => html`<span class="pulse-punch-day">${DAYS[PUNCH_DAYS[row]].slice(0, 3)}</span>${hours.map((count, hour) => {
          const name = `${DAYS[PUNCH_DAYS[row]]}s, ${String(hour).padStart(2, '0')}:00–${String(hour + 1).padStart(2, '0')}:00: ${plural(count, 'commit')}`
          return html`<span class=${`pulse-cell is-${count === 0 ? 0 : Math.ceil(count / most * PUNCH_STEPS)}`} role="img" aria-label=${name} data-tooltip=${name}></span>`
        })}`)}
        <span></span>${Array.from({ length: 24 }, (_, hour) => html`<span class="pulse-punch-hour">${hour % 6 === 0 ? `${hour}h` : ''}</span>`)}
      </div>
      <div class="pulse-scale" aria-hidden="true">Fewer${Array.from({ length: PUNCH_STEPS }, (_, step) => html`<span class=${`pulse-cell is-${step + 1}`}></span>`)}More</div>
    </figure>`
  }

  // The pull requests, the commits pushed to the branch directly where the
  // period has any, and the issues, two at least: the issues, where the
  // period has none, left out beside commits pushed directly; still read,
  // shown. Which of them by the period's alone: a contributor or a column
  // picked narrows what each lists, never adds one or takes one away. Each
  // a panel of its own, for the grid to lay out by how many.
  renderLists(answer, narrowing, now) {
    const period = answer.stats ? directIn(answer.stats, answer.since, Number.POSITIVE_INFINITY, null, now) : null
    const commits = period !== null && period.count > 0
    const issues = answer.closed && answer.created ? answer.closed.count + answer.created.count : null
    const direct = commits && narrowing ? directIn(answer.stats, narrowing.since ?? answer.since, narrowing.until ?? Number.POSITIVE_INFINITY, narrowing.person ?? null, now)
      ?? { count: 0, items: [] } : period
    return [this.renderList(answer, 'pulls', narrowing), ...commits ? [this.renderDirect(direct, narrowing)] : [],
      ...commits && issues === 0 ? [] : [this.renderList(answer, 'issues', narrowing)]]
  }

  // The latest commits pushed to the branch directly, of the period or as
  // it is narrowed, so said beside the title, how many beside: each its
  // subject, short id, author and when, linking to it on GitHub; as many as
  // DIRECT_SHOWN, the rest a click away, none as narrowed so said; those
  // older than the server lists (the year's latest, as many as it lists, or
  // a shorter period's while this one reads), how many.
  renderDirect(direct, narrowing) {
    const repo = this.repo ?? this.repository.repo
    const who = narrowing?.who ? commitAuthorName(narrowing.who.login, narrowing.who.name) : null
    const narrowedTo = narrowing ? [who && `by ${who}`, narrowing.when].filter(Boolean).join(' ') : ''
    const scope = narrowing ? [who && `by ${who}`, narrowing.when ?? 'in the period'].filter(Boolean).join(' ') : 'in the period'
    const shown = this._allDirect ? direct.items : direct.items.slice(0, DIRECT_SHOWN)
    const unlisted = Math.max(0, direct.count - direct.items.length)
    return html`<section class="pulse-panel pulse-list" aria-label="Direct commits">
      <div class="pulse-head"><h3 data-tooltip="Commits pushed to the default branch, not merged from a pull request">Direct commits</h3>${narrowing
        ? html`<span class="pulse-narrowed">${narrowedTo}</span>` : nothing}<span class="pulse-count">${number(direct.count)}</span></div>
      ${direct.count === 0 ? html`<p class="pulse-note">None ${scope}.</p>` : html`<ol>${shown.map(item => html`<li><a class=${`pulse-item is-commit${item.kind ? ` is-${item.kind}` : ''}`}
        href=${repo ? `https://github.com/${repo}/commit/${item.sha}` : nothing} target="_blank" rel="noopener noreferrer"><span class="issue-state" role="img"
        aria-label=${item.kind ? DIRECT_KINDS[item.kind] : 'Commit'}>${COMMIT_ICON}</span>
        <span class="pulse-item-title">${item.subject || '(no message)'}</span>
        <span class="pulse-item-meta"><span>${item.sha.slice(0, 7)}</span><span>${contributor(item)}</span><time datetime=${new Date(item.at).toISOString()}>${compactTime(item.at)}</time></span>
      </a></li>`)}</ol>`}
      ${direct.items.length > DIRECT_SHOWN ? html`<button type="button" class="history-link pulse-more" @click=${() => { this._allDirect = !this._allDirect }}>${this._allDirect
        ? 'Fewer' : `and ${plural(direct.items.length - DIRECT_SHOWN, 'more', 'more')}`}</button>` : nothing}
      ${unlisted > 0 ? html`<p class="pulse-note">${direct.items.length > 0 ? plural(unlisted, 'older commit', 'older commits') : plural(unlisted, 'commit')} not listed.</p>`
        : nothing}
    </section>`
  }

  // What the pull requests, the commits pushed directly and the issues are
  // narrowed to, where a column or a contributor is picked: the column's
  // days (`from` to `to`, YYYY-MM-DD; no column, the period's on; `since`
  // till `until`, the same by time), named (`when`), and the contributor
  // (`person`, by contributorKey) and the GitHub accounts they committed as
  // (`authors`), them named (`who`), `nobody` where their commits name none;
  // null, neither picked.
  narrowing(answer, now) {
    const column = this._picked === null || !answer.stats ? null : pulseColumns(answer, now).find(item => item.from === this._picked) ?? null
    const people = this._person === null || !answer.stats ? null : answer.stats.contributors.filter(item => contributorKey(item) === this._person)
    if (!column && !people) return null
    const authors = [...new Set((people ?? []).flatMap(item => item.login ? [item.login] : []))].slice(0, NARROWED_AUTHORS)
    return { from: isoDay(column?.from ?? answer.since), to: column ? isoDay(column.to - DAY_MS) : null, authors, nobody: people !== null && authors.length === 0,
      who: people?.[0] ?? null, when: column ? column.day ? `on ${columnName(column, now)}` : `in the w${columnName(column, now).slice(1)}` : null,
      since: column?.from ?? answer.since, until: column?.to ?? Number.POSITIVE_INFINITY, person: people ? this._person : null }
  }

  // The latest pull requests merged or opened, or issues closed or opened,
  // as the reader picks, GitHub found in the period, or as it is narrowed
  // (narrowing), so said beside their title, each its state, title, number, author
  // and when, opening its popup; where there were more, the rest on GitHub,
  // narrowed alike. None, while the period, or the narrowing, reads; none
  // narrowed to a contributor whose commits name no GitHub account.
  renderList(answer, items, narrowing = null) {
    const [title, kinds] = LISTS[items]
    const [kind, , search] = kinds.find(([name]) => name === shownLists[items])
    const narrowed = narrowing && !narrowing.nobody ? narrowedRead(this.repository.repoId, answer.weeks, narrowing) : null
    const told = narrowing ? narrowed?.status === 'ready' ? narrowed.answer : null : answer
    const { count, items: listed } = told?.[kind] ?? { count: null, items: null }
    const repo = this.repo ?? this.repository.repo
    const range = narrowing ? narrowing.to === null ? `>=${narrowing.from}` : `${narrowing.from}..${narrowing.to}` : `>=${isoDay(answer.since)}`
    const by = (narrowing?.authors ?? []).map(login => ` author:${login.endsWith('[bot]') ? `app/${login.slice(0, -5)}` : login}`).join('')
    const all = repo ? `https://github.com/${repo}/${items === 'pulls' ? 'pulls' : 'issues'}?q=${encodeURIComponent(`${search}${range}${by}`)}` : null
    const who = narrowing?.who ? commitAuthorName(narrowing.who.login, narrowing.who.name) : null
    const scope = narrowing ? [who && `by ${who}`, narrowing.when ?? 'in the period'].filter(Boolean).join(' ') : 'in the period'
    // What they're narrowed to, beside the title, as the plots name theirs.
    const narrowedTo = narrowing ? [who && `by ${who}`, narrowing.when].filter(Boolean).join(' ') : ''
    return html`<section class="pulse-panel pulse-list" aria-label=${title}>
      <div class="pulse-head"><h3>${title}</h3>${narrowing ? html`<span class="pulse-narrowed">${narrowedTo}</span>` : nothing}
        <div class="history-modes" role="group" aria-label=${`${title} shown`}>${kinds.map(([name, label]) => html`<button type="button"
          aria-pressed=${String(name === kind)} @click=${() => this.showList(items, name)}>${label}<span class="n">${told?.[name] ? number(told[name].count)
            : '–'}</span></button>`)}</div>
      </div>
      ${narrowing?.nobody ? html`<p class="pulse-note">${who}’s commits name no GitHub account to find their ${title.toLowerCase()} by.</p>`
        : narrowed?.status === 'error' ? html`<p class="pulse-note" role="alert">${narrowed.error}</p>`
        : listed === null ? html`<p class="pulse-note" role="status">Reading…</p>` : listed.length === 0 ? html`<p class="pulse-note">None ${scope}.</p>` : html`<ol>${listed.map(item => {
        const [stateClass, stateName] = issueState(items, item)
        return html`<li><a class=${`pulse-item is-${stateClass}`} href=${repo ? `https://github.com/${repo}/${items === 'pulls' ? 'pull' : 'issues'}/${item.number}` : nothing}
          target="_blank" rel="noopener noreferrer" @click=${event => this.openItem(event, items, item)}>
          <span class="issue-state" role="img" aria-label=${stateName}>${STATE_ICONS[items][stateClass]}</span>
          <span class="pulse-item-title">${item.title || '(no title)'}</span>
          <span class="pulse-item-meta"><span>#${item.number}</span>${item.author ? html`<span>${githubUser(item.author)}</span>` : nothing}
            ${item.at == null ? nothing : html`<time datetime=${new Date(item.at).toISOString()}>${compactTime(item.at)}</time>`}</span>
        </a></li>`
      })}</ol>`}
      ${all && listed !== null && count > listed.length ? html`<a class="pulse-all" href=${all} target="_blank" rel="noopener noreferrer">All ${number(count)} on GitHub</a>` : nothing}
    </section>`
  }

  // An item clicked opens its popup (dialogs/repository-item-dialog.js),
  // what the list knew of it shown as the rest is read; held with a key, or
  // another button, it opens on GitHub.
  openItem(event, kind, item) {
    if (!plainClick(event)) return
    event.preventDefault()
    openRepositoryItemDialog({ repository: { ...this.repository, repo: this.repo ?? this.repository.repo },
      target: { number: item.number, preview: { ...item, kind, labels: [], comments: 0 } } })
  }
}
if (!customElements.get('repository-pulse')) customElements.define('repository-pulse', RepositoryPulse)
