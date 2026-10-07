import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { parseBundleBuild } from '../server-managed/bundle-build.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { auditCache } from '../server-managed/upstream-cache.ts'

// Where upstream keeps what audits and bundle builds fetch: on disk in the
// server's cache directory (its default location, off Vercel), or with none
// (Vercel), nowhere but the database's listings.
const audits = [], builds = [], cacheDirs = []
mock.module('@exodus/stasis/vfs-bundle', { namedExports: {
  buildGitHubBundle: options => { builds.push(options); return Promise.reject(new Error('built no further')) },
  setCacheDir: dir => { cacheDirs.push(dir) },
} })
mock.module('@preventive/upstream/advisories.js', { namedExports: {
  advisories: (_packages, options) => { audits.push(options); return Promise.resolve([]) },
} })
const { buildStasisBundle } = await import('../server-managed/bundle-build-worker.js')
const { fetchBundleAdvisories } = await import('../server-managed/bundle-advisories.ts')

test('bundle builds cache on disk in the cache directory, and nowhere without one', async () => {
  const input = parseBundleBuild({ repoId: 1, commit: 'a'.repeat(40), entries: ['index.js'], conditions: { preset: 'node', conditions: ['node'], platforms: [] } })
  const client = { listRepoDir: () => Promise.resolve([]) }
  for (const cacheDir of ['/var/cache/upstream', null]) {
    await assert.rejects(buildStasisBundle({ input, github: 'org/repo', token: null, maxBytes: 1, scopes: [null], cacheDir }, client), /built no further/u)
  }
  assert.deepEqual(cacheDirs, ['/var/cache/upstream', false])
  assert.equal(Object.hasOwn(builds[0], 'cache'), false, 'the cache set keeps the tarballs and version documents')
  assert.equal(builds[1].cache, false)
})

test('audits cache on disk with a cache directory, and in the database store without one', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const signal = new AbortController().signal
  assert.equal(auditCache('/var/cache/upstream', db, signal), undefined)
  const store = auditCache(null, db, signal)
  assert.equal(typeof store?.read, 'function')
  const packages = [{ ecosystem: 'npm', name: 'dep', versions: ['1.0.0'] }]
  for (const cache of [auditCache('/var/cache/upstream', db, signal), store]) {
    assert.equal((await fetchBundleAdvisories(packages, signal, { repoAdvisories: true, cache })).status, 200)
  }
  assert.equal(Object.hasOwn(audits[0], 'cache'), false, 'upstream keeps it in the cache set')
  assert.equal(audits[1].cache, store)
})
