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
import { TEAM_FEED_LIFETIME_MS, serveTeamFeed, serveUserTeamFeed } from '../server-managed/team-feed.ts'
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
  async function userFeed(teamId = 'team', options = {}) {
    const { user } = await db.sessionWithUser(session.id, Date.now())
    const res = new Response()
    const done = serveUserTeamFeed(res, deps, session.id, user, teamId, { pollMs: 10, lifetimeMs: 10000, ...options })
    feeds.push({ res, done })
    await until(() => res.frames.length > 0)
    return { res, done }
  }
  return { db, writer, session, deps, request, feed, userFeed }
}

test('GET feed checks session, role, team and method before subscribing', async t => {
  const h = await fixture(t)
  for (const [path, options, status] of [
    ['/api/teams/team/feed', { cookie: '' }, 401],
    ['/api/teams/feed', { cookie: '' }, 401],
    ['/api/teams/feed', { method: 'POST' }, 405],
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
  assert.match(res.frames[0], /^event: teams\ndata: \{"revision":"[\w-]{43}"\}\n\n$/u)
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

const teamEvents = res => res.frames.filter(frame => frame.startsWith('event: teams\n')).length
const eventNames = res => res.frames.map(frame => frame.split('\n')[0])
const triageEvents = res => res.frames.filter(frame => frame === 'event: triage\ndata: {}\n\n').length

test('REST catalogs and feed confirmations share a version that changes with this user\'s visible access', async t => {
  const h = await fixture(t)
  async function catalog() {
    const { res, done } = h.request('/api/teams')
    await done
    assert.equal(res.status, 200)
    return JSON.parse(res.body)
  }
  const initial = await catalog()
  assert.match(initial.revision, /^[\w-]{43}$/u)
  const { res } = await h.userFeed(null)
  const revisions = () => res.frames.filter(frame => frame.startsWith('event: teams\n'))
    .map(frame => JSON.parse(frame.split('\n')[1].slice(6)).revision)
  assert.deepEqual(revisions(), [initial.revision], 'the first feed event confirms the already-loaded catalog')
  await h.writer.setTeamMember('team', h.session.userId, { security: true, dependencies: false })
  await until(() => teamEvents(res) === 2)
  const changed = await catalog()
  assert.notEqual(changed.revision, initial.revision)
  assert.equal(revisions().at(-1), changed.revision)
  await h.writer.removeTeamMember('team', h.session.userId)
  await until(() => teamEvents(res) === 3)
  const removed = await catalog()
  assert.deepEqual(removed.teams, [])
  assert.equal(revisions().at(-1), removed.revision)
})

test('one feed covers own memberships and all member teams, but only focused triage', async t => {
  const h = await fixture(t), { writer, session } = h
  await writer.createTeam('other', 'Other', 1)
  await writer.createTeam('foreign', 'Foreign', 1)
  await writer.selectRepo({ repoId: 2, fullName: 'own/other', private: false, installationId: null, defaultBranch: 'main', htmlUrl: '', addedBy: session.userId }, 1)
  await writer.setTeamRepo('other', 2, '')
  const { res } = await h.userFeed()
  assert.equal(teamEvents(res), 1)
  assert.equal(triageEvents(res), 1)
  await writer.renameTeam('foreign', 'Unrelated rename', 2)
  await delay(40)
  assert.equal(teamEvents(res), 1)
  await writer.setTeamMember('other', session.userId, { security: false, dependencies: false })
  await until(() => teamEvents(res) === 2)
  await writer.insertReport({ id: 'other-report', filename: 'other.json', repoId: 2, contentType: 'application/json', byteSize: 10, sha256: 'other-hash', uploadedBy: session.userId, visible: true }, 2)
  await until(() => teamEvents(res) === 3)
  await writer.insertBundle({ id: 'bundle', filename: 'bundle.stasis', byteSize: 10, integrity: 'bundle-hash', uploadedBy: session.userId, repoId: 2, kind: 'stasis' }, 2)
  await until(() => teamEvents(res) === 4)
  await writer.setTriage('other-finding', { color: 'red' }, null, null, 2)
  await writer.createComment({ findingId: 'other-finding', body: 'Other team comment', authorId: session.userId, authorLogin: 'viewer' }, 2)
  await delay(40)
  assert.equal(teamEvents(res), 4, 'annotations do not invalidate the catalog')
  assert.equal(triageEvents(res), 1, 'unfocused annotations are not subscribed')
  await writer.setTriage('visible', { color: 'green' }, null, null, 2)
  await until(() => triageEvents(res) === 2)
  await writer.deleteBundle('bundle')
  await until(() => teamEvents(res) === 5)
  await writer.setReportVisible('other-report', false)
  await until(() => teamEvents(res) === 6)
  await writer.removeTeamMember('other', session.userId)
  await until(() => teamEvents(res) === 7)
  assert.equal(res.ended, undefined)
  assert.ok(res.frames.every(frame => /^event: (teams\ndata: \{"revision":"[\w-]{43}"\}|triage\ndata: \{\})\n\n$/u.test(frame)))
})

test('repairing a report link to an existing bundle notifies the feed across instances', async t => {
  const h = await fixture(t), { writer, session } = h
  await writer.insertBundle({ id: 'bundle', integrity: 'bundle-hash', filename: 'bundle.stasis', kind: 'stasis',
    byteSize: 1, uploadedBy: session.userId, repoId: 1 }, 1)
  await writer.insertReport({ id: 'unlinked', filename: 'unlinked.json', contentType: 'application/json', byteSize: 1,
    sha256: 'unlinked-hash', uploadedBy: session.userId, repoId: 1, visible: true, bundleIntegrity: 'bundle-hash' }, 1)
  const before = await h.db.listTeamsForUser(session.userId)
  const { res } = await h.userFeed()
  await writer.linkReportsToBundle('bundle-hash', 'bundle', session.userId)
  await until(() => teamEvents(res) === 2)
  const after = await h.db.listTeamsForUser(session.userId)
  assert.deepEqual(after[0].bundles, before[0].bundles)
  assert.notEqual(after[0].reports.find(r => r.id === 'unlinked').cacheKey, before[0].reports.find(r => r.id === 'unlinked').cacheKey)
  await writer.linkReportsToBundle('bundle-hash', 'bundle', session.userId)
  await delay(40)
  assert.equal(teamEvents(res), 2, 'an already repaired link does not notify again')
})

test('catalog-only feed works with no memberships and observes empty-team grants and scopes', async t => {
  const h = await fixture(t)
  await h.writer.removeTeamMember('team', h.session.userId)
  const { res } = await h.userFeed(null)
  h.db.getAnnotationRevision = () => { assert.fail('catalog feed must not read annotations') }
  h.deps.reportStore.get = () => { assert.fail('catalog feed must not read report bytes') }
  await h.writer.createTeam('empty', 'Empty', 1)
  await h.writer.setTeamMember('empty', h.session.userId, { security: false, dependencies: false })
  await until(() => teamEvents(res) === 2)
  await h.writer.setTeamMember('empty', h.session.userId, { security: true, dependencies: false })
  await until(() => teamEvents(res) === 3)
  await h.writer.setTeamRepo('empty', 1, 'empty/path')
  await until(() => teamEvents(res) === 4)
  assert.equal(triageEvents(res), 0)
  await h.writer.renameTeam('empty', 'Renamed', 2)
  await until(() => teamEvents(res) === 5)
  const http = h.request('/api/teams/feed')
  await until(() => http.res.frames.length > 0)
  assert.deepEqual(eventNames(http.res), ['event: teams'])
})

test('losing the focused team preserves the catalog feed and stops its annotation reads', async t => {
  const h = await fixture(t), { res } = await h.userFeed()
  await h.writer.removeTeamMember('team', h.session.userId)
  await until(() => teamEvents(res) === 2)
  const triage = triageEvents(res)
  await h.writer.setTriage('visible', { color: 'red' }, null, null, 2)
  await delay(40)
  assert.equal(triageEvents(res), triage)
  assert.equal(res.ended, undefined)
  await h.writer.setTeamMember('team', h.session.userId, { security: false, dependencies: false })
  await until(() => teamEvents(res) === 3 && triageEvents(res) === triage + 1)
})

test('revocation during an annotation read discards the poll, then reports membership loss only', async t => {
  const h = await fixture(t), { res } = await h.userFeed()
  const original = h.db.getAnnotationRevision
  h.db.getAnnotationRevision = async ids => {
    const revision = await original(ids)
    await h.writer.removeTeamMember('team', h.session.userId)
    return revision
  }
  await h.writer.setTriage('visible', { color: 'red' }, null, null, 2)
  await until(() => teamEvents(res) === 2)
  assert.equal(triageEvents(res), 1)
})

for (const change of ['logout', 'role']) {
  test(`user feed terminates on ${change} without further events`, async t => {
    const h = await fixture(t), { res, done } = await h.userFeed(null)
    if (change === 'logout') await h.writer.deleteSession(h.session.id)
    else await h.writer.setUserRole(h.session.userId, 'none')
    await done
    assert.deepEqual(eventNames(res), ['event: teams', 'event: close'])
  })
}

test('public shares cannot subscribe to the user catalog even with an issuer cookie', async t => {
  const h = await fixture(t), token = 'b'.repeat(43)
  await h.db.setUserRole(h.session.userId, 'manage')
  await h.db.createWorkspaceShare(h.session.id, Date.now(), 'team', hashToken(token))
  const { res, done } = h.request('/api/teams/feed', { headers: { 'x-deepview-share': token } })
  await done
  assert.equal(res.status, 403)
})

test('focused visibility is recomputed after grant and report publication changes', async t => {
  const h = await fixture(t), { res } = await h.userFeed()
  await h.writer.setTeamMember('team', h.session.userId, { security: true, dependencies: true })
  await until(() => teamEvents(res) === 2 && triageEvents(res) === 2)
  await h.writer.setTriage('hidden', { color: 'red' }, null, null, 1)
  await until(() => triageEvents(res) === 3)
  await h.writer.setReportVisible('report', false)
  await until(() => teamEvents(res) === 3 && triageEvents(res) === 4)
  await h.writer.setTriage('hidden', { color: 'blue' }, null, null, 2)
  await delay(40)
  assert.equal(triageEvents(res), 4)
  assert.equal(res.ended, undefined)
})

test('catalog invalidation arrives before a focused report finishes loading', async t => {
  const gate = Promise.withResolvers(), h = await fixture(t)
  const bytes = await h.deps.reportStore.get('report')
  h.deps.reportStore.get = () => gate.promise
  try {
    const { res } = await h.userFeed()
    assert.deepEqual(eventNames(res), ['event: teams'])
    gate.resolve(bytes)
    await until(() => triageEvents(res) === 1)
  } finally { gate.resolve(bytes) }
})

for (const failure of ['missing', 'malformed', 'storage error']) {
  test(`${failure} report blobs suspend triage but preserve catalog updates and recover on repair`, async t => {
    const h = await fixture(t), original = h.deps.reportStore.get
    let broken = true
    h.deps.reportStore.get = id => {
      if (id !== 'broken' || !broken) return original(id)
      if (failure === 'storage error') return Promise.reject(new Error('Blob store unavailable'))
      return Promise.resolve(failure === 'missing' ? null : Buffer.from('{broken json'))
    }
    const { res } = await h.userFeed()
    await until(() => triageEvents(res) === 1)
    await h.writer.insertReport({ id: 'broken', filename: 'broken.json', contentType: 'application/json',
      byteSize: 12, sha256: 'broken', uploadedBy: h.session.userId, repoId: 1, visible: true }, 1)
    await until(() => teamEvents(res) === 2)
    await h.writer.createTeam('new', 'New team', 1)
    await h.writer.setTeamMember('new', h.session.userId, { security: false, dependencies: false })
    await until(() => teamEvents(res) === 3)
    await h.writer.insertBundle({ id: 'bundle', integrity: 'bundle-hash', filename: 'bundle.stasis', kind: 'stasis',
      byteSize: 1, uploadedBy: h.session.userId, repoId: 1 }, 1)
    await until(() => teamEvents(res) === 4)
    assert.equal(triageEvents(res), 1)
    assert.equal(res.ended, undefined)
    assert.ok(res.frames.every(frame => !frame.includes('event: close')))
    broken = false
    await until(() => triageEvents(res) === 2)
    assert.equal(teamEvents(res), 4, 'repair needs no catalog change or reconnect')
    await h.writer.deleteSession(h.session.id)
    await until(() => res.ended)
    assert.equal(res.frames.at(-1), 'event: close\ndata: {}\n\n')
  })
}

test('session revocation during a catalog read prevents its early invalidation', async t => {
  const h = await fixture(t), original = h.db.getUserTeamFeedSnapshot
  h.db.getUserTeamFeedSnapshot = async (...args) => {
    const catalog = await original(...args)
    await h.writer.deleteSession(h.session.id)
    return catalog
  }
  const { res, done } = await h.userFeed()
  await done
  assert.deepEqual(res.frames, ['event: close\ndata: {}\n\n'])
})
