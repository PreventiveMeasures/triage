import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'
import { createLifecycle } from '../server-e2e/lifecycle.ts'

test('e2e disposal gates new work and drains the reaper and requests before closing storage', async t => {
  const httpServer = createServer()
  const wss = new WebSocketServer({ noServer: true })
  const heartbeatTimer = setInterval(() => {}, 1000)
  const sseKeepaliveTimer = setInterval(() => {}, 1000)
  const reaper = Promise.withResolvers(), request = Promise.withResolvers()
  const lifecycle = createLifecycle()
  let closed = 0, disposed = false
  lifecycle.track(request.promise)
  lifecycle.install({
    httpServer, wss, heartbeatTimer, sseKeepaliveTimer,
    sseSessions: () => [], stopReaper: () => reaper.promise,
    closeDb: () => { closed++; return Promise.resolve() },
  })
  t.after(async () => {
    request.resolve()
    reaper.resolve()
    await httpServer[Symbol.asyncDispose]()
  })
  const disposing = httpServer[Symbol.asyncDispose]().then(() => { disposed = true; return undefined })
  assert.equal(lifecycle.isShuttingDown(), true)
  await setImmediate()
  assert.equal(closed, 0)
  assert.equal(disposed, false)
  reaper.resolve()
  await setImmediate()
  assert.equal(closed, 0, 'requests still own the database after the reaper stops')
  assert.equal(disposed, false)
  request.resolve()
  await disposing
  await httpServer[Symbol.asyncDispose]()
  assert.equal(closed, 1)
})

for (const trigger of ['bind-error', 'error-during-shutdown']) {
  test(`standalone shutdown exits nonzero on ${trigger}`, () => {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import { once } from 'node:events'
      import { createServer } from 'node:http'
      import { startServer } from './server-common/standalone.ts'
      const host = createServer()
      host.listen(0, '127.0.0.1')
      await once(host, 'listening')
      const server = createServer()
      server[Symbol.asyncDispose] = async () => {
        if (${JSON.stringify(trigger)} === 'error-during-shutdown') {
          server.emit('error', new Error('failure while draining'))
        }
        console.log('disposed before exit')
      }
      startServer(server, { host: '127.0.0.1', port: ${trigger === 'bind-error' ? 'host.address().port' : '0'} })
      if (${JSON.stringify(trigger)} === 'error-during-shutdown') {
        await once(server, 'listening')
        process.kill(process.pid, 'SIGTERM')
      }
    `], { encoding: 'utf8', timeout: 10000 })
    assert.equal(child.status, 1, child.error?.message || child.stderr)
    assert.match(child.stdout, /disposed before exit/u)
    assert.match(child.stderr, trigger === 'bind-error' ? /EADDRINUSE/u : /failure while draining/u)
  })
}
