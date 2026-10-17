// A team's Dependencies tab (ui/view/team-dependencies.js): of each of its
// repositories whose review is in effect for its reader, the open pull
// requests whose versions want reviews, fewest first, each version told
// under the first adding it alone, with its review; every version apart, each
// once; and what each default branch locks that wants reviews.
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { mock, test } from 'node:test'
import './_polyfills.js'
import { templateText } from './_lit.js'

const state = { managedSession: { id: 's', role: 'triage' } }
const asked = { branches: [], pulls: [], dependencies: [] }
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
// Repository 8's a page at a time, more than are read.
const pulls = { 7: [pull(1), pull(3), pull(4, { touchesLockfile: false }), pull(9), pull(10), pull(11)], 8: { '': [pull(2)], p2: [pull(6)], p3: [pull(7, { touchesLockfile: false })] }, 9: [pull(5)] }
const page = (repoId, after = '') => Array.isArray(pulls[repoId]) ? { items: pulls[repoId], more: false }
  : { items: pulls[repoId][after] ?? [], more: true, after: after === '' ? 'p2' : `p${Number(after.slice(1)) + 1}` }
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
mock.module('../client/index.js', { exports: { state } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchNpmDelta: () => new Promise(() => {}),
  fetchBranchDependencies(repoId) {
    asked.branches.push(repoId)
    if (repoId === 11) return Promise.reject(Object.assign(new Error('Only some of it.'), { code: 'no-directory' }))
    return repoId in branches ? Promise.resolve(branches[repoId]) : Promise.reject(new Error('It isn’t there.'))
  },
  fetchRepositoryIssues(repoId, kind, options) { asked.pulls.push([repoId, kind, options]); return Promise.resolve(page(repoId, options.after)) },
  fetchPullDependencies(repoId, number, options) { asked.dependencies.push([repoId, number, options]); return Promise.resolve({ number, ...dependencies[`${repoId}#${number}`] }) },
} })
const opened = []
mock.module('../ui/view/lazy-dialogs.js', { exports: { openRepositoryItemDialog(props) { opened.push(props) } } })
mock.module('../ui/view/compare-load.js', { exports: { withCompare: template => template() } })
await import('../ui/view/team-dependencies.js')
const Dependencies = customElements.get('team-dependencies')

const repo = (repoId, name) => ({ repoId, name, paths: [], reports: 0, bundles: 0, available: true })
const settle = async () => { for (let round = 0; round < 12; round++) await setImmediate() }
// As its page would, rendered again as what it reads arrives.
const read = async view => { for (let round = 0; round < 4; round++) { view.render(); await settle() } return templateText(view.render()) }
const shown = repositories => Object.assign(new Dependencies(), { repositories, team: 'team-1' })
// Its sub-tabs, as a dialog's header tabs, each with its count, and the one picked.
const tabs = text => [...text.split('class="dlg-tabs"')[1].split('</div>')[0].matchAll(/aria-selected=(true|false)[^]*?\n\s*>([^<]+)(?:<span class="team-deps-tab-n">([^<]+)<\/span>)?<\/button>/gu)]
  .map(m => [m[2], m[3] ?? null, m[1] === 'true'])
const cardsOf = text => text.slice(text.indexOf('team-deps-pulls'), text.indexOf('</ol>')).split('<li class="team-deps-pull">').slice(1)

test('the pull requests wanting reviews, fewest first, each version under the first adding it alone, its review shown; every version apart, once; the default branches\'; and the team\'s reviews, a sub-tab each', async () => {
  const view = shown([repo(7, 'org/a'), repo(8, 'org/b'), repo(9, 'org/c'), repo(7, 'org/a')])
  assert.match(templateText(view.render()), /role="status">Reading their pull requests…/u)
  const text = await read(view)
  assert.deepEqual(tabs(text), [['Pull requests', '4', true], ['Versions', '16', false], ['Default branch', '2', false], ['Reviews', null, false]])
  assert.match(text, /role="tabpanel" id=team-deps-panel-pulls aria-labelledby=team-deps-tab-pulls>/u, 'the one open under them')
  assert.deepEqual(asked.branches.toSorted(), [7, 8, 9], 'each repository once')
  assert.deepEqual(asked.pulls.map(([repoId, kind, options]) => [repoId, kind, options.state, options.after ?? null]).toSorted(),
    [[7, 'pulls', 'open', null], [8, 'pulls', 'open', null], [8, 'pulls', 'open', 'p2'], [8, 'pulls', 'open', 'p3']], 'of those whose review is in effect, three pages at most')
  assert.deepEqual(asked.dependencies.map(([repoId, number, options]) => [repoId, number, options.review]).toSorted(),
    [[7, 1, true], [7, 10, true], [7, 11, true], [7, 3, true], [7, 9, true], [8, 2, true], [8, 6, true]],
    'those changing a lockfile, of the repositories reviewing them, with their review')
  assert.match(text, /role="alert">Only org\/b’s 3 open pull requests\s+updated latest are checked; its others aren’t\./u)
  assert.doesNotMatch(text, /Reading their pull requests/u)
  const cards = cardsOf(text)
  assert.equal(cards.length, 5, 'one adding none wanting reviews not shown, but where the reader\'s reviews of it are to copy')
  assert.match(cards[4], />org\/a#10<[^]*class=team-deps-count is-done>every version reviewed<[^]*<dependency-review-copy \.text=Reviewed done /u, 'that one last')
  assert.doesNotMatch(text, />org\/a#11</u)
  assert.match(cards[3], />org\/a#9<[^]*class=team-deps-count>4 other versions unreviewed<[^]*aria-expanded=false [^]*<\/svg>Its own versions pass; 4 versions its lockfiles locked before want reviews<\/button>/u,
    'one held only by the versions its lockfiles locked before it, last')
  assert.doesNotMatch(cards[3], /<li>/u, 'those not listed under it till asked for')
  assert.match(cards[0], /href=https:\/\/github\.com\/org\/b\/pull\/2 [^]*>org\/b#2<[^]*>Pull 2<[^]*class=team-deps-count>2 versions to review</u, 'that adding fewest first')
  assert.match(cards[0], /href=\/npm\/shared@1\.0\.0\/review [^]*shared[^]*class="team-deps-review is-wanted" data-tooltip=0 reviews of 2 required>0\/2<[^]*data-tooltip=Added by org\/a#1 too>\+1</u)
  assert.match(cards[0], /href=\/npm\/rej@1\.0\.0\/review [^]*class="team-deps-review is-failed" data-tooltip="A reviewer rejects it[^>]*>rejected</u, 'one rejected, however many pass it')
  assert.match(cards[0], /shared[^]*>0\/2<\/span>\s*<span class="team-deps-elsewhere" data-tooltip=Reviewed in the comments of org\/a#1, which count there alone>in review in\s+org\/a#1<\/span>/u,
    'one another pull request reviews in its comments, which count there alone, told so')
  assert.equal(cards[0].split('team-deps-elsewhere').length - 1, 1)
  assert.match(cards[0], /<\/a><dependency-review-copy \.text=Reviewed rej \.label=Copy your dependency reviews of its versions><\/dependency-review-copy><\/div>/u,
    'the reader\'s reviews of its versions to copy, as the server\'s host formats them')
  assert.doesNotMatch(cards.slice(1, 4).join(''), /dependency-review-copy/u, 'none where it formats none')
  assert.doesNotMatch(cards[0], /vouched/u, 'one the reviewed dependencies pass not told')
  assert.match(cards[0], /shared[^]*<npm-delta \.name=shared \.version=1\.0\.0 \.base=\(empty\)><\/npm-delta>[^]*rej[^]*<npm-delta \.name=rej /u,
    'the lines each wanting reviews changes, a new one\'s whole')
  assert.match(cards[1], />org\/b#6<[^]*class=team-deps-count>3 versions to review<[^]*and 3 more versions past those listed</u, 'one whose versions wanting reviews aren\'t listed kept')
  assert.doesNotMatch(cards[1], /<li>/u)
  assert.match(cards[2], />org\/a#1<[^]*class=team-deps-count is-failed>review fails</u)
  assert.equal(cards[2].split('<li>').length - 1, 12, 'as many as SHOWN_VERSIONS of its own')
  assert.doesNotMatch(cards[2], /shared@|fine@/u, 'one a pull request above adds, nor one passed, under it')
  assert.match(cards[2], /aria-expanded=false [^]*<\/svg>and 2 more<\/button>[^]*aria-expanded=false [^]*<\/svg>1 version a pull request above adds too<\/button>/u)

  // Each list past those shown opened, and closed again.
  for (const key of ['org/a#1:own', 'org/a#1:above', 'org/a#9:others']) view.toggle(key)
  const expanded = cardsOf(templateText(view.render()))
  assert.equal(expanded[2].split('<li>').length - 1, 15, 'its own, and the one a pull request above adds')
  assert.match(expanded[2], /<\/svg>Show fewer<\/button>[^]*aria-expanded=true [^]*above adds too<\/button>\s*<ul class="team-deps-versions"><li>[^]*shared/u)
  assert.match(expanded[3], /aria-expanded=true [^]*href=\/npm\/old@1\.0\.0\/review [^]*and 2 more, not listed</u, 'those its lockfiles locked before, as many as it tells')
  assert.match(expanded[2], /shared[^]*data-tooltip=1 review of 2 required; 1 reviewer in its comments, which count here alone>1\/2</u, 'where its comments review it, its count says so')
  assert.doesNotMatch(expanded[2] + expanded[3], /team-deps-elsewhere/u, 'nor told reviewed elsewhere')
  view.toggle('org/a#1:own')
  assert.equal(cardsOf(templateText(view.render()))[2].split('<li>').length - 1, 13)
  assert.doesNotMatch(text, /versions to review, each once|<h2>org\/a<\/h2>|dependency-review-list/u, 'the other sub-tabs\' apart')

  view.pick('versions')
  const versions = templateText(view.render())
  assert.deepEqual(tabs(versions).map(([label, , on]) => on && label).filter(Boolean), ['Versions'])
  assert.match(versions, /16 versions to review, each once,\s+by the pull requests adding it\./u)
  assert.equal(versions.split('>shared<').length - 1, 1, 'each once')
  assert.match(versions, /shared[^]*in review in\s+org\/a#1[^]*data-tooltip=Added by org\/b#2, org\/a#1>org\/b#2 \+1</u)
  assert.match(versions, />big-0<[^]*>1\/2<\/span>\s*<span class="team-deps-elsewhere"[^>]*>in review in\s+org\/a#1</u, 'the first adding it too, all its pull requests\' alike')
  assert.match(versions, /<span class="team-deps-row">[^]*gitdep[^]*data-tooltip=From git, which isn’t reviewed>can’t review</u)
  assert.doesNotMatch(versions, /team-deps-pull"/u)

  view.pick('branch')
  const branch = templateText(view.render())
  assert.match(branch, /<h2>org\/a<\/h2>\s*<p class="team-deps-quiet">2 versions unreviewed<\/p>[^]*href=\/npm\/old@1\.0\.0\/review [^]*in review in\s+org\/a#9</u,
    'one a pull request reviews in its comments, which count there alone')
  const patched = branch.split('<li>').find(row => row.includes('>pat<'))
  assert.ok(patched && !patched.includes('team-deps-elsewhere'), 'a patched one never, as two pull requests may patch it apart')
  assert.match(branch, /<h2>org\/b<\/h2>\s*<p class="team-deps-quiet">0 versions unreviewed, 1 lockfile unread<\/p>\s*<p class="team-deps-quiet" role="alert">Unread, so what it locks isn’t checked:\s*<code>web\/bun\.lock<\/code>/u,
    'one wanting none, but whose lockfile is unread')
  assert.doesNotMatch(branch, /org\/c/u, 'one not reviewed, not shown')

  view.pick('reviews')
  const reviews = templateText(view.render())
  assert.match(reviews, /<dependency-review-list \.session=\[object Object\] \.team=team-1><\/dependency-review-list>/u, 'those published to the team')
  assert.doesNotMatch(reviews, /Reading their pull requests|team-deps-pull"/u)
  assert.equal(Object.assign(new Dependencies(), { repositories: [], team: 'team-1' })._tab, 'reviews', 'the sub-tab last picked opened again')
  view.pick('pulls')

  view.open({ preventDefault() {} }, { repo: repo(8, 'org/b'), item: pull(2) })
  assert.deepEqual(opened, [{ repository: { repoId: 8, repo: 'org/b' }, target: { number: 2, preview: { ...pull(2), kind: 'pulls' } } }])
})

test('a team none of whose repositories reviews its dependencies for its reader says so, one they read only some of among them; one read failing says it', async () => {
  state.managedSession = { id: 'other', role: 'triage' }
  const none = shown([repo(9, 'org/c'), repo(11, 'org/part')])
  const noneText = await read(none)
  assert.match(noneText, /None of this team’s repositories reviews its dependencies for you\./u)
  assert.deepEqual(tabs(noneText).map(([label]) => label), ['Pull requests', 'Versions', 'Reviews'], 'no default branch to show, nor its sub-tab')
  const failing = Object.assign(new Dependencies(), { repositories: [repo(10, 'org/gone')] })
  const failed = await read(failing)
  assert.match(failed, /role="alert">org\/gone: It isn’t there\.</u)
  assert.doesNotMatch(failed, /workspace-content-empty/u, 'nothing told of what it couldn’t read')
})
