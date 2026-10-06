import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { parseStorageKey } from '../server-common/storage-crypto.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { mergeLinkGroups } from '../server-managed/link-reports.ts'
import { hashToken } from '../server-managed/crypto.ts'
import { checkLinkReports } from './_managed-link-reports.js'
import { harness, memoryStore, setup } from './_managed-mutation-safety.js'

const key = parseStorageKey(randomBytes(32).toString('base64'))
const sessionId = session => hashToken(session.setCookie.split(';')[0].slice(4))

test('merge overlapping rows before filtering, including bridges absent from the response', () => {
  const groups = [['a', 'hidden'], ['b', 'other'], ['hidden', 'other'], ['c'], ['missing', 'absent'], ['a', 'a']]
  assert.deepEqual(mergeLinkGroups(groups, new Set(['a', 'b', 'c'])), [['a', 'b']])
  assert.deepEqual(mergeLinkGroups(groups, new Set(['a'])), [])
})

test('SQLite stores authenticated ciphertext in its own table, retains toggles, and rejects swapped payloads', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-links-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'db.sqlite')
  const db = openSqliteManagedDb(file, { storageEncryptionKey: key })
  t.after(() => db.close())
  const raw = new DatabaseSync(file)
  t.after(() => raw.close())
  const id = await checkLinkReports(db, () => raw.prepare('SELECT * FROM managed_link_report').all())
  raw.prepare('UPDATE managed_link_report SET id = ? WHERE id = ?').run('different-row', id)
  await assert.rejects(db.getEnabledLinkGroups(await db.getLinkRevision()), /authenticat/u)
})

async function fixture(t, encryptionKey = key) {
  const db = openSqliteManagedDb(':memory:', { storageEncryptionKey: encryptionKey })
  t.after(() => db.close())
  const session = await setup(db), store = memoryStore()
  const request = harness(db, store)
  await db.createTeam('team', 'Team', Date.now())
  await db.setTeamRepo('team', 1, '')
  await db.setTeamMember('team', session.userId, { dependencies: false, security: true })
  const seed = async (id, findings) => {
    const bytes = Buffer.from(JSON.stringify({ findings }))
    await store.put(id, bytes)
    await db.insertReport({ id, filename: `${id}.json`, contentType: 'application/json', byteSize: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('base64url'), uploadedBy: session.userId, repoId: 1, visible: true }, Date.now())
  }
  const send = async (path, options = {}) => {
    const res = await request(path, { session, ...options })
    return { status: res.status, body: res.body ? JSON.parse(res.body) : null }
  }
  const upload = content => send('/api/admin/deduplication', { body: Buffer.from(JSON.stringify(content)), headers: { 'x-report-filename': 'example.link.json' } })
  return { db, session, store, seed, send, upload }
}

test('global links apply across reports, survive hidden bridges, stay out of catalogs, and refresh cached responses', async t => {
  const h = await fixture(t)
  await h.seed('first', [{ id: 'a', file: 'src/a.js' }, { id: 'hidden', file: 'node_modules/private/a.js' }])
  await h.seed('second', [{ id: 'b', file: 'src/b.js' }])
  const first = await h.upload([['a', 'hidden']])
  assert.equal(first.status, 201)
  const second = await h.upload([['hidden', 'b'], ['absent', 'missing']])
  assert.equal(second.status, 201)
  const before = (await h.db.listTeamsForUser(h.session.userId))[0].cacheKey
  assert.equal((await h.db.listReports()).length, 2)
  await h.db.setUserRole(h.session.userId, 'view')
  const read = () => h.send('/api/teams/team/reports', { method: 'GET' })
  let result = await read()
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.reports.map(r => r.id), ['first', 'second'])
  assert.deepEqual(result.body.links.map(g => g.toSorted()), [['a', 'b']])
  assert.equal(JSON.stringify(result.body).includes('hidden'), false)
  assert.equal(JSON.stringify(result.body).includes('example.link.json'), false)
  assert.deepEqual((await read()).body, result.body, 'warm cache has the same projected links')
  await h.db.setUserRole(h.session.userId, 'admin')
  assert.equal((await h.send(`/api/admin/deduplication/${second.body.id}`, { method: 'PATCH', body: { enabled: false } })).status, 200)
  assert.notEqual((await h.db.listTeamsForUser(h.session.userId))[0].cacheKey, before)
  await h.db.setUserRole(h.session.userId, 'view')
  result = await read()
  assert.equal(result.body.links, undefined)
  assert.equal((await h.send('/api/admin/deduplication', { method: 'GET' })).status, 403)
  assert.equal((await h.upload([['a', 'b']])).status, 403)
})

test('global security propagation crosses absent IDs and rechecks link toggles during blob reads', async t => {
  const h = await fixture(t)
  await h.seed('first', [{ id: 'a', file: 'src/a.js' }, { id: 'security', file: 'src/s.js', security: true }])
  const upload = await h.upload([['a', 'absent'], ['absent', 'security']])
  await h.db.setTeamMember('team', h.session.userId, { dependencies: true, security: false })
  await h.db.setUserRole(h.session.userId, 'view')
  const res = await h.send('/api/teams/team/reports', { method: 'GET' })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.reports[0].data.findings, [])
  await h.db.setUserRole(h.session.userId, 'admin')
  const original = h.store.get
  h.store.get = async id => {
    await h.db.setLinkReportEnabled(sessionId(h.session), upload.body.id, false)
    return original(id)
  }
  assert.notEqual((await h.send('/api/teams/team/reports', { method: 'GET' })).status, 200)
})

test('uploads require encryption, validate rows, enforce CSRF, and route regular link uploads away from blobs', async t => {
  const plain = await fixture(t, null)
  assert.equal((await plain.upload([['a', 'b']])).status, 503)
  assert.deepEqual(await plain.db.listLinkReports(), [])
  const h = await fixture(t)
  for (const data of [{ findings: [] }, [[1, 2]], [['a', '42']], [['a', '']]]) assert.equal((await h.upload(data)).status, 400)
  assert.equal((await h.send('/api/admin/deduplication', { body: Buffer.from('[["a","b"]]'), headers: { 'x-csrf-token': 'bad' } })).status, 403)
  const result = await h.send('/api/admin/reports', { body: Buffer.from('[["a","b"]]'), headers: { 'x-report-filename': 'file.link.json' } })
  assert.equal(result.status, 201)
  assert.equal(result.body.kind, 'links')
  assert.deepEqual(await h.db.listReports(), [])
  assert.equal(h.store.blobs.size, 0)
  assert.equal((await h.send(`/api/admin/deduplication/${result.body.id}`, { method: 'PATCH', body: { enabled: 'false' } })).status, 400)
})

test('legacy link reports migrate to encrypted SQL with publication state and attribution retained', async t => {
  const h = await fixture(t)
  const content = '[[{"id":"a"},{"id":"b"}]]'
  await h.db.insertReport({ id: 'legacy', filename: 'old.link.json', analyzer: 'links', contentType: 'application/json', byteSize: content.length,
    sha256: createHash('sha256').update(content).digest('base64url'), uploadedBy: h.session.userId, uploadedByLogin: 'original', repoId: 1, visible: false }, 123)
  await assert.rejects(h.db.migrateLinkReport('legacy', '[["wrong","bytes"]]'), /content changed/u)
  assert.equal(await h.db.migrateLinkReport('legacy', content), true)
  assert.equal(await h.db.getReport('legacy'), null)
  assert.deepEqual(await h.db.listLinkReports(), [{ id: 'legacy', filename: 'old.link.json', enabled: false, groupCount: 1, findingCount: 2, uploadedByLogin: 'original', uploadedAt: 123 }])
  assert.equal(await h.db.migrateLinkReport('legacy', content), false)
})

test('manager batch and single previews include only relevant global links', async t => {
  const h = await fixture(t)
  await h.seed('first', [{ id: 'a' }, { id: 'b' }])
  await h.seed('second', [{ id: 'c' }])
  await h.upload([['a', 'hidden'], ['hidden', 'b', 'c']])
  const single = await h.send('/api/reports/first', { method: 'GET', headers: { accept: 'application/json' } })
  assert.deepEqual(single.body.links, [['a', 'b']])
  const batch = await h.send('/api/reports/query', { body: { ids: ['first', 'second'] } })
  assert.equal(batch.status, 200)
  assert.deepEqual(batch.body.links, [['a', 'b', 'c']])
})

test('public workspace snapshots project the global graph and invalidate when it changes', async t => {
  const h = await fixture(t)
  await h.seed('first', [{ id: 'a', file: 'src/a.js' }, { id: 'hidden', file: 'node_modules/private/b.js' }])
  await h.seed('second', [{ id: 'b', file: 'src/b.js' }])
  const imported = await h.upload([['a', 'hidden'], ['hidden', 'b']])
  const token = 'public-token-hash'
  await h.db.createWorkspaceShare(sessionId(h.session), Date.now(), 'team', token, { security: true, dependencies: false })
  const snapshot = await h.db.getWorkspaceShare(token)
  const { loadTeamReportsResponse } = await import('../server-managed/team-reports.ts')
  const body = JSON.parse(await loadTeamReportsResponse(h.db, h.store, snapshot))
  assert.deepEqual(body.links, [['a', 'b']])
  assert.equal(body.reports.length, 2)
  assert.equal(JSON.stringify(body).includes('hidden'), false)
  await h.db.setLinkReportEnabled(sessionId(h.session), imported.body.id, false)
  const next = await h.db.getWorkspaceShare(token)
  assert.notEqual(next.linkRevision, snapshot.linkRevision)
  assert.notEqual(next.team.cacheKey, snapshot.team.cacheKey)
  assert.equal(JSON.parse(await loadTeamReportsResponse(h.db, h.store, next)).links, undefined)
})

test('startup migrates legacy blobs into encrypted SQL and deletes both report representations', async t => {
  const { openManagedStorage } = await import('../server-managed/storage.ts')
  const { access } = await import('node:fs/promises')
  const dir = await mkdtemp(join(tmpdir(), 'managed-links-startup-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const config = { dbPath: join(dir, 'db.sqlite') }
  const legacy = await openManagedStorage(config)
  const bytes = Buffer.from('[["a","b"]]'), id = '11111111-1111-4111-8111-111111111111'
  await legacy.reportStore.put(id, bytes)
  await legacy.db.insertReport({ id, filename: 'old.link.json', analyzer: 'links', contentType: 'application/json', byteSize: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('base64url'), uploadedBy: null, repoId: null, visible: true }, 1)
  await legacy.db.close()
  await assert.rejects(openManagedStorage(config), /MANAGED_STORAGE_ENCRYPTION_KEY/u)
  const migrated = await openManagedStorage({ ...config, storageEncryptionKey: key.bytes.toString('base64') })
  try {
    assert.deepEqual(await migrated.db.listReports(), [])
    assert.deepEqual(await migrated.db.getEnabledLinkGroups(await migrated.db.getLinkRevision()), [['a', 'b']])
    await assert.rejects(access(join(dir, 'reports', id)))
    await assert.rejects(access(join(dir, 'reports', `${id}.br`)))
  } finally { await migrated.db.close() }
})
