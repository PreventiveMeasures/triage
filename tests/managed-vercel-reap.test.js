import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

let closed = 0, reaped = 0
const opened = []
mock.module('../server-managed/db-neon.ts', { namedExports: { openNeonManagedDb: url => {
  opened.push(url)
  return Promise.resolve({ deleteExpiredSessions: () => Promise.resolve(3), close: () => { closed++; return Promise.resolve() } })
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

test('managed cleanup uses shared or dedicated URLs and rejects ambiguous configuration before opening storage', async t => {
  const keys = ['CRON_SECRET', 'E2E_DATABASE_URL', 'MANAGED_DATABASE_URL', 'DATABASE_URL', 'BLOB_READ_WRITE_TOKEN']
  const before = keys.map(key => process.env[key])
  t.after(() => { keys.forEach((key, i) => { if (before[i] == null) delete process.env[key]; else process.env[key] = before[i] }) })
  t.mock.method(console, 'error', () => {})
  for (const key of keys) delete process.env[key]
  assert.equal((await request('Bearer secret')).statusCode, 401)
  process.env.CRON_SECRET = 'secret'
  assert.equal((await request('Bearer other')).statusCode, 401)
  assert.equal((await request('Bearer secret', 'POST')).statusCode, 405)
  assert.equal(opened.length, 0)
  process.env.BLOB_READ_WRITE_TOKEN = 'blob'
  process.env.E2E_DATABASE_URL = 'postgres://e2e'
  assert.equal((await request('Bearer secret')).statusCode, 500, 'e2e-only URL does not select the managed database')
  process.env.MANAGED_DATABASE_URL = 'postgres://managed'
  const response = await request('Bearer secret')
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(response.body), { ok: true, deleted: 3 })
  process.env.DATABASE_URL = 'postgres://shared'
  assert.equal((await request('Bearer secret')).statusCode, 500)
  delete process.env.MANAGED_DATABASE_URL
  assert.equal((await request('Bearer secret')).statusCode, 500, 'global URL also conflicts with e2e-specific URL')
  assert.deepEqual(opened, ['postgres://managed'])
  delete process.env.E2E_DATABASE_URL
  assert.equal((await request('Bearer secret')).statusCode, 200)
  assert.deepEqual(opened, ['postgres://managed', 'postgres://shared'])
  assert.equal(closed, 2)
  assert.equal(reaped, 2)
})
