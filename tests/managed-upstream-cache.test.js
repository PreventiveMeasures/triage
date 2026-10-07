import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { fetchBundleAdvisories } from '../server-managed/bundle-advisories.ts'
import { upstreamCache } from '../server-managed/upstream-cache.ts'
import { checkUpstreamCacheStore } from './_managed-upstream-cache.js'

const signal = () => new AbortController().signal
const listing = 'https://api.github.com/repos/org/dep/security-advisories?state=published&per_page=100'
const packages = [{ ecosystem: 'github', name: 'org/dep', versions: ['1.0.0'] }]
const advisory = { ghsa_id: 'GHSA-2345-6789-cfgh', state: 'published', summary: 'Repository vulnerability', description: '# Details',
  author: { login: 'maintainer' }, vulnerabilities: [{ package: { ecosystem: 'npm', name: 'dep' }, vulnerable_version_range: '<2.0.0' }] }

function stubGithub(t, answer = () => Response.json([advisory])) {
  const calls = []
  t.mock.method(globalThis, 'fetch', url => {
    calls.push(url)
    assert.equal(url, listing)
    return Promise.resolve(answer())
  })
  return calls
}

test('SQLite adds the upstream cache to existing databases and retains it across restarts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'triage-upstream-cache-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'managed.db')
  await openSqliteManagedDb(path).close()
  const legacy = new DatabaseSync(path)
  legacy.exec('DROP TABLE managed_upstream_cache')
  legacy.close()
  const db = openSqliteManagedDb(path)
  const { key, value } = await checkUpstreamCacheStore(db)
  await db.close()
  const reopened = openSqliteManagedDb(path)
  try { assert.equal(await reopened.getUpstreamCacheEntry(key), value) }
  finally { await reopened.close() }
})

test('repository listings are shared across audits, viewers and details through the database', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const calls = stubGithub(t)
  const first = await fetchBundleAdvisories(packages, signal(), { githubToken: 'viewer-token', details: true, cache: upstreamCache(db, signal()) })
  assert.equal(first.status, 200)
  assert.equal(first.body[0].details, '# Details')
  const anonymous = await fetchBundleAdvisories(packages, signal(), { cache: upstreamCache(db, signal()) })
  assert.deepEqual(anonymous, { status: 200, body: first.body.map(({ details: _details, ...row }) => row) })
  assert.deepEqual(await fetchBundleAdvisories(packages, signal(), { details: true, cache: upstreamCache(db, signal()) }), first)
  assert.equal(calls.length, 1, 'GitHub is asked once')
  const stored = JSON.parse(await db.getUpstreamCacheEntry('github/advisories/org/dep'))
  assert.equal(stored.name, 'org/dep')
  assert.deepEqual(stored.advisories.map(entry => entry.ghsa), ['GHSA-2345-6789-cfgh'])
  assert.ok(!JSON.stringify(stored).includes('maintainer'), 'only what upstream builds rows from is stored')
  // Without the store, or with a listing older than upstream's 90 minutes, GitHub is asked again.
  await fetchBundleAdvisories(packages, signal())
  await db.setUpstreamCacheEntry('github/advisories/org/dep', JSON.stringify({ ...stored, at: Date.now() - 2 * 60 * 60 * 1000 }), Date.now() + 1)
  await fetchBundleAdvisories(packages, signal(), { cache: upstreamCache(db, signal()) })
  assert.equal(calls.length, 3)
})

test('gone repositories and failed listings are not cached', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  for (const status of [404, 500]) {
    stubGithub(t, () => Response.json({ message: 'unavailable' }, { status }))
    const result = await fetchBundleAdvisories(packages, signal(), { cache: upstreamCache(db, signal()) })
    assert.equal(result.status, status === 404 ? 200 : 502)
  }
  assert.equal(await db.getUpstreamCacheEntry('github/advisories/org/dep'), null)
})

test('database failures are cache misses, never failed audits', async t => {
  const calls = stubGithub(t)
  const warn = t.mock.method(console, 'warn', () => {})
  const failing = {
    getUpstreamCacheEntry: () => Promise.reject(new Error('database unavailable')),
    setUpstreamCacheEntry: () => Promise.reject(new Error('database unavailable')),
  }
  for (const debug of [false, true]) {
    const result = await fetchBundleAdvisories(packages, signal(), { cache: upstreamCache(failing, signal(), debug) })
    assert.equal(result.status, 200)
    assert.equal(result.body[0].id, 'GHSA-2345-6789-cfgh')
  }
  assert.equal(calls.length, 2)
  assert.equal(warn.mock.callCount(), 2, 'debug logs the failed read and write')
  const malformed = { getUpstreamCacheEntry: () => Promise.resolve('{not json'), setUpstreamCacheEntry: () => Promise.resolve() }
  assert.equal((await fetchBundleAdvisories(packages, signal(), { cache: upstreamCache(malformed, signal()) })).status, 200)
  assert.equal(calls.length, 3)
})

test('an abandoned audit leaves the database alone', async () => {
  const used = []
  const db = {
    getUpstreamCacheEntry: key => { used.push(key); return Promise.resolve(null) },
    setUpstreamCacheEntry: key => { used.push(key); return Promise.resolve() },
  }
  const store = upstreamCache(db, AbortSignal.abort())
  assert.equal(await store.read('github/advisories/org/dep'), null)
  await store.write('github/advisories/org/dep', { at: 1 })
  assert.deepEqual(used, [])
})
