// A managed bundle's dependency review as a line of its Overview's facts
// (ui/view/bundle-dependency-review.js): asked once, kept for its session;
// nothing while first read, for a bundle of no repository, or where no review
// is in effect; else whether its npm versions pass, how many want reviews,
// or what fails it, and, opened, its terms and those versions, each opening
// its review where its reader reviews.
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { mock, test } from 'node:test'
import './_polyfills.js'
import { templateText, templates } from './_lit.js'

const state = { managedSession: { id: 's', role: 'triage' } }
const asked = []
let answers = {}
mock.module('../client/index.js', { exports: { state } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchBundleDependencyReview(id) { asked.push(id); const told = answers[id]; return told instanceof Error ? Promise.reject(told) : Promise.resolve(told) },
  fetchNpmDeltas() { return new Promise(() => {}) },
  fetchTeamDependencies() { return new Promise(() => {}) },
  fetchPullDependencies() { return new Promise(() => {}) },
  fetchPullDependenciesOf() { return new Promise(() => {}) },
} })
mock.module('../ui/view/lazy-dialogs.js', { exports: { openRepositoryItemDialog() {} } })
mock.module('../ui/view/compare-load.js', { exports: { withCompare: template => template() } })
mock.module('../ui/view/managed-history.js', { exports: { managedHistory: { pushRoute() {}, replaceRoute() {} } } })
const { bundleDependencyReviewFact } = await import('../ui/view/bundle-dependency-review.js')

const head = 'f'.repeat(40)
const dir = (more = {}) => ({ paths: ['web/yarn.lock', 'package-lock.json'], added: [], more: 0, unreviewed: [], moreUnreviewed: 0, unsupported: [], moreUnsupported: 0, moreLocked: 0, ...more })
const terms = (more = {}) => ({ required: 2, since: 'd'.repeat(40), canReview: true, toReview: 0, unreviewed: 0, unsupported: 0, ...more })
const wants = (name, more = {}) => ({ name, version: '1.0.0', source: 'registry', reviews: 0, ...more })
const entry = (managedId, more = {}) => ({ managedId, kind: 'stasis', repoId: 7, ...more })
let renders = 0
const render = () => { renders++ }
// The line as the Overview draws it once what it asks is read.
const shown = async bundle => {
  bundleDependencyReviewFact(bundle, render)
  for (let round = 0; round < 4; round++) await setImmediate()
  return templateText(bundleDependencyReviewFact(bundle, render))
}
// Its details' toggle, clicked.
const open = bundle => templates(bundleDependencyReviewFact(bundle, render)).flatMap(template => template.values).find(value => typeof value === 'function')()

test('nothing while first read, for a bundle of no repository, a sourcemap, a public link, or where no review is in effect', async () => {
  answers = { none: { review: null } }
  assert.equal(templateText(bundleDependencyReviewFact(entry('none'), render)), '', 'while read')
  assert.equal(await shown(entry('none')), '', 'none in effect')
  assert.ok(renders > 0, 'drawn again once read')
  const before = asked.length
  for (const other of [entry('loose', { repoId: null }), entry('map', { kind: 'sourcemap' }), { kind: 'stasis', repoId: 7 }]) assert.equal(await shown(other), '')
  state.managedSession = { id: 's', role: 'view', publicShare: true }
  assert.equal(await shown(entry('shared')), '')
  assert.equal(asked.length, before, 'none of them asked')
  state.managedSession = { id: 's', role: 'triage' }
})

test('a bundle whose versions pass says so, of how many it holds; one wanting reviews says how many, its details listing them with its terms', async () => {
  answers = {
    passes: { head, cut: false, versions: 12, unlocked: [], moreUnlocked: 0, review: terms(), lockfiles: [dir()] },
    wants: { head, cut: false, versions: 12, unlocked: [], moreUnlocked: 0, review: terms({ unreviewed: 3 }),
      lockfiles: [dir({ unreviewed: [wants('ms', { reviews: 1 }), wants('kept')], moreUnreviewed: 1 })] },
  }
  const passes = await shown(entry('passes'))
  assert.match(passes, /<dt>Dependency review<\/dt>/u)
  assert.match(passes, /bundle-review-state is-passed[^]*Passes[^]*12 npm versions, each reviewed or needing none/u)
  const before = asked.length
  await shown(entry('passes'))
  assert.equal(asked.length, before, 'kept')

  const wanting = await shown(entry('wants'))
  assert.match(wanting, /is-wanted">3 to review<\/span><span class="bundle-review-said">of 12 npm versions/u)
  assert.doesNotMatch(wanting, /team-deps-versions/u, 'its details closed')
  open(entry('wants'))
  const details = templateText(bundleDependencyReviewFact(entry('wants'), render))
  assert.match(details, /aria-expanded=true/u)
  assert.match(details, /Each version needs 2 full, accepting reviews by as many reviewers, of it whole or compared with any\s+version of its package; those the repository’s lockfiles locked at <code>ddddddd<\/code> need none/u)
  assert.match(details, /As <code>web\/yarn\.lock<\/code>, <code>package-lock\.json<\/code> lock them at <code>fffffff<\/code>, the nearest first/u)
  assert.match(details, /href=\/npm\/ms@1\.0\.0\/review[^]*1\/2[^]*href=\/npm\/kept@1\.0\.0\/review[^]*0\/2/u, 'each opening its review, with how many pass it')
  assert.match(details, /and 1 more, not listed/u)
})

test('a bundle fails where a version can\'t be reviewed, none of its lockfiles locks one, or one is unread; one that couldn\'t be checked says why', async () => {
  const gitdep = { name: 'mine', version: '1.0.0', source: 'git', from: 'git+ssh://github.com/org/mine.git', unsupported: 'git' }
  answers = {
    fails: { head, cut: false, versions: 9, unlocked: [{ name: 'absent', version: '2.0.0' }, { name: 7 }], moreUnlocked: 1, review: terms({ unreviewed: 1, unsupported: 1 }),
      lockfiles: [dir({ unreviewed: [wants('kept')], unsupported: [gitdep] }), { paths: ['web/bun.lock'], error: 'lockfile-unsupported' }] },
    broken: new Error('GitHub has none of the commit this bundle was built from, or of a lockfile it lists there.'),
  }
  const fails = await shown(entry('fails'))
  assert.match(fails, /is-failed">Fails<\/span><span class="bundle-review-said">1 can’t be reviewed, 2 not locked at its commit, 1 lockfile unread; 1 to review, of 9 npm versions/u)
  open(entry('fails'))
  const details = templateText(bundleDependencyReviewFact(entry('fails'), render))
  assert.match(details, /Unread, so what it locks isn’t checked: <code>web\/bun\.lock<\/code>/u)
  const rows = details.split('<li>').slice(1).map(row => row.match(/team-deps-name">([^<]+)/u)?.[1])
  assert.deepEqual(rows, ['mine', 'absent', 'kept'], 'those failing it first, those wanting reviews after')
  assert.match(details, /data-tooltip=absent@2\.0\.0[^]*can’t review/u)
  assert.doesNotMatch(details, /href=\/npm\/absent/u, 'one locked nowhere, by no source, opens nothing')
  assert.match(details, /and 1 more, not listed/u)
  assert.match(await shown(entry('broken')), /role="alert">Couldn’t check its dependencies: GitHub has none of the commit/u)
})

test('a bundle moved to another repository or directory is asked again at once', async () => {
  answers = { moved: { review: null } }
  await shown(entry('moved', { repoDirectory: 'web' }))
  const before = asked.length
  await shown(entry('moved', { repoDirectory: 'web' }))
  assert.equal(asked.length, before, 'kept where it is')
  await shown(entry('moved', { repoDirectory: 'api' }))
  await shown(entry('moved', { repoId: 8, repoDirectory: 'api' }))
  assert.deepEqual(asked.slice(before), ['moved', 'moved'])
})
