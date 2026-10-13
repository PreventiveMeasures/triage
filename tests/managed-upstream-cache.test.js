import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { fetchBundleAdvisories } from '../server-managed/bundle-advisories.ts'
import { setCacheDir } from '@preventive/upstream/npm.js'
import { auditCache, auditedRepos, lastListing, upstreamCache } from '../server-managed/upstream-cache.ts'
import { checkUpstreamCacheStore } from './_managed-upstream-cache.js'
import { OSV, osvNone } from './_managed-npm.js'

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

test('a failed audit is logged, but for one its client gave up on: one past its deadline is', async t => {
  const warn = t.mock.method(console, 'warn', () => {})
  const cancelled = new AbortController()
  cancelled.abort()
  assert.equal((await fetchBundleAdvisories(packages, cancelled.signal)).status, 502)
  assert.equal(warn.mock.callCount(), 0, 'the reader gone')
  assert.equal((await fetchBundleAdvisories(packages, AbortSignal.abort(new DOMException('advisories took too long', 'TimeoutError')))).status, 502)
  assert.deepEqual(warn.mock.calls.map(call => call.arguments), [['managed: advisories failed:', 'advisories took too long']], 'the server\'s deadline passed')
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

test('only repository listings are kept, never npm version documents', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const integrity = `sha512-${createHash('sha512').update('dep').digest('base64')}`
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, init) => {
    calls.push(url)
    const { hostname, pathname } = new URL(url)
    if (pathname.endsWith('/advisories/bulk')) return Promise.resolve(Response.json({}))
    if (url === OSV) return Promise.resolve(osvNone(init))
    if (hostname === 'registry.npmjs.org') {
      assert.equal(pathname, '/dep/2.0.0')
      // Keepable as upstream's disk cache would keep it: its dist is the registry's.
      return Promise.resolve(Response.json({ name: 'dep', version: '2.0.0', repository: 'https://github.com/org/dep',
        dist: { tarball: 'https://registry.npmjs.org/dep/-/dep-2.0.0.tgz', integrity } }))
    }
    assert.equal(url, listing)
    return Promise.resolve(Response.json([advisory]))
  })
  const recheck = () => fetchBundleAdvisories([{ ecosystem: 'npm', name: 'dep', versions: ['1.0.0', '2.0.0'] }], signal(),
    { repoAdvisories: true, cache: upstreamCache(db, signal()) })
  assert.equal((await recheck()).status, 200)
  assert.equal(await db.getUpstreamCacheEntry('npm/versions/dep@2.0.0'), null)
  assert.notEqual(await db.getUpstreamCacheEntry('github/advisories/org/dep'), null)
  assert.equal((await recheck()).status, 200)
  assert.equal(calls.filter(url => url.startsWith('https://registry.npmjs.org/dep/')).length, 2, 'npm is asked each time')
  assert.equal(calls.filter(url => url === listing).length, 1, 'the listing is answered from the database')

  const used = []
  const store = upstreamCache({
    getUpstreamCacheEntry: key => { used.push(key); return Promise.resolve(null) },
    setUpstreamCacheEntry: key => { used.push(key); return Promise.resolve() },
  }, signal())
  for (const type of ['npm/versions', 'npm/tarballs', 'cargo/repos', 'composer/repos', 'soldeer/repos']) {
    assert.equal(await store.read(type, 'dep@2.0.0'), null)
    await store.write(type, 'dep@2.0.0', { name: 'dep' })
  }
  assert.deepEqual(used, [])
})

test('with a cache directory, audits keep listings and npm version documents on disk, not in the database', async t => {
  const db = openSqliteManagedDb(':memory:')
  const dir = await mkdtemp(join(tmpdir(), 'triage-upstream-disk-'))
  setCacheDir(dir)
  t.after(async () => { setCacheDir(false); db.close(); await rm(dir, { recursive: true, force: true }) })
  const integrity = `sha512-${createHash('sha512').update('dep').digest('base64')}`
  const calls = []
  t.mock.method(globalThis, 'fetch', (url, init) => {
    calls.push(url)
    const { hostname, pathname } = new URL(url)
    if (pathname.endsWith('/advisories/bulk')) return Promise.resolve(Response.json({}))
    if (url === OSV) return Promise.resolve(osvNone(init))
    if (hostname === 'registry.npmjs.org') {
      return Promise.resolve(Response.json({ name: 'dep', version: '2.0.0', repository: 'https://github.com/org/dep',
        dist: { tarball: 'https://registry.npmjs.org/dep/-/dep-2.0.0.tgz', integrity } }))
    }
    assert.equal(url, listing)
    return Promise.resolve(Response.json([advisory]))
  })
  const recheck = () => fetchBundleAdvisories([{ ecosystem: 'npm', name: 'dep', versions: ['2.0.0'] }], signal(),
    { repoAdvisories: true, cache: auditCache(dir, db, signal()) })
  assert.equal((await recheck()).status, 200)
  assert.deepEqual(await readdir(join(dir, 'npm/versions')), ['dep@2.0.0.json.gz'])
  assert.equal((await readdir(join(dir, 'github/advisories'))).length, 1)
  assert.equal(await db.getUpstreamCacheEntry('github/advisories/org/dep'), null)
  calls.length = 0
  assert.equal((await recheck()).status, 200)
  assert.deepEqual(calls.toSorted(), ['https://api.osv.dev/v1/querybatch', 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk'],
    'neither npm\'s document nor GitHub is asked again, only the advisories, npm\'s and OSV\'s')
})

test('a listing as last kept, however old, is read where audits keep it, the database or upstream\'s disk cache, and answered as kept now', async t => {
  const db = openSqliteManagedDb(':memory:')
  const dir = await mkdtemp(join(tmpdir(), 'triage-upstream-last-'))
  t.after(async () => { setCacheDir(false); db.close(); await rm(dir, { recursive: true, force: true }) })
  const calls = stubGithub(t)
  assert.equal(await lastListing(null, db, 'org/dep'), null, 'none is kept yet')
  assert.equal(await lastListing(dir, db, 'org/dep'), null)
  const kept = await fetchBundleAdvisories(packages, signal(), { details: true, cache: auditCache(null, db, signal()) })
  setCacheDir(dir)
  assert.deepEqual(await fetchBundleAdvisories(packages, signal(), { details: true, cache: auditCache(dir, db, signal()) }), kept)
  assert.equal(calls.length, 2, 'kept in each')
  const stored = await db.getUpstreamCacheEntry('github/advisories/org/dep'), [file] = await readdir(join(dir, 'github/advisories'))
  // Three hours on, GitHub fails: upstream takes neither as it is.
  const later = Date.now() + 3 * 60 * 60_000
  t.mock.method(Date, 'now', () => later)
  stubGithub(t, () => Response.json({ message: 'unavailable' }, { status: 500 }))
  assert.equal((await fetchBundleAdvisories(packages, signal(), { cache: auditCache(null, db, signal()) })).status, 502)
  for (const cacheDir of [null, dir]) {
    const last = await lastListing(cacheDir, db, 'Org/Dep')
    assert.ok(last.at < later - 2 * 60 * 60_000, 'when it was kept')
    assert.deepEqual(await fetchBundleAdvisories(packages, signal(), { details: true, cache: last.cache }), kept, 'found by any spelling of its name')
    assert.equal(await last.cache.read('github/advisories', 'org/other'), null, 'its own listing alone')
  }
  assert.equal(await db.getUpstreamCacheEntry('github/advisories/org/dep'), stored, 'nothing is written')
  assert.deepEqual(await readdir(join(dir, 'github/advisories')), [file])
  const warn = t.mock.method(console, 'warn', () => {})
  await db.setUpstreamCacheEntry('github/advisories/org/broken', '{not json', later)
  assert.equal(await lastListing(null, db, 'org/broken', true), null, 'one that can\'t be read is none')
  assert.equal(warn.mock.callCount(), 1)
})

test('an audit asks for the listings of the repositories it knows in one database read', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const integrity = `sha512-${createHash('sha512').update('found').digest('base64')}`
  const repos = ['org/a', 'org/b', 'org/c', 'org/found', 'org/dep']
  const github = []
  t.mock.method(globalThis, 'fetch', (url, init) => {
    const { hostname, pathname } = new URL(url)
    if (pathname.endsWith('/advisories/bulk')) return Promise.resolve(Response.json({}))
    if (url === OSV) return Promise.resolve(osvNone(init))
    if (hostname === 'registry.npmjs.org') {
      assert.equal(pathname, '/found/1.0.0')
      return Promise.resolve(Response.json({ name: 'found', version: '1.0.0', repository: 'https://github.com/org/found',
        dist: { tarball: 'https://registry.npmjs.org/found/-/found-1.0.0.tgz', integrity } }))
    }
    const repo = repos.find(name => url.toLowerCase() === `https://api.github.com/repos/${name}/security-advisories?state=published&per_page=100`)
    assert.ok(repo, url)
    github.push(repo)
    return Promise.resolve(Response.json(repo === 'org/dep' ? [advisory] : []))
  })
  // `found` names no repository, so upstream looks it up; `Org/Dep` is spelled as GitHub may have it.
  const audited = [...['a', 'b', 'c'].map(name => ({ ecosystem: 'npm', name, versions: ['1.0.0'], github: `org/${name}` })),
    { ecosystem: 'npm', name: 'found', versions: ['1.0.0'] }, { ecosystem: 'github', name: 'Org/Dep', versions: ['1.0.0'] }]
  const reads = { batched: [], single: [] }
  const counted = {
    getUpstreamCacheEntry: key => { reads.single.push(key); return db.getUpstreamCacheEntry(key) },
    getUpstreamCacheEntries: keys => { reads.batched.push(keys); return db.getUpstreamCacheEntries(keys) },
    setUpstreamCacheEntry: (...args) => db.setUpstreamCacheEntry(...args),
  }
  const recheck = () => fetchBundleAdvisories(audited, signal(),
    { repoAdvisories: true, cache: upstreamCache(counted, signal(), false, auditedRepos(audited, true)) })
  const first = await recheck()
  assert.equal(first.status, 200)
  assert.deepEqual(github.toSorted(), repos.toSorted())
  reads.batched.length = 0
  reads.single.length = 0
  assert.deepEqual(await recheck(), first)
  assert.equal(github.length, repos.length, 'every listing is answered from the database')
  assert.deepEqual(reads.batched, [['github/advisories/org/a', 'github/advisories/org/b', 'github/advisories/org/c', 'github/advisories/org/dep']])
  assert.deepEqual(reads.single, ['github/advisories/org/found'], 'a repository looked up is read alone')

  // A failed batch read is read key by key instead, not answered from GitHub.
  const failing = { ...counted, getUpstreamCacheEntries: () => Promise.reject(new Error('database unavailable')) }
  reads.single.length = 0
  const fallback = await fetchBundleAdvisories(audited, signal(),
    { repoAdvisories: true, cache: upstreamCache(failing, signal(), false, auditedRepos(audited, true)) })
  assert.deepEqual(fallback, first)
  assert.equal(github.length, repos.length)
  assert.equal(reads.single.length, repos.length)
})

test('audits batch the listings they ask for: github packages, soldeer repositories, and the rest only on a recheck', () => {
  const mixed = [
    { ecosystem: 'github', name: 'Org/Tool', versions: ['0.0.0'] },
    { ecosystem: 'soldeer', name: 'lib', versions: ['1.0.0'], github: 'org/lib' },
    { ecosystem: 'npm', name: 'dep', versions: ['1.0.0'], github: 'org/dep' },
    { ecosystem: 'cargo', name: 'dep', versions: ['1.0.0'], github: 'org/dep' },
    { ecosystem: 'npm', name: 'unknown', versions: ['1.0.0'] },
  ]
  assert.deepEqual(auditedRepos(mixed, false), ['Org/Tool', 'org/lib'])
  assert.deepEqual(auditedRepos(mixed, true), ['Org/Tool', 'org/lib', 'org/dep'])
})

test('an abandoned audit leaves the database alone', async () => {
  const used = []
  const db = {
    getUpstreamCacheEntry: key => { used.push(key); return Promise.resolve(null) },
    setUpstreamCacheEntry: key => { used.push(key); return Promise.resolve() },
  }
  const store = upstreamCache(db, AbortSignal.abort())
  assert.equal(await store.read('github/advisories', 'org/dep'), null)
  await store.write('github/advisories', 'org/dep', { at: 1 })
  assert.deepEqual(used, [])
})
