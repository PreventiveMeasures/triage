import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import { templateText } from './_lit.js'

const state = {}
const requests = []
let answer = null
const dependencyRequests = []
const dependencyOptions = []
let dependencies = () => new Promise(() => {})
mock.module('../client/index.js', { exports: { state } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchRepositoryIssues(repoId, kind, options) { requests.push([repoId, kind, options]); return answer(repoId, kind, options) },
  fetchRepositoryHistory: () => new Promise(() => {}),
  fetchPullDependencies(repoId, number, options) { dependencyRequests.push([repoId, number]); dependencyOptions.push(options); return dependencies(repoId, number) },
} })
mock.module('../ui/view/repository-code.js', { exports: { navigateToRepositoryCode() {}, shownRevision: () => ({}) } })
const opened = []
mock.module('../ui/view/lazy-dialogs.js', { exports: { openRepositoryItemDialog(props) { opened.push(props) } } })
const watching = new Map()
mock.module('../ui/view/lazy-render.js', { exports: {
  watchNearViewport(target, cb) { watching.set(target, cb) },
  unwatchNearViewport(target) { watching.delete(target) },
} })
const { commentCount, filterIssues, issueState } = await import('../ui/view/repository-issues.js')
const { knowGithubUsers } = await import('../ui/view/github-users.js')
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
    { name: 'perf', color: null }], moreLabels: 2 }), issue(9, { title: '', comments: 1234 }), { number: 'x' }], counts: { open: 1234, closed: 40 }, more: false })
  const view = shown()
  assert.match(templateText(view.render()), /Reading the issues…/u)
  await setImmediate()
  const text = templateText(view.render())
  assert.deepEqual(requests, [[7, 'issues', { state: 'open', after: null }]])
  assert.match(text, /aria-pressed=true [^\n]*>Open<span class="n">1,234<\/span>/u)
  assert.match(text, /Closed<span class="n">40<\/span>/u)
  assert.match(text, /href=https:\/\/github\.com\/org\/repo\/issues\/12 target="_blank" rel="noopener noreferrer"/u)
  assert.match(text, /aria-label=Open[^]*Issue 12[^]*#12[^]*octo[^]*3h<\/time>/u)
  assert.match(text, /data-tooltip=bug>bug<\/span><span class="issue-labels-rest" style=[^>]*>[^]*>ui<[^]*>docs<[^]*>perf<\/span>(?:<\/span>){3}<span class="issue-label is-more">\+2</u,
    'every label GitHub sent, those after one in a run that gives way first, then how many it didn\'t send')
  assert.equal(text.split('class="issue-labels"').length - 1, 1, 'a line of labels only where there are any')
  assert.doesNotMatch(text, /issue-marks/u, 'an issue has no review or checks to hold room for')
  assert.match(text, /class="issue-comments" role="img" aria-label=4 comments data-tooltip=4 comments><svg[^]*<\/svg><span>4<\/span>/u)
  assert.match(text, /aria-label=1,234 comments [^]*<span>1\.2K<\/span>/u, 'a count of thousands as compact as its rail')
  assert.match(text, /\(no title\)/u)
  assert.equal(text.split('<li ').length - 1, 2, 'one GitHub names no number for left out')
  // Closed reads its own list, the counts read kept while it does.
  view.pick('closed')
  const reading = templateText(view.render())
  assert.deepEqual(requests.at(-1), [7, 'issues', { state: 'closed', after: null }])
  assert.match(reading, /Reading the issues…/u)
  assert.match(reading, /Open<span class="n">1,234<\/span>[^]*aria-pressed=true [^\n]*>Closed<span class="n">40<\/span>/u)
  view.pick('open')
})

test('a tile clicked opens its popup, what the tile knew shown as it reads the rest; held with a key, or another button, it opens on GitHub', () => {
  const view = shown('pulls')
  const click = more => ({ button: 0, prevented: false, preventDefault() { this.prevented = true }, ...more })
  const item = pull(5)
  opened.length = 0
  const plain = click()
  view.openTile(plain, item)
  assert.equal(plain.prevented, true)
  assert.deepEqual(opened, [{ repository: view.repository, target: { number: 5, preview: { ...item, kind: 'pulls' } } }])
  // Its popup by the name the tab was handed, where it was opened by none.
  const unnamed = Object.assign(shown('pulls', null), { repo: 'org/named' })
  unnamed.openTile(click(), item)
  assert.equal(opened.pop().repository.repo, 'org/named')
  for (const held of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    const event = click(held)
    view.openTile(event, item)
    assert.equal(event.prevented, false, JSON.stringify(held))
  }
  assert.equal(opened.length, 1)
})

test('a tile\'s labels, as many as the narrowest has room for as dots: eight, else seven and how many more', async () => {
  const named = count => Array.from({ length: count }, (_, at) => ({ name: `l${at}`, color: null }))
  answer = () => Promise.resolve({ items: [issue(3, { labels: named(8) }), issue(2, { labels: named(9) }), issue(1, { labels: named(6), moreLabels: 4 })],
    counts: { open: 3, closed: 0 }, more: false })
  const view = shown()
  view.render()
  await setImmediate()
  const tiles = templateText(view.render()).split('<li ').slice(1)
  assert.deepEqual(tiles.map(tile => [(tile.match(/class="issue-label" /gu) ?? []).length, /is-more">\+(\d+)</u.exec(tile)?.[1] ?? null]), [[8, null], [7, '2'], [6, '4']])
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
  assert.match(text, /issue-review is-changes role="img" aria-label=Changes requested [^]*issue-checks is-failure role="img" aria-label=Checks failed /u, 'the review, then the checks, under the state')
  assert.doesNotMatch(text, /Approved/u, 'a merged one\'s review is done with')
  assert.match(text, /<span class="issue-marks"><span class=issue-checks is-success /u, 'its checks alone, where the two are held room for')
  assert.match(text, /aria-label=Checks passed /u)
  const unnamed = shown('pulls', null)
  assert.doesNotMatch(templateText(unnamed.render()), /href=/u)
  // Opened by none, its name is the one its repositories list it by, once they arrive.
  unnamed.repo = 'org/named'
  assert.match(templateText(unnamed.render()), /href=https:\/\/github\.com\/org\/named\/pull\/5/u)
})

test('an open pull request changing a lockfile, or that may, shows the package versions new to its lockfiles once read, two at a time; one changing none, or not open, asks none', async () => {
  dependencyRequests.length = 0
  const reads = []
  dependencies = (repoId, number) => new Promise(resolve => { reads.push([number, resolve]) })
  const added = names => names.map(name => ({ name, version: '1.0.0', source: 'registry' }))
  answer = () => Promise.resolve({ items: [pull(1, { touchesLockfile: true }), pull(2, { touchesLockfile: false }), pull(3), pull(4, { touchesLockfile: null }),
    pull(5, { touchesLockfile: true }), pull(6, { state: 'merged', touchesLockfile: true }), pull(7, { draft: true, touchesLockfile: true })], counts: { open: 6, closed: 1 }, more: false })
  const view = shown('pulls')
  view.render()
  await setImmediate()
  assert.doesNotMatch(templateText(view.render()), /issue-deps/u, 'nothing while they are read')
  assert.deepEqual(dependencyRequests, [[7, 1], [7, 4]], 'two at a time, in the order asked')
  reads.shift()[1]({ number: 1, cut: false, lockfiles: [
    { paths: ['package-lock.json'], added: [{ name: 'axios', version: '1.14.1', source: 'registry', was: ['1.14.0'] }, ...added(['plain-crypto-js', 'tool']),
      { name: 'zod', version: '4.0.0', source: 'registry' }], more: 0 },
    { paths: ['web/pnpm-lock.yaml'], added: [...added(['tool']), { name: 'zod', version: '4.0.0', source: 'registry', was: ['3.25.0', '3.0.0'] }], more: 2 },
    { paths: ['berry/yarn.lock'], error: 'lockfile-unreadable' },
  ] })
  await setImmediate()
  assert.deepEqual(dependencyRequests, [[7, 1], [7, 4], [7, 5]])
  reads.shift()[1]({ number: 4, cut: false, lockfiles: [] })
  reads.shift()[1]({ number: 5, cut: false, lockfiles: [{ paths: ['package-lock.json'], added: [], more: 0 }] })
  await setImmediate()
  assert.deepEqual(dependencyRequests, [[7, 1], [7, 4], [7, 5], [7, 7]], 'a draft is open; a merged one\'s tile asks none')
  reads.shift()[1]({ number: 7, cut: false, lockfiles: [{ paths: ['yarn.lock'], added: added(Array.from({ length: 22 }, (_, at) => `p${at}`)), more: 0 }] })
  await setImmediate()
  const tiles = templateText(view.render()).split('<li ').slice(1)
  assert.match(tiles[0], /<span class="issue-deps" data-tooltip=New in its lockfiles: plain-crypto-js@1\.0\.0 \(new\), tool@1\.0\.0 \(new\), axios@1\.14\.1 \(was 1\.14\.0\), zod@4\.0\.0 \(was 3\.25\.0, 3\.0\.0\) and more><svg[^]*<\/svg><span class="issue-deps-names">plain-crypto-js, tool, axios, zod<\/span>\s*<span class="issue-deps-count">2 new, 2 updated\+<\/span>/u,
    'each version once, across its directories, new packages first, then updates; one new to a directory but an update in another an update; "+" where more were left unsent')
  assert.deepEqual(tiles.map(tile => tile.includes('issue-deps')), [true, false, false, false, false, false, true], 'none where none is new')
  assert.match(tiles[6], /data-tooltip=New in its lockfiles: p0@1\.0\.0 \(new\), [^>]*, p19@1\.0\.0 \(new\) and 2 more>/u, 'as many named on hover as fit, the rest counted')
  assert.match(tiles[6], /<span class="issue-deps-count">22 new<\/span>/u)
  // Kept for the session: drawn again, none asked again.
  templateText(view.render())
  assert.equal(dependencyRequests.length, 4)
})

test('an open pull request\'s tile, where its repository reviews dependencies, shows whether they pass: how many want reviews, a check, or that its review fails, and why on hover', async () => {
  dependencyOptions.length = 0
  const terms = { required: 2, since: null, canReview: true }
  const dir = (more = {}) => ({ paths: ['package-lock.json'], added: [], more: 0, unreviewed: [], moreUnreviewed: 0, unsupported: [], moreUnsupported: 0, moreLocked: 0, ...more })
  const mine = { name: 'mine', version: '1.0.0', source: 'git', from: 'git+ssh://github.com/org/mine.git', unsupported: 'git' }
  const replies = {
    1: [dir({ added: [{ name: 'ms', version: '2.1.3', source: 'registry', was: ['2.1.2'], reviews: 2 }, { name: 'tool', version: '1.0.0', source: 'registry', reviews: 1 },
      { name: 'left-pad', version: '1.3.0', source: 'registry', baseline: true }], unreviewed: [{ name: 'other', version: '1.0.0', source: 'registry', reviews: 0 }], moreUnreviewed: 3 })],
    2: [dir({ added: [{ name: 'ms', version: '2.1.3', source: 'registry', reviews: 2 }, { name: 'local', version: '1.0.0', source: 'file' }] })],
    3: [dir({ added: [mine], unsupported: [mine, { name: 'mirrored', version: '1.0.0', source: 'mirror', unsupported: 'tarball' }], moreUnsupported: 1 })],
    4: [{ paths: ['berry/yarn.lock'], error: 'lockfile-unreadable' }],
    5: [dir({ added: [{ name: 'ms', version: '2.1.3', source: 'registry', reviews: 2 }], unreviewed: [{ name: 'other', version: '1.0.0', source: 'registry', reviews: 0 }], moreUnreviewed: 200 }),
      dir({ paths: ['web/package-lock.json'], added: [{ name: 'ms', version: '2.1.3', source: 'registry', reviews: 0 }],
        unreviewed: [{ name: 'other', version: '1.0.0', source: 'registry', reviews: 0 }], moreUnreviewed: 200 })],
  }
  // Two workspaces locking the same versions, which the server counts once.
  const counts = { 5: { unreviewed: 201 } }
  dependencies = (repoId, number) => Promise.resolve({ number, cut: false, review: { ...terms, ...counts[number] }, lockfiles: replies[number] })
  answer = () => Promise.resolve({ items: [1, 2, 3, 4, 5].map(number => pull(number, { touchesLockfile: true })), counts: { open: 5, closed: 0 }, more: false })
  const view = shown('pulls')
  view.render()
  await setImmediate()
  templateText(view.render())
  await setImmediate()
  templateText(view.render())
  await setImmediate()
  templateText(view.render())
  await setImmediate()
  assert.ok(dependencyOptions.every(options => options.review === true), 'an open one\'s asked with their review')
  const tiles = templateText(view.render()).split('<li ').slice(1)
  assert.match(tiles[0], /data-tooltip=New in its lockfiles: tool@1\.0\.0 \(new, 1\/2 reviews\), left-pad@1\.3\.0 \(new, needs no review\), ms@2\.1\.3 \(was 2\.1\.2, 2\/2 reviews\)\. 4 other versions in its lockfiles unreviewed>/u)
  assert.match(tiles[0], /<span class="issue-deps-review is-wanted">1 to review · 4 unreviewed<\/span>/u, 'its own wanting reviews, then the others its lockfiles lock')
  assert.match(tiles[1], /<span class="issue-deps-review is-passed" role="img" aria-label="Every version reviewed"><svg/u, 'a file of the project\'s not reviewed')
  assert.match(tiles[2], /<span class="issue-deps-review is-failed">3 can’t be reviewed<\/span>/u)
  assert.match(tiles[2], /Its review fails: mine@1\.0\.0 \(from git\), mirrored@1\.0\.0 \(a tarball not npm’s registry’s\) and 1 more can’t be reviewed>/u)
  assert.match(tiles[3], /data-tooltip=Its review fails: not every lockfile it changes was read>[^]*<span class="issue-deps-review is-failed">lockfiles unread<\/span>/u,
    'shown with no version new, its lockfiles unread')
  assert.match(tiles[4], /is-wanted">1 to review · 201 unreviewed</u, 'a version two directories lock as passing as the less passing of them; the others counted once, as the server tells')
})

test('a count of comments as narrow as the rail: whole below a thousand, else two digits at most and their unit', () => {
  assert.deepEqual([1, 999, 1000, 1234, 12_345, 1_234_567].map(commentCount), ['1', '999', '1K', '1.2K', '12K', '1.2M'])
})

test('the filter picks among those read by every word, in a number, title, author, label or branch', async () => {
  const items = [pull(12, { title: 'Treemap labels overlap', labels: [{ name: 'ui', color: null }] }), pull(9, { title: 'Search speed', author: 'grace', head: 'perf/search' })]
  assert.deepEqual(filterIssues(items, '').map(item => item.number), [12, 9])
  assert.deepEqual(filterIssues(items, '#12').map(item => item.number), [12])
  assert.deepEqual(filterIssues(items, 'UI treemap').map(item => item.number), [12])
  assert.deepEqual(filterIssues(items, 'grace perf/').map(item => item.number), [9])
  assert.deepEqual(filterIssues(items, 'treemap grace'), [])
  knowGithubUsers({ users: { grace: { id: 'grace-id', login: 'grace-h', name: 'Grace Hopper' } } })
  assert.deepEqual(filterIssues(items, 'hopper').map(item => item.number), [9], 'by the name its author\'s user chose')
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
