import './_polyfills.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configureClientMode, state, toggleClientMode } from '../client/state.ts'
import { SERVER_MODE_KEY, writeCachedServerInfo } from '../client/sync/server-mode.ts'

async function fixture(t, name) {
  const previous = { serverMode: state.serverMode, serverModeConfig: state.serverModeConfig, serverModeSelection: state.serverModeSelection, localMode: state.localMode }
  t.after(() => { Object.assign(state, previous); localStorage.removeItem(SERVER_MODE_KEY) })
  state.serverModeSelection = null
  configureClientMode('e2e+managed')
  writeCachedServerInfo({ mode: 'e2e+managed', managed: null })
  const calls = []
  t.mock.module('../client/sync-host.js', { namedExports: { applyDefaultSyncHost() {} } })
  t.mock.module('../ui/view/client-sync.js', { namedExports: {
    openWorkspace(id) { calls.push(['open', id]) },
    closeWorkspace(id) { calls.push(['close', id]) },
  } })
  const proxy = await import(`../ui/view/client-sync.js?test=${name}`)
  return { proxy, calls }
}

test('switching to managed while sync imports prevents the pending local workspace open', async (t) => {
  const { proxy, calls } = await fixture(t, 'switch-during-import')
  const opening = proxy.openWorkspace('local')
  toggleClientMode()
  await opening
  assert.deepEqual(calls, [], 'a late sync import must not open local data on the managed surface')
})

test('workspace teardown waits for an existing sync import and still runs after switching to managed', async (t) => {
  const { proxy, calls } = await fixture(t, 'close-during-import')
  const opening = proxy.openWorkspace('first')
  const closing = proxy.closeWorkspace('first')
  await Promise.all([opening, closing])
  assert.deepEqual(calls, [['open', 'first'], ['close', 'first']], 'navigation during import must not leave an old workspace open')
  await proxy.openWorkspace('second')
  toggleClientMode()
  await proxy.closeWorkspace('second')
  assert.deepEqual(calls.slice(2), [['open', 'second'], ['close', 'second']], 'managed mode blocks new work, not teardown')
  await proxy.openWorkspace('blocked')
  assert.equal(calls.length, 4)
})
