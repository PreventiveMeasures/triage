// Orchestration test for triage-sync's auth-proxy probe policy — the
// timer→probe→latch→clear flow in triage-sync.ts (reconcileProxyAuthWatch
// / runProxyAuthProbe), driven end-to-end with a fully mocked transport
// (no server). The detector primitives are unit-tested in
// proxy-auth-detect.test.js; this validates the policy that decides WHEN
// to probe, and exercises the test-only `setProxyAuthProbeTimings` knob.
//
// Setup mirrors the SSE-fallback tests in sync-client.test.js: the
// WebSocket constructor throws so the transport falls back to SSE, and a
// mocked `fetch` serves the wire. The SSE session POST returns a 200
// stream that never emits a `session` event, so the adapter stays
// CONNECTING and `status` sits at 'offline' — the stuck-offline shape an
// auth-proxy redirect produces — without a reconnect storm. The probe's
// `redirect:'manual'` GET returns an opaque redirect, the proxy signal.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Buffer } from 'node:buffer'
import { setTimeout as delay } from 'node:timers/promises'

await import('./_polyfills.js')

const { triageSync, setProxyAuthProbeTimings } = await import('../client/sync/triage-sync.ts')
const { setProxyAuthRequired } = await import('../client/sync/proxy-auth-detect.ts')
const { upsertWorkspace, deleteWorkspace } = await import('../client/workspaces.js')

function randomBase64() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64')
}

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(15)
  }
  throw new Error(`waitFor: ${label} did not become true within ${timeoutMs}ms`)
}

describe('triage-sync: auth-proxy probe orchestration', () => {
  it('latches proxyAuthRequired when an offline connection probes to an opaque redirect, and clears on disable', async () => {
    const realWS = globalThis.WebSocket
    const realFetch = globalThis.fetch
    globalThis.WebSocket = class {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
      constructor() { throw new Error('forced SSE fallback') }
    }
    let probeGets = 0
    globalThis.fetch = (_input, init) => {
      const method = init?.method ?? 'GET'
      if (method === 'GET' && init?.redirect === 'manual') {
        probeGets += 1
        return Promise.resolve({ type: 'opaqueredirect', status: 0 })
      }
      // SSE session POST: 200 + a body stream that never emits, so the
      // adapter never flips OPEN and the transport stays offline.
      return Promise.resolve({ ok: true, status: 200, statusText: 'OK', body: new ReadableStream({ start() {} }) })
    }
    // Probe almost immediately instead of the production 6s.
    setProxyAuthProbeTimings({ initialMs: 20 })
    const wsId = `ws-${Math.random().toString(36).slice(2, 10)}`
    try {
      await upsertWorkspace({ id: wsId, name: wsId, privateKey: randomBase64(), reports: [] })
      assert.equal(triageSync.proxyAuthRequired, false, 'clean before any probe')
      // Going active against an unreachable relay drives status → offline,
      // which arms the probe.
      triageSync.setServerUrl('ws://proxy.invalid/api/sync')
      await waitFor(() => triageSync.status === 'offline', 'status reaches offline')
      await waitFor(() => triageSync.proxyAuthRequired === true, 'proxy-auth latched after probe')
      assert.ok(probeGets >= 1, 'the probe GET actually fired')
      // Disabling sync makes isActive() false → status 'off' →
      // reconcileProxyAuthWatch clears the latch synchronously.
      triageSync.setEnabled(false)
      assert.equal(triageSync.proxyAuthRequired, false, 'latch cleared on disable')
    } finally {
      triageSync.setServerUrl('')
      triageSync.setEnabled(true)
      setProxyAuthProbeTimings({ initialMs: 6_000, reprobeMs: 30_000 })
      setProxyAuthRequired(false)
      try { await deleteWorkspace(wsId) } catch {}
      globalThis.WebSocket = realWS
      globalThis.fetch = realFetch
    }
  })
})
