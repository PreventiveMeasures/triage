import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTeamReports, teamFindingIds, teamSourcePaths } from '../server-managed/team-reports.ts'

function fixture(pathCount) {
  const content = Buffer.from(JSON.stringify({ findings: [{ id: 'finding', evidence: Array.from({ length: pathCount }, (_, i) => ({ file: `src/${i}.js` })) }] }))
  const snapshots = new Map()
  let reads = 0
  const db = { getTeamReportAccessSnapshot: (_session, _now, team) => Promise.resolve(snapshots.get(team)) }
  const store = { get: () => { reads++; return Promise.resolve(content) } }
  function snapshot(team) {
    if (!snapshots.has(team)) {
      snapshots.set(team, {
        user: { id: 'user', role: 'view', login: 'user', name: null, avatarUrl: null }, teamId: team,
        reports: [{ id: 'report', filename: 'report.json', byteSize: content.length, sha256: 'immutable', repo: { github: null, directory: '' }, permissions: { dependencies: true, security: true } }],
      })
    }
    return snapshots.get(team)
  }
  return {
    get reads() { return reads },
    load: team => loadTeamReports(db, store, snapshot(team)),
    ids: team => teamFindingIds(db, store, 'session', team, 'report'),
    paths: team => teamSourcePaths(db, store, 'session', team, 'report'),
  }
}

test('visibility eviction includes the incoming snapshot and permits exactly the total limit', async () => {
  // Each snapshot contains one ID and 124,999 paths: two fit exactly.
  const h = fixture(124_999)
  await h.load('first')
  await h.load('second')
  await h.load('second') // Replacing a snapshot must not count its weight twice.
  const warm = h.reads
  assert.deepEqual([...await h.ids('first')], ['finding'])
  assert.equal((await h.paths('second')).size, 124_999)
  assert.equal(h.reads, warm)
  await h.load('third')
  const full = h.reads
  await h.ids('second'); await h.ids('third')
  assert.equal(h.reads, full, 'retain the two newest snapshots that fit')
  assert.deepEqual([...await h.ids('first')], ['finding'])
  assert.equal(h.reads, full + 1, 'evict before inserting an entry that would exceed the limit')
})

test('oversized visibility stays usable for annotation and source authorization without being retained', async () => {
  // One ID plus 250,000 paths exceeds the cache limit, but not report limits.
  const h = fixture(250_000)
  const reports = await h.load('large')
  assert.equal(reports[0].data.findings[0].evidence.length, 250_000)
  assert.equal(h.reads, 1)
  assert.deepEqual([...await h.ids('large')], ['finding'])
  assert.equal(h.reads, 2, 'an oversized workspace is served without caching its visibility')
  const paths = await h.paths('large')
  assert.equal(paths.size, 250_000)
  assert.ok(paths.has('src/249999.js'))
  assert.equal(h.reads, 3, 'uncached source authorization returns the computed visibility directly')
})

test('the snapshot count remains bounded and replacing a full-cache entry preserves its peers', async () => {
  const h = fixture(1)
  for (let i = 0; i < 32; i++) await h.load(`team-${i}`)
  await h.load('team-31')
  const warm = h.reads
  await h.ids('team-0')
  assert.equal(h.reads, warm, 'replacement does not evict another entry')
  await h.load('team-32')
  const full = h.reads
  await h.ids('team-31'); await h.ids('team-32')
  assert.equal(h.reads, full)
  await h.ids('team-0')
  assert.equal(h.reads, full + 1)
})
