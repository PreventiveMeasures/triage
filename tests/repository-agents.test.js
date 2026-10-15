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
const watching = new Map()
mock.module('../ui/view/lazy-render.js', { exports: {
  watchNearViewport(target, cb) { watching.set(target, cb) },
  unwatchNearViewport(target) { watching.delete(target) },
} })
const { filterSessions, sessionLink } = await import('../ui/view/repository-agents.js')
const Agents = customElements.get('repository-agents')

let session = 0
beforeEach(() => {
  requests.length = 0
  // A session of its own each, so nothing kept from another test answers.
  state.managedSession = { id: `s-${++session}`, role: 'admin' }
})

const none = { sessions: [], tasks: [], claude: false }
const claude = id => ({ sessions: [id], tasks: [], claude: true })
const pull = (number, head, signals, more = {}) => ({ number, title: `Pull ${number}`, state: 'merged', draft: false, author: 'ada', createdAt: number, updatedAt: Date.now() - 3 * 3_600_000 + number,
  head, additions: 1000, deletions: 5, commits: 2, closes: [], signals, ...more })
const shown = repo => Object.assign(new Agents(), { repository: { repoId: 7, repo, commit: 'a'.repeat(40), path: '' } })
const firstPage = () => ({
  pulls: [pull(9, 'claude/one', claude('session_A'), { state: 'open' }), pull(8, 'claude/one', claude('session_A')), pull(5, 'codex/two', none), pull(4, 'deps/bump', none)],
  commits: [{ oid: 'c'.repeat(40), title: 'Pushed to main', at: Date.now(), author: 'ada', additions: 1, deletions: 1, signals: claude('session_A') }],
  issues: [{ number: 3, title: 'Asked', state: 'closed', author: 'grace', createdAt: 1, updatedAt: 1, signals: claude('session_A') }],
  // One left without a pull request, and one older than every pull request
  // read, which may be among those yet to read.
  branches: [{ name: 'codex/left', at: Date.now() - 60_000, author: 'ada', signals: none }, { name: 'codex/old', at: 1, author: 'ada', signals: none }],
  more: true, after: { pulls: 'p_1', commits: null },
})

test('the tab reads the first page and shows a session a tile: its agent, title opening where it ran, author, age, tasks, size, pull requests, commits and issues, and branch', async () => {
  answer = () => Promise.resolve(firstPage())
  const view = shown('org/repo')
  assert.match(templateText(view.render()), /Reading what Claude and Codex did…/u)
  await setImmediate()
  const text = templateText(view.render())
  assert.deepEqual(requests, [[7, {}]])
  assert.match(text, /aria-pressed=true [^\n]*>All <span class="issues-count">3\+<\/span>/u)
  assert.match(text, />Claude <span class="issues-count">1\+</u)
  assert.match(text, />Codex <span class="issues-count">2\+</u)
  assert.match(text, /4 pull requests read/u)
  // The session: its two pull requests and its commit to main, the issue it names.
  assert.match(text, /aria-label=Claude[^]*href=https:\/\/claude\.ai\/code\/session_A[^>]*>Pull 8<[^]*ada[^]*now<\/time>[^]*3 tasks[^]*\+2,001[^]*−11/u)
  assert.match(text, /href=https:\/\/github\.com\/org\/repo\/pull\/9[^>]*>#9<[^]*pull\/8[^>]*>#8<[^]*commit\/c{40}[^>]*><code>ccccccc<\/code>[^]*issues\/3[^>]*><span class="sr-only">Issue <\/span>#3</u)
  assert.match(text, /<code>claude\/one<\/code>/u)
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
  const base = { sessions: [], tasks: [], pulls: [], commits: [], branches: [] }
  assert.equal(sessionLink({ ...base, tasks: ['task_e_123456'] }, 'org/repo'), 'https://chatgpt.com/codex/tasks/task_e_123456')
  assert.equal(sessionLink({ ...base, commits: [{ oid: 'c'.repeat(40) }] }, 'org/repo'), `https://github.com/org/repo/commit/${'c'.repeat(40)}`)
  assert.equal(sessionLink({ ...base, branches: ['codex/a b'] }, null), null, 'a repository unnamed yet links none on GitHub')
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
  answer = () => Promise.reject(new Error('Reading what Claude and Codex did needs your GitHub sign-in.'))
  state.managedSession = { id: `s-${++session}`, role: 'admin' }
  const failed = shown('org/repo')
  failed.render()
  await setImmediate()
  assert.match(templateText(failed.render()), /role="alert">Reading what Claude and Codex did needs your GitHub sign-in\.[^]*Retry/u)
})
