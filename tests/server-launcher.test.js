import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession } from '../server-managed/session.ts'

function environment(dir) {
  return {
    ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '', E2E_DATABASE_URL: '', MANAGED_DATABASE_URL: '',
    CRON_SECRET: 'test-cron-secret', OBJSTORE_REAP_DISABLED: 'true',
    CONFIG_PATH: join(dir, 'config.json'), DB_PATH: join(dir, 'e2e.db'),
    MANAGED_DB_PATH: join(dir, 'managed.db'), OBJSTORE_DIR: join(dir, 'objstore'),
    GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret',
    OAUTH_CALLBACK_URL: 'http://127.0.0.1/api/oauth/github/callback',
    SESSION_COOKIE_NAME: 'test-session', DEEPVIEW_SCAN_SERVER: 'http://127.0.0.1:3123/',
    GITHUB_NEW_ISSUE_LABELS: 'team,needs-review',
  }
}

// spawnSync's result, without blocking the other tests in this file.
function run(args, { env, timeout = 30000, killSignal = 'SIGTERM' } = {}) {
  return new Promise(resolve => {
    const proc = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let error, stderr = '', stdout = ''
    proc.stdout.setEncoding('utf8').on('data', data => { stdout += data })
    proc.stderr.setEncoding('utf8').on('data', data => { stderr += data })
    const timer = setTimeout(() => { error = new Error(`Timed out after ${timeout}ms`); proc.kill(killSignal) }, timeout)
    proc.once('error', failure => { error = failure })
    proc.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr, error }) })
  })
}

async function boot(t, args, env) {
  const proc = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  proc.stderr.on('data', data => { output += data })
  async function stop() {
    if (proc.exitCode !== null || proc.signalCode !== null) return
    const exited = once(proc, 'exit')
    proc.kill('SIGTERM')
    const timer = setTimeout(() => proc.kill('SIGKILL'), 5000)
    try { await exited } finally { clearTimeout(timer) }
  }
  t.after(stop)
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Boot timeout: ${output}`)), 15000)
    proc.once('exit', code => { clearTimeout(timer); reject(new Error(`Boot exited ${code}: ${output}`)) })
    proc.once('error', reject)
    proc.stdout.on('data', data => {
      output += data
      const match = /(?:ws|http):\/\/127\.0\.0\.1:(\d+)(?:\/|\s)/u.exec(output)
      if (match) { clearTimeout(timer); resolve(Number(match[1])) }
    })
  })
  return { proc, stop, url: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/api/sync` }
}

async function checkWebSocket(t, url, labels) {
  const ws = new WebSocket(url)
  t.after(() => ws.close())
  const frames = []
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No e2e WebSocket pong')), 5000)
    ws.addEventListener('error', reject, { once: true })
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'ping' })), { once: true })
    ws.addEventListener('message', event => {
      const frame = JSON.parse(event.data)
      frames.push(frame)
      if (frame.type === 'pong') { clearTimeout(timer); resolve() }
    })
  })
  assert.ok(frames.some(frame => frame.type === 'challenge'))
  assert.equal(frames.find(frame => frame.type === 'server-info')?.mode, 'e2e', 'e2e wire advertisement stays unchanged')
  assert.equal(frames.find(frame => frame.type === 'server-info')?.githubNewIssueLabels, labels)
  return ws
}

function tables(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name) }
  finally { db.close() }
}

function embedded(mode) {
  return ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict'
    import { Server, createServer } from 'node:http'
    import { init } from './server.ts'
    const httpServer = await init(${JSON.stringify(mode)})
    assert.ok(httpServer instanceof Server)
    assert.equal(httpServer.listening, false)
    assert.equal(httpServer.address(), null)
    assert.equal(httpServer.listenerCount('request'), 1)
    assert.equal(httpServer.listenerCount('upgrade'), ${mode === 'managed' ? 0 : 1})
    const [triageRequestListener] = httpServer.listeners('request')
    const [triageUpgradeListener] = httpServer.listeners('upgrade')
    const host = createServer((req, res) => {
      res.setHeader('x-test-host', 'embedded')
      triageRequestListener.call(httpServer, req, res)
    })
    if (triageUpgradeListener) host.on('upgrade', (req, socket, head) => {
      triageUpgradeListener.call(httpServer, req, socket, head)
    })
    process.on('SIGTERM', async () => {
      await httpServer[Symbol.asyncDispose]()
      await host[Symbol.asyncDispose]()
    })
    host.listen(0, '127.0.0.1', () => {
      assert.equal(httpServer.listening, false)
      console.log('Host: http://127.0.0.1:' + host.address().port + '/')
    })
  `, '--', '--mode=ignored-by-init']
}

const modes = ['e2e', 'managed', 'managed-e2e', 'e2e-managed']

// Scenarios that only need init() share one child per group: a mode's first
// init loads its modules, which costs far more than the scenario. Each prints
// `<name>: ok` or its error, so every test still checks only its own.
const scenarioRuns = new Map()
function scenarioChild(group, script, { args = [], env = {}, timeout = 30000 } = {}) {
  if (!scenarioRuns.has(group)) {
    const dir = mkdtempSync(join(tmpdir(), `triage-launcher-${group}-`))
    // Each mode gets its own storage, as a child of its own would.
    const storage = Object.fromEntries(modes.map(mode => {
      mkdirSync(join(dir, mode))
      const { CONFIG_PATH, DB_PATH, MANAGED_DB_PATH, OBJSTORE_DIR } = environment(join(dir, mode))
      return [mode, { CONFIG_PATH, DB_PATH, MANAGED_DB_PATH, OBJSTORE_DIR }]
    }))
    scenarioRuns.set(group, run(['--input-type=module', '--eval', `
      const storage = ${JSON.stringify(storage)}
      let failed = false
      async function scenario(name, mode, run) {
        Object.assign(process.env, storage[mode])
        try {
          await run()
          console.log(name + ': ok')
        } catch (error) {
          failed = true
          console.log(name + ': ' + JSON.stringify(error?.stack ?? String(error)))
        }
      }
      ${script}
      // A failed scenario may leave its server open; passing ones must exit by themselves.
      if (failed) process.exit()
    `, '--', ...args], { env: { ...environment(dir), ...env }, timeout, killSignal: 'SIGKILL' })
      .finally(() => rmSync(dir, { recursive: true, force: true })))
  }
  return scenarioRuns.get(group)
}

function assertScenario(proc, name) {
  assert.equal(proc.status, 0, proc.error?.message || proc.stderr)
  const line = proc.stdout.split('\n').find(output => output.startsWith(`${name}: `))
  assert.ok(line, `${name} did not run:\n${proc.stdout}`)
  if (line !== `${name}: ok`) assert.fail(JSON.parse(line.slice(name.length + 2)))
}

const embeddings = ['unbound', 'listening', 'mounted', 'close']

// Each test starts its own processes on its own storage, so they wait together.
describe('server launcher', { concurrency: 4 }, () => {
  for (const [label, args, advertised, hasE2e, hasManaged] of [
    ['default', ['cli.js'], 'e2e', true, false],
    ['e2e', ['cli.js', '--mode=e2e'], 'e2e', true, false],
    ['managed', ['cli.js', '--mode', 'managed'], 'managed', false, true],
    ['managed-e2e', ['cli.js', '--mode', 'managed-e2e'], 'managed+e2e', true, true],
    ['e2e-managed', ['cli.js', '--mode=e2e-managed'], 'e2e+managed', true, true],
    ['embedded e2e', embedded('e2e'), 'e2e', true, false],
    ['embedded managed', embedded('managed'), 'managed', false, true],
    ['embedded managed-e2e', embedded('managed-e2e'), 'managed+e2e', true, true],
    ['embedded e2e-managed', embedded('e2e-managed'), 'e2e+managed', true, true],
    ['standalone e2e', ['server-e2e/index.ts'], 'e2e', true, false],
    ['standalone managed', ['server-managed/index.ts'], 'managed', false, true],
  ]) {
    test(`server launcher: ${label}`, { timeout: 30000 }, async t => {
      const dir = mkdtempSync(join(tmpdir(), 'triage-launcher-'))
      // Cleanup runs after the child-process hook registered by boot below.
      const env = environment(dir)
      let session
      if (hasManaged) {
        const db = openSqliteManagedDb(env.MANAGED_DB_PATH)
        session = await createSession({ sessionCookieName: env.SESSION_COOKIE_NAME, cookieSecure: false, sessionTtlMs: 60000 },
          db, { githubUserId: 1, login: 'managed-user', name: null, avatarUrl: null }, Date.now())
        await db.close()
      }
      const server = await boot(t, args, env)
      t.after(() => rmSync(dir, { recursive: true, force: true }))
      const configResponse = await fetch(`${server.url}/api/config`)
      if (label.startsWith('embedded')) assert.equal(configResponse.headers.get('x-test-host'), 'embedded')
      const info = await configResponse.json()
      assert.equal(info.mode, advertised)
      assert.equal(info.githubNewIssueLabels, env.GITHUB_NEW_ISSUE_LABELS, '/api/config exposes runtime labels in every mode')
      if (hasManaged) {
        assert.equal(info.managed.loginPath, '/api/oauth/github/login')
        const cookie = session.setCookie.split(';')[0]
        const response = await fetch(`${server.url}/api/auth/session`, { headers: { cookie } })
        assert.equal(response.status, 200)
        assert.equal((await response.json()).user.login, 'managed-user')
        const logout = await fetch(`${server.url}/api/auth/logout`, {
          method: 'POST', headers: { cookie, 'x-csrf-token': session.csrfToken },
        })
        assert.equal(logout.status, 204)
        assert.equal((await fetch(`${server.url}/api/auth/session`, { headers: { cookie } })).status, 401)
      } else {
        assert.equal((await fetch(`${server.url}/api/auth/session`)).status, 404)
      }
      assert.equal((await fetch(`${server.url}/api/reap`)).status, 401)
      assert.equal((await fetch(`${server.url}/api/reap`, { method: 'POST', headers: { authorization: `Bearer ${env.CRON_SECRET}` } })).status, 405)
      const cleanup = await fetch(`${server.url}/api/reap`, { headers: { authorization: `Bearer ${env.CRON_SECRET}` } })
      assert.equal(cleanup.status, 200)
      assert.deepEqual((await cleanup.json()).reaped, [...hasE2e ? ['e2e'] : [], ...hasManaged ? ['managed'] : []])
      let ws
      let reader
      if (hasE2e) {
        assert.equal(info.deepviewScanServer, env.DEEPVIEW_SCAN_SERVER)
        ws = await checkWebSocket(t, server.wsUrl, env.GITHUB_NEW_ISSUE_LABELS)
        const sse = await fetch(`${server.url}/api/sync/sse`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(10000) })
        assert.equal(sse.status, 200)
        assert.match(sse.headers.get('content-type'), /text\/event-stream/u)
        reader = sse.body.getReader()
        let data = ''
        while (!data.includes('server-info')) data += new TextDecoder().decode((await reader.read()).value)
        assert.match(data, /"mode":"e2e"/u)
        assert.ok(data.includes(`"githubNewIssueLabels":${JSON.stringify(env.GITHUB_NEW_ISSUE_LABELS)}`), 'SSE advertises the same labels')
        assert.equal((await fetch(`${server.url}/api/sync/save`, { method: 'POST', body: '{}' })).status, 400)
      } else {
        for (const path of ['/api/sync', '/api/sync/sse', '/api/sync/save', '/api/npm-advisories', '/api/objstore/a/b']) {
          assert.equal((await fetch(`${server.url}${path}`)).status, 404, path)
        }
      }
      const closed = ws ? new Promise(resolve => { ws.addEventListener('close', resolve, { once: true }) }) : null
      await server.stop()
      assert.equal(server.proc.exitCode, 0, 'graceful shared shutdown')
      if (closed) assert.equal((await closed).code, 1001)
      if (reader) { while (!(await reader.read()).done) { /* drain the close event */ } }
      assert.equal(existsSync(env.DB_PATH), hasE2e)
      assert.equal(existsSync(env.MANAGED_DB_PATH), hasManaged)
      if (hasE2e) assert.ok(!tables(env.DB_PATH).includes('managed_user'))
      if (hasManaged) assert.ok(!tables(env.MANAGED_DB_PATH).includes('workspace_revision'))
    })
  }

  for (const mode of modes) {
    for (const flag of ['--help', '-h']) {
      test(`init(${mode}) ignores the embedding host's ${flag} argument`, async () => {
        const proc = await scenarioChild(`host-help${flag}`, `
          import assert from 'node:assert/strict'
          import { init } from './server.ts'
          for (const mode of ${JSON.stringify(modes)}) {
            await scenario(mode, mode, async () => {
              const server = await init(mode)
              assert.equal(server.listening, false)
              assert.equal(server.address(), null)
              assert.equal(server.listenerCount('request'), 1)
              assert.equal(server.listenerCount('upgrade'), mode === 'managed' ? 0 : 1)
              await server[Symbol.asyncDispose]()
            })
          }
        `, { args: [flag] })
        assertScenario(proc, mode)
        assert.doesNotMatch(proc.stdout, /Usage:/u)
      })
    }
  }

  test('standalone e2e entry points handle both help flags without opening storage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-launcher-e2e-help-'))
    try {
      const env = environment(dir)
      for (const entry of ['server-e2e/cli.js', 'server-e2e/index.ts']) {
        for (const flag of ['--help', '-h']) {
          const proc = await run([entry, flag], { env, timeout: 5000 })
          assert.equal(proc.status, 0, proc.stderr)
          assert.match(proc.stdout, /Usage: node server-e2e\/index.ts/u)
          assert.match(proc.stdout, /DB_PATH/u)
          assert.equal(existsSync(env.DB_PATH), false)
          assert.equal(existsSync(env.OBJSTORE_DIR), false)
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  for (const mode of modes) {
    for (const embedding of embeddings) {
      test(`embedded ${embedding} server releases ${mode} resources and permits reinitialization`, async () => {
        // No forced exit: a leaked GC interval would keep the child alive.
        assertScenario(await scenarioChild(`dispose-${mode}`, `
          import assert from 'node:assert/strict'
          import { once } from 'node:events'
          import { createServer } from 'node:http'
          import { DatabaseSync } from 'node:sqlite'
          import { mock } from 'node:test'
          import { init } from './server.ts'
          const closed = [], closeDb = DatabaseSync.prototype.close
          let targetCount = 0, databasesClosed
          mock.method(DatabaseSync.prototype, 'close', function () {
            const result = closeDb.call(this)
            closed.push(this)
            if (closed.length === targetCount) databasesClosed.resolve()
            return result
          })
          // Preserve listeners owned by the embedding host across every reload.
          process.on('SIGTERM', () => {})
          const events = ['SIGINT', 'SIGTERM', 'unhandledRejection', 'uncaughtException']
          const signals = events.map(name => process.listeners(name))
          for (const embedding of ${JSON.stringify(embeddings)}) {
            await scenario(embedding, ${JSON.stringify(mode)}, async () => {
              closed.length = 0
              for (let n = 0; n < 2; n++) {
                targetCount = (n + 1) * ${mode.includes('-') ? 2 : 1}
                databasesClosed = Promise.withResolvers()
                const server = await init(${JSON.stringify(mode)})
                assert.deepEqual(events.map(name => process.listeners(name)), signals)
                let host
                if (embedding === 'mounted') {
                  const [handler] = server.listeners('request')
                  host = createServer(handler)
                } else if (embedding !== 'unbound') host = server
                if (host) {
                  host.listen(0, '127.0.0.1')
                  await once(host, 'listening')
                  const response = await fetch('http://127.0.0.1:' + host.address().port + '/api/config')
                  assert.equal((await response.json()).mode, ${JSON.stringify(mode.replace('-', '+'))})
                }
                if (embedding === 'close') {
                  await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
                  // The close event starts cleanup; reaping may still be draining.
                  await databasesClosed.promise
                  await server[Symbol.asyncDispose]()
                } else await Promise.all([server[Symbol.asyncDispose](), server[Symbol.asyncDispose]()])
                assert.equal(server.listening, false)
                assert.equal(closed.length, (n + 1) * ${mode.includes('-') ? 2 : 1}, 'dispose closes each database exactly once')
                for (const db of closed) assert.throws(() => db.prepare('SELECT 1'), /not open/u)
                assert.deepEqual(events.map(name => process.listeners(name)), signals)
                if (host && host !== server) {
                  const stopped = await fetch('http://127.0.0.1:' + host.address().port + '/api/sync/save', { method: 'POST', body: '{}' })
                  assert.equal(stopped.status, 503, 'the host stays alive while disposed handlers reject new work')
                  await stopped.text()
                  await host[Symbol.asyncDispose]()
                }
              }
            })
          }
        `, { env: { OBJSTORE_REAP_DISABLED: 'false', OBJSTORE_REAP_INTERVAL_MS: '10' } }), embedding)
      })
    }
  }

  test('managed disposal drains work on a separate host before closing the database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-launcher-dispose-drain-'))
    try {
      const proc = await run(['--experimental-test-module-mocks', '--input-type=module', '--eval', `
        import assert from 'node:assert/strict'
        import { once } from 'node:events'
        import { createServer } from 'node:http'
        import { setImmediate } from 'node:timers/promises'
        import { mock } from 'node:test'
        import { openManagedStorage } from './server-managed/storage.ts'
        const entered = Promise.withResolvers(), release = Promise.withResolvers()
        let closed = false, disposed = false
        await mock.module('./server-managed/storage.ts', { exports: { openManagedStorage: async config => {
          const storage = await openManagedStorage(config)
          const reap = storage.db.deleteExpiredSessions, close = storage.db.close
          storage.db.deleteExpiredSessions = async now => {
            entered.resolve()
            await release.promise
            return reap(now)
          }
          storage.db.close = async () => { closed = true; await close() }
          return storage
        } } })
        const { init } = await import('./server.ts')
        const server = await init('managed')
        const [handler] = server.listeners('request')
        const host = createServer(handler)
        host.listen(0, '127.0.0.1')
        await once(host, 'listening')
        const url = 'http://127.0.0.1:' + host.address().port
        const request = fetch(url + '/api/reap', { headers: { authorization: 'Bearer test-cron-secret' } })
        await entered.promise
        const disposing = server[Symbol.asyncDispose]().then(() => { disposed = true })
        await setImmediate()
        assert.equal(closed, false, 'tracked work still owns the database')
        assert.equal(disposed, false)
        const stopped = await fetch(url + '/api/auth/session')
        assert.equal(stopped.status, 503)
        await stopped.text()
        release.resolve()
        const response = await request
        assert.equal(response.status, 200)
        await response.text()
        await disposing
        assert.equal(closed, true)
        await host[Symbol.asyncDispose]()
        console.log('drained')
      `], { env: environment(dir), timeout: 30000 })
      assert.equal(proc.status, 0, proc.error?.message || proc.stderr)
      assert.match(proc.stdout, /drained/u)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  for (const mode of modes) {
    test(`embedded ${mode} bind errors preserve the host and dispose resources`, async () => {
      assertScenario(await scenarioChild('bind-error', `
        import assert from 'node:assert/strict'
        import { once } from 'node:events'
        import { createServer } from 'node:http'
        import { init } from './server.ts'
        for (const mode of ${JSON.stringify(modes)}) {
          await scenario(mode, mode, async () => {
            const host = createServer((req, res) => res.end('host alive'))
            host.listen(0, '127.0.0.1')
            await once(host, 'listening')
            const port = host.address().port
            const server = await init(mode)
            const error = once(server, 'error')
            server.listen(port, '127.0.0.1')
            assert.equal((await error)[0].code, 'EADDRINUSE')
            await server[Symbol.asyncDispose]()
            assert.equal(await (await fetch('http://127.0.0.1:' + port)).text(), 'host alive')
            const replacement = await init(mode)
            replacement.listen(0, '127.0.0.1')
            await once(replacement, 'listening')
            await replacement[Symbol.asyncDispose]()
            await host[Symbol.asyncDispose]()
          })
        }
      `), mode)
    })
  }

  for (const mode of modes) {
    test(`init({ mode: '${mode}', ui: false }) serves only the API, never reading out/`, async () => {
      assertScenario(await scenarioChild('no-ui', `
        import assert from 'node:assert/strict'
        import fs from 'node:fs'
        import { once } from 'node:events'
        import { syncBuiltinESMExports } from 'node:module'
        import { init } from './server.ts'
        // The static loader's named readdirSync import sees the spy once synced.
        const readdir = fs.readdirSync, listed = []
        fs.readdirSync = function (path, ...rest) { listed.push(String(path)); return readdir.call(this, path, ...rest) }
        syncBuiltinESMExports()
        const outListings = () => listed.filter(path => path.endsWith('/out') || path.endsWith('/out/')).length
        for (const mode of ${JSON.stringify(modes)}) {
          await scenario(mode, mode, async () => {
            listed.length = 0
            const server = await init({ mode, ui: false })
            assert.equal(outListings(), 0, 'out/ is never read')
            server.listen(0, '127.0.0.1')
            await once(server, 'listening')
            const url = 'http://127.0.0.1:' + server.address().port
            assert.equal((await (await fetch(url + '/api/config')).json()).mode, mode.replace('-', '+'))
            for (const path of ['/', '/index.html']) {
              const response = await fetch(url + path)
              assert.equal(response.status, 404, path)
              assert.match(response.headers.get('content-type'), /json/u, path)
              await response.text()
            }
            await server[Symbol.asyncDispose]()
            const served = await init({ mode })
            assert.ok(outListings() > 0, 'the UI stays on by default')
            await served[Symbol.asyncDispose]()
          })
        }
      `), mode)
    })
  }

  test('launcher validates arguments before opening stores; help needs no managed credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-launcher-cli-'))
    try {
      const env = { ...environment(dir), GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '' }
      for (const args of [['--mode', 'bad'], ['--mode'], ['--unknown']]) {
        assert.notEqual((await run(['cli.js', ...args], { env })).status, 0)
      }
      const help = await run(['cli.js', '--mode=managed-e2e', '--help'], { env })
      assert.equal(help.status, 0)
      assert.match(help.stdout, /managed-e2e/u)
      assert.equal(existsSync(env.DB_PATH), false)
      assert.equal(existsSync(env.MANAGED_DB_PATH), false)
      for (const script of ['server', 'server-e2e']) {
        const scriptHelp = await run(['--run', script, '--', '--help'], { env, timeout: 5000 })
        assert.equal(scriptHelp.status, 0, `${script} forwards arguments`)
        assert.match(scriptHelp.stdout, /DB_PATH/u)
      }
      const sameDb = await run(['cli.js', '--mode=managed-e2e'], {
        env: { ...environment(dir), MANAGED_DB_PATH: join(dir, 'e2e.db') },
      })
      assert.notEqual(sameDb.status, 0)
      assert.match(sameDb.stderr, /must differ/u)
      assert.equal(existsSync(env.DB_PATH), false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('server.ts does not start itself, parse arguments or open storage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-launcher-import-'))
    try {
      const env = { ...environment(dir), GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '' }
      const proc = await run(['--input-type=module', '--eval',
        "import { init, start } from './server.ts'; console.log(typeof init, typeof start)", '--', '--unknown'],
      { env, timeout: 5000 })
      assert.equal(proc.status, 0, proc.stderr)
      assert.equal(proc.stdout.trim(), 'function function')
      const direct = await run(['server.ts', '--unknown'], { env, timeout: 5000 })
      assert.equal(direct.status, 0, direct.stderr)
      assert.equal(direct.stdout, '')
      assert.equal(existsSync(env.DB_PATH), false)
      assert.equal(existsSync(env.MANAGED_DB_PATH), false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('init rejects unsupported modes before opening storage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-launcher-invalid-mode-'))
    try {
      const env = environment(dir)
      const proc = await run(['--input-type=module', '--eval',
        "import { init } from './server.ts'; await init('bad')"], { env, timeout: 5000 })
      assert.equal(proc.status, 1)
      assert.match(proc.stderr, /Unknown mode: bad/u)
      assert.equal(existsSync(env.DB_PATH), false)
      assert.equal(existsSync(env.MANAGED_DB_PATH), false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('both combined launchers reject mixed backends and ambiguous URLs before opening storage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'triage-launcher-databases-'))
    try {
      for (const mode of ['managed-e2e', 'e2e-managed']) {
        for (const urls of [
          { E2E_DATABASE_URL: 'postgres://example/e2e' },
          { MANAGED_DATABASE_URL: 'postgres://example/managed' },
          { DATABASE_URL: 'postgres://example/shared', E2E_DATABASE_URL: 'postgres://example/e2e' },
          { DATABASE_URL: 'postgres://example/shared', MANAGED_DATABASE_URL: 'postgres://example/managed' },
        ]) {
          const env = { ...environment(dir), ...urls }
          const proc = await run(['cli.js', '--mode', mode], { env, timeout: 5000 })
          assert.notEqual(proc.status, 0)
          assert.match(proc.stderr, /Mixing Neon and SQLite|DATABASE_URL cannot be combined/u)
          assert.equal(existsSync(env.DB_PATH), false)
          assert.equal(existsSync(env.MANAGED_DB_PATH), false)
        }
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
