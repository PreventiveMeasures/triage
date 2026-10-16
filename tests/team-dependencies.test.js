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
const big = Array.from({ length: 9 }, (_, at) => wants(`big-${at}`))
const branches = {
  7: { cut: false, review: { ...terms, unreviewed: 1 }, lockfiles: [dir({ unreviewed: [wants('old')] })] },
  8: { cut: false, review: { ...terms, unreviewed: 0 }, lockfiles: [dir(), { paths: ['web/bun.lock'], error: 'lockfile-unsupported' }] },
  9: { cut: false, review: null, lockfiles: [dir()] },
}
const pull = (number, more = {}) => ({ number, title: `Pull ${number}`, author: 'octo', state: 'open', touchesLockfile: true, ...more })
const pulls = { 7: [pull(1), pull(3), pull(4, { touchesLockfile: false })], 8: [pull(2)], 9: [pull(5)] }
const dependencies = {
  '7#1': { cut: false, review: terms, lockfiles: [dir({ added: [wants('shared'), ...big, gitdep, wants('fine', { reviews: 2 })], unsupported: [gitdep] })] },
  '7#3': { cut: false, review: terms, lockfiles: [dir({ added: [wants('fine', { reviews: 2 }), wants('known', { baseline: true })] })] },
  '8#2': { cut: false, review: terms, lockfiles: [dir({ added: [wants('shared'), wants('rej', { reviews: 2, rejected: true }), wants('vouched', { reviewed: true })] })] },
}
mock.module('../client/index.js', { exports: { state } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchBranchDependencies(repoId) {
    asked.branches.push(repoId)
    if (repoId === 11) return Promise.reject(Object.assign(new Error('Only some of it.'), { code: 'no-directory' }))
    return repoId in branches ? Promise.resolve(branches[repoId]) : Promise.reject(new Error('It isn’t there.'))
  },
  fetchRepositoryIssues(repoId, kind, options) { asked.pulls.push([repoId, kind, options]); return Promise.resolve({ items: pulls[repoId], more: false }) },
  fetchPullDependencies(repoId, number, options) { asked.dependencies.push([repoId, number, options]); return Promise.resolve({ number, ...dependencies[`${repoId}#${number}`] }) },
} })
const opened = []
mock.module('../ui/view/lazy-dialogs.js', { exports: { openRepositoryItemDialog(props) { opened.push(props) } } })
await import('../ui/view/team-dependencies.js')
const Dependencies = customElements.get('team-dependencies')

const repo = (repoId, name) => ({ repoId, name, paths: [], reports: 0, bundles: 0, available: true })
const settle = async () => { for (let round = 0; round < 12; round++) await setImmediate() }
// As its page would, rendered again as what it reads arrives.
const read = async view => { for (let round = 0; round < 4; round++) { view.render(); await settle() } return templateText(view.render()) }
const shown = repositories => Object.assign(new Dependencies(), { repositories })

test('the pull requests wanting reviews, fewest first, each version under the first adding it alone, its review shown; every version apart, once; and the default branches\'', async () => {
  const view = shown([repo(7, 'org/a'), repo(8, 'org/b'), repo(9, 'org/c'), repo(7, 'org/a')])
  assert.match(templateText(view.render()), /role="status">Reading their pull requests…/u)
  const text = await read(view)
  assert.deepEqual(asked.branches.toSorted(), [7, 8, 9], 'each repository once')
  assert.deepEqual(asked.pulls.map(([repoId, kind, options]) => [repoId, kind, options.state]).toSorted(), [[7, 'pulls', 'open'], [8, 'pulls', 'open']],
    'of those whose review is in effect')
  assert.deepEqual(asked.dependencies.map(([repoId, number, options]) => [repoId, number, options.review]).toSorted(), [[7, 1, true], [7, 3, true], [8, 2, true]],
    'those changing a lockfile, of the repositories reviewing them, with their review')
  assert.doesNotMatch(text, /Reading their pull requests/u)
  const cards = text.slice(text.indexOf('team-deps-pulls'), text.indexOf('</ol></section>')).split('<li class="team-deps-pull">').slice(1)
  assert.equal(cards.length, 2, 'one adding none wanting reviews not shown')
  assert.match(cards[0], /href=https:\/\/github\.com\/org\/b\/pull\/2 [^]*>org\/b#2<[^]*>Pull 2<[^]*class=team-deps-count>2 versions to review</u, 'that adding fewest first')
  assert.match(cards[0], /href=\/npm\/shared@1\.0\.0\/review [^]*shared[^]*class="team-deps-review is-wanted" data-tooltip=0 reviews of 2 required>0\/2<[^]*data-tooltip=Added by org\/a#1 too>\+1</u)
  assert.match(cards[0], /href=\/npm\/rej@1\.0\.0\/review [^]*class="team-deps-review is-failed" data-tooltip="A reviewer rejects it[^>]*>rejected</u, 'one rejected, however many pass it')
  assert.doesNotMatch(cards[0], /vouched/u, 'one the reviewed dependencies pass not told')
  assert.match(cards[1], />org\/a#1<[^]*class=team-deps-count is-failed>review fails</u)
  assert.equal(cards[1].split('<li>').length - 1, 8, 'as many as SHOWN_VERSIONS of its own')
  assert.doesNotMatch(cards[1].slice(0, cards[1].indexOf('and 2 more')), /shared@|fine/u, 'one a pull request above adds, nor one passed, under it')
  assert.match(cards[1], /and 2 more<[^]*data-tooltip=shared@1\.0\.0>and 1 version a pull request above adds too</u)
  const versions = text.slice(text.indexOf('versions to review, each once'))
  assert.match(text, /<summary>12 versions to review, each once<\/summary>/u)
  assert.equal(versions.split('>shared<').length - 1, 1, 'each once')
  assert.match(versions, /shared[^]*data-tooltip=Added by org\/b#2, org\/a#1>org\/b#2 \+1</u)
  assert.match(versions, /<span class="team-deps-row">[^]*gitdep[^]*data-tooltip=From git, which isn’t reviewed>can’t review</u)
  assert.match(text, /<summary>org\/a’s default branch: 1 version unreviewed<\/summary>[^]*href=\/npm\/old@1\.0\.0\/review /u)
  assert.match(text, /<summary>org\/b’s default branch: 0 versions unreviewed, 1 lockfile unread<\/summary>\s*<p class="team-deps-quiet" role="alert">Unread, so what it locks isn’t checked:\s*<code>web\/bun\.lock<\/code>/u,
    'one wanting none, but whose lockfile is unread')
  assert.doesNotMatch(text, /org\/c/u, 'one not reviewed, not shown')

  view.open({ preventDefault() {} }, { repo: repo(8, 'org/b'), item: pull(2) })
  assert.deepEqual(opened, [{ repository: { repoId: 8, repo: 'org/b' }, target: { number: 2, preview: { ...pull(2), kind: 'pulls' } } }])
})

test('a team none of whose repositories reviews its dependencies for its reader says so, one they read only some of among them; one read failing says it', async () => {
  state.managedSession = { id: 'other', role: 'triage' }
  const none = shown([repo(9, 'org/c'), repo(11, 'org/part')])
  assert.match(await read(none), /None of this team’s repositories reviews its dependencies for you\./u)
  const failing = Object.assign(new Dependencies(), { repositories: [repo(10, 'org/gone')] })
  const failed = await read(failing)
  assert.match(failed, /role="alert">org\/gone: It isn’t there\.</u)
  assert.doesNotMatch(failed, /workspace-content-empty/u, 'nothing told of what it couldn’t read')
})
