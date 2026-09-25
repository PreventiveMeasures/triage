import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openSqliteManagedDb } from '../server-managed/db.ts'
import { createSession } from '../server-managed/session.ts'

function environment(dir) {
  return {
    ...process.env, HOST: '127.0.0.1', PORT: '0', DATABASE_URL: '',
    CONFIG_PATH: join(dir, 'config.json'), DB_PATH: join(dir, 'e2e.db'),
    MANAGED_DB_PATH: join(dir, 'managed.db'), OBJSTORE_DIR: join(dir, 'objstore'),
    GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret',
    OAUTH_CALLBACK_URL: 'http://127.0.0.1/api/oauth/github/callback',
    SESSION_COOKIE_NAME: 'test-session', DEEPVIEW_SCAN_SERVER: 'http://127.0.0.1:3123/',
  }
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

async function checkWebSocket(t, url) {
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
  return ws
}

function tables(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name) }
  finally { db.close() }
}

for (const [label, args, advertised, hasE2e, hasManaged] of [
  ['default', ['server.js'], 'e2e', true, false],
  ['e2e', ['server.js', '--mode=e2e'], 'e2e', true, false],
  ['managed', ['server.js', '--mode', 'managed'], 'managed', false, true],
  ['managed-e2e', ['server.js', '--mode', 'managed-e2e'], 'managed+e2e', true, true],
  ['e2e-managed', ['server.js', '--mode=e2e-managed'], 'e2e+managed', true, true],
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
    const info = await (await fetch(`${server.url}/api/config`)).json()
    assert.equal(info.mode, advertised)
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
    let ws
    let reader
    if (hasE2e) {
      assert.equal(info.deepviewScanServer, env.DEEPVIEW_SCAN_SERVER)
      ws = await checkWebSocket(t, server.wsUrl)
      const sse = await fetch(`${server.url}/api/sync/sse`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(10000) })
      assert.equal(sse.status, 200)
      assert.match(sse.headers.get('content-type'), /text\/event-stream/u)
      reader = sse.body.getReader()
      let data = ''
      while (!data.includes('server-info')) data += new TextDecoder().decode((await reader.read()).value)
      assert.match(data, /"mode":"e2e"/u)
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

test('launcher validates arguments before opening stores; help needs no managed credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'triage-launcher-cli-'))
  try {
    const env = { ...environment(dir), GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '' }
    for (const args of [['--mode', 'bad'], ['--mode'], ['--unknown']]) {
      assert.notEqual(spawnSync(process.execPath, ['server.js', ...args], { env }).status, 0)
    }
    const help = spawnSync(process.execPath, ['server.js', '--mode=managed-e2e', '--help'], { env, encoding: 'utf8' })
    assert.equal(help.status, 0)
    assert.match(help.stdout, /managed-e2e/u)
    assert.equal(existsSync(env.DB_PATH), false)
    assert.equal(existsSync(env.MANAGED_DB_PATH), false)
    for (const script of ['server', 'server-e2e']) {
      const scriptHelp = spawnSync(process.execPath, ['--run', script, '--', '--help'], { env, encoding: 'utf8', timeout: 5000 })
      assert.equal(scriptHelp.status, 0, `${script} forwards arguments`)
      assert.match(scriptHelp.stdout, /DB_PATH/u)
    }
    const sameDb = spawnSync(process.execPath, ['server.js', '--mode=managed-e2e'], {
      env: { ...environment(dir), MANAGED_DB_PATH: join(dir, 'e2e.db') }, encoding: 'utf8',
    })
    assert.notEqual(sameDb.status, 0)
    assert.match(sameDb.stderr, /must differ/u)
    assert.equal(existsSync(env.DB_PATH), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
