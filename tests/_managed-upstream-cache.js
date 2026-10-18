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
  // Many at once, as each alone: a newer kept, the last of a key given twice.
  await db.setUpstreamCacheEntries([['many/a', '"a1"'], ['many/b', '"b1"'], ['many/a', '"a2"'], [key, '{"v":"older"}']], 2)
  assert.deepEqual(await db.getUpstreamCacheEntries(['many/a', 'many/b', key]), new Map([['many/a', '"a2"'], ['many/b', '"b1"'], [key, '{"v":2}']]))
  await db.setUpstreamCacheEntries([['many/b', '"b2"']], 4)
  await db.setUpstreamCacheEntries([], 5)
  assert.equal(await db.getUpstreamCacheEntry('many/b'), '"b2"')
  // The first keys' where any is kept, else the others', in one read.
  assert.deepEqual(await db.getFirstUpstreamCacheEntries(['many/missing', 'many/a'], ['many/b', key]), { first: true, entries: new Map([['many/a', '"a2"']]) })
  assert.deepEqual(await db.getFirstUpstreamCacheEntries(['many/missing'], ['many/b', 'many/none', key]),
    { first: false, entries: new Map([['many/b', '"b2"'], [key, '{"v":2}']]) })
  assert.deepEqual(await db.getFirstUpstreamCacheEntries(['many/missing'], ['many/none']), { first: false, entries: new Map() })
  assert.deepEqual(await db.getFirstUpstreamCacheEntries([], ['many/b']), { first: false, entries: new Map([['many/b', '"b2"']]) })
  assert.deepEqual(await db.getFirstUpstreamCacheEntries([], []), { first: false, entries: new Map() })
  return { key, value: '{"v":2}' }
}
