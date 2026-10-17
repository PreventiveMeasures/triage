// The lockfiles a repository's dependency review holds to
// (server-managed/lockfile-scope.ts): every one but those named, or those
// alone, each by its path or a directory's ending in `/`; and a pull
// request's directories none of whose lockfiles it holds to, told unasked,
// failing it in nothing (pull-dependency-reviews.ts), as its popup tells them
// (ui/view/pull-dependencies.js).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { EVERY_LOCKFILE, heldTo, reviewedIn, scopeOf, scopeText, storedScope } from '../server-managed/lockfile-scope.ts'
import { reviewedDependencies } from '../server-managed/pull-dependency-reviews.ts'
import { checked, reviewFailures } from '../ui/view/pull-dependencies.js'

test('a scope names lockfiles by their paths, or a directory\'s ending in /, each once in order, none outside the repository; stored as JSON, every one as none', () => {
  assert.deepEqual(scopeOf({ mode: 'include', paths: ['web/', 'package-lock.json', 'web/'] }), { mode: 'include', paths: ['package-lock.json', 'web/'] })
  for (const bad of [null, {}, { mode: 'exclude' }, { mode: 'all', paths: [] }, { mode: 'exclude', paths: [''] }, { mode: 'exclude', paths: ['/abs'] },
    { mode: 'exclude', paths: ['a/./b'] }, { mode: 'exclude', paths: ['a/../b'] }, { mode: 'exclude', paths: ['..'] }, { mode: 'exclude', paths: ['a\\b'] },
    { mode: 'exclude', paths: ['a\nb'] }, { mode: 'exclude', paths: [1] }, { mode: 'exclude', paths: ['x'.repeat(301)] }]) {
    assert.equal(scopeOf(bad), null, JSON.stringify(bad))
  }
  assert.equal(scopeText(EVERY_LOCKFILE), null)
  assert.deepEqual(storedScope(scopeText({ mode: 'exclude', paths: ['docs/'] })), { mode: 'exclude', paths: ['docs/'] })
  assert.deepEqual([storedScope(null), storedScope('{'), storedScope('{"mode":"x"}')], [EVERY_LOCKFILE, EVERY_LOCKFILE, EVERY_LOCKFILE], 'one unreadable, every lockfile')

  const out = { mode: 'exclude', paths: ['docs/', 'examples/app/yarn.lock'] }
  assert.deepEqual(['package-lock.json', 'docs/package-lock.json', 'docs/a/b/yarn.lock', 'examples/app/yarn.lock', 'examples/app/package-lock.json', 'docsite/yarn.lock']
    .map(path => heldTo(out, path)), [true, false, false, false, true, true], 'a directory names what is under it, not one that starts alike')
  const only = { mode: 'include', paths: ['web/'] }
  assert.deepEqual([heldTo(only, 'web/package-lock.json'), heldTo(only, 'package-lock.json')], [true, false])
  assert.deepEqual([reviewedIn(only, ['package-lock.json', 'web/pnpm-lock.yaml']), reviewedIn(only, ['package-lock.json']), reviewedIn(only, [])], [true, false, true],
    'a directory with one it holds to is reviewed whole')
})

const sri = text => `sha512-${createHash('sha512').update(text).digest('base64')}`
const at = (name, version) => ({ name, version, source: 'registry', integrity: sri(`${name}@${version}`), lockfile: 'npm' })

test('a pull request\'s directories none of whose lockfiles its review holds to are told unasked, neither asked of the reviewed dependencies nor failing it, its terms telling which', async () => {
  const [ms, docs, gitdep] = [at('ms', '2.1.3'), at('docs-tool', '1.0.0'), { name: 'mine', version: '1.0.0', source: 'git', from: 'git+ssh://github.com/org/mine.git' }]
  const told = { base: 'c'.repeat(40), head: 'b'.repeat(40), cut: false, lockfiles: [
    { paths: ['package-lock.json'], more: 0, moreLocked: 0, added: [ms], locked: [ms] },
    { paths: ['docs/package-lock.json'], more: 0, moreLocked: 0, added: [docs, gitdep], locked: [docs, gitdep] },
    { paths: ['docs/old/yarn.lock'], error: 'lockfile-unreadable' },
  ] }
  const lockfiles = { mode: 'exclude', paths: ['docs/'] }
  const asked = []
  const lookup = dependency => { asked.push(dependency.name); return Promise.resolve(false) }
  const answer = await reviewedDependencies(told, { required: 1, since: null, canReview: true, lockfiles, reviews: [] },
    { reviewed: { lookup }, baselineUnread: ['docs/yarn.lock', 'yarn.lock'] })
  assert.deepEqual(asked, ['ms'], 'those left out not asked')
  assert.deepEqual(answer.lockfiles.map(dir => [dir.paths[0], dir.excluded ?? false]), [['package-lock.json', false], ['docs/package-lock.json', true], ['docs/old/yarn.lock', true]])
  assert.deepEqual(answer.lockfiles[1].added.map(pkg => Object.keys(pkg).toSorted().join()), ['name,source,version', 'from,name,source,version'], 'told without a review')
  assert.deepEqual([answer.review.toReview, answer.review.unsupported, answer.review.lockfiles], [1, 0, lockfiles], 'one from git there failing nothing')
  assert.equal(answer.review.baselineUnread, undefined, 'registered reviewed dependencies replace the commit reviewed since')
  const baseline = await reviewedDependencies(told, { required: 1, since: 'd'.repeat(40), canReview: true, lockfiles, reviews: [] }, { baselineUnread: ['docs/yarn.lock', 'yarn.lock'] })
  assert.deepEqual(baseline.review.baselineUnread, ['yarn.lock'], 'one left out unread at the commit reviewed since told of none')

  const read = checked(JSON.parse(JSON.stringify(answer)))
  assert.deepEqual([read.lockfiles.map(dir => dir.excluded), read.review.lockfiles], [[false, true, true], lockfiles])
  assert.equal(reviewFailures(read), null, 'its unread lockfile left out fails nothing')
  assert.equal((await reviewedDependencies(told, { required: 1, since: null, canReview: true, reviews: [] })).review.lockfiles, undefined, 'every one, told of none')
})
