import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backfillBundleCommits, bundleCommits, cacheCommitDetails, parseGithubCommit } from '../server-managed/bundle-commits.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'

const sha = 'a'.repeat(40)
const listed = (extra = {}, commit = {}) => [{
  sha, author: { login: 'alice' }, files: [{ patch: 'never kept' }],
  commit: { message: 'Fix the parser\n\nLonger body', author: { name: ' Alice Example ', date: '2026-10-01T10:00:00Z' }, committer: { date: '2026-10-02T11:30:00Z' }, ...commit },
  ...extra,
}]
const details = { message: 'Fix the parser\n\nLonger body', authorName: 'Alice Example', authorLogin: 'alice',
  authoredAt: Date.parse('2026-10-01T10:00:00Z'), committedAt: Date.parse('2026-10-02T11:30:00Z') }

async function database(t) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  for (const repoId of [1, 2]) await db.selectRepo({ repoId, fullName: `org/repo${repoId}`, private: true, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: null }, Date.now())
  return db
}

test('commit details come only from the listed commit itself, validated and bounded', () => {
  assert.deepEqual(parseGithubCommit(sha, listed()), details)
  assert.deepEqual(parseGithubCommit(sha, listed({ author: { login: 'dependabot[bot]' } })).authorLogin, 'dependabot[bot]')
  for (const author of [null, { login: '-bad' }, { login: 'a/b' }, { login: 'x'.repeat(40) }, { login: 7 }]) {
    assert.equal(parseGithubCommit(sha, listed({ author })).authorLogin, null)
  }
  assert.deepEqual(parseGithubCommit(sha, listed({}, { author: null, committer: { date: 'not a date' } })),
    { message: details.message, authorName: null, authorLogin: 'alice', authoredAt: null, committedAt: null })
  for (const body of [null, {}, [], listed({ sha: 'b'.repeat(40) }), listed({}, { message: null }), [null]]) {
    assert.equal(parseGithubCommit(sha, body), null)
  }
  const long = parseGithubCommit(sha, listed({}, { message: `${'x'.repeat(65_535)}😀` })).message
  assert.equal(long.length, 65_535, 'truncation never splits a surrogate pair')
  assert.equal(parseGithubCommit(sha, listed({}, { author: { name: 'n'.repeat(300) } })).authorName.length, 256)
})

test('catalogs read the cached details and tags of each bundle summary commit in its stored repository', async t => {
  const db = await database(t)
  const other = 'b'.repeat(40)
  await db.setGithubCommits([{ key: `1:${sha}`, ...details, fetchedAt: 1 }])
  await db.refreshGithubTags(1, [{ name: 'v1.0.0', sha }], true, 1)
  await db.refreshGithubTags(2, [{ name: 'v2.0.0', sha: other }, { name: 'elsewhere', sha }], true, 1)
  const summaries = new Map([
    ['hash-a', { summary: { files: 1, codeFiles: 1, lines: 1, commit: sha } }],
    ['hash-b', { summary: { files: 1, codeFiles: 1, lines: 1, commit: other } }],
    ['hash-c', { summary: { files: 1, codeFiles: 1, lines: 1 } }],
    ['hash-d', { summary: { files: 1, codeFiles: 1, lines: 1, commit: 'not a commit' } }],
  ])
  const bundle = (integrity, repoId) => ({ integrity, repoId, repoFullName: repoId == null ? null : `org/repo${repoId}` })
  const read = [bundle('hash-a', 1), bundle('hash-a', 1), bundle('hash-b', 2), bundle('hash-b', 1), bundle('hash-a', null),
    bundle('hash-c', 1), bundle('hash-d', 1), bundle('hash-cold', 1)]
  const { commitInfo, missing } = await bundleCommits(db, read, summaries)
  assert.deepEqual(read.map(commitInfo), [
    { sha, github: 'org/repo1', tags: ['v1.0.0'], details }, { sha, github: 'org/repo1', tags: ['v1.0.0'], details },
    { sha: other, github: 'org/repo2', tags: ['v2.0.0'], details: null }, null, null, null, null, null,
  ])
  assert.deepEqual(missing, [{ repoId: 2, sha: other, key: `2:${other}` }, { repoId: 1, sha: other, key: `1:${other}` }],
    'only missing details are backfilled, never tags, once per repository and commit')
  assert.equal(commitInfo(bundle('hash-a', 2)), null, 'a bundle moved after the read gets nothing for its new repository')
  assert.equal(commitInfo({ ...bundle('hash-a', 1), repoFullName: null }), null)
  const reads = t.mock.method(db, 'listGithubCommits')
  const empty = await bundleCommits(db, [bundle('hash-c', 1)], summaries)
  assert.deepEqual([empty.commitInfo(bundle('hash-a', 1)), empty.missing], [null, []])
  assert.equal(reads.mock.callCount(), 0, 'catalogs without commits make no cache reads')
})

test('backfill reads at most four missing commits with the viewer access and retries failures for that viewer later', async t => {
  const db = await database(t)
  const missing = Array.from({ length: 6 }, (_, i) => {
    const commit = String(i).repeat(40)
    return { repoId: 1 + (i % 2), sha: commit, key: `${1 + (i % 2)}:${commit}` }
  })
  const reads = []
  const readers = []
  const reader = repoId => {
    readers.push(repoId)
    return Promise.resolve({ commitDetails: commit => {
      reads.push(commit)
      return Promise.resolve(commit === '2'.repeat(40) ? null : { ...details, message: `Commit ${commit[0]}` })
    } })
  }
  await backfillBundleCommits(db, 'viewer-a', missing, reader)
  assert.deepEqual(readers, [1, 2], 'one reader per repository')
  assert.deepEqual(reads, ['0', '2', '1', '3'].map(digit => digit.repeat(40)))
  assert.deepEqual((await db.listGithubCommits(missing.map(commit => commit.key))).map(commit => commit.message).toSorted(), ['Commit 0', 'Commit 1', 'Commit 3'])

  reads.length = 0
  await backfillBundleCommits(db, 'viewer-a', missing.slice(2), reader)
  assert.deepEqual(reads.toSorted(), ['4', '5'].map(digit => digit.repeat(40)), 'a failed read waits before the same viewer retries it; cached commits are not read')
  reads.length = 0
  await backfillBundleCommits(db, 'viewer-b', [missing[2]], reader)
  assert.deepEqual(reads, ['2'.repeat(40)], 'another viewer may read it sooner')

  let unavailable = 0
  await backfillBundleCommits(db, 'viewer-c', [{ repoId: 1, sha: '9'.repeat(40), key: `1:${'9'.repeat(40)}` }], () => { unavailable++; return Promise.reject(new Error('no access')) })
  await backfillBundleCommits(db, 'viewer-c', [{ repoId: 1, sha: '9'.repeat(40), key: `1:${'9'.repeat(40)}` }], () => { unavailable++; return Promise.resolve(null) })
  assert.equal(unavailable, 1, 'an unreadable repository is retried later too')
  await backfillBundleCommits(db, 'viewer-c', [], () => assert.fail('nothing to read'))
})

test('concurrent backfills never read the same commit twice', async t => {
  const db = await database(t)
  const commit = 'c'.repeat(40)
  const missing = [{ repoId: 1, sha: commit, key: `1:${commit}` }]
  let release
  const gate = new Promise(resolve => { release = resolve })
  let reads = 0
  const reader = () => Promise.resolve({ async commitDetails() { reads++; await gate; return details } })
  const first = backfillBundleCommits(db, 'viewer-a', missing, reader)
  await new Promise(resolve => { setImmediate(resolve) })
  await new Promise(resolve => { setImmediate(resolve) })
  await backfillBundleCommits(db, 'viewer-b', missing, reader)
  release()
  await first
  assert.equal(reads, 1)
  assert.equal((await db.listGithubCommits([`1:${commit}`])).length, 1)
})

test('caching a commit reads it once and is best effort', async t => {
  const db = await database(t)
  let reads = 0
  const reader = { commitDetails: () => { reads++; return Promise.resolve(details) } }
  assert.equal(await cacheCommitDetails(db, reader, 1, sha), true)
  assert.equal(await cacheCommitDetails(db, reader, 1, sha), true)
  assert.equal(reads, 1, 'cached commits are never read again')
  assert.equal(await cacheCommitDetails(db, { commitDetails: () => Promise.reject(new Error('rate limited')) }, 2, sha), false)
  assert.equal(await cacheCommitDetails(db, { commitDetails: () => Promise.resolve(null) }, 2, sha), false)
  assert.deepEqual(await db.listGithubCommits([`2:${sha}`]), [])
})
