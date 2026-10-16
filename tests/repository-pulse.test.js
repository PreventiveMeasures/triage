import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import { templateText } from './_lit.js'

const state = {}
const requests = []
let answer = null
// The app's users and agents an answer names kept as client-managed.js keeps them.
let knowing = read => read()
mock.module('../client/index.js', { exports: { state } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchRepositoryPulse(repoId, weeks) { requests.push([repoId, weeks]); return knowing(() => answer(repoId, weeks)) },
  fetchRepositoryHistory: () => new Promise(() => {}),
} })
mock.module('../ui/view/repository-code.js', { exports: { navigateToRepositoryCode() {}, shownRevision: () => ({}) } })
const opened = []
mock.module('../ui/view/lazy-dialogs.js', { exports: { openRepositoryItemDialog(props) { opened.push(props) } } })
const { niceScale, periodContributors, pulseSummary } = await import('../ui/view/repository-pulse.js')
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

// The year's weeks, a commit a day, ten lines added and two removed a week;
// two a day the week of Sep 6, and this week none after today.
const year = () => Array.from({ length: 52 }, (_, at) => {
  const week = FIRST + at * WEEK
  const days = week === Date.UTC(2026, 8, 6) ? Array.from({ length: 7 }, () => 2) : at === 51 ? [1, 1, 1, 1, 1, 0, 0] : Array.from({ length: 7 }, () => 1)
  return { week, days, commits: days.reduce((sum, count) => sum + count, 0), additions: 10, deletions: 2 }
})
const punch = () => Array.from({ length: 7 }, (_, day) => Array.from({ length: 24 }, (__, hour) => day === 2 && hour === 14 ? 12 : day === 6 ? 0 : 1))
const stats = (more = {}) => ({ weeks: year(), contributors: [
  { login: 'ada', name: 'Ada', weeks: [[SINCE, 3, 30, 4], [SINCE + WEEK, 2, 5, 1], [SINCE - WEEK, 9, 9, 9]] },
  { login: 'grace', name: null, weeks: [[SINCE - 2 * WEEK, 4, 1, 0]] },
  { login: 'claude[bot]', name: null, weeks: [[SINCE + 2 * WEEK, 5, 2000, 10]] },
  { login: null, name: 'Alan Kay', weeks: [[SINCE + WEEK, 1, 3, 0]] },
], punch: punch(), lines: true, ...more })
const item = (number, more = {}) => ({ number, title: `Item ${number}`, author: 'ada', at: NOW - 3 * 3_600_000, createdAt: NOW - DAY, kind: 'pulls', state: 'merged', draft: false, ...more })
const pulse = (more = {}) => ({ weeks: 4, since: SINCE, previousSince: SINCE - 4 * WEEK,
  merged: { count: 12, previous: 8, items: [item(5), item(4, { title: '' })] }, opened: { count: 2, previous: 2, items: [item(6, { state: 'open', draft: true })] },
  closed: { count: 0, previous: 3, items: [] }, created: { count: 1, previous: 0, items: [item(3, { kind: 'issues', state: 'open', reason: null })] },
  stats: stats(), reading: null, pending: false, users: { 'claude[bot]': { agent: 'claude' } }, ...more })
const shown = (repo = 'org/repo') => Object.assign(new Pulse(), { repository: { repoId: 7, repo, commit: 'a'.repeat(40), path: '' } })

test('a period\'s figures: its commits, beside the same days of the week a period earlier where the year reaches back; its lines; who made commits', () => {
  const read = pulse()
  assert.deepEqual(pulseSummary(read, NOW), { commits: 26, previous: 33, additions: 40, deletions: 8, authors: 3 })
  assert.equal(pulseSummary({ ...read, weeks: 52, since: FIRST }, NOW).previous, null, 'the year before the year GitHub counts')
  const large = pulseSummary({ ...read, stats: stats({ lines: false }) }, NOW)
  assert.deepEqual([large.additions, large.deletions], [null, null])
  assert.deepEqual(pulseSummary({ ...read, stats: null, pending: true }, NOW), { commits: null, previous: null, additions: null, deletions: null, authors: null })
})

test('the period\'s contributors, the most commits first, and a scale\'s round ticks', () => {
  assert.deepEqual(periodContributors(stats().contributors, SINCE), [
    { login: 'ada', name: 'Ada', commits: 5, additions: 35, deletions: 5 }, { login: 'claude[bot]', name: null, commits: 5, additions: 2000, deletions: 10 },
    { login: null, name: 'Alan Kay', commits: 1, additions: 3, deletions: 0 }])
  assert.deepEqual([niceScale(93), niceScale(7), niceScale(1), niceScale(0), niceScale(12_000)], [
    { top: 100, ticks: [0, 50, 100] }, { top: 10, ticks: [0, 5, 10] }, { top: 1, ticks: [0, 1] }, { top: 1, ticks: [0, 1] },
    { top: 15_000, ticks: [0, 5000, 10_000, 15_000] }])
})

test('a user of the app is one contributor whichever of their GitHub accounts committed', () => {
  knowGithubUsers({ users: { mona: { id: 'mona-id', login: 'mona', name: 'Mona' }, 'mona-work': { id: 'mona-id', login: 'mona', name: 'Mona' },
    claude: { agent: 'claude' }, 'claude[bot]': { agent: 'claude' }, 'dependabot[bot]': { agent: 'dependabot' } } })
  const week = (commits, additions) => [[SINCE, commits, additions, 1]]
  assert.deepEqual(periodContributors([{ login: 'mona-work', name: 'M', weeks: week(4, 10) }, { login: 'other', name: null, weeks: week(5, 1) },
    { login: 'mona', name: 'Mona', weeks: week(2, 5) }, { login: null, name: 'Mona', weeks: week(1, 1) }], SINCE), [
    { login: 'mona-work', name: 'M', commits: 6, additions: 15, deletions: 2 }, { login: 'other', name: null, commits: 5, additions: 1, deletions: 1 },
    { login: null, name: 'Mona', commits: 1, additions: 1, deletions: 1 }], 'one known by name alone is no user\'s')
  assert.deepEqual(periodContributors([{ login: 'claude', name: 'Claude', weeks: week(1, 1) }, { login: 'claude[bot]', name: null, weeks: week(2, 2) },
    { login: null, name: 'Claude', weeks: week(3, 3) }, { login: null, name: 'Codex', weeks: week(1, 1) },
    { login: 'dependabot[bot]', name: 'dependabot[bot]', weeks: week(4, 4) }, { login: null, name: 'dependabot[bot]', weeks: week(1, 1) }], SINCE), [
    { login: 'claude', name: 'Claude', commits: 6, additions: 6, deletions: 3 }, { login: 'dependabot[bot]', name: 'dependabot[bot]', commits: 5, additions: 5, deletions: 2 },
    { login: null, name: 'Codex', commits: 1, additions: 1, deletions: 1 }],
  'an agent is one contributor whichever of its identities committed')
})

test('the pulse reads a month first: its figures beside the month before, the year\'s weeks with the period\'s marked, its contributors, when commits are made, and its lists', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  answer = () => Promise.resolve(pulse())
  const view = shown()
  assert.match(templateText(view.render()), /Reading the repository’s pulse…/u)
  await setImmediate()
  const text = templateText(view.render())
  assert.deepEqual(requests, [[7, 4]])
  assert.match(text, /^<div class="history-bar">/u, 'the bar none of the charts\' bars')
  assert.match(text, /aria-pressed=true [^\n]*>Month</u)
  assert.match(text, /class="pulse-range">Sep 20 – Oct 15</u)
  assert.match(text, /Commits<\/span>\s*<span class="pulse-tile-value">26<\/span>\s*<span class="pulse-tile-note">↓ from 33 the month before</u)
  assert.match(text, /Contributors<\/span>\s*<span class="pulse-tile-value">3</u)
  assert.match(text, /Pull requests merged<\/span>\s*<span class="pulse-tile-value">12<\/span>\s*<span class="pulse-tile-note">↑ from 8 the month before<\/span>\s*<span class="pulse-tile-note">2 opened/u)
  assert.match(text, /Issues closed<\/span>\s*<span class="pulse-tile-value">0<\/span>\s*<span class="pulse-tile-note">↓ from 3 the month before/u)
  assert.match(text, /<span>\+40<\/span> <span>−8<\/span>/u)
  const columns = text.split('class=pulse-column').slice(1)
  assert.equal(columns.length, 104, 'a column a week in each plot')
  assert.deepEqual(columns.slice(0, 52).map(column => column.startsWith(' is-period')).lastIndexOf(false), 47, 'the period\'s four weeks marked')
  assert.match(columns[51], /^ is-period role="img" aria-label=Week of Oct 11, 2026: 5 commits data-tooltip=Week of Oct 11, 2026: 5 commits>/u)
  assert.match(columns[52], /aria-label=Week of Oct 19, 2025: \+10 −2 lines/u)
  assert.match(text, /<span style=--at: 1><span>15<\/span>/u, 'commits\' scale to a round top over the most')
  assert.match(text, /class="pulse-months"[^]*<span>Nov<\/span>[^]*<span>2026<\/span>/u, 'months named where they start, January by its year')
  assert.match(text, /href=https:\/\/github\.com\/ada [^>]*>ada<\/a>[^]*--value: 1[^]*>5<\/span>[^]*\+35 −5/u)
  assert.match(text, /href=https:\/\/github\.com\/apps\/claude [^>]*><span class="app-user" data-tooltip=@claude\[bot\] on GitHub>[^]*?is-claude[^]*?app-user-name">Claude</u,
    'an app by its page, Claude\'s by its mark')
  assert.match(text, /<span class="pulse-rank-name">Alan Kay<\/span>/u, 'one GitHub names no account for, by name, unlinked')
  assert.doesNotMatch(text, />grace</u, 'none of the period\'s')
  assert.match(text, /class=pulse-cell is-6 role="img" aria-label=Tuesdays, 14:00–15:00: 12 commits/u)
  assert.match(text, /class=pulse-cell is-1 role="img" aria-label=Mondays, 00:00–01:00: 1 commit /u)
  assert.match(text, /class=pulse-cell is-0 role="img" aria-label=Saturdays, 00:00–01:00: 0 commits/u)
  assert.ok(text.indexOf('>Mon<') < text.indexOf('>Sun<'), 'Monday first')
  assert.match(text, /Merged pull requests<span class="issues-count">12<\/span>[^]*href=https:\/\/github\.com\/org\/repo\/pull\/5\s[^]*Item 5[^]*#5[^]*3h<\/time>[^]*\(no title\)/u)
  assert.match(text, /href=https:\/\/github\.com\/org\/repo\/pulls\?q=is%3Apr%20is%3Amerged%20merged%3A%3E%3D2026-09-20 [^>]*>All 12 on GitHub</u)
  assert.match(text, /Closed issues<span class="issues-count">0<\/span><\/h3>\s*<p class="pulse-note">None in the period\.<\/p>/u)
  assert.match(text, /href=https:\/\/github\.com\/org\/repo\/issues\/3\s/u)
  assert.deepEqual(text.match(/All \d+ on GitHub/gu), ['All 12 on GitHub', 'All 2 on GitHub'], 'a list of all GitHub found holds no link to more')
  // Opened by none, its name is the one its repositories list it by, once they arrive.
  const unnamed = shown(null)
  assert.doesNotMatch(templateText(unnamed.render()), /github\.com\/org/u)
  unnamed.repo = 'org/named'
  assert.match(templateText(unnamed.render()), /href=https:\/\/github\.com\/org\/named\/pull\/5\s/u)
})

test('another period is read for itself, the last one shown faded meanwhile; read, it is kept', async t => {
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
  assert.match(text, /class=pulse-scroll is-reading aria-busy=true/u)
  assert.match(text, /Sep 20 – Oct 15/u)
  release()
  await setImmediate()
  text = templateText(view.render())
  assert.match(text, /class=pulse-scroll aria-busy=false/u)
  assert.match(text, /Oct 19, 2025 – Oct 15, 2026/u)
  assert.match(text, /Commits<\/span>\s*<span class="pulse-tile-value">369<\/span>\s*<span class="pulse-tile-note">to the default branch/u, 'no year before it to compare')
  assert.match(text, /The year/u)
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
  assert.match(templateText(view.render()), /class=pulse-column is-period/u)
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
  assert.match(text, /class=pulse-column is-period/u, 'the commits counted shown')
  assert.match(text, /Lines<\/span>\s*<span class="pulse-tile-value">–<\/span>\s*<span class="pulse-tile-note">Counting…/u)
  assert.match(text, /GitHub hasn’t counted lines added and removed yet\. <button[^]*?>Ask again</u)
  assert.doesNotMatch(text, /pulse-rank-lines/u, 'no contributor\'s lines')
})

test('the charts as tables: the year\'s weeks, the latest first, the period\'s marked; the period\'s contributors; commits by day and hour', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW })
  answer = () => Promise.resolve(pulse())
  const view = shown()
  view.render()
  await setImmediate()
  view.show('table')
  const text = templateText(view.render())
  view.show('charts')
  assert.doesNotMatch(text, /pulse-column/u)
  assert.match(text, /<caption>Commits and lines a week, over the last year<\/caption>[^]*<tr class=is-period>\s*<th scope="row">Oct 11, 2026<\/th><td>5<\/td>\s*<td>\+10<\/td><td>−2<\/td>/u)
  assert.match(text, /<tr class=>\s*<th scope="row">Sep 13, 2026/u)
  assert.match(text, /<caption>Contributors in the period<\/caption>[^]*<th scope="row">ada<\/th><td>5<\/td>/u)
  assert.match(text, /<th scope="row">Tue<\/th>(?:<td>1<\/td>){14}<td>12<\/td>/u)
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
