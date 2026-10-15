import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import { templateText } from './_lit.js'

const state = {}
const requests = []
let answer = null
mock.module('../client/index.js', { exports: { state } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchRepositoryAgents(repoId, options) { requests.push([repoId, options]); return answer(repoId, options) },
  fetchRepositoryHistory: () => new Promise(() => {}),
} })
mock.module('../ui/view/repository-code.js', { exports: { navigateToRepositoryCode() {}, shownRevision: () => ({}) } })
const opened = []
mock.module('../ui/view/lazy-dialogs.js', { exports: { openRepositoryItemDialog(props) { opened.push(props) } } })
const watching = new Map()
mock.module('../ui/view/lazy-render.js', { exports: {
  watchNearViewport(target, cb) { watching.set(target, cb) },
  unwatchNearViewport(target) { watching.delete(target) },
} })
const { agentStats, filterSessions, sessionLink } = await import('../ui/view/repository-agents.js')
const { agentIcon } = await import('../ui/view/repository-tiles.js')
const Agents = customElements.get('repository-agents')

let session = 0
beforeEach(() => {
  requests.length = 0
  // A session of its own each, so nothing kept from another test answers.
  state.managedSession = { id: `s-${++session}`, role: 'admin' }
})

const none = { sessions: [], tasks: [], claude: false, agents: [] }
const claude = id => ({ sessions: [id], tasks: [], claude: true, agents: [] })
const pull = (number, head, signals, more = {}) => ({ number, title: `Pull ${number}`, state: 'merged', draft: false, author: 'ada', createdAt: number, updatedAt: Date.now() - 3 * 3_600_000 + number,
  head, additions: 1000, deletions: 5, commits: 2, closes: [], signals, ...more })
const shown = repo => Object.assign(new Agents(), { repository: { repoId: 7, repo, commit: 'a'.repeat(40), path: '' } })
const firstPage = () => ({
  pulls: [pull(9, 'claude/one', claude('session_A'), { state: 'open', closes: [3] }), pull(8, 'claude/one', claude('session_A')), pull(5, 'codex/two', none),
    pull(4, 'deps/bump', none)],
  commits: [{ oid: 'c'.repeat(40), title: 'Pushed to main', at: Date.now(), author: 'ada', additions: 1, deletions: 1, signals: claude('session_A') }],
  issues: [{ number: 3, title: 'Asked', state: 'closed', author: 'grace', createdAt: 1, updatedAt: 1 }],
  // One left without a pull request, and one older than every pull request
  // read, which may be among those yet to read.
  branches: [{ name: 'codex/left', at: Date.now() - 60_000, author: 'ada', signals: none }, { name: 'codex/old', at: 1, author: 'ada', signals: none }],
  more: true, after: { pulls: 'p_1', commits: null },
})

test('the tab reads the first page and shows a session a tile: its agent, title opening where it ran, author, age, tasks, size, pull requests, commits and issues, and branch', async () => {
  answer = () => Promise.resolve(firstPage())
  const view = shown('org/repo')
  assert.match(templateText(view.render()), /Reading what the agents did…/u)
  await setImmediate()
  const text = templateText(view.render())
  assert.deepEqual(requests, [[7, {}]])
  assert.match(text, /aria-pressed=true [^\n]*>All<span class="n">3\+<\/span>/u)
  assert.match(text, />Claude<span class="n">1\+</u)
  assert.match(text, />Codex<span class="n">2\+</u)
  assert.match(text, /4 pull requests read/u)
  // Each agent's pull requests, branches and commits to main without one, by icon, more to come
  // where its pages are left: pull requests', and the branches waiting on them, not commits'.
  assert.match(text, /role="group" aria-label=Claude>[^]*aria-label=2\+ pull requests[^]*aria-label=1\+ branches[^]*aria-label=1 commit to the default branch without a pull request/u)
  assert.match(text, /role="group" aria-label=Codex>[^]*aria-label=1\+ pull requests[^]*aria-label=2\+ branches[^]*<\/span>\s*<\/span><\/span>/u)
  assert.doesNotMatch(text, /aria-label=0 commits/u, 'none pushed without a pull request, none counted')
  // The session: its two pull requests and its commit to main, the issue it names.
  assert.match(text, /aria-label=Claude[^]*href=https:\/\/claude\.ai\/code\/session_A[^>]*>Pull 8<[^]*ada[^]*now<\/time>[^]*3 tasks[^]*\+2,001[^]*−11/u)
  assert.match(text, /href=https:\/\/github\.com\/org\/repo\/pull\/9[^]*?>#9<[^]*pull\/8[^]*?>#8<[^]*commit\/c{40}[^]*?><code>ccccccc<\/code>[^]*issues\/3[^]*?><span class="sr-only">Issue <\/span>#3</u)
  assert.match(text, /<code>claude\/one<\/code>/u)
  // Each chip with how many follow it, seen past the last that fits.
  assert.match(text, /data-rest=3>#9<[^]*data-rest=2>#8<[^]*data-rest=1><code>[^]*issues\/3[^]*?data-rest=>/u)
  // A Codex branch's pull request, one left without any; work no agent did is none.
  assert.match(text, /href=https:\/\/github\.com\/org\/repo\/pull\/5[^>]*>Pull 5</u)
  assert.match(text, /href=https:\/\/github\.com\/org\/repo\/tree\/codex\/left[^>]*>codex\/left<[^]*no pull request/u)
  assert.doesNotMatch(text, /Pull 4/u)
  assert.doesNotMatch(text, /codex\/old/u, 'older than those read, it waits for the rest')
  assert.match(text, />More</u)
})

test('more read on from the cursors a page ended at, each pull request and commit once, the sessions made again of all read', async () => {
  answer = (repoId, { pulls }) => Promise.resolve(pulls ? { pulls: [pull(8, 'claude/one', claude('session_A')), pull(2, 'claude/one', none)], commits: [], more: false, after: null }
    : firstPage())
  const view = shown('org/repo')
  view.render()
  await setImmediate()
  view.list().more()
  await setImmediate()
  assert.deepEqual(requests.at(-1), [7, { pulls: 'p_1', commits: null }])
  const text = templateText(view.render())
  assert.match(text, /5 pull requests read/u)
  assert.match(text, />Pull 2<[^]*4 tasks/u, 'an older one on its branch, its first task now')
  assert.match(text, /codex\/old[^]*no pull request/u, 'all read, a branch without one shows')
  assert.doesNotMatch(text, />More</u)
})

test('the agent picked, and the filter, pick among the sessions read; a session links where it ran, else on GitHub', async () => {
  answer = () => Promise.resolve(firstPage())
  const view = shown('org/repo')
  view.render()
  await setImmediate()
  const sessions = view.list().entry.sessions
  assert.deepEqual(filterSessions(sessions, 'codex', '').map(item => item.title), ['codex/left', 'Pull 5'])
  assert.deepEqual(filterSessions(sessions, 'all', 'ccccccc').map(item => item.title), ['Pull 8'])
  assert.deepEqual(filterSessions(sessions, 'all', 'asked #9').map(item => item.title), ['Pull 8'])
  assert.deepEqual(filterSessions(sessions, 'claude', 'left'), [])
  view.pick('codex')
  assert.doesNotMatch(templateText(view.render()), /Pull 8/u)
  view._filter = 'nothing'
  assert.match(templateText(view.render()), /None of the Codex sessions read match\./u)
  view.pick('all')
  assert.deepEqual([agentStats(sessions, 'claude'), agentStats(sessions, 'codex')], [{ pulls: 2, branches: 1, commits: 1 }, { pulls: 1, branches: 2, commits: 0 }])
  const base = { sessions: [], tasks: [], pulls: [], commits: [], branches: [] }
  assert.equal(sessionLink({ ...base, tasks: ['task_e_123456'] }, 'org/repo'), 'https://chatgpt.com/codex/tasks/task_e_123456')
  assert.equal(sessionLink({ ...base, commits: [{ oid: 'c'.repeat(40) }] }, 'org/repo'), `https://github.com/org/repo/commit/${'c'.repeat(40)}`)
  assert.equal(sessionLink({ ...base, branches: ['codex/a b'] }, null), null, 'a repository unnamed yet links none on GitHub')
})

test('more read on their own only while each page adds a session; after one adding none, a click reads on', async () => {
  // Pages of pull requests no agent made: none adds a session.
  answer = (repoId, { pulls }) => Promise.resolve(pulls ? { pulls: [pull(Number(pulls.slice(2)), 'deps/bump', none)], commits: [], more: true, after: { pulls: `p_${Number(pulls.slice(2)) + 1}`, commits: null } }
    : firstPage())
  const view = shown('org/repo')
  view.render()
  await setImmediate()
  let clicks = 0
  const button = { isConnected: true, disabled: false, parentElement: { querySelector: () => null }, click() { clicks++; view.list().more() } }
  view.querySelector = () => button
  const updated = near => { watching.delete(button); view.updated(); watching.get(button)(near) }
  updated(true)
  await setImmediate()
  assert.equal(clicks, 1, 'the first page\'s sessions leave room: it reads on')
  updated(true)
  await setImmediate()
  assert.equal(clicks, 1, 'that page added none: it waits')
  assert.equal(requests.length, 2)
  // A click reads on, and auto-reading with it, till a page adds none again.
  const [clicked] = templateText(view.render()).match(/@click=\(\) => \{ entry\.stalled = false; more\(\) \}/u) ?? []
  assert.ok(clicked, 'its button clears the wait as it reads')
  view.list().entry.stalled = false
  updated(true)
  await setImmediate()
  assert.equal(requests.length, 3)
})

test('more read as their button nears the end, but not while a filter picks; a list that fails says why', async () => {
  answer = () => Promise.resolve(firstPage())
  const view = shown('org/repo')
  view.render()
  await setImmediate()
  let clicks = 0
  const button = { isConnected: true, disabled: false, parentElement: { querySelector: () => null }, click() { clicks++ } }
  view.querySelector = () => button
  const updated = near => { watching.delete(button); view.updated(); watching.get(button)(near) }
  view._filter = 'x'
  updated(true)
  assert.equal(clicks, 0)
  view._filter = ''
  updated(true)
  assert.equal(clicks, 1)
  answer = () => Promise.reject(new Error('Reading what the agents did needs your GitHub sign-in.'))
  state.managedSession = { id: `s-${++session}`, role: 'admin' }
  const failed = shown('org/repo')
  failed.render()
  await setImmediate()
  assert.match(templateText(failed.render()), /role="alert">Reading what the agents did needs your GitHub sign-in\.[^]*Retry/u)
})

test('a session clicked, its card or title, opens its popup; a pull request or issue of it, that one\'s; a commit, on GitHub; held with a key, a link', async () => {
  answer = () => Promise.resolve(firstPage())
  const view = shown('org/repo')
  view.render()
  await setImmediate()
  const claudeSession = view.list().entry.sessions.find(item => item.id === 'session_A')
  const click = (more = {}) => ({ button: 0, target: { closest: () => null }, prevented: false, stopped: false,
    preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true }, ...more })
  opened.length = 0
  const card = click()
  view.openSession(card, claudeSession)
  assert.equal(card.prevented, true)
  assert.deepEqual(opened, [{ repository: view.repository, target: { session: claudeSession } }])
  const commit = click({ target: { closest: selector => selector === '.agent-chip.is-commit' ? {} : null } })
  view.openSession(commit, claudeSession)
  assert.equal(commit.prevented, false, 'a commit opens on GitHub')
  const held = click({ metaKey: true })
  view.openSession(held, claudeSession)
  assert.equal(held.prevented, false)
  const chip = click()
  view.openItem(chip, 9, { kind: 'pulls', ...claudeSession.pulls[0] })
  assert.deepEqual([chip.prevented, chip.stopped], [true, true], 'its own popup, not its session\'s')
  assert.deepEqual(opened.at(-1).target, { number: 9, preview: { kind: 'pulls', ...claudeSession.pulls[0] } })
  assert.equal(opened.length, 2)
  // Each chip of a pull request or issue opens its own; a commit's none.
  const text = templateText(view.render())
  assert.match(text, /pull\/9 [^]*?@click=event => this\.openItem\(event, preview\.number, preview\)[^]*?>#9</u)
  assert.match(text, /commit\/c{40} [^]*?@click=\s+data-rest=1><code>/u)
})

test('an agent the server knows by its app: picked after Claude and Codex, counted before them, its avatar its mark, first on its tiles, Claude\'s beside it where its marks are', async () => {
  const neo = { ...none, agents: ['neo'] }
  answer = () => Promise.resolve({ pulls: [pull(12, 'neo/links', { ...neo, claude: true }), pull(11, 'neo/bump', neo), pull(10, 'claude/one', claude('session_A'))],
    commits: [], issues: [], branches: [],
    agents: [{ id: 'neo', name: ' Neo ', avatar: 'app-3115942' }, { id: 'claude', name: 'Not Claude', avatar: 'app-1' }, { id: 'odd one', name: 'Odd', avatar: 'app-2' },
      { id: 'nameless', avatar: 'app-3' }, { id: 'odd-avatar', name: 'Odd', avatar: '../x' }, { id: 'copilot', name: 'Copilot' }],
    more: false, after: null })
  const view = shown('org/repo')
  view.render()
  await setImmediate()
  assert.deepEqual(view.list().entry.agents, [{ id: 'neo', name: 'Neo', avatar: 'app-3115942' }, { id: 'copilot', name: 'Copilot', avatar: null }],
    'only well formed, never Claude or Codex; one the app draws its mark for, without an avatar')
  assert.match(templateText(agentIcon('copilot')), /^<span class="agent-logo" aria-hidden="true"><svg [^>]*viewBox="0 0 24 24"/u, 'Copilot\'s mark, drawn, not fetched')
  const text = templateText(view.render())
  assert.match(text, />Claude<span class="n">2<[^]*>Codex<span class="n">0<[^]*class=agent-pick is-neo [^]*src=\/api\/avatar\/app-3115942 [^]*>Neo<span class="n">2</u)
  assert.doesNotMatch(text, /agent-pick is-copilot/u, 'an agent the server knows with no session read is not picked among')
  assert.match(text, /class="agent-totals"><span class="agent-stats" role="group" aria-label=Neo>[^]*aria-label=Claude>/u)
  assert.doesNotMatch(text, /role="group" aria-label=Codex>/u, 'an agent with no session read is not counted')
  assert.match(text, /class="issue-rail"><span class=agent-mark is-neo role="img" aria-label=Neo><img class="agent-avatar" src=\/api\/avatar\/app-3115942 [^]*<span class=agent-mark is-claude role="img" aria-label=Claude>[^]*>Pull 12</u)
  assert.equal(view.list().entry.sessions.filter(item => item.agents[0] === 'neo').length, 2, 'a pull request a session')
})
