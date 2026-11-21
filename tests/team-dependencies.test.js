// A team's Dependencies tab (ui/view/team-dependencies.js): of each of its
// repositories whose review is in effect for its reader, the open pull
// requests whose versions want reviews, in the order picked, each version
// listed under one of those reviewing it alike, dimmed under the rest naming
// it, red under those holding reviews but lacking one made in another's
// comments, dimmed under one holding none where another holds some, with its review
// and its details as its tooltip; those adding only versions others list
// apart, a line each; every version apart, each once; and what each default
// branch locks that wants reviews; each sub-tab at its address; a pull
// request named without its owner where every repository reviewed has the
// same one.
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
// A pull request's answer once it is asked alone, by its repository and number: unanswered where none is.
const answers = new Map()
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
  13: { cut: false, review: { ...terms, unreviewed: 0 }, lockfiles: [dir()] },
  9: { cut: false, review: null, lockfiles: [dir()] },
}
const pull = (number, more = {}) => ({ number, title: `Pull ${number}`, author: 'octo', state: 'open', touchesLockfile: true, ...more })
// When one was opened and last updated, by days into the year.
const dated = (opened, updated) => ({ createdAt: Date.UTC(2026, 0, opened), updatedAt: Date.UTC(2026, 0, updated) })
// Repository 8's more than are read; not all of 13's read.
const UNREAD = 'Not all its open pull requests were read. GitHub failed to answer. Try again shortly.'
const pulls = { 7: { items: [pull(1, dated(10, 60)), pull(3), pull(4, { touchesLockfile: false }), pull(9, dated(15, 32)), pull(10), pull(11)], more: false },
  8: { items: [pull(2, dated(20, 21)), pull(6, dated(5, 64)), pull(7, { touchesLockfile: false })], more: true },
  13: { items: [pull(20)], more: true, error: UNREAD } }
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
  '13#20': { cut: false, review: terms, lockfiles: [dir({ added: [wants('late')] })] },
}
// A team's lines, as the server tells them (fetchTeamDependencies), of those
// `repoIds` names, else all: the lines `old` changes, counted already, with
// 7's default branch; its pull requests' dependencies two a line. Those
// `timeUp` names left for the read's time, once, their default branch told.
const TEAM = [7, 8, 9, 10, 11, 12, 13]
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
  fetchPullDependencies(repoId, number, options) {
    asked.dependencies.push([repoId, number, options])
    return answers.has(`${repoId}#${number}`) ? Promise.resolve(answers.get(`${repoId}#${number}`)) : new Promise(() => {})
  },
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
// Those set apart, adding only versions others list.
const apartOf = text => text.includes('team-deps-pulls is-covered') ? text.slice(text.indexOf('team-deps-pulls is-covered')).split('</ol>')[0].split(/<li class="team-deps-pull is-covered">/u).slice(1) : []
const nameOf = card => card.match(/class="team-deps-pull-name">([^<]+)</u)[1]
// Each card's width: a column's, unless it carries a span.
const widths = text => [...text.matchAll(/<li class="?team-deps-pull( is-[a-z\d-]+)?"?>/gu)].map(m => m[1]?.trim() ?? 'column')

test('the pull requests wanting reviews, fewest first, each version with its review, one unreviewed there dimmed under one reviewing it; every version apart, once; the default branches\'; and the team\'s reviews, a sub-tab each', async () => {
  const view = shown([repo(7, 'org/a'), repo(8, 'org/b'), repo(9, 'other/c'), repo(7, 'org/a')])
  assert.match(templateText(view.render()), /<div class="team-deps-bar">\s*<p class="team-deps-quiet" role="status">Reading their pull requests…<\/p>\s*<\/div>/u,
    'said in the line above the lists, none yet to order')
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
  assert.match(cards[3], />a#9<[^]*class="team-deps-count is-wanted">4 other versions unreviewed<[^]*aria-expanded=false [^]*<\/svg>Its own versions pass; 4 versions its lockfiles locked before want reviews<\/button>/u,
    'one held only by the versions its lockfiles locked before it, last')
  assert.doesNotMatch(cards[3], /<li>/u, 'those not listed under it till asked for')
  assert.match(cards[0], /href=https:\/\/github\.com\/org\/b\/pull\/2 [^]*>b#2<[^]*>Pull 2<[^]*class="team-deps-count">2 deps</u, 'that adding fewest first, how many told, as more than one')
  assert.match(cards[0], /<ul class="team-deps-versions is-same"><li><a class="team-deps-row" href=\/npm\/shared@1\.0\.0\/review [^]*<\/npm-delta>\s*<span class="team-deps-under">a#1<\/span>\s*<\/a><\/li><\/ul>/u,
    'one no review passes yet with no count of them; dimmed after its own, as another pull request holds a review of it, naming that one, not besides')
  assert.match(cards[0], /href=\/npm\/rej@1\.0\.0\/review [^]*<span class="team-deps-review is-failed">rejected</u, 'one rejected, however many pass it, its badge with no tooltip of its own')
  assert.doesNotMatch(cards.join(''), /is-behind|team-deps-lacks|compare-tip-label">Lacks/u,
    'one no review of which counts there never red, though another pull request reviews it in its comments: it is but unreviewed')
  assert.doesNotMatch(cards.join(''), /team-deps-elsewhere/u, 'none told reviewed elsewhere besides')
  assert.equal(cards.join('').split('is-same').length - 1, 1, 'nor any other under another')
  assert.match(text, /<div class="team-deps-bar">\s*<span class="bundles-overview-sort"/u, 'nothing said of red rows in the line above the lists, as there are none')
  assert.match(cards[0], new RegExp(String.raw`<a class="team-deps-row" href=/npm/shared@1\.0\.0/review [^>]* data-tooltip=shared@1\.0\.0 \.tooltipContent=<div class="compare-tip">\s*` +
    String.raw`<div class="team-deps-tip-name">shared@1\.0\.0</div>\s*<div class="compare-tip-rows">` +
    String.raw`<span class="compare-tip-label">Review</span><span>0 reviews of 2 required</span><span class="compare-tip-label">Listed</span><span>under a#1</span></div>\s*` +
    String.raw`<div class="compare-tip-head">Pull requests</div>\s*<div class="compare-tip-rows"><span class=team-deps-tip-pull>\[object Object\]a#1</span>\s*<span>adds it, 1/2</span>` +
    String.raw`<span class=team-deps-tip-pull team-deps-tip-here>\[object Object\]b#2</span>\s*<span>adds it, 0/2</span></div>\s*` +
    String.raw`<div class="compare-tip-head">Reviewed by</div>\s*<div class="compare-tip-rows"><span>cy</span>\s*<span>requests changes</span>` +
    String.raw`<span>kay</span>\s*<span>accepts, in a#1’s comments</span></div>\s*</div>>`, 'u'),
  'its details its tooltip, formatted: its name and version whole, those present before, its review, the one listing it; the pull requests adding it, each with its review there, ' +
  'the one it is listed under marked; and who reviews it, where')
  assert.match(cards[0], /<\/a><dependency-review-copy \.text=Reviewed rej \.label=Copy your dependency reviews of its versions><\/dependency-review-copy><\/div>/u,
    'the reader\'s reviews of its versions to copy, as the server\'s host formats them')
  assert.doesNotMatch(cards.slice(1).join(''), /dependency-review-copy/u, 'none where it formats none')
  assert.doesNotMatch(cards[0], /vouched/u, 'one the reviewed dependencies pass not told')
  assert.match(cards[0], /rej[^]*<npm-delta \.name=rej [^]*shared[^]*<npm-delta \.name=shared \.version=1\.0\.0 \.base=\(empty\) \.patch=><\/npm-delta>/u,
    'the lines each wanting reviews changes, a new one\'s whole; the one reviewed there already first, the one another lists after its own')
  assert.match(cards[1], />b#6<[^]*class="team-deps-count">3 deps<[^]*and 3 more versions past those listed</u, 'one whose versions wanting reviews aren\'t listed kept')
  assert.doesNotMatch(cards[1], /<li>/u)
  assert.match(cards[2], />a#1<[^]*class="team-deps-count is-failed">review fails</u)
  assert.equal(cards[2].split('<li>').length - 1, 12, 'as many as SHOWN_VERSIONS of its own')
  assert.doesNotMatch(cards[2], /fine@/u, 'nor one passed')
  assert.match(cards[2], /<a class="team-deps-row" href=\/npm\/shared@1\.0\.0\/review [^]*<span class="team-deps-review is-wanted">1\/2<\/span>\s*<span class="team-deps-also">\+1<\/span>[^]*aria-expanded=false [^]*<\/svg>and 3 more<\/button>/u,
    'the one holding every review made of it lists it, as it was, whoever is shown first: how many reviews it has, whose in its tooltip')
  assert.equal(cards[2].split('aria-expanded').length - 1, 1)
  assert.match(cards[2], /data-tooltip=shared@1\.0\.0 \.tooltipContent=[^]*<span class="compare-tip-label">Review<\/span><span>1 review of 2 required; 1 reviewer in its comments<\/span><\/div>[^]*<span class=team-deps-tip-pull team-deps-tip-here>\[object Object\]a#1<\/span>[^]*<span>kay<\/span>\s*<span>accepts, in a#1’s comments<\/span>/u,
    'its tooltip telling neither a review it lacks nor another listing it')

  // Each list past those shown opened, and closed again.
  for (const key of ['org/a#1:own', 'org/a#9:others']) view.toggle(key)
  assert.deepEqual(widths(templateText(view.render())), ['column', 'column', 'column', 'column'], 'one whose list is opened a column wide still')
  const expanded = cardsOf(templateText(view.render()))
  assert.equal(expanded[2].split('<li>').length - 1, 15, 'all its own')
  assert.match(expanded[2], /gitdep[^]*<\/svg>Show fewer<\/button>/u)
  assert.match(expanded[3], /aria-expanded=true [^]*href=\/npm\/old@1\.0\.0\/review [^]*and 2 more, not listed</u, 'those its lockfiles locked before, as many as it tells')
  assert.doesNotMatch(expanded.join(''), /team-deps-review[^>]*data-tooltip|>0\/2<\/span>\s*<span class="team-deps-(?:also|lacks)/u, 'no badge with a tooltip of its own, its row\'s telling it; none of no reviews')
  assert.match(expanded[3], /data-tooltip=pat@1\.0\.0 \(patched\) \.tooltipContent=[^]*<span>lee<\/span>\s*<span>accepts, in a#9’s comments<\/span>/u, 'a patched one\'s reviewers in its own comments')
  assert.match(expanded[3], new RegExp(`href=/npm/pat@1\\.0\\.0/review\\?patch=${patch.hash}&repo=7&commit=${'e'.repeat(40)}&path=patches/pat%401\\.0\\.0\\.patch `, 'u'),
    'a patched one reviewed as patched, its patch read of its repository at the commit its lockfiles were read at')
  assert.doesNotMatch(expanded[2] + expanded[3], /team-deps-elsewhere/u, 'nor told reviewed elsewhere')
  view.toggle('org/a#1:own')
  assert.equal(cardsOf(templateText(view.render()))[2].split('<li>').length - 1, 12)
  assert.doesNotMatch(text, /<h2>a<\/h2>|dependency-review-list/u, 'the other sub-tabs\' apart')

  view.pick('versions')
  const versions = templateText(view.render())
  assert.deepEqual(tabs(versions).map(([label, , on]) => on && label).filter(Boolean), ['Versions'])
  assert.doesNotMatch(versions, /versions to review/u, 'counted by its tab alone')
  assert.equal(versions.split('>shared<').length - 1, 1, 'each once')
  assert.match(versions, /shared[^]*1\/2<\/span>\s*<span class="team-deps-elsewhere">a#1<\/span>\s*<span class="team-deps-also">b#2<\/span>\s*<\/a>/u,
    'as the one listing it tells it; one reviewing it in its comments its blue pill names, the other after, not red: it holds none')
  assert.match(versions, /data-tooltip=shared@1\.0\.0 \.tooltipContent=[^]*<span class=team-deps-tip-pull>\[object Object\]a#1<\/span>\s*<span>adds it, 1\/2<\/span><span class=team-deps-tip-pull>\[object Object\]b#2<\/span>\s*<span>adds it, 0\/2<\/span>[^]*<span>kay<\/span>[^]*<span>cy<\/span>/u,
    'its tooltip naming them all, none marked')
  assert.match(versions, />big-0<[^]*>1\/2<\/span>\s*<span class="team-deps-elsewhere">a#1</u, 'the first adding it too, all its pull requests\' alike')
  assert.doesNotMatch(versions.split('<li>').find(row => row.includes('>big-0<')), /team-deps-also/u, 'nor its adders\' pill, where it names all of them')
  assert.match(versions, /<span class="team-deps-row" data-tooltip=gitdep@1\.0\.0 \.tooltipContent=[^]*<span class="compare-tip-label">From<\/span><span>git\+ssh:\/\/github\.com\/org\/gitdep\.git<\/span><span class="compare-tip-label">Review<\/span><span>From git, which isn’t reviewed<\/span>[^]*<span>adds it, can’t review<\/span>[^]*gitdep[^]*<span class="team-deps-review is-failed">can’t review</u)
  assert.doesNotMatch(versions, /team-deps-pull"/u)

  view.pick('branch')
  const branch = templateText(view.render())
  assert.match(branch, /<h2>a<\/h2>\s*<p class="team-deps-quiet">2 versions unreviewed<\/p>[^]*href=\/npm\/old@1\.0\.0\/review [^]*<span class=team-deps-tip-pull>\[object Object\]a#9<\/span>\s*<span>locks it, 1\/2<\/span>[^]*class="team-deps-elsewhere">a#9</u,
    'one a pull request reviews in its comments, which count there alone')
  const patched = branch.split('<li>').find(row => row.includes('>pat<'))
  assert.match(patched, new RegExp(`href=/npm/pat@1\\.0\\.0/review\\?patch=${patch.hash}&repo=7&commit=${'f'.repeat(40)}&path=patches/pat%401\\.0\\.0\\.patch `, 'u'),
    'a patched one reviewed as patched, its patch read at the default branch\'s head')
  assert.match(patched, new RegExp(`<span class="team-deps-patched">patched</span>\\s*<npm-delta \\.name=pat \\.version=1\\.0\\.0 \\.base=\\(empty\\) \\.patch=\\[object Object\\]></npm-delta>\\s*<span class="team-deps-elsewhere">a#9</span>`, 'u'),
    'its lines counted as its patch changes it; its reviews of it as patched, those a pull request\'s comments make of the same patch told so')
  assert.match(patched, /<span class="compare-tip-label">Patched<\/span><span>patches\/pat@1\.0\.0\.patch<\/span>/u, 'its patch\'s file in its tooltip')
  assert.match(patched, /<span class=team-deps-tip-pull>\[object Object\]a#9<\/span>\s*<span>locks it, 1\/2<\/span>[^]*<span>lee<\/span>\s*<span>accepts, in a#9’s comments<\/span>/u,
    'and who reviews the same patch in that pull request\'s comments')
  assert.match(branch, /<h2>b<\/h2>\s*<p class="team-deps-quiet">0 versions unreviewed, 1 lockfile unread<\/p>\s*<p class="team-deps-quiet" role="alert">Unread, so what it locks isn’t checked:\s*<code>web\/bun\.lock<\/code>/u,
    'one wanting none, but whose lockfile is unread')
  assert.doesNotMatch(branch, /<h2>(?:other\/)?c</u, 'one not reviewed, not shown')

  view.pick('reviews')
  const reviews = templateText(view.render())
  assert.match(reviews, /<dependency-review-list \.session=\[object Object\] \.team=team-1><\/dependency-review-list>/u, 'those published to the team')
  assert.doesNotMatch(reviews, /Reading their pull requests|team-deps-pull"|team-deps-bar/u)
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
  const order = text => cardsOf(text).map(nameOf)
  const picked = text => [...text.matchAll(/aria-pressed=true @click=[^]*?\}>([^<]+)<\/button>/gu)].map(m => m[1])
  try {
    let text = await read(view)
    assert.deepEqual(order(text), ['b#2', 'b#6', 'a#1', 'a#9'], 'those adding fewest first, as picked')
    assert.match(text, /<div class="team-deps-bar">\s*<span class="bundles-overview-sort" role="group" aria-label="Pull request order"><button type="button" aria-pressed=false @click=[^]*?>Newest<\/button><button type="button" aria-pressed=false @click=[^]*?>Updated<\/button><button type="button" aria-pressed=true @click=[^]*?>Fewest to review<\/button><\/span>\s*<\/div>/u,
      'picked as other orders are, by their buttons, at the end of the line above them, which says nothing')
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
    // How a version stands under each is whatever order they are in.
    assert.match(cardsOf(text)[0], />b#2<[^]*class="team-deps-under">a#1</u, 'one holding no review of it dimmed under the one holding one, shown before that one')
    assert.doesNotMatch(cardsOf(text)[2], /is-behind|team-deps-under/u, 'the one holding it listing it')
    state.teamDependenciesSort = 'updated'
    text = templateText(view.render())
    assert.match(cardsOf(text)[3], />b#2<[^]*class="team-deps-under">a#1</u, 'and shown after it')
    assert.doesNotMatch(cardsOf(text).slice(0, 3).join(''), /is-behind|team-deps-under/u)
    routes.length = 0
  } finally { state.teamDependenciesSort = 'fewest' }
})

test('a team none of whose repositories reviews its dependencies for its reader says so, one they read only some of among them; one read failing says it', async t => {
  state.managedSession = { id: 'other', role: 'triage' }
  const none = shown([repo(9, 'org/c'), repo(11, 'org/part')])
  const noneText = await read(none)
  assert.match(noneText, /None of this team’s repositories reviews its dependencies for you\./u)
  assert.deepEqual(tabs(noneText).map(([label]) => label), ['Pull requests', 'Versions', 'Reviews'], 'no default branch to show, nor its sub-tab')
  const failing = shown([repo(10, 'org/gone')])
  const failed = await read(failing)
  assert.match(failed, /role="alert">gone: It isn’t there\.</u, 'named without its owner, the only one')
  assert.match(failed, /<div class="team-deps-bar">\s*<p class="team-deps-quiet" data-tooltip=[^]*? role="alert">gone: It isn’t there\.<\/p>\s*<\/div>/u,
    'in the line above the lists, whole in its tooltip')
  // Not all of one's open pull requests read: those read shown, why the rest weren't said there too, in place of their being more than are read.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const partly = shown([repo(13, 'org/m')])
  const partial = await read(partly)
  assert.match(partial, /role="alert">m: Not all its open pull requests were read\. GitHub failed to answer\. Try again shortly\.</u)
  assert.match(partial, />m#20<[^]*>late</u, 'those read, with their versions')
  assert.doesNotMatch(partial, /updated latest are checked/u)
  const before = asked.teams.length
  t.mock.timers.tick(31_000)
  await read(partly)
  assert.equal(asked.teams.length, before + 1, 'asked for again as one failing is, sooner than one read whole')
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

test('a version pull requests add patched alike links to its review as patched by the first told its patch\'s file, read at its commit', async () => {
  const hash = 'b'.repeat(64), named = { hash, path: 'patches/twice@1.0.0.patch' }
  TEAM.push(13)
  branches[13] = { cut: false, review: { ...terms, unreviewed: 0 }, lockfiles: [dir()] }
  pulls[13] = { items: [pull(1), pull(2)], more: false }
  // The first, adding fewest, is told no file of its patch.
  dependencies['13#1'] = { cut: false, head: '1'.repeat(40), review: terms, lockfiles: [dir({ added: [wants('twice', { patch: { hash } })] })] }
  dependencies['13#2'] = { cut: false, head: '2'.repeat(40), review: terms, lockfiles: [dir({ added: [wants('twice', { patch: named }), wants('extra')] })] }
  Object.assign(state, { teamDependenciesTab: 'versions', teamDependenciesSort: 'fewest' })
  const text = await read(shown([repo(13, 'org/twice')]))
  const row = text.split('<li>').find(one => one.includes('>twice<'))
  assert.match(row, new RegExp(`href=/npm/twice@1\\.0\\.0/review\\?patch=${hash}&repo=13&commit=${'2'.repeat(40)}&path=patches/twice%401\\.0\\.0\\.patch `, 'u'))
  assert.match(row, /class="team-deps-also">twice#1 \+1<\/span>/u, 'told under the first adding it still')
  state.teamDependenciesTab = 'pulls'
})

test('a version several pull requests add: listed under one of those reviewing it alike, that with the fewest reviews left, dimmed under the rest; red under those holding reviews but lacking one made in another\'s comments; dimmed under one holding none where another holds some; those adding only versions others list apart, a line each', async () => {
  // Reviewers of a version, each passing it: in its pull request's comments, or published to the team.
  const by = (...logins) => ({ reviews: logins.length, reviewers: logins.map(login => ({ login, status: 'accept', passes: true, comment: true })), commented: logins.length })
  const three = { ...terms, required: 3 }
  const adds = (...added) => ({ cut: false, review: three, lockfiles: [dir({ added })] })
  TEAM.push(14)
  branches[14] = { cut: false, review: { ...three, unreviewed: 0 }, lockfiles: [dir()] }
  pulls[14] = { items: Array.from({ length: 15 }, (_, at) => pull(at + 1)), more: false }
  Object.assign(dependencies, {
    // Reviewed alike in three: the two adding it alone leave as many reviews, the newer listing it, the other set apart; the one adding more tells it under that one.
    '14#1': adds(wants('alike', by('ann')), wants('solo')),
    // Its lockfiles lock another version wanting reviews, which no other lists.
    '14#2': { cut: false, review: { ...three, unreviewed: 1 }, formatted: 'Reviewed alike', lockfiles: [dir({ added: [wants('alike', by('ann'))], unreviewed: [wants('before')] })] },
    '14#3': adds(wants('alike', by('ann'))),
    // One holds a review the other lacks, which holds one too: the one lacking it red, the other as it was. The review lacked is the reader's.
    '14#4': adds(wants('part', by('ann'))),
    '14#5': adds(wants('part', by('ann', 'bo'))),
    // Each holds a review the other lacks: both red.
    '14#6': adds(wants('differ', by('ann'))),
    '14#7': adds(wants('differ', by('bo'))),
    // The same reviewer, published to the team in one, in the other's comments, her login cased otherwise: alike.
    '14#8': adds(wants('cased', { reviews: 1, reviewers: [{ login: 'Ann', status: 'accept', passes: true }] })),
    '14#9': adds(wants('cased', by('ann'))),
    // Two hold no review of it, a third one: those holding none never red, but unreviewed, dimmed under the one holding one.
    '14#10': adds(wants('none')),
    '14#11': adds(wants('none', by('ann'))),
    '14#12': adds(wants('none')),
    // One holding no review of what the two above differ on: under the first of them, as none holds every review.
    '14#13': adds(wants('differ')),
    // One adding a version with a review in its comments, one published to the team not counting of it there, as compared with a version it doesn't replace;
    // and one stacked on it, which but locks the version, that review counting there: the first lacks nothing, as none of it is another's comments'.
    '14#14': adds(wants('stacked', { reviews: 1, commented: 1, reviewers: [{ login: 'dee', status: 'accept' }, { login: 'ann', status: 'accept', passes: true, comment: true }] })),
    '14#15': { cut: false, review: { ...three, unreviewed: 1 }, lockfiles: [dir({ unreviewed: [wants('stacked', { reviews: 1, reviewers: [{ login: 'dee', status: 'accept', passes: true }] })] })] },
  })
  state.managedSession = { id: 'stood', role: 'triage', login: 'Bo' }
  Object.assign(state, { teamDependenciesTab: 'pulls', teamDependenciesSort: 'newest' })
  const view = shown([repo(14, 'org/m')])
  try {
    const text = await read(view)
    assert.deepEqual(tabs(text).slice(0, 2), [['Pull requests', '15', true], ['Versions', '7', false]], 'counted with the rest')
    const main = ['m#15', 'm#14', 'm#11', 'm#9', 'm#7', 'm#6', 'm#5', 'm#4', 'm#3', 'm#1']
    assert.deepEqual(cardsOf(text).map(nameOf), main, 'those listing a version, or lacking a review of one, in the order picked')
    const card = number => cardsOf(text).find(one => nameOf(one) === `m#${number}`)
    const rows = one => one.split('<li>').slice(1)

    // Reviewed alike: one lists it, the rest tell it under that one.
    assert.match(card(3), /<ul class="team-deps-versions"><li><a class="team-deps-row" href=\/npm\/alike@[^]*1\/3<\/span>\s*<span class="team-deps-also">\+2<\/span>/u,
      'listed under one of those leaving fewest reviews, the first of them')
    assert.doesNotMatch(card(3), /is-same|team-deps-under|is-behind|team-deps-count/u, 'nor how many, as one')
    assert.match(card(1), /class="team-deps-count">2 deps<[^]*<ul class="team-deps-versions"><li><a class="team-deps-row" href=\/npm\/solo@[^]*<\/ul>\s*<ul class="team-deps-versions is-same"><li><a class="team-deps-row" href=\/npm\/alike@[^]*<span class="team-deps-under">m#3<\/span>\s*<span class="team-deps-also">\+1<\/span>/u,
      'dimmed after its own under one leaving more, naming the one listing it, not besides')
    assert.match(card(1), /data-tooltip=alike@1\.0\.0 \.tooltipContent=[^]*<span class="compare-tip-label">Listed<\/span><span>under m#3<\/span>/u, 'told so in its tooltip')
    assert.equal(rows(card(1)).length, 2)

    // One a subset of the other, holding a review itself: the smaller red, the fuller as it was.
    assert.match(card(4), /<a class="team-deps-row is-behind" href=\/npm\/part@[^]*<span class="compare-tip-label">Lacks<\/span><span>your review in m#5<\/span>[^]*1\/3<\/span>\s*<span class="team-deps-also">\+1<\/span>/u,
      'its tooltip telling whose it lacks, the reader\'s as theirs, and where')
    assert.match(card(5), /<a class="team-deps-row" href=\/npm\/part@[^]*2\/3<\/span>\s*<span class="team-deps-also">\+1<\/span>/u)
    assert.doesNotMatch(card(5), /is-behind|compare-tip-label">Lacks|is-same/u)

    // Neither a subset of the other: both red.
    assert.match(card(6), /<a class="team-deps-row is-behind" href=\/npm\/differ@[^]*<span class="compare-tip-label">Lacks<\/span><span>your review in m#7<\/span>[^]*1\/3<\/span>\s*<span class="team-deps-also">\+2<\/span>/u)
    assert.match(card(7), /<a class="team-deps-row is-behind" href=\/npm\/differ@[^]*<span class="compare-tip-label">Lacks<\/span><span>ann’s review in m#6<\/span>[^]*1\/3<\/span>\s*<span class="team-deps-also">\+2<\/span>/u)
    assert.doesNotMatch(cardsOf(text).join(''), /team-deps-lacks/u, 'what each lacks in its tooltip alone')
    assert.match(text, /<p class="team-deps-quiet team-deps-key">3 versions lack reviews made elsewhere<\/p>/u, 'each counted in the line above them')

    // A review published to the team, counting where a pull request but locks the version and not where one adds it: not lacked there, as it is no comment's.
    assert.match(card(14), /<ul class="team-deps-versions"><li><a class="team-deps-row" href=\/npm\/stacked@[^]*<span class=team-deps-tip-pull>\[object Object\]m#15<\/span>\s*<span>locks it, 1\/3<\/span>[^]*1\/3<\/span>\s*<\/a>/u)
    assert.doesNotMatch(card(14), /is-behind|compare-tip-label">Lacks|is-same/u)

    // One holding no review of it: never red, but dimmed under the one holding one, which lists it.
    assert.match(card(11), /<ul class="team-deps-versions"><li><a class="team-deps-row" href=\/npm\/none@[^]*1\/3<\/span>\s*<span class="team-deps-also">\+2<\/span>/u)
    assert.doesNotMatch(card(11), /is-behind|is-same/u)

    // Those adding only versions others list: apart, after the rest, a line each.
    assert.match(text, /<\/ol>\s*<section class="team-deps-covered" aria-label="Pull requests adding only versions listed above">\s*<button type="button" class="team-deps-more" aria-expanded=true [^]*?<\/svg>5 more\s+add only versions listed above<\/button>/u)
    const apart = apartOf(text)
    const aside = ['m#13', 'm#12', 'm#10', 'm#8', 'm#2']
    assert.deepEqual(apart.map(nameOf), aside, 'in the order picked')
    assert.match(apart[4], /<button type="button" class="team-deps-fold" aria-expanded=false aria-label=m#2’s versions\s[^]*>m#2<[^]*>Pull 2<\/span>\s*<span class="team-deps-count is-wanted">1 other unreviewed<\/span>\s*<span class="team-deps-under">m#3<\/span>\s*<\/a><dependency-review-copy \.text=Reviewed alike /u,
      'its head alone, naming the one listing its versions, the reader\'s reviews of them to copy still; and how many other versions its lockfiles lock want reviews, which none else lists')
    assert.match(apart[3], /<span class="team-deps-under">m#9<\/span>/u, 'one reviewed by the same reviewer, her login cased otherwise, alike')
    assert.match(apart[1] + apart[2], /<span class="team-deps-under">m#11<\/span>[^]*<span class="team-deps-under">m#11<\/span>/u, 'each holding no review under the one holding one')
    assert.match(apart[0], /<span class="team-deps-under">m#7<\/span>/u, 'one holding none of what two differ on under the first of them')
    assert.doesNotMatch(apart.join(''), /<li>|is-behind/u, 'none of their versions listed till asked for, none red')
    assert.doesNotMatch(apart[3], /team-deps-count/u, 'nothing told of one whose lockfiles lock no others')
    assert.match(card(9), /<a class="team-deps-row" href=\/npm\/cased@/u)

    view.toggle('org/m#2:covered')
    const unfolded = apartOf(templateText(view.render()))
    assert.match(unfolded[4], /aria-expanded=true [^]*<ul class="team-deps-versions is-same"><li><a class="team-deps-row" href=\/npm\/alike@[^]*<span class="team-deps-under">m#3<\/span>[^]*<\/svg>1 other version its lockfiles lock wants reviews<\/button>/u,
      'its versions once opened, dimmed, and those others to open under them')
    assert.doesNotMatch(unfolded.slice(0, 4).join(''), /<li>/u, 'the others as they were')
    view.toggle('covered')
    const hidden = templateText(view.render())
    assert.deepEqual(apartOf(hidden), [], 'all of them hidden once asked')
    assert.match(hidden, /class="team-deps-more" aria-expanded=false [^]*?<\/svg>5 more\s+add only versions listed above<\/button>\s*<\/section>/u)
    assert.equal(cardsOf(hidden).length, 10)

    // Whatever order is picked, each stands as it did.
    state.teamDependenciesSort = 'fewest'
    const fewest = templateText(view.render())
    assert.deepEqual(cardsOf(fewest).map(nameOf), [...main.slice(1), 'm#15'], 'the one holding none of its own last')
    view.toggle('covered')
    assert.deepEqual(apartOf(templateText(view.render())).map(nameOf), aside)

    view.pick('versions')
    const versions = templateText(view.render())
    const version = name => versions.split('<li>').find(one => one.includes(`>${name}<`))
    assert.match(version('alike'), /1\/3<\/span>\s*<span class="team-deps-elsewhere">m#1 \+2<\/span>\s*<\/a>/u, 'one reviewed alike once, none of those adding it red')
    assert.match(version('part'), /2\/3<\/span>\s*<span class="team-deps-lacks">m#4<\/span>\s*<span class="team-deps-elsewhere">m#5<\/span>/u,
      'as the one holding every review of it tells it, the one lacking them red')
    assert.match(version('differ'), /1\/3<\/span>\s*<span class="team-deps-lacks">m#7 \+1<\/span>\s*<span class="team-deps-also">m#13<\/span>\s*<\/a>/u,
      'each lacking another\'s review red, none listing it: told as one holding most does; the one holding none after, not red')
    assert.doesNotMatch(version('differ'), /team-deps-elsewhere/u)
    assert.match(version('none'), /1\/3<\/span>\s*<span class="team-deps-elsewhere">m#11<\/span>\s*<span class="team-deps-also">m#12 \+1<\/span>/u,
      'as the one listing it tells it; those holding none after it, not red')
    assert.doesNotMatch(version('none'), /team-deps-lacks/u)
  } finally {
    Object.assign(state, { teamDependenciesTab: 'pulls', teamDependenciesSort: 'fewest' })
    routes.length = 0
  }
})

test('a pull request awaiting a build of Stasis\'s is asked again alone, its repository not read again for it; one whose default branch awaits it is read again sooner; none said to want nothing meanwhile', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const waiting = { paths: ['stasis.config.json'], error: 'stasis-pending' }
  const none = { ...terms, toReview: 0, unreviewed: 0, unsupported: 0 }
  TEAM.push(21, 22)
  branches[21] = { cut: false, review: none, lockfiles: [dir()] }
  pulls[21] = { items: [pull(1)], more: false }
  dependencies['21#1'] = { cut: false, review: none, lockfiles: [waiting] }
  Object.assign(state, { teamDependenciesTab: 'pulls', teamDependenciesSort: 'fewest' })
  asked.teams.length = asked.dependencies.length = 0
  const view = shown([repo(21, 'org/built')])
  const text = await read(view)
  assert.match(text, /role="status">Stasis is still working out what some <code>stasis\.config\.json<\/code> entries reach; they are asked again as it does\.</u)
  assert.doesNotMatch(text, /No open pull request/u, 'nothing known to want none till it is built')
  t.mock.timers.tick(30_000)
  await read(view)
  assert.deepEqual([asked.teams, asked.dependencies.map(([repoId, number]) => [repoId, number])], [[['team-1', null]], [[21, 1]]], 'the pull request asked again alone, its repository read once')

  // Its default branch awaiting one: its repository read again, 30 s on.
  branches[22] = { cut: false, review: none, lockfiles: [dir(), waiting] }
  pulls[22] = { items: [], more: false }
  asked.teams.length = 0
  const branch = shown([repo(22, 'org/building')])
  state.teamDependenciesTab = 'branch'
  assert.match(await read(branch), /role="status">Stasis is still working out what some <code>stasis\.config\.json<\/code> entries reach/u)
  t.mock.timers.tick(15_000)
  await read(branch)
  assert.equal(asked.teams.length, 1, 'not yet')
  t.mock.timers.tick(15_000)
  await read(branch)
  assert.equal(asked.teams.length, 2)
  state.teamDependenciesTab = 'pulls'
})

test('a version its lockfile alone asks for, the stasis.config.json beside it reaching it not, is marked in each list, every other row as it was; a lockfile\'s are listed while Stasis builds, marked once it has; those reviewed already first, those marked last', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const stasis = more => dir({ paths: ['stasis.config.json'], ...more })
  const lone = name => wants(name, { unreached: true })
  const waiting = { paths: ['stasis.config.json'], error: 'stasis-pending' }
  TEAM.push(23, 24)
  // 23 holds to its lockfile and the stasis.config.json beside it; 24 to its lockfile alone.
  branches[23] = { cut: false, review: { ...terms, unreviewed: 2 }, lockfiles: [dir({ unreviewed: [lone('devtool'), wants('bundled')] }), stasis({ unreviewed: [wants('bundled')] })] }
  pulls[23] = { items: [pull(1), pull(2)], more: false }
  dependencies['23#1'] = { cut: false, review: terms, lockfiles: [dir({ added: [lone('only-pm'), wants('by-both'), lone('mixed'), wants('tooling', { unreached: true, reviews: 1 })] }),
    stasis({ added: [wants('by-both'), wants('only-stasis', { reviews: 1 })] })] }
  dependencies['23#2'] = { cut: false, review: terms, lockfiles: [dir({ added: [wants('early')] }), waiting] }
  branches[24] = { cut: false, review: { ...terms, unreviewed: 0 }, lockfiles: [dir()] }
  pulls[24] = { items: [pull(1)], more: false }
  dependencies['24#1'] = { cut: false, review: terms, lockfiles: [dir({ added: [wants('mixed'), wants('plain')] })] }
  Object.assign(state, { teamDependenciesTab: 'pulls', teamDependenciesSort: 'fewest' })
  asked.teams.length = asked.dependencies.length = 0
  // Each row's version, and whether it is marked.
  const rows = text => text.split('<li>').slice(1).map(row => [row.match(/data-tooltip=([^@]+)@/u)[1], row.includes('class="team-deps-unreached"')])
  const cards = text => new Map(cardsOf(text).map(card => [nameOf(card), rows(card)]))
  try {
    const view = shown([repo(23, 'org/both'), repo(24, 'org/plain')])
    const text = await read(view)
    assert.deepEqual(cards(text), new Map([['plain#1', [['mixed', false], ['plain', false]]], ['both#2', [['early', false]]],
      ['both#1', [['only-stasis', false], ['by-both', false], ['tooling', true], ['only-pm', true], ['mixed', true]]]]),
    'its lockfile\'s alone marked; one Stasis reaches, alone or with it, and one of a lockfile with none beside it, not; one still built, listed unmarked. ' +
    'Those reviewed there already first, those marked last, a reviewed one first among them')
    assert.deepEqual(rows(cardsOf(text).find(card => nameOf(card) === 'both#1').split('team-deps-versions is-same')[1]), [['mixed', true]], 'above the one another lists, dimmed, which comes after all')
    assert.match(text, /role="status">Stasis is still working out what some <code>stasis\.config\.json<\/code> entries reach/u)
    assert.doesNotMatch(text, /review fails/u, 'one awaiting it fails nothing')
    const marked = text.split('<li>').find(row => row.includes('data-tooltip=only-pm@'))
    assert.match(marked, /<span class="team-deps-unreached" role="img" aria-label=Asked for by its lockfile alone: the stasis\.config\.json beside it reaches it by no entry>!<\/span>/u, 'an exclamation mark, named')
    assert.match(marked, /<span class="compare-tip-label">Asked for<\/span><span>by its lockfile alone: the stasis\.config\.json beside it reaches it by no entry<\/span>/u, 'and said in its tooltip')
    assert.doesNotMatch(text.split('<li>').find(row => row.includes('data-tooltip=by-both@')), /Asked for/u)

    view.pick('versions')
    assert.deepEqual(rows(templateText(view.render())), [['only-stasis', false], ['early', false], ['mixed', false], ['plain', false], ['by-both', false], ['tooling', true], ['only-pm', true]],
      'each once, in that order too: not marked where another pull request\'s lockfile asks for it too')
    view.pick('branch')
    assert.deepEqual(rows(templateText(view.render())), [['bundled', false], ['devtool', true]], 'its default branch\'s too')
    view.pick('pulls')

    // Built: asked again alone, its rows marked as it tells them, the rest as they were.
    answers.set('23#2', { number: 2, cut: false, review: terms, lockfiles: [dir({ added: [lone('early'), wants('late')] }), stasis({ added: [wants('late')] })] })
    t.mock.timers.tick(30_000)
    const built = await read(view)
    assert.deepEqual(asked.dependencies.map(([repoId, number]) => [repoId, number]), [[23, 2]])
    assert.deepEqual([cards(built).get('both#2'), cards(built).get('both#1')], [[['late', false], ['early', true]], cards(text).get('both#1')])
    assert.doesNotMatch(built, /Stasis is still working/u)
    assert.deepEqual(asked.teams, [['team-1', null]], 'its repositories not read again for it')
  } finally {
    answers.clear()
    routes.length = 0
    Object.assign(state, { teamDependenciesTab: 'pulls', teamDependenciesSort: 'fewest' })
  }
})

// Every version's row of every card of `text`, those set apart too: its card, whether its list is the dimmed one, the pull request it names, and whether it is red.
const rowsOf = text => [...cardsOf(text), ...apartOf(text)].flatMap(card => card.split('<ul class="team-deps-versions').slice(1).map(part => part.split('</ul>')[0])
  .flatMap(list => list.split('<li>').slice(1).map(row => ({ card: nameOf(card), same: list.startsWith(' is-same"'), version: /href=\/npm\/(v\d)@/u.exec(row)[1],
    under: /class="team-deps-under">([^<]+)</u.exec(row)?.[1], red: row.includes('team-deps-row is-behind') }))))

test('however reviews fall across the pull requests adding a version, some pull request lists it, plain or red; one dimming it names a pull request listing it', async () => {
  TEAM.push(15)
  branches[15] = { cut: false, review: { ...terms, required: 4, unreviewed: 0 }, lockfiles: [dir()] }
  let seed = 11
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  // In its comments mostly, else published to the team, which counts in some pull requests and not others.
  const stance = login => {
    const where = random() < 0.7 ? { comment: true } : {}
    return random() < 0.15 ? { login, status: 'reject', ...where } : { login, status: 'accept', ...where.comment || random() < 0.6 ? { passes: true } : {}, ...where }
  }
  Object.assign(state, { teamDependenciesTab: 'pulls', teamDependenciesSort: 'newest' })
  // How many rows were dimmed, and red, over all of them: each some, lest none be tried.
  const seen = { dimmed: 0, red: 0 }
  try {
    for (let round = 0; round < 40; round++) {
      const count = 2 + Math.floor(random() * 6), wanted = new Set()
      pulls[15] = { items: Array.from({ length: count }, (_, at) => pull(at + 1)), more: false }
      for (let number = 1; number <= count; number++) {
        // Each of a few versions, by any of three reviewers, more wanted than they are: every one wants reviews.
        const added = ['v0', 'v1', 'v2', 'v3'].filter(() => random() < 0.6).map(name => {
          const reviewers = ['ann', 'bo', 'cy'].filter(() => random() < 0.35).map(stance)
          wanted.add(name)
          return wants(name, { reviews: reviewers.filter(one => one.passes).length, ...reviewers.some(one => one.status === 'reject') ? { rejected: true } : {}, ...reviewers.length > 0 ? { reviewers } : {} })
        })
        dependencies[`15#${number}`] = { cut: false, review: { ...terms, required: 4 }, lockfiles: [dir({ added })] }
      }
      state.managedSession = { id: `falls-${round}`, role: 'triage' }
      const view = shown([repo(15, 'org/p')])
      await read(view)
      // Those set apart opened, their versions told.
      for (let number = 1; number <= count; number++) view.toggle(`org/p#${number}:covered`)
      const text = templateText(view.render())
      // Each card's versions: those it lists, plain or red, and those it dims, by the pull request each names.
      const dimmed = []
      const listed = new Map()
      for (const row of rowsOf(text)) {
        assert.equal(row.same, row.under !== undefined, 'dimmed where it names another, and there alone')
        if (row.under) dimmed.push([row.card, row.version, row.under])
        else listed.set(row.version, [...listed.get(row.version) ?? [], row.card])
        if (row.red) seen.red++
      }
      for (const version of wanted) assert.ok(listed.has(version), `round ${round}: ${version} listed by some pull request`)
      for (const [card, version, under] of dimmed) {
        assert.ok(listed.get(version).includes(under), `round ${round}: ${card} dims ${version} under ${under}, which lists it`)
        assert.ok(!listed.get(version).includes(card), `round ${round}: ${card} doesn't list ${version} too`)
      }
      seen.dimmed += dimmed.length
    }
    assert.ok(seen.dimmed > 40 && seen.red > 10, `tried: ${seen.dimmed} dimmed, ${seen.red} red`)
  } finally {
    Object.assign(state, { teamDependenciesTab: 'pulls', teamDependenciesSort: 'fewest' })
    routes.length = 0
  }
})

test('where the host names bases, a row reviews its version against the one it names, of its package or another, its lines counted against one of its own; whole where it names none', async () => {
  const { versionRow } = await import('../ui/view/team-dependencies.js')
  const review = { required: 1, canReview: true, reviewedBases: true }
  const row = (pkg, more = review) => templateText(versionRow({ source: 'registry', version: '3.0.0', reviews: 0, ...pkg }, more, { added: true }))
  assert.match(row({ name: 'ms', base: { name: 'ms', version: '2.0.0' } }), /href=\/npm\/ms@3\.0\.0\/review\/ms@2\.0\.0 [^]*<npm-delta \.name=ms \.version=3\.0\.0 \.base=2\.0\.0 \.patch=>/u)
  const forked = row({ name: '@fork/ms', base: { name: 'ms', version: '2.1.3' } })
  assert.match(forked, /href=\/npm\/@fork\/ms@3\.0\.0\/review\/ms@2\.1\.3 /u)
  assert.doesNotMatch(forked, /<npm-delta/u, 'no lines counted against another package\'s')
  assert.match(row({ name: 'ms', was: ['2.1.2'] }), /href=\/npm\/ms@3\.0\.0\/review [^]*\.base=\(empty\) \.patch=>/u, 'none named: whole, not against the version it was')
  assert.match(row({ name: 'ms', was: ['2.1.2'] }, { ...review, reviewedBases: undefined }), /href=\/npm\/ms@3\.0\.0\/review\/ms@2\.1\.2 /u, 'where the host names none')
})

test('a row\'s tooltip names its reviewers the app knows by their names and avatars, the rest by their logins', async () => {
  const { versionRow } = await import('../ui/view/team-dependencies.js')
  const { knowGithubUsers } = await import('../ui/view/github-users.js')
  knowGithubUsers({ users: { kay: { id: 'u-kay', login: 'kay', name: 'Kay Lee' } }, reviewers: [{ login: 'kay' }, { login: 'stranger' }] })
  const pkg = { name: 'ms', version: '2.1.3', source: 'registry', reviews: 1, reviewers: [{ login: 'kay', status: 'accept', passes: true }, { login: 'stranger', status: 'reject' }] }
  const text = templateText(versionRow(pkg, { required: 2, canReview: true }, { added: true, lacks: [{ login: 'kay', status: 'accept', where: ['a#1'] }] }))
  assert.match(text, /Reviewed by<\/div>[^]*<span class="app-user" data-tooltip=@kay on GitHub><span class="app-user-avatar" aria-hidden="true">K<img src=\/api\/avatar\/u-kay [^]*<span class="app-user-name">Kay Lee<\/span>[^]*<span>stranger<\/span>/u)
  assert.match(text, /Lacks<\/span><span>Kay Lee’s review in a#1<\/span>/u)
  // An answer telling no users, as one seeded of a team's line, forgets none.
  const { seedPullDependencies } = await import('../ui/view/pull-dependencies.js')
  seedPullDependencies(70, new Map([[1, { number: 1, cut: false, review: { required: 2, canReview: true }, lockfiles: [{ paths: ['package-lock.json'], added: [pkg], more: 0 }] }]]), true)
  assert.match(templateText(versionRow(pkg, { required: 2, canReview: true }, { added: true })), /<span class="app-user-name">Kay Lee<\/span>/u)
})

test('a pull request into a branch other than the default is left out where it adds none to review and its comments review none', async () => {
  const was = dependencies['7#9']
  try {
    for (const [session, more, shownToo] of [['into-other', {}, false], ['into-other-commented', { commentReviews: 1 }, true]]) {
      state.managedSession = { id: session, role: 'triage' }
      dependencies['7#9'] = { ...was, intoOther: true, review: { ...was.review, ...more } }
      const names = new Set(cardsOf(await read(shown([repo(7, 'org/a')]))).map(nameOf))
      assert.equal(names.has('a#9'), shownToo, session)
      assert.ok(names.has('a#1'), 'one adding some still')
    }
  } finally { dependencies['7#9'] = was }
})


test('a version its pull request\'s comments alone pass, where the host reads them, is still listed, as its reviews aren\'t yet the host\'s, its pull request with it', async () => {
  const was = dependencies['7#11']
  try {
    state.managedSession = { id: 'by-comments', role: 'triage' }
    dependencies['7#11'] = { ...was, review: { ...terms, byComments: true, reviewedDependencies: true }, lockfiles: [dir({ added: [wants('talked', { reviews: 2, commented: 2 })] })] }
    const card = cardsOf(await read(shown([repo(7, 'org/a')]))).find(one => nameOf(one) === 'a#11')
    assert.match(card ?? '', /talked@[^]*<span class="team-deps-review is-commented">2\/2<\/span>/u)
    assert.match(card, /2 reviews of 2 required, in its comments, not yet in the reviewed dependencies/u)
  } finally { dependencies['7#11'] = was }
})

test('its pull requests\' cards packed as masonry: each spanning as many of its list\'s rows as it is tall, with the gap under it; none out of a list', async t => {
  const { masonrySpan } = await import('../ui/view/team-dependencies.js')
  const list = { style: {} }
  const card = (height, more = {}) => ({ isConnected: true, parentElement: list, style: {}, getBoundingClientRect: () => ({ height }), marginBottom: '8px', ...more })
  const had = globalThis.getComputedStyle
  globalThis.getComputedStyle = element => element === list ? { gridAutoRows: '4px' } : { marginBottom: element.marginBottom }
  t.after(() => { globalThis.getComputedStyle = had })
  const [tall, short, gapless, gone] = [card(300), card(1), card(10, { marginBottom: '' }), card(300, { isConnected: false })]
  for (const one of [tall, short, gapless, gone]) masonrySpan(one)
  assert.deepEqual([tall, short, gapless, gone].map(one => one.style.gridRowEnd), ['span 77', 'span 3', 'span 3', undefined])
})
