import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'
import { MAX_COMMENT_TEXT } from '../common/managed/comments.ts'

const identity = (githubUserId, login) => ({ githubUserId, login, name: null, avatarUrl: null })
const config = {
  port: 8765, host: '127.0.0.1', dbPath: ':memory:', debug: false,
  githubClientId: 'test', githubClientSecret: 'test', oauthCallbackUrl: 'http://127.0.0.1:8765/api/oauth/github/callback',
  cookieSecure: false, sessionCookieName: 'comments-test', sessionTtlMs: 3_600_000,
  maxReportBytes: 10_485_760, maxBundleBytes: 104_857_600,
}

test('legacy text migrates once without guessing authors; comments survive triage changes and restarts', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'managed-comments-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'managed.sqlite')
  let db = openSqliteManagedDb(path)
  const alice = await db.upsertUser(identity(1, 'alice'), 10)
  await db.setTriage('f', { comment: 'Legacy note', color: 'red' }, alice, 'alice', 20)
  await db.close()
  db = openSqliteManagedDb(path)
  const [legacy] = await db.listComments(['f'])
  assert.equal(legacy.body, 'Legacy note')
  assert.equal(legacy.authorId, null, 'last triage writer is not proof of comment authorship')
  assert.equal(legacy.authorLogin, null)
  assert.equal((await db.listTriage(['f']))[0].comment, null)
  assert.equal((await db.listTriage(['f']))[0].color, 'red')
  assert.equal((await db.listTriageHistory('f', 10))[0].comment, 'Legacy note', 'existing audit history stays intact')
  assert.equal(await db.editComment(legacy.id, alice, 'alice', 'claim ownership', 1, 'r', 30), 'forbidden')
  const added = await db.createComment({ findingId: 'f', body: 'New note', authorId: alice, authorLogin: 'alice' }, 30)
  await db.setTriage('f', null, alice, 'alice', 40)
  assert.equal((await db.listComments(['f'])).length, 2, 'clearing triage does not clear comments')
  await db.close()
  db = openSqliteManagedDb(path)
  assert.deepEqual((await db.listComments(['f'])).map(comment => comment.id), [legacy.id, added.id])
  await db.upsertUser(identity(1, 'renamed'), 50)
  assert.equal((await db.getComment(added.id)).authorLogin, 'renamed')
  await db.close()
  const sql = new DatabaseSync(path)
  sql.exec('PRAGMA foreign_keys=ON')
  sql.prepare('DELETE FROM managed_user WHERE id = ?').run(alice)
  sql.close()
  db = openSqliteManagedDb(path)
  t.after(() => db.close())
  assert.equal((await db.getComment(added.id)).authorId, null)
  assert.equal((await db.getComment(added.id)).authorLogin, 'alice', 'deleted users retain a durable author label')
})

test('comments have independent IDs, ownership, conflict detection, and body-free activity', async (t) => {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const alice = await db.upsertUser(identity(1, 'alice'), 10)
  const bob = await db.upsertUser(identity(2, 'bob'), 10)
  const a = await db.createComment({ findingId: 'f', body: 'Private note A', authorId: alice, authorLogin: 'alice' }, 20)
  const b = await db.createComment({ findingId: 'f', body: 'Private note B', authorId: bob, authorLogin: 'bob' }, 21)
  assert.notEqual(a.id, b.id)
  assert.equal(await db.editComment(a.id, bob, 'bob', 'overwrite', 1, 'r', 22), 'forbidden')
  const [updated, conflict] = await Promise.all([
    db.editComment(a.id, alice, 'alice', 'Edited A', 1, 'r', 30),
    db.editComment(a.id, alice, 'alice', 'Stale A', 1, 'r', 31),
  ])
  assert.equal(updated.body, 'Edited A')
  assert.equal(updated.version, 2)
  assert.equal(updated.createdAt, 20)
  assert.equal(conflict, 'conflict')
  assert.equal((await db.getComment(b.id)).body, 'Private note B')
  assert.deepEqual(await db.editComment(a.id, alice, 'alice', 'Edited A', 2, 'r', 40), updated, 'no-op edits do not restamp the record')
  const history = await db.listActivity({ page: 1, limit: 100, kind: 'triage', query: '', contexts: null })
  assert.equal(history.total, 3)
  assert.equal(history.history[0].action, 'edited a comment')
  assert.doesNotMatch(JSON.stringify(history), /Private note|Edited A|Stale A/u)
  assert.equal((await db.listUsers()).find(user => user.id === alice).lastActivityAt, 30)
  assert.equal((await db.listUsers()).find(user => user.id === bob).lastActivityAt, 21)
  await db.deleteTriage(['f'])
  assert.deepEqual(await db.listComments(['f']), [])
  assert.equal((await db.listActivity({ page: 1, limit: 100, kind: 'all', query: '', contexts: null })).total, 0)
})

async function fixture(t) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const sessions = {}
  for (const [index, [name, role]] of [['admin', 'admin'], ['alice', 'triage'], ['bob', 'manage'], ['reader', 'view'], ['outside', 'triage']].entries()) {
    const session = await createSession(config, db, identity(index + 1, name), Date.now())
    await db.setUserRole(session.userId, role)
    sessions[name] = session
  }
  await db.selectRepo({ repoId: 1, fullName: 'o/r', private: false, installationId: null, defaultBranch: 'main', htmlUrl: 'https://github.com/o/r', addedBy: sessions.admin.userId }, 10)
  await db.createTeam('team', 'Team', 10)
  await db.setTeamRepo('team', 1, 'src')
  for (const name of ['alice', 'bob', 'reader']) await db.setTeamMember('team', sessions[name].userId, { dependencies: false, security: false })
  const reportStore = new Map()
  for (const [id, directory] of [['r', 'src'], ['rescan', 'src'], ['outside', 'private']]) {
    const bytes = Buffer.from(JSON.stringify({ findings: [{ id: 'own', file: 'a.js' }, { id: 'dep', file: 'node_modules/pkg/a.js' }, { id: 'secret', file: 'secret.js', security: true }] }))
    reportStore.set(id, bytes)
    await db.insertReport({ id, filename: `${id}.json`, repoId: 1, repoDirectory: directory, contentType: 'application/json', byteSize: bytes.length, sha256: id, uploadedBy: sessions.admin.userId, bundleId: null, bundleIntegrity: null, visible: true }, 10)
  }
  let pending
  const blobs = { get: id => Promise.resolve(reportStore.get(id) ?? null) }
  const handler = createManagedRequestHandler({
    config, db, reportStore: blobs, bundleStore: {}, avatarStore: {},
    originGate: { trustProxy: false, isOriginAllowed: () => true }, isShuttingDown: () => false, track: promise => { pending = promise },
  })
  async function request(method, path, name, body, csrf = true) {
    const session = sessions[name]
    const req = new Readable({ read() {} })
    req.method = method; req.url = path
    req.headers = { 'content-type': 'application/json' }
    if (session) req.headers.cookie = session.setCookie.split(';', 1)[0]
    if (session && csrf) req.headers['x-csrf-token'] = session.csrfToken
    const res = { statusCode: 0, body: '', headersSent: false,
      writeHead(status) { this.statusCode = status },
      end(data) { this.body = data?.toString() ?? ''; this.headersSent = true },
    }
    handler(req, res)
    if (body !== undefined) req.push(JSON.stringify(body))
    req.push(null)
    await pending
    return { status: res.statusCode, ...JSON.parse(res.body) }
  }
  return { db, sessions, request, blobs }
}

test('comment API enforces author identity, team paths, visibility, CSRF, versions and read-only roles', async (t) => {
  const { db, sessions, request } = await fixture(t)
  const path = '/api/reports/r/comments'
  const payload = { findingId: 'own', body: '  Alice note  ', authorId: sessions.bob.userId, authorLogin: 'spoofed' }
  assert.equal((await request('POST', path, null, payload)).status, 401)
  assert.equal((await request('POST', path, 'alice', payload, false)).status, 403)
  for (const user of ['reader', 'outside']) assert.equal((await request('POST', path, user, payload)).status, 404)
  for (const body of ['', '  ', 123, 'a'.repeat(MAX_COMMENT_TEXT + 1)]) assert.equal((await request('POST', path, 'alice', { ...payload, body })).status, 400)
  for (const findingId of ['dep', 'secret', 'absent']) assert.equal((await request('POST', path, 'alice', { ...payload, findingId })).status, 404)
  assert.equal((await request('POST', '/api/reports/outside/comments', 'bob', payload)).status, 404, 'manager still obeys team paths')
  const first = await request('POST', path, 'alice', payload)
  assert.equal(first.status, 201)
  assert.equal(first.comment.body, 'Alice note')
  assert.equal(first.comment.authorId, sessions.alice.userId)
  assert.equal(first.comment.authorLogin, 'alice')
  const second = await request('POST', path, 'bob', { findingId: 'own', body: 'Bob note' })
  assert.equal(second.status, 201)
  await db.createComment({ findingId: 'own', body: 'Legacy note', authorId: null, authorLogin: null }, 20)
  const hidden = await request('POST', path, 'admin', { findingId: 'dep', body: 'Dependency note' })
  assert.equal(hidden.status, 201)
  const read = await request('GET', path, 'reader')
  assert.equal(read.comments.length, 3)
  assert.ok(read.comments.some(comment => comment.authorId === null))
  assert.equal((await request('GET', path, 'admin')).comments.length, 4)
  assert.equal((await request('GET', '/api/reports/rescan/comments', 'alice')).comments.length, 3, 'same finding shares its discussion across reports')
  const edit = `${path}/${first.comment.id}`
  for (const user of ['bob', 'admin']) assert.equal((await request('PATCH', edit, user, { body: 'Overwrite Alice', version: 1 })).status, 403)
  assert.equal((await request('PATCH', `${path}/${hidden.comment.id}`, 'alice', { body: 'Hidden', version: 1 })).status, 404)
  assert.equal((await request('PATCH', edit, 'alice', { body: 'Edited', version: 1 }, false)).status, 403)
  assert.equal((await request('PATCH', edit, 'alice', { body: 'Edited' })).status, 400)
  const updated = await request('PATCH', edit, 'alice', { body: 'Edited', version: 1 })
  assert.equal(updated.status, 200)
  assert.equal(updated.comment.version, 2)
  assert.equal((await request('PATCH', edit, 'alice', { body: 'Stale', version: 1 })).status, 409)
  assert.equal((await request('PATCH', edit, 'alice', { body: '', version: 2 })).status, 400)
  const legacy = read.comments.find(comment => comment.authorId === null)
  assert.equal((await request('PATCH', `${path}/${legacy.id}`, 'admin', { body: 'Claim legacy', version: 1 })).status, 403)
  assert.equal((await request('POST', '/api/reports/r/triage', 'alice', { entries: { own: { comment: 'Shared overwrite' } } })).status, 400)
  assert.equal((await request('POST', '/api/reports/r/triage', 'alice', { entries: { own: null } })).status, 200)
  assert.equal((await request('GET', path, 'alice')).comments.length, 3)
  const managerHistory = await request('GET', '/api/admin/history?kind=triage', 'bob')
  assert.ok(managerHistory.history.some(event => event.action === 'edited a comment'))
  assert.equal(managerHistory.history.some(event => event.finding === 'dep'), true, 'managers oversee all finding types inside their team content')
  await db.removeTeamRepo('team', 1)
  assert.equal((await request('GET', path, 'alice')).status, 404)
  assert.equal((await request('PATCH', edit, 'alice', { body: 'After revocation', version: 2 })).status, 404)
  assert.equal((await request('GET', '/api/admin/history?kind=triage', 'bob')).history.length, 0)
})

for (const method of ['GET', 'POST', 'PATCH']) {
  for (const revoke of ['team', 'role', 'security']) {
    test(`comments ${method} rechecks ${revoke} access after a cold report read`, async t => {
      const { db, sessions, request, blobs } = await fixture(t)
      const userId = sessions.alice.userId
      await db.setTeamMember('team', userId, { dependencies: false, security: true })
      const comment = await db.createComment({ findingId: 'secret', body: 'Original', authorId: userId, authorLogin: 'alice' }, 20)
      const gate = Promise.withResolvers(), started = Promise.withResolvers()
      const get = blobs.get
      let reads = 0
      blobs.get = async id => {
        if (reads++ === 0) { started.resolve(); await gate.promise }
        return get(id)
      }
      const path = `/api/reports/r/comments${method === 'PATCH' ? `/${comment.id}` : ''}`
      const pending = request(method, path, 'alice', method === 'GET' ? undefined : { findingId: 'secret', body: 'Changed', version: 1 })
      await started.promise
      if (revoke === 'team') await db.removeTeamRepo('team', 1)
      if (revoke === 'role') await db.setUserRole(userId, 'none')
      if (revoke === 'security') await db.setTeamMember('team', userId, { dependencies: false, security: false })
      gate.resolve()
      const result = await pending
      if (method === 'GET' && revoke === 'security') {
        assert.equal(result.status, 200)
        assert.deepEqual(result.comments, [])
      } else assert.equal(result.status, 404)
      assert.deepEqual(await db.listComments(['secret']), [comment], 'revoked access cannot modify or add comments')
    })
  }
}
