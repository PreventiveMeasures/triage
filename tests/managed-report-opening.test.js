import './_polyfills.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession } from '../server-managed/session.ts'
import { managedReportConfirmedDefaultOffered, managedTeamAppMetadata, managedTeamAppRows } from '../common/managed/team-app.js'
import { confirmedCoverage, tabKey } from '../common/finding-filters.js'
import { config, harness, memoryStore, setup } from './_managed-mutation-safety.js'
import { checkReportOpenings } from './_managed-report-opening.js'

const { state } = await import('../client/state.ts')
const { defaultConfidenceFloor, defaultRevalidateFilter, shouldLockConfirmed } = await import('../ui/view/filters.js')
const { configureRevalidation } = await import('../ui/view/format.js')

const app = id => ({ id, severity: 'high', confidence: 9, file: 'app.js', revalidate: 'revalidation', isApp: true })
const source = (id, extra = {}) => ({ id, severity: 'high', confidence: 9, file: 'app.js', isApp: false, ...extra })
// A pass that confirmed one finding and never reached another the range shows:
// Confirmed would hide `U`, so the report opens on Confidence.
const uncovered = (prefix = '') => ({ findings: [[app(`${prefix}A`), source(`${prefix}S`, { revalidate: 'confirmed' })], source(`${prefix}U`)] })
// A pass that answered everything it shows: it opens on Confirmed already.
const covered = { findings: [[app('CA'), source('CS', { revalidate: 'confirmed' })]] }
const report = (id, data, confirmedDefault) => ({ id, filename: `${id}.json`, data, ...confirmedDefault ? { confirmedDefault: true } : {} })

test('the switch is offered only for a report with Confirmed findings that opens on the confidence range', () => {
  assert.equal(managedReportConfirmedDefaultOffered('uncovered.json', structuredClone(uncovered())), true)
  assert.equal(managedReportConfirmedDefaultOffered('covered.json', structuredClone(covered)), false, 'it opens on Confirmed already')
  assert.equal(managedReportConfirmedDefaultOffered('source.json', { findings: [source('X')] }), false, 'no pass, no Confirmed to open on')
  assert.equal(managedReportConfirmedDefaultOffered('import.json', { source: 'codex-security', findings: [{ id: 'I', severity: 'high', file: 'a.js' }] }), false,
    'another analyzer\'s unjudged findings')
  assert.equal(managedReportConfirmedDefaultOffered('conflict.json', { findings: [[app('A'), source('S', { revalidate: 'confirmed' })], [app('B'), source('S', { revalidate: 'partial' })], source('U')] }), false,
    'contradicting verdicts open with no App layer')
  assert.equal(managedReportConfirmedDefaultOffered('links.json', { source: 'links', findings: [], links: [['A', 'B']] }), false)
  assert.equal(managedReportConfirmedDefaultOffered('stamped.json', { findings: uncovered().findings.map(group => Array.isArray(group)
    ? group.map(f => ({ ...f, _confirmedDefault: true })) : { ...group, _confirmedDefault: true }) }), true, 'its content cannot switch itself')
})

test('a switched finding counts as covered only where every copy of it is switched', () => {
  const rows = (...flags) => flags.map(flag => [{ id: 'F', _confirmedDefault: flag }])
  const keys = groups => [...confirmedCoverage(groups, g => g, () => '')].filter(key => key === tabKey(groups[0][0]))
  assert.deepEqual(keys(rows(true)), ['F'])
  assert.deepEqual(keys(rows(true, true)), ['F'])
  assert.deepEqual(keys(rows(true, false)), [], 'a copy in a report nobody switched is still that report\'s to lose')
  assert.deepEqual(keys(rows(false)), [])
})

test('a team whose only uncovered findings are in switched reports is an App team', () => {
  assert.deepEqual(managedTeamAppMetadata([report('r', uncovered())]), { appMode: false })
  assert.deepEqual(managedTeamAppMetadata([report('r', uncovered(), true)]), { appMode: true, appFindings: 1 })
  assert.deepEqual([...managedTeamAppRows([report('r', uncovered(), true)])], ['A'], 'its App view shows what Confirmed does')
  assert.deepEqual(managedTeamAppMetadata([report('r', uncovered(), true), report('c', covered)]), { appMode: true, appFindings: 2 })
  assert.deepEqual(managedTeamAppMetadata([report('r', uncovered('1'), true), report('s', uncovered('2'), true)]), { appMode: true, appFindings: 2 })
  assert.deepEqual(managedTeamAppMetadata([report('r', uncovered('1'), true), report('s', uncovered('2'))]), { appMode: false },
    'another report\'s violations keep the team out')
  assert.deepEqual(managedTeamAppMetadata([report('r', uncovered(), true), report('s', { findings: [source('U')] })]), { appMode: false },
    'the same finding in a report nobody switched keeps the team out')
  assert.deepEqual(managedTeamAppMetadata([report('r', { findings: uncovered().findings.map(group => Array.isArray(group)
    ? group.map(f => ({ ...f, _confirmedDefault: true })) : { ...group, _confirmedDefault: true }) })]), { appMode: false },
  'a stamp a report wrote itself counts for nothing')
})

test('a view opens a switched report on Confirmed, its outcome locked as the App view, and the same rows unswitched on Confidence', () => {
  state.showRevalidation = true
  state.upstreamOnly = false
  state.revalidationDetailed = false
  state.severityMode = 'corrected'
  configureRevalidation(true)
  const groups = flag => uncovered().findings.map(group => (Array.isArray(group) ? group : [group]).map(f => ({ ...f, _confirmedDefault: flag })))
  for (const [flag, opens, locked] of [[false, '', false], [true, 'confirmed', true]]) {
    const rows = groups(flag)
    assert.equal(defaultRevalidateFilter(rows, defaultConfidenceFloor(rows)), opens)
    assert.equal(shouldLockConfirmed(rows), locked)
  }
})

// Uploads, the reports page, the switch and a team reading it, over HTTP.
async function fixture(t) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const reports = memoryStore(), send = harness(db, reports)
  const session = await setup(db)
  await db.createTeam('team', 'Team', 1)
  await db.setTeamRepo('team', 1, '')
  await db.setTeamMember('team', session.userId, { dependencies: true, security: true })
  const upload = async (name, data) => {
    const res = await send('/api/admin/reports', { session, body: Buffer.from(JSON.stringify({ repo: { github: 'org/repo1' }, ...data })),
      headers: { 'x-report-filename': `${name}.json`, 'content-type': 'application/json' } })
    assert.equal(res.status, 201, res.body)
    return JSON.parse(res.body).id
  }
  const get = async path => {
    const res = await send(path, { session, method: 'GET' })
    assert.equal(res.status, 200, res.body)
    return JSON.parse(res.body)
  }
  const listed = async () => Object.fromEntries((await get('/api/admin/reports')).reports.map(r => [r.filename.replace(/\.json$/u, ''), [r.confirmedOffered, r.confirmedDefault]]))
  const switchTo = (reportId, confirmedDefault, as = session) => send('/api/admin/reports/set-opening', { session: as, body: { reportId, confirmedDefault } })
  const team = async () => (await get('/api/teams')).teams.find(entry => entry.id === 'team')
  return { db, reports, send, session, upload, get, listed, switchTo, team }
}

test('managers switch a report that offers it; its team reads it switched, and opens as an App team', async t => {
  const h = await fixture(t)
  const switched = await h.upload('uncovered', uncovered())
  const plain = await h.upload('covered', covered)
  assert.deepEqual(await h.listed(), { uncovered: [true, false], covered: [false, false] }, 'read as each is uploaded')
  for (const id of [switched, plain]) await h.db.setReportVisible(id, true)
  const before = await h.team()
  assert.equal(before.app.appMode, false)

  const refused = await h.switchTo(plain, true)
  assert.equal(refused.status, 409)
  assert.equal(JSON.parse(refused.body).error, 'not-offered')
  assert.equal((await h.switchTo(switched, true)).status, 200)
  assert.deepEqual(await h.listed(), { uncovered: [true, true], covered: [false, false] })
  const after = await h.team()
  assert.notEqual(after.reports.find(r => r.id === switched).cacheKey, before.reports.find(r => r.id === switched).cacheKey,
    'the switch changes the report\'s catalog key, so views of it reload')
  assert.deepEqual(after.app, { appMode: true, appFindings: 2 })
  const workspace = await h.get('/api/teams/team/reports')
  assert.deepEqual(workspace.reports.map(r => [r.id, r.confirmedDefault]).toSorted(), [[switched, true], [plain, undefined]].toSorted())
  const lite = await h.get('/api/teams/team/reports?lite=1')
  assert.equal(lite.folded, 'app', 'its board is sent the rows the App view shows')

  const history = await h.get('/api/admin/history')
  assert.ok(history.history.some(entry => entry.action === 'set a report to open on Confirmed' && entry.reportId === switched))
  assert.equal((await h.switchTo(switched, true)).status, 200)
  assert.equal((await h.get('/api/admin/history')).total, history.total, 'an unchanged switch adds no history')

  assert.equal((await h.switchTo(switched, false)).status, 200)
  assert.equal((await h.team()).app.appMode, false)
  assert.equal((await h.switchTo(plain, false)).status, 200, 'off is always allowed')
  assert.equal((await h.switchTo(switched, 'yes')).status, 400)
})

test('a report uploaded before the switch existed is read for it as the reports page lists it, or as it is switched', async t => {
  const h = await fixture(t)
  const legacy = async (name, data) => {
    const bytes = Buffer.from(JSON.stringify(data)), id = randomUUID()
    await h.reports.put(id, bytes)
    await h.db.insertReport({ id, filename: `${name}.json`, contentType: 'application/json', byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('base64url'), uploadedBy: h.session.userId, repoId: 1, visible: false }, Date.now())
    return id
  }
  const listedLater = await legacy('listed', uncovered())
  const switchedFirst = await legacy('switched', uncovered('2'))
  const missing = await legacy('missing', covered)
  h.reports.blobs.delete(missing)
  assert.equal((await h.db.getReport(listedLater)).confirmedOffered, null)
  assert.equal((await h.switchTo(switchedFirst, true)).status, 200, 'read as it is switched')
  assert.deepEqual(await h.listed(), { listed: [true, false], switched: [true, true], missing: [null, false] }, 'one whose bytes are missing is read again later')
  assert.equal((await h.db.getReport(listedLater)).confirmedOffered, true, 'and kept')
  assert.equal((await h.switchTo(missing, true)).status, 503)
})

test('a manager cannot switch a report outside their access', async t => {
  const h = await fixture(t)
  const id = await h.upload('uncovered', uncovered())
  const other = await createSession(config, h.db, { githubUserId: 9, login: 'other', name: null, avatarUrl: null }, Date.now())
  await h.db.setUserRole(other.userId, 'manage')
  assert.equal((await h.switchTo(id, true, other)).status, 404)
  await h.db.setUserRole(other.userId, 'triage')
  assert.equal((await h.switchTo(id, true, other)).status, 403)
  assert.equal((await h.db.getReport(id)).confirmedDefault, false)
})

test('SQLite reads reports for their opening in one write and carries a switched report to its team and public link', async t => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  await checkReportOpenings(db)
})
