import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession } from '../server-managed/session.ts'
import { createManagedRequestHandler } from '../server-managed/http.ts'
import { vercelStores } from './_managed-storage.js'
import { UPLOAD_CHUNK_BYTES } from '../server-managed/uploads.ts'
import { sdkFixture } from './_managed-vercel.js'

async function fixture(t) {
  const config = { sessionCookieName: 'sid', sessionTtlMs: 3_600_000, cookieSecure: false,
    maxReportBytes: UPLOAD_CHUNK_BYTES + 1, maxBundleBytes: UPLOAD_CHUNK_BYTES + 1 }
  const db = openSqliteManagedDb(':memory:')
  t.after(() => db.close())
  const sessions = {}
  for (const [index, role] of ['admin', 'manage', 'view'].entries()) {
    const session = await createSession(config, db, { githubUserId: index + 1, login: role, name: null, avatarUrl: null }, Date.now())
    await db.setUserRole(session.userId, role)
    sessions[role] = session
  }
  const { sdk, objects } = sdkFixture()
  const storage = await vercelStores(t, 'test', sdk, db)
  const handler = createManagedRequestHandler({ config, db, ...storage,
    originGate: { isOriginAllowed: req => req.headers.origin !== 'blocked' },
    isShuttingDown: () => false, track() {},
  })
  async function send(path, { method = 'POST', body = 'part', role = 'admin', headers = {} } = {}) {
    const session = sessions[role]
    const req = Readable.from([Buffer.from(body)])
    Object.assign(req, { url: path, method, headers: {
      ...(session ? { cookie: session.setCookie.split(';')[0], 'x-csrf-token': session.csrfToken } : {}), ...headers,
    } })
    const res = { status: 200, headersSent: false,
      writeHead(status) { this.status = status }, end(bytes) { this.body = JSON.parse(bytes); this.headersSent = true },
    }
    await handler(req, res)
    return { status: res.status, ...res.body }
  }
  return { config, objects, send, storage }
}

test('oversized report and bundle finalization immediately removes staging without touching published bytes', async t => {
  const { config, objects, send, storage } = await fixture(t)
  const advertised = await send('/api/config', { method: 'GET' })
  assert.deepEqual(advertised.managed.uploadMaxBytes, { reports: config.maxReportBytes, bundles: config.maxBundleBytes })
  for (const kind of ['reports', 'bundles']) {
    const id = randomUUID(), path = `/api/admin/uploads/${kind}/${id}`
    assert.equal((await send(`${path}/0`, { body: Buffer.alloc(UPLOAD_CHUNK_BYTES) })).status, 200)
    assert.equal((await send(`${path}/1`, { body: 'xx' })).status, 200)
    await storage.reportStore.put(id, Buffer.from('saved report'))
    const result = await send(`/api/admin/${kind}`, { body: '', headers: {
      'x-upload-id': id, 'x-upload-parts': '2', 'x-upload-size': String(UPLOAD_CHUNK_BYTES + 2),
    } })
    assert.deepEqual(result, { status: 413, error: 'too-large' })
    assert.equal([...objects.keys()].some(key => key.startsWith('.managed/uploads/')), false)
    assert.equal((await storage.reportStore.get(id)).toString(), 'saved report')
  }
})

test('rejected later chunks discard earlier parts for old clients that do not send cancellation', async t => {
  const { objects, send } = await fixture(t)
  for (const failure of ['index', 'size', 'empty']) {
    const path = `/api/admin/uploads/reports/${randomUUID()}`
    assert.equal((await send(`${path}/0`)).status, 200)
    assert.equal(objects.size, 1)
    const result = await send(`${path}/${failure === 'index' ? 2 : 1}`, {
      body: failure === 'size' ? Buffer.alloc(UPLOAD_CHUNK_BYTES + 1) : '',
    })
    assert.equal(result.status, failure === 'size' ? 413 : 400)
    assert.equal(objects.size, 0, failure)
  }
})

test('upload cancellation requires manager access, CSRF and origin, and only removes the current session and kind', async t => {
  const { objects, send } = await fixture(t)
  const id = randomUUID(), path = `/api/admin/uploads/reports/${id}`
  assert.equal((await send(`${path}/0`)).status, 200)
  assert.equal((await send(`${path}/0`, { role: 'manage' })).status, 200)
  assert.equal((await send(`/api/admin/uploads/bundles/${id}/0`)).status, 200)
  const options = { method: 'DELETE', headers: { 'x-upload-parts': '1' }, body: '' }
  assert.equal((await send(path, { ...options, role: null })).status, 401)
  assert.equal((await send(path, { ...options, role: 'view' })).status, 403)
  for (const headers of [{ 'x-csrf-token': 'wrong' }, { origin: 'blocked' }]) {
    assert.equal((await send(path, { ...options, headers: { ...options.headers, ...headers } })).status, 403)
  }
  assert.equal(objects.size, 3)
  for (const count of ['0', '-1', 'NaN', '1.5', 'Infinity']) {
    assert.equal((await send(path, { ...options, headers: { 'x-upload-parts': count } })).status, 400)
  }
  assert.equal((await send('/api/admin/uploads/reports/invalid', options)).status, 400)
  assert.equal(objects.size, 3)
  assert.equal((await send(path, options)).status, 200)
  assert.equal(objects.size, 2)
  assert.equal((await send(path, options)).status, 200)
  assert.equal(objects.size, 2, 'repeat cancellation is harmless')
  assert.equal((await send(path, { ...options, role: 'manage' })).status, 200)
  assert.equal(objects.size, 1, 'the bundle part is untouched')
})
