// The comment a host formats of one's own dependency reviews, for a copy
// button to give (server-managed/dependency-review-comments.ts,
// reviewed-dependencies.ts formatDependencyReviews): of a review, or of
// those of the versions a pull request adds; given one's own published
// reviews alone, never another's, a draft or a revoked one, however asked;
// none told where it formats none, or fails.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { formattedPull, withFormatted } from '../server-managed/dependency-review-comments.ts'

const sri = text => `sha512-${createHash('sha512').update(text).digest('base64')}`
const review = (id, more = {}) => ({ id, user: 'me', userLogin: 'grace', ecosystem: 'npm', package: 'ms', version: '2.1.3', integrity: sri('ms@2.1.3'),
  basePackage: 'ms', baseVersion: '2.1.2', baseIntegrity: sri('ms@2.1.2'), time: 1, revision: 1, publishedAt: 100, revokedAt: null, teams: [], files: ['index.js'],
  nonTextFiles: [], coverage: 'full', checkedFiles: 1, totalFiles: 1, verdictLimit: 'accept', status: 'accept-with-nits', comment: 'Fine.',
  entries: [{ id: 'e1', file: 'index.js', status: 'accept-with-nits', comment: 'Rename it.', time: 1 }, { id: 'e2', file: 'old.js', status: null, comment: '', time: 1 }], ...more })

test('each of one\'s own published reviews is formatted alone, as the host formats it; another\'s, a draft and a revoked one never asked of', async () => {
  const given = []
  const reviewed = { lookup: () => Promise.resolve(false), formatDependencyReviews: input => { given.push(input); return Promise.resolve(`Reviewed ${input.reviews[0].new.name}`) } }
  const reviews = [review('mine'), review('theirs', { user: 'them' }), review('draft', { publishedAt: null, status: null }), review('revoked', { revokedAt: 200 })]
  const formatted = await withFormatted(reviewed, 'me', reviews)
  assert.deepEqual(formatted.map(one => [one.id, one.formatted ?? null]), [['mine', 'Reviewed ms'], ['theirs', null], ['draft', null], ['revoked', null]])
  assert.deepEqual(given, [{ reviews: [{ ecosystem: 'npm', old: { name: 'ms', version: '2.1.2', integrity: sri('ms@2.1.2') },
    new: { name: 'ms', version: '2.1.3', integrity: sri('ms@2.1.3') }, status: 'accept-with-nits', coverage: 'full', comment: 'Fine.',
    files: [{ path: 'index.js', status: 'accept-with-nits', comment: 'Rename it.' }], reviewer: 'grace', publishedAt: 100 }] }],
  'its versions, verdict, coverage and each file\'s, as given; a file neither checked nor commented on left out')
  assert.equal((await withFormatted(reviewed, 'me', [review('whole', { basePackage: null, baseVersion: null, baseIntegrity: null, coverage: 'partial' })]))[0].formatted, 'Reviewed ms')
  assert.deepEqual([given.at(-1).reviews[0].old, given.at(-1).reviews[0].coverage], [null, 'partial'])

  for (const answer of [() => Promise.resolve(''), () => Promise.resolve('  '), () => Promise.resolve(null), () => Promise.resolve(undefined), () => Promise.resolve(3),
    () => Promise.reject(new Error('down'))]) {
    const [one] = await withFormatted({ lookup: reviewed.lookup, formatDependencyReviews: answer }, 'me', [review('mine')])
    assert.equal(Object.hasOwn(one, 'formatted'), false)
  }
  assert.equal((await withFormatted({ lookup: reviewed.lookup }, 'me', reviews)), reviews, 'none registered, none formatted')
})

test('a pull request\'s, of one\'s own published reviews of the versions it adds, as its lockfile locks them, never another\'s however the store answers', async () => {
  const pkg = { name: 'ms', version: '2.1.3', source: 'registry', integrity: sri('ms@2.1.3'), shasum: 'abc', patchHash: 'patch', lockfile: 'pnpm', was: ['2.1.2'] }
  const told = { base: 'c'.repeat(40), head: 'b'.repeat(40), cut: false, lockfiles: [{ paths: ['pnpm-lock.yaml'], more: 0, moreLocked: 0, added: [pkg], locked: [pkg] },
    { paths: ['web/yarn.lock'], error: 'lockfile-unreadable' }] }
  const published = (id, more = {}) => ({ id, package: 'ms', version: '2.1.3', integrity: sri('ms@2.1.3'), patchHash: 'patch', basePackage: 'ms', baseVersion: '2.1.2',
    reviewer: 'me', status: 'accept', full: true, time: 1, ...more })
  const state = { required: 1, since: null, canReview: true, lockfiles: { mode: 'exclude', paths: [] }, reviews: [published('mine'), published('theirs', { reviewer: 'them' }),
    published('other-base', { baseVersion: '1.0.0' }), published('unpatched', { patchHash: undefined }), published('commented', { id: undefined, comment: true })] }
  const asked = []
  // A store answering another's too, which the formatter is never given.
  const db = { listOwnDependencyReviewsById: (user, ids) => { asked.push([user, ids]); return Promise.resolve([review('mine'), review('sneaky', { user: 'them' })]) } }
  const given = []
  const reviewed = { lookup: () => Promise.resolve(false), formatDependencyReviews: input => { given.push(input); return Promise.resolve('Reviewed in #5') } }
  const pullRequest = { repository: 'org/a', number: 5 }
  assert.equal(await formattedPull(reviewed, db, 'me', told, state, pullRequest), 'Reviewed in #5')
  assert.deepEqual(asked, [['me', ['mine']]], 'those of its versions, of their integrity, patch and a base they were, alone')
  assert.deepEqual([given[0].pullRequest, given[0].reviews.map(one => [one.new.name, one.new.shasum, one.new.patchHash])], [pullRequest, [['ms', 'abc', 'patch']]])
  assert.equal(await formattedPull(reviewed, db, 'me', told, null, pullRequest), null, 'none where its review is not in effect')
  assert.equal(await formattedPull({ lookup: reviewed.lookup }, db, 'me', told, state, pullRequest), null, 'nor where none is registered')
  assert.equal(await formattedPull(reviewed, db, 'nobody', told, state, pullRequest), null, 'nor for one with no review of its versions')
  assert.equal(asked.length, 1, 'the store asked of none of them')
})

test('a pull request\'s reviews are read a page at a time, every one formatted, however many', async () => {
  const pkgs = Array.from({ length: 250 }, (_, at) => ({ name: `lib-${at}`, version: '1.0.0', source: 'registry', integrity: sri(`lib-${at}`), lockfile: 'npm' }))
  const told = { base: 'c'.repeat(40), head: 'b'.repeat(40), cut: false, lockfiles: [{ paths: ['package-lock.json'], more: 0, moreLocked: 0, added: pkgs, locked: pkgs }] }
  const state = { required: 1, since: null, canReview: true, lockfiles: { mode: 'exclude', paths: [] }, reviews: pkgs.map((pkg, at) => ({ id: `r${at}`, package: pkg.name,
    version: '1.0.0', integrity: pkg.integrity, basePackage: null, baseVersion: null, reviewer: 'me', status: 'accept', full: true, time: 1 })) }
  const pages = []
  const db = { listOwnDependencyReviewsById: (user, ids) => {
    pages.push(ids.length)
    return Promise.resolve(ids.map(id => review(id, { package: `lib-${id.slice(1)}`, basePackage: null, baseVersion: null, baseIntegrity: null })))
  } }
  let given = null
  const reviewed = { lookup: () => Promise.resolve(false), formatDependencyReviews: input => { given = input; return Promise.resolve(`${input.reviews.length} reviewed`) } }
  assert.equal(await formattedPull(reviewed, db, 'me', told, state, { repository: 'org/a', number: 5 }), '250 reviewed')
  assert.deepEqual([pages, given.reviews.length], [[200, 50], 250])
})

