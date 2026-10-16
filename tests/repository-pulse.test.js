import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import { templateText } from './_lit.js'

const state = {}
const requests = []
let answer = null
// What narrowed pull requests and issues were asked for, and answer them.
const narrowedRequests = []
let narrowedAnswer = () => new Promise(() => {})
// The app's users and agents an answer names kept as client-managed.js keeps them.
let knowing = read => read()
mock.module('../client/index.js', { exports: { state } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchRepositoryPulse(repoId, weeks) { requests.push([repoId, weeks]); return knowing(() => answer(repoId, weeks)) },
  fetchRepositoryHistory: () => new Promise(() => {}),
  fetchRepositoryPulseItems(repoId, weeks, narrowing) { narrowedRequests.push([repoId, weeks, narrowing]); return knowing(() => narrowedAnswer(repoId, weeks, narrowing)) },
} })
mock.module('../ui/view/repository-code.js', { exports: { navigateToRepositoryCode() {}, shownRevision: () => ({}) } })
const opened = []
mock.module('../ui/view/lazy-dialogs.js', { exports: { openRepositoryItemDialog(props) { opened.push(props) } } })
const { contributorStats, niceScale, periodContributors, pulseColumns, pulseSummary } = await import('../ui/view/repository-pulse.js')
const { knowGithubUsers, knowingGithubUsers } = await import('../ui/view/github-users.js')
knowing = knowingGithubUsers
const Pulse = customElements.get('repository-pulse')

const DAY = 86_400_000
const WEEK = 7 * DAY
// A Thursday, the month's period from the Sunday three weeks before the
// Sunday of its week.
const NOW = Date.UTC(2026, 9, 15, 12)
const SINCE = Date.UTC(2026, 8, 20)
const FIRST = SINCE - 48 * WEEK

let session = 0
beforeEach(() => {
  requests.length = 0
  opened.length = 0
  // A session of its own each, so nothing kept from another test answers.
  state.managedSession = { id: `s-${++session}`, role: 'admin' }
})

// The year's weeks, a commit a day, ten lines added and two removed a week,
// on its Sunday; two a day the week of Sep 6, and this week none after today.
const year = () => Array.from({ length: 52 }, (_, at) => {
  const week = FIRST + at * WEEK
  const days = week === Date.UTC(2026, 8, 6) ? Array.from({ length: 7 }, () => 2) : at === 51 ? [1, 1, 1, 1, 1, 0, 0] : Array.from({ length: 7 }, () => 1)
  return { week, days, commits: days.reduce((sum, count) => sum + count, 0), additions: 10, deletions: 2, dayLines: days.map((count, day) => day === 0 ? [10, 2] : [0, 0]) }
})
const punch = () => Array.from({ length: 7 }, (_, day) => Array.from({ length: 24 }, (__, hour) => day === 2 && hour === 14 ? 12 : day === 6 ? 0 : 1))
// Its contributors, by their weeks and days, as counted from its commits.
const stats = (more = {}) => ({ weeks: year(), contributors: [
  { login: 'ada', name: 'Ada', weeks: [[SINCE, 3, 30, 4], [SINCE + WEEK, 2, 5, 1], [SINCE - WEEK, 9, 9, 9]],
    days: [[SINCE, 3, 30, 4], [SINCE + WEEK + DAY, 2, 5, 1], [SINCE - WEEK, 9, 9, 9]] },
  { login: 'grace', name: null, weeks: [[SINCE - 2 * WEEK, 4, 1, 0]], days: [[SINCE - 2 * WEEK, 4, 1, 0]] },
  { login: 'claude[bot]', name: null, weeks: [[SINCE + 2 * WEEK, 5, 2000, 10]], days: [[SINCE + 2 * WEEK + 2 * DAY, 5, 2000, 10]] },
  { login: null, name: 'Alan Kay', weeks: [[SINCE + WEEK, 1, 3, 0]], days: [[SINCE + WEEK + DAY, 1, 3, 0]] },
], punch: punch(), periodPunch: true, lines: true, ...more })
// GitHub's statistics of a year too large to read: no day's lines, nor
// anyone's days, and when commits are made, not only the period's.
const counted = (more = {}) => stats({ weeks: year().map(week => ({ ...week, dayLines: undefined })), contributors: stats().contributors.map(person => ({ ...person, days: undefined })),
  periodPunch: false, ...more })
const item = (number, more = {}) => ({ number, title: `Item ${number}`, author: 'ada', at: NOW - 3 * 3_600_000, createdAt: NOW - DAY, kind: 'pulls', state: 'merged', draft: false, ...more })
const pulse = (more = {}) => ({ weeks: 4, since: SINCE, previousSince: SINCE - 4 * WEEK,
  merged: { count: 12, previous: 8, items: [item(5), item(4, { title: '' })] }, opened: { count: 2, previous: 2, items: [item(6, { state: 'open', draft: true })] },
  closed: { count: 0, previous: 3, items: [] }, created: { count: 1, previous: 0, items: [item(3, { kind: 'issues', state: 'open', reason: null })] },
  stats: stats(), reading: null, pending: false, users: { 'claude[bot]': { agent: 'claude' } }, ...more })
const shown = (repo = 'org/repo') => Object.assign(new Pulse(), { repository: { repoId: 7, repo, commit: 'a'.repeat(40), path: '' } })

test('a period\'s figures: its commits, beside the same days of the week a period earlier where the year reaches back; its lines; who made commits', () => {
  const read = pulse()
  assert.deepEqual(pulseSummary(read, NOW), { commits: 26, previous: 33, agents: null, previousAgents: null, releases: null, previousReleases: null, additions: 40,
    deletions: 8, authors: 3 })
  assert.equal(pulseSummary({ ...read, weeks: 52, since: FIRST }, NOW).previous, null, 'the year before the year GitHub counts')
  const large = pulseSummary({ ...read, stats: stats({ lines: false }) }, NOW)
  assert.deepEqual([large.additions, large.deletions], [null, null])
  assert.deepEqual(pulseSummary({ ...read, stats: null, pending: true }, NOW), { commits: null, previous: null, agents: null, previousAgents: null, releases: null,
    previousReleases: null, additions: null, deletions: null, authors: null })
})

test('the period\'s contributors, or a day\'s, the most commits first, and a scale\'s round ticks', () => {
  assert.deepEqual(periodContributors(stats().contributors, SINCE), [
    { key: '@ada', login: 'ada', name: 'Ada', commits: 5, additions: 35, deletions: 5 },
    { key: '@claude[bot]', login: 'claude[bot]', name: null, commits: 5, additions: 2000, deletions: 10 },
    { key: '=Alan Kay', login: null, name: 'Alan Kay', commits: 1, additions: 3, deletions: 0 }])
  assert.deepEqual(periodContributors(counted().contributors, SINCE), periodContributors(stats().contributors, SINCE), 'by their weeks where their days aren\'t counted')
  assert.deepEqual(periodContributors(stats().contributors, SINCE + WEEK + DAY, SINCE + WEEK + 2 * DAY), [
    { key: '@ada', login: 'ada', name: 'Ada', commits: 2, additions: 5, deletions: 1 }, { key: '=Alan Kay', login: null, name: 'Alan Kay', commits: 1, additions: 3, deletions: 0 }])
  assert.deepEqual([niceScale(93), niceScale(7), niceScale(1), niceScale(0), niceScale(12_000)], [
    { top: 100, ticks: [0, 50, 100] }, { top: 10, ticks: [0, 5, 10] }, { top: 1, ticks: [0, 1] }, { top: 1, ticks: [0, 1] },
    { top: 15_000, ticks: [0, 5000, 10_000, 15_000] }])
})

test('a contributor\'s year: their commits and lines each week, and each day and those with agents where their days are counted', () => {
  const people = [{ login: 'ada', name: 'Ada', weeks: [[SINCE, 3, 30, 4], [SINCE + WEEK, 2, 5, 1]], days: [[SINCE, 3, 30, 4, 1, 1], [SINCE + WEEK + DAY, 2, 5, 1, 2, 0]] },
    { login: 'grace', name: null, weeks: [[SINCE, 4, 1, 0]], days: [[SINCE, 4, 1, 0, 0, 0]] }]
  const ada = contributorStats(stats({ agents: true, releases: true, contributors: people }), '@ada')
  const none = Array.from({ length: 7 }, () => 0)
  assert.deepEqual([ada.byDays, ada.agents, ada.releases, ada.weeks.length], [true, true, true, 52])
  assert.deepEqual(ada.weeks.find(row => row.week === SINCE), { week: SINCE, days: [3, ...none.slice(1)], dayLines: [[30, 4], ...none.slice(1).map(() => [0, 0])],
    agentDays: [1, ...none.slice(1)], releaseDays: [1, ...none.slice(1)], commits: 3, additions: 30, deletions: 4 })
  assert.deepEqual(ada.weeks.find(row => row.week === SINCE + WEEK).agentDays, [0, 2, 0, 0, 0, 0, 0])
  assert.equal(ada.weeks.reduce((sum, row) => sum + row.commits, 0), 5, 'none of anyone else\'s')
  assert.deepEqual(pulseColumns({ ...pulse(), stats: ada }, NOW).slice(0, 9).map(column => [column.commits, column.agents]),
    [[3, 1], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [2, 2]])
  const weekly = contributorStats(counted(), '@ada')
  assert.deepEqual([weekly.byDays, weekly.agents], [false, false])
  assert.deepEqual(weekly.weeks.find(row => row.week === SINCE), { week: SINCE, days: none, dayLines: none.map(() => [0, 0]), agentDays: none, releaseDays: none,
    commits: 3, additions: 30, deletions: 4 }, 'by their weeks where their days aren\'t counted')
  assert.equal(contributorStats(stats({ agents: true }), '@ada').agents, false, 'their commits with agents not counted where their days hold none')
  assert.ok(contributorStats(stats(), '@nobody').weeks.every(row => row.commits === 0))
})

test('a user of the app is one contributor whichever of their GitHub accounts committed', () => {
  knowGithubUsers({ users: { mona: { id: 'mona-id', login: 'mona', name: 'Mona' }, 'mona-work': { id: 'mona-id', login: 'mona', name: 'Mona' },
    claude: { agent: 'claude' }, 'claude[bot]': { agent: 'claude' }, 'dependabot[bot]': { agent: 'dependabot' } } })
  const week = (commits, additions) => [[SINCE, commits, additions, 1]]
  assert.deepEqual(periodContributors([{ login: 'mona-work', name: 'M', weeks: week(4, 10) }, { login: 'other', name: null, weeks: week(5, 1) },
    { login: 'mona', name: 'Mona', weeks: week(2, 5) }, { login: null, name: 'Mona', weeks: week(1, 1) }], SINCE), [
    { key: 'user:mona-id', login: 'mona-work', name: 'M', commits: 6, additions: 15, deletions: 2 },
    { key: '@other', login: 'other', name: null, commits: 5, additions: 1, deletions: 1 },
    { key: '=Mona', login: null, name: 'Mona', commits: 1, additions: 1, deletions: 1 }], 'one known by name alone is no user\'s')
  assert.deepEqual(periodContributors([{ login: 'claude', name: 'Claude', weeks: week(1, 1) }, { login: 'claude[bot]', name: null, weeks: week(2, 2) },
    { login: null, name: 'Claude', weeks: week(3, 3) }, { login: null, name: 'Codex', weeks: week(1, 1) },
    { login: 'dependabot[bot]', name: 'dependabot[bot]', weeks: week(4, 4) }, { login: null, name: 'dependabot[bot]', weeks: week(1, 1) }], SINCE), [
    { key: 'agent:claude', login: 'claude', name: 'Claude', commits: 6, additions: 6, deletions: 3 },
    { key: 'agent:dependabot', login: 'dependabot[bot]', name: 'dependabot[bot]', commits: 5, additions: 5, deletions: 2 },
    { key: 'agent:codex', login: null, name: 'Codex', commits: 1, additions: 1, deletions: 1 }],
  'an agent is one contributor whichever of its identities committed')
})

test('the pulse reads a month first: its figures beside the month before, the month alone a column a day, its contributors, pull requests and issues, and when its commits are made', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  answer = () => Promise.resolve(pulse())
  const view = shown()
  assert.match(templateText(view.render()), /Reading the repository’s pulse…/u)
  await setImmediate()
  const text = templateText(view.render())
  assert.deepEqual(requests, [[7, 4]])
  assert.match(text, /^<div class="history-bar">/u, 'the bar none of the charts\' bars')
  assert.match(text, /aria-pressed=true [^\n]*>Month</u)
  assert.doesNotMatch(text, /Table|pulse-table/u, 'its figures in no table')
  assert.match(text, /class="pulse-range">Sep 20 – Oct 15</u)
  assert.match(text, /Commits<\/span>\s*<span class="pulse-tile-value">26<\/span>\s*<span class="pulse-tile-note">↓ 21% from 33 the month before</u)
  assert.match(text, /Contributors<\/span>\s*<span class="pulse-tile-value">3</u)
  assert.match(text, /Pull requests merged<\/span>\s*<span class="pulse-tile-value">12<\/span>\s*<span class="pulse-tile-note">↑ 50% from 8 the month before<\/span>\s*<span class="pulse-tile-note">2 opened/u)
  assert.match(text, /Issues closed<\/span>\s*<span class="pulse-tile-value">0<\/span>\s*<span class="pulse-tile-note">↓ 100% from 3 the month before/u)
  assert.match(text, /<span class="is-added">\+40<\/span> <span class="is-removed">−8<\/span><\/span>\s*<span class="pulse-ratio" aria-hidden="true"><span class=is-added style=--share: 0\.83\d*><\/span><span class=is-removed style=--share: 0\.16\d*>/u,
    'lines added beside those removed, each as long as its share')
  assert.doesNotMatch(text, /With agents|pulse-part|pulse-figure/u, 'none of the commits agents took part in counted; no day\'s figures written in a month')
  // The month alone, a column a day in each plot, its weekends shaded, the days to come empty; the lines' named by the commits'.
  assert.match(text, /<h3>Commits<\/h3><span>a day<\/span>[^]*<h3>Lines<\/h3><span>added and removed a day<\/span>/u)
  const columns = text.split('class=pulse-column').slice(1)
  assert.equal(columns.length, 56)
  assert.match(columns[0], /^ is-weekend role=img\s+aria-label=Sun, Sep 20: 1 commit, \+10 −2 lines aria-hidden=/u)
  assert.match(columns[1], /^ role=img\s+aria-label=Mon, Sep 21: 1 commit, \+0 −0 lines /u)
  assert.match(columns[26], /^ is-future role=img\s+aria-label=Fri, Oct 16: 0 commits/u)
  assert.match(columns[27], /^ is-future is-weekend /u)
  assert.match(columns[28], /^ is-weekend role=\s+aria-label= aria-hidden=true/u)
  assert.match(text, /style=--at: 1><span>1<\/span>/u, 'commits\' scale to a round top over the most')
  assert.match(text, /style=--at: 1><span>\+10<\/span>/u, 'and lines\'')
  assert.match(text, /<span class=is-zero\s+style=--at: 0><span>0<\/span>[^]*<span class=is-zero\s+style=--at: 0\.5><span>0<\/span>/u, 'naught each plot\'s baseline')
  const axis = text.match(/class=pulse-axis aria-hidden="true">[^]*?<\/div>/u)[0]
  assert.deepEqual([...axis.matchAll(/>([^<]+)<\/span>/gu)].map(([, label]) => label), ['Sep 20', 'Sep 27', 'Oct 4', 'Oct 11'], 'each week by its Sunday')
  assert.doesNotMatch(text, /class=pulse-tip/u, 'no column\'s figures till one is pointed at')
  assert.match(text, /<h3>Contributors<\/h3><span>by their commits in the period<\/span>/u)
  assert.match(text, /class=pulse-ranks><li\s+class=>\s*<span class="pulse-rank-who"><button type="button" class="pulse-rank-name" aria-pressed=false\s+@click=\(\) => this\.showPerson\(person\.key\)>ada<\/button>\s*<a class="pulse-rank-profile" href=https:\/\/github\.com\/ada [^>]*aria-label=ada on GitHub>[^]*--value: 1[^]*>5<\/span>[^]*<span class="is-added">\+35<\/span> <span\s+class="is-removed">−5</u,
    'each a button picking them, their profile a link beside')
  assert.match(text, /<span class="app-user" data-tooltip=@claude\[bot\] on GitHub>[^]*?is-claude[^]*?app-user-name">Claude<[^]*?<\/button>\s*<a class="pulse-rank-profile" href=https:\/\/github\.com\/apps\/claude /u,
    'an app by its page, Claude\'s by its mark')
  assert.match(text, /class="pulse-rank-name" aria-pressed=false\s+@click=\(\) => this\.showPerson\(person\.key\)>Alan Kay<\/button>\s*<\/span>/u, 'one GitHub names no account for, by name, unlinked')
  assert.doesNotMatch(text, />grace</u, 'none of the period\'s')
  assert.match(text, /<h3>When commits are made<\/h3><span>by day and hour, in each author’s own time zone<\/span>/u, 'the period\'s')
  assert.match(text, /class=pulse-cell is-6 role="img" aria-label=Tuesdays, 14:00–15:00: 12 commits/u)
  assert.match(text, /class=pulse-cell is-1 role="img" aria-label=Mondays, 00:00–01:00: 1 commit /u)
  assert.match(text, /class=pulse-cell is-0 role="img" aria-label=Saturdays, 00:00–01:00: 0 commits/u)
  assert.ok(text.indexOf('>Mon<') < text.indexOf('>Sun<'), 'Monday first')
  // Pull requests merged and issues closed shown, each beside how many were opened.
  assert.match(text, /<h3>Pull requests<\/h3>[^]*aria-pressed=true[^\n]*?>Merged<span class="n">12<\/span>[^]*aria-pressed=false[^\n]*?>Opened<span class="n">2<\/span>/u)
  assert.match(text, /<h3>Issues<\/h3>[^]*aria-pressed=true[^\n]*?>Closed<span class="n">0<\/span>[^]*aria-pressed=false[^\n]*?>Opened<span class="n">1<\/span>/u)
  assert.match(text, /href=https:\/\/github\.com\/org\/repo\/pull\/5\s[^]*Item 5[^]*#5[^]*3h<\/time>[^]*\(no title\)/u)
  assert.match(text, /href=https:\/\/github\.com\/org\/repo\/pulls\?q=is%3Apr%20is%3Amerged%20merged%3A%3E%3D2026-09-20 [^>]*>All 12 on GitHub</u)
  assert.match(text, /<h3>Issues<\/h3>[^]*<p class="pulse-note">None in the period\.<\/p>/u)
  assert.doesNotMatch(text, /pull\/6|issues\/3/u, 'those opened a click away')
  // Opened by none, its name is the one its repositories list it by, once they arrive.
  const unnamed = shown(null)
  assert.doesNotMatch(templateText(unnamed.render()), /github\.com\/org/u)
  unnamed.repo = 'org/named'
  assert.match(templateText(unnamed.render()), /href=https:\/\/github\.com\/org\/named\/pull\/5\s/u)
})

test('a column pointed at, or read with the arrow keys, shows its figures and who made its commits beside it; picked, the contributors are its, till it is again or Escape', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  answer = () => Promise.resolve(pulse())
  const view = shown()
  view.render()
  await setImmediate()
  const columns = pulseColumns(pulse(), NOW)
  view.point(8)
  let text = templateText(view.render())
  assert.match(text, /class=pulse-column is-at role=img\s+aria-label=Mon, Sep 28/u)
  assert.equal(text.match(/class=pulse-column is-at/gu).length, 2, 'marked in both plots')
  assert.match(text, /class=pulse-tip style=--x: 0\.30\d* aria-hidden="true">\s*<span class="pulse-tip-when">Mon, Sep 28<\/span>/u, 'on its right, there being more room')
  assert.match(text, /<strong>1<\/strong> commit<\/span>[^]*<strong>\+0<\/strong> added[^]*<strong>−0<\/strong> removed/u)
  assert.match(text, /class="pulse-tip-people">\s*<span class="pulse-tip-person">ada<strong>2<\/strong><\/span><span class="pulse-tip-person">Alan Kay<strong>1<\/strong>/u, 'the day\'s')
  assert.match(text, /aria-live="polite"><\/span>/u, 'pointed at, not read aloud')
  view.point(25)
  text = templateText(view.render())
  assert.match(text, /class=pulse-tip is-left [^>]*>\s*<span class="pulse-tip-when">Thu, Oct 15 <span>today<\/span>/u, 'on its left, near the end')
  assert.doesNotMatch(text, /pulse-tip-people/u, 'none named for a day no one\'s commits were counted on')
  view.point(26)
  assert.doesNotMatch(templateText(view.render()), /class=pulse-tip/u, 'a day to come, none')
  // Picked, the contributors are the day's, the period's a click away.
  view.pickColumn(columns, 8)
  view.point(null)
  text = templateText(view.render())
  assert.match(text, /class=pulse-column is-picked role=img\s+aria-label=Mon, Sep 28/u)
  assert.match(text, /<h3>Contributors<\/h3><button type="button" class="pulse-picked" aria-label=Mon, Sep 28: show the whole period’s/u)
  assert.match(text, />ada<\/button>[^]*>2<\/span>[^]*Alan Kay/u)
  assert.doesNotMatch(text, /apps\/claude/u, 'not the day\'s')
  view.pickColumn(columns, 8)
  assert.match(templateText(view.render()), /by their commits in the period/u, 'picked again, none is')
  view.pickColumn(columns, 26)
  assert.match(templateText(view.render()), /by their commits in the period/u, 'a day to come, never')
  // The keys: End the latest, the arrows the days beside, Home the first, Enter picks, Escape leaves it.
  const key = name => ({ key: name, prevented: false, preventDefault() { this.prevented = true } })
  const press = name => {
    const event = key(name)
    view.readColumns(event, columns)
    return event.prevented
  }
  assert.equal(press('End'), true)
  assert.match(templateText(view.render()), /class="pulse-tip-when">Thu, Oct 15 [^]*aria-live="polite">Thu, Oct 15: 1 commit, \+0 −0 lines<\/span>/u, 'read aloud')
  press('ArrowRight')
  assert.match(templateText(view.render()), /class="pulse-tip-when">Thu, Oct 15 /u, 'no further than today')
  press('ArrowLeft')
  assert.match(templateText(view.render()), /class="pulse-tip-when">Wed, Oct 14</u)
  press('Home')
  press('ArrowLeft')
  assert.match(templateText(view.render()), /class="pulse-tip-when">Sun, Sep 20</u)
  press('Enter')
  assert.match(templateText(view.render()), /class="pulse-picked" aria-label=Sun, Sep 20: /u)
  assert.equal(press('Escape'), true)
  text = templateText(view.render())
  assert.doesNotMatch(text, /pulse-picked|class=pulse-tip/u)
  assert.equal(press('Escape'), false, 'nothing left to leave')
  assert.equal(press('a'), false)
  // Another period, none picked.
  view.pickColumn(columns, 3)
  view.pick(13)
  assert.equal(view._picked, null)
  view.pick(4)
})

test('another repository\'s pulse in the same element: none of its columns pointed at or picked, its contributors the first of them', () => {
  const view = shown()
  const picked = () => Object.assign(view, { _column: 3, _picked: SINCE, _everyone: true, _person: '@ada' })
  picked()
  view.repository = { ...view.repository, commit: 'b'.repeat(40) }
  view.willUpdate(new Map([['repository', { repoId: 7 }]]))
  assert.deepEqual([view._column, view._picked, view._everyone, view._person], [3, SINCE, true, '@ada'], 'the same repository\'s kept')
  view.repository = { ...view.repository, repoId: 8 }
  view.willUpdate(new Map([['repository', { repoId: 7 }]]))
  assert.deepEqual([view._column, view._picked, view._everyone, view._person], [null, null, false, null])
  picked()
  view.willUpdate(new Map([['_column', null]]))
  assert.equal(view._picked, SINCE, 'its own state changed alone, kept')
})

test('a week, each day\'s figures written on it, today\'s named; the commits agents made or co-authored over the rest, and their share beside the week before\'s', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const week = Date.UTC(2026, 9, 11)
  // Mondays' commits made with agents, and this week's Wednesday's.
  const agents = stats({ weeks: year().map(row => ({ ...row, agentDays: row.days.map((count, day) => day === 1 || (row.week === week && day === 3) ? count : 0) })) })
  answer = (repoId, weeks) => Promise.resolve(pulse({ weeks, since: week, stats: agents }))
  const view = shown()
  view.pick(1)
  view.render()
  await setImmediate()
  view.point(1)
  const text = templateText(view.render())
  view.pick(4)
  assert.match(text, /Commits<\/span>\s*<span class="pulse-tile-value">5<\/span>\s*<span class="pulse-tile-note">Same as the week before</u)
  assert.match(text, /With agents<\/span><\/span>\s*<span class="pulse-tile-value">40%<\/span>\s*<span class="pulse-tile-note">↑ from 20% the week before<\/span>\s*<span class="pulse-tile-note">2 of 5 commits</u)
  assert.match(text, /<h3>Commits<\/h3><span>a day<\/span><span class="pulse-legend"><span\s+class="pulse-key"><\/span>With agents<span class="pulse-key is-without"><\/span>Without</u)
  const columns = text.split('class=pulse-column').slice(1)
  assert.equal(columns.length, 14)
  assert.match(columns[0], /^ role=img\s+aria-label=Sun, Oct 11: 1 commit, 0 with agents, \+10 −2 lines aria-hidden=/u, 'a week\'s weekend unshaded')
  assert.match(columns[0], /<span class="pulse-figure">1<\/span><span class=pulse-bar is-split style=--value: 1><span class=pulse-part is-without style=--part: 1><\/span><\/span>/u)
  assert.match(columns[1], /aria-label=Mon, Oct 12: 1 commit, 1 with agents[^]*<span class=pulse-part style=--part: 1><\/span><\/span>/u)
  assert.doesNotMatch(columns[1], /is-without/u)
  assert.match(columns[5], /^ is-future role=img/u)
  assert.doesNotMatch(columns[5], /pulse-figure/u, 'none written on a day to come')
  assert.match(columns[7], /<span class="pulse-figure">\+10<\/span>[^]*<span class="pulse-figure">−2<\/span>/u)
  const axis = text.match(/class=pulse-axis is-each aria-hidden="true">[^]*?<\/div>/u)[0]
  assert.deepEqual([...axis.matchAll(/>([^<]+)<\/span>/gu)].map(([, label]) => label), ['Sun 11', 'Mon 12', 'Tue 13', 'Wed 14', 'Thu 15', 'Fri 16', 'Sat 17'])
  assert.match(axis, /class=is-today>Thu 15</u)
  assert.match(text, /<span class=pulse-tip-key is-none><\/span><strong>1<\/strong> commit<\/span>\s*<span class="pulse-tip-row"><span class="pulse-tip-key"><\/span><strong>1<\/strong> with agents/u)
})

test('a contributor clicked: their commits alone in the plots, named over them, the rest of the contributors faded, whatever the period; again, or their name over the plots, everyone\'s', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  answer = (repoId, weeks) => Promise.resolve(pulse({ weeks, since: weeks === 4 ? SINCE : SINCE - 9 * WEEK }))
  const view = shown()
  view.render()
  await setImmediate()
  view.point(8)
  view.showPerson('@ada')
  assert.equal(view._column, null, 'no column pointed at')
  view.point(8)
  let text = templateText(view.render())
  assert.match(text, /aria-label=Commits and lines a day by ada: the arrow keys/u)
  assert.match(text, /<h3>Commits<\/h3><span>a day by<\/span><button type="button" class="pulse-picked is-person" aria-label=ada’s: show everyone’s\s[^]*?>ada<span aria-hidden="true">×<\/span><\/button>/u)
  const columns = text.split('class=pulse-column').slice(1)
  assert.match(columns[0], /aria-label=Sun, Sep 20: 3 commits, \+30 −4 lines /u)
  assert.match(columns[1], /aria-label=Mon, Sep 21: 0 commits, \+0 −0 lines /u)
  assert.match(columns[8], /aria-label=Mon, Sep 28: 2 commits, \+5 −1 lines /u)
  assert.match(text, /style=--at: 1><span>3<\/span>/u, 'their commits\' own scale')
  assert.match(text, /class="pulse-tip-when">Mon, Sep 28<\/span>[^]*<strong>2<\/strong> commits/u)
  assert.doesNotMatch(text, /pulse-tip-people/u, 'no one else named')
  assert.match(text, /class=pulse-ranks is-picking><li\s+class=is-person>\s*<span class="pulse-rank-who"><button type="button" class="pulse-rank-name" aria-pressed=true\s/u)
  assert.equal(text.match(/aria-pressed=false\s+@click=\(\) => this\.showPerson/gu).length, 2, 'the rest not')
  assert.match(text, /Commits<\/span>\s*<span class="pulse-tile-value">26</u, 'the figures everyone\'s')
  // Another period, theirs still.
  view.pick(13)
  view.render()
  await setImmediate()
  text = templateText(view.render())
  view.pick(4)
  assert.match(text, /<span>a week by<\/span>[^]*aria-label=Week of Sep 20: 3 commits/u)
  view.showPerson('@ada')
  text = templateText(view.render())
  assert.match(text, /<h3>Commits<\/h3><span>a day<\/span>/u, 'clicked again, everyone\'s')
  assert.doesNotMatch(text, /is-picking|is-person|class="pulse-rank-name" aria-pressed=true/u)
  view.showPerson('@grace')
  assert.match(templateText(view.render()), /<span>a day by<\/span>[^]*<p class="pulse-note">No commits by grace in the period\.<\/p>/u, 'one with none in the period')
  view.showPerson(null)
  assert.equal(view._person, null, 'their name over the plots clicked, everyone\'s')
})

test('commits with agents counted, the year holding some: a period, or a contributor, with none all without, the legend said', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  // The year's first Monday's commits made with agents, none since; each
  // contributor's days counting theirs.
  const agents = stats({ weeks: year().map((row, at) => ({ ...row, agentDays: row.days.map((count, day) => at === 0 && day === 1 ? count : 0) })),
    contributors: stats().contributors.map(person => ({ ...person, days: person.days.map(row => [...row, 0]) })) })
  answer = () => Promise.resolve(pulse({ stats: agents }))
  const view = shown()
  view.render()
  await setImmediate()
  let text = templateText(view.render())
  assert.match(text, /<h3>Commits<\/h3><span>a day<\/span><span class="pulse-legend"><span\s+class="pulse-key"><\/span>With agents<span class="pulse-key is-without"><\/span>Without/u)
  assert.match(text.split('class=pulse-column').slice(1)[0],
    /aria-label=Sun, Sep 20: 1 commit, 0 with agents[^]*<span class=pulse-bar is-split style=--value: 1><span class=pulse-part is-without style=--part: 1><\/span><\/span>/u)
  view.showPerson('@ada')
  text = templateText(view.render())
  assert.match(text, /<span>a day by<\/span>[^]*With agents[^]*Without/u, 'a contributor\'s too')
  assert.match(text.split('class=pulse-column').slice(1)[0], /<span class=pulse-part is-without style=--part: 3><\/span>/u)
  view.showPerson('@ada')
  answer = () => Promise.resolve(pulse({ stats: stats({ weeks: agents.weeks }) }))
  state.managedSession = { id: 'other', role: 'admin' }
  view.render()
  await setImmediate()
  view.showPerson('@ada')
  text = templateText(view.render())
  assert.doesNotMatch(text, /pulse-legend"><span\s+class="pulse-key"><\/span>With agents|pulse-part/u, 'a contributor whose commits with agents aren\'t counted, unsplit')
})

test('releases apart: at the foot of each column\'s commits in their own color, named last in the legend, its figures and words; the share with agents of the rest alone', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const week = Date.UTC(2026, 9, 11)
  // This week's Monday's commit a release, its Tuesday's made with an agent;
  // last week's Monday's a release too.
  const release = row => row.days.map((count, day) => (row.week === week || row.week === week - WEEK) && day === 1 ? count : 0)
  const agents = stats({ weeks: year().map(row => ({ ...row, releaseDays: release(row), agentDays: row.days.map((count, day) => row.week === week && day === 2 ? count : 0) })) })
  answer = (repoId, weeks) => Promise.resolve(pulse({ weeks, since: week, stats: agents }))
  const view = shown()
  view.pick(1)
  view.render()
  await setImmediate()
  view.point(1)
  const text = templateText(view.render())
  view.pick(4)
  assert.match(text, /<span class="pulse-legend"><span\s+class="pulse-key"><\/span>With agents<span class="pulse-key is-without"><\/span>Without<span\s+class="pulse-key is-release"><\/span>Releases<\/span>/u)
  const columns = text.split('class=pulse-column').slice(1)
  assert.match(columns[1], /aria-label=Mon, Oct 12: 1 commit, 0 with agents, 1 release, \+0 −0 lines [^]*<span class=pulse-bar is-split style=--value: 1><span class=pulse-part is-release style=--part: 1><\/span><\/span>/u)
  assert.match(columns[2], /aria-label=Tue, Oct 13: 1 commit, 1 with agents, 0 releases[^]*<span class=pulse-part style=--part: 1><\/span><\/span>/u)
  assert.match(columns[3], /<span class=pulse-part is-without style=--part: 1><\/span><\/span>/u)
  assert.match(columns[3], /^ role=img\s+aria-label=Wed, Oct 14:/u)
  assert.match(text, /<span class=pulse-tip-key is-none><\/span><strong>1<\/strong> commit<\/span>[^]*<strong>0<\/strong> with agents[^]*<span class="pulse-tip-row"><span class="pulse-tip-key is-release"><\/span><strong>1<\/strong> release<\/span>/u)
  // Five commits, one a release: one of the other four with agents; the week
  // before's (Sunday to Thursday) five, one a release, none of the other four.
  assert.match(text, /With agents<\/span><\/span>\s*<span class="pulse-tile-value">25%<\/span>\s*<span class="pulse-tile-note">↑ from 0% the week before<\/span>\s*<span class="pulse-tile-note">1 of 4 commits, 1 release apart</u)
})

test('a column\'s commits top to bottom as the legend names them left to right: with agents, without, releases', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  const week = Date.UTC(2026, 9, 11)
  // This week's Wednesday's three commits: one with an agent, one without, one a release.
  const day = (row, count, other = 0) => row.days.map((_, at) => row.week === week && at === 3 ? count : other)
  const all = stats({ weeks: year().map(row => ({ ...row, days: row.week === week ? row.days.map((count, at) => at === 3 ? 3 : count) : row.days,
    agentDays: day(row, 1), releaseDays: day(row, 1) })) })
  answer = (repoId, weeks) => Promise.resolve(pulse({ weeks, since: week, stats: all }))
  const view = shown()
  view.pick(1)
  view.render()
  await setImmediate()
  const text = templateText(view.render())
  view.pick(4)
  assert.match(text, /With agents<span class="pulse-key is-without"><\/span>Without<span\s+class="pulse-key is-release"><\/span>Releases/u)
  assert.match(text.split('class=pulse-column').slice(1)[3], /<span class=pulse-bar is-split style=--value: 1><span class=pulse-part style=--part: 1><\/span><span class=pulse-part is-without style=--part: 1><\/span><span class=pulse-part is-release style=--part: 1><\/span><\/span>/u)
})

test('a contributor or a column picked narrows the pull requests and issues to theirs, so said, the rest on GitHub narrowed alike; one whose commits name no account, none', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  answer = (repoId, weeks) => Promise.resolve(pulse({ weeks, since: weeks === 4 ? SINCE : SINCE - 9 * WEEK }))
  narrowedAnswer = () => Promise.resolve({ merged: { count: 14, items: [item(9, { title: 'Ada’s' })] }, opened: { count: 1, items: [] }, closed: { count: 0, items: [] },
    created: { count: 0, items: [] } })
  const view = shown()
  view.render()
  await setImmediate()
  narrowedRequests.length = 0
  const asked = () => narrowedRequests.map(([repoId, weeks, { from, to, authors }]) => [repoId, weeks, from, to, authors])
  view.showPerson('@ada')
  let text = templateText(view.render())
  assert.deepEqual(asked(), [[7, 4, '2026-09-20', null, ['ada']]], 'one read for both lists')
  assert.match(text, /<h3>Pull requests<\/h3><span class="pulse-narrowed">by ada<\/span>[^]*<\/div>\s*<p class="pulse-note" role="status">Reading…/u,
    'beside the title, not over the list')
  await setImmediate()
  text = templateText(view.render())
  assert.match(text, /by ada<\/span>[^]*Merged<span class="n">14<\/span>[^]*Opened<span class="n">1<\/span>[^]*Ada’s/u)
  assert.match(text, /href=https:\/\/github\.com\/org\/repo\/pulls\?q=is%3Apr%20is%3Amerged%20merged%3A%3E%3D2026-09-20%20author%3Aada [^>]*>All 14 on GitHub</u)
  assert.match(text, /<h3>Issues<\/h3>[^]*<p class="pulse-note">None by ada in the period\.<\/p>/u)
  view.pickColumn(pulseColumns(pulse(), NOW), 8)
  text = templateText(view.render())
  assert.deepEqual(asked().at(-1), [7, 4, '2026-09-28', '2026-09-28', ['ada']])
  assert.match(text, /<span class="pulse-narrowed">by ada on Mon, Sep 28<\/span>/u)
  view.showPerson('@ada')
  text = templateText(view.render())
  assert.deepEqual(asked().at(-1), [7, 4, '2026-09-28', '2026-09-28', []], 'the day\'s alone')
  assert.match(text, /<span class="pulse-narrowed">on Mon, Sep 28<\/span>/u)
  view.pickColumn(pulseColumns(pulse(), NOW), 8)
  text = templateText(view.render())
  assert.doesNotMatch(text, /pulse-narrowed/u)
  assert.match(text, /Merged<span class="n">12<\/span>/u, 'neither picked, the period\'s')
  const reads = narrowedRequests.length
  view.showPerson('=Alan Kay')
  text = templateText(view.render())
  assert.match(text, /<p class="pulse-note">Alan Kay’s commits name no GitHub account to find their pull requests by\.<\/p>/u)
  assert.equal(narrowedRequests.length, reads, 'none read')
  view.showPerson(null)
  view.pick(13)
  view.render()
  await setImmediate()
  view.pickColumn(pulseColumns(pulse({ weeks: 13, since: SINCE - 9 * WEEK }), NOW), 10)
  text = templateText(view.render())
  view.pick(4)
  assert.match(text, /<span class="pulse-narrowed">in the week of Sep 27<\/span>/u)
  assert.deepEqual(asked().at(-1), [7, 13, '2026-09-27', '2026-10-03', []])
})

test('a quarter, a column a week, every other one named; this week\'s figures so far', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  answer = (repoId, weeks) => Promise.resolve(pulse({ weeks, since: SINCE - 9 * WEEK }))
  const view = shown()
  view.pick(13)
  view.render()
  await setImmediate()
  view.point(12)
  const text = templateText(view.render())
  view.pick(4)
  assert.match(text, /<h3>Commits<\/h3><span>a week<\/span>/u)
  const columns = text.split('class=pulse-column').slice(1)
  assert.equal(columns.length, 26)
  assert.match(columns[0], /^ role=img\s+aria-label=Week of Jul 19: 7 commits, \+10 −2 lines /u)
  assert.match(columns[7], /aria-label=Week of Sep 6: 14 commits/u)
  const axis = text.match(/class=pulse-axis aria-hidden="true">[^]*?<\/div>/u)[0]
  assert.deepEqual([...axis.matchAll(/>([^<]+)<\/span>/gu)].map(([, label]) => label), ['Jul 19', 'Aug 2', 'Aug 16', 'Aug 30', 'Sep 13', 'Sep 27', 'Oct 11'])
  assert.match(text, /class="pulse-tip-when">Week of Oct 11 <span>so far<\/span>/u)
})

test('another period is shown at once from the year read, its pull requests and issues read for it meanwhile; read, it is kept', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  let release
  answer = (repoId, weeks) => weeks === 4 ? Promise.resolve(pulse()) : new Promise(resolve => { release = () => resolve(pulse({ weeks, since: FIRST, stats: stats() })) })
  const view = shown()
  view.render()
  await setImmediate()
  view.pick(52)
  let text = templateText(view.render())
  assert.deepEqual(requests.at(-1), [7, 52])
  assert.match(text, /aria-pressed=true [^\n]*>Year</u)
  assert.match(text, /class=pulse-scroll aria-busy=true/u, 'not faded')
  assert.match(text, /Oct 19, 2025 – Oct 15, 2026/u)
  assert.match(text, /Commits<\/span>\s*<span class="pulse-tile-value">369<\/span>/u, 'the year\'s commits, of the month\'s year')
  assert.equal(text.split('class=pulse-column').length - 1, 104)
  assert.match(text, /Pull requests merged<\/span>\s*<span class="pulse-tile-value">–<\/span>\s*<span class="pulse-tile-note">Reading…/u)
  assert.match(text, /<h3>Pull requests<\/h3>[^]*?>Merged<span class="n">–<\/span>[^]*?<p class="pulse-note" role="status">Reading…<\/p>/u, 'listed once read')
  assert.match(text, /<figure class=pulse-panel is-reading aria-busy=true>\s*<figcaption class="pulse-head"><h3>When commits are made/u, 'the month\'s hours faded')
  release()
  await setImmediate()
  text = templateText(view.render())
  assert.match(text, /class=pulse-scroll aria-busy=false/u)
  assert.match(text, /Oct 19, 2025 – Oct 15, 2026/u)
  assert.match(text, /Commits<\/span>\s*<span class="pulse-tile-value">369<\/span>\s*<span class="pulse-tile-note">to the default branch/u, 'no year before it to compare')
  assert.match(text, /Pull requests merged<\/span>\s*<span class="pulse-tile-value">12</u)
  assert.match(text, /<figure class=pulse-panel aria-busy=false>\s*<figcaption class="pulse-head"><h3>When commits are made/u)
  assert.equal(text.split('class=pulse-column').length - 1, 104, 'a column a week in each plot')
  assert.match(text, /style=--at: 1><span>15<\/span>/u, 'commits\' scale to a round top over the most')
  const axis = text.match(/class=pulse-axis aria-hidden="true">[^]*?<\/div>/u)[0]
  assert.deepEqual([...axis.matchAll(/>([^<]+)<\/span>/gu)].map(([, label]) => label).slice(0, 4), ['Nov', 'Dec', '2026', 'Feb'], 'months named where they start, January by its year')
  view.pick(4)
  view.render()
  assert.equal(requests.length, 2, 'the month kept')
})

test('a year not read whole yet: the rest shown, how many commits are read, asked again a second apart while each answer reads more', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW })
  let read = 500
  answer = () => Promise.resolve(pulse({ stats: null, reading: read }))
  const view = shown()
  view.render()
  await setImmediate()
  let text = templateText(view.render())
  assert.match(text, /role="status">Reading this repository’s commits… 500 of the last year so far/u)
  assert.match(text, /Commits<\/span>\s*<span class="pulse-tile-value">–<\/span>\s*<span class="pulse-tile-note">Reading commits…/u)
  assert.match(text, /Pull requests merged<\/span>\s*<span class="pulse-tile-value">12</u, 'the period\'s pull requests and issues shown')
  // Each answer reading more, as many times as it takes.
  for (let more = 0; more < 8; more++) {
    read += 500
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  assert.equal(requests.length, 9)
  assert.match(templateText(view.render()), /4,500 of the last year so far/u)
  // Then none more, five times, and it is left to the reader.
  for (let stalled = 0; stalled < 6; stalled++) {
    t.mock.timers.tick(1000)
    await setImmediate()
  }
  assert.equal(requests.length, 14, 'five answers reading no more')
  text = templateText(view.render())
  assert.match(text, /4,500 of this repository’s commits of the last year read so far\. <button type="button" class="history-link" @click=\(\) => this\.askAgain\(\)>Read on</u)
  answer = () => Promise.resolve(pulse())
  view.askAgain()
  t.mock.timers.tick(0)
  await setImmediate()
  assert.equal(requests.length, 15)
  assert.match(templateText(view.render()), /class=pulse-column/u)
})

test('a year read again for a head moved on: the year as it was shown meanwhile, the server\'s or the last read, asked again a second apart while each answer reads more', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW })
  let read = 500
  answer = () => Promise.resolve(pulse({ reading: read }))
  const view = shown()
  view.render()
  await setImmediate()
  let text = templateText(view.render())
  // Said in the bar, at its end, the year shown under it.
  const bar = text.slice(0, text.indexOf('class=pulse-scroll'))
  assert.match(bar, /class="pulse-range">[^<]*<\/span>\s*<span class="pulse-updating" role="status">Reading this repository’s latest commits… 500 of the last year so far<\/span>\s*<\/div>/u)
  assert.match(text, /Commits<\/span>\s*<span class="pulse-tile-value">26<\/span>\s*<span class="pulse-tile-note">↓ 21% from 33/u, 'the year as it was')
  assert.equal(text.split('class=pulse-column').length - 1, 56)
  // An answer telling no year, the last read shown.
  answer = () => Promise.resolve(pulse({ stats: null, reading: (read += 500) }))
  t.mock.timers.tick(1000)
  await setImmediate()
  text = templateText(view.render())
  assert.equal(requests.length, 2)
  assert.match(text, /latest commits… 1,000 of the last year so far/u)
  assert.equal(text.split('class=pulse-column').length - 1, 56)
  assert.doesNotMatch(text, /pulse-pending/u)
  answer = () => Promise.resolve(pulse())
  t.mock.timers.tick(1000)
  await setImmediate()
  text = templateText(view.render())
  assert.equal(requests.length, 3)
  assert.doesNotMatch(text, /pulse-updating/u)
  t.mock.timers.tick(5000)
  assert.equal(requests.length, 3, 'read whole, not asked again')
})

test('the pull requests merged in the year read a few pages an answer: how many so far, asked again a second apart while each answer reads more', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW })
  let pulls = 500
  answer = () => Promise.resolve(pulse({ stats: null, pulls }))
  const view = shown()
  view.render()
  await setImmediate()
  let text = templateText(view.render())
  assert.match(text, /class="pulse-pending pulse-wide" role="status">Reading the pull requests merged in this repository… 500 so far</u)
  assert.match(text, /Commits<\/span>\s*<span class="pulse-tile-value">–<\/span>\s*<span class="pulse-tile-note">Reading pull requests…/u)
  // The year as it was told beside them, shown meanwhile.
  answer = () => Promise.resolve(pulse({ pulls: (pulls += 500) }))
  t.mock.timers.tick(1000)
  await setImmediate()
  text = templateText(view.render())
  assert.equal(requests.length, 2)
  assert.match(text.slice(0, text.indexOf('class=pulse-scroll')), /class="pulse-updating" role="status">Reading the pull requests merged in this repository… 1,000 so far</u, 'in the bar')
  assert.equal(text.split('class=pulse-column').length - 1, 56)
  answer = () => Promise.resolve(pulse())
  t.mock.timers.tick(1000)
  await setImmediate()
  assert.equal(requests.length, 3)
  assert.doesNotMatch(templateText(view.render()), /pulse-updating/u)
  t.mock.timers.tick(5000)
  assert.equal(requests.length, 3, 'read whole, not asked again')
})

test('a year GitHub\'s statistics count, while GitHub computes them, or its lines: asked again a while apart, a dozen times, then left to the reader', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW })
  answer = () => Promise.resolve(pulse({ stats: null, pending: true }))
  const view = shown()
  view.render()
  await setImmediate()
  assert.match(templateText(view.render()), /role="status">GitHub is still counting this repository’s commits…/u)
  answer = () => Promise.resolve(pulse({ stats: stats({ lines: null, weeks: year().map(week => ({ ...week, additions: null, deletions: null })) }), pending: true }))
  for (let tries = 0; tries < 12; tries++) {
    t.mock.timers.tick(5000)
    await setImmediate()
  }
  assert.equal(requests.length, 13, 'asked a dozen times again')
  t.mock.timers.tick(60_000)
  assert.equal(requests.length, 13, 'no more')
  const text = templateText(view.render())
  assert.match(text, /class=pulse-column/u, 'the commits counted shown')
  assert.match(text, /Lines<\/span>\s*<span class="pulse-tile-value">–<\/span>\s*<span class="pulse-tile-note">Counting…/u)
  assert.match(text, /GitHub hasn’t counted lines added and removed yet\. <button[^]*?>Ask again</u)
  assert.doesNotMatch(text, /pulse-rank-lines/u, 'no contributor\'s lines')
})

test('the pull requests opened, or the issues opened, shown as picked, and kept so', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  answer = () => Promise.resolve(pulse())
  const view = shown()
  view.render()
  await setImmediate()
  view.showList('pulls', 'opened')
  view.showList('issues', 'created')
  const text = templateText(shown().render())
  view.showList('pulls', 'merged')
  view.showList('issues', 'closed')
  assert.match(text, /aria-pressed=false[^\n]*?>Merged<[^]*aria-pressed=true[^\n]*?>Opened<span class="n">2</u)
  assert.match(text, /href=https:\/\/github\.com\/org\/repo\/pull\/6\s/u)
  assert.doesNotMatch(text, /pull\/5\s/u)
  assert.match(text, /href=https:\/\/github\.com\/org\/repo\/issues\/3\s/u)
  assert.deepEqual(text.match(/All \d+ on GitHub/gu), ['All 2 on GitHub'], 'the issues opened all listed')
  assert.match(text, /pulls\?q=is%3Apr%20created%3A%3E%3D2026-09-20 [^>]*>All 2 on GitHub</u)
})

test('where GitHub\'s statistics count the year: a day\'s lines a week\'s, its contributors its week\'s, and when commits are made, not only the period\'s', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  answer = (repoId, weeks) => Promise.resolve(pulse({ weeks, since: weeks === 4 ? SINCE : SINCE - 9 * WEEK, stats: counted() }))
  const view = shown()
  view.render()
  await setImmediate()
  view.point(8)
  let text = templateText(view.render())
  assert.doesNotMatch(text, /is-diverging/u)
  assert.match(text, /GitHub counts this repository’s lines a week, not a day: the quarter and the year show them\./u)
  assert.match(text, /class=pulse-column is-at role=img\s+aria-label=Mon, Sep 28: 1 commit aria-hidden=/u)
  assert.match(text, /class="pulse-tip-people"><span class="pulse-tip-note">Its week’s<\/span>\s*<span class="pulse-tip-person">ada<strong>2<\/strong>/u)
  assert.match(text, /in each author’s own time zone, not only the period’s<\/span>/u)
  assert.doesNotMatch(text, /With agents/u, 'none of the commits agents took part in counted')
  view.pickColumn(pulseColumns(pulse({ stats: counted() }), NOW), 8)
  text = templateText(view.render())
  assert.match(text, /class="pulse-picked" aria-label=Week of Sep 27: show the whole period’s/u)
  view.showPerson('@ada')
  assert.match(templateText(view.render()), /<span>a day by<\/span>[^]*<p class="pulse-note">GitHub counts each contributor’s commits a week, not a day, in a repository this large: the quarter and the year show theirs\.<\/p>/u)
  view.pick(13)
  view.render()
  await setImmediate()
  text = templateText(view.render())
  view.pick(4)
  assert.match(text, /is-diverging/u, 'a week\'s lines by the week')
  assert.match(text, /<span>a week by<\/span>[^]*aria-label=Week of Sep 20: 3 commits, \+30 −4 lines/u, 'a contributor\'s by their weeks')
})

test('a repository GitHub counts no lines for shows none, nor its contributors\'', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  answer = () => Promise.resolve(pulse({ stats: stats({ lines: false, weeks: year().map(week => ({ ...week, additions: null, deletions: null })) }) }))
  const view = shown()
  view.render()
  await setImmediate()
  const text = templateText(view.render())
  assert.doesNotMatch(text, />Lines</u)
  assert.doesNotMatch(text, /pulse-rank-lines/u)
  assert.match(text, /GitHub doesn’t count lines added and removed in a repository of 10,000 commits or more\./u)
})

test('an item clicked opens its popup, what the list knew shown as it reads the rest; held with a key, or another button, it opens on GitHub', () => {
  const view = shown()
  const click = more => ({ button: 0, prevented: false, preventDefault() { this.prevented = true }, ...more })
  const plain = click()
  view.openItem(plain, 'issues', item(3, { kind: 'issues', state: 'open', reason: null }))
  assert.equal(plain.prevented, true)
  assert.deepEqual(opened, [{ repository: view.repository, target: { number: 3, preview: { ...item(3, { state: 'open', reason: null }), kind: 'issues', labels: [], comments: 0 } } }])
  // Its popup by the name the tab was handed, where it was opened by none.
  const unnamed = Object.assign(shown(null), { repo: 'org/named' })
  unnamed.openItem(click(), 'issues', item(3))
  assert.equal(opened.pop().repository.repo, 'org/named')
  for (const held of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    const event = click(held)
    view.openItem(event, 'pulls', item(5))
    assert.equal(event.prevented, false, JSON.stringify(held))
  }
  assert.equal(opened.length, 1)
})

test('a pulse that fails says why, and reads again on Retry', async () => {
  answer = () => Promise.reject(new Error('Reading a repository’s pulse needs your GitHub sign-in.'))
  const view = shown()
  view.render()
  await setImmediate()
  assert.match(templateText(view.render()), /role="alert">Reading a repository’s pulse needs your GitHub sign-in\.[^]*Retry/u)
  view.render()
  assert.equal(requests.length, 1, 'not read again till its retry is due')
})
