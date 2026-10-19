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
const { compactTime, historyRefs, plantedCommits, unmergedCommits } = await import('../ui/view/repository-history.js')
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
  assert.equal(managedRoutePath(route), `/repo/7/${a}/commits?path=src`)
  assert.deepEqual(parseManagedRoute(new URL(managedRoutePath(route), 'https://triage.test')), route)
  assert.deepEqual(parseManagedRoute(new URL(`https://triage.test/repo/7/${a}/history?path=src`)), route)
  assert.equal(managedRoutePath({ ...route, bundleTab: 'history' }), null, 'no route names History')
  assert.equal(parseManagedRoute(new URL(`https://triage.test/repo/7/${a}/commits/2`)), null, 'only Code names a file')
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

test('a squash merge is drawn as the merge it was, its pull request\'s own commits on a lane of their own, those a reused branch shares once', () => {
  const [squash, squash2, p1, p2, p3, base] = ['1', '2', '3', '4', '5', '6'].map(char => char.repeat(40))
  // main: #4 squashed, then #2; #4's branch was #2's, reused, its commits on from #2's.
  const commits = [commit(squash2, [squash], 50, 'Again (#4)'), commit(squash, [base], 40, 'Feature (#2)'), commit(base, [], 10, 'Base')]
  const pulls = [{ merge: squash, number: 2, head: p2, commits: [commit(p1, [base], 20), commit(p2, [p1], 30)] },
    { merge: squash2, number: 4, head: p3, commits: [commit(p1, [base], 20), commit(p2, [p1], 30), commit(p3, [p2], 45)] }]
  const planted = plantedCommits(commits, pulls)
  assert.deepEqual(planted.map(item => [item.sha[0], item.parents.map(parent => parent[0]), item.pull ?? null]),
    [['2', ['1', '5'], null], ['1', ['6', '4'], null], ['6', [], null], ['3', ['6'], 2], ['4', ['3'], 2], ['5', ['4'], 4]])
  const layout = historyLayout(historyOrder(planted), { trunk: firstParentLine(planted, squash2) })
  assert.deepEqual(layout.rows.map(row => [row.commit.sha[0], row.col]), [['2', 0], ['5', 1], ['1', 0], ['4', 1], ['3', 1], ['6', 0]], 'the pull requests\' lane beside the default branch\'s')
  assert.equal(layout.width, 2)
  assert.equal(plantedCommits(commits, []), commits, 'none squashed, as listed')
})

test('the branches not merged are those the default branch doesn\'t reach, a squash merge reaching its pull request\'s, each down to where it began', () => {
  const [main, squash, base, feature, head, after] = ['1', '2', '3', '4', '5', '6'].map(char => char.repeat(40))
  // main squashed #2, whose branch went on after; feature never merged.
  const commits = [commit(main, [squash], 60), commit(after, [head], 55), commit(feature, [base], 50), commit(squash, [base], 40), commit(head, [base], 30),
    commit(base, [], 10)]
  const pulls = [{ merge: squash, number: 2, head, commits: [commit(head, [base], 30)] }]
  assert.deepEqual(unmergedCommits(commits, pulls, main).map(item => item.sha[0]), ['6', '4'])
  assert.deepEqual(unmergedCommits(commits, [], main).map(item => item.sha[0]), ['6', '4', '5'], 'a squash not known of, its branch not merged')
  assert.deepEqual(unmergedCommits(commits, pulls, undefined).length, 6, 'no default branch read, none merged')
  // The default branch read only so far: a branch older than the oldest of
  // its line read may be merged further down, not told yet; one newer is told.
  const [tip, older, stale, fresh] = ['7', '8', '9', 'a'].map(char => char.repeat(40))
  const partial = [commit(tip, [older], 100), commit(fresh, [x], 95), commit(older, [x], 90), commit(stale, [x], 50)]
  assert.deepEqual(unmergedCommits(partial, [], tip).map(item => item.sha[0]), ['a'])
})

test('Unmerged shows the branches every branch\'s holds not merged, read as every branch\'s, unread again; none, says so', async () => {
  const [main, feature] = ['1', '2'].map(char => char.repeat(40))
  answer = () => Promise.resolve({ all: true, commits: [commit(main, [b], 30, 'Main work'), commit(feature, [b], 20, 'Feature work'), commit(b, [], 10, 'First')],
    branches: [{ name: 'main', sha: main }, { name: 'feature', sha: feature }], tags: [], defaultBranch: 'main', more: false })
  const view = shownAt(main)
  view.render()
  await setImmediate()
  assert.match(templateText(view.render()), /aria-pressed=true [^\n]*>All branches<\/button>\s*<button [^\n]*>Unmerged<\/button>\s*<\/div>/u, 'every branch\'s or those not merged alone')
  view.pick('unmerged')
  const text = templateText(view.render())
  assert.match(text, /aria-pressed=true [^\n]*>Unmerged</u)
  assert.match(text, /1 commit on 1 branch</u)
  assert.match(text, /<span>feature<\/span>[^]*Feature work/u)
  assert.doesNotMatch(text, /Main work|isn’t among these commits/u)
  assert.equal(requests.length, 1, 'every branch\'s, read once')
  answer = () => Promise.resolve({ all: true, commits: [commit(main, [b], 30, 'Main work'), commit(b, [], 10, 'First')], branches: [{ name: 'main', sha: main }], tags: [],
    defaultBranch: 'main', more: false })
  state.managedSession = { id: `s-${++session}`, role: 'admin' }
  const merged = shownAt(main)
  merged.render()
  await setImmediate()
  assert.match(templateText(merged.render()), /Every branch read is merged\./u)
  merged.pick('all')
})

test('a pull request\'s head is named by its number, beside the branch still at it; an open one\'s too, each number once', () => {
  const named = historyRefs({ branches: [{ name: 'claude/feature', sha: a }], tags: [], pulls: [{ merge: c, number: 2, head: a, commits: [] }],
    openPulls: [{ number: 4, sha: b }, { number: 2, sha: b }] }, 'main')
  assert.deepEqual([named.get(a), named.get(b)], [[{ kind: 'branch', name: 'claude/feature', main: false }, { kind: 'pull', name: '#2', number: 2 }], [{ kind: 'pull', name: '#4', number: 4 }]])
})

test('the tab draws the pull requests squashed into the history it reads, their heads named by number', async () => {
  const [squash, p1] = ['1', '2'].map(char => char.repeat(40))
  answer = () => Promise.resolve({ all: true, commits: [commit(squash, [b], 30, 'Feature (#2)'), commit(b, [], 10, 'First')], branches: [{ name: 'main', sha: squash }],
    tags: [], defaultBranch: 'main', more: false, pulls: [{ merge: squash, number: 2, head: p1, commits: [commit(p1, [b], 20, 'Started the feature')] }, { merge: 'bad' }] })
  const view = shownAt(squash)
  view.render()
  await setImmediate()
  const text = templateText(view.render())
  assert.match(text, /2 commits on 1 branch</u, 'those of the branches read counted')
  // Its chip opens it on GitHub, in a new tab, as a line's id does its
  // commit, and so does the subject naming it.
  assert.match(text, new RegExp(`>Feature \\(<a href=https://github.com/org/repo/issues/2 target="_blank" rel="noopener noreferrer"\\s+tabindex="-1">#2</a>\\)</span>`
    + `\\s*<button type="button" class="history-commit" id=history-commit-${squash}`, 'u'))
  assert.match(text, new RegExp('>2222222</a>\\s*<span class="history-refs"[^]*<a class=[^>]* href=https://github.com/org/repo/pull/2 target="_blank" '
    + 'rel="noopener noreferrer" tabindex="-1"\\s+aria-label=Pull request #2 on GitHub>[^]*<span>#2</span></a>[^]*>Started the feature</span>', 'u'))
})

test('the pull requests squashed into a page that GitHub was still looking up are asked for again a little later, of the same page, and drawn once found', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const [squash, other, p1, p2] = ['1', '3', '2', '4'].map(char => char.repeat(40))
    const pulls = { 1: { merge: squash, number: 2, head: p1, commits: [commit(p1, [b], 20, 'Started the feature')] },
      2: { merge: other, number: 3, head: p2, commits: [commit(p2, [d], 3, 'Other work')] } }
    const pending = new Set([1, 2])
    answer = (repoId, ref, path, { page }) => Promise.resolve({ all: true, page, more: page === 1, branches: [{ name: 'main', sha: squash }], tags: [], defaultBranch: 'main',
      commits: page === 1 ? [commit(squash, [b], 30, 'Feature (#2)'), commit(b, [other], 10, 'First')] : [commit(other, [d], 5, 'Other (#3)'), commit(d, [], 1, 'Root')],
      ...pending.has(page) ? { pullsPending: true } : { pulls: [pulls[page]] } })
    const view = shownAt(squash)
    view.pick('all')
    view.render()
    await setImmediate()
    assert.doesNotMatch(templateText(view.render()), /Started the feature/u)
    pending.delete(1)
    mock.timers.tick(3000)
    await setImmediate()
    assert.deepEqual(requests.map(request => request[3]), [{ page: 1, all: true }, { page: 1, all: true }])
    assert.match(templateText(view.render()), /Started the feature/u, 'drawn once found')
    // An older page's, on from where it read on from.
    view.history('all').more()
    await setImmediate()
    pending.delete(2)
    mock.timers.tick(3000)
    await setImmediate()
    assert.deepEqual(requests.slice(2).map(request => request[3]), [{ page: 2, all: true, from: [other] }, { page: 2, all: true, from: [other] }])
    const text = templateText(view.render())
    assert.match(text, /Started the feature/u)
    assert.match(text, /Other work/u)
    mock.timers.tick(30_000)
    await setImmediate()
    assert.equal(requests.length, 4, 'none asked for again once found')
  } finally { mock.timers.reset() }
})

const allAnswer = { all: true, commits: [commit(a, [b], 20, 'Merge work'), commit(b, [], 10, 'First')], branches: [{ name: 'main', sha: a }], tags: [{ name: 'v1', sha: b }],
  defaultBranch: 'main', more: false }
function shownAt(sha, path = '') {
  return Object.assign(new History(), { repository: { repoId: 7, repo: 'org/repo', commit: sha, path, revision: { kind: 'branch', name: null } },
    refs: { status: 'ready', value: { defaultBranch: 'main' } } })
}

test('the tab reads every branch at the root, marks the commit shown, and shows a commit clicked in its place by the branch naming it', async () => {
  answer = () => Promise.resolve(allAnswer)
  const view = shownAt(a)
  assert.match(templateText(view.render()), /Reading the history/u)
  await setImmediate()
  const text = templateText(view.render())
  assert.deepEqual(requests, [[7, '', '', { page: 1, all: true }]])
  assert.match(text, /aria-pressed=true [^\n]*>All branches</u)
  assert.match(text, /2 commits on 1 branch</u)
  // Its short id opens it on GitHub, in a new tab, out of the lines' keys'
  // way; the rest of it, its code, its button named by its subject.
  assert.match(text, new RegExp(`<a class="history-sha" href=https://github.com/org/repo/commit/${a} target="_blank" rel="noopener noreferrer" tabindex="-1"\\s+`
    + `aria-label=Commit aaaaaaa on GitHub>aaaaaaa</a>[^]*<span>main</span></span>[^]*<span class="history-subject" id=history-subject-${a}>Merge work</span>\\s*`
    + `<button type="button" class="history-commit" id=history-commit-${a} tabindex=0\\s+aria-labelledby=history-subject-${a} history-commit-${a} aria-current=true`, 'u'))
  // The default branch's chip, marked so, and in the shown revision's, as is
  // the tag's in none.
  const chips = templates(view.render()).filter(template => template.strings.join('') === '<span class=></span>')
  assert.deepEqual(chips.map(chip => chip.values[0].values[0]), [
    { 'history-ref': true, 'is-branch': true, 'is-default': true, 'is-shown': false },
    { 'history-ref': true, 'is-tag': true, 'is-default': false, 'is-shown': false },
  ])
  assert.doesNotMatch(text, /among these commits/u)
  view.open(allAnswer.commits[0], historyRefs(allAnswer, 'main').get(a))
  view.open(allAnswer.commits[1], [])
  assert.deepEqual(navigations, [
    { repoId: 7, repo: 'org/repo', path: '', commit: a, bundleTab: 'commits', revision: { kind: 'branch', name: 'main' } },
    { repoId: 7, repo: 'org/repo', path: '', commit: b, bundleTab: 'commits' },
  ], 'shown in its place, on Commits')
  // A commit those listed miss, as the server kept them, reads every
  // branch again, afresh, those listed shown meanwhile; still missing it, it
  // says so, read no more.
  const older = shownAt(x)
  let text2 = templateText(older.render())
  assert.doesNotMatch(text2, /isn’t among these commits/u, 'not while every branch is read again')
  assert.match(text2, /Merge work/u)
  assert.deepEqual(requests.at(-1), [7, '', '', { page: 1, all: true, fresh: true }])
  await setImmediate()
  text2 = templateText(older.render())
  assert.match(text2, /fffffff<\/code> isn’t among these commits\.<\/p>/u)
  older.render()
  assert.equal(requests.length, 2, 'once')
  // Opened by none, its name is the one its repositories list it by, once
  // they arrive: its ids are only text until then.
  const unnamed = Object.assign(shownAt(a), { repository: { ...shownAt(a).repository, repo: null } })
  assert.match(templateText(unnamed.render()), /<code class="history-sha">aaaaaaa<\/code>/u)
  unnamed.repo = 'org/named'
  assert.match(templateText(unnamed.render()), new RegExp(`<a class="history-sha" href=https://github.com/org/named/commit/${a} `, 'u'))
  assert.equal(requests.length, 2, 'what was read is kept')
})

test('every branch\'s history as the server kept it, missing the commit a branch has reached since, is read again afresh and shows it', async () => {
  const head = '9'.repeat(40)
  // The server's kept heads, from before main moved on to `head`.
  answer = (repoId, ref, path, options) => Promise.resolve(options.fresh
    ? { ...allAnswer, commits: [commit(head, [a], 40, 'Since'), ...allAnswer.commits], branches: [{ name: 'main', sha: head }] }
    : allAnswer)
  const view = shownAt(head)
  view.render()
  await setImmediate()
  assert.doesNotMatch(templateText(view.render()), /isn’t among these commits/u, 'those kept shown while read again')
  await setImmediate()
  assert.deepEqual(requests.map(request => request[3]), [{ page: 1, all: true }, { page: 1, all: true, fresh: true }])
  let text = templateText(view.render())
  assert.match(text, /id=history-subject-9{40}>Since<\/span>\s*<button [^>]*?aria-current=true/u, 'the commit shown, marked')
  assert.doesNotMatch(text, /isn’t among these commits/u)
  // A commit of a pull request squashed into those listed, planted among
  // them, is no commit they miss.
  const own = '8'.repeat(40)
  state.managedSession = { id: 'planted', role: 'admin' }
  answer = () => Promise.resolve({ ...allAnswer, pulls: [{ number: 5, merge: a, head: own, commits: [commit(own, [b], 15, 'Squashed work')] }] })
  const planted = shownAt(own)
  planted.render()
  await setImmediate()
  planted.render()
  await setImmediate()
  assert.equal(requests.filter(request => request[3].fresh).length, 1, 'not read again for it')
  assert.match(templateText(planted.render()), /Squashed work/u)
  // Read again where the server read them just before, answered as kept:
  // asked once more when it may read them again.
  state.managedSession = { id: 'soon', role: 'admin' }
  const later = '7'.repeat(40)
  let freshReads = 0
  answer = (repoId, ref, path, options) => {
    if (!options.fresh) return Promise.resolve(allAnswer)
    freshReads++
    return Promise.resolve(freshReads === 1 ? { ...allAnswer, retryIn: 5 }
      : { ...allAnswer, commits: [commit(later, [a], 50, 'Later'), ...allAnswer.commits], branches: [{ name: 'main', sha: later }] })
  }
  const soon = shownAt(later)
  soon.render()
  await setImmediate()
  soon.render()
  await setImmediate()
  assert.equal(freshReads, 1)
  assert.doesNotMatch(templateText(soon.render()), /isn’t among these commits/u, 'not while it waits to ask again')
  await new Promise(resolve => { setTimeout(resolve, 10) })
  soon.render()
  await setImmediate()
  assert.equal(freshReads, 2)
  assert.match(templateText(soon.render()), /id=history-subject-7{40}>Later</u)
  // Read again for the commit shown, not for good: another commit a branch
  // reaches since, those held missing it, reads them again, afresh, once.
  const newest = '6'.repeat(40)
  answer = (repoId, ref, path, options) => {
    if (!options.fresh) return Promise.resolve(allAnswer)
    freshReads++
    return Promise.resolve({ ...allAnswer, commits: [commit(newest, [later], 60, 'Newest'), commit(later, [a], 50, 'Later'), ...allAnswer.commits],
      branches: [{ name: 'main', sha: newest }] })
  }
  const next = shownAt(newest)
  assert.doesNotMatch(templateText(next.render()), /isn’t among these commits/u, 'not while every branch is read again')
  await setImmediate()
  assert.equal(freshReads, 3)
  assert.match(templateText(next.render()), /id=history-subject-6{40}>Newest<\/span>\s*<button [^>]*?aria-current=true/u)
  shownAt(later).render()
  next.render()
  await setImmediate()
  assert.equal(freshReads, 3, 'listed, not read again')
  // A read again that fails keeps those listed, and says what they miss.
  answer = (repoId, ref, path, options) => options.fresh ? Promise.reject(new Error('GitHub is down.')) : Promise.resolve(allAnswer)
  state.managedSession = { id: 'another', role: 'admin' }
  const again = shownAt(head)
  again.render()
  await setImmediate()
  again.render()
  await setImmediate()
  text = templateText(again.render())
  assert.match(text, /Merge work/u)
  assert.match(text, /9999999<\/code> isn’t among these commits/u)
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
  assert.doesNotMatch(text, /history-modes/u, 'nothing to pick: the revision\'s alone')
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
  assert.doesNotMatch(text, /first 5,000 branches/u)
})

test('every branch\'s history, where branches past those GitHub listed are left out, says so, however far it reads', async () => {
  answer = () => Promise.resolve({ ...allAnswer, cut: true, more: true })
  const view = shownAt(a)
  view.pick('all')
  view.render()
  await setImmediate()
  const text = templateText(view.render())
  assert.match(text, /2\+ commits on 1 branch</u, 'nothing left to read, but some never read')
  assert.match(text, /Only the first 5,000 branches by name are read\./u)
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
  // Unmerged's, whose pages may add no line, waits for a click.
  alert = null
  view._mode = 'unmerged'
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

test('keys move up and down between lines\' buttons, and along a line through its links on GitHub to its button, the one reached the list\'s stop for Tab', () => {
  let focused = null
  const key = name => ({ name, tabIndex: -1, focus() { focused = name } })
  const lines = [['sha 1', 'pull 1', 'open 1'], ['sha 2', 'open 2'], ['sha 3', 'subject 3', 'open 3']].map(names => {
    const items = names.map(key)
    const line = { items, querySelectorAll: () => items, querySelector: () => items.at(-1) }
    for (const item of items) item.closest = () => line
    return line
  })
  const view = Object.assign(new History(), { querySelectorAll: selector => selector === '.history-row' ? lines : lines.flatMap(line => line.items) })
  const press = (from, name) => {
    let prevented = false
    view.keydown({ key: name, target: lines.flatMap(line => line.items).find(item => item.name === from), preventDefault() { prevented = true } })
    return prevented ? focused : null
  }
  assert.equal(press('open 1', 'ArrowDown'), 'open 2')
  assert.equal(press('open 2', 'ArrowLeft'), 'sha 2')
  assert.equal(press('sha 2', 'ArrowLeft'), null, 'none before a line\'s first')
  assert.equal(press('sha 2', 'ArrowDown'), 'open 3', 'a line\'s button, from any of its keys')
  assert.equal(press('open 3', 'ArrowLeft'), 'subject 3')
  assert.equal(press('subject 3', 'ArrowRight'), 'open 3')
  assert.equal(press('open 3', 'ArrowRight'), null, 'none after its button')
  assert.equal(press('open 3', 'Home'), 'open 1')
  assert.equal(press('pull 1', 'End'), 'open 3')
  assert.equal(press('open 3', 'ArrowDown'), null, 'none past the last line')
  assert.deepEqual(lines.flatMap(line => line.items).filter(item => item.tabIndex === 0).map(item => item.name), ['open 3'])
})
