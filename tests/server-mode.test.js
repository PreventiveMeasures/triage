import { test } from 'node:test'
import assert from 'node:assert/strict'
import './_polyfills.js'

import { SERVER_MODE_KEY, classifyServerMode, hasStandaloneProbeHint, mergeSyncServerInfo, parseServerInfo, probeServerInfo, readCachedServerInfo, rememberStandaloneProbe, waitForServerInfo, writeCachedServerInfo } from '../client/sync/server-mode.ts'
import { clientModeLabel, configureClientMode, isManagedUiMode, state, toggleClientMode } from '../client/state.ts'

test('mode labels distinguish standalone, e2e, and both managed surfaces', (t) => {
  const oldMode = state.serverMode
  const oldLocal = state.localMode
  t.after(() => { state.serverMode = oldMode; state.localMode = oldLocal })
  for (const local of [false, true]) {
    state.localMode = local
    state.serverMode = 'standalone'
    assert.equal(clientModeLabel(), local ? 'local' : 'standalone')
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

test('combined advertisements preserve order, managed login, and e2e scan discovery', () => {
  for (const mode of ['managed+e2e', 'e2e+managed']) {
    const managed = { loginPath: '/api/auth/github/login', cookieName: '__Host-dvsid' }
    assert.deepEqual(parseServerInfo({ mode, managed, deepviewScanServer: 'https://scan.example' }), {
      mode, managed, deepviewScanServer: 'https://scan.example/',
    })
    assert.deepEqual(parseServerInfo({ mode, deepviewScanServer: 'file:///tmp/scan' }), { mode, managed: null })
  }
  for (const mode of ['managed+local', 'e2e+e2e', 'managed+e2e+managed']) assert.equal(parseServerInfo({ mode }), null)
})

test('combined clicks stay in memory through revalidation and reload into the advertised default', async (t) => {
  const previous = { serverMode: state.serverMode, serverModeConfig: state.serverModeConfig, serverModeSelection: state.serverModeSelection, localMode: state.localMode }
  t.after(() => { Object.assign(state, previous); localStorage.removeItem(SERVER_MODE_KEY) })
  for (const [mode, initial, alternate] of [['managed+e2e', 'managed', 'e2e'], ['e2e+managed', 'e2e', 'managed']]) {
    state.serverModeSelection = null
    configureClientMode(mode)
    writeCachedServerInfo({ mode, managed: null })
    const stored = localStorage.getItem(SERVER_MODE_KEY)
    assert.equal(clientModeLabel(), initial)
    assert.equal(isManagedUiMode(), initial === 'managed')
    assert.equal(toggleClientMode(), true)
    assert.equal(clientModeLabel(), alternate)
    assert.equal(state.localMode, false, 'combined modes switch protocols, never into offline local mode')
    assert.equal(isManagedUiMode(), alternate === 'managed')
    configureClientMode(mode)
    assert.equal(clientModeLabel(), alternate, 'background discovery must preserve the click')
    const fresh = await import(`../client/state.ts?reload=${mode}`)
    assert.equal(fresh.clientModeLabel(), initial, 'a new page uses the advertised default')
    assert.equal(fresh.state.serverModeSelection, null)
    assert.equal(toggleClientMode(), true)
    assert.equal(clientModeLabel(), initial)
    assert.equal(localStorage.getItem(SERVER_MODE_KEY), stored, 'clicking never persists a mode preference')
  }
})

test('single managed deployments retain their local switch and e2e stays unswitchable', (t) => {
  const previous = { serverMode: state.serverMode, serverModeConfig: state.serverModeConfig, serverModeSelection: state.serverModeSelection, localMode: state.localMode }
  t.after(() => Object.assign(state, previous))
  state.serverModeSelection = null
  state.localMode = false
  configureClientMode('managed')
  assert.equal(toggleClientMode(), true)
  assert.equal(clientModeLabel(), 'local')
  configureClientMode('managed')
  assert.equal(clientModeLabel(), 'local', 'revalidation keeps the offline surface open')
  assert.equal(toggleClientMode(), true)
  assert.equal(clientModeLabel(), 'managed')
  configureClientMode('e2e')
  assert.equal(toggleClientMode(), false)
  assert.equal(clientModeLabel(), 'e2e')
})

test('the managed surface of either combined deployment blocks lazy e2e sync', async (t) => {
  const previous = { serverMode: state.serverMode, serverModeConfig: state.serverModeConfig, serverModeSelection: state.serverModeSelection, localMode: state.localMode }
  t.after(() => { Object.assign(state, previous); localStorage.removeItem(SERVER_MODE_KEY) })
  const sync = await import('../ui/view/client-sync.js')
  for (const mode of ['managed+e2e', 'e2e+managed']) {
    state.serverModeSelection = null
    configureClientMode(mode)
    writeCachedServerInfo({ mode, managed: null })
    if (!isManagedUiMode()) toggleClientMode()
    assert.equal(await sync.loadSync(), null, 'a combined advertisement does not activate sync on its managed surface')
    assert.equal(await sync.openWorkspace('local-workspace'), undefined)
  }
})

test('e2e connection frames keep a combined deployment configuration and its default', () => {
  for (const mode of ['managed+e2e', 'e2e+managed']) {
    const configured = { mode, managed: { loginPath: '/login', cookieName: 'session' }, deepviewScanServer: 'https://scan.example/' }
    assert.deepEqual(mergeSyncServerInfo(configured, { mode: 'e2e', managed: null }), configured)
    assert.deepEqual(mergeSyncServerInfo(configured, { mode: 'e2e', managed: null, deepviewScanServer: 'https://new-scan.example/' }), {
      ...configured, deepviewScanServer: 'https://new-scan.example/',
    })
  }
  const frame = { mode: 'managed', managed: null }
  assert.deepEqual(mergeSyncServerInfo({ mode: 'e2e', managed: null }, frame), frame, 'single-protocol mismatches remain visible')
  assert.deepEqual(mergeSyncServerInfo(null, frame), frame)
})

test('scan discovery is validated, ignored for managed mode, and never persisted', () => {
  const info = parseServerInfo({ mode: 'e2e', deepviewScanServer: 'https://scan.example/prefix' })
  assert.equal(info.deepviewScanServer, 'https://scan.example/prefix/')
  writeCachedServerInfo(info)
  assert.deepEqual(readCachedServerInfo(), { mode: 'e2e', managed: null })
  localStorage.setItem(SERVER_MODE_KEY, JSON.stringify(info))
  assert.deepEqual(readCachedServerInfo(), { mode: 'e2e', managed: null }, 'old cached URLs cannot enable scanning')
  for (const value of [null, 1, '', 'file:///tmp/scan', 'https://key@scan.example', 'https://scan.example/?key=secret']) {
    assert.deepEqual(parseServerInfo({ mode: 'e2e', deepviewScanServer: value }), { mode: 'e2e', managed: null })
  }
  assert.deepEqual(parseServerInfo({ mode: 'managed', deepviewScanServer: 'https://scan.example' }), { mode: 'managed', managed: null })
  localStorage.removeItem(SERVER_MODE_KEY)
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
    ['managed+e2e', () => Response.json({ mode: 'managed+e2e' }), { mode: 'managed+e2e', managed: null }],
    ['e2e+managed', () => Response.json({ mode: 'e2e+managed' }), { mode: 'e2e+managed', managed: null }],
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
        assert.deepEqual(options, { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } })
        return Promise.resolve().then(response)
      })
      assert.deepEqual(await probeServerInfo(), expected)
      assert.equal(fetch.mock.callCount(), 1)
    })
  }
})

test('startup falls back locally after its wait budget without cancelling a late server response', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let answer
  const probe = new Promise((resolve) => { answer = resolve })
  const startup = waitForServerInfo(probe)
  t.mock.timers.tick(3000)
  assert.equal(await startup, null, 'a hung server must release local startup')
  answer({ mode: 'managed', managed: null })
  assert.deepEqual(await probe, { mode: 'managed', managed: null }, 'the caller can still learn the protocol later')
})

test('startup uses prompt server answers and treats probe failures as a local fallback', async () => {
  const managed = { mode: 'managed', managed: null }
  assert.deepEqual(await waitForServerInfo(Promise.resolve(managed)), managed)
  assert.equal(await waitForServerInfo(Promise.resolve('standalone')), 'standalone')
  assert.equal(await waitForServerInfo(Promise.resolve(null)), null)
  assert.equal(await waitForServerInfo(Promise.reject(new Error('unavailable'))), null)
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
  for (const combined of ['managed+e2e', 'e2e+managed']) {
    assert.equal(classifyServerMode(null, combined), 'first')
    for (const mode of ['e2e', 'managed', 'managed+e2e', 'e2e+managed']) {
      assert.equal(classifyServerMode(mode, combined), 'match')
      assert.equal(classifyServerMode(combined, mode), 'match')
    }
  }
})
