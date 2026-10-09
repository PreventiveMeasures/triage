import './_polyfills.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable, Writable } from 'node:stream'
import { reportEntries } from '@preventive/report'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession } from '../server-managed/session.ts'
import { hashToken } from '../server-managed/crypto.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { loadTeamReports } from '../server-managed/team-reports.ts'
import { managedTeamAppMetadata } from '../common/managed/team-app.js'

const app = id => ({ id, severity: 'high', confidence: 9, file: 'app.js', revalidate: 'revalidation', isApp: true })
const source = id => ({ id, severity: 'high', confidence: 9, file: 'app.js', isApp: false })
const report = (id, ...findings) => ({ id, filename: `${id}.json`, data: { findings } })

test('managed teams use workspace App coverage, conflicting verdicts and linked finding counts', () => {
  const reports = [report('source', source('S')), report('app', [app('A'), { ...source('S'), revalidate: 'confirmed' }], app('B'))]
  assert.deepEqual(managedTeamAppMetadata(reports), { appMode: true, appFindings: 2 })
  const links = { id: 'links', filename: 'links.json', data: { source: 'links', links: [['A', 'B']] } }
  assert.deepEqual(managedTeamAppMetadata([...reports, links]), { appMode: true, appFindings: 1 })
  const globalLinks = [...reports]
  Object.defineProperty(globalLinks, 'links', { value: [['A', 'B']] })
  assert.deepEqual(managedTeamAppMetadata(globalLinks), { appMode: true, appFindings: 1 }, 'global links count just like local link reports')
  assert.deepEqual(managedTeamAppMetadata([...reports, report('uncovered', source('U'))]), { appMode: false })
  assert.deepEqual(managedTeamAppMetadata([...reports, report('conflict', [app('A'), { ...source('S'), revalidate: 'partial' }])]), { appMode: false })
  assert.deepEqual(managedTeamAppMetadata([]), { appMode: false })
  assert.deepEqual(managedTeamAppMetadata([report('source', source('S'))]), { appMode: false })
})

for (const format of ['JSON', 'Markdown']) {
  test(`server backfills IDs before App coverage and counts are computed for ID-less ${format} reports`, async () => {
    const bodies = [
      JSON.stringify({ findings: [app('confirmed-app')] }),
      format === 'JSON' ? JSON.stringify({ findings: [{ ...app(undefined), description: 'App A' }, { ...app(undefined), description: 'App B' }] })
        : '# App A\n\n---\n**Severity:** high\n\n# App B\n\n---\n**Severity:** high\n',
      JSON.stringify({ findings: [{ ...source(undefined), description: 'Uncovered finding' }] }),
    ]
    const reports = bodies.map((body, i) => ({
      id: String(i), filename: i === 1 && format === 'Markdown' ? 'app.md' : `${i}.json`,
      byteSize: Buffer.byteLength(body), sha256: 'immutable', repo: { github: null, directory: '' },
      permissions: { security: true, dependencies: true },
    }))
    const loaded = await loadTeamReports({}, { get: id => Promise.resolve(Buffer.from(bodies[Number(id)])) }, {
      user: { id: 'user', role: 'view' }, teamId: 'team', repositories: [], reports,
    })
    const findings = loaded.flatMap(r => reportEntries(r.data).flat())
    assert.equal(findings.length, 4)
    assert.ok(findings.every(f => typeof f.id === 'string' && f.id.length > 0))
    assert.equal(new Set(findings.map(f => f.id)).size, 4, 'unrelated ID-less findings must remain distinct')
    assert.deepEqual(managedTeamAppMetadata(loaded.slice(0, 2)), { appMode: true, appFindings: 3 })
    assert.deepEqual(managedTeamAppMetadata(loaded), { appMode: false }, 'App findings must not cover unrelated source rows')
  })
}

const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 3_600_000, allowShare: true }

// Teams in one repository: `app` holds an App report, `mixed` adds a source
// report the App does not cover, `empty` publishes nothing.
async function fixture(t) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const sessions = {}
  for (const [i, login] of ['admin', 'reader', 'peer'].entries()) {
    sessions[login] = await createSession(config, db, { githubUserId: i + 1, login, name: null, avatarUrl: null }, Date.now())
    await db.setUserRole(sessions[login].userId, login === 'admin' ? 'admin' : 'view')
  }
  await db.selectRepo({ repoId: 1, fullName: 'org/repo', private: true, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: sessions.admin.userId }, Date.now())
  const blobs = new Map(), reads = []
  const store = { failing: false, get(id) {
    reads.push(id)
    return Promise.resolve(store.failing ? null : blobs.get(id) ?? null)
  } }
  async function seed(id, directory, body, visible = true) {
    const bytes = Buffer.from(JSON.stringify(body))
    blobs.set(id, bytes)
    await db.insertReport({ id, filename: `${id}.json`, analyzer: null, contentType: 'application/json', repoId: 1, repoDirectory: directory, visible,
      byteSize: bytes.length, sha256: bytes.toString('base64'), uploadedBy: sessions.admin.userId, bundleId: null, bundleIntegrity: null }, Date.now())
  }
  for (const team of ['app', 'mixed', 'empty']) {
    await db.createTeam(team, team, Date.now())
    await db.setTeamRepo(team, 1, team)
    for (const login of ['reader', 'peer']) await db.setTeamMember(team, sessions[login].userId, { dependencies: true, security: true })
  }
  await seed('app-report', 'app', { findings: [app('A'), app('B')] })
  await seed('mixed-app', 'mixed', { findings: [app('C')] })
  await seed('mixed-source', 'mixed', { findings: [source('S')] })
  const handler = createManagedRequestHandler({ config, db, reportStore: store, originGate: { isOriginAllowed: () => true },
    isShuttingDown: () => false, track() {} })
  async function request(path, { login = 'reader', headers = {} } = {}) {
    const req = Readable.from([])
    Object.assign(req, { url: path, method: 'GET', headers: { cookie: sessions[login]?.setCookie.split(';', 1)[0], ...headers } })
    const chunks = []
    const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback() } })
    res.writeHead = (status, values) => { res.status = status; res.headers = values }
    await handler(req, res)
    return { status: res.status, body: JSON.parse(Buffer.concat(chunks).toString()) }
  }
  const catalog = async (login) => {
    const response = await request('/api/teams', { login })
    assert.equal(response.status, 200)
    return { revision: response.body.revision, apps: Object.fromEntries(response.body.teams.map(team => [team.id, team.app])) }
  }
  return { db, sessions, store, reads, seed, request, catalog }
}

test('the team catalog says which teams open as App teams before any team is opened', async t => {
  const h = await fixture(t)
  const { apps } = await h.catalog('reader')
  assert.deepEqual(apps, { app: { appMode: true, appFindings: 2 }, mixed: { appMode: false }, empty: { appMode: false } })
  assert.deepEqual(h.reads.toSorted(), ['app-report', 'mixed-app', 'mixed-source'], 'only published team reports are read')
  h.reads.length = 0
  assert.deepEqual((await h.catalog('reader')).apps, apps)
  assert.deepEqual((await h.catalog('peer')).apps, apps, 'the same access shares one classification')
  assert.deepEqual(h.reads, [], 'an unchanged catalog reuses its classification')
})

test('catalog changes reclassify teams under a new revision', async t => {
  const h = await fixture(t)
  const first = await h.catalog('reader')
  // Drafts are not part of the team's published workspace.
  await h.seed('draft', 'app', { findings: [source('D')] }, false)
  const drafted = await h.catalog('reader')
  assert.deepEqual(drafted.apps.app, { appMode: true, appFindings: 2 })
  await h.db.setReportVisible('draft', true)
  const published = await h.catalog('reader')
  assert.notEqual(published.revision, first.revision)
  assert.deepEqual(published.apps.app, { appMode: false }, 'an uncovered source report takes the team out of App mode')
  await h.db.setReportVisible('draft', false)
  assert.deepEqual((await h.catalog('reader')).apps.app, { appMode: true, appFindings: 2 })
  await h.seed('links', 'app', { source: 'links', findings: [], links: [['A', 'B']] })
  assert.deepEqual((await h.catalog('reader')).apps.app, { appMode: true, appFindings: 1 }, 'linked findings count once')
  await h.db.setReportVisible('mixed-source', false)
  assert.deepEqual((await h.catalog('reader')).apps.mixed, { appMode: true, appFindings: 1 })
})

test('unavailable reports leave a team unclassified until a later catalog read succeeds', async t => {
  const h = await fixture(t)
  t.mock.method(console, 'warn', () => {})
  h.store.failing = true
  assert.deepEqual((await h.catalog('reader')).apps, { app: null, mixed: null, empty: { appMode: false } })
  h.store.failing = false
  assert.deepEqual((await h.catalog('reader')).apps.app, { appMode: true, appFindings: 2 })
})

test('public links carry their workspace classification', async t => {
  const h = await fixture(t)
  const adminSession = hashToken(h.sessions.admin.setCookie.split(';', 1)[0].split('=')[1]), token = 'A'.repeat(43)
  assert.equal(await h.db.createWorkspaceShare(adminSession, Date.now(), 'app', hashToken(token), { dependencies: true, security: true }), true)
  const shared = await h.request('/api/teams/app/shared', { login: null, headers: { 'x-deepview-share': token } })
  assert.equal(shared.status, 200)
  assert.deepEqual(shared.body.team.app, { appMode: true, appFindings: 2 })
})

test('the client keeps only well-formed App classifications from the catalog', async t => {
  const { probeTeams } = await import('../client/managed/session.js')
  const sent = [{ appMode: true, appFindings: 3 }, { appMode: false, appFindings: 9 }, { appMode: true }, { appMode: true, appFindings: -1 },
    { appMode: true, appFindings: 1.5 }, { appMode: 'true', appFindings: 1 }, null, undefined]
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json({
    teams: sent.map((value, i) => ({ id: `team-${i}`, name: `Team ${i}`, reports: [], bundles: [], app: value })),
  })))
  const kept = (await probeTeams()).map(team => team.app)
  assert.deepEqual(kept.slice(0, 2), [{ appMode: true, appFindings: 3 }, { appMode: false }])
  assert.ok(kept.slice(2).every(value => value === undefined), 'malformed or missing classifications leave the team expanded')
})
