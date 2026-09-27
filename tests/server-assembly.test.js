import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { initializeApp } from '../server-common/initialize.ts'

const cases = []
for (const mode of ['e2e', 'managed', 'managed-e2e', 'e2e-managed']) {
  for (const fault of ['directory', 'asset']) {
    for (const layer of mode.includes('-') ? ['e2e', 'managed'] : [mode]) cases.push({ mode, fault, layer })
  }
  if (mode !== 'managed') cases.push({ mode, fault: 'wiring', layer: 'e2e' })
}

for (const { mode, fault, layer } of cases) {
  test(`${mode} rolls back ${layer} ${fault} failures and permits retry`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-assembly-'))
    try {
      const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '--eval', `
        import assert from 'node:assert/strict'
        import fs from 'node:fs'
        import { syncBuiltinESMExports } from 'node:module'
        import { join } from 'node:path'
        import { DatabaseSync } from 'node:sqlite'
        import { mock } from 'node:test'
        import { setImmediate } from 'node:timers/promises'
        import { reapOrphans } from './server-e2e/objstore/reaper.ts'
        import * as staticApp from './server-e2e/static.ts'
        import { createLifecycle } from './server-e2e/lifecycle.ts'
        import * as pubsub from './server-e2e/pubsub.ts'
        const failure = Object.assign(new Error('unreadable output'), { code: 'EACCES' })
        const fixture = join(${JSON.stringify(dir)}, 'static')
        fs.mkdirSync(fixture)
        fs.writeFileSync(join(fixture, 'index.html'), '<html>fixture</html>')
        let failing = true, readingFaultyStatic = false, busStops = 0
        let sweepRelease, staticFailure
        const holdSweep = ${JSON.stringify(fault === 'asset' && layer === 'e2e')}
        const readFile = fs.readFileSync, readDir = fs.readdirSync
        mock.method(fs, 'readdirSync', (...args) => {
          if (readingFaultyStatic && ${JSON.stringify(fault)} === 'directory') throw failure
          return readDir(...args)
        })
        mock.method(fs, 'readFileSync', (...args) => {
          if (readingFaultyStatic && ${JSON.stringify(fault)} === 'asset') { staticFailure.resolve(); throw failure }
          return readFile(...args)
        })
        syncBuiltinESMExports()
        await mock.module('./server-e2e/static.ts', { exports: { ...staticApp,
          loadStatic: (dir, scanServer, options = {}) => {
            const layer = options.transformIndex ? 'managed' : 'e2e'
            readingFaultyStatic = failing && layer === ${JSON.stringify(layer)}
            try { return staticApp.loadStatic(fixture, scanServer, options) }
            finally { readingFaultyStatic = false }
          },
        } })
        await mock.module('./server-e2e/lifecycle.ts', { exports: {
          createLifecycle: () => {
            const lifecycle = createLifecycle()
            return { ...lifecycle, install: deps => {
              if (failing && ${JSON.stringify(fault)} === 'wiring') throw failure
              lifecycle.install(deps)
            } }
          },
        } })
        await mock.module('./server-e2e/pubsub.ts', { exports: { ...pubsub,
          createNoopPubSub: () => ({ ...pubsub.createNoopPubSub(), stop: () => {
            busStops++
            return Promise.resolve()
          } }),
        } })
        await mock.module('./server-e2e/objstore/reaper.ts', { exports: {
          reapOrphans: async (...args) => {
            if (failing && holdSweep) await sweepRelease.promise
            return reapOrphans(...args)
          },
        } })
        const timers = new Set()
        const interval = globalThis.setInterval, timeout = globalThis.setTimeout
        const clearInterval = globalThis.clearInterval, clearTimeout = globalThis.clearTimeout
        mock.method(globalThis, 'setInterval', (...args) => {
          const timer = interval(...args); timers.add(timer); return timer
        })
        mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
          const timer = timeout(() => { timers.delete(timer); fn(...args) }, ms)
          timers.add(timer)
          return timer
        })
        mock.method(globalThis, 'clearInterval', timer => { timers.delete(timer); clearInterval(timer) })
        mock.method(globalThis, 'clearTimeout', timer => { timers.delete(timer); clearTimeout(timer) })
        const closed = [], close = DatabaseSync.prototype.close
        mock.method(DatabaseSync.prototype, 'close', function () {
          closed.push(this)
          return close.call(this)
        })
        const { init } = await import('./server.ts')
        const events = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']
        const listeners = events.map(event => process.listeners(event))
        const failedDatabases = ${mode.includes('-') && layer === 'managed' ? 2 : 1}
        for (let attempt = 1; attempt <= 2; attempt++) {
          sweepRelease = Promise.withResolvers()
          staticFailure = Promise.withResolvers()
          let rejected = false
          const checked = assert.rejects(init(${JSON.stringify(mode)}), err => { rejected = true; return err === failure })
          if (holdSweep) {
            await staticFailure.promise
            await setImmediate()
            assert.equal(rejected, false, 'initialization waits for pending reaping before rejecting')
            assert.equal(closed.length, (attempt - 1) * failedDatabases, 'storage stays open until the sweep finishes')
            sweepRelease.resolve()
          }
          await checked
          assert.equal(closed.length, attempt * failedDatabases, 'every acquired database closes exactly once')
          assert.equal(new Set(closed).size, closed.length)
          for (const db of closed) assert.throws(() => db.prepare('SELECT 1'), /not open/u)
          assert.equal(timers.size, 0, 'no reaper, SSE, heartbeat or managed maintenance timers survive')
          if (${JSON.stringify(mode)} !== 'managed') assert.equal(busStops, attempt)
          assert.deepEqual(events.map(event => process.listeners(event)), listeners)
        }
        failing = false
        const server = await init(${JSON.stringify(mode)})
        await server[Symbol.asyncDispose]()
        assert.equal(closed.length, 2 * failedDatabases + ${mode.includes('-') ? 2 : 1})
        assert.equal(timers.size, 0)
        console.log('rolled back and recovered')
      `], { env: {
        ...process.env, VERCEL: '', HOST: '127.0.0.1', PORT: '0',
        DATABASE_URL: '', E2E_DATABASE_URL: '', MANAGED_DATABASE_URL: '', OBJSTORE_TOKEN_SECRET: '',
        OBJSTORE_REAP_DISABLED: 'false', OBJSTORE_REAP_INTERVAL_MS: '3600000',
        CONFIG_PATH: join(dir, 'config.json'), DB_PATH: join(dir, 'e2e.db'),
        MANAGED_DB_PATH: join(dir, 'managed.db'), OBJSTORE_DIR: join(dir, 'objstore'),
        GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret',
        OAUTH_CALLBACK_URL: 'https://example.test/api/oauth/github/callback', SESSION_COOKIE_NAME: 'test-session',
      }, encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' })
      assert.equal(child.status, 0, child.error?.message || child.stderr)
      assert.match(child.stdout, /rolled back and recovered/u)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}

test('failed assembly preserves the original error and runs every cleanup if one fails', async () => {
  const cleanupFailure = new Error('cleanup failed'), failure = new Error('assembly failed')
  let databaseClosed = false
  await assert.rejects(initializeApp(rollback => {
    rollback.defer(() => { databaseClosed = true })
    rollback.defer(() => { throw cleanupFailure })
    throw failure
  }), error => {
    assert.ok(error instanceof SuppressedError)
    assert.equal(error.error, cleanupFailure)
    assert.equal(error.suppressed, failure)
    return true
  })
  assert.equal(databaseClosed, true)
})
