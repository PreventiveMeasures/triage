// Cross-tab persistence behavior. Two tabs on the same origin share
// localStorage, so a write in one tab is observable by the other —
// either by a sibling reading later, or via the `storage` event
// (which fires only in the OTHER tabs, not the writer). These tests
// exercise the two protections against multi-tab data loss:
//
//   1. The sessions blob (`deepview.sync.sessions`) is read-modify-
//      write — without serialization, two tabs writing entries for
//      different workspaces could clobber each other. `triage-sync`
//      now wraps every RMW in `navigator.locks.request`, so a
//      simulated interleaving still ends up with both entries
//      persisted.
//
//   2. The triage blob (`deepview.triage`) is written wholesale by
//      whichever tab's `saveTriage` runs last; older edits would
//      survive only because the OTHER tab's in-memory state still
//      held them. `client/triage.js` now exposes
//      `reloadTriageFromStorage`, hooked to the `storage` event, so
//      a sibling tab's edits propagate into this tab's state.* even
//      when the sync server is offline.

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

function createLocalStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    clear: () => { store.clear() },
    get length() { return store.size },
    key: (i) => Array.from(store.keys())[i] ?? null,
  }
}

if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = createLocalStorage()
}

const { state } = await import('../client/state.js')
const { saveTriage, reloadTriageFromStorage } = await import('../client/triage.js')

const FINDING_A = '00000000-0000-4000-8000-00000000000a'
const FINDING_B = '00000000-0000-4000-8000-00000000000b'

function clearState() {
  state.markers.clear()
  state.triageState.clear()
  state.comments.clear()
  state.fixes.clear()
  globalThis.localStorage.clear()
}

describe('reloadTriageFromStorage (cross-tab triage)', () => {
  beforeEach(() => clearState())

  it('picks up entries the sibling tab added', async () => {
    // Tab "this": empty.
    // Tab "sibling": adds A=red. We simulate by setting state, calling
    // saveTriage to write the blob, then clearing state to mimic this
    // tab not knowing about it yet.
    state.markers.set(FINDING_A, 'red')
    await saveTriage()
    state.markers.clear()

    // Storage event fires here in production via the sibling's write.
    await reloadTriageFromStorage()

    assert.equal(state.markers.get(FINDING_A), 'red', 'sibling-added marker landed')
  })

  it('removes entries the sibling tab cleared', async () => {
    // Tab "this": A=red, B=blue. Sibling tab clears A but keeps B.
    state.markers.set(FINDING_A, 'red')
    state.markers.set(FINDING_B, 'blue')
    await saveTriage()
    // Sibling rewrites the blob (only B). Simulate by mutating state
    // and saving — both tabs see the same blob in the end.
    state.markers.delete(FINDING_A)
    await saveTriage()
    // This tab's in-memory map still has A — it hasn't seen the
    // sibling's write yet. Restore that to mimic tab divergence.
    state.markers.set(FINDING_A, 'red')

    await reloadTriageFromStorage()

    assert.equal(state.markers.get(FINDING_A), undefined, 'sibling-cleared marker removed')
    assert.equal(state.markers.get(FINDING_B), 'blue', 'unchanged sibling marker preserved')
  })

  it('propagates triage state, comments, and fixes', async () => {
    // Sibling tab persists a fully-annotated finding.
    state.markers.set(FINDING_A, 'gray')
    state.triageState.set(FINDING_A, 'fixed')
    state.comments.set(FINDING_A, 'verified upstream')
    state.fixes.set(FINDING_A, 'https://example.test/pr/42')
    await saveTriage()

    // This tab knew nothing.
    state.markers.clear()
    state.triageState.clear()
    state.comments.clear()
    state.fixes.clear()

    await reloadTriageFromStorage()

    assert.equal(state.markers.get(FINDING_A), 'gray')
    assert.equal(state.triageState.get(FINDING_A), 'fixed')
    assert.equal(state.comments.get(FINDING_A), 'verified upstream')
    assert.equal(state.fixes.get(FINDING_A), 'https://example.test/pr/42')
  })

  it('leaves session-only ids alone (numeric ids never round-trip)', async () => {
    // Numeric ids are session-local — they're never written to the
    // blob. Reload must not nuke them when the blob doesn't carry
    // them, otherwise an unsaved-because-numeric edit would vanish
    // every time a sibling tab persisted anything.
    state.markers.set('42', 'red')
    state.markers.set(FINDING_A, 'blue')
    await saveTriage()
    // saveTriage skipped the numeric id, so blob has only A.
    // Now simulate a sibling change: blob still only has A.
    await reloadTriageFromStorage()
    assert.equal(state.markers.get('42'), 'red', 'session-only id preserved through reload')
    assert.equal(state.markers.get(FINDING_A), 'blue')
  })
})

describe('sessions blob persistence (Web Locks)', () => {
  beforeEach(() => { globalThis.localStorage.clear() })

  it('sessions persistence is serialized — concurrent writes for different workspaces both land', async () => {
    // Without `navigator.locks`, two tabs racing on the
    // read-modify-write of `deepview.sync.sessions` could each load
    // an empty blob, set their own workspace's entry, and write
    // back — the second writer clobbering the first's entry. With
    // the lock the two RMWs serialize; the second sees the first's
    // write before deciding what to write next, so both entries
    // survive.
    //
    // Simulate the race by issuing concurrent `mutateAllSessions`
    // calls whose mutators yield to the microtask queue between
    // read and write. Without the lock those microtasks would
    // interleave and one entry would be lost; with the lock they
    // serialize and both entries land.
    const { mutateAllSessions } = await import('../client/triage-sync.js')
    const order = []
    await Promise.all([
      mutateAllSessions(async (all) => {
        const before = JSON.stringify(all)
        order.push(`A read ${before}`)
        await new Promise((r) => { setTimeout(r, 10) })
        all.A = { serverUrl: 'wss://t', baseRevision: null, savesSinceKeyframe: 0, baseState: { x: 1 } }
        order.push('A write')
      }),
      mutateAllSessions(async (all) => {
        const before = JSON.stringify(all)
        order.push(`B read ${before}`)
        await new Promise((r) => { setTimeout(r, 10) })
        all.B = { serverUrl: 'wss://t', baseRevision: null, savesSinceKeyframe: 0, baseState: { y: 2 } }
        order.push('B write')
      }),
    ])
    const final = JSON.parse(globalThis.localStorage.getItem('deepview.sync.sessions') ?? '{}')
    assert.ok(final.A, 'workspace A persisted')
    assert.ok(final.B, 'workspace B persisted')
    // Lock invariant: the second mutator's READ must see the first's
    // WRITE — otherwise we're not actually serialized.
    const aWriteIdx = order.indexOf('A write')
    const bWriteIdx = order.indexOf('B write')
    const firstReadIdx = Math.min(order.findIndex((s) => s.startsWith('A read')), order.findIndex((s) => s.startsWith('B read')))
    const secondReadIdx = Math.max(order.findIndex((s) => s.startsWith('A read')), order.findIndex((s) => s.startsWith('B read')))
    const firstWriteIdx = Math.min(aWriteIdx, bWriteIdx)
    assert.ok(firstReadIdx < firstWriteIdx, 'first read precedes first write')
    assert.ok(firstWriteIdx < secondReadIdx, 'first writer releases before second reader acquires')
  })
})

