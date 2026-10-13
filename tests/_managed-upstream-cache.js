import assert from 'node:assert/strict'

export async function checkUpstreamCacheStore(db) {
  const key = 'github/advisories/org/dep'
  assert.equal(await db.getUpstreamCacheEntry(key), null)
  await db.setUpstreamCacheEntry(key, '{"v":1}', 2)
  assert.equal(await db.getUpstreamCacheEntry(key), '{"v":1}')
  await db.setUpstreamCacheEntry(key, '{"v":"older"}', 1)
  assert.equal(await db.getUpstreamCacheEntry(key), '{"v":1}', 'a slower concurrent audit cannot replace a newer listing')
  await db.setUpstreamCacheEntry(key, '{"v":2}', 3)
  assert.equal(await db.getUpstreamCacheEntry(key), '{"v":2}')
  await db.setUpstreamCacheEntry('github/advisories/org/other', '[]', 1)
  assert.equal(await db.getUpstreamCacheEntry(key), '{"v":2}', 'keys are independent')
  assert.equal(await db.getUpstreamCacheEntry('github/advisories/ORG/DEP'), null, 'upstream normalizes keys, the store does not')
  assert.deepEqual(await db.getUpstreamCacheEntries([key, 'github/advisories/org/other', 'github/advisories/org/missing', 'github/advisories/ORG/DEP']),
    new Map([[key, '{"v":2}'], ['github/advisories/org/other', '[]']]), 'one read answers every key kept')
  assert.deepEqual(await db.getUpstreamCacheEntries([]), new Map())
  await db.setUpstreamCacheEntry('repository-risk/lines/old', '{}', 1)
  await db.setUpstreamCacheEntry('repository-risk/lines/new', '{}', 5)
  await db.setUpstreamCacheEntry('repository-risk/linesake', '{}', 1)
  assert.equal(await db.deleteUpstreamCacheEntries('repository-risk/lines/', 3), 1, 'those under the prefix kept before then')
  assert.deepEqual(await db.getUpstreamCacheEntries(['repository-risk/lines/old', 'repository-risk/lines/new', 'repository-risk/linesake', key]),
    new Map([['repository-risk/lines/new', '{}'], ['repository-risk/linesake', '{}'], [key, '{"v":2}']]))
  return { key, value: '{"v":2}' }
}
