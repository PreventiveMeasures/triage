// Unit tests for `client/sync/proxy-auth-detect.ts` — the auth-proxy
// (e.g. Cloudflare Access) detector that turns a stuck-offline sync
// connection into an actionable "reload to sign in" signal.
//
// Covers:
//   - probeProxyAuth: opaqueredirect → true; normal 4xx/basic → false;
//     thrown fetch → false; empty URL / no fetch → false; and that the
//     probe hits the relay's `/sse` HTTP URL with redirect:'manual'.
//   - The proxyAuthRequired latch + listener fan-out (dedup, on-subscribe
//     fire, transitions, unsubscribe).
//   - triageSync delegates `proxyAuthRequired` / `onProxyAuthRequired`
//     to the same detector singleton (the public surface the UI reads).

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

// `_polyfills.js` installs the default sync host so importing
// triage-sync (for the delegation test) boots cleanly. Harmless for the
// pure-detector tests.
await import('./_polyfills.js')

const { probeProxyAuth, proxyAuthRequired, setProxyAuthRequired, onProxyAuthRequired } =
  await import('../client/sync/proxy-auth-detect.ts')
const { triageSync } = await import('../client/sync/triage-sync.ts')

// ─────────── probeProxyAuth ───────────

describe('proxy-auth-detect: probeProxyAuth', () => {
  let originalFetch
  let calls
  beforeEach(() => {
    originalFetch = globalThis.fetch
    calls = []
  })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('reports true on an opaque-redirect response (a relay-origin redirect to a login proxy)', async () => {
    globalThis.fetch = (url, opts) => {
      calls.push({ url, opts })
      return Promise.resolve({ type: 'opaqueredirect', status: 0 })
    }
    assert.equal(await probeProxyAuth('wss://app.example/api/sync'), true)
  })

  it('probes the relay /sse HTTP URL with a no-store, manual-redirect GET', async () => {
    globalThis.fetch = (url, opts) => {
      calls.push({ url, opts })
      return Promise.resolve({ type: 'basic', status: 405 })
    }
    await probeProxyAuth('wss://app.example/api/sync')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://app.example/api/sync/sse')
    assert.equal(calls[0].opts.method, 'GET')
    assert.equal(calls[0].opts.redirect, 'manual')
    assert.equal(calls[0].opts.cache, 'no-store')
    assert.equal(calls[0].opts.credentials, 'same-origin')
  })

  it('reports false on an ordinary (non-redirect) response — a real outage is not proxy auth', async () => {
    globalThis.fetch = () => Promise.resolve({ type: 'basic', status: 405 })
    assert.equal(await probeProxyAuth('ws://test.invalid/api/sync'), false)
  })

  it('reports false when fetch throws (offline / DNS failure / CORS)', async () => {
    globalThis.fetch = () => Promise.reject(new TypeError('Failed to fetch'))
    assert.equal(await probeProxyAuth('ws://test.invalid/api/sync'), false)
  })

  it('reports false for an empty URL without calling fetch', async () => {
    let called = false
    globalThis.fetch = () => { called = true; return Promise.resolve({ type: 'opaqueredirect' }) }
    assert.equal(await probeProxyAuth(''), false)
    assert.equal(called, false)
  })

  it('reports false when fetch is unavailable', async () => {
    globalThis.fetch = undefined
    assert.equal(await probeProxyAuth('ws://test.invalid/api/sync'), false)
  })
})

// ─────────── latch + listeners ───────────

describe('proxy-auth-detect: required latch', () => {
  afterEach(() => { setProxyAuthRequired(false) })

  it('starts false', () => {
    assert.equal(proxyAuthRequired(), false)
  })

  it('setProxyAuthRequired flips the latch and fires listeners only on a real change', () => {
    const seen = []
    const off = onProxyAuthRequired((v) => seen.push(v))
    // Drop the queued on-subscribe fire from this assertion (it lands on
    // a microtask); we only want the synchronous transition events here.
    seen.length = 0
    setProxyAuthRequired(true)
    setProxyAuthRequired(true)  // no-op (same value)
    setProxyAuthRequired(false)
    assert.deepEqual(seen, [true, false])
    assert.equal(proxyAuthRequired(), false)
    off()
  })

  it('onProxyAuthRequired fires once on subscribe with the current value', async () => {
    setProxyAuthRequired(true)
    const seen = []
    const off = onProxyAuthRequired((v) => seen.push(v))
    await delay(0)  // let the queued microtask run
    assert.deepEqual(seen, [true])
    off()
  })

  it('unsubscribe stops further notifications', () => {
    const seen = []
    const off = onProxyAuthRequired((v) => seen.push(v))
    seen.length = 0
    off()
    setProxyAuthRequired(true)
    assert.deepEqual(seen, [], 'no events after unsubscribe')
  })
})

// ─────────── public surface the UI consumes ───────────

describe('triage-sync: proxyAuthRequired wiring', () => {
  afterEach(() => { setProxyAuthRequired(false) })

  it('exposes the detector latch via triageSync.proxyAuthRequired', () => {
    assert.equal(triageSync.proxyAuthRequired, false)
    setProxyAuthRequired(true)
    assert.equal(triageSync.proxyAuthRequired, true)
  })

  it('triageSync.onProxyAuthRequired delegates to the detector listeners', async () => {
    const seen = []
    const off = triageSync.onProxyAuthRequired((v) => seen.push(v))
    await delay(0)  // on-subscribe fire (current value: false)
    setProxyAuthRequired(true)
    assert.deepEqual(seen, [false, true])
    off()
  })
})
