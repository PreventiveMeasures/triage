import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { createSession } from '../server-managed/session.ts'
import { hashToken } from '../server-managed/crypto.ts'
import { packageOf, registry, withToken } from './_managed-npm.js'

async function fixture(t) {
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const config = { sessionCookieName: 'sid', sessionTtlMs: 3600000 }
  const sessions = {}
  for (const [i, role] of ['admin', 'triage', 'view'].entries()) {
    const session = await createSession(config, db, { githubUserId: i + 1, login: role, name: null, avatarUrl: null }, Date.now())
    await db.setUserRole(session.userId, role)
    sessions[role] = session
  }
  const handler = createManagedRequestHandler({ db, config, originGate: { isOriginAllowed: () => true }, isShuttingDown: () => false, track() {} })
  async function send(path, { body, who = 'triage', csrf = true, method = body ? 'POST' : 'GET' } = {}) {
    const session = sessions[who]
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { url: path, method,
      headers: { ...(session ? { cookie: session.setCookie.split(';')[0], ...(csrf ? { 'x-csrf-token': session.csrfToken } : {}) } : {}) } })
    // ServerResponse exposes Node's EventEmitter contract.
    // eslint-disable-next-line unicorn/prefer-event-target
    const res = Object.assign(new EventEmitter(), { status: 0, headers: {}, body: '',
      writeHead(status, headers) { this.status = status; this.headers = headers }, end(value) { this.body = JSON.parse(value); this.writableEnded = true } })
    await handler(req, res)
    return res
  }
  return { db, sessions, send }
}
const url = context => `/api/npm/reviews?${new URLSearchParams(Object.entries(context).filter(([, value]) => value !== null))}`

test('review API validates bytes and file scope, protects identity, and publishes whole sets', async t => {
  const h = await fixture(t)
  const after = packageOf('lib', '2.0.0', { 'index.js': 'new\n' })
  const before = packageOf('lib', '1.0.0', { 'removed.js': 'gone\n' })
  registry(t, [after, before])
  const context = { ecosystem: 'npm', package: 'lib', version: '2.0.0', integrity: after.doc.dist.integrity,
    basePackage: 'lib', baseVersion: '1.0.0', baseIntegrity: before.doc.dist.integrity }
  const body = { ...context, action: 'save', file: 'removed.js', comment: 'Intentional removal', status: 'accept', user: 'forged' }
  assert.equal((await h.send(url(context), { who: 'anonymous' })).status, 401)
  assert.equal((await h.send('/api/npm/reviews', { body, csrf: false })).status, 403)
  assert.equal((await h.send('/api/npm/reviews', { body, who: 'view' })).status, 403)
  for (const patch of [{ status: 'approve' }, { status: ['accept'] }, { action: ['save'] }, { status: null, comment: '' }, { comment: 'x'.repeat(20001) }, { file: '../escape' }]) {
    assert.equal((await h.send('/api/npm/reviews', { body: { ...body, ...patch } })).status, 400)
  }
  for (const patch of [{ integrity: 'sha512-wrong' }, { baseIntegrity: 'sha512-wrong' }, { version: 'latest' }]) {
    assert.equal((await h.send('/api/npm/reviews', { body: { ...body, ...patch } })).status, 409)
  }
  const saved = await h.send('/api/npm/reviews', { body })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  const review = saved.body.review
  assert.equal(review.user, h.sessions.triage.userId)
  assert.equal(review.entries[0].file, 'removed.js', 'removed files are reviewable against the base')
  assert.equal((await h.send(url(context), { who: 'admin' })).body.reviews.length, 0, 'admin sees no other user private review')
  await h.db.createTeam('team', 'Team', Date.now())
  await h.db.setTeamMember('team', h.sessions.triage.userId, { dependencies: false, security: false })
  const toggle = { teamId: 'team', enabled: true }
  assert.equal((await h.send('/api/admin/teams/set-dependency-review', { body: toggle })).status, 403)
  assert.equal((await h.send('/api/admin/teams/set-dependency-review', { body: toggle, who: 'admin' })).status, 200)
  assert.deepEqual((await h.send(url(context))).body.teams, [{ id: 'team', name: 'Team' }])
  const publish = { ...context, action: 'publish', reviewId: review.id, revision: review.revision, teamIds: [], finalStatus: 'accept', finalComment: 'Removal checked.' }
  assert.equal((await h.send('/api/npm/reviews', { body: publish })).status, 400)
  const published = await h.send('/api/npm/reviews', { body: { ...publish, teamIds: ['team'] } })
  assert.equal(published.status, 200)
  assert.ok(published.body.review.publishedAt)
  assert.equal(published.body.review.coverage, 'partial')
  assert.equal(published.body.review.checkedFiles, 1)
  assert.equal(published.body.review.totalFiles, 2)
  assert.equal(published.body.review.status, 'accept')
  assert.equal(published.body.review.comment, 'Removal checked.')
  assert.equal((await h.send('/api/npm/reviews/mine')).body.reviews[0].id, review.id)
  assert.deepEqual((await h.send('/api/npm/reviews/mine', { who: 'admin' })).body.reviews, [])
  const edited = await h.send('/api/npm/reviews', { body: { ...body, reviewId: review.id, revision: published.body.review.revision, entryId: review.entries[0].id, comment: 'overwrite' } })
  assert.equal(edited.status, 409)
})

test('reviews recheck private access to both packages, including before publication', async t => {
  const h = await fixture(t)
  withToken(t)
  const after = packageOf('public', '2.0.0', { 'index.js': 'new' })
  const before = { ...packageOf('@private/base', '1.0.0', { 'index.js': 'old' }), private: true }
  registry(t, [after, before])
  const context = { ecosystem: 'npm', package: 'public', version: '2.0.0', integrity: after.doc.dist.integrity,
    basePackage: '@private/base', baseVersion: '1.0.0', baseIntegrity: before.doc.dist.integrity }
  assert.equal((await h.send(url(context))).status, 404)
  await h.db.createTeam('team', 'Team', Date.now())
  await h.db.setTeamMember('team', h.sessions.triage.userId, { dependencies: false, security: false })
  const adminId = hashToken(h.sessions.admin.setCookie.split(';')[0].slice(4))
  await h.db.setTeamNpmScopes(adminId, 'team', ['@private'])
  await h.db.setTeamDependencyReview(adminId, 'team', true)
  const saved = await h.send('/api/npm/reviews', { body: { ...context, action: 'save', file: 'index.js', status: 'reject', comment: 'Do not upgrade' } })
  assert.equal(saved.status, 200)
  await h.db.setTeamNpmScopes(adminId, 'team', [])
  assert.equal((await h.send(url(context))).status, 404)
  assert.equal((await h.send('/api/npm/reviews', { body: { ...context, action: 'publish', reviewId: saved.body.review.id, revision: 1, teamIds: ['team'] } })).status, 404)
})

test('final verdict is mandatory and constrained, while coverage is derived from package bytes', async t => {
  const h = await fixture(t)
  const pkg = packageOf('all-files', '1.0.0', { 'a.js': 'a', 'b.js': 'b', 'c.bin': Buffer.from([0, 255]), 'empty': '' })
  registry(t, [pkg])
  await h.db.createTeam('team', 'Team', Date.now())
  await h.db.setTeamMember('team', h.sessions.triage.userId, { dependencies: false, security: false })
  await h.send('/api/admin/teams/set-dependency-review', { who: 'admin', body: { teamId: 'team', enabled: true } })
  const context = { ecosystem: 'npm', package: 'all-files', version: '1.0.0', integrity: pkg.doc.dist.integrity }
  let review = (await h.send('/api/npm/reviews', { body: { ...context, action: 'start' } })).body.review
  assert.deepEqual(review.entries, [])
  const publish = patch => h.send('/api/npm/reviews', { body: { ...context, action: 'publish', reviewId: review.id,
    revision: review.revision, teamIds: ['team'], files: [], coverage: 'full', ...patch } })
  assert.equal((await publish({})).status, 400, 'a final verdict is required even with no checks')
  for (const file of ['a.js', 'b.js', 'c.bin']) {
    review = (await h.send('/api/npm/reviews', { body: { ...context, action: 'save', reviewId: review.id, revision: review.revision,
      file, status: file === 'b.js' ? 'request-changes' : 'accept', comment: '' } })).body.review
  }
  assert.equal((await publish({ finalStatus: 'accept' })).status, 400)
  assert.equal((await publish({ finalStatus: 'accept-with-nits' })).status, 400)
  const result = await publish({ finalStatus: 'request-changes', finalComment: 'Check the remaining file.' })
  assert.equal(result.status, 200)
  review = result.body.review
  assert.equal(review.coverage, 'partial')
  assert.equal(review.totalFiles, 4, 'client cannot forge file coverage')
  assert.equal(review.checkedFiles, 3)
  assert.equal(review.comment, 'Check the remaining file.')
  assert.equal((await publish({ finalStatus: 'reject', finalComment: 'Overwrite' })).status, 409, 'the final verdict is frozen too')
  assert.equal((await h.send('/api/npm/reviews/mine', { who: 'anonymous' })).status, 401)
  assert.equal((await h.send('/api/npm/reviews/mine?beforeTime=oops&beforeId=id')).status, 400)
})


test('a saved verdict can be cleared without adding a note, leaving publication unavailable', async t => {
  const h = await fixture(t), pkg = packageOf('clear-verdict', '1.0.0', { 'index.js': 'new\n' })
  registry(t, [pkg])
  const context = { ecosystem: 'npm', package: pkg.doc.name, version: '1.0.0', integrity: pkg.doc.dist.integrity }
  const saved = await h.send('/api/npm/reviews', { body: { ...context, action: 'save', file: 'index.js', status: 'accept', comment: '' } })
  assert.equal(saved.status, 200)
  const review = saved.body.review
  const cleared = await h.send('/api/npm/reviews', { body: { ...context, action: 'save', file: 'index.js', status: null, comment: '',
    reviewId: review.id, revision: review.revision, entryId: review.entries[0].id } })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.body.review.entries[0].status, null)
  assert.equal(cleared.body.review.entries[0].comment, '')
})
