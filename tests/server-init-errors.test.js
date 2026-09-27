import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

function environment(dir) {
  return {
    ...process.env, VERCEL: '', HOST: '127.0.0.1', PORT: '0', TRUST_PROXY: '', DEBUG: '',
    DATABASE_URL: 'postgres://example/shared', E2E_DATABASE_URL: '', MANAGED_DATABASE_URL: '',
    BLOB_READ_WRITE_TOKEN: 'test-token', OBJSTORE_TOKEN_SECRET: Buffer.alloc(32).toString('base64'),
    OBJSTORE_REAP_DISABLED: 'true', OBJSTORE_REAP_INTERVAL_MS: '600000', MAX_INFLIGHT_PER_SOCKET: '64',
    CONFIG_PATH: join(dir, 'config.json'), DB_PATH: join(dir, 'e2e.db'),
    MANAGED_DB_PATH: join(dir, 'managed.db'), OBJSTORE_DIR: join(dir, 'objstore'),
    GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret',
    OAUTH_CALLBACK_URL: 'https://example.test/api/oauth/github/callback',
    SESSION_COOKIE_NAME: 'test-session',
  }
}

for (const mode of ['e2e', 'managed-e2e', 'e2e-managed']) {
  test(`init(${mode}) rejects invalid configuration without exiting or opening storage`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-init-errors-'))
    try {
      const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '--eval', `
        import assert from 'node:assert/strict'
        import { once } from 'node:events'
        import { existsSync, writeFileSync } from 'node:fs'
        import { createServer } from 'node:http'
        import { mock } from 'node:test'
        import * as neonDb from './server-e2e/db-neon.ts'
        let storageOpens = 0
        await mock.module('./server-e2e/db-neon.ts', { exports: { ...neonDb,
          openNeonDb: () => { storageOpens++; throw new Error('unexpected storage open') },
        } })
        await mock.module('./server-e2e/neon-driver.ts', { exports: {} })
        const { init } = await import('./server.ts')
        const base = { ...process.env }
        const badJson = base.CONFIG_PATH + '.bad-json'
        const badPassword = base.CONFIG_PATH + '.bad-password'
        writeFileSync(badJson, '{')
        writeFileSync(badPassword, '{"password": 123}')
        const cases = [
          [{ BLOB_READ_WRITE_TOKEN: '' }, /BLOB_READ_WRITE_TOKEN/u],
          [{ OBJSTORE_TOKEN_SECRET: '' }, /OBJSTORE_TOKEN_SECRET is not/u],
          [{ HOST: '0.0.0.0' }, /TRUST_PROXY is not enabled/u],
          [{}, /Client export is not available/u],
          [{ PORT: 'invalid' }, /Invalid PORT/u],
          [{ OBJSTORE_REAP_INTERVAL_MS: '0' }, /Invalid OBJSTORE_REAP_INTERVAL_MS/u],
          [{ MAX_INFLIGHT_PER_SOCKET: '0' }, /Invalid MAX_INFLIGHT_PER_SOCKET/u],
          [{ OBJSTORE_TOKEN_SECRET: '   ' }, /empty after trimming/u],
          [{ OBJSTORE_TOKEN_SECRET: '!' }, /non-base64/u],
          [{ OBJSTORE_TOKEN_SECRET: 'YWJj' }, /must decode to 32 bytes/u],
          [{ CONFIG_PATH: badJson }, /Failed to parse/u],
          [{ CONFIG_PATH: ${JSON.stringify(dir)} }, /Failed to read/u],
          [{ CONFIG_PATH: badPassword }, /password.*must be a string or null/u],
        ]
        const host = createServer((req, res) => res.end('host alive'))
        host.listen(0, '127.0.0.1')
        await once(host, 'listening')
        const events = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']
        const listeners = events.map(event => process.listeners(event))
        for (const [changes, expected] of cases) {
          Object.assign(process.env, base, changes)
          await assert.rejects(init(${JSON.stringify(mode)}), expected)
          assert.equal(storageOpens, 0, 'validation precedes storage opening')
          assert.equal(existsSync(base.DB_PATH), false)
          assert.equal(existsSync(base.MANAGED_DB_PATH), false)
          assert.deepEqual(events.map(event => process.listeners(event)), listeners)
          const response = await fetch('http://127.0.0.1:' + host.address().port)
          assert.equal(await response.text(), 'host alive')
        }
        // The host can correct the configuration and retry the same module.
        Object.assign(process.env, base, { DATABASE_URL: '' })
        const server = await init(${JSON.stringify(mode)})
        await server[Symbol.asyncDispose]()
        await host[Symbol.asyncDispose]()
        console.log('caught all failures and recovered')
      `], { env: environment(dir), encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' })
      assert.equal(child.status, 0, child.error?.message || child.stderr)
      assert.match(child.stdout, /caught all failures and recovered/u)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}

test('standalone entry points exit nonzero with useful initialization errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-init-cli-errors-'))
  try {
    for (const entry of [
      ['cli.js', '--mode=e2e'], ['cli.js', '--mode=managed-e2e'], ['cli.js', '--mode=e2e-managed'],
      ['server-e2e/index.ts'], ['server-e2e/cli.js'],
    ]) {
      const child = spawnSync(process.execPath, entry, {
        env: { ...environment(dir), OBJSTORE_TOKEN_SECRET: '' }, encoding: 'utf8', timeout: 10000,
      })
      assert.equal(child.status, 1, child.error?.message || child.stderr)
      assert.match(child.stderr, /OBJSTORE_TOKEN_SECRET is not/u)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

for (const backend of ['sqlite', 'neon-blob', 'neon-objstore']) {
  test(`${backend} initialization closes its database if the byte store fails`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-init-storage-error-'))
    try {
      const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '--eval', `
        import assert from 'node:assert/strict'
        import { writeFileSync } from 'node:fs'
        import { DatabaseSync } from 'node:sqlite'
        import { mock } from 'node:test'
        import * as neonDb from './server-e2e/db-neon.ts'
        let closed = 0
        if (${JSON.stringify(backend)} === 'sqlite') {
          process.env.DATABASE_URL = ''
          writeFileSync(process.env.OBJSTORE_DIR, 'not a directory')
          const close = DatabaseSync.prototype.close
          mock.method(DatabaseSync.prototype, 'close', function () { closed++; return close.call(this) })
        } else {
          await mock.module('./server-e2e/neon-driver.ts', { exports: { Client: class {} } })
          await mock.module('./server-e2e/db-neon.ts', { exports: { ...neonDb,
            openNeonDb: () => Promise.resolve({ close: () => { closed++; return Promise.resolve() } }),
          } })
          await mock.module('./server-e2e/objstore/blob-vercel.ts', { exports: {
            openVercelBlobBackend: () => {
              if (${JSON.stringify(backend)} === 'neon-blob') throw new Error('byte store failed')
              return Promise.resolve({})
            },
          } })
          await mock.module('./server-e2e/objstore/store-neon.ts', { exports: {
            openNeonObjstore: () => { throw new Error('byte store failed') },
          } })
        }
        const { init } = await import('./server.ts')
        await assert.rejects(init('e2e'), ${backend === 'sqlite' ? "{ code: 'EEXIST' }" : '/byte store failed/u'})
        assert.equal(closed, 1)
        console.log('released storage')
      `], { env: environment(dir), encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' })
      assert.equal(child.status, 0, child.error?.message || child.stderr)
      assert.match(child.stdout, /released storage/u)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}
