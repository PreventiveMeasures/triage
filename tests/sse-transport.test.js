// Outbound-backpressure cap for the SSE uplink (client/sync/sse-transport.ts).
//
// The WS plane hands each frame to the socket immediately (native send
// buffer + TCP backpressure). The SSE fallback instead BUFFERS frames in
// `outbound` between POSTs, so a stalled uplink + active editing would
// grow that queue without bound in JS heap — the one place the SSE plane
// lacked the backpressure the server enforces everywhere else. Past the
// cap the transport tears itself down (a `close` event) so the outer
// transport reconnects and the client re-syncs via the chain, mirroring
// the server's per-socket MAX_BUFFERED_BYTES terminate-on-overflow.
//
// The cap is constructor-injectable purely so these tests can trip it
// without allocating 16 MiB of frames; production uses the module default.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SseTransport } from '../client/sync/sse-transport.ts'

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

// A frame whose serialized length is ~`bytes` (the cap counts source-JSON
// length). The padding dominates the small JSON envelope.
function frameOfSize(bytes) {
  return JSON.stringify({ type: 'workspace-save', pad: 'a'.repeat(bytes) })
}

// A minimal OK POST response with an immediately-closed body, so a real
// flush completes (drains the queue) without needing an SSE stream.
function emptyOkResponse() {
  return { ok: true, status: 200, statusText: 'OK', body: new ReadableStream({ start(c) { c.close() } }) }
}

describe('SseTransport outbound backpressure cap', () => {
  it('tears down (close event) when queued bytes exceed the cap instead of buffering unbounded', () => {
    const origFetch = globalThis.fetch
    // Stalled uplink: the POST never settles, so absent the cap the queue
    // would grow without bound as `send` keeps appending.
    globalThis.fetch = () => new Promise(() => {})
    try {
      const t = new SseTransport('ws://localhost/api/sync', { maxOutboundBytes: 200 })
      let closed = false
      t.addEventListener('close', () => { closed = true })

      t.send(frameOfSize(120))  // ~160 B queued — under the 200 cap
      assert.equal(closed, false, 'first frame fits under the cap')

      t.send(frameOfSize(120))  // would push the queue to ~320 B > 200
      assert.equal(closed, true, 'second frame trips the cap → close')
      assert.equal(t.readyState, SseTransport.CLOSED)

      // A post-overflow send must not silently re-buffer (transport is closed).
      assert.throws(() => t.send(frameOfSize(1)), /send on closed transport/u)
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('does not tear down for normal-sized traffic under the (default) cap', () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = () => new Promise(() => {})
    try {
      const t = new SseTransport('ws://localhost/api/sync')  // production 16 MiB cap
      let closed = false
      t.addEventListener('close', () => { closed = true })
      for (let i = 0; i < 50; i++) t.send(JSON.stringify({ type: 'ping', n: i }))
      assert.equal(closed, false)
      t.close()
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('resets the queued-byte counter after a flush drains the queue', async () => {
    const origFetch = globalThis.fetch
    // Resolving uplink: each POST completes, so the flush snapshots +
    // drains the queue (and must reset the byte counter).
    globalThis.fetch = () => Promise.resolve(emptyOkResponse())
    try {
      const t = new SseTransport('ws://localhost/api/sync', { maxOutboundBytes: 250 })
      let closed = false
      t.addEventListener('close', () => { closed = true })

      t.send(frameOfSize(150))   // ~190 B — under cap; the flush will drain it
      await delay(160)           // > FLUSH_DELAY_MS: flush runs, queue + counter reset

      // Another ~190 B frame. If the counter hadn't reset, ~190 + ~190
      // would exceed 250 and trip the cap. It must NOT.
      t.send(frameOfSize(150))
      assert.equal(closed, false, 'counter reset on drain → second frame fits again')
      assert.notEqual(t.readyState, SseTransport.CLOSED)
      t.close()
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
