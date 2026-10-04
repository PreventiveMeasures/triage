import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

const state = { maintenance: null, released: false }
mock.module('../server-managed/storage.ts', { namedExports: { openManagedStorage: () => Promise.resolve({
  db: {
    deleteExpiredSessions: () => Promise.resolve(0),
    claimMaintenanceLease: () => Promise.resolve(true),
    finishMaintenanceLease: () => { state.released = true; return Promise.resolve() },
  },
  reapStorage: () => state.maintenance.promise,
}) } })
mock.module('../server-managed/static.ts', { namedExports: { loadManagedStatic: () => () => false } })
mock.module('../server-managed/config.ts', { namedExports: { loadManagedConfig: () => ({ host: 'localhost', serverless: true }) } })

for (const fail of [false, true]) {
  test(`Vercel ordinary responses retain maintenance with waitUntil (failure: ${fail})`, async t => {
    state.maintenance = Promise.withResolvers()
    state.released = false
    const contextKey = Symbol.for('@vercel/request-context')
    const original = Object.getOwnPropertyDescriptor(globalThis, contextKey)
    const retained = [], warnings = []
    Object.defineProperty(globalThis, contextKey, { configurable: true, value: { get: () => ({ waitUntil: promise => retained.push(promise) }) } })
    t.after(() => { if (original) Object.defineProperty(globalThis, contextKey, original); else delete globalThis[contextKey] })
    t.mock.method(console, 'info', () => {})
    t.mock.method(console, 'warn', (...args) => warnings.push(args))
    const { default: handler } = await import(`../api/managed.ts?lifetime=${fail}`)
    const ended = Promise.withResolvers()
    const res = { writeHead(status) { this.status = status }, end() { ended.resolve() } }
    const request = handler({ url: '/api/config', method: 'GET', headers: {} }, res)
    assert.equal(retained.length, 1, 'register work before any response can end')
    assert.equal(retained[0], request, 'register the entire handler, not only its response')
    let settled = false
    retained[0].finally(() => { settled = true })
    try {
      await ended.promise
      assert.equal(res.status, 200)
      assert.equal(settled, false, 'the HTTP response can finish while Vercel still holds pending maintenance')
      assert.equal(state.released, false)
      if (fail) state.maintenance.reject(new Error('maintenance test failure'))
      else state.maintenance.resolve()
      await Promise.all(retained)
      assert.equal(settled, true)
      assert.equal(state.released, true, 'waitUntil covers releasing the database maintenance lease too')
      assert.equal(warnings.length, fail ? 1 : 0)
    } finally { state.maintenance.resolve(); await request }
  })
}
