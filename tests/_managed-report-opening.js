import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { hashToken } from '../server-managed/crypto.ts'
import { harness, memoryStore, setup } from './_managed-mutation-safety.js'

const app = id => ({ id, severity: 'high', confidence: 9, file: 'app.js', revalidate: 'revalidation', isApp: true })
const source = (id, extra = {}) => ({ id, severity: 'high', confidence: 9, file: 'app.js', isApp: false, ...extra })

// Either store: reports uploaded before their opening was read are read for it
// in one write as the reports page lists them; a switched report reads so in
// its team's snapshot, its public link's, and changes its catalog key.
export async function checkReportOpenings(db) {
  const reports = memoryStore(), send = harness(db, reports), session = await setup(db)
  const sessionId = hashToken(session.setCookie.split(';')[0].slice(4))
  await db.createTeam('team', 'Team', 1)
  await db.setTeamRepo('team', 1, '')
  await db.setTeamMember('team', session.userId, { dependencies: true, security: true })
  const legacy = async (name, data) => {
    const bytes = Buffer.from(JSON.stringify(data)), id = randomUUID()
    await reports.put(id, bytes)
    await db.insertReport({ id, filename: `${name}.json`, contentType: 'application/json', byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('base64url'), uploadedBy: session.userId, repoId: 1, visible: true }, Date.now())
    return id
  }
  const offered = await legacy('offered', { findings: [[app('A'), source('S', { revalidate: 'confirmed' })], source('U')] })
  const plain = await legacy('plain', { findings: [[app('B'), source('T', { revalidate: 'confirmed' })]] })
  const list = async () => {
    const res = await send('/api/admin/reports', { session, method: 'GET' })
    assert.equal(res.status, 200)
    return Object.fromEntries(JSON.parse(res.body).reports.map(r => [r.id, [r.confirmedOffered, r.confirmedDefault]]))
  }
  assert.deepEqual(await list(), { [offered]: [true, false], [plain]: [false, false] })
  assert.deepEqual([(await db.getReport(offered)).confirmedOffered, (await db.getReport(plain)).confirmedOffered], [true, false], 'kept')
  await db.createWorkspaceShare(sessionId, Date.now(), 'team', 'share')
  const keys = async () => {
    const feed = await db.getUserTeamFeedSnapshot(sessionId, Date.now())
    const share = await db.getWorkspaceShare('share')
    return [feed.teams[0].reports.find(r => r.id === offered).cacheKey, share.catalogKeys[offered]]
  }
  const before = await keys()
  const res = await send('/api/admin/reports/set-opening', { session, body: { reportId: offered, confirmedDefault: true } })
  assert.equal(res.status, 200)
  assert.deepEqual(await list(), { [offered]: [true, true], [plain]: [false, false] })
  const after = await keys()
  assert.notEqual(after[0], before[0])
  assert.notEqual(after[1], before[1])
  const snapshot = await db.getTeamReportAccessSnapshot(sessionId, Date.now(), 'team')
  assert.deepEqual(snapshot.reports.map(r => [r.id, r.confirmedDefault]).toSorted(), [[offered, true], [plain, undefined]].toSorted())
  assert.equal(snapshot.catalogKeys[offered], after[0], 'the snapshot names the key its catalog entry has')
  const share = await db.getWorkspaceShare('share')
  assert.deepEqual(share.reports.map(r => [r.id, r.confirmedDefault]).toSorted(), [[offered, true], [plain, undefined]].toSorted())
}
