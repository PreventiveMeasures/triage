import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

let fail = false, opened = 0, sessions = 0, uploads = 0
mock.module('../server-managed/storage.ts', { namedExports: { openManagedStorage: () => {
  opened++
  if (fail) return Promise.reject(new Error('cold start failed'))
  return Promise.resolve({
    db: { deleteExpiredSessions: () => { sessions++; return Promise.resolve(3) } },
    reapUploads: () => { uploads++; return Promise.resolve() },
  })
} } })
mock.module('../server-managed/static.ts', { namedExports: { loadManagedStatic: () => () => false } })

async function request(handler, authorization, method = 'GET') {
  const res = { statusCode: 200, headers: {}, writeHead(status, headers) { this.statusCode = status; this.headers = headers }, end(body) { this.body = body } }
  await handler({ url: '/api/reap', method, headers: { authorization } }, res)
  return res
}

test('managed function owns /api/reap and authenticates before initializing the active app', async t => {
  const keys = ['VERCEL', 'CRON_SECRET', 'E2E_DATABASE_URL', 'MANAGED_DATABASE_URL', 'DATABASE_URL', 'BLOB_READ_WRITE_TOKEN', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'OAUTH_CALLBACK_URL']
  const before = keys.map(key => process.env[key])
  t.after(() => { keys.forEach((key, i) => { if (before[i] == null) delete process.env[key]; else process.env[key] = before[i] }) })
  t.mock.method(console, 'error', () => {})
  t.mock.method(globalThis, 'setInterval', () => { throw new Error('serverless cleanup must not start timers') })
  for (const key of keys) delete process.env[key]
  Object.assign(process.env, {
    VERCEL: '1', CRON_SECRET: 'secret', BLOB_READ_WRITE_TOKEN: 'blob', GITHUB_CLIENT_ID: 'client',
    GITHUB_CLIENT_SECRET: 'client-secret', OAUTH_CALLBACK_URL: 'https://app.example/api/oauth/github/callback',
  })
  const { default: handler } = await import('../api/managed.ts')
  assert.equal((await request(handler, 'Bearer wrong')).statusCode, 401)
  assert.equal((await request(handler, 'Bearer secret', 'POST')).statusCode, 405)
  assert.equal(opened, 0)
  process.env.E2E_DATABASE_URL = 'postgres://e2e'
  assert.equal((await request(handler, 'Bearer secret')).statusCode, 500)
  assert.equal(opened, 0, 'no managed URL fails before storage')
  process.env.MANAGED_DATABASE_URL = 'postgres://managed'
  process.env.DATABASE_URL = 'postgres://shared'
  assert.equal((await request(handler, 'Bearer secret')).statusCode, 500)
  assert.equal(opened, 0, 'ambiguous URLs fail before storage')
  delete process.env.DATABASE_URL
  fail = true
  assert.equal((await request(handler, 'Bearer secret')).statusCode, 500)
  fail = false
  const response = await request(handler, 'Bearer secret')
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(response.body).reaped, ['managed'])
  assert.equal((await request(handler, 'Bearer secret')).statusCode, 200)
  assert.equal(opened, 2, 'retry initializes once and later requests reuse the app')
  assert.equal(sessions, 2)
  assert.equal(uploads, 2)
})
