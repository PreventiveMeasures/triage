// A team's Dependencies tab (ui/view/team-dependencies.js): of each of its
// repositories whose review is in effect for its reader, the open pull
// requests whose versions want reviews, fewest first, each version told
// under the first adding it alone, with its review; every version apart, each
// once; and what each default branch locks that wants reviews; each sub-tab
// at its address; a pull request named without its owner where every
// repository reviewed has the same one.
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { mock, test } from 'node:test'
import './_polyfills.js'
import { templateText } from './_lit.js'

const state = { managedSession: { id: 's', role: 'triage' }, managedTeams: [{ id: 'team-1', slug: 'deps' }], teamDependenciesTab: 'pulls' }
// The team reads asked, by the repositories each names (none: all), and the
// pull requests or deltas asked alone.
const asked = { teams: [], dependencies: [], deltas: [] }
const terms = { required: 2, since: null, canReview: true }
const dir = (more = {}) => ({ paths: ['package-lock.json'], added: [], more: 0, unreviewed: [], moreUnreviewed: 0, unsupported: [], moreUnsupported: 0, moreLocked: 0, ...more })
const wants = (name, more = {}) => ({ name, version: '1.0.0', source: 'registry', reviews: 0, ...more })
const gitdep = { name: 'gitdep', version: '1.0.0', source: 'git', from: 'git+ssh://github.com/org/gitdep.git', unsupported: 'git' }
// The first reviewed in its own pull request's comments alone.
const big = Array.from({ length: 13 }, (_, at) => wants(`big-${at}`, at === 0 ? { reviews: 1, commented: 1 } : {}))
const branches = {
  7: { cut: false, review: { ...terms, unreviewed: 2 }, lockfiles: [dir({ unreviewed: [wants('old'), wants('pat', { patched: true })] })] },
  8: { cut: false, review: { ...terms, unreviewed: 0 }, lockfiles: [dir(), { paths: ['web/bun.lock'], error: 'lockfile-unsupported' }] },
  9: { cut: false, review: null, lockfiles: [dir()] },
}
const pull = (number, more = {}) => ({ number, title: `Pull ${number}`, author: 'octo', state: 'open', touchesLockfile: true, ...more })
// Repository 8's more than are read.
const pulls = { 7: { items: [pull(1), pull(3), pull(4, { touchesLockfile: false }), pull(9), pull(10), pull(11)], more: false },
  8: { items: [pull(2), pull(6), pull(7, { touchesLockfile: false })], more: true } }
const dependencies = {
  // Its shared one reviewed in its comments, which count for it alone.
  '7#1': { cut: false, review: terms, lockfiles: [dir({ added: [wants('shared', { reviews: 1, commented: 1 }), ...big, gitdep, wants('fine', { reviews: 2 })], unsupported: [gitdep] })] },
  '7#3': { cut: false, review: terms, lockfiles: [dir({ added: [wants('fine', { reviews: 2 }), wants('known', { baseline: true })] })] },
  // Its own passed, but held by those its lockfiles locked before it.
  '7#9': { cut: false, review: { ...terms, unreviewed: 4 }, lockfiles: [dir({ added: [wants('fine', { reviews: 2 })], unreviewed: [wants('old', { reviews: 1, commented: 1 }),
    wants('pat', { patched: true, reviews: 1, commented: 1 })], moreUnreviewed: 2 })] },
  // The reader's reviews of its versions formatted by the server's host, to copy.
  // Every version reviewed, one with the reader's reviews to copy, one without.
  '7#10': { cut: false, review: terms, formatted: 'Reviewed done', lockfiles: [dir({ added: [wants('done', { reviews: 2 })] })] },
  '7#11': { cut: false, review: terms, lockfiles: [dir({ added: [wants('done', { reviews: 2 })] })] },
  '8#2': { cut: false, review: terms, formatted: 'Reviewed rej', lockfiles: [dir({ added: [wants('shared'), wants('rej', { reviews: 2, rejected: true }), wants('vouched', { reviewed: true })] })] },
  // Its versions past those told wanting reviews, those told passed.
  '8#6': { cut: false, review: { ...terms, toReview: 3 }, lockfiles: [dir({ added: [wants('fine', { reviews: 2 })], more: 250 })] },
}
// A team's lines, as the server tells them (fetchTeamDependencies), of those
// `repoIds` names, else all: the lines `old` changes, counted already, with
// 7's default branch; its pull requests' dependencies two a line. Those
// `timeUp` names left for the read's time, once, their default branch told.
const TEAM = [7, 8, 9, 10, 11, 12]
let timeUp = new Set()
function teamLines(repoIds) {
  const lines = [], unread = []
  for (const repoId of repoIds ?? TEAM) {
    // Repository 11 read only in part, 9 reviewing none.
    if (repoId === 11 || branches[repoId]?.review === null) lines.push({ repoId, branch: null })
    else if (!branches[repoId]) lines.push({ repoId, error: 'It isn’t there.', code: 'github-not-found' })
    else {
      lines.push({ repoId, branch: branches[repoId], pulls: pulls[repoId], ...repoId === 7 ? { deltas: [['old', '1.0.0', '(empty)', { additions: 3, deletions: 0, typeless: null }]] } : {} })
      if (timeUp.has(repoId)) { unread.push(repoId); continue }
      const numbers = pulls[repoId].items.filter(item => item.touchesLockfile !== false).map(item => item.number)
      for (let at = 0; at < numbers.length; at += 2) {
        lines.push({ repoId, dependencies: new Map(numbers.slice(at, at + 2).map(number => [number, { number, ...dependencies[`${repoId}#${number}`] }])) })
      }
    }
  }
  timeUp = new Set()
  return [...lines, unread.length > 0 ? { done: false, unread } : { done: true }]
}
mock.module('../client/index.js', { exports: { state } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchNpmDeltas(versions) { asked.deltas.push(versions); return new Promise(() => {}) },
  async fetchTeamDependencies(teamId, onLine, { repoIds }) {
    asked.teams.push([teamId, repoIds])
    for (const line of teamLines(repoIds)) {
      await setImmediate()
      onLine(line)
    }
  },
  fetchPullDependencies(repoId, number, options) { asked.dependencies.push([repoId, number, options]); return new Promise(() => {}) },
  fetchPullDependenciesOf(repoId, numbers, options) { asked.dependencies.push([repoId, numbers, options]); return new Promise(() => {}) },
} })
const opened = []
mock.module('../ui/view/lazy-dialogs.js', { exports: { openRepositoryItemDialog(props) { opened.push(props) } } })
mock.module('../ui/view/compare-load.js', { exports: { withCompare: template => template() } })
const routes = []
mock.module('../ui/view/managed-history.js', { exports: { managedHistory: {
  pushRoute(route) { routes.push(['push', route]) }, replaceRoute(route) { routes.push(['replace', route]) },
} } })
await import('../ui/view/team-dependencies.js')
const Dependencies = customElements.get('team-dependencies')
const { pullDependencies } = await import('../ui/view/pull-dependencies.js')
const { npmDelta } = await import('../ui/view/npm-delta.js')

const repo = (repoId, name) => ({ repoId, name, paths: [], reports: 0, bundles: 0, available: true })
const settle = async () => { for (let round = 0; round < 12; round++) await setImmediate() }
// As its page would, rendered again as what it reads arrives.
const read = async view => { for (let round = 0; round < 4; round++) { view.render(); await settle() } return templateText(view.render()) }
const shown = repositories => Object.assign(new Dependencies(), { repositories, team: 'team-1' })
// Its sub-tabs, as a dialog's header tabs, each with its count, and the one picked.
const tabs = text => [...text.split('class="dlg-tabs"')[1].split('</div>')[0].matchAll(/aria-selected=(true|false)[^]*?\n\s*>([^<]+)(?:<span class="team-deps-tab-n">([^<]+)<\/span>)?<\/button>/gu)]
  .map(m => [m[2], m[3] ?? null, m[1] === 'true'])
const cardsOf = text => text.slice(text.indexOf('team-deps-pulls'), text.indexOf('</ol>')).split(/<li class="?team-deps-pull(?=[ >"])/u).slice(1)
// Each card's width: a column's, unless it carries a span.
const widths = text => [...text.matchAll(/<li class="?team-deps-pull( is-[a-z\d-]+)?"?>/gu)].map(m => m[1]?.trim() ?? 'column')

test('the pull requests wanting reviews, fewest first, each version under the first adding it alone, its review shown; every version apart, once; the default branches\'; and the team\'s reviews, a sub-tab each', async () => {
  const view = shown([repo(7, 'org/a'), repo(8, 'org/b'), repo(9, 'other/c'), repo(7, 'org/a')])
  assert.match(templateText(view.render()), /role="status">Reading their pull requests…/u)
  const text = await read(view)
  assert.deepEqual(tabs(text), [['Pull requests', '4', true], ['Versions', '16', false], ['Default branch', '2', false], ['Reviews', null, false]])
  assert.match(text, /role="tabpanel" id=team-deps-panel-pulls aria-labelledby=team-deps-tab-pulls>/u, 'the one open under them')
  assert.deepEqual(asked.teams, [['team-1', null]], 'its repositories, all of them, in one request')
  assert.deepEqual(asked.dependencies, [], 'no pull request asked alone')
  assert.equal(pullDependencies(7, 1, true).status, 'ready', 'their dependencies held as a tile or a popup asks for them')
  assert.deepEqual(asked.dependencies, [], 'none asked again')
  assert.equal(npmDelta('old', '1.0.0', '(empty)').additions, 3, 'the lines a version changes, counted already, held as its row asks for them')
  assert.match(text, /role="alert">Only b’s 3 open pull requests\s+updated latest are checked; its others aren’t\./u)
  assert.doesNotMatch(text, /Reading their pull requests/u)
  const cards = cardsOf(text)
  assert.equal(cards.length, 4, 'one adding none wanting reviews not shown')
  assert.deepEqual(widths(text), ['column', 'column', 'column', 'column'], 'every card a column wide, however many versions it lists: two, none, twelve, none')
  assert.doesNotMatch(text, />a#1[01]</u, 'nor one every version of which is reviewed, the reader\'s reviews of it to copy or not: its popup copies them')
  assert.match(cards[3], />a#9<[^]*class=team-deps-count>4 other versions unreviewed<[^]*aria-expanded=false [^]*<\/svg>Its own versions pass; 4 versions its lockfiles locked before want reviews<\/button>/u,
    'one held only by the versions its lockfiles locked before it, last')
  assert.doesNotMatch(cards[3], /<li>/u, 'those not listed under it till asked for')
  assert.match(cards[0], /href=https:\/\/github\.com\/org\/b\/pull\/2 [^]*>b#2<[^]*>Pull 2<[^]*class=team-deps-count>2 versions to review</u, 'that adding fewest first')
  assert.match(cards[0], /href=\/npm\/shared@1\.0\.0\/review [^]*shared[^]*class="team-deps-review is-wanted" data-tooltip=0 reviews of 2 required>0\/2<[^]*data-tooltip=Added by a#1 too>\+1</u)
  assert.match(cards[0], /href=\/npm\/rej@1\.0\.0\/review [^]*class="team-deps-review is-failed" data-tooltip="A reviewer rejects it[^>]*>rejected</u, 'one rejected, however many pass it')
  assert.match(cards[0], /shared[^]*>0\/2<\/span>\s*<span class="team-deps-elsewhere" data-tooltip=Reviewed in the comments of a#1, which count there alone>in review in\s+a#1<\/span>/u,
    'one another pull request reviews in its comments, which count there alone, told so')
  assert.equal(cards[0].split('team-deps-elsewhere').length - 1, 1)
  assert.match(cards[0], /<\/a><dependency-review-copy \.text=Reviewed rej \.label=Copy your dependency reviews of its versions><\/dependency-review-copy><\/div>/u,
    'the reader\'s reviews of its versions to copy, as the server\'s host formats them')
  assert.doesNotMatch(cards.slice(1).join(''), /dependency-review-copy/u, 'none where it formats none')
  assert.doesNotMatch(cards[0], /vouched/u, 'one the reviewed dependencies pass not told')
  assert.match(cards[0], /shared[^]*<npm-delta \.name=shared \.version=1\.0\.0 \.base=\(empty\)><\/npm-delta>[^]*rej[^]*<npm-delta \.name=rej /u,
    'the lines each wanting reviews changes, a new one\'s whole')
  assert.match(cards[1], />b#6<[^]*class=team-deps-count>3 versions to review<[^]*and 3 more versions past those listed</u, 'one whose versions wanting reviews aren\'t listed kept')
  assert.doesNotMatch(cards[1], /<li>/u)
  assert.match(cards[2], />a#1<[^]*class=team-deps-count is-failed>review fails</u)
  assert.equal(cards[2].split('<li>').length - 1, 12, 'as many as SHOWN_VERSIONS of its own')
  assert.doesNotMatch(cards[2], /shared@|fine@/u, 'one a pull request above adds, nor one passed, under it')
  assert.match(cards[2], /aria-expanded=false [^]*<\/svg>and 2 more<\/button>[^]*aria-expanded=false [^]*<\/svg>1 version a pull request above adds too<\/button>/u)

  // Each list past those shown opened, and closed again.
  for (const key of ['org/a#1:own', 'org/a#1:above', 'org/a#9:others']) view.toggle(key)
  assert.deepEqual(widths(templateText(view.render())), ['column', 'column', 'column', 'column'], 'one whose list is opened a column wide still')
  const expanded = cardsOf(templateText(view.render()))
  assert.equal(expanded[2].split('<li>').length - 1, 15, 'its own, and the one a pull request above adds')
  assert.match(expanded[2], /<\/svg>Show fewer<\/button>[^]*aria-expanded=true [^]*above adds too<\/button>\s*<ul class="team-deps-versions"><li>[^]*shared/u)
  assert.match(expanded[3], /aria-expanded=true [^]*href=\/npm\/old@1\.0\.0\/review [^]*and 2 more, not listed</u, 'those its lockfiles locked before, as many as it tells')
  assert.match(expanded[2], /shared[^]*data-tooltip=1 review of 2 required; 1 reviewer in its comments, which count here alone>1\/2</u, 'where its comments review it, its count says so')
  assert.doesNotMatch(expanded[2] + expanded[3], /team-deps-elsewhere/u, 'nor told reviewed elsewhere')
  view.toggle('org/a#1:own')
  assert.equal(cardsOf(templateText(view.render()))[2].split('<li>').length - 1, 13)
  assert.doesNotMatch(text, /<h2>a<\/h2>|dependency-review-list/u, 'the other sub-tabs\' apart')

  view.pick('versions')
  const versions = templateText(view.render())
  assert.deepEqual(tabs(versions).map(([label, , on]) => on && label).filter(Boolean), ['Versions'])
  assert.doesNotMatch(versions, /versions to review/u, 'counted by its tab alone')
  assert.equal(versions.split('>shared<').length - 1, 1, 'each once')
  assert.match(versions, /shared[^]*in review in\s+a#1[^]*data-tooltip=Added by b#2, a#1>b#2 \+1</u)
  assert.match(versions, />big-0<[^]*>1\/2<\/span>\s*<span class="team-deps-elsewhere"[^>]*>in review in\s+a#1</u, 'the first adding it too, all its pull requests\' alike')
  assert.match(versions, /<span class="team-deps-row">[^]*gitdep[^]*data-tooltip=From git, which isn’t reviewed>can’t review</u)
  assert.doesNotMatch(versions, /team-deps-pull"/u)

  view.pick('branch')
  const branch = templateText(view.render())
  assert.match(branch, /<h2>a<\/h2>\s*<p class="team-deps-quiet">2 versions unreviewed<\/p>[^]*href=\/npm\/old@1\.0\.0\/review [^]*in review in\s+a#9</u,
    'one a pull request reviews in its comments, which count there alone')
  const patched = branch.split('<li>').find(row => row.includes('>pat<'))
  assert.ok(patched && !patched.includes('team-deps-elsewhere'), 'a patched one never, as two pull requests may patch it apart')
  assert.match(branch, /<h2>b<\/h2>\s*<p class="team-deps-quiet">0 versions unreviewed, 1 lockfile unread<\/p>\s*<p class="team-deps-quiet" role="alert">Unread, so what it locks isn’t checked:\s*<code>web\/bun\.lock<\/code>/u,
    'one wanting none, but whose lockfile is unread')
  assert.doesNotMatch(branch, /<h2>(?:other\/)?c</u, 'one not reviewed, not shown')

  view.pick('reviews')
  const reviews = templateText(view.render())
  assert.match(reviews, /<dependency-review-list \.session=\[object Object\] \.team=team-1><\/dependency-review-list>/u, 'those published to the team')
  assert.doesNotMatch(reviews, /Reading their pull requests|team-deps-pull"/u)
  assert.equal(state.teamDependenciesTab, 'reviews', 'the sub-tab last picked, which the team\'s Dependencies tab opens again')
  assert.deepEqual(routes.splice(0), ['versions', 'branch', 'reviews'].map(dependencyTab => ['push', { view: 'workspace-dependencies', teamSlug: 'deps', dependencyTab }]),
    'each picked at its address, an entry of its own')
  view.pick('pulls')
  routes.length = 0

  view.open({ preventDefault() {} }, { repo: repo(8, 'org/b'), item: pull(2) })
  assert.deepEqual(opened, [{ repository: { repoId: 8, repo: 'org/b' }, target: { number: 2, preview: { ...pull(2), kind: 'pulls' } } }])
})

test('a team none of whose repositories reviews its dependencies for its reader says so, one they read only some of among them; one read failing says it', async () => {
  state.managedSession = { id: 'other', role: 'triage' }
  const none = shown([repo(9, 'org/c'), repo(11, 'org/part')])
  const noneText = await read(none)
  assert.match(noneText, /None of this team’s repositories reviews its dependencies for you\./u)
  assert.deepEqual(tabs(noneText).map(([label]) => label), ['Pull requests', 'Versions', 'Reviews'], 'no default branch to show, nor its sub-tab')
  const failing = shown([repo(10, 'org/gone')])
  const failed = await read(failing)
  assert.match(failed, /role="alert">gone: It isn’t there\.</u, 'named without its owner, the only one')
  assert.doesNotMatch(failed, /workspace-content-empty/u, 'nothing told of what it couldn’t read')
})

test('pull requests and repositories named with their owners where those reviewed have more than one; a sub-tab its address names kept while read, the first in its place where it isn’t shown', async () => {
  state.teamDependenciesTab = 'versions'
  const owners = await read(shown([repo(7, 'org/a'), repo(8, 'kin/b'), repo(10, 'kin/gone')]))
  assert.match(owners, /shared[^]*in review in\s+org\/a#1[^]*data-tooltip=Added by kin\/b#2, org\/a#1>kin\/b#2 \+1</u)
  assert.match(owners, /role="alert">kin\/gone: It isn’t there\.</u)
  state.teamDependenciesTab = 'branch'
  const branch = await read(shown([repo(7, 'org/a'), repo(8, 'kin/b')]))
  assert.match(branch, /<h2>org\/a<\/h2>[^]*<h2>kin\/b<\/h2>/u)

  routes.length = 0
  const view = shown([repo(12, 'org/new')])
  const reading = templateText(view.render())
  assert.deepEqual(tabs(reading).find(([, , on]) => on), ['Default branch', null, true], 'the default branch\'s while its repositories are read')
  view.updated()
  assert.deepEqual(routes, [])
  const text = await read(view)
  assert.deepEqual(tabs(text).map(([label, , on]) => [label, on]), [['Pull requests', true], ['Versions', false], ['Reviews', false]])
  view.updated()
  assert.deepEqual(routes, [['replace', { view: 'workspace-dependencies', teamSlug: 'deps', dependencyTab: 'pulls' }]], 'its address the first\'s, replacing its own')
  assert.equal(state.teamDependenciesTab, 'pulls')
})

test('a read the server\'s time cut short asks again for the repositories it left alone, those told held', async () => {
  state.managedSession = { id: 'resume', role: 'triage' }
  state.teamDependenciesTab = 'pulls'
  asked.teams.length = 0
  timeUp = new Set([8])
  const view = shown([repo(7, 'org/a'), repo(8, 'org/b')])
  const text = await read(view)
  assert.deepEqual(asked.teams, [['team-1', null], ['team-1', [8]]], 'the one left asked for again, alone')
  assert.deepEqual(cardsOf(text).map(card => />([ab]#\d+)</u.exec(card)?.[1]), ['b#2', 'b#6', 'a#1', 'a#9'], 'all told as one read tells them')
  assert.deepEqual(asked.dependencies, [], 'none asked alone')
})

test('a team\'s grown old shown as it was while it is read again; all read anew once a review is set anew', async t => {
  state.managedSession = { id: 'stale', role: 'triage' }
  asked.teams.length = 0
  const view = shown([repo(7, 'org/a')])
  await read(view)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 2 * 60_000 + 1 })
  const refreshing = templateText(view.render())
  assert.deepEqual(asked.teams, [['team-1', null], ['team-1', null]], 'asked again once old')
  assert.match(refreshing, />a#1</u, 'its pull requests shown meanwhile')
  assert.doesNotMatch(refreshing, /Reading their pull requests/u)
  await read(view)
  t.mock.timers.reset()
  globalThis.dispatchEvent(new Event('dependency-review-changed'))
  assert.match(templateText(view.render()), /role="status">Reading their pull requests…/u, 'a review set anew, read anew')
  assert.equal(asked.teams.length, 3)
  await read(view)
  assert.deepEqual(asked.dependencies, [])
})
