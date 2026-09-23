import './_polyfills.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { state } from '../client/state.ts'

test('local triage waits for a local consumer and cannot hydrate a managed surface', async (t) => {
  const previousLocal = state.localMode, previousMode = state.serverMode
  const previousTriage = new Map(state.triage)
  t.after(() => {
    state.serverMode = previousMode
    state.localMode = previousLocal
    state.triage.clear()
    for (const [id, entry] of previousTriage) state.triage.set(id, entry)
    localStorage.removeItem('deepview.triage.pending')
  })
  state.serverMode = 'e2e' // the unconfirmed default on a cold first visit
  state.localMode = false
  state.triage.clear()
  localStorage.setItem('deepview.triage.pending', JSON.stringify({ 'local-only': { color: 'red' } }))
  const reads = []
  const getItem = localStorage.getItem.bind(localStorage)
  t.mock.method(localStorage, 'getItem', (key) => {
    if (key.startsWith('deepview.triage')) reads.push(key)
    return getItem(key)
  })
  const triage = await import('../client/triage.js?managed-boot-regression')
  assert.deepEqual(reads, [], 'importing the client never restores triage before mode detection')
  state.serverMode = 'managed'
  await triage.ensureTriageLoaded()
  await triage.reloadTriageFromStorage()
  assert.deepEqual(reads, [], 'managed boot and storage notifications never read local triage')
  assert.equal(state.triage.size, 0)
  state.localMode = true
  await triage.ensureTriageLoaded()
  assert.equal(state.triage.get('local-only').color, 'red', 'entering local mode still restores annotations')
  state.triage.clear()
  const pending = triage.reloadTriageFromStorage()
  state.localMode = false
  await pending
  assert.equal(state.triage.size, 0, 'a local read finishing after a mode switch cannot populate managed triage')
  state.serverMode = 'standalone'
  state.localMode = true
  await triage.reloadTriageFromStorage()
  assert.equal(state.triage.get('local-only').color, 'red', 'offline fallback restores annotations without a confirmed server protocol')
})
