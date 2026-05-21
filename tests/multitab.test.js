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
import { decodeUtf8 } from '../common/utf8.js'

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

if (globalThis.localStorage === undefined) {
  globalThis.localStorage = createLocalStorage()
}

// Pull in the shared `navigator.locks` polyfill so the Node 22
// local-test loop can exercise saveTriage (which sits inside a
// `navigator.locks.request`). Native on Node 24+ — polyfill is a
// no-op there.
await import('./_polyfills.js')

const { state } = await import('../client/state.ts')
const { saveTriage, reloadTriageFromStorage } = await import('../client/triage.js')
const { triageSync } = await import('../client/sync/triage-sync.ts')
const { patchEntry, setReportIgnored, isReportIgnored } = await import('../client/triage-entry.ts')

const FINDING_A = '00000000-0000-4000-8000-00000000000a'
const FINDING_B = '00000000-0000-4000-8000-00000000000b'

function clearState() {
  state.triage.clear()
  globalThis.localStorage.clear()
}

describe('reloadTriageFromStorage (cross-tab triage)', () => {
  beforeEach(() => clearState())

  it('picks up entries the sibling tab added', async () => {
    // Tab "this": empty.
    // Tab "sibling": adds A=red. We simulate by setting state, calling
    // saveTriage to write the blob, then clearing state to mimic this
    // tab not knowing about it yet.
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    await saveTriage()
    state.triage.clear()

    // Storage event fires here in production via the sibling's write.
    await reloadTriageFromStorage()

    assert.equal(state.triage.get(FINDING_A)?.color, 'red', 'sibling-added marker landed')
  })

  it('removes entries the sibling tab cleared', async () => {
    // Tab "this": A=red, B=blue. Sibling tab clears A but keeps B.
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    patchEntry(state.triage, FINDING_B, { color: 'blue' })
    await saveTriage()
    // Sibling rewrites the blob (only B). Simulate by mutating state
    // and saving — both tabs see the same blob in the end.
    patchEntry(state.triage, FINDING_A, { color: undefined })
    await saveTriage()
    // This tab's in-memory map still has A — it hasn't seen the
    // sibling's write yet. Restore that to mimic tab divergence.
    patchEntry(state.triage, FINDING_A, { color: 'red' })

    await reloadTriageFromStorage()

    assert.equal(state.triage.get(FINDING_A)?.color, undefined, 'sibling-cleared marker removed')
    assert.equal(state.triage.get(FINDING_B)?.color, 'blue', 'unchanged sibling marker preserved')
  })

  it('propagates triage state, comments, and fixes', async () => {
    // Sibling tab persists a fully-annotated finding.
    patchEntry(state.triage, FINDING_A, {
      color: 'gray',
      triage: 'fixed',
      comment: 'verified upstream',
      fix: 'https://example.test/pr/42',
    })
    await saveTriage()

    // This tab knew nothing.
    state.triage.clear()

    await reloadTriageFromStorage()

    assert.equal(state.triage.get(FINDING_A)?.color, 'gray')
    assert.equal(state.triage.get(FINDING_A)?.triage, 'fixed')
    assert.equal(state.triage.get(FINDING_A)?.comment, 'verified upstream')
    assert.equal(state.triage.get(FINDING_A)?.fix, 'https://example.test/pr/42')
  })

  it('honors triage/ignored mutual-exclusion when the blob carries both', async () => {
    // The action handlers + sync layer enforce "triage and per-
    // report ignore can't coexist on a tab" — but a sibling tab on
    // an older build, or a corrupt blob, could carry both for the
    // same id. Reload must mirror the sync-layer mutex (triage
    // wins, ignoredReports skipped) so a multi-tab race can't
    // land this tab in the forbidden state.
    patchEntry(state.triage, FINDING_A, { color: 'red', triage: 'fixed' })
    setReportIgnored(state.triage, FINDING_A, 'r.json', true)
    // saveTriage emits both because state has both — it doesn't
    // enforce the invariant, the action handlers do.
    await saveTriage()
    // This tab's local cleared the ignored entry locally before
    // the storage event arrived (e.g. action handler ran).
    setReportIgnored(state.triage, FINDING_A, 'r.json', false)

    await reloadTriageFromStorage()

    assert.equal(state.triage.get(FINDING_A)?.triage, 'fixed', 'triage preserved')
    assert.equal(isReportIgnored(state.triage, FINDING_A, 'r.json'), false, 'ignored skipped because triage wins')
  })

  it('drops local ignored entries when sibling re-asserted triage on the same id', async () => {
    // Local: id is ignored in r.json. Sibling tab set triage on
    // the same id and saved (which under the mutex also clears
    // their ignored — but if the sibling's blob still has both
    // for any reason, local should drop its ignored entry too).
    setReportIgnored(state.triage, FINDING_A, 'r.json', true)
    await saveTriage()
    // Mimic sibling: write a blob with triage AND ignoredReports
    // for the same id (forbidden state — defends against a
    // sibling running an older build).
    patchEntry(state.triage, FINDING_A, { color: 'red', triage: 'fixed' })
    // ignoredReports already has r.json — leave it so the
    // saved blob carries both.
    await saveTriage()
    // Restore "this tab" state to before the sibling acted.
    state.triage.clear()
    setReportIgnored(state.triage, FINDING_A, 'r.json', true)

    await reloadTriageFromStorage()

    assert.equal(state.triage.get(FINDING_A)?.triage, 'fixed', 'triage applied')
    assert.equal(
      isReportIgnored(state.triage, FINDING_A, 'r.json'),
      false,
      'pre-existing local ignored dropped because blob has triage for this id',
    )
  })

  it('leaves session-only ids alone (numeric ids never round-trip)', async () => {
    // Numeric ids are session-local — they're never written to the
    // blob. Reload must not nuke them when the blob doesn't carry
    // them, otherwise an unsaved-because-numeric edit would vanish
    // every time a sibling tab persisted anything.
    patchEntry(state.triage, '42', { color: 'red' })
    patchEntry(state.triage, FINDING_A, { color: 'blue' })
    await saveTriage()
    // saveTriage skipped the numeric id, so blob has only A.
    // Now simulate a sibling change: blob still only has A.
    await reloadTriageFromStorage()
    assert.equal(state.triage.get('42')?.color, 'red', 'session-only id preserved through reload')
    assert.equal(state.triage.get(FINDING_A)?.color, 'blue')
  })

  it('forward-compat: a blob with unknown future fields loads cleanly', async () => {
    // Defensive: a future build might add a new per-id field
    // (e.g. `state.suppressedReports`) the current reader doesn't
    // recognize. Loading must succeed and leave the known fields
    // populated; unknown fields are silently dropped (current
    // serialiser doesn't preserve them, which is fine — the
    // contract is "old readers don't crash on new fields", not
    // "old readers preserve new fields"). Pin both halves.
    //
    // Build a blob the same way saveTriage would, then splice in
    // an extra field per entry plus a top-level field. Re-encode +
    // base64 + write directly to localStorage, then reload.
    patchEntry(state.triage, FINDING_A, { color: 'red', triage: 'fixed' })
    await saveTriage()
    const raw = globalThis.localStorage.getItem('deepview.triage')
    const compressed = Uint8Array.fromBase64(raw)
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate'))
    const decompressed = new Uint8Array(await new Response(stream).arrayBuffer())
    const entries = JSON.parse(decodeUtf8(decompressed))
    // Splice in unknown fields.
    entries[FINDING_A].suppressedReports = ['x.json']
    entries[FINDING_A].futureFlag = true
    entries.__topLevel = { whatever: 1 }
    const reencoded = new TextEncoder().encode(JSON.stringify(entries))
    const recompressedStream = new Blob([reencoded]).stream().pipeThrough(new CompressionStream('deflate'))
    const recompressed = new Uint8Array(await new Response(recompressedStream).arrayBuffer())
    globalThis.localStorage.setItem('deepview.triage', recompressed.toBase64())

    state.triage.clear()
    await reloadTriageFromStorage()

    // Known fields loaded; unknown fields silently ignored.
    assert.equal(state.triage.get(FINDING_A)?.color, 'red', 'known marker loads')
    assert.equal(state.triage.get(FINDING_A)?.triage, 'fixed', 'known triage loads')
    // Top-level keys that aren't valid id-keyed entries don't crash
    // the loader (the reader iterates entries and treats any object
    // value as a per-id record; `__topLevel`'s `whatever` field has
    // no recognized properties, so nothing lands in state.*).
    assert.equal(state.triage.get('__topLevel')?.color, undefined)
  })

  it('crash mid-compress: pending uncompressed snapshot recovers the user edit', async () => {
    // Audit M3 round-5: saveTriage's `await compressDeflate` window
    // would lose the user's edit on a tab crash — in-memory state.*
    // dies with the process, the compressed key wasn't updated, and
    // triageSync.notify hadn't fired yet. The fix writes an
    // uncompressed snapshot to a `pending` key BEFORE the await;
    // readTriageBlob prefers it on next load.
    //
    // We simulate the crash by stubbing CompressionStream so the
    // await never resolves, kicking saveTriage in the background,
    // then verifying the pending key has the data and reload picks
    // it up.
    patchEntry(state.triage, FINDING_A, { color: 'red', comment: 'pre-crash note' })
    const realCompressionStream = globalThis.CompressionStream
    let resolveStuck
    globalThis.CompressionStream = class {
      constructor() {
        const { writable, readable } = new TransformStream()
        // Block forever — simulates a crash mid-compress.
        this.writable = new WritableStream({ write() { return new Promise((r) => { resolveStuck = r }) } })
        this.readable = readable
        void writable
      }
    }
    try {
      // Fire saveTriage but don't await — it'll hang on compress.
      const saving = saveTriage()
      void saving
      // Pending key landed synchronously before the await.
      const pending = globalThis.localStorage.getItem('deepview.triage.pending')
      assert.ok(pending, 'pending uncompressed blob written sync before compress')
      const parsed = JSON.parse(pending)
      assert.equal(parsed[FINDING_A]?.color, 'red')
      assert.equal(parsed[FINDING_A]?.comment, 'pre-crash note')

      // Simulate restart: clear in-memory state, then reload from
      // localStorage. readTriageBlob prefers pending → state.*
      // recovers.
      state.triage.clear()
      await reloadTriageFromStorage()
      assert.equal(state.triage.get(FINDING_A)?.color, 'red', 'pre-crash marker recovered')
      assert.equal(state.triage.get(FINDING_A)?.comment, 'pre-crash note', 'pre-crash comment recovered')
    } finally {
      globalThis.CompressionStream = realCompressionStream
      // Unblock the stuck stream so the test process can exit
      // cleanly. saveTriage's catch swallows whatever happens after.
      if (resolveStuck) resolveStuck()
    }
  })

  it('successful saveTriage clears the pending key', async () => {
    // Counterpart to the crash test: in the happy path, after the
    // compressed write lands, the pending key is removed so future
    // reads get the (canonical) compressed view.
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    await saveTriage()
    assert.equal(
      globalThis.localStorage.getItem('deepview.triage.pending'),
      null,
      'pending key cleared after successful compress + write',
    )
    assert.ok(
      globalThis.localStorage.getItem('deepview.triage'),
      'compressed key has the canonical blob',
    )
  })

  it('replace-mode reload during local saveTriage preserves in-flight edit (audit round-9 M3)', async () => {
    // Round-9 M3: a sibling tab's storage event reaches us while
    // our own saveTriage is mid-compress (TRIAGE_PENDING_KEY set).
    // Replace-mode applyTriageEntries used to wipe any local state.*
    // id not present in the sibling's blob — including the local
    // edit we just wrote to the pending key but haven't committed
    // to the compressed blob yet. Fix: replace mode reads the
    // pending key and treats its ids as protected local edits.

    // Step 1: a sibling tab persisted FINDING_B=blue (compressed key).
    patchEntry(state.triage, FINDING_B, { color: 'blue' })
    await saveTriage()

    // Step 2: locally, the user edited FINDING_A=red. saveTriage
    // started — synchronously wrote the pending key — but compress
    // is still in flight when the sibling's storage event arrives.
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    globalThis.localStorage.setItem('deepview.triage.pending', JSON.stringify({
      [FINDING_A]: { color: 'red' },
      [FINDING_B]: { color: 'blue' },
    }))

    // Step 3: cross-tab reload (driven by the sibling's storage
    // event firing on the compressed key). Replace mode would have
    // wiped FINDING_A — but the pending-key check protects it.
    await reloadTriageFromStorage()

    assert.equal(state.triage.get(FINDING_A)?.color, 'red',
      'local in-flight edit preserved across cross-tab replace')
    assert.equal(state.triage.get(FINDING_B)?.color, 'blue',
      'sibling\'s entry from compressed blob still present')
  })

  it('replace-mode without pending key still wipes stale local entries', async () => {
    // Sanity: when no in-flight saveTriage is pending (no pending
    // key), replace mode behaves as before — sibling's clear of an
    // id that this tab still has in state.* propagates as a delete.
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    patchEntry(state.triage, FINDING_B, { color: 'blue' })
    await saveTriage()
    // Sibling clears A. Simulate by deleting + re-saving here.
    patchEntry(state.triage, FINDING_A, { color: undefined })
    await saveTriage()
    // Restore A locally (mimic divergence) — no pending key, just
    // a stale state.* entry.
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    assert.equal(globalThis.localStorage.getItem('deepview.triage.pending'), null,
      'no pending key — clean fast-path')

    await reloadTriageFromStorage()

    assert.equal(state.triage.get(FINDING_A)?.color, undefined,
      'sibling\'s clear propagates via replace mode')
    assert.equal(state.triage.get(FINDING_B)?.color, 'blue')
  })

  it('QuotaExceededError on the compressed key falls back to the pending blob (audit round-7)', async () => {
    // saveTriage wraps both writes in try/catch — a quota failure
    // on the compressed key shouldn't take down the in-memory state
    // or block future writes. The pending key (M3 round-5) is the
    // belt-and-suspenders snapshot: written synchronously before the
    // compress await, with `try { } catch {}` around it so its own
    // quota failure can't suppress the main write either.
    //
    // Verify: with quota throwing on the compressed write only, the
    // outer try/catch swallows the error, the pending key still
    // holds the latest data (so reload-from-storage recovers), and
    // the in-memory state.* is unchanged.
    patchEntry(state.triage, FINDING_A, { color: 'red' })
    patchEntry(state.triage, FINDING_A, { comment: 'pre-quota note' })

    const realSetItem = globalThis.localStorage.setItem
    let quotaHits = 0
    globalThis.localStorage.setItem = function setItem(k, v) {
      if (k === 'deepview.triage') {
        quotaHits += 1
        const err = new Error('Quota exceeded')
        err.name = 'QuotaExceededError'
        throw err
      }
      return realSetItem.call(this, k, v)
    }
    const realWarn = console.warn
    const warnCalls = []
    console.warn = (...args) => { warnCalls.push(args) }
    try {
      await saveTriage()
    } finally {
      globalThis.localStorage.setItem = realSetItem
      console.warn = realWarn
    }

    assert.equal(quotaHits, 1, 'compressed-key write attempted exactly once')
    assert.equal(
      globalThis.localStorage.getItem('deepview.triage'),
      null,
      'compressed-key write rejected by quota',
    )
    // Pending key was written BEFORE the compress await, with its
    // own try/catch — and the cleanup `removeItem` after the
    // compressed write never runs because the compressed write
    // threw. So the pending blob should still hold the data.
    const pending = globalThis.localStorage.getItem('deepview.triage.pending')
    assert.ok(pending, 'pending key holds the data after the quota failure')
    const parsed = JSON.parse(pending)
    assert.equal(parsed[FINDING_A]?.color, 'red')
    assert.equal(parsed[FINDING_A]?.comment, 'pre-quota note')

    // saveTriage logged the quota failure via console.warn — pinning
    // the error path so a future change can't silently regress it
    // into a throw.
    assert.ok(
      warnCalls.some((args) => String(args[0] ?? '').includes('Failed to save triage')),
      'saveTriage logged the quota failure',
    )

    // In-memory state.* survives — the user's edit isn't dropped.
    assert.equal(state.triage.get(FINDING_A)?.color, 'red')
    assert.equal(state.triage.get(FINDING_A)?.comment, 'pre-quota note')

    // And reloadTriageFromStorage recovers via the pending key
    // (preferred over the missing compressed key). Same primitive
    // that the M3 round-5 crash test exercises.
    state.triage.clear()
    await reloadTriageFromStorage()
    assert.equal(state.triage.get(FINDING_A)?.color, 'red', 'reload recovered marker via pending key')
    assert.equal(state.triage.get(FINDING_A)?.comment, 'pre-quota note', 'reload recovered comment via pending key')
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
    const { mutateAllSessions } = await import('../client/sync/triage-sync.ts')
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
    // Round-10 freeze added a versioned wrapper: { version, sessions }.
    const wrapper = JSON.parse(globalThis.localStorage.getItem('deepview.sync.sessions') ?? '{}')
    const final = wrapper.sessions ?? wrapper
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

describe('saveTriage — notify + Web-Lock serialization (audit round-12 H10)', () => {
  beforeEach(clearState)

  it('an empty saveTriage still calls triageSync.notify (audit round-12 H10a)', async () => {
    // Pre-fix the empty-entries early `return` exited before
    // reaching `triageSync.notify()`. Clearing the last marker /
    // comment / fix / ignored / triageState left the WS sync layer
    // unaware — peers and sibling tabs subscribing via from=null
    // kept receiving the prior non-empty state until the next
    // unrelated mutation.
    const original = triageSync.notify
    let calls = 0
    triageSync.notify = () => { calls += 1 }
    try {
      // First save with one marker — non-empty branch.
      patchEntry(state.triage, FINDING_A, { color: 'red' })
      await saveTriage()
      const afterFirst = calls
      assert.ok(afterFirst > 0, 'non-empty saveTriage notifies')

      // Clear the marker — empty-branch path.
      patchEntry(state.triage, FINDING_A, { color: undefined })
      await saveTriage()
      assert.ok(calls > afterFirst, 'EMPTY saveTriage also notifies (was the bug)')
    } finally {
      triageSync.notify = original
    }
  })

  it('concurrent saveTriage calls serialise via the Web Lock (audit round-12 H10b)', async () => {
    // Pre-fix two saveTriage calls shared TRIAGE_PENDING_KEY and
    // ran their compress + write phases interleaved. The first to
    // finish would `removeItem(TRIAGE_PENDING_KEY)`, wiping the
    // second's still-needed crash-recovery snapshot; CompressionStream
    // isn't FIFO across separate streams either, so saveTriage1
    // could overwrite saveTriage2's newer TRIAGE_KEY directly.
    //
    // Fix: wrap the whole RMW in `navigator.locks.request`. Two
    // calls now serialize — second waits until first commits.
    // We assert serialization by observing the order of
    // triageSync.notify calls relative to the user mutations
    // they reflect.
    const original = triageSync.notify
    const order = []
    let saveCount = 0
    triageSync.notify = () => {
      saveCount += 1
      order.push(`notify-${saveCount}`)
    }
    try {
      // First write: marker A=red. Second write (queued before
      // first lock release): marker A=blue.
      patchEntry(state.triage, FINDING_A, { color: 'red' })
      const p1 = saveTriage()
      // Mutate state synchronously between the two saveTriage
      // entries — the second one runs against post-mutation state.
      patchEntry(state.triage, FINDING_A, { color: 'blue' })
      const p2 = saveTriage()
      await Promise.all([p1, p2])

      // Both notify calls fired (one per saveTriage commit).
      assert.equal(saveCount, 2, 'both saveTriage commits notified')

      // After both complete, persisted state reflects the LATEST
      // mutation (blue). Without the lock, an out-of-order compress
      // completion could leave 'red' on disk.
      const persisted = globalThis.localStorage.getItem('deepview.triage')
      assert.ok(persisted, 'triage persisted')
      // Decode and assert the marker is 'blue'. We don't go through
      // readTriageBlob (would race the test); decode inline.
      const compressed = Uint8Array.fromBase64(persisted)
      const ds = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate'))
      const decompressed = new Uint8Array(await new Response(ds).arrayBuffer())
      const entries = JSON.parse(decodeUtf8(decompressed))
      assert.equal(entries[FINDING_A].color, 'blue', 'persisted state reflects the latest mutation')
    } finally {
      triageSync.notify = original
    }
  })
})

