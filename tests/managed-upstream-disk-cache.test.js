import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { parseBundleBuild } from '../server-managed/bundle-build.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { upstreamCache } from '../server-managed/upstream-cache.ts'

// What the server hands Stasis and upstream as their `cache`: upstream's disk
// cache is never used, on Vercel or anywhere else.
const audits = [], builds = []
mock.module('@exodus/stasis/vfs-bundle', { namedExports: {
  buildGitHubBundle: options => { builds.push(options); return Promise.reject(new Error('built no further')) },
} })
mock.module('@preventive/upstream/advisories.js', { namedExports: {
  advisories: (_packages, options) => { audits.push(options); return Promise.resolve([]) },
} })
const { buildStasisBundle } = await import('../server-managed/bundle-build-worker.js')
const { fetchBundleAdvisories } = await import('../server-managed/bundle-advisories.ts')

test('bundle builds keep npm tarballs and version documents nowhere', async () => {
  const input = parseBundleBuild({ repoId: 1, commit: 'a'.repeat(40), entries: ['index.js'], conditions: { preset: 'node', conditions: ['node'], platforms: [] } })
  await assert.rejects(buildStasisBundle({ input, github: 'org/repo', token: null, maxBytes: 1, scopes: [null] }, { listRepoDir: () => Promise.resolve([]) }), /built no further/u)
  assert.equal(builds.length, 1)
  assert.equal(builds[0].cache, false)
})

test('audits cache in the database store or nowhere', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const packages = [{ ecosystem: 'npm', name: 'dep', versions: ['1.0.0'] }]
  const signal = new AbortController().signal
  assert.equal((await fetchBundleAdvisories(packages, signal)).status, 200)
  const store = upstreamCache(db, signal)
  assert.equal((await fetchBundleAdvisories(packages, signal, { repoAdvisories: true, cache: store })).status, 200)
  assert.deepEqual(audits.map(options => options.cache), [false, store])
})
