import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession } from '../server-managed/session.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { TEAM_FEED_LIFETIME_MS, serveTeamFeed } from '../server-managed/team-feed.ts'
import { recheckTeam, teamSnapshot } from '../server-managed/team-reports.ts'
import { hashToken } from '../server-managed/crypto.ts'

// Node HTTP responses use EventEmitter.
// eslint-disable-next-line unicorn/prefer-event-target
class Response extends EventEmitter {
  headersSent = false
  destroyed = false
  body = ''
  frames = []
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true }
  flushHeaders() {}
  write(value) { this.body += value; this.frames.push(value); return !this.slow }
  end(value = '') { this.body += value; this.ended = true }
  destroy() { this.destroyed = true; this.emit('close') }
}
async function until(check) {
  for (let n = 0; n < 200; n++) { if (check()) return; await delay(5) }
  assert.fail('Timed out waiting for feed')
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'managed-feed-'))
  const path = join(dir, 'db.sqlite')
  const db = openSqliteManagedDb(path, { triageHistoryLimit: 1 })
  const writer = openSqliteManagedDb(path, { triageHistoryLimit: 1 })
  const feeds = []
  t.after(async () => {
    for (const { res, done } of feeds) { res.destroy(); await done }
    await db.close(); await writer.close(); await rm(dir, { recursive: true, force: true })
  })
  const config = { sessionCookieName: 'sid', cookieSecure: false, sessionTtlMs: 3600000, allowShare: true }
  const session = await createSession(config, db, { githubUserId: 1, login: 'viewer', name: null, avatarUrl: null }, Date.now())
  session.id = hashToken(session.setCookie.split(';')[0].slice(4))
  await db.setUserRole(session.userId, 'triage')
  await db.selectRepo({ repoId: 1, fullName: 'own/repo', private: false, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: session.userId }, Date.now())
  await db.createTeam('team', 'Team', Date.now())
  await db.setTeamRepo('team', 1, '')
  await db.setTeamMember('team', session.userId, { security: false, dependencies: false })
  const bytes = Buffer.from(JSON.stringify({ findings: [{ id: 'visible', file: 'app.js' }, { id: 'hidden', file: 'node_modules/dep/a.js' }] }))
  await db.insertReport({ id: 'report', filename: 'report.json', repoId: 1, repoDirectory: '', contentType: 'application/json', byteSize: bytes.length, sha256: 'hash', uploadedBy: session.userId, visible: true, bundleId: null, bundleIntegrity: null }, Date.now())
  const deps = { config, db, reportStore: { get: () => Promise.resolve(bytes) }, isShuttingDown: () => false,
    originGate: { isOriginAllowed: () => true }, track() {} }
  const handler = createManagedRequestHandler(deps)
  function request(url, { cookie = session.setCookie.split(';')[0], method = 'GET', headers = {} } = {}) {
    const req = Readable.from([])
    Object.assign(req, { url, method, headers: { cookie, ...headers } })
    const res = new Response()
    const done = handler(req, res)
    feeds.push({ res, done })
    return { res, done }
  }
  async function feed(options) {
    const snapshot = await teamSnapshot(db, session.id, 'team')
    const res = new Response()
    const done = serveTeamFeed(res, deps, snapshot, () => recheckTeam(db, session.id, snapshot), { pollMs: 10, lifetimeMs: 10000, ...options })
    feeds.push({ res, done })
    await until(() => res.frames.length > 0)
    return { res, done }
  }
  return { db, writer, session, deps, request, feed }
}

test('GET feed checks session, role, team and method before subscribing', async t => {
  const h = await fixture(t)
  for (const [path, options, status] of [
    ['/api/teams/team/feed', { cookie: '' }, 401],
    ['/api/teams/missing/feed', {}, 404],
    ['/api/teams/team/feed', { method: 'POST' }, 405],
  ]) {
    const { res, done } = h.request(path, options); await done
    assert.equal(res.status, status)
  }
  const { res, done } = h.request('/api/teams/team/feed')
  await until(() => res.frames.length > 0)
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /^text\/event-stream/u)
  assert.match(res.headers['cache-control'], /no-store/u)
  assert.equal(res.frames[0], 'event: triage\ndata: {}\n\n')
  res.destroy(); await done
  await h.db.setUserRole(h.session.userId, 'none')
  const blocked = h.request('/api/teams/team/feed'); await blocked.done
  assert.equal(blocked.res.status, 403)
})

test('another instance changes only the visible annotation revision, including clears, comments and purges', async t => {
  const h = await fixture(t), { res } = await h.feed()
  await h.writer.setTriage('hidden', { color: 'red' }, null, null, 1)
  await delay(40)
  assert.equal(res.frames.length, 1, 'hidden changes do not notify this viewer')
  await h.writer.setTriage('visible', { color: 'red' }, null, null, 1)
  await until(() => res.frames.length === 2)
  await h.writer.setTriage('visible', null, null, null, 1)
  await until(() => res.frames.length === 3)
  await h.writer.setTriage('visible', null, null, null, 2)
  await delay(40)
  assert.equal(res.frames.length, 3, 'unchanged writes do not notify')
  const comment = await h.writer.createComment({ findingId: 'visible', body: 'hello', authorId: h.session.userId, authorLogin: 'viewer' }, 3)
  await until(() => res.frames.length === 4)
  await h.writer.editComment(comment.id, h.session.userId, 'viewer', 'edited', 1, 'report', 3)
  await until(() => res.frames.length === 5)
  await h.writer.deleteComment(comment.id, h.session.userId, 'viewer', 2, 'report', 3)
  await until(() => res.frames.length === 6)
  await h.writer.deleteTriage(['visible'])
  await until(() => res.frames.length === 7)
  await h.writer.setTriage('visible', { color: 'blue' }, null, null, 1)
  await until(() => res.frames.length === 8)
  assert.ok(res.frames.every(frame => frame === 'event: triage\ndata: {}\n\n'))
})

for (const change of ['logout', 'membership', 'permission', 'publication']) {
  test(`a live feed closes when ${change} changes access`, async t => {
    const h = await fixture(t), { res, done } = await h.feed()
    if (change === 'logout') await h.writer.deleteSession(h.session.id)
    if (change === 'membership') await h.writer.removeTeamMember('team', h.session.userId)
    if (change === 'permission') await h.writer.setTeamMember('team', h.session.userId, { security: true, dependencies: true })
    if (change === 'publication') await h.writer.setReportVisible('report', false)
    await done
    assert.equal(res.frames.at(-1), 'event: close\ndata: {}\n\n')
    assert.equal(res.ended, true)
  })
}

test('bounded lifetime, shutdown and disconnect stop polling; slow consumers cannot build a queue', async t => {
  assert.ok(TEAM_FEED_LIFETIME_MS < 300_000)
  const h = await fixture(t)
  const expired = await h.feed({ lifetimeMs: 35 })
  await expired.done
  assert.equal(expired.res.ended, true)
  const shutdown = await h.feed()
  h.deps.isShuttingDown = () => true
  await shutdown.done
  assert.equal(shutdown.res.ended, true)
  h.deps.isShuttingDown = () => false
  const disconnected = await h.feed()
  disconnected.res.destroy(); await disconnected.done
  const count = disconnected.res.frames.length
  await h.writer.setTriage('visible', { color: 'green' }, null, null, 5)
  await delay(30)
  assert.equal(disconnected.res.frames.length, count)
  const slow = await h.feed()
  slow.res.slow = true
  await h.writer.setTriage('visible', null, null, null, 6)
  await slow.done
  assert.equal(slow.res.destroyed, true)
})

test('public feeds use only the capability scope and stop when it is revoked', async t => {
  const h = await fixture(t), token = 'a'.repeat(43)
  await h.db.setUserRole(h.session.userId, 'manage')
  await h.db.createWorkspaceShare(h.session.id, Date.now(), 'team', hashToken(token))
  const wrong = h.request('/api/teams/other/feed', { headers: { 'x-deepview-share': token } }); await wrong.done
  assert.equal(wrong.res.status, 404)
  const invalid = h.request('/api/teams/team/feed', { headers: { 'x-deepview-share': 'bad' } }); await invalid.done
  assert.equal(invalid.res.status, 401, 'valid cookie never rescues invalid share')
  const { res, done } = h.request('/api/teams/team/feed', { cookie: '', headers: { 'x-deepview-share': token } })
  await until(() => res.frames.length > 0)
  await h.db.revokeWorkspaceShares(h.session.id, Date.now(), 'team')
  await done
  assert.equal(res.frames.at(-1), 'event: close\ndata: {}\n\n')
})

test('revocation during a revision read closes before emitting an update', async t => {
  const h = await fixture(t)
  const original = h.db.getAnnotationRevision
  h.db.getAnnotationRevision = async ids => {
    const revision = await original(ids)
    await h.writer.removeTeamMember('team', h.session.userId)
    return revision
  }
  const { res, done } = await h.feed()
  await done
  assert.deepEqual(res.frames, ['event: close\ndata: {}\n\n'])
})
