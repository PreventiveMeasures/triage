// `tests/_helpers.js` — `closeWebSocketServer`. Pins the teardown
// contract the WS suites depend on: shutting down an in-process
// WebSocketServer must not wait on the peer.
//
// Why this is worth a test of its own: the bare form it replaces
// (`new Promise((resolve) => wss.close(resolve))`) resolves only once
// every connection has ended, so a still-connected client held it open
// forever. Under `--test-isolation=process` that deadlocked the whole
// file — the child never exited, the runner waited on it indefinitely,
// and the suite's `--test-timeout` was unset, so nothing intervened. It
// surfaced only under load (when the client's teardown lagged the
// server close), which is the worst way for a CI hang to behave.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { awaitListening, closeWebSocketServer } from './_helpers.js'

const { WebSocket, WebSocketServer } = await import('ws')

async function listeningServer() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await awaitListening(wss)
  return { wss, url: `ws://127.0.0.1:${wss.address().port}` }
}

async function connect(url) {
  const sock = new WebSocket(url)
  await new Promise((resolve, reject) => {
    sock.once('open', resolve)
    sock.once('error', reject)
  })
  return sock
}

describe('closeWebSocketServer', () => {
  it('resolves promptly with a live client still connected', async () => {
    const { wss, url } = await listeningServer()
    const sock = await connect(url)
    assert.equal(wss.clients.size, 1, 'server sees the connection')
    // The regression guard: a bare wss.close(resolve) never resolves
    // here. Anything under the helper's own fallback proves it didn't
    // wait on the peer (in practice this is ~1ms).
    const started = Date.now()
    await closeWebSocketServer(wss)
    assert.ok(Date.now() - started < 2_000, 'closed without waiting on the peer')
    sock.close()
  })

  it('resolves with several live clients', async () => {
    const { wss, url } = await listeningServer()
    const socks = await Promise.all([connect(url), connect(url), connect(url)])
    assert.equal(wss.clients.size, 3)
    await closeWebSocketServer(wss)
    for (const s of socks) s.close()
  })

  it('resolves on an idle server, and is safe to call twice', async () => {
    const { wss } = await listeningServer()
    await closeWebSocketServer(wss)
    // Second call: already closed, so `close(cb)` errors/no-ops
    // depending on state — the timed fallback must still let teardown
    // finish rather than stranding a caller.
    await closeWebSocketServer(wss, 100)
  })

  it('stops accepting new connections', async () => {
    const { wss, url } = await listeningServer()
    await closeWebSocketServer(wss)
    await assert.rejects(connect(url), 'listener is gone')
  })
})

describe('awaitListening', () => {
  it('resolves once the server is listening', async () => {
    const { wss } = await listeningServer()
    assert.ok(wss.address().port > 0)
    await closeWebSocketServer(wss)
  })

  it('rejects instead of hanging when the listen fails', async () => {
    // A bare once('listening') never settles here — the event doesn't
    // fire and the 'error' goes unhandled.
    const { wss, url } = await listeningServer()
    const taken = Number(new URL(url).port)
    const clash = new WebSocketServer({ port: taken, host: '127.0.0.1' })
    await assert.rejects(awaitListening(clash), 'listen error surfaces')
    await closeWebSocketServer(wss)
  })
})
