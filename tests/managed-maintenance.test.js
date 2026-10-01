import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import { mock, test } from 'node:test'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession, readSession } from '../server-managed/session.ts'
import { vercelStores } from './_managed-storage.js'
import { sdkFixture } from './_managed-vercel.js'

let nextStorage
mock.module('../server-managed/storage.ts', { namedExports: { openManagedStorage: () => Promise.resolve(nextStorage) } })
mock.module('../server-managed/static.ts', { namedExports: { loadManagedStatic: () => () => false } })
const { createManagedApp } = await import('../server-managed/index.ts')

const HOUR = 3_600_000
async function fixture(t) {
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'setInterval', () => { throw new Error('serverless maintenance must not create timers') })
  const logs = [], warnings = []
  t.mock.method(console, 'info', message => { logs.push(message) })
  t.mock.method(console, 'warn', (...args) => { warnings.push(args) })
  const config = { serverless: true, sessionCookieName: 'sid', sessionTtlMs: HOUR, cookieSecure: false, dbPath: ':memory:' }
  const db = openSqliteManagedDb(':memory:')
  const { sdk, objects } = sdkFixture()
  const storage = await vercelStores(t, 'test', sdk, db)
  nextStorage = { db, ...storage }
  const app = await createManagedApp(config)
  let closing
  const close = () => closing ??= app.close()
  t.after(close)
  function request() {
    const req = { url: '/api/config', method: 'GET', headers: {} }
    const res = { status: null, ended: false,
      writeHead(status) { this.status = status }, end(body) { this.body = JSON.parse(body); this.ended = true },
    }
    return { res, done: app.handleRequest(req, res) }
  }
  return { app, close, config, db, logs, objects, request, sdk, warnings, advance: ms => { now += ms } }
}

test('ordinary managed traffic reaps three-day-old parts and expired sessions without a cron call', async t => {
  const { config, db, logs, objects, request } = await fixture(t)
  const identity = { githubUserId: 1, login: 'admin', name: null, avatarUrl: null }
  await createSession(config, db, identity, Date.now() - 2 * HOUR)
  const current = await createSession(config, db, identity, Date.now())
  const old = `.managed/uploads/${randomUUID()}`, recent = `.managed/uploads/${randomUUID()}`
  const bundle = `.managed/bundles/${randomUUID()}`, report = `.managed/reports/${randomUUID()}`
  for (const pathname of [old, recent, report, bundle]) {
    objects.set(pathname, { bytes: Buffer.from('stored'), uploadedAt: new Date(Date.now() - (pathname === recent ? HOUR : 72 * HOUR)) })
  }
  const { res, done } = request()
  await done
  assert.equal(res.status, 200)
  assert.equal(res.body.mode, 'managed')
  assert.deepEqual([...objects.keys()], [recent, report, bundle])
  assert.equal(await db.deleteExpiredSessions(Date.now()), 0)
  assert.ok(await readSession(config, db, current.setCookie.split(';')[0], Date.now()))
  assert.equal(logs.length, 1)
  assert.match(logs[0], /managed-reaper: removed 1 expired session\(s\), 1 stale upload part\(s\)/u)
})

test('traffic throttles successful sweeps hourly while explicit cleanup remains available', async t => {
  const { advance, app, logs, request } = await fixture(t)
  await request().done
  await Promise.all([request().done, request().done])
  advance(HOUR - 1)
  await request().done
  assert.equal(logs.length, 1)
  advance(1)
  await request().done
  assert.equal(logs.length, 2)
  await app.reap()
  assert.equal(logs.length, 3, 'explicit cleanup bypasses the automatic cadence')
  await request().done
  assert.equal(logs.length, 3, 'explicit cleanup also updates the next automatic sweep')
})

test('a request sends its response promptly but its invocation and shutdown await coalesced maintenance', async t => {
  const pending = Promise.withResolvers(), started = Promise.withResolvers()
  t.after(() => pending.resolve({ blobs: [], hasMore: false }))
  const { app, close, db, request, sdk } = await fixture(t)
  let lists = 0, requestFinished = false, storageClosed = false
  sdk.list = () => { lists++; started.resolve(); return pending.promise }
  const originalClose = db.close.bind(db)
  t.mock.method(db, 'close', () => { storageClosed = true; return originalClose() })
  const first = request()
  const completed = first.done.then(() => { requestFinished = true; return undefined })
  await started.promise
  await setImmediate()
  assert.equal(first.res.ended, true, 'the response does not wait for the sweep')
  assert.equal(requestFinished, false, 'the invocation keeps the sweep alive')
  await request().done
  const explicit = app.reap()
  assert.equal(lists, 1)
  const closing = close()
  await setImmediate()
  assert.equal(storageClosed, false)
  const stopped = request()
  await stopped.done
  assert.equal(stopped.res.status, 503)
  assert.equal(lists, 1, 'shutdown does not start another sweep')
  pending.resolve({ blobs: [], hasMore: false })
  await Promise.all([completed, explicit, closing])
  assert.equal(storageClosed, true)
})

test('failed automatic sweeps preserve responses, log the failure, and retry after a short backoff', async t => {
  const { advance, logs, objects, request, sdk, warnings } = await fixture(t)
  const old = `.managed/uploads/${randomUUID()}`
  objects.set(old, { bytes: Buffer.from('old'), uploadedAt: new Date(Date.now() - 72 * HOUR) })
  const list = sdk.list
  sdk.list = () => Promise.reject(new Error('storage unavailable'))
  const first = request()
  await first.done
  assert.equal(first.res.status, 200)
  assert.equal(objects.has(old), true)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][0], /managed-reaper: cleanup failed/u)
  assert.equal(logs.length, 0)
  sdk.list = list
  advance(59_999)
  await request().done
  assert.equal(objects.has(old), true)
  advance(1)
  await request().done
  assert.equal(objects.has(old), false)
  assert.equal(logs.length, 1)
})
