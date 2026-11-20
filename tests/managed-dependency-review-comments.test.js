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
import { askedOf } from '../server-managed/pull-dependency-reviews.ts'

const sri = text => `sha512-${createHash('sha512').update(text).digest('base64')}`
const sha1 = text => createHash('sha1').update(text).digest('hex')
const review = (id, more = {}) => ({ id, user: 'me', userLogin: 'grace', ecosystem: 'npm', package: 'ms', version: '2.1.3', integrity: sri('ms@2.1.3'),
  basePackage: 'ms', baseVersion: '2.1.2', baseIntegrity: sri('ms@2.1.2'), shasum: sha1('ms@2.1.3'), baseShasum: sha1('ms@2.1.2'), time: 1, revision: 1, publishedAt: 100, revokedAt: null, teams: [], files: ['index.js'],
  nonTextFiles: [], coverage: 'full', checkedFiles: 1, totalFiles: 1, verdictLimit: 'accept', status: 'accept-with-nits', comment: 'Fine.',
  entries: [{ id: 'e1', file: 'index.js', status: 'accept-with-nits', comment: 'Rename it.', time: 1 }, { id: 'e2', file: 'old.js', status: null, comment: '', time: 1 }], ...more })

test('each of one\'s own published reviews is formatted alone, as the host formats it; another\'s, a draft and a revoked one never asked of', async () => {
  const given = []
  const reviewed = { lookup: () => Promise.resolve(false), formatDependencyReviews: input => { given.push(input); return Promise.resolve(`Reviewed ${input.reviews[0].new.name}`) } }
  const reviews = [review('mine'), review('theirs', { user: 'them' }), review('draft', { publishedAt: null, status: null }), review('revoked', { revokedAt: 200 })]
  const formatted = await withFormatted(reviewed, 'me', reviews)
  assert.deepEqual(formatted.map(one => [one.id, one.formatted ?? null]), [['mine', 'Reviewed ms'], ['theirs', null], ['draft', null], ['revoked', null]])
  assert.deepEqual(given, [{ reviews: [{ ecosystem: 'npm', old: { name: 'ms', version: '2.1.2', integrity: sri('ms@2.1.2'), shasum: sha1('ms@2.1.2') },
    new: { name: 'ms', version: '2.1.3', integrity: sri('ms@2.1.3'), shasum: sha1('ms@2.1.3') }, status: 'accept-with-nits', coverage: 'full', comment: 'Fine.',
    files: [{ path: 'index.js', status: 'accept-with-nits', comment: 'Rename it.' }], reviewer: 'grace', publishedAt: 100 }] }],
  'its versions, with the integrity and shasum of each tarball reviewed, verdict, coverage and each file\'s, as given; a file neither checked nor commented on left out')
  assert.equal((await withFormatted(reviewed, 'me', [review('whole', { basePackage: null, baseVersion: null, baseIntegrity: null, baseShasum: null, coverage: 'partial' })]))[0].formatted, 'Reviewed ms')
  assert.deepEqual([given.at(-1).reviews[0].old, given.at(-1).reviews[0].coverage], [null, 'partial'])
  await withFormatted(reviewed, 'me', [review('unknown', { shasum: null, baseShasum: null })])
  assert.deepEqual([given.at(-1).reviews[0].old, given.at(-1).reviews[0].new], [{ name: 'ms', version: '2.1.2', integrity: sri('ms@2.1.2') },
    { name: 'ms', version: '2.1.3', integrity: sri('ms@2.1.3') }], 'no shasum where the review kept none')
  await withFormatted(reviewed, 'me', [review('patched', { patchHash: 'patch' })])
  assert.equal(given.at(-1).reviews[0].new.patchHash, 'patch', 'a patched version\'s review with its patch')

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
    published('other-base', { baseVersion: '1.0.0' }), published('unpatched', { patchHash: undefined }), published('commented', { id: undefined, comment: true }),
    published('forked', { basePackage: 'ms-fork', baseVersion: '9.0.0' })] }
  const asked = []
  // A store answering another's too, which the formatter is never given.
  const db = { listOwnDependencyReviewsById: (user, ids) => { asked.push([user, ids]); return Promise.resolve([review('mine', { patchHash: 'patch' }), review('sneaky', { user: 'them' })]) } }
  const given = []
  const reviewed = { lookup: () => Promise.resolve(false), formatDependencyReviews: input => { given.push(input); return Promise.resolve('Reviewed in #5') } }
  const pullRequest = { repository: 'org/a', number: 5 }
  assert.equal(await formattedPull(reviewed, db, 'me', told, state, pullRequest), 'Reviewed in #5')
  assert.deepEqual(asked, [['me', ['mine', 'forked']]], 'those of its versions, of their integrity, patch and a base they were or another package\'s, alone')
  assert.deepEqual([given[0].pullRequest, given[0].reviews.map(one => [one.new.name, one.new.shasum, one.old.shasum, one.new.patchHash])],
    [pullRequest, [['ms', sha1('ms@2.1.3'), sha1('ms@2.1.2'), 'patch']]], 'the shasums the review kept of the tarballs it read, not the lockfile\'s, and the patch it is of')
  assert.equal(await formattedPull(reviewed, db, 'me', told, null, pullRequest), null, 'none where its review is not in effect')
  assert.equal(await formattedPull({ lookup: reviewed.lookup }, db, 'me', told, state, pullRequest), null, 'nor where none is registered')
  assert.equal(await formattedPull(reviewed, db, 'nobody', told, state, pullRequest), null, 'nor for one with no review of its versions')
  assert.equal(asked.length, 1, 'the store asked of none of them')
  // One compared with the version the host names its base, as its review was told it, too.
  await formattedPull(reviewed, db, 'me', told, state, pullRequest, [], new Map([[askedOf(pkg)[0], { name: 'ms', version: '1.0.0' }]]))
  assert.deepEqual(asked.at(-1), ['me', ['mine', 'other-base', 'forked']])
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


test('a pull request\'s leaves out one\'s reviews of the versions the host\'s lookup passes already, whatever its comments review; nothing to copy where it passes them all', async () => {
  const pkgs = ['kept', 'vouched', 'unanswered'].map(name => ({ name, version: '1.0.0', source: 'registry', integrity: sri(name), lockfile: 'npm' }))
  // The same version locked another way too, which the host doesn't pass.
  const twice = { name: 'vouched-once', version: '1.0.0', source: 'registry', integrity: sri('vouched-once'), lockfile: 'npm' }
  const told = { base: 'c'.repeat(40), head: 'b'.repeat(40), cut: false, lockfiles: [{ paths: ['package-lock.json'], more: 0, moreLocked: 0, added: [...pkgs, twice], locked: [...pkgs, twice] },
    { paths: ['web/yarn.lock'], more: 0, moreLocked: 0, added: [{ ...twice, lockfile: 'yarn1' }], locked: [{ ...twice, lockfile: 'yarn1' }] }] }
  const state = { required: 1, since: null, canReview: true, lockfiles: { mode: 'exclude', paths: [] }, reviews: [...pkgs, twice].map(pkg => ({ id: pkg.name, package: pkg.name,
    version: '1.0.0', integrity: pkg.integrity, basePackage: null, baseVersion: null, reviewer: 'me', status: 'accept', full: true, time: 1 })) }
  const db = { listOwnDependencyReviewsById: (user, ids) => Promise.resolve(ids.map(id => review(id, { package: id, basePackage: null, baseVersion: null, baseIntegrity: null }))) }
  const looked = []
  const lookup = dependency => {
    looked.push(`${dependency.name}:${dependency.lockfile}`)
    if (dependency.name === 'unanswered') return Promise.reject(new Error('down'))
    return Promise.resolve(dependency.name === 'vouched' || (dependency.name === 'vouched-once' && dependency.lockfile === 'npm'))
  }
  let given = null
  const reviewed = { lookup, formatDependencyReviews: input => { given = input; return Promise.resolve(`${input.reviews.length} reviewed`) } }
  assert.equal(await formattedPull(reviewed, db, 'me', told, state, { repository: 'org/a', number: 5 }), '3 reviewed')
  assert.deepEqual(given.reviews.map(one => one.new.name).toSorted(), ['kept', 'unanswered', 'vouched-once'],
    'one it passes left out; one it fails to answer of, and one it passes as one lockfile locks it but not another, kept')
  assert.deepEqual(looked.toSorted(), ['kept:npm', 'unanswered:npm', 'vouched-once:npm', 'vouched-once:yarn1', 'vouched:npm'], 'asked of each version reviewed, as locked, once')

  let formatted = 0
  const all = { lookup: () => Promise.resolve(true), formatDependencyReviews: () => { formatted++; return Promise.resolve('Reviewed') } }
  assert.equal(await formattedPull(all, db, 'me', told, state, { repository: 'org/a', number: 5 }), null)
  assert.equal(formatted, 0, 'the host asked to format none')
})

test('a pull request\'s leaves out one\'s reviews its own comments there make already, with the same verdict; another\'s comments, or one\'s of another verdict, leave it in', async () => {
  const pkgs = ['posted', 'theirs', 'changed', 'unposted', 'superseded'].map(name => ({ name, version: '1.0.0', source: 'registry', integrity: sri(name), lockfile: 'npm' }))
  const told = { base: 'c'.repeat(40), head: 'b'.repeat(40), cut: false, lockfiles: [{ paths: ['package-lock.json'], more: 0, moreLocked: 0, added: pkgs, locked: pkgs }] }
  const published = (pkg, more = {}) => ({ package: pkg.name, version: '1.0.0', integrity: pkg.integrity, basePackage: null, baseVersion: null, reviewer: 'me', login: 'grace', status: 'accept',
    full: true, time: 1, ...more })
  const state = { required: 2, since: null, canReview: true, lockfiles: { mode: 'exclude', paths: [] }, reviews: pkgs.map(pkg => published(pkg, { id: pkg.name })) }
  // The reviews its comments make: one's own of the first, another's of the second, one's own of the third with another verdict;
  // and of the last one's own acceptance, then their later rejection, which is where they stand there.
  const commented = [published(pkgs[0], { comment: true }), published(pkgs[1], { comment: true, reviewer: 'them' }), published(pkgs[2], { comment: true, status: 'accept-with-nits' }),
    published(pkgs[4], { comment: true, time: 5 }), published(pkgs[4], { comment: true, status: 'reject', time: 9 })]
  const db = { listOwnDependencyReviewsById: (user, ids) => Promise.resolve(ids.map(id => review(id, { package: id, basePackage: null, baseVersion: null, baseIntegrity: null, status: 'accept' }))) }
  let given = null
  const reviewed = { lookup: () => Promise.resolve(false), formatDependencyReviews: input => { given = input; return Promise.resolve(`${input.reviews.length} reviewed`) } }
  const pullRequest = { repository: 'org/a', number: 5 }
  assert.equal(await formattedPull(reviewed, db, 'me', told, state, pullRequest, commented), '4 reviewed')
  assert.deepEqual(given.reviews.map(one => one.new.name), ['theirs', 'changed', 'unposted', 'superseded'], 'one their latest comment there rejects kept, though an older one accepted it')
  assert.equal(await formattedPull(reviewed, db, 'me', told, state, pullRequest), '5 reviewed', 'all of them where its comments make none')
  assert.equal(await formattedPull(reviewed, db, 'me', told, state, pullRequest, pkgs.map(pkg => published(pkg, { comment: true }))), null, 'nothing to copy once its comments make them all')
})

test('a pull request\'s gives one\'s review compared with a version it doesn\'t replace only where the host reads comments, what it was compared with then the host\'s to weigh', async () => {
  const pkg = { name: 'fresh', version: '1.0.0', source: 'registry', integrity: sri('fresh'), lockfile: 'npm' }
  const told = { base: 'c'.repeat(40), head: 'b'.repeat(40), cut: false, lockfiles: [{ paths: ['package-lock.json'], more: 0, moreLocked: 0, added: [pkg], locked: [pkg] }] }
  // Of a package new to its lockfiles, compared with an older version of it.
  const state = { required: 1, since: null, canReview: true, lockfiles: { mode: 'exclude', paths: [] }, reviews: [{ id: 'against', package: 'fresh', version: '1.0.0', integrity: pkg.integrity,
    basePackage: 'fresh', baseVersion: '0.9.0', reviewer: 'me', login: 'grace', status: 'accept', full: true, time: 1 }] }
  const db = { listOwnDependencyReviewsById: (user, ids) => Promise.resolve(ids.map(id => review(id, { package: 'fresh', version: '1.0.0', baseVersion: '0.9.0' }))) }
  const hooks = more => ({ lookup: () => Promise.resolve(false), formatDependencyReviews: input => Promise.resolve(`${input.reviews.length} reviewed`), ...more })
  const pullRequest = { repository: 'org/a', number: 5 }
  assert.equal(await formattedPull(hooks(), db, 'me', told, state, pullRequest), null, 'not where reviews published here count, as it counts for nothing there')
  assert.equal(await formattedPull(hooks({ parseComments: () => Promise.resolve([]) }), db, 'me', told, state, pullRequest), '1 reviewed')
})
