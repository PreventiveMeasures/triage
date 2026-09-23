import { test } from 'node:test'
import assert from 'node:assert/strict'
import './_polyfills.js'

import { SERVER_MODE_KEY, classifyServerMode, hasStandaloneProbeHint, parseServerInfo, probeServerInfo, readCachedServerInfo, rememberStandaloneProbe, writeCachedServerInfo } from '../client/sync/server-mode.ts'
import { clientModeLabel, state } from '../client/state.ts'

test('mode labels distinguish standalone, e2e, and both managed surfaces', (t) => {
  const oldMode = state.serverMode
  const oldLocal = state.localMode
  t.after(() => { state.serverMode = oldMode; state.localMode = oldLocal })
  for (const local of [false, true]) {
    state.localMode = local
    state.serverMode = 'standalone'
    assert.equal(clientModeLabel(), 'standalone')
    state.serverMode = 'e2e'
    assert.equal(clientModeLabel(), 'e2e')
    state.serverMode = 'managed'
    assert.equal(clientModeLabel(), local ? 'local' : 'managed')
  }
})

test('standalone paint hints never bind a protocol or suppress future detection', () => {
  localStorage.removeItem(SERVER_MODE_KEY)
  rememberStandaloneProbe()
  assert.equal(hasStandaloneProbeHint(), true)
  assert.equal(readCachedServerInfo(), null)
  const info = { mode: 'managed', managed: null }
  assert.equal(classifyServerMode(readCachedServerInfo()?.mode ?? null, info.mode), 'first')
  writeCachedServerInfo(info)
  assert.deepEqual(readCachedServerInfo(), info)
  assert.equal(hasStandaloneProbeHint(), false, 'a detected backend clears the paint hint')
  localStorage.removeItem(SERVER_MODE_KEY)
})

test('parseServerInfo: valid e2e (managed absent or null both normalize to null)', () => {
  assert.deepEqual(parseServerInfo({ mode: 'e2e' }), { mode: 'e2e', managed: null })
  assert.deepEqual(parseServerInfo({ mode: 'e2e', managed: null }), { mode: 'e2e', managed: null })
  // The `server-info` frame carries a `type` discriminant — ignored.
  assert.deepEqual(
    parseServerInfo({ type: 'server-info', mode: 'e2e', managed: null }),
    { mode: 'e2e', managed: null },
  )
})

test('parseServerInfo: valid managed with login entry points', () => {
  assert.deepEqual(
    parseServerInfo({ mode: 'managed', managed: { loginPath: '/api/auth/github/login', cookieName: '__Host-dvsid' } }),
    { mode: 'managed', managed: { loginPath: '/api/auth/github/login', cookieName: '__Host-dvsid' } },
  )
})

test('parseServerInfo: managed object with a malformed shape degrades to managed:null', () => {
  assert.deepEqual(parseServerInfo({ mode: 'managed', managed: { loginPath: 5 } }), { mode: 'managed', managed: null })
  assert.deepEqual(parseServerInfo({ mode: 'managed', managed: { loginPath: '/x' } }), { mode: 'managed', managed: null })
  assert.deepEqual(parseServerInfo({ mode: 'managed', managed: 'nope' }), { mode: 'managed', managed: null })
})

test('parseServerInfo: rejects non-objects and unknown modes', () => {
  assert.equal(parseServerInfo(null), null)
  assert.equal(parseServerInfo(undefined), null)
  assert.equal(parseServerInfo('e2e'), null)
  assert.equal(parseServerInfo(42), null)
  assert.equal(parseServerInfo({}), null)
  assert.equal(parseServerInfo({ mode: 'other' }), null)
  assert.equal(parseServerInfo({ mode: '' }), null)
})

test('mode probing distinguishes confirmed protocols and standalone from inconclusive failures', async (t) => {
  for (const [name, response, expected] of [
    ['e2e', () => Response.json({ mode: 'e2e' }), { mode: 'e2e', managed: null }],
    ['managed', () => Response.json({ mode: 'managed' }), { mode: 'managed', managed: null }],
    ['standalone', () => new Response('Not found', { status: 404 }), 'standalone'],
    ['server error', () => Response.json({ mode: 'e2e' }, { status: 500 }), null],
    ['unauthorized', () => new Response('', { status: 401 }), null],
    ['invalid JSON', () => new Response('not JSON'), null],
    ['HTML fallback', () => new Response('<html>Static host</html>'), null],
    ['missing mode', () => Response.json({}), null],
    ['unknown mode', () => Response.json({ mode: 'something-else' }), null],
    ['rejected fetch', () => { throw new Error('network failed') }, null],
  ]) {
    await t.test(name, async (subtest) => {
      const fetch = subtest.mock.method(globalThis, 'fetch', (url, options) => {
        assert.equal(url, '/api/config')
        assert.deepEqual(options, { credentials: 'same-origin', headers: { accept: 'application/json' } })
        return Promise.resolve().then(response)
      })
      assert.deepEqual(await probeServerInfo(), expected)
      assert.equal(fetch.mock.callCount(), 1)
    })
  }
})

test('classifyServerMode: first / match / mismatch', () => {
  // Nothing cached yet — accept whatever the server reports.
  assert.equal(classifyServerMode(null, 'e2e'), 'first')
  assert.equal(classifyServerMode(null, 'managed'), 'first')
  // Same protocol — proceed.
  assert.equal(classifyServerMode('e2e', 'e2e'), 'match')
  assert.equal(classifyServerMode('managed', 'managed'), 'match')
  // Cross-mode — refused (both directions).
  assert.equal(classifyServerMode('e2e', 'managed'), 'mismatch')
  assert.equal(classifyServerMode('managed', 'e2e'), 'mismatch')
})
