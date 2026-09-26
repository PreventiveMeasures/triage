import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { createBundleStore } from '../server-managed/bundle-store.ts'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession } from '../server-managed/session.ts'
import { loadManagedConfig } from '../server-managed/config.ts'
import { UPLOAD_CHUNK_BYTES } from '../server-managed/uploads.ts'

function replaceEnv(values) {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, values)
}

const memoryStore = () => {
  const objects = new Map()
  return {
    get: id => Promise.resolve(objects.get(id) ?? null),
    open: id => Promise.resolve(objects.has(id) ? { size: objects.get(id).length, stream: Readable.from([objects.get(id)]) } : null),
    put: (id, bytes) => { objects.set(id, bytes); return Promise.resolve() },
    delete: id => { objects.delete(id); return Promise.resolve() },
  }
}
let calls = 0, failOnce = true
const db = openSqliteManagedDb(':memory:')
const storage = { db, reportStore: memoryStore(), bundleStore: createBundleStore(memoryStore(), memoryStore()), uploadStore: memoryStore(), avatarStore: { get: () => Promise.resolve(null) } }
mock.module('../server-managed/storage.ts', { namedExports: { openManagedStorage: () => {
  calls++
  if (failOnce) { failOnce = false; return Promise.reject(new Error('test cold-start failure')) }
  return Promise.resolve(storage)
} } })
mock.module('../server-managed/static.ts', { namedExports: { loadManagedStatic: () => () => false } })
const { default: handler } = await import('../api/managed.ts')

async function send(url, { method = 'GET', headers = {}, body = '' } = {}) {
  const req = Readable.from([Buffer.from(body)])
  Object.assign(req, { url, method, headers: { host: 'app.example', 'x-forwarded-proto': 'https', ...headers } })
  const chunks = []
  const res = Object.assign(new Writable({
    write(bytes, _encoding, callback) { chunks.push(Buffer.from(bytes)); callback() },
    final(callback) { this.ended = true; callback() },
  }), {
    status: 200, headers: {}, ended: false,
    writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders; this.headersSent = true },
  })
  await handler(req, res)
  assert.equal(res.ended, true, 'function awaits its request work')
  const bytes = Buffer.concat(chunks)
  return { ...res, bytes, json: () => JSON.parse(bytes) }
}

test('managed function retries failed cold starts, shares initialization, and authenticates chunk uploads', async t => {
  const oldEnv = { ...process.env }
  Object.assign(process.env, { VERCEL: '1', DATABASE_URL: 'postgres://example/test', BLOB_READ_WRITE_TOKEN: 'test', GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret', OAUTH_CALLBACK_URL: 'https://app.example/api/oauth/github/callback' })
  t.after(async () => { replaceEnv(oldEnv); await db.close() })
  const config = loadManagedConfig()
  t.mock.method(globalThis, 'setInterval', () => { throw new Error('serverless app must not install timers') })
  t.mock.method(console, 'error', () => {})
  assert.equal((await send('/api/config')).status, 503)
  const configs = await Promise.all([send('/api/config'), send('/api/config')])
  assert.equal(calls, 2, 'one retry initializes both requests')
  assert.equal(configs[0].json().managed.uploadChunkBytes, UPLOAD_CHUNK_BYTES)
  const session = await createSession(config, db, { githubUserId: 1, login: 'admin', name: null, avatarUrl: null }, Date.now())
  const headers = { cookie: session.setCookie.split(';')[0], 'x-csrf-token': session.csrfToken, origin: 'https://app.example' }
  const id = randomUUID(), path = `/api/admin/uploads/bundles/${id}/0`
  assert.equal((await send(path, { method: 'POST', body: 'part' })).status, 401)
  assert.equal((await send(path, { method: 'POST', headers: { ...headers, 'x-csrf-token': 'bad' }, body: 'part' })).status, 403)
  assert.equal((await send(path, { method: 'POST', headers: { ...headers, origin: 'https://other.example' }, body: 'part' })).status, 403)
  const first = Buffer.alloc(UPLOAD_CHUNK_BYTES, 65), last = Buffer.from('last')
  assert.equal((await send(path, { method: 'POST', headers, body: first })).status, 200)
  assert.equal((await send(`/api/admin/uploads/bundles/${id}/1`, { method: 'POST', headers, body: last })).status, 200)
  const finalize = { ...headers, 'x-upload-id': id, 'x-upload-parts': '2', 'x-upload-size': String(first.length + last.length), 'x-bundle-filename': 'archive.bin' }
  const uploaded = await send('/api/admin/bundles', { method: 'POST', headers: finalize })
  assert.equal(uploaded.status, 201)
  const read = await send(`/api/admin/bundles/${uploaded.json().id}`, { headers })
  assert.deepEqual(read.bytes, Buffer.concat([first, last]), 'large downloads stream complete authorized bytes')
  assert.equal((await send('/api/admin/bundles', { method: 'POST', headers: finalize })).status, 400)
  await db.setUserRole(session.userId, 'view')
  assert.equal((await send(path, { method: 'POST', headers, body: first })).status, 403)
})

test('Vercel configuration fails closed without durable storage or secure OAuth', () => {
  const oldEnv = { ...process.env }
  try {
    replaceEnv({ VERCEL: '1', GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret', OAUTH_CALLBACK_URL: 'https://app.example/api/oauth/github/callback' })
    assert.throws(loadManagedConfig, /DATABASE_URL/u)
    process.env.DATABASE_URL = 'postgres://test'
    assert.throws(loadManagedConfig, /BLOB_READ_WRITE_TOKEN/u)
    process.env.BLOB_READ_WRITE_TOKEN = 'test'
    process.env.OAUTH_CALLBACK_URL = 'http://app.example/api/oauth/github/callback'
    assert.throws(loadManagedConfig, /https/u)
    process.env.OAUTH_CALLBACK_URL = 'https://app.example/api/oauth/github/callback'
    assert.equal(loadManagedConfig().trustProxyEnv, '1')
  } finally { replaceEnv(oldEnv) }
})
