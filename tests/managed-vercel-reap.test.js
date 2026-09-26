import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

let closed = 0, opened = 0, reaped = 0
mock.module('../server-managed/db-neon.ts', { namedExports: { openNeonManagedDb: url => {
  assert.equal(url, 'postgres://managed')
  opened++
  return Promise.resolve({ deleteExpiredSessions: now => { assert.ok(now > 0); return Promise.resolve(3) }, close: () => { closed++; return Promise.resolve() } })
} } })
mock.module('../server-managed/blob-vercel.ts', { namedExports: { openManagedVercelStorage: token => {
  assert.equal(token, 'blob')
  return Promise.resolve({ reapUploads: () => { reaped++; return Promise.resolve() } })
} } })
const { default: handler } = await import('../api/managed-reap.ts')

async function request(authorization, method = 'GET') {
  const res = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value }, end(body) { this.body = body } }
  await handler({ method, headers: { authorization } }, res)
  return res
}

test('managed cleanup is fail-closed, method-limited, and closes its database', async t => {
  const keys = ['CRON_SECRET', 'MANAGED_DATABASE_URL', 'DATABASE_URL', 'BLOB_READ_WRITE_TOKEN']
  const before = keys.map(key => process.env[key])
  t.after(() => { keys.forEach((key, i) => { if (before[i] == null) delete process.env[key]; else process.env[key] = before[i] }) })
  delete process.env.CRON_SECRET
  assert.equal((await request('Bearer secret')).statusCode, 401)
  process.env.CRON_SECRET = 'secret'
  assert.equal((await request('Bearer other')).statusCode, 401)
  assert.equal((await request('Bearer secret', 'POST')).statusCode, 405)
  assert.equal(opened, 0)
  process.env.MANAGED_DATABASE_URL = 'postgres://managed'
  process.env.DATABASE_URL = 'postgres://e2e'
  process.env.BLOB_READ_WRITE_TOKEN = 'blob'
  const response = await request('Bearer secret')
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(response.body), { ok: true, deleted: 3 })
  assert.equal(opened, 1)
  assert.equal(closed, 1)
  assert.equal(reaped, 1)
})
