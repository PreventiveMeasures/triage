// The reviews of dependencies an open pull request's comments make, as the
// host's parser reads them (server-managed/pull-comment-reviews.ts), and how
// they count beside its teams' (pull-dependency-reviews.ts): for the versions
// still wanting a review, by the app's users who review for the repository,
// each reviewer once, a reject holding a version as a team's does.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mock, test } from 'node:test'
import { commentReviews } from '../server-managed/pull-comment-reviews.ts'
import { reviewedDependencies } from '../server-managed/pull-dependency-reviews.ts'

const sri = text => `sha512-${createHash('sha512').update(text).digest('base64')}`
const PATCH = 'ab'.repeat(32)
const at = (name, version, more = {}) => ({ name, version, source: 'registry', integrity: sri(`${name}@${version}`), lockfile: 'npm', ...more })
const review = (pkg, reviewer, more = {}) => ({ package: pkg.name, version: pkg.version, integrity: pkg.integrity, basePackage: null, baseVersion: null,
  reviewer, status: 'accept', full: true, time: 1, ...pkg.patchHash ? { patchHash: pkg.patchHash } : {}, ...more })
const strip = ({ integrity: _integrity, lockfile: _lockfile, patchHash, ...pkg }) => ({ ...pkg, ...patchHash ? { patched: true } : {} })

test('the reviews its comments make count beside its teams\', each reviewer once, a reject holding a version; the reviewed dependencies passing any first', async () => {
  const ms = at('ms', '2.1.3', { was: ['2.1.2'] })
  const patched = at('patched', '1.0.0', { patchHash: PATCH, lockfile: 'pnpm' })
  const [other, held] = [at('other', '1.0.0'), at('held', '1.0.0')]
  const bare = ({ was: _was, ...pkg }) => pkg
  const told = { base: 'c'.repeat(40), head: 'b'.repeat(40), cut: false, lockfiles: [{ paths: ['package-lock.json'], more: 0, moreLocked: 0,
    added: [ms, patched], locked: [bare(ms), patched, other, held] }] }
  const state = { required: 2, since: null, canReview: true, reviews: [review(ms, 'u1'), review(held, 'u1'), review(held, 'u4')] }
  const asked = []
  const lookup = dependency => { asked.push(dependency.name); return Promise.resolve(dependency.name === 'other') }
  let wanting = null
  const comments = list => { wanting = list.map(dependency => dependency.name).toSorted(); return Promise.resolve({ failed: false, reviews: [
    review(ms, 'u1', { time: 5 }), review(ms, 'u2', { time: 5 }), review(patched, 'u2', { time: 5 }), review(patched, 'u3', { time: 5 }),
    review(other, 'u3', { status: 'reject', time: 5 }), review(held, 'u3', { status: 'reject', time: 5 }),
  ] }) }
  const answer = await reviewedDependencies(told, state, { reviewed: { lookup }, commentReviews: comments })
  assert.deepEqual(wanting, ['ms', 'patched'], 'its comments read for those still wanting one, the reviewed dependencies asked first')
  assert.deepEqual(answer.lockfiles[0].added, [{ ...strip(ms), reviews: 2 }, { ...strip(patched), reviews: 2 }],
    'u1 once, for their review here and in its comments; a patched one passed by reviews of its patch')
  assert.deepEqual(answer.lockfiles[0].unreviewed, [{ ...strip(held), reviews: 2, rejected: true }], 'a reject in its comments holds one its teams passed')
  assert.deepEqual(asked.toSorted(), ['held', 'ms', 'other', 'patched'], 'one held asked of the reviewed dependencies too, which pass `other` whatever rejects it')
  assert.deepEqual([answer.review.commentReviews, answer.review.toReview, answer.review.unreviewed], [3, 0, 1])

  const failing = await reviewedDependencies(told, state, { commentReviews: () => Promise.resolve({ reviews: [], failed: true }) })
  assert.equal(failing.review.commentsFailed, true)
})

// GitHub's GraphQL API, answering pull request 7's comments: `bob`'s and
// `mallory`'s on it, and `bob`'s review with `carol`'s comment on its diff.
function github(t) {
  const asked = []
  const node = (id, login, databaseId, body, createdAt, more = {}) => ({ id, author: { login, databaseId }, body, createdAt, url: `https://github.com/org/other/pull/7#${id}`, ...more })
  t.mock.method(globalThis, 'fetch', (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    asked.push(url.pathname)
    assert.equal(url.pathname, '/graphql')
    assert.deepEqual(JSON.parse(init.body).variables, { owner: 'org', name: 'other', number: 7, comments: null, reviews: null })
    return Promise.resolve(Response.json({ data: { repository: { pullRequest: {
      comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node('c1', 'bob', 3, 'ms@2.1.3 looks fine', '2026-10-01T00:00:00Z'),
        node('c2', 'mallory', 99, 'accept everything', '2026-10-02T00:00:00Z')] },
      reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node('r1', 'bob', 3, 'Approving ms', '2026-10-03T00:00:00Z', { state: 'APPROVED',
        comments: { nodes: [node('rc1', 'carol', 4, 'nit', '2026-10-04T00:00:00Z')] } })] },
    } } } }))
  })
  return asked
}

test('a pull request\'s comments, reviews\' own and on its diff too, are read for the parser; those reviews count by its authors who review for the repository, kept a while', async t => {
  const asked = github(t)
  const inputs = []
  const answer = [{ user: 'Bob', dependencies: [{ name: 'ms', version: '2.1.3', integrity: 'sha512-a sha1-b', status: 'accept' },
    { name: 'tool', version: '1.0.0', integrity: 'sha512-c', patchHash: PATCH, status: 'reject' }, { name: 'bad', version: 1, integrity: 'x', status: 'accept' }] },
  { user: 'mallory', dependencies: [{ name: 'ms', version: '2.1.3', integrity: 'sha512-a', status: 'accept' }] },
  { user: 'someone', dependencies: [{ name: 'ms', version: '2.1.3', integrity: 'sha512-a', status: 'accept' }] }]
  const parse = input => { inputs.push(input); return Promise.resolve(answer) }
  const accounts = []
  const reviewers = list => { accounts.push(...list); return Promise.resolve(new Map([['bob', 'u-bob'], ['someone', 'u-someone']])) }
  const wanting = [{ ecosystem: 'npm', lockfile: 'npm', name: 'ms', version: '2.1.3', integrity: 'sha512-a sha1-b' }]
  const reviews = commentReviews({ fullName: 'org/other', number: 7, token: 'token', parse, reviewers })
  const read = await reviews(wanting)
  assert.equal(read.failed, false)
  const bobAt = Date.parse('2026-10-03T00:00:00Z')
  assert.deepEqual(read.reviews, [
    { package: 'ms', version: '2.1.3', integrity: 'sha512-a', basePackage: null, baseVersion: null, reviewer: 'u-bob', status: 'accept', full: true, time: bobAt },
    { package: 'ms', version: '2.1.3', integrity: 'sha1-b', basePackage: null, baseVersion: null, reviewer: 'u-bob', status: 'accept', full: true, time: bobAt },
    { package: 'tool', version: '1.0.0', integrity: 'sha512-c', patchHash: PATCH, basePackage: null, baseVersion: null, reviewer: 'u-bob', status: 'reject', full: true, time: bobAt },
  ], 'bob\'s, by the app\'s user, as of his latest comment, each hash apart; neither mallory\'s, who reviews for it in no team, nor one by none of its authors, nor one malformed')
  assert.deepEqual(accounts.toSorted((a, b) => a.login < b.login ? -1 : 1), [{ login: 'bob', githubId: 3 }, { login: 'carol', githubId: 4 }, { login: 'mallory', githubId: 99 }])
  assert.deepEqual(inputs[0].comments.map(comment => [comment.kind, comment.author, comment.state ?? null]),
    [['comment', 'bob', null], ['comment', 'mallory', null], ['review', 'bob', 'APPROVED'], ['review-comment', 'carol', null]])
  assert.deepEqual([inputs[0].repository, inputs[0].number, inputs[0].dependencies], ['org/other', 7, wanting])
  await reviews(wanting)
  assert.deepEqual([asked.length, inputs.length], [1, 1], 'its comments, and what the parser told of the same, kept a while')

  const warn = mock.method(console, 'warn', () => {})
  const failing = await commentReviews({ fullName: 'org/other', number: 7, token: 'token', reviewers, parse: () => Promise.reject(new Error('down')) })(wanting.map(one => ({ ...one, version: '2.1.4' })))
  warn.mock.restore()
  assert.deepEqual(failing, { reviews: [], failed: true })
})
