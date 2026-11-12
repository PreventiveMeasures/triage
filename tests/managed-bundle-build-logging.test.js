import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { totalmem } from 'node:os'
import { mock, test } from 'node:test'
import { bundleBuildDiagnostic } from '../server-managed/bundle-build-diagnostics.js'

// oxlint-disable-next-line unicorn/prefer-event-target
class Worker extends EventEmitter {
  static start
  static env
  static resourceLimits
  constructor(url, options) {
    super()
    assert.ok(url.href.endsWith('/bundle-build-worker.js'))
    Worker.env = options.env
    Worker.resourceLimits = options.resourceLimits
    assert.deepEqual(options.execArgv, [])
    Worker.start(this)
  }
  terminate() { this.emit('exit', 1); return Promise.resolve(1) }
}
mock.module('node:worker_threads', { namedExports: { Worker } })
const { BundleBuildError, buildHeapLimitMib, buildRepositoryBundle, parseBundleBuild } = await import('../server-managed/bundle-build.ts')
const token = 'private-test-credential'
const input = parseBundleBuild({ repoId: 12, commit: 'a'.repeat(40), entries: ['src/index.js'], conditions: { preset: 'node', conditions: ['node'] } })
const request = { input, github: 'org/repo', token, maxBytes: 1_000_000, scopes: [null] }

function capture(t) {
  const records = []
  for (const method of ['info', 'error']) {
    t.mock.method(console, method, (prefix, json) => {
      assert.equal(prefix, 'managed-bundle-build:')
      records.push({ ...JSON.parse(json), level: method })
    })
  }
  return records
}

test('the worker env holds NPM_TOKEN alone, when set', async t => {
  t.after(() => { delete process.env.NPM_TOKEN; delete process.env.TRIAGE_TEST_SECRET })
  process.env.TRIAGE_TEST_SECRET = 'not for the worker'
  for (const npmToken of [undefined, 'npm_testToken']) {
    if (npmToken === undefined) delete process.env.NPM_TOKEN
    else process.env.NPM_TOKEN = npmToken
    Worker.start = worker => queueMicrotask(() => worker.emit('message', { bytes: new Uint8Array(), directory: '', filename: 'bundle.br' }))
    await buildRepositoryBundle('user', request, new AbortController().signal)
    assert.deepEqual(Worker.env, npmToken === undefined ? {} : { NPM_TOKEN: npmToken })
  }
})

test('progress messages do not settle a build; success and termination log one outcome', async t => {
  const logs = capture(t)
  const bytes = new Uint8Array([1, 2, 3])
  Worker.start = worker => queueMicrotask(() => {
    worker.emit('message', { type: 'progress', stage: 'build' })
    worker.emit('message', { type: 'progress', stage: 'compress' })
    worker.emit('message', { bytes, directory: 'src', filename: 'bundle.br' })
  })
  assert.deepEqual(await buildRepositoryBundle('user', request, new AbortController().signal),
    { bytes: Buffer.from(bytes), directory: 'src', filename: 'bundle.br' })
  assert.deepEqual(logs.map(log => log.event), ['started', 'progress', 'progress', 'completed'])
  assert.equal(logs.at(-1).stage, 'compress')
  assert.equal(logs.at(-1).byteSize, 3)
  assert.equal(new Set(logs.map(log => log.buildId)).size, 1)
  assert.ok(logs.every(log => log.repoId === 12 && log.entryCount === 1 && log.elapsedMs >= 0))
  assert.ok(!JSON.stringify(logs).includes(token))
})

test('worker construction, runtime errors, and premature exits log the actual failure once', async t => {
  const error = Object.assign(new Error(`cannot load worker ${token}`, { cause: new Error('root cause') }), { code: 'MODULE_NOT_FOUND' })
  for (const kind of ['constructor', 'error', 'exit', 'reported']) { await t.test(kind, async st => {
    const logs = capture(st)
    Worker.start = worker => {
      if (kind === 'constructor') throw error
      queueMicrotask(() => {
        if (kind === 'error') { worker.emit('error', error); worker.emit('exit', 1) }
        if (kind === 'exit') worker.emit('exit', 17)
        if (kind === 'reported') {
          worker.emit('message', { type: 'progress', stage: 'build' })
          worker.emit('message', { error: 'build-failed', status: 422, diagnostic: bundleBuildDiagnostic(error, token) })
        }
      })
    }
    // Reusing the same user also verifies cleanup after every failure path.
    await assert.rejects(buildRepositoryBundle('user', request, new AbortController().signal),
      kind === 'constructor' ? error : { code: 'build-failed', status: 422 })
    const failures = logs.filter(log => log.event === 'failed')
    assert.equal(failures.length, 1)
    const failure = failures[0]
    assert.equal(failure.level, 'error')
    assert.equal(failure.stage, kind === 'reported' ? 'build' : 'worker-start')
    if (kind === 'exit') assert.equal(failure.exitCode, 17)
    else {
      assert.equal(failure.diagnostic.code, 'MODULE_NOT_FOUND')
      assert.match(failure.diagnostic.stack, /cannot load worker \[redacted\]/u)
      assert.equal(failure.diagnostic.cause.message, 'root cause')
    }
    assert.ok(!JSON.stringify(logs).includes(token))
  }) }
})

test('lease timeouts retain their reason and cancellations avoid spurious exit errors', async t => {
  for (const timeout of [false, true]) { await t.test(String(timeout), async st => {
    const controller = new AbortController(), logs = capture(st)
    Worker.start = () => queueMicrotask(() => controller.abort(timeout ? new BundleBuildError(504, 'build-timeout') : undefined))
    await assert.rejects(buildRepositoryBundle('user', request, controller.signal),
      { code: timeout ? 'build-timeout' : 'build-cancelled', status: timeout ? 504 : 499 })
    assert.deepEqual(logs.map(log => log.event), ['started', timeout ? 'failed' : 'cancelled'])
  }) }
})

test('diagnostics redact credentials, omit upstream response bodies, and bound causes', () => {
  const error = Object.assign(new Error('GET https://api.github.com/repos/org/repo 404: private response body'),
    { name: 'HttpError', status: 404, headers: { authorization: token }, request: { token }, response: 'secret body' })
  const diagnostic = bundleBuildDiagnostic(error, token)
  assert.equal(diagnostic.status, 404)
  assert.equal(diagnostic.message, 'GET https://api.github.com/repos/org/repo 404')
  assert.ok(!JSON.stringify(diagnostic).includes('body'))
  assert.ok(!JSON.stringify(diagnostic).includes(token))
  const nested = new Error(`${token} ghp_someToken https://user:password@example.test/?token=secret`, { cause: new Error('nested') })
  nested.cause.cause = nested
  const text = JSON.stringify(bundleBuildDiagnostic(nested, token))
  for (const secret of [token, 'ghp_someToken', 'password', 'secret']) assert.ok(!text.includes(secret))
  assert.equal(bundleBuildDiagnostic('thrown string', null).message, 'thrown string')
  assert.ok(bundleBuildDiagnostic(new Error('x'.repeat(20_000)), null).stack.length <= 8192)
})

test('a build’s heap is what a project producing 512 MiB of JSON takes, or what the process’s memory leaves', () => {
  const mib = 1024 ** 2
  assert.equal(buildHeapLimitMib(16 * 1024 * mib), 2048, 'no more where there is more')
  assert.equal(buildHeapLimitMib(2560 * mib), 2048)
  assert.equal(buildHeapLimitMib(2048 * mib), 1536, 'what a 2 GiB container leaves past the server’s 512 MiB')
  assert.equal(buildHeapLimitMib(768 * mib), 512, 'never less than the 512 MiB a build always had')
  assert.equal(buildHeapLimitMib(), buildHeapLimitMib(Math.min(process.constrainedMemory() || Infinity, totalmem())), 'of this process’s memory')
})

test('a worker is given that heap, and one running out of it is told so, its limit logged', async t => {
  const logs = capture(t)
  Worker.start = worker => queueMicrotask(() => {
    worker.emit('error', Object.assign(new Error('Worker terminated due to reaching memory limit: JS heap out of memory'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }))
    worker.emit('exit', 1)
  })
  await assert.rejects(buildRepositoryBundle('user', request, new AbortController().signal), { code: 'build-memory', status: 413 })
  assert.deepEqual(Worker.resourceLimits, { maxOldGenerationSizeMb: buildHeapLimitMib() })
  const failures = logs.filter(log => log.event === 'failed')
  assert.deepEqual(failures.map(log => [log.code, log.heapLimitMib, log.diagnostic.code]), [['build-memory', buildHeapLimitMib(), 'ERR_WORKER_OUT_OF_MEMORY']])
})

test('one build at a time in a process, each user’s alike', async () => {
  let finish
  Worker.start = worker => { finish = () => worker.emit('message', { bytes: new Uint8Array(), directory: '', filename: 'bundle.br' }) }
  const running = buildRepositoryBundle('one', request, new AbortController().signal)
  await assert.rejects(buildRepositoryBundle('other', request, new AbortController().signal), { code: 'build-busy', status: 429 })
  finish()
  await running
  Worker.start = worker => queueMicrotask(() => worker.emit('message', { bytes: new Uint8Array(), directory: '', filename: 'bundle.br' }))
  await buildRepositoryBundle('other', request, new AbortController().signal)
})
