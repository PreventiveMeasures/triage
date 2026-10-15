import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import { templateText, templates } from './_lit.js'
import { managedRoutePath, parseManagedRoute } from '../common/managed/routes.js'
import { firstParentLine, historyLayout, historyOrder } from '../ui/view/history-graph.js'

const state = {}
const navigations = [], requests = []
let answer = null
mock.module('../client/index.js', { exports: { state } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchRepositoryHistory(repoId, ref, path, options) { requests.push([repoId, ref, path, options]); return answer(repoId, ref, path, options) },
} })
const watching = new Map()
mock.module('../ui/view/lazy-render.js', { exports: {
  watchNearViewport(target, cb) { watching.set(target, cb) },
  unwatchNearViewport(target) { watching.delete(target) },
} })
mock.module('../ui/view/repository-compare.js', { exports: { repositoryCompareSource: () => null } })
mock.module('../ui/view/repository-code.js', { exports: {
  navigateToRepositoryCode(route) { navigations.push(route) },
  shownRevision: ({ revision, commit }) => revision?.name ? revision : { kind: 'commit', name: commit },
} })
const { compactTime, historyRefs, revisionFromAll } = await import('../ui/view/repository-history.js')
const History = customElements.get('repository-history')

const [a, b, c, d, e, x] = ['a', 'b', 'c', 'd', 'e', 'f'].map(char => char.repeat(40))
const commit = (sha, parents, at, subject = `commit ${sha[0]}`) => ({ sha, parents, subject, authorName: 'Ada', authorLogin: null, committedAt: at })

let session = 0
beforeEach(() => {
  requests.length = 0
  navigations.length = 0
  // A session of its own each, so nothing kept from another test answers.
  state.managedSession = { id: `s-${++session}`, role: 'admin' }
})

test('Commits have a route of their own beside the code viewer\'s others, which History\'s links still open', () => {
  const route = { view: 'repository-code', repoId: 7, commit: a, path: 'src', bundleTab: 'commits' }
  assert.equal(managedRoutePath(route), `/manage/code/7/${a}/commits?path=src`)
  assert.deepEqual(parseManagedRoute(new URL(managedRoutePath(route), 'https://triage.test')), route)
  assert.deepEqual(parseManagedRoute(new URL(`https://triage.test/manage/code/7/${a}/history?path=src`)), route)
  assert.equal(managedRoutePath({ ...route, bundleTab: 'history' }), null, 'no route names History')
  assert.equal(parseManagedRoute(new URL(`https://triage.test/manage/code/7/${a}/commits/2`)), null, 'only Code names a file')
})

test('commits list newest first, but never a parent before a child of it, whatever its clock says', () => {
  const ordered = historyOrder([commit(d, [], 40), commit(b, [d], 20), commit(c, [d], 30), commit(a, [b, c], 50), commit(e, [a], 10)])
  assert.deepEqual(ordered.map(item => item.sha[0]), ['e', 'a', 'c', 'b', 'd'], 'e, dated before its parent a, comes first all the same')
  assert.deepEqual([...firstParentLine(ordered, e)], [e, a, b, d])
})

test('a merge draws its other parent on a lane of its own, which joins the first lane where the lines meet, and a parent not listed as a short line on', () => {
  const ordered = historyOrder([commit(a, [b, c], 50), commit(c, [d], 40), commit(b, [d], 30), commit(d, [e], 20), commit(e, [x], 10)])
  const layout = historyLayout(ordered, { trunk: firstParentLine(ordered, a) })
  assert.deepEqual(layout.rows.map(({ commit: item, col, color }) => [item.sha[0], col, color]), [['a', 0, 0], ['c', 1, 1], ['b', 0, 0], ['d', 0, 0], ['e', 0, 0]])
  assert.deepEqual(layout.segments, [
    { row: 0, from: 0, to: 0, color: 0 }, { row: 0, from: 0, to: 1, color: 1 },
    { row: 1, from: 0, to: 0, color: 0 }, { row: 1, from: 1, to: 1, color: 1 },
    { row: 2, from: 0, to: 0, color: 0 }, { row: 2, from: 1, to: 0, color: 1 },
    { row: 3, from: 0, to: 0, color: 0 },
  ])
  assert.deepEqual(layout.stubs, [{ row: 4, col: 0, straight: true, color: 0 }])
  assert.equal(layout.width, 2)
})

test('the default branch keeps the first lane and color, a branch with newer commits beside it', () => {
  const ordered = historyOrder([commit(d, [], 10), commit(c, [d], 20), commit(b, [d], 30), commit(a, [c], 40)])
  assert.deepEqual(ordered.map(item => item.sha[0]), ['a', 'b', 'c', 'd'])
  const layout = historyLayout(ordered, { trunk: firstParentLine(ordered, b) })
  assert.deepEqual(layout.rows.map(({ commit: item, col, color }) => [item.sha[0], col, color]), [['a', 1, 1], ['b', 0, 0], ['c', 1, 1], ['d', 0, 0]])
  assert.deepEqual(layout.segments.filter(segment => segment.row === 2), [{ row: 2, from: 0, to: 0, color: 0 }, { row: 2, from: 1, to: 0, color: 1 }])
  // Without one, the newest takes it.
  assert.deepEqual(historyLayout(ordered).rows.map(row => row.col), [0, 1, 0, 0])
})

test('lines side by side take colors unlike each other\'s, and a directory\'s commits draw as one line', () => {
  const ordered = historyOrder([commit(a, [d], 40), commit(b, [d], 30), commit(c, [d], 20), commit(d, [], 10)])
  assert.deepEqual(historyLayout(ordered, { colors: 2 }).rows.map(row => [row.col, row.color]), [[0, 0], [1, 1], [2, 0], [0, 0]])
  const linear = historyLayout([commit(a, [x], 30), commit(c, [x], 20), commit(e, [x], 10)], { linear: true })
  assert.deepEqual(linear.rows.map(row => row.col), [0, 0, 0])
  assert.deepEqual(linear.segments, [{ row: 0, from: 0, to: 0, color: 0 }, { row: 1, from: 0, to: 0, color: 0 }])
  assert.deepEqual(linear.stubs, [{ row: 2, col: 0, straight: true, color: 0 }], 'its history goes on past the last')
})

test('a line\'s time is how long ago, within a week, else its day; branches name a commit before tags, the default branch first', () => {
  const now = Date.UTC(2026, 9, 15, 12)
  assert.deepEqual([30e3, 5 * 60e3, 3 * 3600e3, 2 * 86400e3, 10 * 86400e3, -2 * 86400e3].map(ago => compactTime(now - ago, now)), ['now', '5m', '3h', '2d', 'Oct 5', 'Oct 17'])
  assert.equal(compactTime(Date.UTC(2024, 9, 14, 12), now), 'Oct 14, 2024')
  assert.equal(compactTime(null, now), '')
  const named = historyRefs({ branches: [{ name: 'feature', sha: a }, { name: 'main', sha: a }], tags: [{ name: 'v1', sha: a }, { name: 'v0', sha: b }] }, 'main')
  assert.deepEqual(named.get(a), [{ kind: 'branch', name: 'main', main: true }, { kind: 'branch', name: 'feature', main: false }, { kind: 'tag', name: 'v1' }])
  assert.deepEqual(named.get(b), [{ kind: 'tag', name: 'v0' }])
})

const allAnswer = { all: true, commits: [commit(a, [b], 20, 'Merge work'), commit(b, [], 10, 'First')], branches: [{ name: 'main', sha: a }], tags: [{ name: 'v1', sha: b }],
  defaultBranch: 'main', more: false }
function shownAt(sha, path = '') {
  return Object.assign(new History(), { repository: { repoId: 7, repo: 'org/repo', commit: sha, path, revision: { kind: 'branch', name: null } },
    refs: { status: 'ready', value: { defaultBranch: 'main' } } })
}

test('the tab reads every branch at the root, marks the commit shown, and opens a commit\'s code by the branch naming it', async () => {
  answer = () => Promise.resolve(allAnswer)
  const view = shownAt(a)
  assert.match(templateText(view.render()), /Reading the history/u)
  await setImmediate()
  const text = templateText(view.render())
  assert.deepEqual(requests, [[7, '', '', { page: 1, all: true }]])
  assert.match(text, /aria-pressed=true [^\n]*>All branches</u)
  assert.match(text, /2 commits on 1 branch</u)
  assert.match(text, /aria-current=true[^]*aaaaaaa<\/code>[^]*<span>main<\/span>[^]*Merge work/u)
  // The default branch's chip, marked so, and in the shown revision's, as is
  // the tag's in none.
  const chips = templates(view.render()).filter(template => template.strings.join('').includes('</span></span>') && template.strings[0].startsWith('<span class='))
  assert.deepEqual(chips.map(chip => chip.values[0].values[0]), [
    { 'history-ref': true, 'is-branch': true, 'is-default': true, 'is-shown': false },
    { 'history-ref': true, 'is-tag': true, 'is-default': false, 'is-shown': false },
  ])
  assert.doesNotMatch(text, /among these commits/u)
  view.open(allAnswer.commits[0], historyRefs(allAnswer, 'main').get(a))
  view.open(allAnswer.commits[1], [])
  assert.deepEqual(navigations, [
    { repoId: 7, repo: 'org/repo', path: '', commit: a, bundleTab: 'code', revision: { kind: 'branch', name: 'main' } },
    { repoId: 7, repo: 'org/repo', path: '', commit: b, bundleTab: 'code' },
  ])
  // A commit older than those listed offers its own history.
  const older = shownAt(x)
  assert.match(templateText(older.render()), /fffffff<\/code> isn’t among these commits\.[^]*Show its history/u)
  assert.equal(requests.length, 1, 'what was read is kept')
})

test('this revision\'s history reads a page at a time, from the commit shown; every branch, where it needs a sign-in, falls back to it', async () => {
  answer = (repoId, ref, path, { page, all }) => all
    ? Promise.reject(Object.assign(new Error('Reading every branch needs your GitHub sign-in.'), { code: 'github-token-required' }))
    : Promise.resolve({ commit: a, path, page, commits: page === 1 ? [commit(a, [b], 20)] : [commit(b, [], 10)], more: page === 1, ...page === 1 ? { branches: [], tags: [] } : {} })
  const view = shownAt(a)
  view.render()
  await setImmediate()
  let text = templateText(view.render())
  await setImmediate()
  text = templateText(view.render())
  assert.deepEqual(requests.map(request => [request[1], request[3]]), [['', { page: 1, all: true }], [a, { page: 1, all: false }]])
  assert.match(text, /aria-pressed=true [^\n]*>This revision</u)
  assert.match(text, /Every branch needs your GitHub sign-in/u)
  assert.match(text, /1\+ commit</u)
  // Held long, it reads its next page all the same, not its first again, on
  // from where those listed stop.
  const held = view.history('revision')
  held.entry.until = 0
  held.more()
  view.render()
  await setImmediate()
  text = templateText(view.render())
  assert.deepEqual(requests.slice(2), [[7, a, '', { page: 2, all: false, from: [b] }]])
  assert.match(text, /2 commits</u)
  assert.doesNotMatch(text, /Older commits/u, 'the last page read')
})

test('this revision\'s history comes from every branch\'s where that holds its commit: those it reaches, going on where a parent is missing', () => {
  const all = { status: 'ready', until: 1, commits: [commit(a, [b, c], 40), commit(c, [d], 30), commit(b, [d], 20), commit(d, [x], 10)],
    branches: [{ name: 'main', sha: a }], tags: [], defaultBranch: 'main', more: true }
  const fromB = revisionFromAll(all, b)
  assert.deepEqual(fromB.commits.map(item => item.sha[0]), ['b', 'd'])
  assert.equal(fromB.more, true, 'd\'s parent is not among them')
  assert.deepEqual([fromB.page, fromB.next], [1, [x]], 'older commits read on from where those it holds stop')
  assert.deepEqual(revisionFromAll({ ...all, commits: [commit(a, [b], 20), commit(b, [], 10)] }, a).more, false, 'a root reached is all of it')
  assert.equal(revisionFromAll(all, e), null, 'a commit every branch\'s doesn\'t hold')
})

test('switching from every branch to this revision reads nothing again where every branch\'s holds it; back again reads every branch', async () => {
  answer = (repoId, ref, path, { all, page }) => all ? Promise.resolve({ ...allAnswer, commits: [commit(a, [b], 20, 'Merge work'), commit(b, [x], 10, 'First')] })
    : Promise.resolve({ commit: b, path, page, commits: [commit(x, [], 5, 'Older')], more: false })
  const view = shownAt(b)
  view.render()
  await setImmediate()
  view.pick('revision')
  let text = templateText(view.render())
  assert.deepEqual(requests.map(request => request[3]), [{ page: 1, all: true }], 'no request for this revision')
  assert.match(text, /aria-pressed=true [^\n]*>This revision</u)
  assert.match(text, /1\+ commit</u, 'b alone, its parent beyond those every branch read')
  view.history('revision').more()
  await setImmediate()
  text = templateText(view.render())
  assert.deepEqual(requests.at(-1), [7, b, '', { page: 2, all: false, from: [x] }], 'older commits read on from where every branch\'s stop')
  assert.match(text, /2 commits</u)
  // From this revision, every branch's is read: this one's says nothing of
  // the others.
  state.managedSession = { id: `s-${++session}`, role: 'admin' }
  const fromRevision = shownAt(b)
  fromRevision.render()
  await setImmediate()
  assert.deepEqual(requests.at(-1), [7, b, '', { page: 1, all: false }])
  fromRevision.pick('all')
  fromRevision.render()
  assert.deepEqual(requests.at(-1), [7, '', '', { page: 1, all: true }])
})

test('every branch\'s older commits read on from where those listed stop and from the branches not read, the newest first, naming those reached', async () => {
  // b's parent c isn't listed; old, a branch not read, is older than b.
  answer = (repoId, ref, path, { page, from }) => Promise.resolve(page === 1
    ? { all: true, commits: [commit(a, [b], 50), commit(b, [c], 40)], branches: [{ name: 'main', sha: a }], tags: [], defaultBranch: 'main',
      unread: [{ name: 'old', sha: e, at: 10 }, { name: 'bad', sha: 'e', at: 60 }], more: true }
    : { all: true, page, commits: from.includes(c) ? [commit(c, [d], 30), commit(d, [x], 20), commit(e, [d], 10)] : [], more: true })
  const view = shownAt(a)
  view.pick('all')
  view.render()
  await setImmediate()
  let text = templateText(view.render())
  assert.match(text, /2\+ commits on 1 branch</u)
  view.history('all').more()
  await setImmediate()
  text = templateText(view.render())
  assert.deepEqual(requests.slice(1), [[7, '', '', { page: 2, all: true, from: [c, e] }]])
  assert.match(text, /5\+ commits on 2 branches</u, 'old, its tip read, among them')
  assert.match(text, /<span>old<\/span>/u)
  // On from d's parent, x, which reads nothing: nothing is left to read.
  view.history('all').more()
  await setImmediate()
  text = templateText(view.render())
  assert.deepEqual(requests.at(-1), [7, '', '', { page: 3, all: true, from: [x] }])
  assert.match(text, /5 commits on 2 branches</u)
  assert.doesNotMatch(text, /Older commits/u)
  assert.doesNotMatch(text, /first 1,000 branches/u)
})

test('every branch\'s history, where branches past those GitHub listed are left out, says so, however far it reads', async () => {
  answer = () => Promise.resolve({ ...allAnswer, cut: true, more: true })
  const view = shownAt(a)
  view.pick('all')
  view.render()
  await setImmediate()
  const text = templateText(view.render())
  assert.match(text, /2\+ commits on 1 branch</u, 'nothing left to read, but some never read')
  assert.match(text, /Only the first 1,000 branches by name are read\./u)
  assert.doesNotMatch(text, /Older commits/u)
})

test('older commits read as their button nears the end of the scroll, again after each page while it stays near, but not after one failed', () => {
  const view = new History()
  let alert = null, clicks = 0
  const button = { isConnected: true, disabled: false, parentElement: { querySelector: () => alert }, click() { clicks++ } }
  let shown = button
  view.querySelector = () => shown
  // Each update watches it again, and reads where it is then.
  const updated = near => { watching.delete(button); view.updated(); watching.get(button)(near) }
  updated(false)
  assert.equal(clicks, 0, 'not near yet')
  updated(true)
  assert.equal(clicks, 1)
  // Reading, it waits; read, and still near, it reads the next; moved
  // away by the lines read, it doesn't.
  button.disabled = true
  updated(true)
  assert.equal(clicks, 1)
  button.disabled = false
  updated(true)
  assert.equal(clicks, 2)
  updated(false)
  assert.equal(clicks, 2)
  // A page that failed waits for a click.
  alert = {}
  updated(true)
  assert.equal(clicks, 2)
  // Nothing left to read, its button gone, it watches nothing.
  shown = null
  view.updated()
  assert.equal(watching.has(button), false)
})

test('a directory\'s history lists the commits touching it, in a line, and says why where it can\'t', async () => {
  answer = (repoId, ref, path) => path === 'src'
    ? Promise.resolve({ commit: a, path, page: 1, commits: [commit(a, [b], 20), commit(c, [d], 10)], more: false, branches: [], tags: [] })
    : Promise.reject(Object.assign(new Error('This directory’s history is not available to you.'), { code: 'no-directory' }))
  const view = shownAt(a, 'src')
  view.render()
  await setImmediate()
  const text = templateText(view.render())
  assert.deepEqual(requests, [[7, a, 'src', { page: 1, all: false }]])
  assert.match(text, /Commits touching <code>src<\/code>/u)
  assert.doesNotMatch(text, /All branches/u)
  assert.deepEqual(view.layout('path', view.history('path').entry, null).segments, [{ row: 0, from: 0, to: 0, color: 0 }])
  const denied = shownAt(a, 'lib')
  denied.render()
  await setImmediate()
  assert.match(templateText(denied.render()), /role="alert">This directory’s history is not available to you\.[^]*Retry/u)
})
