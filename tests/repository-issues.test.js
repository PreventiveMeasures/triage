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
  fetchRepositoryIssues(repoId, kind, options) { requests.push([repoId, kind, options]); return answer(repoId, kind, options) },
  fetchRepositoryHistory: () => new Promise(() => {}),
} })
mock.module('../ui/view/repository-code.js', { exports: { navigateToRepositoryCode() {}, shownRevision: () => ({}) } })
const watching = new Map()
mock.module('../ui/view/lazy-render.js', { exports: {
  watchNearViewport(target, cb) { watching.set(target, cb) },
  unwatchNearViewport(target) { watching.delete(target) },
} })
const { filterIssues, issueState } = await import('../ui/view/repository-issues.js')
const Issues = customElements.get('repository-issues')

let session = 0
beforeEach(() => {
  requests.length = 0
  // A session of its own each, so nothing kept from another test answers.
  state.managedSession = { id: `s-${++session}`, role: 'admin' }
})

const issue = (number, more = {}) => ({ number, title: `Issue ${number}`, author: 'octo', createdAt: 0, updatedAt: Date.now() - 3 * 3_600_000, closedAt: null, comments: 0,
  labels: [], moreLabels: 0, state: 'open', reason: null, ...more })
const pull = (number, more = {}) => ({ ...issue(number), state: 'open', draft: false, mergedAt: null, review: null, checks: null, additions: 1200, deletions: 3,
  head: 'feature/x', base: 'main', ...more })
const shown = (kind = 'issues', repo = 'org/repo') => Object.assign(new Issues(), { repository: { repoId: 7, repo, commit: 'a'.repeat(40), path: '' }, kind })

test('the issues open read first, as tiles opening on GitHub, each its state, number, author, age, title, labels and comments, with how many are open and closed', async () => {
  answer = () => Promise.resolve({ items: [issue(12, { comments: 4, labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'ui', color: null }, { name: 'docs', color: null },
    { name: 'perf', color: null }], moreLabels: 2 }), issue(9, { title: '' }), { number: 'x' }], counts: { open: 1234, closed: 40 }, more: false })
  const view = shown()
  assert.match(templateText(view.render()), /Reading the issues…/u)
  await setImmediate()
  const text = templateText(view.render())
  assert.deepEqual(requests, [[7, 'issues', { state: 'open', after: null }]])
  assert.match(text, /aria-pressed=true [^\n]*>Open <span class="issues-count">1,234<\/span>/u)
  assert.match(text, /Closed <span class="issues-count">40<\/span>/u)
  assert.match(text, /href=https:\/\/github\.com\/org\/repo\/issues\/12 target="_blank" rel="noopener noreferrer"/u)
  assert.match(text, /aria-label=Open[^]*Issue 12[^]*#12[^]*octo[^]*3h<\/time>/u)
  assert.match(text, />bug<[^]*>ui<[^]*>docs<\/span><span class="issue-label is-more">\+3</u, 'three labels, then how many more')
  assert.match(text, /4<span class="sr-only"> comments<\/span>/u)
  assert.match(text, /\(no title\)/u)
  assert.equal(text.split('<li ').length - 1, 2, 'one GitHub names no number for left out')
  // Closed reads its own list.
  view.pick('closed')
  view.render()
  assert.deepEqual(requests.at(-1), [7, 'issues', { state: 'closed', after: null }])
  view.pick('open')
})

test('a tile\'s state: open, merged, closed or draft for a pull request; open, completed or not planned for an issue', () => {
  assert.deepEqual([pull(1), pull(1, { draft: true }), pull(1, { state: 'merged' }), pull(1, { state: 'closed' })].map(item => issueState('pulls', item)[0]),
    ['open', 'draft', 'merged', 'closed'])
  assert.deepEqual([issue(1), issue(1, { state: 'closed', reason: 'completed' }), issue(1, { state: 'closed', reason: 'not-planned' }), issue(1, { state: 'closed', reason: 'duplicate' })]
    .map(item => issueState('issues', item)), [['open', 'Open'], ['completed', 'Closed'], ['not-planned', 'Closed as not planned'], ['not-planned', 'Closed as duplicate']])
})

test('a pull request\'s tile names its branches, size, review and checks, and a repository unnamed yet shows its tiles unlinked', async () => {
  answer = () => Promise.resolve({ items: [pull(5, { review: 'changes', checks: 'failure' }), pull(4, { state: 'merged', review: 'approved', checks: 'success' })],
    counts: { open: 1, closed: 1 }, more: false })
  const view = shown('pulls')
  view.render()
  await setImmediate()
  const text = templateText(view.render())
  assert.match(text, /href=https:\/\/github\.com\/org\/repo\/pull\/5/u)
  assert.match(text, /<code>feature\/x<\/code>[^]*<code>main<\/code>[^]*\+1,200[^]*−3/u)
  assert.match(text, /issue-review is-changes>Changes requested<[^]*aria-label=Checks failed>/u)
  assert.doesNotMatch(text, /Approved/u, 'a merged one\'s review is done with')
  assert.match(text, /aria-label=Checks passed>/u)
  const unnamed = shown('pulls', null)
  assert.doesNotMatch(templateText(unnamed.render()), /href=/u)
})

test('the filter picks among those read by every word, in a number, title, author, label or branch', async () => {
  const items = [pull(12, { title: 'Treemap labels overlap', labels: [{ name: 'ui', color: null }] }), pull(9, { title: 'Search speed', author: 'grace', head: 'perf/search' })]
  assert.deepEqual(filterIssues(items, '').map(item => item.number), [12, 9])
  assert.deepEqual(filterIssues(items, '#12').map(item => item.number), [12])
  assert.deepEqual(filterIssues(items, 'UI treemap').map(item => item.number), [12])
  assert.deepEqual(filterIssues(items, 'grace perf/').map(item => item.number), [9])
  assert.deepEqual(filterIssues(items, 'treemap grace'), [])
  answer = () => Promise.resolve({ items, counts: { open: 2, closed: 0 }, more: false })
  const view = shown('pulls')
  view.render()
  await setImmediate()
  view._filter = 'nothing like it'
  const text = templateText(view.render())
  assert.match(text, /0 of 2 read/u)
  assert.match(text, /None of the open pull requests read match\./u)
})

test('more read on from the cursor a page ended at, each once, as their button nears the end, but not while a filter picks, nor after one failed', async () => {
  let fail = false
  answer = (repoId, kind, { after }) => fail ? Promise.reject(new Error('GitHub’s API rate limit has been reached.'))
    : Promise.resolve(after ? { items: [issue(2), issue(1)], counts: { open: 3, closed: 0 }, more: false } : { items: [issue(3), issue(2)], counts: { open: 3, closed: 0 }, more: true, after: 'c1' })
  const view = shown()
  view.render()
  await setImmediate()
  assert.match(templateText(view.render()), />More</u)
  let clicks = 0
  const button = { isConnected: true, disabled: false, parentElement: { querySelector: () => null }, click() { clicks++ } }
  view.querySelector = () => button
  const updated = near => { watching.delete(button); view.updated(); watching.get(button)(near) }
  view._filter = 'x'
  updated(true)
  assert.equal(clicks, 0, 'not while a filter picks')
  view._filter = ''
  updated(false)
  assert.equal(clicks, 0)
  updated(true)
  assert.equal(clicks, 1)
  // As though clicked: the next page, on from its cursor.
  fail = true
  view.list('open').more()
  await setImmediate()
  assert.deepEqual(requests.at(-1), [7, 'issues', { state: 'open', after: 'c1' }])
  assert.match(templateText(view.render()), /role="alert">GitHub’s API rate limit has been reached\.[^]*>More</u)
  button.parentElement.querySelector = () => ({})
  updated(true)
  assert.equal(clicks, 1, 'not after one failed')
  fail = false
  view.list('open').more()
  await setImmediate()
  const text = templateText(view.render())
  assert.equal(text.split('<li ').length - 1, 3, 'the one read twice listed once')
  assert.doesNotMatch(text, />More</u)
})

test('a list that fails says why, and reads again on Retry', async () => {
  answer = () => Promise.reject(new Error('Reading issues and pull requests needs your GitHub sign-in.'))
  const view = shown()
  view.render()
  await setImmediate()
  assert.match(templateText(view.render()), /role="alert">Reading issues and pull requests needs your GitHub sign-in\.[^]*Retry/u)
  assert.equal(requests.length, 1)
  view.render()
  assert.equal(requests.length, 1, 'not read again till its retry is due')
})
