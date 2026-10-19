// A team's Dependencies tab (ui/view/team-dependencies.js): of each of its
// repositories whose review is in effect for its reader, the open pull
// requests whose versions want reviews, in the order picked, each version told
// under the first adding it, dimmed under those after naming it, with its
// review and its details as its tooltip; every version apart, each once; and
// what each default branch locks that wants reviews; each sub-tab at its
// address; a pull request named without its owner where every repository
// reviewed has the same one.
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { mock, test } from 'node:test'
import './_polyfills.js'
import { templateText, templates } from './_lit.js'

const state = { managedSession: { id: 's', role: 'triage' }, managedTeams: [{ id: 'team-1', slug: 'deps' }], teamDependenciesTab: 'pulls', teamDependenciesSort: 'fewest' }
// The team reads asked, by the repositories each names (none: all), and the
// pull requests or deltas asked alone.
const asked = { teams: [], dependencies: [], deltas: [] }
// Each team read's signal, as asked.
const reads = []
const terms = { required: 2, since: null, canReview: true }
const dir = (more = {}) => ({ paths: ['package-lock.json'], added: [], more: 0, unreviewed: [], moreUnreviewed: 0, unsupported: [], moreUnsupported: 0, moreLocked: 0, ...more })
const wants = (name, more = {}) => ({ name, version: '1.0.0', source: 'registry', reviews: 0, ...more })
const gitdep = { name: 'gitdep', version: '1.0.0', source: 'git', from: 'git+ssh://github.com/org/gitdep.git', unsupported: 'git' }
// The first reviewed in its own pull request's comments alone.
const big = Array.from({ length: 13 }, (_, at) => wants(`big-${at}`, at === 0 ? { reviews: 1, commented: 1 } : {}))
// pat as pnpm patches it, by the same patch everywhere, its lockfile naming its file.
const patch = { hash: 'a'.repeat(64), path: 'patches/pat@1.0.0.patch' }
const branches = {
  7: { cut: false, head: 'f'.repeat(40), review: { ...terms, unreviewed: 2 }, lockfiles: [dir({ unreviewed: [wants('old'), wants('pat', { patch })] })] },
  8: { cut: false, review: { ...terms, unreviewed: 0 }, lockfiles: [dir(), { paths: ['web/bun.lock'], error: 'lockfile-unsupported' }] },
  9: { cut: false, review: null, lockfiles: [dir()] },
}
const pull = (number, more = {}) => ({ number, title: `Pull ${number}`, author: 'octo', state: 'open', touchesLockfile: true, ...more })
// When one was opened and last updated, by days into the year.
const dated = (opened, updated) => ({ createdAt: Date.UTC(2026, 0, opened), updatedAt: Date.UTC(2026, 0, updated) })
// Repository 8's more than are read.
const pulls = { 7: { items: [pull(1, dated(10, 60)), pull(3), pull(4, { touchesLockfile: false }), pull(9, dated(15, 32)), pull(10), pull(11)], more: false },
  8: { items: [pull(2, dated(20, 21)), pull(6, dated(5, 64)), pull(7, { touchesLockfile: false })], more: true } }
const dependencies = {
  // Its shared one reviewed in its comments, which count for it alone.
  '7#1': { cut: false, review: terms, lockfiles: [dir({ added: [wants('shared', { reviews: 1, commented: 1, reviewers: [{ login: 'kay', status: 'accept', passes: true, comment: true }] }),
    ...big, gitdep, wants('fine', { reviews: 2 })], unsupported: [gitdep] })] },
  '7#3': { cut: false, review: terms, lockfiles: [dir({ added: [wants('fine', { reviews: 2 }), wants('known', { baseline: true })] })] },
  // Its own passed, but held by those its lockfiles locked before it.
  // Its patch of pat reviewed in its comments.
  '7#9': { cut: false, head: 'e'.repeat(40), review: { ...terms, unreviewed: 4 }, lockfiles: [dir({ added: [wants('fine', { reviews: 2 })], unreviewed: [wants('old', { reviews: 1, commented: 1 }),
    wants('pat', { patch, reviews: 1, commented: 1, reviewers: [{ login: 'lee', status: 'accept', passes: true, comment: true }] })], moreUnreviewed: 2 })] },
  // The reader's reviews of its versions formatted by the server's host, to copy.
  // Every version reviewed, one with the reader's reviews to copy, one without.
  '7#10': { cut: false, review: terms, formatted: 'Reviewed done', lockfiles: [dir({ added: [wants('done', { reviews: 2 })] })] },
  '7#11': { cut: false, review: terms, lockfiles: [dir({ added: [wants('done', { reviews: 2 })] })] },
  // Its shared one asked changes of by a reviewer whose reviews count
  // everywhere; two reviewers malformed, not told.
  '8#2': { cut: false, review: terms, formatted: 'Reviewed rej', lockfiles: [dir({ added: [wants('shared', { reviewers: [{ login: 'cy', status: 'request-changes' },
    { login: 7, status: 'accept' }, { login: 'zed', status: 'maybe' }] }), wants('rej', { reviews: 2, rejected: true }), wants('vouched', { reviewed: true })] })] },
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
    else if (branches[repoId]) {
      lines.push({ repoId, branch: branches[repoId], pulls: pulls[repoId], ...repoId === 7 ? { deltas: [['old', '1.0.0', '(empty)', { additions: 3, deletions: 0, typeless: null }]] } : {} })
      if (timeUp.has(repoId)) { unread.push(repoId); continue }
      const numbers = pulls[repoId].items.filter(item => item.touchesLockfile !== false).map(item => item.number)
      for (let at = 0; at < numbers.length; at += 2) {
        lines.push({ repoId, dependencies: new Map(numbers.slice(at, at + 2).map(number => [number, { number, ...dependencies[`${repoId}#${number}`] }])) })
      }
    } else lines.push({ repoId, error: 'It isn’t there.', code: 'github-not-found' })
  }
  timeUp = new Set()
  return [...lines, unread.length > 0 ? { done: false, unread } : { done: true }]
}
mock.module('../client/index.js', { exports: { state } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchNpmDeltas(versions) { asked.deltas.push(versions); return new Promise(() => {}) },
  async fetchTeamDependencies(teamId, onLine, { repoIds, signal }) {
    asked.teams.push([teamId, repoIds])
    reads.push(signal)
    for (const line of teamLines(repoIds)) {
      await setImmediate()
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
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

test('the pull requests wanting reviews, fewest first, each version under the first adding it, dimmed under those after naming it, its review shown; every version apart, once; the default branches\'; and the team\'s reviews, a sub-tab each', async () => {
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
  assert.match(cards[0], /href=\/npm\/shared@1\.0\.0\/review [^]*shared[^]*class="team-deps-review is-wanted" data-tooltip=0 reviews of 2 required \.tooltipContent=<div class="compare-tip"><div class="compare-tip-head">Reviews<\/div><div class="compare-tip-rows"><span class="compare-tip-label">Passing<\/span><span>0 of 2 required<\/span><\/div><\/div>>0\/2<[^]*<span class="team-deps-also">\+1<\/span>/u,
    'its review\'s badge, what it says its tooltip, formatted')
  assert.match(cards[0], /href=\/npm\/rej@1\.0\.0\/review [^]*class="team-deps-review is-failed" data-tooltip=A reviewer rejects it: it wants their newer accepting review \.tooltipContent=<div class="compare-tip"><div class="compare-tip-head">Rejected<\/div><div>A reviewer rejects it: it wants their newer accepting review<\/div><\/div>>rejected</u, 'one rejected, however many pass it')
  assert.match(cards[0], /shared[^]*>0\/2<\/span>\s*<span class="team-deps-elsewhere">a#1<\/span>/u,
    'one another pull request reviews in its comments, which count there alone, told so')
  assert.equal(cards[0].split('team-deps-elsewhere').length - 1, 1)
  assert.match(cards[0], new RegExp(String.raw`<a class="team-deps-row" href=/npm/shared@1\.0\.0/review [^>]* data-tooltip=shared@1\.0\.0 \.tooltipContent=<div class="compare-tip">\s*` +
    String.raw`<div class="team-deps-tip-name">shared@1\.0\.0</div>\s*<div class="compare-tip-rows"><span class="compare-tip-label">Present</span><span>none, new</span>` +
    String.raw`<span class="compare-tip-label">Review</span><span>0 reviews of 2 required</span></div>\s*` +
    String.raw`<div class="compare-tip-head">Pull requests</div>\s*<div class="compare-tip-rows"><span class=>a#1</span>\s*<span>adds it, 1/2</span>` +
    String.raw`<span class=team-deps-tip-here>b#2</span>\s*<span>adds it, 0/2</span></div>\s*` +
    String.raw`<div class="compare-tip-head">Reviewed by</div>\s*<div class="compare-tip-rows"><span>cy</span>\s*<span>requests changes</span>` +
    String.raw`<span>kay</span>\s*<span>accepts, in a#1’s comments</span></div>\s*</div>>`, 'u'),
  'its details its tooltip, formatted: its name and version whole, those present before, its review; the pull requests adding it, each with its review there, ' +
  'the one it is listed under marked; and who reviews it, where')
  assert.match(cards[0], /<\/a><dependency-review-copy \.text=Reviewed rej \.label=Copy your dependency reviews of its versions><\/dependency-review-copy><\/div>/u,
    'the reader\'s reviews of its versions to copy, as the server\'s host formats them')
  assert.doesNotMatch(cards.slice(1).join(''), /dependency-review-copy/u, 'none where it formats none')
  assert.doesNotMatch(cards[0], /vouched/u, 'one the reviewed dependencies pass not told')
  assert.match(cards[0], /shared[^]*<npm-delta \.name=shared \.version=1\.0\.0 \.base=\(empty\)><\/npm-delta>[^]*rej[^]*<npm-delta \.name=rej /u,
    'the lines each wanting reviews changes, a new one\'s whole')
  assert.match(cards[1], />b#6<[^]*class=team-deps-count>3 versions to review<[^]*and 3 more versions past those listed</u, 'one whose versions wanting reviews aren\'t listed kept')
  assert.doesNotMatch(cards[1], /<li>/u)
  assert.match(cards[2], />a#1<[^]*class=team-deps-count is-failed>review fails</u)
  assert.equal(cards[2].split('<li>').length - 1, 13, 'as many as SHOWN_VERSIONS of its own, and the one a pull request above adds')
  assert.doesNotMatch(cards[2], /fine@/u, 'nor one passed')
  assert.match(cards[2], /aria-expanded=false [^]*<\/svg>and 2 more<\/button>\s*<ul class="team-deps-versions is-above"><li>[^]*href=\/npm\/shared@1\.0\.0\/review [^]*<span class="team-deps-above">b#2<\/span>\s*<\/a><\/li><\/ul>/u,
    'one a pull request above adds after its own, dimmed, naming that one, not besides')
  assert.equal(cards[2].split('aria-expanded').length - 1, 1, 'all of them listed, none to open')
  assert.match(cards[2], /data-tooltip=shared@1\.0\.0 \.tooltipContent=[^]*<span class="compare-tip-label">Review<\/span><span>1 review of 2 required; 1 reviewer in its comments, which count here alone<\/span><span class="compare-tip-label">Listed<\/span><span>under b#2 above<\/span>[^]*<span class=team-deps-tip-here>a#1<\/span>[^]*<span>kay<\/span>\s*<span>accepts, in a#1’s comments<\/span>/u,
    'one a pull request above adds told so in its tooltip too')

  // Each list past those shown opened, and closed again.
  for (const key of ['org/a#1:own', 'org/a#9:others']) view.toggle(key)
  assert.deepEqual(widths(templateText(view.render())), ['column', 'column', 'column', 'column'], 'one whose list is opened a column wide still')
  const expanded = cardsOf(templateText(view.render()))
  assert.equal(expanded[2].split('<li>').length - 1, 15, 'its own, and the one a pull request above adds')
  assert.match(expanded[2], /<\/svg>Show fewer<\/button>\s*<ul class="team-deps-versions is-above"><li>[^]*shared/u)
  assert.match(expanded[3], /aria-expanded=true [^]*href=\/npm\/old@1\.0\.0\/review [^]*and 2 more, not listed</u, 'those its lockfiles locked before, as many as it tells')
  assert.match(expanded[2], /shared[^]*data-tooltip=1 review of 2 required; 1 reviewer in its comments, which count here alone \.tooltipContent=[^]*<span class="compare-tip-label">Passing<\/span><span>1 of 2 required<\/span><span class="compare-tip-label">In its comments<\/span><span>1 reviewer, counting here alone<\/span><\/div><\/div>>1\/2</u,
    'where its comments review it, its count says so')
  assert.match(expanded[3], /data-tooltip=pat@1\.0\.0 \(patched\) \.tooltipContent=[^]*<span>lee<\/span>\s*<span>accepts, in a#9’s comments<\/span>/u, 'a patched one\'s reviewers in its own comments')
  assert.match(expanded[3], new RegExp(`href=/npm/pat@1\\.0\\.0/review\\?patch=${patch.hash}&repo=7&commit=${'e'.repeat(40)}&path=patches/pat%401\\.0\\.0\\.patch `, 'u'),
    'a patched one reviewed as patched, its patch read of its repository at the commit its lockfiles were read at')
  assert.doesNotMatch(expanded[2] + expanded[3], /team-deps-elsewhere/u, 'nor told reviewed elsewhere')
  view.toggle('org/a#1:own')
  assert.equal(cardsOf(templateText(view.render()))[2].split('<li>').length - 1, 13)
  assert.doesNotMatch(text, /<h2>a<\/h2>|dependency-review-list/u, 'the other sub-tabs\' apart')

  view.pick('versions')
  const versions = templateText(view.render())
  assert.deepEqual(tabs(versions).map(([label, , on]) => on && label).filter(Boolean), ['Versions'])
  assert.doesNotMatch(versions, /versions to review/u, 'counted by its tab alone')
  assert.equal(versions.split('>shared<').length - 1, 1, 'each once')
  assert.match(versions, /shared[^]*class="team-deps-elsewhere">a#1<\/span>\s*<span class="team-deps-also">b#2<\/span>/u, 'one adding it its blue pill names, not named again')
  assert.match(versions, /data-tooltip=shared@1\.0\.0 \.tooltipContent=[^]*<span class=>a#1<\/span>\s*<span>adds it, 1\/2<\/span><span class=>b#2<\/span>\s*<span>adds it, 0\/2<\/span>[^]*<span>cy<\/span>[^]*<span>kay<\/span>/u,
    'its tooltip naming them all, none marked')
  assert.match(versions, />big-0<[^]*>1\/2<\/span>\s*<span class="team-deps-elsewhere">a#1</u, 'the first adding it too, all its pull requests\' alike')
  assert.doesNotMatch(versions.split('<li>').find(row => row.includes('>big-0<')), /team-deps-also/u, 'nor its adders\' pill, where it names all of them')
  assert.match(versions, /<span class="team-deps-row" data-tooltip=gitdep@1\.0\.0 \.tooltipContent=[^]*<span class="compare-tip-label">From<\/span><span>git\+ssh:\/\/github\.com\/org\/gitdep\.git<\/span><span class="compare-tip-label">Review<\/span><span>From git, which isn’t reviewed<\/span>[^]*<span>adds it, can’t review<\/span>[^]*gitdep[^]*data-tooltip=From git, which isn’t reviewed \.tooltipContent=[^]*?<\/div>>can’t review</u)
  assert.doesNotMatch(versions, /team-deps-pull"/u)

  view.pick('branch')
  const branch = templateText(view.render())
  assert.match(branch, /<h2>a<\/h2>\s*<p class="team-deps-quiet">2 versions unreviewed<\/p>[^]*href=\/npm\/old@1\.0\.0\/review [^]*<span class=>a#9<\/span>\s*<span>locks it, 1\/2<\/span>[^]*class="team-deps-elsewhere">a#9</u,
    'one a pull request reviews in its comments, which count there alone')
  const patched = branch.split('<li>').find(row => row.includes('>pat<'))
  assert.match(patched, new RegExp(`href=/npm/pat@1\\.0\\.0/review\\?patch=${patch.hash}&repo=7&commit=${'f'.repeat(40)}&path=patches/pat%401\\.0\\.0\\.patch `, 'u'),
    'a patched one reviewed as patched, its patch read at the default branch\'s head')
  assert.match(patched, /<span class="team-deps-patched">patched<\/span>[^]*class="team-deps-review is-wanted"[^]*>0\/2<[^]*<span class="team-deps-elsewhere">a#9<\/span>/u,
    'its reviews of it as patched, those a pull request\'s comments make of the same patch told so')
  assert.match(patched, /<span class="compare-tip-label">Patched<\/span><span>patches\/pat@1\.0\.0\.patch<\/span>/u, 'its patch\'s file in its tooltip')
  assert.match(patched, /<span class=>a#9<\/span>\s*<span>locks it, 1\/2<\/span>[^]*<span>lee<\/span>\s*<span>accepts, in a#9’s comments<\/span>/u,
    'and who reviews the same patch in that pull request\'s comments')
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

test('the pull requests in the order picked, the newest opened first where none is, or the latest updated; versions in theirs whatever is picked', async () => {
  const view = shown([repo(7, 'org/a'), repo(8, 'org/b')])
  const order = text => cardsOf(text).map(card => card.match(/class="team-deps-pull-name">([^<]+)</u)[1])
  const picked = text => [...text.matchAll(/aria-pressed=true @click=[^]*?\}>([^<]+)<\/button>/gu)].map(m => m[1])
  try {
    let text = await read(view)
    assert.deepEqual(order(text), ['b#2', 'b#6', 'a#1', 'a#9'], 'those adding fewest first, as picked')
    assert.match(text, /<div class="team-deps-sort"><span class="bundles-overview-sort" role="group" aria-label="Pull request order"><button type="button" aria-pressed=false @click=[^]*?>Newest<\/button><button type="button" aria-pressed=false @click=[^]*?>Updated<\/button><button type="button" aria-pressed=true @click=[^]*?>Fewest to review<\/button><\/span><\/div>/u,
      'picked as other orders are, by their buttons')
    const versions = () => { view.pick('versions'); const listed = templateText(view.render()); view.pick('pulls'); return listed }
    const before = versions()
    for (const [sort, expected] of [[undefined, ['b#2', 'a#9', 'a#1', 'b#6']], ['updated', ['b#6', 'a#1', 'a#9', 'b#2']], ['other', ['b#2', 'a#9', 'a#1', 'b#6']]]) {
      state.teamDependenciesSort = sort
      text = templateText(view.render())
      assert.deepEqual(order(text), expected, sort ?? 'none picked')
      assert.deepEqual(picked(text), [sort === 'updated' ? 'Updated' : 'Newest'])
      assert.equal(versions(), before, 'Versions as it was')
    }
    const button = label => templates(view.render()).find(template => template.strings.join('').includes('aria-pressed=') && template.values.includes(label))
    button('Newest').values.find(value => typeof value === 'function')()
    assert.equal(state.teamDependenciesSort, 'newest', 'its button picks it')
    text = templateText(view.render())
    assert.match(cardsOf(text)[2], /class="team-deps-above">b#2</u, 'a version told under the first adding it, as it is shown, by its tag')
    state.teamDependenciesSort = 'updated'
    text = templateText(view.render())
    assert.match(cardsOf(text)[3], /class="team-deps-above is-reviewed">a#1<\/span>/u, 'blue where that one reviews it in its comments')
    assert.doesNotMatch(cardsOf(text)[3], /team-deps-elsewhere/u, 'not named again')
    assert.doesNotMatch(cardsOf(text)[1], /team-deps-above/u)
    routes.length = 0
  } finally { state.teamDependenciesSort = 'fewest' }
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
  assert.match(owners, /shared[^]*class="team-deps-elsewhere">org\/a#1<\/span>\s*<span class="team-deps-also">kin\/b#2<\/span>/u)
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

test('a team\'s read stopped once no tab shows it, its tab left or showing another team; read again once shown', async () => {
  state.managedSession = { id: 'left', role: 'triage' }
  state.teamDependenciesTab = 'pulls'
  asked.teams.length = 0
  const view = shown([repo(7, 'org/a'), repo(8, 'org/b')])
  const connected = value => Object.defineProperty(view, 'isConnected', { value, configurable: true })
  connected(true)
  view.render()
  await setImmediate()
  connected(false)
  view.disconnectedCallback()
  await settle()
  assert.ok(reads.at(-1).aborted, 'its tab left, stopped')
  connected(true)
  assert.match(await read(view), />a#1</u, 'shown again, read again')
  assert.deepEqual(asked.teams, [['team-1', null], ['team-1', null]])
  assert.ok(!reads.at(-1).aborted)

  // Another team's shown: the first stopped, the repositories it held read for the other.
  state.managedSession = { id: 'switched', role: 'triage' }
  asked.teams.length = 0
  view.render()
  await setImmediate()
  view.team = 'team-2'
  const text = await read(view)
  assert.ok(reads.at(-2).aborted, 'the first team\'s stopped')
  assert.deepEqual(asked.teams, [['team-1', null], ['team-2', null]])
  assert.match(text, />a#1</u)
  connected(false)
  view.disconnectedCallback()
})
