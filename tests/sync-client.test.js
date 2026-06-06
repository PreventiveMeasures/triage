// End-to-end client tests for the triage-sync state machine. Runs
// the real `client/triage-sync.js` in Node against a real server,
// polyfilling the only browser global the client actually needs
// (`localStorage`). Drives the same paths the UI exercises — set
// state.markers, call saveTriage, wait for the protocol round-trip
// — and verifies that the rebase preserves user edits AND surfaces
// remote changes.
//
// This catches the rebase-order bug that the server-side protocol
// tests can't see: a chain or ack that hits the client merges
// correctly only when the overlay is captured BEFORE baseState is
// mutated.
//
// `Uint8Array.fromBase64` / `.toBase64` are stage-3 TC39 methods —
// native in every shipping browser, but in V8 (Node) they're behind
// the `--js-base-64` flag until Node 25. The `npm test` script
// passes that flag; running this file directly needs `node
// --js-base-64 --test tests/sync-client.test.js`.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { Buffer } from 'node:buffer'

// MUST run before any client module loads — `_polyfills.js` shims
// `localStorage` / `navigator.locks` and (critically) drops the
// broken native `Uint8Array.prototype.toHex` that some Node 24.x
// builds expose under `--js-base-64`, before @noble/ciphers captures
// `hasHexBuiltin` at first import.
await import('./_polyfills.js')

const { bootServer } = await import('./_helpers.js')

// ─────────── client modules ───────────

const { triageSync, mutateAllSessions, setHeartbeatTimings, setKeyframeInterval } = await import('../client/sync/triage-sync.ts')
const { state } = await import('../client/state.ts')
const { saveTriage } = await import('../client/triage.js')
const { upsertWorkspace, deleteWorkspace, addReportToWorkspace, setReportWorkspace } = await import('../client/workspaces.js')
const { hydrate: hydrateSecureStorage } = await import('../client/secure-storage.js')
const { patchEntry, isReportIgnored } = await import('../client/triage-entry.ts')

// ─────────── helpers ───────────

function randomBase64() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64')
}

// Each synthetic report needs a `fileName` so triage-sync's
// workspace-scoped buildWorkspaceIds can match it against the
// workspace's `reports` member list. Returns the chosen filename
// so the caller can plug it into upsertWorkspace.
function setReports(findings, fileName = 'test.md') {
  state.reports.length = 0
  state.reports.push({ fileName, groups: [findings] })
  return fileName
}

function clearTriageState() {
  state.triage.clear()
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => { setTimeout(resolve, 25) })
  }
  throw new Error(`waitFor: ${label} did not become true within ${timeoutMs}ms`)
}

function statusOnline() { return triageSync.status === 'online' }

// "Settled after at least one ack": baseRevision has been set, no
// pending save, no encryption in flight. Poll-friendly. NOT just
// `pending == null` — pending starts null and only becomes non-null
// inside trySendSave's async IIFE *after* encryptJson resolves, so
// a naive `pending == null` predicate returns true the moment a
// save is queued, before the round-trip even begins.
function settledAfterAck(workspaceId) {
  const info = triageSync.sessionInfo(workspaceId)
  return info != null
    && info.baseRevision != null
    && info.pending == null
    && !info.encrypting
}

// ─────────── server fixture + per-test workspace ───────────

describe('triage-sync client', () => {
  let server, serverUrl

  before(async () => {
    server = await bootServer()
    serverUrl = server.serverUrl
  })

  after(async () => {
    triageSync.closeSession()
    triageSync.setServerUrl('')
    if (server) await server.teardown()
  })

  // Each scenario gets its own workspace + reports so tests don't
  // pollute each other through the shared module-level `state` /
  // localStorage / sync session.
  async function startSession(findingIds) {
    triageSync.closeSession()
    clearTriageState()
    const fileName = setReports(findingIds.map((id) => ({ id, _id: id })))
    const id = `ws-${Math.random().toString(36).slice(2, 10)}`
    // Workspace must list the synthetic report so buildWorkspaceIds
    // scopes session.ids to those findings.
    await upsertWorkspace({ id, name: id, privateKey: randomBase64(), reports: [fileName] })
    triageSync.openSession(id)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'sync online')
    return id
  }

  it('preserves a user edit made between save and ack', async () => {
    const wsId = await startSession(['finding-A', 'finding-B'])
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    // Simulate the user editing again WHILE the first save is in
    // flight (pending, awaiting ack). saveTriage flips pendingSave
    // because pending is non-null.
    patchEntry(state.triage, 'finding-B', { color: 'green' })
    await saveTriage()
    // The server acks the first save; the rebase should preserve
    // the second edit. Without the fix, applyToReactiveState
    // overwrites state.* with a stale localState snapshot and
    // finding-B → green is silently dropped.
    await waitFor(() => settledAfterAck(wsId), 'ack landed and pending cleared')
    // After the rebase + the follow-up save for finding-B, both
    // edits must still be visible.
    await waitFor(() => state.triage.get('finding-B')?.color === 'green', 'finding-B preserved')
    assert.equal(state.triage.get('finding-A')?.color, 'red')
    assert.equal(state.triage.get('finding-B')?.color, 'green')
    triageSync.closeSession()
    await deleteWorkspace(wsId)
  })

  it('SSE mode: saves go to the REST save plane (POST /api/sync/save), not the session stream', async () => {
    // Force the SSE fallback (WS constructor throws) and spy on fetch while
    // delegating to the real relay. In SSE mode a save must POST to
    // /api/sync/save (session-independent) instead of riding a session POST
    // that would take over the event-stream. Proof: a /api/sync/save fetch
    // happens AND the save commits (settles after the REST ack).
    const realWS = globalThis.WebSocket
    const realFetch = globalThis.fetch
    const fetchedUrls = []
    globalThis.WebSocket = class {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
      constructor() { throw new Error('forced SSE fallback') }
    }
    globalThis.fetch = (input, init) => { fetchedUrls.push(String(input)); return realFetch(input, init) }
    try {
      // Drop any existing WS socket so the next open uses the SSE mock.
      triageSync.setServerUrl('')
      const wsId = await startSession(['finding-A'])
      patchEntry(state.triage, 'finding-A', { color: 'red' })
      await saveTriage()
      await waitFor(() => settledAfterAck(wsId), 'SSE REST save acked')
      assert.ok(
        fetchedUrls.some((u) => u.split('?', 1)[0].endsWith('/api/sync/save')),
        `expected a POST to /api/sync/save in SSE mode, saw ${JSON.stringify(fetchedUrls.slice(-6))}`,
      )
      assert.equal(state.triage.get('finding-A')?.color, 'red', 'REST-routed save committed + applied')
      triageSync.closeSession()
      await deleteWorkspace(wsId)
    } finally {
      globalThis.WebSocket = realWS
      globalThis.fetch = realFetch
      triageSync.setServerUrl('')
    }
  })

  it('SSE mode: a server 413 (too-large) surfaces as a save error, not a stuck pending', async () => {
    const realWS = globalThis.WebSocket
    const realFetch = globalThis.fetch
    globalThis.WebSocket = class {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
      constructor() { throw new Error('forced SSE fallback') }
    }
    // Intercept ONLY the REST save POST → 413; SSE stream fetches pass through.
    globalThis.fetch = (input, init) => {
      if (String(input).split('?', 1)[0].endsWith('/api/sync/save')) {
        return Promise.resolve(new Response(JSON.stringify({ reason: 'too-large' }), { status: 413, headers: { 'content-type': 'application/json' } }))
      }
      return realFetch(input, init)
    }
    try {
      triageSync.setServerUrl('')
      const wsId = await startSession(['finding-A'])
      patchEntry(state.triage, 'finding-A', { color: 'red' })
      await saveTriage()
      // 413 → workspace-save-error{too-large} (non-recoverable) → session.error.
      await waitFor(() => triageSync.sessionInfo(wsId)?.error != null, 'too-large surfaced as session error')
      triageSync.closeSession()
      await deleteWorkspace(wsId)
    } finally {
      globalThis.WebSocket = realWS
      globalThis.fetch = realFetch
      triageSync.setServerUrl('')
    }
  })

  it('SSE mode: a malformed REST save response falls back to the in-band frame (still commits)', async () => {
    const realWS = globalThis.WebSocket
    const realFetch = globalThis.fetch
    let savePosts = 0
    globalThis.WebSocket = class {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
      constructor() { throw new Error('forced SSE fallback') }
    }
    // First REST save POST → malformed 200 (no `id`) → the client must fall
    // back to the in-band frame (over the SSE session POST), which commits.
    globalThis.fetch = (input, init) => {
      if (String(input).split('?', 1)[0].endsWith('/api/sync/save')) {
        savePosts++
        if (savePosts === 1) return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      return realFetch(input, init)
    }
    try {
      triageSync.setServerUrl('')
      const wsId = await startSession(['finding-A'])
      patchEntry(state.triage, 'finding-A', { color: 'red' })
      await saveTriage()
      await waitFor(() => settledAfterAck(wsId), 'in-band fallback save committed')
      assert.equal(state.triage.get('finding-A')?.color, 'red')
      assert.ok(savePosts >= 1, 'the REST save plane was attempted before falling back')
      triageSync.closeSession()
      await deleteWorkspace(wsId)
    } finally {
      globalThis.WebSocket = realWS
      globalThis.fetch = realFetch
      triageSync.setServerUrl('')
    }
  })

  it('merges a remote change with an in-progress local edit', async () => {
    const wsId = await startSession(['finding-A', 'finding-B'])
    // Local: finding-A = red, sync up.
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'first ack')

    // Push a chain from a SECOND client (raw WS) carrying a remote
    // change to finding-B = green. Local A = red must survive; the
    // remote B = green must land.
    const { workspaceTag } = triageSync.sessionInfo(wsId)
    const _persistedRaw = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const persisted = Array.isArray(_persistedRaw) ? _persistedRaw : _persistedRaw.workspaces
    const seed = persisted.find((w) => w.id === wsId).privateKey
    await pushRemoteChange(serverUrl, workspaceTag, seed, { 'finding-B': { color: 'green' } })

    await waitFor(() => state.triage.get('finding-B')?.color === 'green', 'remote change landed')
    assert.equal(state.triage.get('finding-A')?.color, 'red', 'local edit survived')
    assert.equal(state.triage.get('finding-B')?.color, 'green')
    triageSync.closeSession()
    await deleteWorkspace(wsId)
  })

  it('local-wins on a conflicting id (same finding edited both sides)', async () => {
    const wsId = await startSession(['finding-A'])
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')

    // User edits to amber WITHOUT calling saveTriage — simulates a
    // rapid in-flight UI edit between two ticks of the sync loop.
    // The chain handler's captureOverlay reads state.* directly,
    // so the merge must see this edit even though no save is queued.
    patchEntry(state.triage, 'finding-A', { color: 'amber' })

    const beforeRev = triageSync.sessionInfo(wsId).baseRevision
    const { workspaceTag } = triageSync.sessionInfo(wsId)
    const _persistedRaw = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const persisted = Array.isArray(_persistedRaw) ? _persistedRaw : _persistedRaw.workspaces
    const seed = persisted.find((w) => w.id === wsId).privateKey
    // Remote pushes A = blue. Server appends, broadcasts to client A.
    await pushRemoteChange(serverUrl, workspaceTag, seed, { 'finding-A': { color: 'blue' } })

    // Wait for client A's chain handler to advance baseRevision.
    await waitFor(
      () => triageSync.sessionInfo(wsId).baseRevision !== beforeRev,
      'remote chain processed by client A',
    )
    // Local edit (amber) wins over the conflicting remote (blue).
    // Without the rebase fix, captureOverlay-equivalent code would
    // collapse to identity and the user would see the remote value.
    assert.equal(state.triage.get('finding-A')?.color, 'amber')
    triageSync.closeSession()
    await deleteWorkspace(wsId)
  })

  it('chain-receive surfaces conflicts to the resolver and honors "imported" picks', async () => {
    // Pre-fix: a peer's broadcast that disagreed per-property with
    // the user's unsynced overlay was silently overwritten by the
    // overlay-wins merge, and the user's local value then propagated
    // back through the chain — peers' views silently flipped without
    // any UI prompt. Now a resolver registered via
    // setHydrationConflictResolver fires on chain-receive too, with
    // a `'chain'` context tag.
    const { setHydrationConflictResolver } = await import('../client/sync/triage-sync.ts')
    const wsId = await startSession(['finding-A'])
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')

    // User locally re-marks to amber WITHOUT saving — this is the
    // "unsynced overlay" the chain-receive code path captures.
    patchEntry(state.triage, 'finding-A', { color: 'amber' })

    let resolverCalled = false
    let seenContext = null
    let seenConflicts = []
    setHydrationConflictResolver((conflicts, _baseState, context) => {
      resolverCalled = true
      seenContext = context
      seenConflicts = conflicts
      const decisions = {}
      for (const c of conflicts) decisions[`${c.id}:${c.property}`] = 'imported'
      return decisions
    })
    try {
      const beforeRev = triageSync.sessionInfo(wsId).baseRevision
      const { workspaceTag } = triageSync.sessionInfo(wsId)
      const _persistedRaw = JSON.parse(localStorage.getItem('deepview.workspaces'))
      const persisted = Array.isArray(_persistedRaw) ? _persistedRaw : _persistedRaw.workspaces
      const seed = persisted.find((w) => w.id === wsId).privateKey
      await pushRemoteChange(serverUrl, workspaceTag, seed, { 'finding-A': { color: 'blue' } })
      await waitFor(
        () => triageSync.sessionInfo(wsId).baseRevision !== beforeRev,
        'remote chain processed',
      )
      await waitFor(() => resolverCalled, 'chain-conflict resolver fired')
      assert.equal(seenContext, 'chain', 'context tag identifies chain-receive')
      assert.equal(seenConflicts.length, 1)
      assert.deepEqual(seenConflicts[0], {
        id: 'finding-A',
        property: 'color',
        local: 'amber',
        imported: 'blue',
      })
      // "imported" decision applied: local amber → chain's blue.
      await waitFor(() => state.triage.get('finding-A')?.color === 'blue', 'imported decision landed in state.*')
    } finally {
      setHydrationConflictResolver(null)
    }
    triageSync.closeSession()
    await deleteWorkspace(wsId)
  })

  it('chain-receive resolver = "local" preserves local + propagates back to chain', async () => {
    // The pre-fix local-wins-silently behavior is preserved when the
    // user picks "local" (or cancels — null decisions). The local
    // value then propagates to the chain on the next save (audit
    // round-1 rebase semantics).
    const { setHydrationConflictResolver } = await import('../client/sync/triage-sync.ts')
    const wsId = await startSession(['finding-A'])
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')

    patchEntry(state.triage, 'finding-A', { color: 'amber' })

    setHydrationConflictResolver((conflicts) => {
      const decisions = {}
      for (const c of conflicts) decisions[`${c.id}:${c.property}`] = 'local'
      return decisions
    })
    try {
      const beforeRev = triageSync.sessionInfo(wsId).baseRevision
      const { workspaceTag } = triageSync.sessionInfo(wsId)
      const _persistedRaw = JSON.parse(localStorage.getItem('deepview.workspaces'))
      const persisted = Array.isArray(_persistedRaw) ? _persistedRaw : _persistedRaw.workspaces
      const seed = persisted.find((w) => w.id === wsId).privateKey
      await pushRemoteChange(serverUrl, workspaceTag, seed, { 'finding-A': { color: 'blue' } })
      await waitFor(
        () => triageSync.sessionInfo(wsId).baseRevision !== beforeRev,
        'remote chain processed',
      )
      // Local amber stays — overlay-wins merge (the explicit "local"
      // decision matches the default, so applyHydrationDecisions is
      // a no-op for it).
      assert.equal(state.triage.get('finding-A')?.color, 'amber')
    } finally {
      setHydrationConflictResolver(null)
    }
    triageSync.closeSession()
    await deleteWorkspace(wsId)
  })

  it('user unsets locally + peer sets on chain → conflict surfaced (was silent loss of peer\'s value)', async () => {
    // Three-way compare in collectChainConflicts: oldBase had a
    // value, the user cleared it locally (overlay = `{X: null}`),
    // the peer assigned a new value on the chain. Pre-fix the
    // two-way (overlay vs newBaseState) path skipped because
    // `localEntry` was null — applyChangeset replayed the delete on
    // top of the new chain value and the peer's change disappeared.
    const { setHydrationConflictResolver } = await import('../client/sync/triage-sync.ts')
    const wsId = await startSession(['finding-A'])
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')

    // Take Tab A offline, peer pushes a different color, Tab A
    // unsets its local color, Tab A reconnects.
    triageSync.setEnabled(false)
    await waitFor(() => triageSync.status === 'off', 'sync off')
    const { workspaceTag } = triageSync.sessionInfo(wsId)
    const _persistedRaw = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const persisted = Array.isArray(_persistedRaw) ? _persistedRaw : _persistedRaw.workspaces
    const seed = persisted.find((w) => w.id === wsId).privateKey
    await pushRemoteChange(serverUrl, workspaceTag, seed, { 'finding-A': { color: 'blue' } })
    patchEntry(state.triage, 'finding-A', { color: undefined })

    let resolverCalls = 0
    const seenConflicts = []
    setHydrationConflictResolver((conflicts) => {
      resolverCalls += 1
      for (const c of conflicts) seenConflicts.push(c)
      const decisions = {}
      for (const c of conflicts) decisions[`${c.id}:${c.property}`] = 'imported'
      return decisions
    })
    try {
      triageSync.setEnabled(true)
      await waitFor(() => resolverCalls >= 1, 'resolver fired')
      assert.equal(seenConflicts.length, 1)
      assert.deepEqual(seenConflicts[0], {
        id: 'finding-A',
        property: 'color',
        local: '',
        imported: 'blue',
      })
      // "imported" decision applied: peer's blue lands in state.*.
      await waitFor(() => state.triage.get('finding-A')?.color === 'blue', 'imported decision applied')
    } finally {
      setHydrationConflictResolver(null)
    }
    triageSync.closeSession()
    await deleteWorkspace(wsId)
  })

  it('user sets locally + peer unsets on chain → conflict surfaced (was silent override of peer\'s delete)', async () => {
    // Symmetric to the test above. oldBase had a value, the user
    // changed it locally (overlay = `{X: {color: green}}`), the
    // peer deleted the entry on the chain. Pre-fix the two-way
    // path skipped because `chainEntry` was undefined — the
    // overlay-wins merge replayed the user's value on top of the
    // empty chain entry and the peer's delete disappeared.
    const { setHydrationConflictResolver } = await import('../client/sync/triage-sync.ts')
    const wsId = await startSession(['finding-A'])
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')

    triageSync.setEnabled(false)
    await waitFor(() => triageSync.status === 'off', 'sync off')
    const { workspaceTag } = triageSync.sessionInfo(wsId)
    const _persistedRaw = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const persisted = Array.isArray(_persistedRaw) ? _persistedRaw : _persistedRaw.workspaces
    const seed = persisted.find((w) => w.id === wsId).privateKey
    // Peer pushes an explicit delete (changeset entry = null).
    await pushRemoteChange(serverUrl, workspaceTag, seed, { 'finding-A': null })
    patchEntry(state.triage, 'finding-A', { color: 'green' })

    let resolverCalls = 0
    const seenConflicts = []
    setHydrationConflictResolver((conflicts) => {
      resolverCalls += 1
      for (const c of conflicts) seenConflicts.push(c)
      const decisions = {}
      for (const c of conflicts) decisions[`${c.id}:${c.property}`] = 'imported'
      return decisions
    })
    try {
      triageSync.setEnabled(true)
      await waitFor(() => resolverCalls >= 1, 'resolver fired')
      assert.equal(seenConflicts.length, 1)
      assert.deepEqual(seenConflicts[0], {
        id: 'finding-A',
        property: 'color',
        local: 'green',
        imported: '',
      })
      // "imported" decision applied: empty `c.imported` deletes
      // the local marker, matching the peer's chain delete.
      await waitFor(() => state.triage.get('finding-A')?.color === undefined, 'imported (empty) deleted local marker')
    } finally {
      setHydrationConflictResolver(null)
    }
    triageSync.closeSession()
    await deleteWorkspace(wsId)
  })

  it('idempotent stale-base catch-up does not re-fire the conflict dialog (Keep-current double-popup)', async () => {
    // Reproduces the user-reported "Keep current causes the popup to
    // be shown twice" bug. On reconnect, the open-handler's
    // trySendSave kicks an encrypt IIFE in parallel with
    // trySendSubscribe; if the save (with `base = our last known
    // baseRevision`) reaches a server whose head moved past while
    // we were offline, the server replies with a stale-base
    // workspace-state catch-up containing the SAME revisions the
    // subscribe response just delivered. applyChainToBase's
    // idempotent skip (`rev.id === session.baseRevision`) makes
    // that second chain a no-op — but the pre-fix code re-ran
    // collectChainConflicts against the unchanged overlay /
    // baseState and fired the dialog again with the same
    // conflicts. Now handleChain short-circuits when the chain
    // didn't advance baseRevision.
    const { setHydrationConflictResolver } = await import('../client/sync/triage-sync.ts')
    const wsId = await startSession(['finding-A'])
    // Sync up to a known baseline so baseRevision is set.
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')
    const { workspaceTag } = triageSync.sessionInfo(wsId)
    const _persistedRaw = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const persisted = Array.isArray(_persistedRaw) ? _persistedRaw : _persistedRaw.workspaces
    const seed = persisted.find((w) => w.id === wsId).privateKey

    // Take Tab A offline, mutate state.* locally (creating an
    // unsynced overlay), let a peer push past us while we're down,
    // then come back online.
    triageSync.setEnabled(false)
    await waitFor(() => triageSync.status === 'off', 'sync off')
    patchEntry(state.triage, 'finding-A', { color: 'amber' })
    await pushRemoteChange(serverUrl, workspaceTag, seed, { 'finding-A': { color: 'blue' } })

    let resolverCalls = 0
    setHydrationConflictResolver((conflicts) => {
      resolverCalls += 1
      const decisions = {}
      for (const c of conflicts) decisions[`${c.id}:${c.property}`] = 'local'
      return decisions
    })
    try {
      // Reconnect. The open handler kicks both trySendSubscribe
      // (queued waiting for the challenge) and trySendSave (encrypt
      // IIFE). Once the challenge arrives the subscribe ships; the
      // save's encrypt may finish either before or after the
      // server's subscribe response — either way the server returns
      // a workspace-state for the subscribe AND a workspace-state
      // catch-up for the stale-base save. Both contain the peer's
      // chain2 revision. The first applies; the second is a no-op.
      triageSync.setEnabled(true)
      // Wait for at least one resolver call (= the dialog fired
      // for the first, content-bearing chain) and for the save to
      // settle. Then assert no further resolver calls land — give
      // microtasks a generous window to drain in case a second
      // workspace-state was queued behind the first.
      await waitFor(() => resolverCalls >= 1, 'resolver fired for the first chain')
      await waitFor(() => triageSync.sessionInfo(wsId)?.pending == null && !triageSync.sessionInfo(wsId)?.encrypting, 'save round-trip settled')
      // Drain ~250 ms so any post-settle workspace-state catch-up
      // would have arrived + been processed by now.
      await new Promise((resolve) => { setTimeout(resolve, 250) })
      assert.equal(resolverCalls, 1, 'resolver fired exactly once despite the redundant stale-base catch-up')
      assert.equal(state.triage.get('finding-A')?.color, 'amber', 'local value preserved after Keep-current')
    } finally {
      setHydrationConflictResolver(null)
    }
    triageSync.closeSession()
    await deleteWorkspace(wsId)
  })

  it('restores baseRevision + baseState across closeSession / openSession', async () => {
    const wsId = await startSession(['finding-A'])
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')
    const beforeClose = triageSync.sessionInfo(wsId).baseRevision

    triageSync.closeSession()
    // Re-opening with the same workspaceId + server URL should
    // restore the persisted base from localStorage; subscribe uses
    // `from = restored baseRevision`, so the server responds with
    // an empty chain (no new revisions) and the existing state.*
    // edits stay visible.
    triageSync.openSession(wsId)
    await waitFor(statusOnline, 'sync online (re-open)')
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.baseRevision === beforeClose,
      'baseRevision restored from localStorage',
    )
    assert.equal(state.triage.get('finding-A')?.color, 'red', 'triage value preserved')
    triageSync.closeSession()
    await deleteWorkspace(wsId)
  })

  it('exposes triageModifiedAt — stamped on save, restored across reopen', async () => {
    const wsId = await startSession(['finding-A'])
    // Unknown until the first triage change lands.
    assert.equal(triageSync.sessionInfo(wsId).triageModifiedAt, null)
    const beforeSave = Date.now()
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')
    const modAt = triageSync.sessionInfo(wsId).triageModifiedAt
    assert.equal(typeof modAt, 'number')
    assert.ok(modAt >= beforeSave, 'triageModifiedAt stamped at save time')

    // Reopen: the at-head re-subscribe returns an empty chain, so the
    // value must come back from the persisted session blob rather than
    // reset to null — otherwise "triage last modified" would vanish on
    // every reload.
    triageSync.closeSession()
    triageSync.openSession(wsId)
    await waitFor(statusOnline, 'sync online (re-open)')
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.baseRevision != null,
      'baseRevision restored from localStorage',
    )
    assert.equal(triageSync.sessionInfo(wsId).triageModifiedAt, modAt, 'triageModifiedAt restored across reopen')
    triageSync.closeSession()
    await deleteWorkspace(wsId)
  })

  it('skips a revision whose id does not match its content hash', async () => {
    // Fake relay so we can fabricate a chain entry the real server
    // would never produce. The signature is valid; only the `id`
    // field is wrong, hitting the content-hash check that runs
    // before signature verification.
    const wsId = `ws-${Math.random().toString(36).slice(2, 10)}`
    const seed = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['t.md'] })
    setReports([{ id: 'finding-A', _id: 'finding-A' }], 't.md')
    clearTriageState()
    const key = await cryptoMod.deriveSessionKey(seed)
    const { privateKey: signingKey, publicKeyB64: workspaceTag } = await cryptoMod.deriveSigningKeypair(seed, wsId)

    let chainSent = false
    const relay = await startFakeRelay((sock) => {
      sock.on('message', async (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type !== 'workspace-subscribe') return
        sock.send(JSON.stringify({ type: 'workspace-subscribed', workspaceTag: msg.workspaceTag }))
        const aad = cryptoMod.buildAad(workspaceTag, null)
        const { nonce, ciphertext } = await cryptoMod.encryptJson(key, { 'finding-A': { color: 'red' } }, aad)
        const payload = { publicKeyB64: workspaceTag, base: null, nonceB64: nonce, ciphertextB64: ciphertext }
        const signature = await cryptoMod.signSavePayload(signingKey, payload)
        sock.send(JSON.stringify({
          type: 'workspace-state',
          workspaceTag: msg.workspaceTag,
          // 43 base64url chars (correct length for an unpadded
          // SHA-256), but not the real hash of the content.
          revisions: [{
            base: null,
            id: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            nonce, ciphertext, signature,
          }],
        }))
        chainSent = true
      })
    })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(relay.url)
    await waitFor(() => chainSent, 'fake relay sent the bogus chain')
    // The revision was skipped: state.markers must NOT have the
    // 'red' value the (bogus) chain tried to set.
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.baseRevision === null,
      'baseRevision reset via continuity-break recovery (M1)',
    )
    assert.equal(state.triage.get('finding-A')?.color, undefined, 'bogus-id revision did not poison state')
    // M1 round-4: a content-hash mismatch must NOT advance
    // baseRevision to the relay-claimed id (would let a malicious
    // relay drive our chain cursor). Instead it triggers a
    // continuity-break recovery: re-subscribe, the relay sends the
    // bogus chain again, second break runs the full reset, leaving
    // baseRevision at null. The M5 round-3 keyframe-on-skip bump
    // survives the reset so the next save will be a keyframe.
    assert.ok(
      (triageSync.sessionInfo(wsId).savesSinceKeyframe ?? 0) >= 100,
      'savesSinceKeyframe bumped so next save is a keyframe (M5 healing)',
    )
    triageSync.closeSession()
    triageSync.setServerUrl('')
    await deleteWorkspace(wsId)
    await relay.close()
  })

  it('skips a revision whose signature does not verify', async () => {
    const wsId = `ws-${Math.random().toString(36).slice(2, 10)}`
    const seed = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['t.md'] })
    setReports([{ id: 'finding-A', _id: 'finding-A' }], 't.md')
    clearTriageState()
    const key = await cryptoMod.deriveSessionKey(seed)
    const { publicKeyB64: workspaceTag } = await cryptoMod.deriveSigningKeypair(seed, wsId)

    let chainSent = false
    const relay = await startFakeRelay((sock) => {
      sock.on('message', async (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type !== 'workspace-subscribe') return
        sock.send(JSON.stringify({ type: 'workspace-subscribed', workspaceTag: msg.workspaceTag }))
        const aad = cryptoMod.buildAad(workspaceTag, null)
        const { nonce, ciphertext } = await cryptoMod.encryptJson(key, { 'finding-A': { color: 'red' } }, aad)
        const payload = { publicKeyB64: workspaceTag, base: null, nonceB64: nonce, ciphertextB64: ciphertext }
        const id = await cryptoMod.computeRevisionId(payload)
        // Right shape, garbage bytes — the length precheck passes
        // but Ed25519 verify rejects.
        const fakeSignature = Buffer.alloc(64).toString('base64url')
        sock.send(JSON.stringify({
          type: 'workspace-state',
          workspaceTag: msg.workspaceTag,
          revisions: [{ base: null, id, nonce, ciphertext, signature: fakeSignature }],
        }))
        chainSent = true
      })
    })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(relay.url)
    await waitFor(() => chainSent, 'fake relay sent the bad-sig chain')
    await new Promise((resolve) => { setTimeout(resolve, 200) })
    assert.equal(state.triage.get('finding-A')?.color, undefined, 'bad-sig revision did not poison state')
    triageSync.closeSession()
    triageSync.setServerUrl('')
    await deleteWorkspace(wsId)
    await relay.close()
  })

  it('continuity break falls back to full state push when re-subscribe also breaks', async () => {
    // The user has unsaved edits in state.* when a chain arrives
    // whose `base` doesn't match our baseRevision. The client first
    // tries an incremental recovery — re-subscribe with `from =
    // current baseRevision` — but our fake relay returns the same
    // broken chain on every subscribe, so the second break is what
    // trips the full state-push reset. state.* itself MUST survive
    // both rounds (otherwise the user loses every triage they made).
    const wsId = `ws-${Math.random().toString(36).slice(2, 10)}`
    const seed = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['t.md'] })
    setReports([{ id: 'finding-A', _id: 'finding-A' }], 't.md')
    clearTriageState()
    patchEntry(state.triage, 'finding-A', { color: 'green' })

    let chainSent = false
    const relay = await startFakeRelay((sock) => {
      sock.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type !== 'workspace-subscribe') return
        sock.send(JSON.stringify({ type: 'workspace-subscribed', workspaceTag: msg.workspaceTag }))
        // Send a chain whose first revision claims a non-null
        // `base` (we have null) — continuity check fails
        // immediately and applyChainToBase returns false.
        sock.send(JSON.stringify({
          type: 'workspace-state',
          workspaceTag: msg.workspaceTag,
          revisions: [{
            base: 'NONEXISTENT_BASE',
            id: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
            nonce: 'AAAAAAAAAAAAAAAAAAAAAAA',
            ciphertext: 'AAAA',
            signature: Buffer.alloc(64).toString('base64url'),
          }],
        }))
        chainSent = true
      })
    })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(relay.url)
    await waitFor(() => chainSent, 'fake relay sent the broken-continuity chain')
    // The full reset path fires `trySendSave` after wiping
    // baseRevision; the fake relay doesn't respond to saves, so
    // `pending` stays set once that path runs. Use that as the
    // signal that the second break tripped the full reset (rather
    // than guessing a sleep duration).
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.pending != null,
      'full state-push attempted after re-subscribe also broke',
    )
    // state.* preserved across both break attempts.
    assert.equal(state.triage.get('finding-A')?.color, 'green', 'user edit survived resync')
    assert.equal(triageSync.sessionInfo(wsId).baseRevision, null)
    triageSync.closeSession()
    triageSync.setServerUrl('')
    await deleteWorkspace(wsId)
    await relay.close()
  })

  it('continuity break recovers via re-subscribe when the next chain fills the gap', async () => {
    // The first chain breaks continuity (gap in delivery — most
    // realistic shape: a broadcast that skipped one revision).
    // Client should re-subscribe from baseRevision; the re-issued
    // chain is well-formed, so the client applies it cleanly and
    // never falls through to the full state-push reset.
    const wsId = `ws-${Math.random().toString(36).slice(2, 10)}`
    const seed = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['t.md'] })
    setReports([{ id: 'finding-A', _id: 'finding-A' }], 't.md')
    clearTriageState()
    const key = await cryptoMod.deriveSessionKey(seed)
    const { privateKey: signingKey, publicKeyB64: workspaceTag } = await cryptoMod.deriveSigningKeypair(seed, wsId)

    let subscribeCount = 0
    const relay = await startFakeRelay((sock) => {
      sock.on('message', async (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type !== 'workspace-subscribe') return
        subscribeCount++
        sock.send(JSON.stringify({ type: 'workspace-subscribed', workspaceTag: msg.workspaceTag }))
        if (subscribeCount === 1) {
          // Broken chain on the initial subscribe — base claims a
          // revision we never saw.
          sock.send(JSON.stringify({
            type: 'workspace-state',
            workspaceTag: msg.workspaceTag,
            revisions: [{
              base: 'NONEXISTENT_BASE',
              id: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
              nonce: 'AAAAAAAAAAAAAAAAAAAAAAA',
              ciphertext: 'AAAA',
              signature: Buffer.alloc(64).toString('base64url'),
            }],
          }))
        } else {
          // Re-subscribe: send the valid chain the client SHOULD
          // have received the first time.
          const aad = cryptoMod.buildAad(workspaceTag, null)
          const { nonce, ciphertext } = await cryptoMod.encryptJson(key, { 'finding-A': { color: 'red' } }, aad)
          const payload = { publicKeyB64: workspaceTag, base: null, nonceB64: nonce, ciphertextB64: ciphertext }
          const id = await cryptoMod.computeRevisionId(payload)
          const signature = await cryptoMod.signSavePayload(signingKey, payload)
          sock.send(JSON.stringify({
            type: 'workspace-state',
            workspaceTag: msg.workspaceTag,
            revisions: [{ base: null, id, nonce, ciphertext, signature }],
          }))
        }
      })
    })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(relay.url)
    // Wait for the valid chain to land. baseRevision becomes the
    // computed id of the second chain's revision (NOT null — that
    // would mean the full reset path ran).
    await waitFor(
      () => state.triage.get('finding-A')?.color === 'red',
      'incremental recovery applied the valid chain',
    )
    assert.equal(subscribeCount, 2, 'client re-subscribed exactly once')
    assert.notEqual(triageSync.sessionInfo(wsId).baseRevision, null, 'baseRevision set to valid id, not nuked')
    triageSync.closeSession()
    triageSync.setServerUrl('')
    await deleteWorkspace(wsId)
    await relay.close()
  })

  it('heartbeat closes the socket when the server stops responding to pings', async () => {
    // Fake relay accepts the connection but never replies to a
    // `ping`. With heartbeat enabled, the client should hit its
    // pong-timeout and close the socket; status flips to `offline`
    // and the reconnect path takes over.
    const wsId = `ws-${Math.random().toString(36).slice(2, 10)}`
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: randomBase64(), reports: ['t.md'] })
    setReports([{ id: 'finding-A', _id: 'finding-A' }], 't.md')
    clearTriageState()

    const relay = await startFakeRelay((sock) => {
      sock.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        // Replies to subscribe so the client reaches `online`, but
        // ignores ping. Save / chain don't matter for this test.
        if (msg.type === 'workspace-subscribe') {
          sock.send(JSON.stringify({ type: 'workspace-subscribed', workspaceTag: msg.workspaceTag }))
          sock.send(JSON.stringify({ type: 'workspace-state', workspaceTag: msg.workspaceTag, revisions: [] }))
        }
        // Deliberate: no `pong` for `ping`.
      })
    })

    // Tight timings so the test doesn't have to wait the production
    // 15 s + 5 s. Total deadline: ping fires at 50 ms, pong-timeout
    // at +50 ms → socket closed by ~100 ms.
    setHeartbeatTimings({ pingMs: 50, pongMs: 50 })
    triageSync.openSession(wsId)
    triageSync.setServerUrl(relay.url)
    await waitFor(statusOnline, 'sync online')
    // Within ~150 ms the heartbeat must give up and close the socket;
    // status drops out of `online`.
    await waitFor(() => triageSync.status !== 'online', 'heartbeat closed socket', 1_000)

    // Reset to production timings so subsequent tests aren't
    // accidentally driven by tight windows.
    setHeartbeatTimings({ pingMs: 15_000, pongMs: 5_000 })
    triageSync.closeSession()
    triageSync.setServerUrl('')
    await deleteWorkspace(wsId)
    await relay.close()
  })

  it('heartbeat fires during `connecting` (subscribe not yet acked) and closes a dead socket', async () => {
    // Audit gap: existing heartbeat test waits until status reaches
    // `online` before checking the heartbeat, so it doesn't pin the
    // pre-subscribe-ack window. A subscribe that the server never
    // responds to leaves the client in `connecting` indefinitely;
    // the heartbeat must still fire and close a dead socket so the
    // reconnect path takes over.
    const wsId = `ws-${Math.random().toString(36).slice(2, 10)}`
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: randomBase64(), reports: ['t.md'] })
    setReports([{ id: 'finding-A', _id: 'finding-A' }], 't.md')
    clearTriageState()

    // Relay accepts the connection but ignores BOTH the subscribe
    // (so subscribeAcked never flips → status stays `connecting`)
    // AND the ping. Heartbeat must close the socket on its own.
    const relay = await startFakeRelay((sock) => {
      sock.on('message', () => {
        // Deliberate: no `workspace-subscribed` for `workspace-subscribe`,
        // no `pong` for `ping`.
      })
    })

    setHeartbeatTimings({ pingMs: 50, pongMs: 50 })
    triageSync.openSession(wsId)
    triageSync.setServerUrl(relay.url)
    // Wait for the socket to open + subscribe to send (status walks
    // off → offline → connecting). Skip `online` because the relay
    // never ack's subscribe.
    await waitFor(() => triageSync.status === 'connecting', 'reached connecting')
    assert.notEqual(triageSync.status, 'online', 'never reached online (subscribe not acked)')
    // Within ~150 ms heartbeat fires, no pong arrives, socket closes
    // and status drops to offline (or off, depending on enabled state).
    await waitFor(() => triageSync.status !== 'connecting', 'heartbeat closed dead socket from connecting', 1_000)

    setHeartbeatTimings({ pingMs: 15_000, pongMs: 5_000 })
    triageSync.closeSession()
    triageSync.setServerUrl('')
    await deleteWorkspace(wsId)
    await relay.close()
  })

  it('an open socket with no subscribe-ack reads `connecting`, never `online`', async () => {
    // Complaint: the badge read `online` whenever the socket was OPEN,
    // even with nothing subscribed to receive peers' changes — so an
    // action riding a side channel (the SSE REST `/save` plane) could
    // "look online" while nothing was listening upstream. A relay that
    // accepts the WebSocket but sends NO `challenge` holds the session
    // at subscribed === false / subscribeAcked === false with the socket
    // OPEN — the canonical "connected but not listening" shape (and the
    // steady state a silently-dead SSE downstream leaves behind). Status
    // MUST settle at `connecting`, never fall through to `online`.
    //
    // Pre-fix `currentStatus` only gated `connecting` on
    // `subscribed && !subscribeAcked`, so an unsubscribed session
    // (subscribed === false) didn't gate and the status latched `online`
    // off the bare open socket.
    const { WebSocketServer } = await import('ws')
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise((resolve) => { wss.once('listening', resolve) })
    const url = `ws://127.0.0.1:${wss.address().port}`
    // Accept the socket and stay silent — no challenge means the client
    // never gets a nonce, so it can't (and doesn't) subscribe.
    wss.on('connection', () => {})

    const wsId = `ws-${Math.random().toString(36).slice(2, 10)}`
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: randomBase64(), reports: ['t.md'] })
    setReports([{ id: 'finding-A', _id: 'finding-A' }], 't.md')
    clearTriageState()

    // No client ping, so a missing pong can't close the socket out from
    // under the assertion — we want the steady-state status of an
    // open-but-unsubscribed socket.
    setHeartbeatTimings({ pingMs: 0, pongMs: 5_000 })
    triageSync.openSession(wsId)
    triageSync.setServerUrl(url)
    // Socket reaches OPEN (status leaves `offline`); with no
    // subscribe-ack it must sit at `connecting`.
    await waitFor(() => triageSync.status === 'connecting', 'reached connecting on a bare open socket')
    // Give the status ample room to (wrongly) latch `online` if the gate
    // regressed to the old `subscribed && !subscribeAcked` test.
    await new Promise((resolve) => { setTimeout(resolve, 200) })
    assert.equal(triageSync.status, 'connecting', 'open-but-unsubscribed socket is `connecting`')
    assert.notEqual(triageSync.status, 'online', 'never `online` without a subscribe-ack')

    setHeartbeatTimings({ pingMs: 15_000, pongMs: 5_000 })
    triageSync.closeSession()
    triageSync.setServerUrl('')
    await deleteWorkspace(wsId)
    await new Promise((resolve) => { wss.close(resolve) })
  })

  it('emits a keyframe after `keyframeInterval` non-keyframe revisions', async () => {
    // Drop the threshold so we don't have to stage 100 saves.
    // Production stays at 100 — verified by reading sessionInfo
    // after the keyframe round-trip lands.
    setKeyframeInterval(2)
    const wsId = await startSession(['finding-A'])
    // Three saves: the first two bump the counter (1, then 2);
    // the third trips the threshold and goes out as a keyframe.
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'first ack')
    patchEntry(state.triage, 'finding-A', { color: 'green' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'second ack')
    patchEntry(state.triage, 'finding-A', { color: 'blue' })
    await saveTriage()
    // After the third ack, savesSinceKeyframe should be 0 — i.e.
    // the third save was a keyframe, and the counter reset.
    await waitFor(
      () => settledAfterAck(wsId) && (triageSync.sessionInfo(wsId).savesSinceKeyframe ?? -1) === 0,
      'third save emitted as a keyframe (counter reset to 0)',
    )
    assert.equal(state.triage.get('finding-A')?.color, 'blue', 'final state visible after keyframe')
    setKeyframeInterval(100)
    triageSync.closeSession()
    await deleteWorkspace(wsId)
  })

  it('a fresh client subscribed with from=null catches up via the keyframe (no rev_A)', async () => {
    // Two clients on the same workspace: writer A produces a
    // chain [rev_A (regular), kf (keyframe)]. Reader B subscribes
    // fresh — server's from=null path returns from the keyframe,
    // so reader's baseState reflects the keyframe's full content
    // even though rev_A was never delivered.
    // Counter starts at 0; with interval=1 the second save trips
    // the threshold and is emitted as a keyframe.
    setKeyframeInterval(1)
    const wsId = await startSession(['finding-A', 'finding-B'])
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'rev_A ack')
    // Counter should now be 1 — next save will be promoted to a
    // keyframe (interval = 1). Bake finding-B into state to make
    // the keyframe content distinguishable from rev_A's content.
    patchEntry(state.triage, 'finding-B', { color: 'green' })
    await saveTriage()
    await waitFor(
      () => (triageSync.sessionInfo(wsId)?.savesSinceKeyframe ?? -1) === 0,
      'keyframe ack',
    )

    // Fresh reader on a new workspace context — close the writer's
    // session, blow away local state.*, swap the persisted-session
    // entry to look fresh, re-open. This simulates a brand-new
    // device subscribing for the first time.
    triageSync.closeSession()
    clearTriageState()
    // Wipe persisted session so re-open starts at baseRevision=null.
    // Round-10 freeze: sessions blob is now `{ version, sessions }`;
    // legacy bare-object shape still tolerated by loadAllSessions.
    const wrapper = JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}')
    const all = wrapper.sessions ?? wrapper
    delete all[wsId]
    localStorage.setItem('deepview.sync.sessions', JSON.stringify({ version: 1, sessions: all }))
    await hydrateSecureStorage()
    triageSync.openSession(wsId)
    await waitFor(statusOnline, 'reader online')
    // Server returns the chain starting at the keyframe; client
    // applies, replacing the (empty) baseState with the keyframe's
    // full content. state.* now reflects {A: red, B: green}.
    await waitFor(
      () => state.triage.get('finding-A')?.color === 'red' && state.triage.get('finding-B')?.color === 'green',
      'reader caught up via keyframe',
    )
    setKeyframeInterval(100)
    triageSync.closeSession()
    await deleteWorkspace(wsId)
  })

  it('two open sessions sync independently over one socket', async () => {
    // Two workspaces, two reports, disjoint finding-id sets. Both
    // get added to the multi-session map and multiplex over one WS.
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({ fileName: 'A.md', groups: [[ { id: 'finding-in-A', _id: 'finding-in-A' } ]] })
    state.reports.push({ fileName: 'B.md', groups: [[ { id: 'finding-in-B', _id: 'finding-in-B' } ]] })
    const wsA = `ws-A-${Math.random().toString(36).slice(2, 8)}`
    const wsB = `ws-B-${Math.random().toString(36).slice(2, 8)}`
    await upsertWorkspace({ id: wsA, name: wsA, privateKey: randomBase64(), reports: ['A.md'] })
    await upsertWorkspace({ id: wsB, name: wsB, privateKey: randomBase64(), reports: ['B.md'] })

    triageSync.openSession(wsA)
    triageSync.openSession(wsB)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'sync online (both sessions)')

    // Edit a finding in workspace A's scope. Only A's session
    // should produce a save; B's session.ids doesn't include
    // 'finding-in-A' so B's localState diff is empty.
    patchEntry(state.triage, 'finding-in-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsA), 'A acked')
    // B never acked anything (no edits in B's scope).
    assert.equal(triageSync.sessionInfo(wsB).baseRevision, null, 'B remained at null base')

    // Edit a finding in workspace B's scope. Now B saves; A is
    // unaffected because A's session.ids doesn't include
    // 'finding-in-B'.
    const aBaseAfterFirstSave = triageSync.sessionInfo(wsA).baseRevision
    patchEntry(state.triage, 'finding-in-B', { color: 'green' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsB), 'B acked')
    assert.equal(triageSync.sessionInfo(wsA).baseRevision, aBaseAfterFirstSave, 'A base unchanged')

    // Each session has its own chain; the workspaceTags are
    // different so the server tracks them as different routing
    // entries. Verify by checking they advanced independently.
    assert.notEqual(triageSync.sessionInfo(wsA).baseRevision, null)
    assert.notEqual(triageSync.sessionInfo(wsB).baseRevision, null)
    assert.notEqual(triageSync.sessionInfo(wsA).workspaceTag, triageSync.sessionInfo(wsB).workspaceTag)

    triageSync.closeSession(wsA)
    triageSync.closeSession(wsB)
    await deleteWorkspace(wsA)
    await deleteWorkspace(wsB)
  })

  it('closeSession(id) only closes that one; the other keeps syncing', async () => {
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({ fileName: 'A.md', groups: [[ { id: 'fA', _id: 'fA' } ]] })
    state.reports.push({ fileName: 'B.md', groups: [[ { id: 'fB', _id: 'fB' } ]] })
    const wsA = `ws-A-${Math.random().toString(36).slice(2, 8)}`
    const wsB = `ws-B-${Math.random().toString(36).slice(2, 8)}`
    await upsertWorkspace({ id: wsA, name: wsA, privateKey: randomBase64(), reports: ['A.md'] })
    await upsertWorkspace({ id: wsB, name: wsB, privateKey: randomBase64(), reports: ['B.md'] })

    triageSync.openSession(wsA)
    triageSync.openSession(wsB)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'both online')
    // Drop A; B must remain.
    triageSync.closeSession(wsA)
    assert.equal(triageSync.sessionInfo(wsA), null, 'A is closed')
    assert.notEqual(triageSync.sessionInfo(wsB), null, 'B is still open')
    // B can still save.
    patchEntry(state.triage, 'fB', { color: 'amber' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsB), 'B acked after closing A')

    triageSync.closeSession(wsB)
    await deleteWorkspace(wsA)
    await deleteWorkspace(wsB)
  })

  it('propagates a chain update across workspaces sharing a finding-id', async () => {
    // Two workspaces, two reports, BOTH containing the same
    // finding-id. When workspace A's chain advances (a remote peer
    // pushed an update for that shared id), workspace B's session
    // must see state.* change for that id and push a save under
    // B's own tag — the cross-workspace propagation that "shared
    // finding-ids share triage" demands.
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({
      fileName: 'A.md',
      groups: [[ { id: 'shared', _id: 'shared' }, { id: 'a-only', _id: 'a-only' } ]],
    })
    state.reports.push({
      fileName: 'B.md',
      groups: [[ { id: 'shared', _id: 'shared' }, { id: 'b-only', _id: 'b-only' } ]],
    })
    const wsA = `ws-A-${Math.random().toString(36).slice(2, 8)}`
    const wsB = `ws-B-${Math.random().toString(36).slice(2, 8)}`
    const seedA = randomBase64()
    const seedB = randomBase64()
    await upsertWorkspace({ id: wsA, name: wsA, privateKey: seedA, reports: ['A.md'] })
    await upsertWorkspace({ id: wsB, name: wsB, privateKey: seedB, reports: ['B.md'] })

    triageSync.openSession(wsA)
    triageSync.openSession(wsB)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'both online')
    // Both workspaceTags must be derived before we can address A's
    // chain — key derivation is async; openSession kicks subscribe
    // once it lands.
    await waitFor(
      () => triageSync.sessionInfo(wsA)?.workspaceTag != null
        && triageSync.sessionInfo(wsB)?.workspaceTag != null,
      'both workspaceTags derived',
    )

    const tagA = triageSync.sessionInfo(wsA).workspaceTag
    // Push a remote update under A's tag: shared = red. The client's
    // session for A receives the broadcast, applies it, and writes
    // state.markers['shared'] = red. The propagation step that this
    // test pins is what happens NEXT: session B sees state.* changed
    // for an id in its scope and emits its own save under B's tag.
    await pushRemoteChange(serverUrl, tagA, seedA, { shared: { color: 'red' } })

    // A's chain handler advances A's baseRevision.
    await waitFor(
      () => triageSync.sessionInfo(wsA)?.baseRevision != null,
      'A applied the remote update',
    )
    // The cross-workspace propagation: B emits its own save under
    // its own tag, the server acks it, B's baseRevision advances.
    // Without `applyOverlayAndPersist` kicking other sessions, B
    // would never push the shared value and this would time out.
    await waitFor(
      () => triageSync.sessionInfo(wsB)?.baseRevision != null,
      'B propagated the shared update under its own tag',
    )
    assert.equal(state.triage.get('shared')?.color, 'red', 'shared finding visible in state.*')

    // Sanity: the two sessions ended up at different baseRevisions
    // (different tags, different chains), confirming the propagation
    // produced an actual save under B's tag rather than an empty
    // round-trip.
    assert.notEqual(
      triageSync.sessionInfo(wsA).baseRevision,
      triageSync.sessionInfo(wsB).baseRevision,
      'A and B chains advanced independently',
    )

    triageSync.closeSession(wsA)
    triageSync.closeSession(wsB)
    await deleteWorkspace(wsA)
    await deleteWorkspace(wsB)
  })

  it('out-of-workspace ids land in baseState but not in state.* (per-workspace scope contract)', async () => {
    // Spec: U0 has report R0 in workspace W (with finding-A only).
    // R1 (with findings A and B) is loaded but NOT in W. Peer U1
    // (whose workspace also has another report R2 with A, B, C)
    // triages all three. U0 must:
    //   - APPLY A to state.markers (A is in W via R0).
    //   - STORE B in baseState — needed so a future keyframe carries
    //     it for fresh subscribers — but NOT apply to state.markers
    //     (B isn't in W; B's appearance in R1 doesn't count because
    //     R1 isn't in W).
    //   - STORE C in baseState — needed for keyframe — but NOT apply
    //     to state.markers (no report in W has C).
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    // R0 is in W; R1 is loaded but NOT in W.
    state.reports.push({
      fileName: 'R0.md',
      groups: [[ { id: 'finding-A', _id: 'finding-A' } ]],
    })
    state.reports.push({
      fileName: 'R1.md',
      groups: [[ { id: 'finding-A', _id: 'finding-A' }, { id: 'finding-B', _id: 'finding-B' } ]],
    })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    const seed = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['R0.md'] })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'online')
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.workspaceTag != null,
      'tag derived',
    )
    const tag = triageSync.sessionInfo(wsId).workspaceTag

    // Peer pushes triage for all three findings under W's workspaceTag.
    await pushRemoteChange(serverUrl, tag, seed, {
      'finding-A': { color: 'red' },
      'finding-B': { color: 'blue' },
      'finding-C': { color: 'green' },
    })

    // Wait for the in-scope id to land in state.markers (cheapest
    // observable for "the chain applied").
    await waitFor(
      () => state.triage.get('finding-A')?.color === 'red',
      'in-scope id applied',
    )

    // Spec assertion: in-scope A applied; OOS B and C did NOT touch
    // state.markers. (R1 has finding-B but isn't in the workspace, so
    // finding-B is OOS for this session.)
    assert.equal(state.triage.get('finding-A')?.color, 'red', 'A applied (in scope via R0)')
    assert.equal(state.triage.get('finding-B')?.color, undefined, 'B not applied (R1 not in workspace)')
    assert.equal(state.triage.get('finding-C')?.color, undefined, 'C not applied (no report in workspace has it)')

    // baseState carries all three — verified via the persisted-session
    // blob, which mirrors session.baseState. This is what guarantees a
    // future keyframe preserves OOS triage for fresh subscribers.
    const persisted = (JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}').sessions ?? JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}'))[wsId]
    assert.equal(persisted?.baseState?.['finding-A']?.color, 'red', 'A in baseState')
    assert.equal(persisted?.baseState?.['finding-B']?.color, 'blue', 'B in baseState (OOS but stored)')
    assert.equal(persisted?.baseState?.['finding-C']?.color, 'green', 'C in baseState (OOS but stored)')

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('attaching R1 to the workspace hydrates state.* with B from baseState (C stays OOS)', async () => {
    // Spec continuation: from the prior test's state, U0 attaches R1
    // to W. B is now in scope (R1 has B); C is still OOS (no report
    // in W has C). The hydration step (audit H1 fix) reads B from
    // baseState into state.markers; A stays put; C is left in
    // baseState only.
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({
      fileName: 'R0.md',
      groups: [[ { id: 'finding-A', _id: 'finding-A' } ]],
    })
    state.reports.push({
      fileName: 'R1.md',
      groups: [[ { id: 'finding-A', _id: 'finding-A' }, { id: 'finding-B', _id: 'finding-B' } ]],
    })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    const seed = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['R0.md'] })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'online')
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.workspaceTag != null,
      'tag derived',
    )
    const tag = triageSync.sessionInfo(wsId).workspaceTag

    await pushRemoteChange(serverUrl, tag, seed, {
      'finding-A': { color: 'red' },
      'finding-B': { color: 'blue' },
      'finding-C': { color: 'green' },
    })
    await waitFor(
      () => state.triage.get('finding-A')?.color === 'red',
      'A applied (in scope)',
    )
    assert.equal(state.triage.get('finding-B')?.color, undefined, 'B not yet applied')

    // Attach R1 to W. The membership listener refreshes session.ids
    // and hydrates state.* from baseState for the newly-in-scope
    // ids — only B in this case (A was already in scope, C still
    // not in any of W's reports).
    await setReportWorkspace('R1.md', wsId)

    assert.equal(state.triage.get('finding-A')?.color, 'red', 'A still set')
    assert.equal(state.triage.get('finding-B')?.color, 'blue', 'B hydrated from baseState')
    assert.equal(state.triage.get('finding-C')?.color, undefined, 'C still OOS (no report in W has it)')

    // baseState still carries all three (hydration reads, doesn't
    // remove). Future keyframes preserve C for fresh subscribers.
    const persisted = (JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}').sessions ?? JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}'))[wsId]
    assert.equal(persisted?.baseState?.['finding-C']?.color, 'green', 'C remains in baseState after attach')

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('attaching a different report containing only B (not C) hydrates B from baseState', async () => {
    // Spec: "U0 adds R1 ... or adds a different report containing
    // issue B". Verify the "different report" half — instead of R1,
    // attach R3 which contains only finding-B (not A, not C).
    // Hydration must still pick up B from baseState.
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({
      fileName: 'R0.md',
      groups: [[ { id: 'finding-A', _id: 'finding-A' } ]],
    })
    state.reports.push({
      fileName: 'R3.md',
      groups: [[ { id: 'finding-B', _id: 'finding-B' } ]],
    })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    const seed = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['R0.md'] })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'online')
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.workspaceTag != null,
      'tag derived',
    )
    const tag = triageSync.sessionInfo(wsId).workspaceTag
    await pushRemoteChange(serverUrl, tag, seed, {
      'finding-A': { color: 'red' },
      'finding-B': { color: 'blue' },
      'finding-C': { color: 'green' },
    })
    await waitFor(() => state.triage.get('finding-A')?.color === 'red', 'A applied')

    await setReportWorkspace('R3.md', wsId)

    assert.equal(state.triage.get('finding-B')?.color, 'blue', 'B hydrated from R3')
    assert.equal(state.triage.get('finding-C')?.color, undefined, 'C still OOS')

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('hydration on attach with conflict resolver = "imported" overwrites local + propagates to chain', async () => {
    // The resolver is the UI dialog. When the user picks "Apply
    // from chain" for a conflict, state.* gets overwritten with
    // the chain's value, the next save's diff against the
    // (already-matching) baseState is empty, and the chain stays
    // on the imported value.
    const { setHydrationConflictResolver } = await import('../client/sync/triage-sync.ts')
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({
      fileName: 'R0.md',
      groups: [[ { id: 'finding-A', _id: 'finding-A' } ]],
    })
    state.reports.push({
      fileName: 'R1.md',
      groups: [[ { id: 'finding-B', _id: 'finding-B' } ]],
    })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    const seed = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['R0.md'] })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'online')
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.workspaceTag != null,
      'tag derived',
    )
    const tag = triageSync.sessionInfo(wsId).workspaceTag
    await pushRemoteChange(serverUrl, tag, seed, {
      'finding-A': { color: 'red' },
      'finding-B': { color: 'blue' },
    })
    await waitFor(() => state.triage.get('finding-A')?.color === 'red', 'A applied')

    patchEntry(state.triage, 'finding-B', { color: 'green' })

    let resolverCalled = false
    let seenConflicts = []
    setHydrationConflictResolver((conflicts) => {
      resolverCalled = true
      seenConflicts = conflicts
      const decisions = {}
      for (const c of conflicts) decisions[`${c.id}:${c.property}`] = 'imported'
      return decisions
    })
    try {
      await setReportWorkspace('R1.md', wsId)
      // The listener's IIFE is async — wait for the resolver to
      // run AND the resulting saveTriage round-trip to land.
      await waitFor(() => resolverCalled, 'conflict resolver called')
      await waitFor(() => state.triage.get('finding-B')?.color === 'blue', 'imported decision applied')
      assert.equal(seenConflicts.length, 1)
      assert.deepEqual(seenConflicts[0], {
        id: 'finding-B',
        property: 'color',
        local: 'green',
        imported: 'blue',
      })
    } finally {
      setHydrationConflictResolver(null)
    }

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('hydration on attach with conflict resolver = "local" keeps local + propagates local-wins to chain', async () => {
    // Same setup, but the resolver picks "Keep current". Local
    // value wins; the diff against baseState produces a save that
    // pushes the local value to the chain (the gap-only behaviour
    // that this PR's resolver layer is built on).
    const { setHydrationConflictResolver } = await import('../client/sync/triage-sync.ts')
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({
      fileName: 'R0.md',
      groups: [[ { id: 'finding-A', _id: 'finding-A' } ]],
    })
    state.reports.push({
      fileName: 'R1.md',
      groups: [[ { id: 'finding-B', _id: 'finding-B' } ]],
    })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    const seed = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['R0.md'] })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'online')
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.workspaceTag != null,
      'tag derived',
    )
    const tag = triageSync.sessionInfo(wsId).workspaceTag
    await pushRemoteChange(serverUrl, tag, seed, {
      'finding-B': { color: 'blue' },
    })
    // Wait for the chain to land; B is OOS so check via persisted
    // baseState.
    await waitFor(
      () => {
        const _wrapper = JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}')
        const all = _wrapper.sessions ?? _wrapper
        return all[wsId]?.baseState?.['finding-B']?.color === 'blue'
      },
      'B in baseState',
    )
    patchEntry(state.triage, 'finding-B', { color: 'green' })

    let resolverCalled = false
    setHydrationConflictResolver((conflicts) => {
      resolverCalled = true
      const decisions = {}
      for (const c of conflicts) decisions[`${c.id}:${c.property}`] = 'local'
      return decisions
    })
    try {
      await setReportWorkspace('R1.md', wsId)
      await waitFor(() => resolverCalled, 'conflict resolver called')
      // Local 'green' stays; chain advances with the local-wins value.
      await waitFor(() => settledAfterAck(wsId), 'follow-up save acked')
      assert.equal(state.triage.get('finding-B')?.color, 'green', 'local kept')
    } finally {
      setHydrationConflictResolver(null)
    }

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('hydration on attach with cancelled resolver (returns null) keeps local everywhere', async () => {
    // Cancel = same outcome as picking "local" for every conflict.
    const { setHydrationConflictResolver } = await import('../client/sync/triage-sync.ts')
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({
      fileName: 'R0.md',
      groups: [[ { id: 'finding-A', _id: 'finding-A' } ]],
    })
    state.reports.push({
      fileName: 'R1.md',
      groups: [[ { id: 'finding-B', _id: 'finding-B' } ]],
    })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    const seed = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['R0.md'] })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'online')
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.workspaceTag != null,
      'tag derived',
    )
    const tag = triageSync.sessionInfo(wsId).workspaceTag
    await pushRemoteChange(serverUrl, tag, seed, {
      'finding-B': { color: 'blue' },
    })
    await waitFor(
      () => {
        const _wrapper = JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}')
        const all = _wrapper.sessions ?? _wrapper
        return all[wsId]?.baseState?.['finding-B']?.color === 'blue'
      },
      'B in baseState',
    )
    patchEntry(state.triage, 'finding-B', { color: 'green' })

    let resolverCalled = false
    setHydrationConflictResolver(() => {
      resolverCalled = true
      return null
    })
    try {
      await setReportWorkspace('R1.md', wsId)
      await waitFor(() => resolverCalled, 'resolver invoked')
      await waitFor(() => settledAfterAck(wsId), 'save settled')
      assert.equal(state.triage.get('finding-B')?.color, 'green', 'local kept on cancel')
    } finally {
      setHydrationConflictResolver(null)
    }

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('hydration on attach without a registered resolver falls back to gap-only (local-wins)', async () => {
    // No resolver wired (the triage-sync default). Conflicts are
    // silently resolved to local-wins; no dialog shows.
    const { setHydrationConflictResolver } = await import('../client/sync/triage-sync.ts')
    setHydrationConflictResolver(null)
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({
      fileName: 'R0.md',
      groups: [[ { id: 'finding-A', _id: 'finding-A' } ]],
    })
    state.reports.push({
      fileName: 'R1.md',
      groups: [[ { id: 'finding-B', _id: 'finding-B' } ]],
    })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    const seed = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['R0.md'] })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'online')
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.workspaceTag != null,
      'tag derived',
    )
    const tag = triageSync.sessionInfo(wsId).workspaceTag
    await pushRemoteChange(serverUrl, tag, seed, {
      'finding-B': { color: 'blue' },
    })
    await waitFor(
      () => {
        const _wrapper = JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}')
        const all = _wrapper.sessions ?? _wrapper
        return all[wsId]?.baseState?.['finding-B']?.color === 'blue'
      },
      'B in baseState',
    )
    patchEntry(state.triage, 'finding-B', { color: 'green' })

    await setReportWorkspace('R1.md', wsId)
    await waitFor(() => settledAfterAck(wsId), 'save settled')
    assert.equal(state.triage.get('finding-B')?.color, 'green', 'gap-only kept local')

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('hydration on attach is gap-only: pre-existing local triage value wins, propagates to chain', async () => {
    // Spec: "applied (with a conflict resolution dialog, if needed)".
    // Current behavior: hydration is gap-only, so a pre-existing
    // local state.markers[B] takes precedence over baseState[B].
    // The next save then propagates the local value to the chain
    // (local-wins). A conflict dialog isn't currently surfaced for
    // the report-attach path; this test pins the local-wins
    // resolution so a future "ask the user" UX is an additive
    // change that doesn't silently drift.
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({
      fileName: 'R0.md',
      groups: [[ { id: 'finding-A', _id: 'finding-A' } ]],
    })
    state.reports.push({
      fileName: 'R1.md',
      groups: [[ { id: 'finding-B', _id: 'finding-B' } ]],
    })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    const seed = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['R0.md'] })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'online')
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.workspaceTag != null,
      'tag derived',
    )
    const tag = triageSync.sessionInfo(wsId).workspaceTag
    await pushRemoteChange(serverUrl, tag, seed, {
      'finding-A': { color: 'red' },
      'finding-B': { color: 'blue' },
    })
    await waitFor(() => state.triage.get('finding-A')?.color === 'red', 'A applied')

    // Pre-existing local triage on B (e.g. user set it via the
    // console API while R1 was in a different workspace, or it was
    // restored from the deepview.triage blob at module load).
    patchEntry(state.triage, 'finding-B', { color: 'green' })
    // Snapshot the pre-attach baseRevision so the wait below pins to
    // "the membership-listener-driven save acked". `settledAfterAck`
    // alone is trivially true at this point — there's no save in
    // flight yet. The membership listener at triage-sync.ts goes
    // through `await saveTriage()` (which awaits compressDeflate +
    // navigator.locks.request) BEFORE reaching `trySendSave`, so
    // `encrypting=false` is the default state observable on
    // `waitFor`'s sync first-predicate-check. Without this pin,
    // waitFor returns immediately, the reader subscribes, and the
    // chain only contains pushRemoteChange's revision.
    const preAttachRev = triageSync.sessionInfo(wsId).baseRevision

    await setReportWorkspace('R1.md', wsId)

    // Hydration is gap-only — local 'green' is preserved over the
    // chain's 'blue'.
    assert.equal(state.triage.get('finding-B')?.color, 'green', 'local value preserved')

    // Wait for the membership-listener-driven save to ACTUALLY
    // advance the chain past `preAttachRev`. `baseRevision` only
    // moves via `handleAck` in this scenario (no peer pushes during
    // the window), so the predicate firing is a positive proof a
    // save round-tripped.
    await waitFor(
      () => settledAfterAck(wsId) && triageSync.sessionInfo(wsId).baseRevision !== preAttachRev,
      'follow-up save acked',
    )
    const reader = await new Promise((resolve, reject) => {
      const s = new WebSocket(serverUrl)
      s.addEventListener('open', () => resolve(s), { once: true })
      s.addEventListener('error', (e) => reject(e.error ?? new Error('open failed')), { once: true })
    })
    const buffered = []
    reader.addEventListener('message', (e) => buffered.push(JSON.parse(e.data)))
    const { privateKey: signKey } = await cryptoMod.deriveSigningKeypair(seed, wsId)
    await waitFor(() => buffered.some((m) => m.type === 'challenge'), 'reader challenge')
    const challenge = buffered.find((m) => m.type === 'challenge')
    const subSig = await cryptoMod.signSubscribePayload(signKey, tag, null, challenge.nonce)
    reader.send(JSON.stringify({ type: 'workspace-subscribe', workspaceTag: tag, from: null, signature: subSig }))
    await waitFor(() => buffered.some((m) => m.type === 'workspace-state'), 'reader chain')
    const revisions = buffered.filter((m) => m.type === 'workspace-state').flatMap((s) => s.revisions)
    const key = await cryptoMod.deriveSessionKey(seed)
    const cumulative = {}
    for (const rev of revisions) {
      const aad = cryptoMod.buildAad(tag, rev.base)
      const changeset = await cryptoMod.decryptJson(key, rev.nonce, rev.ciphertext, aad)
      for (const [id, entry] of Object.entries(changeset)) {
        if (entry === null) delete cumulative[id]
        else cumulative[id] = entry
      }
    }
    assert.equal(cumulative['finding-B']?.color, 'green', 'chain converged to local-wins value')
    reader.close()

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('attaching a report containing a peer-triaged id does not wipe the chain on the next save', async () => {
    // H1: a peer triaged finding-X via R2; the chain arrived here
    // with baseState[X] populated but state.* untouched (X not in
    // session.ids because R2 wasn't attached). User attaches R2 to
    // the workspace, then edits a different known finding. Without
    // the membership-listener-driven hydration, the next
    // `effectiveLocalState` would call snapshotEntry(X) → {} →
    // emit `X: null` (delete) → wipe the peer's triage from the
    // chain.
    //
    // Simulate the "peer triaged via R2, then we attach R2" sequence
    // by seeding the persisted-base blob directly (via the v2 lock
    // path — same shape `applyChainToBase → persistSession` would
    // produce), then opening the session. That avoids opening a
    // second raw WS to push the chain, which is brittle in the
    // full-suite ordering.
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({
      fileName: 'A.md',
      groups: [[ { id: 'known', _id: 'known' } ]],
    })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: randomBase64(), reports: ['A.md'] })

    // Pre-seed baseState as if a peer's chain had landed for an
    // id this client has no loaded report for. baseRevision must
    // be a non-null content-hash-shaped string so the next save
    // builds a delta against it; the value itself is opaque to
    // this test.
    localStorage.setItem('deepview.sync.sessions', JSON.stringify({
      version: 1,
      sessions: {
        [wsId]: {
          serverUrl,
          baseRevision: 'a'.repeat(43),
          savesSinceKeyframe: 0,
          baseState: { 'unknown-X': { color: 'red', triage: 'fixed' } },
        },
      },
    }))
    await hydrateSecureStorage()

    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    // The session restored baseState from the seeded blob; state.*
    // is empty for unknown-X because applyToReactiveState's scope
    // (session.ids) doesn't include it (R2 not attached).
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.workspaceTag != null,
      'workspaceTag derived',
    )
    assert.equal(state.triage.get('unknown-X')?.color, undefined, 'state.* untouched (X out of scope)')

    // Attach R2 mid-session — both state.reports (renderer) and
    // workspace.reports (membership). The onReportMembershipChanged
    // listener fires; refreshSessionIds sees X is newly in scope
    // and hydrates state.* from baseState before any save runs.
    state.reports.push({
      fileName: 'B.md',
      groups: [[ { id: 'unknown-X', _id: 'unknown-X' } ]],
    })
    await setReportWorkspace('B.md', wsId)
    assert.equal(state.triage.get('unknown-X')?.color, 'red', 'state.* hydrated for newly-in-scope id')
    assert.equal(state.triage.get('unknown-X')?.triage, 'fixed', 'triageState hydrated too')

    // After hydration, a local edit on a different finding produces
    // a save whose effectiveLocalState carries the full unknown-X
    // entry (matching baseState) — so the changeset against
    // baseState contains ONLY the user's edit on 'known' and does
    // NOT emit { 'unknown-X': null }. The post-save in-memory state
    // confirms unknown-X stays set; without hydration, snapshotEntry
    // would return {} and effectiveLocalState would delete it,
    // letting trySendSave emit a wipe.
    patchEntry(state.triage, 'known', { color: 'green' })
    await saveTriage()
    assert.equal(state.triage.get('unknown-X')?.color, 'red', 'unknown-X marker preserved after save')
    assert.equal(state.triage.get('unknown-X')?.triage, 'fixed', 'unknown-X triage preserved after save')

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('regular save does not delete triage for ids the client does not have a report for', async () => {
    // Same root cause as the keyframe variant below, but exercised
    // on the delta-save path: the chain brings in a finding-id the
    // workspace's session.ids doesn't cover, the user edits a
    // KNOWN id, and the resulting non-keyframe save's changeset
    // must NOT include `<unknown>: null` (delete). Without the
    // fix, the very first edit after a chain referencing an
    // unknown id wipes that triage on the server.
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({
      fileName: 'A.md',
      groups: [[ { id: 'known', _id: 'known' } ]],
    })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    const seed = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['A.md'] })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'online')
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.workspaceTag != null,
      'tag derived',
    )
    const tag = triageSync.sessionInfo(wsId).workspaceTag

    await pushRemoteChange(serverUrl, tag, seed, {
      'unknown': { color: 'purple', comment: 'from elsewhere' },
      'known': { color: 'red' },
    })
    await waitFor(
      () => state.triage.get('known')?.color === 'red',
      'remote chain applied',
    )

    // ONE local edit on the known id. With keyframeInterval=100
    // (production default) this stays a regular delta save.
    patchEntry(state.triage, 'known', { color: 'green' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'delta save acked')
    // Sanity: no keyframe was emitted.
    assert.equal(triageSync.sessionInfo(wsId).pending, null)
    assert.notEqual(triageSync.sessionInfo(wsId).savesSinceKeyframe, 0, 'still on the delta path')

    // Subscribe a fresh raw client with from=null. No keyframe in
    // the chain yet → server returns the full chain. Decrypt and
    // apply each revision in order; the final cumulative state
    // must include 'unknown' alongside the latest 'known' value.
    const reader = await new Promise((resolve, reject) => {
      const s = new WebSocket(serverUrl)
      s.addEventListener('open', () => resolve(s), { once: true })
      s.addEventListener('error', (e) => reject(e.error ?? new Error('open failed')), { once: true })
    })
    const buffered = []
    reader.addEventListener('message', (e) => buffered.push(JSON.parse(e.data)))
    const { privateKey: signKey } = await cryptoMod.deriveSigningKeypair(seed, wsId)
    await waitFor(() => buffered.some((m) => m.type === 'challenge'), 'reader challenge')
    const challenge = buffered.find((m) => m.type === 'challenge')
    const subSig = await cryptoMod.signSubscribePayload(signKey, tag, null, challenge.nonce)
    reader.send(JSON.stringify({ type: 'workspace-subscribe', workspaceTag: tag, from: null, signature: subSig }))
    await waitFor(() => buffered.some((m) => m.type === 'workspace-state'), 'reader chain')
    const revisions = buffered
      .filter((m) => m.type === 'workspace-state')
      .flatMap((s) => s.revisions)
    assert.ok(revisions.length >= 2, 'at least the remote save + our delta')
    assert.ok(!revisions.some((r) => r.keyframe), 'chain has no keyframe yet')

    const key = await cryptoMod.deriveSessionKey(seed)
    let cumulative = {}
    for (const rev of revisions) {
      const aad = cryptoMod.buildAad(tag, rev.base)
      const changeset = await cryptoMod.decryptJson(key, rev.nonce, rev.ciphertext, aad)
      // Mirror applyChangeset: null entries delete; present
      // entries overwrite.
      for (const [id, entry] of Object.entries(changeset)) {
        if (entry === null) delete cumulative[id]
        else cumulative[id] = entry
      }
    }
    assert.deepEqual(
      cumulative.unknown,
      { color: 'purple', comment: 'from elsewhere' },
      'unknown-id triage survived the delta save',
    )
    assert.equal(cumulative.known.color, 'green', 'known-id reflects local edit')
    reader.close()

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('keyframe preserves triage for ids the client does not have a report for', async () => {
    // The chain can carry triage for finding-ids the user's
    // session.ids doesn't include — typically a peer triaged a
    // finding from a report this client never imported. The
    // client must still ROUND-TRIP those entries through its own
    // saves; otherwise its first save (or its keyframe) would
    // emit `<unknown>: null` and erase the triage on the server,
    // taking the data with it for every other client that DOES
    // have that report.
    setKeyframeInterval(2)
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({
      fileName: 'A.md',
      groups: [[ { id: 'known', _id: 'known' } ]],
    })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    const seed = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['A.md'] })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'online')
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.workspaceTag != null,
      'tag derived',
    )
    const tag = triageSync.sessionInfo(wsId).workspaceTag

    // A peer pushes a save mentioning a finding-id our session
    // doesn't track (no report for it locally).
    await pushRemoteChange(serverUrl, tag, seed, {
      'unknown': { color: 'purple', comment: 'from elsewhere' },
      'known': { color: 'red' },
    })
    await waitFor(
      () => state.triage.get('known')?.color === 'red',
      'remote chain applied',
    )

    // Two local edits to push savesSinceKeyframe past the
    // threshold (which we lowered to 2). The third save would be
    // the keyframe — but with `keyframeInterval = 2`, the second
    // edit IS the keyframe-promoted one because the chain we just
    // applied bumped the counter to 1.
    patchEntry(state.triage, 'known', { color: 'green' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'second ack')
    patchEntry(state.triage, 'known', { color: 'blue' })
    await saveTriage()
    await waitFor(
      () => (triageSync.sessionInfo(wsId)?.savesSinceKeyframe ?? -1) === 0,
      'keyframe emitted',
    )

    // Open a fresh raw client and subscribe with `from = null` —
    // the server returns the chain starting at the latest
    // keyframe. Decrypt the keyframe; its full state must include
    // the unknown-id entry untouched.
    const reader = await new Promise((resolve, reject) => {
      const s = new WebSocket(serverUrl)
      s.addEventListener('open', () => resolve(s), { once: true })
      s.addEventListener('error', (e) => reject(e.error ?? new Error('open failed')), { once: true })
    })
    const buffered = []
    reader.addEventListener('message', (e) => buffered.push(JSON.parse(e.data)))
    const { privateKey: signKey } = await cryptoMod.deriveSigningKeypair(seed, wsId)
    await waitFor(() => buffered.some((m) => m.type === 'challenge'), 'reader challenge')
    const challenge = buffered.find((m) => m.type === 'challenge')
    const subSig = await cryptoMod.signSubscribePayload(signKey, tag, null, challenge.nonce)
    reader.send(JSON.stringify({ type: 'workspace-subscribe', workspaceTag: tag, from: null, signature: subSig }))
    await waitFor(() => buffered.some((m) => m.type === 'workspace-state'), 'reader chain')
    const revisions = buffered
      .filter((m) => m.type === 'workspace-state')
      .flatMap((s) => s.revisions)
    const kf = revisions.find((r) => r.keyframe)
    assert.ok(kf, 'chain begins at a keyframe')

    const key = await cryptoMod.deriveSessionKey(seed)
    const aad = cryptoMod.buildAad(tag, kf.base)
    const fullState = await cryptoMod.decryptJson(key, kf.nonce, kf.ciphertext, aad)
    // The keyframe's full state must include the unknown-id
    // triage even though our session never had a report for it.
    // Without the effectiveLocalState fix, this entry would be
    // missing — and a fresh subscriber would never see it again.
    assert.deepEqual(
      fullState.unknown,
      { color: 'purple', comment: 'from elsewhere' },
      'unknown-id triage preserved through keyframe',
    )
    assert.equal(fullState.known.color, 'blue', 'known-id reflects latest local edit')
    reader.close()

    setKeyframeInterval(100)
    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('refreshes session.ids when a report is added to the workspace mid-session', async () => {
    // Bug #2: session.ids was captured once at openSession from
    // buildWorkspaceIds(workspaceId), so dragging a new report
    // into the workspace later left its findings outside the
    // session's tracked id set — edits on them silently never
    // synced. trySendSave / captureOverlay now re-read the live
    // workspace membership before computing localState, so a
    // newly-added report's findings join the next save.
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({
      fileName: 'A.md',
      groups: [[ { id: 'in-A', _id: 'in-A' } ]],
    })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: randomBase64(), reports: ['A.md'] })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'online')

    // Initial sanity: edit a known finding, save, ack.
    patchEntry(state.triage, 'in-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'first ack')

    // Add a NEW report mid-session, with a finding the workspace
    // didn't previously track. Drag-into-workspace updates both
    // state.reports (so the renderer knows about it) and
    // workspace.reports (so buildWorkspaceIds includes it).
    state.reports.push({
      fileName: 'B.md',
      groups: [[ { id: 'in-B', _id: 'in-B' } ]],
    })
    await setReportWorkspace('B.md', wsId)

    // Edit the new report's finding. Without the refresh, the
    // session's stale `ids` would skip 'in-B' inside
    // effectiveLocalState → save's changeset would be empty →
    // the edit never reaches the server.
    const beforeRev = triageSync.sessionInfo(wsId).baseRevision
    patchEntry(state.triage, 'in-B', { color: 'green' })
    await saveTriage()
    await waitFor(
      () => triageSync.sessionInfo(wsId).baseRevision !== beforeRev,
      'second ack — new finding synced',
    )

    // Verify by fetching the chain from a fresh raw client and
    // applying it: the cumulative state must include in-B = green.
    const tag = triageSync.sessionInfo(wsId).workspaceTag
    const _persistedRaw = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const persisted = Array.isArray(_persistedRaw) ? _persistedRaw : _persistedRaw.workspaces
    const seed = persisted.find((w) => w.id === wsId).privateKey
    const reader = await new Promise((resolve, reject) => {
      const s = new WebSocket(serverUrl)
      s.addEventListener('open', () => resolve(s), { once: true })
      s.addEventListener('error', (e) => reject(e.error ?? new Error('open failed')), { once: true })
    })
    const buffered = []
    reader.addEventListener('message', (e) => buffered.push(JSON.parse(e.data)))
    const { privateKey: signKey } = await cryptoMod.deriveSigningKeypair(seed, wsId)
    await waitFor(() => buffered.some((m) => m.type === 'challenge'), 'reader challenge')
    const challenge = buffered.find((m) => m.type === 'challenge')
    const subSig = await cryptoMod.signSubscribePayload(signKey, tag, null, challenge.nonce)
    reader.send(JSON.stringify({ type: 'workspace-subscribe', workspaceTag: tag, from: null, signature: subSig }))
    await waitFor(() => buffered.some((m) => m.type === 'workspace-state'), 'reader chain')
    const revisions = buffered
      .filter((m) => m.type === 'workspace-state')
      .flatMap((s) => s.revisions)
    const key = await cryptoMod.deriveSessionKey(seed)
    let cumulative = {}
    for (const rev of revisions) {
      const aad = cryptoMod.buildAad(tag, rev.base)
      const changeset = await cryptoMod.decryptJson(key, rev.nonce, rev.ciphertext, aad)
      for (const [id, entry] of Object.entries(changeset)) {
        if (entry === null) delete cumulative[id]
        else cumulative[id] = entry
      }
    }
    assert.equal(cumulative['in-B']?.color, 'green', 'newly-added report\'s edit reached the chain')
    reader.close()

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('chain arriving for a closed session is dropped without touching state.*', async () => {
    // Bug #1 first line of defense: handleMessage looks the session
    // up by workspaceTag at handler entry; a tag with no live
    // session (because closeSession ran) is silently dropped.
    // Rather than race against a real-server broadcast, drive the
    // delivery through a fake relay that delays the chain via
    // setTimeout — closeSession runs synchronously before the
    // delivery, so the chain lands at a closed-session.
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({
      fileName: 'A.md',
      groups: [[ { id: 'finding-X', _id: 'finding-X' } ]],
    })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    const seed = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['A.md'] })
    const key = await cryptoMod.deriveSessionKey(seed)
    const { privateKey: signKey, publicKeyB64: workspaceTag } = await cryptoMod.deriveSigningKeypair(seed, wsId)

    let chainSent = false
    const relay = await startFakeRelay((sock) => {
      sock.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type !== 'workspace-subscribe') return
        sock.send(JSON.stringify({ type: 'workspace-subscribed', workspaceTag: msg.workspaceTag }))
        sock.send(JSON.stringify({ type: 'workspace-state', workspaceTag: msg.workspaceTag, revisions: [] }))
        // Send the chain after a small delay so the test has time
        // to call closeSession before the message hits handleMessage.
        setTimeout(async () => {
          const aad = cryptoMod.buildAad(workspaceTag, null)
          const { nonce, ciphertext } = await cryptoMod.encryptJson(key, { 'finding-X': { color: 'purple' } }, aad)
          const payload = { publicKeyB64: workspaceTag, base: null, nonceB64: nonce, ciphertextB64: ciphertext }
          const id = await cryptoMod.computeRevisionId(payload)
          const signature = await cryptoMod.signSavePayload(signKey, payload)
          sock.send(JSON.stringify({
            type: 'workspace-state',
            workspaceTag,
            revisions: [{ base: null, id, nonce, ciphertext, signature }],
          }))
          chainSent = true
        }, 100)
      })
    })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(relay.url)
    await waitFor(statusOnline, 'online')
    // Close the session synchronously before the relay's setTimeout
    // fires — by the time the chain message hits handleMessage,
    // getSessionByTag returns null and the message is dropped.
    triageSync.closeSession(wsId)
    await waitFor(() => chainSent, 'relay sent the chain')
    // Give the message handler a chance to run.
    await new Promise((resolve) => { setTimeout(resolve, 100) })
    assert.equal(state.triage.get('finding-X')?.color, undefined, 'closed-session chain did not pollute state.*')

    triageSync.setServerUrl('')
    await deleteWorkspace(wsId)
    await relay.close()
  })

  it('non-recoverable crypto failure surfaces as `error` status with a per-session message', async () => {
    // Bug #5: persistent encrypt/sign failure (or, more directly,
    // a bad privateKey that fails key derivation) used to log to
    // the console and silently retry forever — no UI signal, the
    // user sees "online" but no data ever lands. Now: session
    // sets `error`, currentStatus aggregates to 'error', and the
    // sidebar surfaces it with the per-session message.
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({ fileName: 'A.md', groups: [[ { id: 'in-A', _id: 'in-A' } ]] })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    // Malformed privateKey: not 32 bytes after base64 decode.
    // deriveSessionKey throws inside the openSession IIFE.
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: 'AAAA', reports: ['A.md'] })

    const seenStatuses = []
    const off = triageSync.onStatusChange((s) => seenStatuses.push(s))
    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)

    // Wait for the key-derivation failure to land + the error to
    // bubble through emitStatusIfChanged.
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.error != null,
      'session.error set after key derivation failure',
    )
    assert.match(triageSync.sessionInfo(wsId).error, /key derivation failed/iu)
    // Status aggregates to 'error', not 'online' — even though the
    // socket may be open, no save under this workspace will ever
    // land, so the UI must signal something is wrong.
    await waitFor(() => triageSync.status === 'error', 'status flips to error')
    assert.ok(seenStatuses.includes('error'), 'status listener fired with `error`')

    // dismissError() with no args clears every session's error;
    // the kicked re-derivation still fails, but only test that
    // the no-arg form exists and clears the error transiently
    // (the next round-trip will re-set it).
    triageSync.dismissError(wsId)
    assert.equal(triageSync.sessionInfo(wsId).error, null, 'dismissError clears the error field')

    off()
    triageSync.closeSession(wsId)
    triageSync.setServerUrl('')
    await deleteWorkspace(wsId)
  })

  it('setServerUrl re-runs key derivation when keys never landed (PR #10 audit F1)', async () => {
    // Same regression class as `dismissError re-runs key derivation`,
    // but for the server-URL lifecycle path. setServerUrl clears
    // `session.error` and `session.error` can carry FOUR classes —
    // three of which are LOCAL (workspace gone, key derivation
    // failed, encrypt/sign failed). Clearing without re-running
    // key derivation leaves the session "looks online, silently
    // fails to sync".
    //
    // Test design subtlety (round-6 audit F6): the bad-key + retry
    // pattern is the natural way to surface a key-derivation failure,
    // but `upsertWorkspace(... fresh key ...)` fires
    // `onWorkspacePrivateKeyChanged` which separately re-derives —
    // masking whether F1's own kick fired. To pin F1 uniquely: do
    // NOT fix the privateKey. Instead, observe that the SAME bad-key
    // failure re-surfaces AFTER the lifecycle handler. With F1 the
    // kick re-runs (error cleared → derivation fails again → error
    // re-set). Without F1 the error stays cleared (no kick → no
    // derivation → no re-failure).
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({ fileName: 'A.md', groups: [[ { id: 'in-A', _id: 'in-A' } ]] })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: 'AAAA', reports: ['A.md'] })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.error?.startsWith('key derivation failed'),
      'initial key-derivation failure surfaced',
    )
    assert.equal(triageSync.sessionInfo(wsId).workspaceTag, null)

    // Call setServerUrl with a DIFFERENT URL so the early-return
    // at the top (`if (next === serverUrl) return`) doesn't skip the
    // body. The server's upgrade handler strips `?…` so this still
    // hits `/api/sync`.
    triageSync.setServerUrl(`${serverUrl}?retry=1`)

    // F1 fix: setServerUrl's body runs kickKeyDerivation when keys
    // are missing AND error was present. With the SAME bad key still
    // in localStorage, derivation fails again and re-sets the error.
    // Without F1, the error stays cleared (no kick → no re-failure).
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.error?.startsWith('key derivation failed'),
      'kick re-fired (error re-surfaced after lifecycle handler)',
    )

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('setEnabled(true) re-runs key derivation when keys never landed (PR #10 audit F1)', async () => {
    // Same pin shape as the setServerUrl test above — observe that
    // the bad-key error RE-SURFACES after the lifecycle handler,
    // proving the kick fired. Doesn't fix the key so the change
    // can't be masked by `onWorkspacePrivateKeyChanged`.
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({ fileName: 'A.md', groups: [[ { id: 'in-A', _id: 'in-A' } ]] })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: 'AAAA', reports: ['A.md'] })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.error?.startsWith('key derivation failed'),
      'initial key-derivation failure surfaced',
    )

    triageSync.setEnabled(false)
    triageSync.setEnabled(true)

    await waitFor(
      () => triageSync.sessionInfo(wsId)?.error?.startsWith('key derivation failed'),
      'kick re-fired after setEnabled(false) + setEnabled(true)',
    )

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('setForcedOff(false) re-runs key derivation when keys never landed (PR #10 audit round-8 F1)', async () => {
    // Third F1 path — server/README.md's error-handling matrix lists
    // setForcedOff(false) alongside setServerUrl and setEnabled(true)
    // as a lifecycle handler that clears `session.error` AND re-kicks
    // key derivation. The other two paths have F1 regression tests
    // above; this one pins setForcedOff so a future refactor that
    // drops `kickKeyDerivation` from its body fails loudly. Same
    // pin shape: error must RE-SURFACE after the handler, proving
    // the kick fired (a no-op clear-only would leave the error
    // cleared).
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({ fileName: 'A.md', groups: [[ { id: 'in-A', _id: 'in-A' } ]] })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: 'AAAA', reports: ['A.md'] })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.error?.startsWith('key derivation failed'),
      'initial key-derivation failure surfaced',
    )

    triageSync.setForcedOff(true)
    triageSync.setForcedOff(false)

    await waitFor(
      () => triageSync.sessionInfo(wsId)?.error?.startsWith('key derivation failed'),
      'kick re-fired after setForcedOff(true) + setForcedOff(false)',
    )

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('dismissError re-runs key derivation when keys never landed', async () => {
    // Regression: dismissError used to just clear `session.error`
    // and call trySendSubscribe / trySendSave. Both silently bail
    // on `!session.key || !session.signingKey`, so a no-keys
    // session that the user retried looked recovered — the error
    // chip went away — but no save ever went out and the workspace
    // tag stayed null forever. The fix re-runs key derivation in
    // that case, so a corrected privateKey actually heals the
    // session.
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({ fileName: 'A.md', groups: [[ { id: 'in-A', _id: 'in-A' } ]] })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: 'AAAA', reports: ['A.md'] })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.error != null,
      'initial key-derivation failure surfaced',
    )
    // Pre-condition: session has no usable keys yet — workspaceTag
    // is the public part, populated only after a successful
    // derivation.
    assert.equal(triageSync.sessionInfo(wsId).workspaceTag, null)

    // User "fixes" the workspace (e.g. re-imports it with a
    // correct-length key). Same workspace id, fresh privateKey.
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: randomBase64(), reports: ['A.md'] })

    triageSync.dismissError(wsId)
    // Without the fix, workspaceTag would stay null and the session
    // would silently never sync. With the fix, dismissError calls
    // kickKeyDerivation which picks up the fresh privateKey.
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.workspaceTag != null,
      'workspaceTag set after dismissError re-runs key derivation',
    )
    await waitFor(statusOnline, 'session reaches online after retry')
    assert.equal(triageSync.sessionInfo(wsId).error, null)

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('triage state transitions (fixed/invalid/deleted) round-trip through the chain', async () => {
    // Regression for the entriesEqual gap left over from the
    // Fixed/Invalid/Deleted bucket commit: snapshotEntry was
    // updated to emit `entry.triage` and applyToReactiveState was
    // updated to read it, but entriesEqual still compared the
    // legacy `deleted` boolean — so `computeChangeset` saw two
    // entries that differed only in `triage` as equal, the
    // changeset went out empty, and triage transitions were
    // silently never synced.
    const wsId = await startSession(['finding-A'])
    patchEntry(state.triage, 'finding-A', { triage: 'fixed' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'fixed acked')
    const baseAfterFixed = triageSync.sessionInfo(wsId).baseRevision

    patchEntry(state.triage, 'finding-A', { triage: 'invalid' })
    await saveTriage()
    await waitFor(
      () => triageSync.sessionInfo(wsId).baseRevision !== baseAfterFixed,
      'invalid acked (transition synced)',
    )

    // Verify the chain on the server reflects the latest value.
    const tag = triageSync.sessionInfo(wsId).workspaceTag
    const _persistedRaw = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const persisted = Array.isArray(_persistedRaw) ? _persistedRaw : _persistedRaw.workspaces
    const seed = persisted.find((w) => w.id === wsId).privateKey
    const reader = await new Promise((resolve, reject) => {
      const s = new WebSocket(serverUrl)
      s.addEventListener('open', () => resolve(s), { once: true })
      s.addEventListener('error', (e) => reject(e.error ?? new Error('open failed')), { once: true })
    })
    const buffered = []
    reader.addEventListener('message', (e) => buffered.push(JSON.parse(e.data)))
    const { privateKey: signKey } = await cryptoMod.deriveSigningKeypair(seed, wsId)
    await waitFor(() => buffered.some((m) => m.type === 'challenge'), 'reader challenge')
    const challenge = buffered.find((m) => m.type === 'challenge')
    const subSig = await cryptoMod.signSubscribePayload(signKey, tag, null, challenge.nonce)
    reader.send(JSON.stringify({ type: 'workspace-subscribe', workspaceTag: tag, from: null, signature: subSig }))
    await waitFor(() => buffered.some((m) => m.type === 'workspace-state'), 'reader chain')
    const revisions = buffered
      .filter((m) => m.type === 'workspace-state')
      .flatMap((s) => s.revisions)
    const key = await cryptoMod.deriveSessionKey(seed)
    let cumulative = {}
    for (const rev of revisions) {
      const aad = cryptoMod.buildAad(tag, rev.base)
      const changeset = await cryptoMod.decryptJson(key, rev.nonce, rev.ciphertext, aad)
      for (const [id, entry] of Object.entries(changeset)) {
        if (entry === null) delete cumulative[id]
        else cumulative[id] = entry
      }
    }
    assert.equal(cumulative['finding-A']?.triage, 'invalid', 'latest triage value reached the chain')
    reader.close()

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('deleteWorkspace tears down the live session and drops persisted base', async () => {
    const wsId = await startSession(['finding-A'])
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')

    // Sanity: session is live and a persisted entry exists.
    assert.notEqual(triageSync.sessionInfo(wsId), null)
    const _wrapperBefore = JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}')
    const persistedBefore = _wrapperBefore.sessions ?? _wrapperBefore
    assert.ok(persistedBefore[wsId], 'persisted session entry exists pre-delete')

    // Workspace deletion goes through the listener wired up in
    // triage-sync at module init: in-memory session is dropped AND
    // the persisted-base entry is wiped, so the same id can't get
    // reanimated from a stale chain on the next page load.
    await deleteWorkspace(wsId)

    // The in-memory teardown is synchronous (sessions.delete) but
    // the persisted-base wipe goes through navigator.locks.request,
    // so the localStorage write resolves a microtask later. Poll
    // briefly for it to land.
    assert.equal(triageSync.sessionInfo(wsId), null, 'session removed in-memory')
    await waitFor(
      () => (JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}').sessions ?? JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}'))[wsId] === undefined,
      'persisted session entry dropped',
    )
  })

  it('rotating a workspace privateKey tears down + reopens the live session under the new identity', async () => {
    // upsertWorkspace with a different privateKey for the same id
    // (re-import of a re-keyed bundle, or a future "rotate key"
    // affordance). The live session has cached signingKey /
    // workspaceTag derived from the OLD key — keeping it would
    // route saves to an orphan workspaceTag. The privateKey-change
    // listener tears down the session, drops the persisted base
    // (chain ids were content-addressed under the old tag and are
    // useless to the new identity), and reopens.
    const wsId = await startSession(['finding-A'])
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack under old key')
    const oldTag = triageSync.sessionInfo(wsId).workspaceTag
    assert.ok(oldTag, 'workspaceTag derived under old key')
    const oldPersisted = (JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}').sessions ?? JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}'))[wsId]
    assert.ok(oldPersisted?.baseRevision, 'persisted base existed under old key')

    // Rotate the workspace's privateKey via upsertWorkspace.
    await upsertWorkspace({
      id: wsId,
      name: wsId,
      privateKey: randomBase64(),
      reports: ['test.md'],
    })

    // Wait for the listener to drop the old session AND for the
    // re-opened session to derive its new workspaceTag.
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.workspaceTag != null
        && triageSync.sessionInfo(wsId).workspaceTag !== oldTag,
      'session re-opened with fresh workspaceTag derived from new key',
    )
    await waitFor(statusOnline, 'session reaches online under new identity')
    // The new session must NOT inherit the OLD identity's
    // baseRevision via a load-race against the persisted blob.
    // Audit H2: without the `await dropPersistedSession(...)`
    // before the re-open, `loadPersistedSession` would race the
    // lock-scheduled mutator and restore the old `baseRevision`
    // into the new session. The new session's auto-emitted save
    // (state.markers carries `finding-A`='red' from before the
    // rotation) would then send `base = oldBaseRevision`, which
    // the server doesn't recognize under the new tag → rejected
    // with an empty catch-up chain → pending stuck → baseRevision
    // never advances past the race-restored value.
    //
    // With the fix: new session starts at null base, emits a save
    // under the new identity, server acks, baseRevision advances
    // to a fresh content-hash that's necessarily different from
    // the old chain's value (different workspaceTag → different
    // canonical bytes → different SHA-256).
    await waitFor(() => settledAfterAck(wsId), 'first save under new identity acked')
    assert.notEqual(
      triageSync.sessionInfo(wsId).baseRevision,
      oldPersisted.baseRevision,
      'baseRevision advanced under new identity (no race-restore from old)',
    )

    // Persisted base for the OLD identity was dropped; the new
    // session, syncing under the new tag, may re-persist its own
    // (different) baseRevision, but never the old one.
    const newPersisted = (JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}').sessions ?? JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}'))[wsId]
    assert.notEqual(newPersisted?.baseRevision, oldPersisted.baseRevision, 'persisted base reset (or replaced) for new identity')

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('cross-tab workspace deletion (storage event) tears down the local session', async () => {
    // Audit M-1: when a sibling tab deletes a workspace, the
    // localStorage write fires a `storage` event in this tab, and
    // workspaces.js's listener re-fires the local
    // `onWorkspaceDeleted` handlers — same end state as if the
    // local tab itself had called deleteWorkspace.
    const { propagateWorkspaceChangesFromStorage } = await import('../client/workspaces.js')
    const wsId = await startSession(['finding-A'])
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')
    assert.notEqual(triageSync.sessionInfo(wsId), null, 'session live before sibling delete')

    // Simulate a sibling tab deleting the workspace: rewrite the
    // localStorage blob directly (NOT via this tab's deleteWorkspace
    // — that path already fires the local listener), then drive the
    // diff handler that the storage-event listener would call.
    const _persistedRaw = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const persisted = Array.isArray(_persistedRaw) ? _persistedRaw : _persistedRaw.workspaces
    const remaining = persisted.filter((w) => w.id !== wsId)
    localStorage.setItem('deepview.workspaces', JSON.stringify(remaining))

    await hydrateSecureStorage()
    propagateWorkspaceChangesFromStorage()

    // Triage-sync's onWorkspaceDeleted listener tears down the session.
    assert.equal(triageSync.sessionInfo(wsId), null, 'sibling delete tore down session')
    await waitFor(
      () => (JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}').sessions ?? JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}'))[wsId] === undefined,
      'sibling delete dropped persisted base',
    )
  })

  it('cross-tab workspace privateKey rotation (storage event) re-opens the session', async () => {
    // Audit M-1: same flow, for the rotation case. Sibling tab
    // upserts the workspace with a fresh privateKey; storage event
    // diff fires onWorkspacePrivateKeyChanged → triage-sync drops
    // the old session and re-opens under the new identity.
    const { propagateWorkspaceChangesFromStorage } = await import('../client/workspaces.js')
    const wsId = await startSession(['finding-A'])
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack under old key')
    const oldTag = triageSync.sessionInfo(wsId).workspaceTag

    // Sibling tab rotates: rewrite the localStorage blob with a new
    // privateKey for the same id, then drive the diff handler.
    const _persistedRaw = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const persisted = Array.isArray(_persistedRaw) ? _persistedRaw : _persistedRaw.workspaces
    const idx = persisted.findIndex((w) => w.id === wsId)
    persisted[idx] = { ...persisted[idx], privateKey: randomBase64() }
    localStorage.setItem('deepview.workspaces', JSON.stringify(persisted))

    await hydrateSecureStorage()
    propagateWorkspaceChangesFromStorage()

    await waitFor(
      () => triageSync.sessionInfo(wsId)?.workspaceTag != null
        && triageSync.sessionInfo(wsId).workspaceTag !== oldTag,
      'session re-opened with fresh workspaceTag after sibling rotation',
    )
    await waitFor(statusOnline, 'online under new identity')

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('cross-tab report membership change (storage event) refreshes session.ids', async () => {
    // Audit M-1: same flow, for setReportWorkspace. Sibling tab
    // attaches a new report to a workspace; storage event diff
    // fires onReportMembershipChanged → session.ids picks up the
    // new id and hydration runs.
    const { propagateWorkspaceChangesFromStorage } = await import('../client/workspaces.js')
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({
      fileName: 'A.md',
      groups: [[ { id: 'in-A', _id: 'in-A' } ]],
    })
    state.reports.push({
      fileName: 'B.md',
      groups: [[ { id: 'in-B', _id: 'in-B' } ]],
    })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: randomBase64(), reports: ['A.md'] })
    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'online')
    assert.equal(triageSync.sessionInfo(wsId).tracked, 1, 'A.md only')

    // Sibling tab attaches B.md: rewrite the blob, drive the diff.
    const _persistedRaw = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const persisted = Array.isArray(_persistedRaw) ? _persistedRaw : _persistedRaw.workspaces
    const idx = persisted.findIndex((w) => w.id === wsId)
    persisted[idx] = { ...persisted[idx], reports: ['A.md', 'B.md'] }
    localStorage.setItem('deepview.workspaces', JSON.stringify(persisted))

    await hydrateSecureStorage()
    propagateWorkspaceChangesFromStorage()

    // Membership listener refreshes session.ids — `tracked` now
    // counts both findings.
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.tracked === 2,
      'session.ids picked up sibling-attached report',
    )

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('hydration conflict resolver: M-2 user edit during dialog wins over imported decision', async () => {
    // Audit M-2: the resolver is async; if the user mutates state.*
    // for one of the conflicting properties WHILE the dialog is
    // open, an `imported` decision must NOT silently overwrite
    // their fresh edit. applyHydrationDecisions re-checks current
    // state.* against `c.local` and skips the imported assignment
    // when they no longer match.
    const { setHydrationConflictResolver } = await import('../client/sync/triage-sync.ts')
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({
      fileName: 'R0.md',
      groups: [[ { id: 'finding-A', _id: 'finding-A' } ]],
    })
    state.reports.push({
      fileName: 'R1.md',
      groups: [[ { id: 'finding-B', _id: 'finding-B' } ]],
    })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    const seed = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['R0.md'] })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'online')
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.workspaceTag != null,
      'tag derived',
    )
    const tag = triageSync.sessionInfo(wsId).workspaceTag
    await pushRemoteChange(serverUrl, tag, seed, {
      'finding-B': { color: 'blue' },
    })
    await waitFor(
      () => {
        const _wrapper = JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}')
        const all = _wrapper.sessions ?? _wrapper
        return all[wsId]?.baseState?.['finding-B']?.color === 'blue'
      },
      'B in baseState',
    )
    patchEntry(state.triage, 'finding-B', { color: 'green' })

    let dialogResolve = null
    let resolverArgs = null
    setHydrationConflictResolver((conflicts) => {
      resolverArgs = conflicts
      // Block the resolver until the test releases it — simulating
      // the user staring at the dialog.
      return new Promise((resolve) => { dialogResolve = resolve })
    })
    try {
      await setReportWorkspace('R1.md', wsId)
      await waitFor(() => resolverArgs != null, 'resolver invoked')
      // While the dialog is open, user re-edits state.markers.
      // (Imagine the user clicked through to that finding's row
      // and used the toolbar to set yet another color.)
      patchEntry(state.triage, 'finding-B', { color: 'cyan' })

      // Now the user picks "Apply imported" in the dialog.
      const decisions = {}
      for (const c of resolverArgs) decisions[`${c.id}:${c.property}`] = 'imported'
      dialogResolve(decisions)

      // M-2 guard: applyHydrationDecisions sees state.markers ===
      // 'cyan' (not 'green' that was c.local) and skips the
      // overwrite. User's mid-dialog edit survives.
      await waitFor(() => settledAfterAck(wsId), 'follow-up save acked')
      assert.equal(state.triage.get('finding-B')?.color, 'cyan', 'mid-dialog edit preserved')
    } finally {
      setHydrationConflictResolver(null)
    }

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('upsertWorkspace with the same privateKey does NOT tear down the session', async () => {
    // Listener only fires when privateKey actually changed — a
    // re-import that carries the same key (the common case) must
    // be a no-op for the running session, otherwise re-importing
    // the same bundle would needlessly drop the chain and force a
    // resubscribe round-trip.
    const wsId = await startSession(['finding-A'])
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')
    const oldTag = triageSync.sessionInfo(wsId).workspaceTag
    const oldPersisted = (JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}').sessions ?? JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}'))[wsId]

    // Re-import with the SAME privateKey.
    const _persistedRaw = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const persisted = Array.isArray(_persistedRaw) ? _persistedRaw : _persistedRaw.workspaces
    const samePrivateKey = persisted.find((w) => w.id === wsId).privateKey
    await upsertWorkspace({
      id: wsId,
      name: wsId,
      privateKey: samePrivateKey,
      reports: ['test.md'],
    })

    // Give a couple of ticks to make sure no async listener-driven
    // teardown is in flight.
    await new Promise((r) => { setTimeout(r, 50) })
    assert.equal(triageSync.sessionInfo(wsId).workspaceTag, oldTag, 'workspaceTag unchanged')
    const stillPersisted = (JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}').sessions ?? JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}'))[wsId]
    assert.equal(stillPersisted?.baseRevision, oldPersisted.baseRevision, 'persisted base unchanged')

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('upsertWorkspace with a different reports list fires the membership listener', async () => {
    // Audit H1 round-3: a re-import that adds (or removes) reports
    // via upsertWorkspace used to skip the eager hydration / dialog
    // path because only the privateKey-change listener fired.
    // Now: set-equal diff on `reports` fires the membership
    // listener; triage-sync's handler refreshes session.ids and
    // hydrates state.* for the newly-in-scope ids.
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({
      fileName: 'A.md',
      groups: [[ { id: 'in-A', _id: 'in-A' } ]],
    })
    state.reports.push({
      fileName: 'B.md',
      groups: [[ { id: 'in-B', _id: 'in-B' } ]],
    })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    const seed = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['A.md'] })
    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'online')
    assert.equal(triageSync.sessionInfo(wsId).tracked, 1, 'A.md only initially')

    // Re-import via upsertWorkspace — adds B.md without going
    // through setReportWorkspace.
    await upsertWorkspace({
      id: wsId,
      name: wsId,
      privateKey: seed,
      reports: ['A.md', 'B.md'],
    })

    await waitFor(
      () => triageSync.sessionInfo(wsId)?.tracked === 2,
      'membership listener fired; session.ids refreshed',
    )

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('upsertWorkspace with reports reordered (set-equal) does NOT fire membership listener', async () => {
    // Audit M2 round-3: reordered reports list (no add/remove)
    // doesn't change session.ids, so the listener should NOT fire.
    // Test by registering a counter and verifying it stays at zero
    // for a pure reorder. setReportWorkspace's diff also uses
    // set-equal semantics elsewhere; this pins upsertWorkspace.
    const { onReportMembershipChanged } = await import('../client/workspaces.js')
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({
      fileName: 'A.md',
      groups: [[ { id: 'in-A', _id: 'in-A' } ]],
    })
    state.reports.push({
      fileName: 'B.md',
      groups: [[ { id: 'in-B', _id: 'in-B' } ]],
    })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    const seed = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['A.md', 'B.md'] })

    let firedFor = null
    const off = onReportMembershipChanged((id) => { if (id === wsId) firedFor = id })
    try {
      // Re-import with the SAME set, different order.
      await upsertWorkspace({
        id: wsId,
        name: wsId,
        privateKey: seed,
        reports: ['B.md', 'A.md'],
      })
      // Give microtasks a turn — listener fires synchronously, so
      // a delay isn't strictly needed, but be defensive.
      await new Promise((r) => { setTimeout(r, 25) })
      assert.equal(firedFor, null, 'no membership listener fire on pure reorder')
    } finally {
      off()
    }

    await deleteWorkspace(wsId)
  })

  it('cross-tab workspace creation fires onWorkspaceCreated', async () => {
    // Audit M3 round-3: sibling-tab create symmetric with delete.
    // Direct localStorage rewrite simulating a sibling tab; drive
    // the diff handler; assert the create listener fires.
    const { propagateWorkspaceChangesFromStorage, onWorkspaceCreated } = await import('../client/workspaces.js')
    triageSync.closeSession()
    clearTriageState()
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`

    let firedFor = null
    const off = onWorkspaceCreated((id) => { firedFor = id })
    try {
      // Round-10 freeze: workspaces blob is now `{ version, workspaces }`.
      // Read forward-compat (legacy bare array still tolerated by readRaw).
      const _wrapper = JSON.parse(localStorage.getItem('deepview.workspaces') ?? '{}')
      const persisted = Array.isArray(_wrapper) ? _wrapper : (_wrapper.workspaces ?? [])
      persisted.push({
        id: wsId,
        name: wsId,
        privateKey: randomBase64(),
        reports: [],
        createdAt: Date.now(),
      })
      localStorage.setItem('deepview.workspaces', JSON.stringify({ version: 1, workspaces: persisted }))

      await hydrateSecureStorage()
      propagateWorkspaceChangesFromStorage()

      assert.equal(firedFor, wsId, 'create listener fired with new workspace id')
    } finally {
      off()
    }

    await deleteWorkspace(wsId)
  })

  it('chain whose first revision is bad triggers resync and discards the rest of the chain', async () => {
    // Audit M1 round-4: a bad-id (or bad-sig / decrypt-fail) rev
    // returns false from applyChainToBase, ending chain processing
    // immediately. Subsequent revs in the SAME chain are discarded.
    // Recovery flows through the continuity-break path: first
    // re-subscribe, second-break full reset. The relay's good rev
    // (built off the bogus id) is never applied — the chain is
    // rejected before reaching it. This is the price of refusing
    // to trust server-claimed unverified ids.
    const wsId = `ws-${Math.random().toString(36).slice(2, 10)}`
    const seed = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['t.md'] })
    setReports([{ id: 'finding-A', _id: 'finding-A' }], 't.md')
    clearTriageState()
    const key = await cryptoMod.deriveSessionKey(seed)
    const { privateKey: signingKey, publicKeyB64: workspaceTag } = await cryptoMod.deriveSigningKeypair(seed, wsId)

    const relay = await startFakeRelay((sock) => {
      sock.on('message', async (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type !== 'workspace-subscribe') return
        sock.send(JSON.stringify({ type: 'workspace-subscribed', workspaceTag: msg.workspaceTag }))
        const aad = cryptoMod.buildAad(workspaceTag, null)
        const { nonce, ciphertext } = await cryptoMod.encryptJson(key, { 'finding-A': { color: 'red' } }, aad)
        const payload = { publicKeyB64: workspaceTag, base: null, nonceB64: nonce, ciphertextB64: ciphertext }
        const sig = await cryptoMod.signSavePayload(signingKey, payload)
        const bogusRev = { base: null, id: 'A'.repeat(43), nonce, ciphertext, signature: sig }
        // A "good" rev built off the bogus id. With M1 the client
        // never gets here — the bogus rev's content-hash mismatch
        // ends chain processing first.
        const goodAad = cryptoMod.buildAad(workspaceTag, bogusRev.id)
        const { nonce: gn, ciphertext: gc } = await cryptoMod.encryptJson(key, { 'finding-A': { color: 'green' } }, goodAad)
        const goodPayload = { publicKeyB64: workspaceTag, base: bogusRev.id, nonceB64: gn, ciphertextB64: gc }
        const goodSig = await cryptoMod.signSavePayload(signingKey, goodPayload)
        const goodId = await cryptoMod.computeRevisionId(goodPayload)
        const goodRev = { base: bogusRev.id, id: goodId, nonce: gn, ciphertext: gc, signature: goodSig }
        sock.send(JSON.stringify({
          type: 'workspace-state',
          workspaceTag: msg.workspaceTag,
          revisions: [bogusRev, goodRev],
        }))
      })
    })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(relay.url)
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.baseRevision === null
        && state.triage.get('finding-A')?.color === undefined,
      'continuity-break full reset; good rev discarded with the bogus chain',
    )

    triageSync.closeSession()
    triageSync.setServerUrl('')
    await deleteWorkspace(wsId)
    await relay.close()
  })

  it('bad-rev → full reset emits a healing keyframe even with no local overlay', async () => {
    // Audit M1 round-5: the M5 keyframe-on-skip bump puts
    // `savesSinceKeyframe = keyframeInterval` so the next save is
    // a keyframe. But trySendSave used to short-circuit on an
    // empty changeset — meaning if the user had no local overlay
    // (state.* matches baseState after the full reset's `{}`),
    // no keyframe was ever emitted, leaving any peer who applied
    // the bad rev divergent indefinitely. The fix: don't
    // short-circuit when isKeyframe is true. Even an empty-content
    // keyframe carries signal — receivers wholesale-replace
    // baseState with {} so divergent content gets cleared.
    const wsId = `ws-${Math.random().toString(36).slice(2, 10)}`
    const seed = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['t.md'] })
    setReports([{ id: 'finding-A', _id: 'finding-A' }], 't.md')
    clearTriageState()
    const key = await cryptoMod.deriveSessionKey(seed)
    const { privateKey: signingKey, publicKeyB64: workspaceTag } = await cryptoMod.deriveSigningKeypair(seed, wsId)

    let savesReceived = 0
    let lastSaveKeyframe = null
    const relay = await startFakeRelay((sock) => {
      sock.on('message', async (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'workspace-subscribe') {
          sock.send(JSON.stringify({ type: 'workspace-subscribed', workspaceTag: msg.workspaceTag }))
          // Always send the bogus chain — first one trips the
          // continuity-break recovery; second one trips the full
          // reset. After full reset, the client's next save is
          // what we're observing here.
          const aad = cryptoMod.buildAad(workspaceTag, null)
          const { nonce, ciphertext } = await cryptoMod.encryptJson(key, { 'finding-A': { color: 'red' } }, aad)
          const payload = { publicKeyB64: workspaceTag, base: null, nonceB64: nonce, ciphertextB64: ciphertext }
          const sig = await cryptoMod.signSavePayload(signingKey, payload)
          sock.send(JSON.stringify({
            type: 'workspace-state',
            workspaceTag: msg.workspaceTag,
            revisions: [{ base: null, id: 'A'.repeat(43), nonce, ciphertext, signature: sig }],
          }))
        } else if (msg.type === 'workspace-save') {
          savesReceived += 1
          lastSaveKeyframe = msg.keyframe
          sock.send(JSON.stringify({
            type: 'workspace-save-ack',
            workspaceTag: msg.workspaceTag,
            base: msg.base,
            id: 'X'.repeat(43),
          }))
        }
      })
    })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(relay.url)
    // The client has no local triage; baseState is empty after the
    // full reset; localState is empty. With M1 round-5 the empty
    // keyframe still goes out for cluster healing.
    await waitFor(() => savesReceived >= 1, 'healing keyframe emitted after full reset', 3_000)
    assert.equal(lastSaveKeyframe, true, 'save was a keyframe (heals divergent peers)')

    triageSync.closeSession()
    triageSync.setServerUrl('')
    await deleteWorkspace(wsId)
    await relay.close()
  })

  it('outbound chain entries never carry the legacy `deleted: true` shape', async () => {
    // Audit L3 round-3: snapshotEntry emits `triage` (new) only,
    // never `deleted: true`. Pin via a save round-trip + reader.
    const wsId = await startSession(['finding-A'])
    patchEntry(state.triage, 'finding-A', { triage: 'deleted' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'save acked')

    const tag = triageSync.sessionInfo(wsId).workspaceTag
    const _persistedRaw = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const persisted = Array.isArray(_persistedRaw) ? _persistedRaw : _persistedRaw.workspaces
    const seed = persisted.find((w) => w.id === wsId).privateKey
    const reader = await new Promise((resolve, reject) => {
      const s = new WebSocket(serverUrl)
      s.addEventListener('open', () => resolve(s), { once: true })
      s.addEventListener('error', (e) => reject(e.error ?? new Error('open failed')), { once: true })
    })
    const buffered = []
    reader.addEventListener('message', (e) => buffered.push(JSON.parse(e.data)))
    const { privateKey: signKey } = await cryptoMod.deriveSigningKeypair(seed, wsId)
    await waitFor(() => buffered.some((m) => m.type === 'challenge'), 'reader challenge')
    const challenge = buffered.find((m) => m.type === 'challenge')
    const subSig = await cryptoMod.signSubscribePayload(signKey, tag, null, challenge.nonce)
    reader.send(JSON.stringify({ type: 'workspace-subscribe', workspaceTag: tag, from: null, signature: subSig }))
    await waitFor(() => buffered.some((m) => m.type === 'workspace-state'), 'reader chain')
    const revisions = buffered.filter((m) => m.type === 'workspace-state').flatMap((s) => s.revisions)
    const key = await cryptoMod.deriveSessionKey(seed)
    for (const rev of revisions) {
      const aad = cryptoMod.buildAad(tag, rev.base)
      const changeset = await cryptoMod.decryptJson(key, rev.nonce, rev.ciphertext, aad)
      for (const [, entry] of Object.entries(changeset)) {
        if (entry === null) continue
        assert.equal(entry.deleted, undefined, 'no chain entry carries legacy `deleted: true`')
        assert.notEqual(entry.triage, undefined, 'triage carried as new shape')
      }
    }
    reader.close()

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('three workspaces sharing a finding-id all converge after a chain on one', async () => {
    // Audit gap round-3: existing two-session test pins propagation
    // to one peer; a three-way scenario verifies the cross-session
    // kick loop bounds at convergence (each session's empty-changeset
    // short-circuit is what stops the cycle).
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({ fileName: 'A.md', groups: [[ { id: 'shared', _id: 'shared' } ]] })
    state.reports.push({ fileName: 'B.md', groups: [[ { id: 'shared', _id: 'shared' } ]] })
    state.reports.push({ fileName: 'C.md', groups: [[ { id: 'shared', _id: 'shared' } ]] })
    const ids = ['A', 'B', 'C'].map((suffix) => `ws-${suffix}-${Math.random().toString(36).slice(2, 6)}`)
    const seeds = [randomBase64(), randomBase64(), randomBase64()]
    await upsertWorkspace({ id: ids[0], name: ids[0], privateKey: seeds[0], reports: ['A.md'] })
    await upsertWorkspace({ id: ids[1], name: ids[1], privateKey: seeds[1], reports: ['B.md'] })
    await upsertWorkspace({ id: ids[2], name: ids[2], privateKey: seeds[2], reports: ['C.md'] })

    for (const id of ids) triageSync.openSession(id)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'all three online')
    for (const id of ids) {
      await waitFor(
        () => triageSync.sessionInfo(id)?.workspaceTag != null,
        `${id} tag derived`,
      )
    }

    // Push a remote change under workspace A's tag.
    await pushRemoteChange(serverUrl, triageSync.sessionInfo(ids[0]).workspaceTag, seeds[0], {
      shared: { color: 'red' },
    })

    // Wait for state.* to land + all three sessions to settle.
    await waitFor(() => state.triage.get('shared')?.color === 'red', 'shared visible')
    for (const id of ids) {
      await waitFor(() => settledAfterAck(id), `${id} settled`)
    }
    // Each session ended up with a non-null baseRevision under its
    // own tag — confirms the propagation actually pushed.
    for (const id of ids) {
      assert.notEqual(triageSync.sessionInfo(id).baseRevision, null, `${id} baseRevision advanced`)
    }

    for (const id of ids) triageSync.closeSession(id)
    for (const id of ids) await deleteWorkspace(id)
  })

  it('setServerUrl mid-save reaches a healthy state on the new server', async () => {
    // Audit gap: changing serverUrl while an encryption is in flight
    // is a race — the in-flight save's IIFE captures `sentBase`
    // before the setServerUrl reset, then completes encryption and
    // tries to send. setServerUrl resets `pending` AND reopens the
    // socket; the new socket's open handler resets `pending` again
    // and re-subscribes. The in-flight send may briefly produce a
    // stale-base save against the new server (which the server
    // rejects with an empty chain), but the session must
    // self-recover so the next user edit lands cleanly on the new
    // server's chain. Pin the high-level outcome.
    const server2 = await bootServer()
    try {
      const wsId = await startSession(['finding-X'])
      patchEntry(state.triage, 'finding-X', { color: 'red' })
      await saveTriage()
      await waitFor(() => settledAfterAck(wsId), 'baseline ack on server1')

      // Trigger a fresh save and IMMEDIATELY swap servers — don't
      // await saveTriage so the encrypt is racing with setServerUrl.
      patchEntry(state.triage, 'finding-X', { color: 'green' })
      const saveP = saveTriage()
      triageSync.setServerUrl(server2.serverUrl)

      // Both promises must complete without throwing; the in-flight
      // save's send may land on server2 with a stale base (rejected),
      // OR be dropped because socket was null at send-time. Either
      // way, no exception escapes.
      await saveP
      await waitFor(() => triageSync.status === 'online', 'reconnected to server2')

      // Self-recovery: a subsequent edit must land on server2 cleanly.
      patchEntry(state.triage, 'finding-X', { color: 'blue' })
      await saveTriage()
      await waitFor(() => settledAfterAck(wsId), 'follow-up save acked on server2')
      assert.equal(state.triage.get('finding-X')?.color, 'blue')

      triageSync.closeSession(wsId)
      await deleteWorkspace(wsId)
    } finally {
      triageSync.setServerUrl(serverUrl)
      await server2.teardown()
    }
  })

  it('reloadTriageFromStorage during an active session does not trigger an outbound save', async () => {
    // Audit gap: the cross-tab `storage` listener calls
    // reloadTriageFromStorage, which mutates state.* but must NOT
    // call triageSync.notify() — otherwise an outbound save would
    // race with the originating tab's save under the same
    // workspaceTag, producing a redundant chain entry. The design
    // contract: storage-event reload is view-only; the sync chain
    // is the canonical cross-tab propagation channel.
    const { reloadTriageFromStorage } = await import('../client/triage.js')
    const wsId = await startSession(['shared-finding'])
    patchEntry(state.triage, 'shared-finding', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')
    const baselineRev = triageSync.sessionInfo(wsId).baseRevision
    assert.ok(baselineRev, 'baseline revision exists')

    // Simulate a sibling tab persisting different state. Build the
    // blob the way saveTriage would (gzipped, base64) by routing
    // through saveTriage on a swapped state, then restore state.
    patchEntry(state.triage, 'shared-finding', { color: 'green' })
    await saveTriage()
    // saveTriage above bumped baseRevision via its own round-trip;
    // capture the new baseline.
    await waitFor(() => settledAfterAck(wsId), 'sibling-mimic ack')
    const sentinelRev = triageSync.sessionInfo(wsId).baseRevision

    // Now mutate state.* in-memory to simulate "this tab's view"
    // having drifted, then call reloadTriageFromStorage as if a
    // storage event fired. Reload should overwrite state.* with the
    // persisted (green) value WITHOUT firing an outbound save.
    patchEntry(state.triage, 'shared-finding', { color: 'cyan' })
    await reloadTriageFromStorage()
    assert.equal(state.triage.get('shared-finding')?.color, 'green', 'reload picked up persisted value')

    // Give a couple of ticks for any speculative save to land.
    await new Promise((resolve) => { setTimeout(resolve, 100) })

    // baseRevision unchanged — no save fired off the back of the
    // reload, which is what protects against multi-tab kick storms.
    assert.equal(
      triageSync.sessionInfo(wsId).baseRevision,
      sentinelRev,
      'reload did not trigger an outbound save',
    )

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('two sessions sharing a finding-id receive concurrent chains without a kick storm', async () => {
    // Audit gap: existing "propagates a chain update across
    // workspaces sharing a finding-id" covers one peer pushing.
    // Pin the more interesting case where BOTH sessions receive a
    // chain for the same shared id near-simultaneously: the cross-
    // session propagation could in principle ping-pong (A applies,
    // kicks B; B's snapshot differs from B's base, B saves; B's
    // ack kicks A; ...). The convergence guarantee is that once
    // state.* matches a session's baseState, computeChangeset emits
    // an empty changeset and trySendSave bails — so the loop
    // terminates with both chains carrying the same final value.
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({
      fileName: 'A.md',
      groups: [[ { id: 'shared', _id: 'shared' } ]],
    })
    state.reports.push({
      fileName: 'B.md',
      groups: [[ { id: 'shared', _id: 'shared' } ]],
    })
    const wsA = `ws-A-${Math.random().toString(36).slice(2, 8)}`
    const wsB = `ws-B-${Math.random().toString(36).slice(2, 8)}`
    const seedA = randomBase64()
    const seedB = randomBase64()
    await upsertWorkspace({ id: wsA, name: wsA, privateKey: seedA, reports: ['A.md'] })
    await upsertWorkspace({ id: wsB, name: wsB, privateKey: seedB, reports: ['B.md'] })

    triageSync.openSession(wsA)
    triageSync.openSession(wsB)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'both online')
    await waitFor(
      () => triageSync.sessionInfo(wsA)?.workspaceTag != null
        && triageSync.sessionInfo(wsB)?.workspaceTag != null,
      'both workspaceTags derived',
    )
    const tagA = triageSync.sessionInfo(wsA).workspaceTag
    const tagB = triageSync.sessionInfo(wsB).workspaceTag

    // Fire two pushes back-to-back without awaiting between them so
    // they queue up at the server in roughly the same micro-window.
    // pushRemoteChange opens a fresh ws each time; whichever lands
    // first at the relay determines what the other client sees as
    // a remote chain.
    await Promise.all([
      pushRemoteChange(serverUrl, tagA, seedA, { shared: { color: 'red' } }),
      pushRemoteChange(serverUrl, tagB, seedB, { shared: { color: 'blue' } }),
    ])

    // Both sessions must reach a settled, non-null baseRevision.
    // settledAfterAck checks: pending null AND !encrypting AND
    // baseRevision non-null. Convergence means the kick-storm
    // terminated without leaving anything in flight.
    await waitFor(() => settledAfterAck(wsA), 'A settled')
    await waitFor(() => settledAfterAck(wsB), 'B settled')

    // state.markers['shared'] has SOME value (red or blue depending
    // on which broadcast landed last); both chains carry the same
    // final value (last-write-wins under cross-session propagation).
    const finalColor = state.triage.get('shared')?.color
    assert.ok(finalColor === 'red' || finalColor === 'blue', 'shared converged to one of the two values')
    // Both sessions advanced — propagation actually ran on both
    // sides, didn't dead-lock waiting for each other.
    assert.notEqual(triageSync.sessionInfo(wsA).baseRevision, null)
    assert.notEqual(triageSync.sessionInfo(wsB).baseRevision, null)

    triageSync.closeSession(wsA)
    triageSync.closeSession(wsB)
    await deleteWorkspace(wsA)
    await deleteWorkspace(wsB)
  })

  it('setEnabled(false) keeps the socket closed across the reconnect window', async () => {
    // Audit gap: after a user toggles sync off, no zombie reconnect
    // should kick the socket back open. closeSocket clears the
    // reconnect timer, and the close-handler's `if (isActive())`
    // gate prevents the natural-disconnect path from re-scheduling
    // — pin both with a single test that disables sync, waits past
    // the initial 1s reconnect delay, and verifies the socket stays
    // down.
    const wsId = await startSession(['finding-X'])
    assert.equal(triageSync.status, 'online')
    assert.equal(triageSync.connected, true)

    triageSync.setEnabled(false)
    assert.equal(triageSync.status, 'off')
    assert.equal(triageSync.connected, false, 'socket closed by setEnabled(false)')

    // Wait past the initial reconnect delay (1s default) — if any
    // reconnect timer was leaked, it'd fire here and re-open.
    await new Promise((resolve) => { setTimeout(resolve, 1500) })

    assert.equal(triageSync.connected, false, 'no zombie reconnect after disable')
    assert.equal(triageSync.status, 'off', 'status stays off')

    // Re-enable for cleanup so the next test starts with a clean
    // serverUrl + enabled state.
    triageSync.setEnabled(true)
    await waitFor(statusOnline, 'reconnected after re-enable')
    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('setEnabled(false) clears `encrypting` so re-enable doesn\'t needlessly raise pendingSave', async () => {
    // Audit M2 round-4: a save that's mid-encryption when the user
    // disables sync leaves `session.encrypting=true` stranded; the
    // next `trySendSave` (after re-enable) sees it and redundantly
    // raises `pendingSave`. The reset paths now clear the flag at
    // client/triage-sync.ts:2215.
    //
    // sessionInfo (client/triage-sync.ts:2433) exposes `encrypting`,
    // so we can pin the property directly: after a settled save +
    // setEnabled toggle, `encrypting` is observably false (the
    // toggle's reset path ran). Catching the IIFE mid-encrypt
    // deterministically would need an encryptJson stub; the
    // steady-state assertion below is the strongest black-box pin
    // available without one.
    const wsId = await startSession(['finding-A'])
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')
    // Steady-state pre-condition: encrypting cleared by the
    // settled save's own success path (line 1403).
    assert.equal(triageSync.sessionInfo(wsId).encrypting, false, 'baseline encrypting=false post-ack')
    // Toggle disable / enable. The reset path inside setEnabled(false)
    // walks every session and clears `encrypting` (line 2215). Even
    // if the steady-state pre-condition already had it false, this
    // pins that the reset path doesn't TURN IT BACK ON.
    triageSync.setEnabled(false)
    assert.equal(triageSync.sessionInfo(wsId).encrypting, false, 'setEnabled(false) leaves encrypting=false')
    triageSync.setEnabled(true)
    await waitFor(statusOnline, 'reconnected after toggle')
    assert.equal(triageSync.sessionInfo(wsId).encrypting, false, 'setEnabled(true) leaves encrypting=false')
    // A fresh save after re-enable still completes cleanly.
    patchEntry(state.triage, 'finding-A', { color: 'green' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'follow-up ack after toggle')
    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('setForcedOff(true) takes the session offline; setForcedOff(false) reconnects', async () => {
    // Audit gap round-4: setForcedOff is the sidebar-driven gate
    // (vs the user-driven setEnabled). Same close-without-touching-
    // URL semantics; pin the lifecycle.
    const wsId = await startSession(['finding-A'])
    assert.equal(triageSync.status, 'online')

    triageSync.setForcedOff(true)
    assert.equal(triageSync.connected, false, 'forcedOff closed socket')
    assert.equal(triageSync.status, 'off')

    triageSync.setForcedOff(false)
    await waitFor(statusOnline, 'reconnected after setForcedOff(false)')

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('ignoredReports round-trips through the sync chain (delivery + apply-side mutex)', async () => {
    // Audit coverage gap round-4: existing ignoredReports tests
    // exercise the storage path (multitab.test.js) and the
    // import/export path (workspace-roundtrip.test.js); the SYNC
    // chain path was unverified. This test pins both halves in one
    // workspace setup:
    //   1. a peer push of `{ color, ignoredReports }` lands in
    //      state.ignoredIds (delivery + applyToReactiveState);
    //   2. a follow-up push of `{ triage, ignoredReports }` for
    //      the same id applies triage but SKIPS ignoredReports
    //      (apply-side mutex — same as the load/import paths).
    const wsId = await startSession(['shared-finding'])
    patchEntry(state.triage, 'shared-finding', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')

    const tag = triageSync.sessionInfo(wsId).workspaceTag
    const _persistedRaw = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const persisted = Array.isArray(_persistedRaw) ? _persistedRaw : _persistedRaw.workspaces
    const seed = persisted.find((w) => w.id === wsId).privateKey

    // Half 1: ignoredReports delivery via chain.
    await pushRemoteChange(serverUrl, tag, seed, {
      'shared-finding': { color: 'red', ignoredReports: ['somereport.md'] },
    })
    await waitFor(
      () => isReportIgnored(state.triage, 'shared-finding', 'somereport.md'),
      'ignoredReports from chain landed in state.ignoredIds',
    )

    // Half 2: chain entry with BOTH triage + ignoredReports → apply
    // triage, skip ignoredReports. (Mutex check on a stale chain
    // entry that violates the action-handler invariant.)
    await pushRemoteChange(serverUrl, tag, seed, {
      'shared-finding': { triage: 'fixed', ignoredReports: ['x.md'] },
    })
    await waitFor(
      () => state.triage.get('shared-finding')?.triage === 'fixed',
      'triage from chain applied',
    )
    assert.equal(
      isReportIgnored(state.triage, 'shared-finding', 'x.md'),
      false,
      'ignoredReports skipped due to apply-side mutex',
    )
    // The earlier ignoredReports ('somereport.md') should also be
    // dropped because the second chain entry's wire view sets
    // triage and the apply path clears local ignoredIds for the id.
    assert.equal(
      isReportIgnored(state.triage, 'shared-finding', 'somereport.md'),
      false,
      'pre-existing ignoredReports cleared (mutex preserves triage)',
    )

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('dismissError racing initial key derivation does not stale-clobber the new keys', async () => {
    // Audit L2 round-4: openSession + dismissError can both invoke
    // kickKeyDerivation. The newer derivation must win even if the
    // older completes later. Generation token in kickKeyDerivation
    // gates the commit. Test: spawn an initial derivation (slow
    // privateKey via openSession), then immediately rotate the
    // privateKey + dismissError; verify the resulting workspaceTag
    // is the NEW key's, not the old.
    const { setHydrationConflictResolver } = await import('../client/sync/triage-sync.ts')
    setHydrationConflictResolver(null)
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({ fileName: 'A.md', groups: [[ { id: 'in-A', _id: 'in-A' } ]] })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    const seed1 = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed1, reports: ['A.md'] })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    // Wait for the initial key derivation to commit. Note:
    // statusOnline alone isn't sufficient — `currentStatus` reports
    // 'online' as soon as the socket's open AND no session is
    // subscribed-but-not-acked, which is true BEFORE this session's
    // kickKeyDerivation finishes (the session hasn't subscribed yet
    // because it has no signingKey). Wait for the tag explicitly.
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.workspaceTag != null,
      'initial key derivation commits workspaceTag',
    )
    const tagOld = triageSync.sessionInfo(wsId).workspaceTag
    assert.ok(tagOld, 'tag derived')

    // Rotate privateKey via upsertWorkspace; the privateKey-change
    // listener tears down + reopens the session, kicking a fresh
    // derivation under the new key.
    const seed2 = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed2, reports: ['A.md'] })
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.workspaceTag != null
        && triageSync.sessionInfo(wsId).workspaceTag !== tagOld,
      'new tag derived from rotated key',
    )
    const tagNew = triageSync.sessionInfo(wsId).workspaceTag

    // Verify the new tag actually corresponds to seed2 (not a
    // stale-overwrite of the older derivation winning the race).
    const expectedNewTag = (await cryptoMod.deriveSigningKeypair(seed2, wsId)).publicKeyB64
    assert.equal(tagNew, expectedNewTag, 'workspaceTag matches the NEW key')

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('savesSinceKeyframe is capped at keyframeInterval (audit L3 round-6)', async () => {
    // Audit L3 round-6: peer broadcasts that arrive while the local
    // user is idle bump `savesSinceKeyframe` once each. Without the
    // cap, a long burst leaves the counter far past keyframeInterval
    // — only cosmetic (the next emit is a keyframe regardless and
    // resets to 0), but the bloat shows up in the persisted-sessions
    // blob and the `sessionInfo` debug view. Verify the cap by
    // pushing more peer chains than the interval and inspecting.
    setKeyframeInterval(3)
    const wsId = await startSession(['shared-finding'])
    patchEntry(state.triage, 'shared-finding', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')

    const tag = triageSync.sessionInfo(wsId).workspaceTag
    const _persistedRaw = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const persisted = Array.isArray(_persistedRaw) ? _persistedRaw : _persistedRaw.workspaces
    const seed = persisted.find((w) => w.id === wsId).privateKey

    // Push 6 peer chains — twice the interval. Without the cap,
    // savesSinceKeyframe would climb to 6 (or higher, since our own
    // baseline save was already counted toward it).
    for (let i = 0; i < 6; i++) {
      await pushRemoteChange(serverUrl, tag, seed, {
        'shared-finding': { color: i % 2 ? 'green' : 'red' },
      })
    }
    // Wait for the chain handler to settle on the last revision.
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.savesSinceKeyframe >= 3,
      'savesSinceKeyframe reached cap',
    )
    const counter = triageSync.sessionInfo(wsId).savesSinceKeyframe
    assert.equal(counter, 3, `savesSinceKeyframe capped at keyframeInterval (got ${counter})`)

    setKeyframeInterval(100)
    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('privateKey rotation disarms old session keys synchronously (audit L2 round-6)', async () => {
    // Audit L2 round-6: a `notify()` landing during the
    // dropPersistedSession await of the rotation listener used to
    // skip the workspace (sessions.delete was synchronous). With the
    // fix, the OLD session entry stays in `sessions` but its keys
    // are nulled synchronously — `notify()` finds it, `trySendSave`
    // bails on the no-keys check, no save under the orphan
    // workspaceTag goes out. After the drop completes, the entry is
    // atomically replaced with a new session via openSession.
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({ fileName: 'A.md', groups: [[ { id: 'in-A', _id: 'in-A' } ]] })
    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    const seed1 = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed1, reports: ['A.md'] })

    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.workspaceTag != null,
      'initial key derivation commits workspaceTag',
    )
    const tagOld = triageSync.sessionInfo(wsId).workspaceTag

    // Trigger rotation. The listener fires synchronously inside
    // upsertWorkspace; the keys-null mutation is synchronous, the
    // dropPersistedSession + openSession run in an awaited IIFE.
    const seed2 = randomBase64()
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: seed2, reports: ['A.md'] })
    // RIGHT after upsertWorkspace returns, the OLD session entry
    // should still be present but with nulled keys / tag.
    const mid = triageSync.sessionInfo(wsId)
    assert.notEqual(mid, null, 'session entry stayed in the map during rotation')
    assert.equal(mid.workspaceTag, null, 'old workspaceTag was cleared synchronously')
    assert.equal(mid.keyReady, false, 'old session.key was cleared synchronously')

    // After the await IIFE settles, the new derivation lands.
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.workspaceTag != null
        && triageSync.sessionInfo(wsId).workspaceTag !== tagOld,
      'new tag derived',
    )
    const tagNew = triageSync.sessionInfo(wsId).workspaceTag
    const expectedNewTag = (await cryptoMod.deriveSigningKeypair(seed2, wsId)).publicKeyB64
    assert.equal(tagNew, expectedNewTag, 'workspaceTag matches the NEW key')

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('persistSession reflects the post-rebase baseRevision (audit M2 round-6)', async () => {
    // Audit M2 round-6: applyOverlayAndPersist used to await
    // saveTriage (which awaits compressDeflate) BEFORE kicking
    // persistSession's lock-RMW. A tab teardown landing inside the
    // compress await would leave state.* updated (via saveTriage's
    // pending-key M3 mechanism) but the persisted base stale —
    // cosmetic chain growth on next reload. The fix reorders:
    // persistSession kicks first (under the Web Lock), saveTriage
    // awaits second.
    //
    // Black-box pin: after a peer chain lands and the rebase has
    // settled, the persisted-sessions blob's baseRevision must
    // match the live session's. The reorder doesn't change the
    // observable steady-state value; it does ensure the lock-RMW
    // is initiated earlier in the apply sequence.
    const wsId = await startSession(['finding-A'])
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')
    const baselineRev = triageSync.sessionInfo(wsId).baseRevision

    const tag = triageSync.sessionInfo(wsId).workspaceTag
    const _persistedRaw = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const persisted = Array.isArray(_persistedRaw) ? _persistedRaw : _persistedRaw.workspaces
    const seed = persisted.find((w) => w.id === wsId).privateKey
    // Peer pushes a non-conflicting change; client's chain handler
    // routes through applyOverlayAndPersist (overlay is empty, but
    // the persist path still fires for the rebased baseRevision).
    await pushRemoteChange(serverUrl, tag, seed, { 'finding-A': { color: 'amber' } })

    await waitFor(
      () => triageSync.sessionInfo(wsId)?.baseRevision !== baselineRev
        && triageSync.sessionInfo(wsId)?.pending == null,
      'chain rebase settled',
    )
    const rebasedRev = triageSync.sessionInfo(wsId).baseRevision

    // Lock-RMW is async (Web Locks). Allow microtasks to drain so
    // the persistSession write lands.
    await waitFor(
      () => {
        const blobRaw = localStorage.getItem('deepview.sync.sessions')
        if (!blobRaw) return false
        const wrapper = JSON.parse(blobRaw)
        const blob = wrapper.sessions ?? wrapper
        return blob[wsId]?.baseRevision === rebasedRev
      },
      'persisted-sessions baseRevision tracks live session',
    )

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('setServerUrl prunes persisted sessions whose serverUrl no longer matches', async () => {
    // Revision IDs are per-server, so a persisted entry under a
    // different `serverUrl` is already inert at restore time
    // (loadPersistedSession rejects on URL mismatch). This pin
    // covers the cleanup half: setServerUrl drops those entries
    // from localStorage so legacy bytes (e.g. pre-`/api/sync` path)
    // don't accumulate forever.
    triageSync.closeSession()
    const wsLive = `ws-${Math.random().toString(36).slice(2, 8)}`
    const wsStale = `ws-${Math.random().toString(36).slice(2, 8)}`
    await upsertWorkspace({ id: wsLive, name: wsLive, privateKey: randomBase64(), reports: [] })
    await upsertWorkspace({ id: wsStale, name: wsStale, privateKey: randomBase64(), reports: [] })
    localStorage.setItem('deepview.sync.sessions', JSON.stringify({
      version: 1,
      sessions: {
        [wsLive]: { serverUrl, baseRevision: 'a'.repeat(43), savesSinceKeyframe: 0, baseState: {} },
        [wsStale]: { serverUrl: 'ws://stale.example/api/sync', baseRevision: 'b'.repeat(43), savesSinceKeyframe: 0, baseState: {} },
      },
    }))
    await hydrateSecureStorage()
    // Force a URL transition so setServerUrl doesn't early-return
    // on the same-URL no-op (suite ordering may have left it at
    // `serverUrl` already).
    triageSync.setServerUrl('')
    triageSync.setServerUrl(serverUrl)
    await waitFor(() => {
      const blob = JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}')
      return blob.sessions?.[wsStale] === undefined
    }, 'stale-URL entry pruned')
    const blob = JSON.parse(localStorage.getItem('deepview.sync.sessions'))
    assert.notEqual(blob.sessions[wsLive], undefined, 'matching-URL entry survives')
    assert.equal(blob.sessions[wsStale], undefined, 'stale-URL entry pruned')
    await deleteWorkspace(wsLive)
    await deleteWorkspace(wsStale)
  })

  it('mutateAllSessions skips writes when localStorage holds an unrecognized future version', async () => {
    // Open-ended audit `client/triage-sync.ts:884`. Pre-fix:
    // loadAllSessions returned `{}` for any `{ version: N }` with
    // N !== SESSIONS_VERSION, so a subsequent mutateAllSessions
    // call would WRITE a v1 blob over whatever the future build had
    // persisted, silently destroying its entries. Post-fix:
    // mutateAllSessions detects `unknown-version` and skips the
    // write entirely so the future shape survives. Triggers the
    // `persistenceDegraded` latch so UI can surface a hint.
    triageSync.closeSession()
    // Reset latch from any prior test by clearing the blob and
    // driving mutateAllSessions through a successful write.
    localStorage.removeItem('deepview.sync.sessions')
    await mutateAllSessions((all) => { all['_reset'] = { serverUrl: 'wss://reset', baseRevision: null, baseState: {} } })
    assert.equal(triageSync.persistenceDegraded, false, 'pre-condition: latch clean')
    const transitions = []
    const unsub = triageSync.onPersistenceDegraded((degraded) => { transitions.push(degraded) })
    // Late-subscriber microtask fires once with current state (false).
    await Promise.resolve()
    assert.deepEqual(transitions, [false], 'subscribe fires once with current state (false)')
    const futurePayload = JSON.stringify({ version: 99, sessions: { 'ws-future': { serverUrl: 'wss://later.example', baseRevision: 'rev-from-v99' } }, futureField: { whatever: 1 } })
    localStorage.setItem('deepview.sync.sessions', futurePayload)
    // sync sessions now read through the secure-storage cache; the
    // direct LS write needs an explicit hydrate. The hydrate fires
    // triage-sync's onAfterHydrate hook which re-probes the load
    // result and flips the latch ON when it observes the
    // unknown-version blob. (Pre-secure-storage, the latch only
    // flipped during the first mutateAllSessions skip-write; now
    // boot-time detection catches it earlier.)
    await hydrateSecureStorage()
    // Drive `mutateAllSessions` directly to confirm the skip-write
    // path still no-ops on disk (the latch is already on, so this
    // doesn't fire another transition).
    await mutateAllSessions((all) => { all['probe'] = { serverUrl: 'wss://probe', baseRevision: null, baseState: {} } })
    unsub()
    // The future blob is still on disk byte-identical.
    assert.equal(localStorage.getItem('deepview.sync.sessions'), futurePayload, 'unrecognized future blob preserved')
    // Latch flipped + listener received the off→on transition.
    assert.equal(triageSync.persistenceDegraded, true, 'persistenceDegraded latch on')
    assert.deepEqual(transitions, [false, true], 'listener received initial state + transition')
  })

  it('mutateAllSessions recovers from a matching-version blob with corrupt sessions field', async () => {
    // Audit follow-up to round-15. Pre-fix: `{ version: 1, sessions: <missing|array> }`
    // (e.g. a v1 client that crashed mid-write, or hand-edited
    // corruption) classified as `'unknown-version'` and the entry
    // was permanently quarantined. Post-fix: matching version with
    // a malformed sessions field reads as `'empty'` so the next
    // save rewrites cleanly.
    triageSync.closeSession()
    const corruptPayload = JSON.stringify({ version: 1, sessions: [] })
    localStorage.setItem('deepview.sync.sessions', corruptPayload)
    // sync sessions read through the secure-storage cache; the
    // direct LS write needs an explicit hydrate.
    await hydrateSecureStorage()
    // Drive mutateAllSessions directly with a mutator that adds an
    // entry — exercises the recovery write.
    await mutateAllSessions((all) => { all['probe'] = { serverUrl: 'wss://probe', baseRevision: null, baseState: {} } })
    // The corrupt blob has been replaced by a fresh v1 wrapper
    // containing the mutator's entry.
    const rewritten = JSON.parse(localStorage.getItem('deepview.sync.sessions'))
    assert.equal(rewritten.version, 1, 'corrupt blob rewritten with v1 wrapper')
    assert.ok(rewritten.sessions && typeof rewritten.sessions === 'object' && !Array.isArray(rewritten.sessions), 'sessions field is a plain object')
    assert.ok(rewritten.sessions.probe, 'mutator entry persisted post-recovery')
  })

  it('onPersistenceDegraded late subscribers fire once with current state (both directions)', async () => {
    // A lazily-mounted UI component (badge/toast) that subscribes
    // AFTER the unknown-version skip-write fired should see the
    // current state on the first callback. The late callback is
    // queued on a microtask so subscribe-and-immediately-unsubscribe
    // is safe.
    triageSync.closeSession()
    const futurePayload = JSON.stringify({ version: 99, sessions: {} })
    localStorage.setItem('deepview.sync.sessions', futurePayload)
    await hydrateSecureStorage()
    // Flip the latch by driving mutateAllSessions BEFORE
    // subscribing.
    await mutateAllSessions((all) => { all['probe-late'] = { serverUrl: 'wss://probe', baseRevision: null, baseState: {} } })
    assert.equal(triageSync.persistenceDegraded, true, 'latch flipped pre-subscribe')
    // Subscribe AFTER the flip. The callback fires with the
    // current `degraded === true` state.
    const lateValues = []
    const unsubLate = triageSync.onPersistenceDegraded((degraded) => { lateValues.push(degraded) })
    await Promise.resolve()
    assert.deepEqual(lateValues, [true], 'late subscriber received initial state = true')
    // Latch already-true → setPersistenceDegraded(true) is a no-op,
    // no transition fires the listener.
    await mutateAllSessions((all) => { all['probe-late-2'] = { serverUrl: 'wss://probe', baseRevision: null, baseState: {} } })
    await Promise.resolve()
    assert.deepEqual(lateValues, [true], 'no-op transition does not fire the listener')
    unsubLate()
    // Unsubscribing IMMEDIATELY after subscribe (before the queued
    // microtask runs) suppresses the late dispatch — defends against
    // a component that mounts + unmounts in the same tick.
    let bouncedFired = 0
    const unsubBounced = triageSync.onPersistenceDegraded(() => { bouncedFired++ })
    unsubBounced()
    await Promise.resolve()
    assert.equal(bouncedFired, 0, 'subscribe+unsubscribe in same tick suppresses dispatch')
  })

  it('persistenceDegraded latch clears on a subsequent successful mutateAllSessions', async () => {
    // Audit follow-up: the latch was previously sticky-per-page-load,
    // so a user clearing the future-version blob via DevTools couldn't
    // recover without a reload. Now: a successful write of a
    // recognized v1 shape flips the latch off and fires listeners
    // on the off transition.
    triageSync.closeSession()
    const futurePayload = JSON.stringify({ version: 99, sessions: {} })
    localStorage.setItem('deepview.sync.sessions', futurePayload)
    await hydrateSecureStorage()
    // Skip write → latch on.
    await mutateAllSessions((all) => { all['probe'] = { serverUrl: 'wss://probe', baseRevision: null, baseState: {} } })
    assert.equal(triageSync.persistenceDegraded, true, 'latch on after skipped write')
    const transitions = []
    const unsub = triageSync.onPersistenceDegraded((degraded) => { transitions.push(degraded) })
    // Late-subscriber microtask fires once with the current state.
    await Promise.resolve()
    assert.deepEqual(transitions, [true], 'late subscriber sees current degraded state')
    // Simulate the user clearing the future-version blob (DevTools
    // / sibling tab).
    localStorage.removeItem('deepview.sync.sessions')
    await hydrateSecureStorage()
    // Next mutateAllSessions writes a recognized v1 shape → latch clears.
    await mutateAllSessions((all) => { all['probe2'] = { serverUrl: 'wss://probe', baseRevision: null, baseState: {} } })
    assert.equal(triageSync.persistenceDegraded, false, 'latch cleared after successful write')
    assert.deepEqual(transitions, [true, false], 'listener fired on the off transition')
    unsub()
  })

  it('latch stays ON when writeAllSessionsRaw fails (quota path) — clear is gated on successful write', async () => {
    // Audit follow-up to PR #80 review: a degraded user whose disk
    // is full would see the UI hint disappear (clearing the latch)
    // even though localStorage.setItem actually threw inside
    // writeAllSessionsRaw and the warn was the only signal. Fixed
    // by gating setPersistenceDegraded(false) on the write returning
    // true. Simulate a quota throw via a patched setItem.
    triageSync.closeSession()
    // Pre-condition: latch on after a skip-write.
    const futurePayload = JSON.stringify({ version: 99, sessions: {} })
    localStorage.setItem('deepview.sync.sessions', futurePayload)
    await hydrateSecureStorage()
    await mutateAllSessions((all) => { all['probe-q'] = { serverUrl: 'wss://probe', baseRevision: null, baseState: {} } })
    assert.equal(triageSync.persistenceDegraded, true, 'pre-condition: latch on')
    // Clear the future blob and patch setItem to throw on the
    // sessions key (simulating quota exceeded).
    localStorage.removeItem('deepview.sync.sessions')
    await hydrateSecureStorage()
    const origSetItem = localStorage.setItem
    localStorage.setItem = function (k, v) {
      if (k === 'deepview.sync.sessions') {
        const err = new Error('quota exceeded (simulated)')
        err.name = 'QuotaExceededError'
        throw err
      }
      return origSetItem.call(this, k, v)
    }
    try {
      await mutateAllSessions((all) => { all['probe-q2'] = { serverUrl: 'wss://probe', baseRevision: null, baseState: {} } })
      // The write threw inside writeAllSessionsRaw (swallowed +
      // warned). Latch must NOT clear — the user's state isn't
      // persisted; the UI hint should stay on.
      assert.equal(triageSync.persistenceDegraded, true, 'latch stays on when write fails')
    } finally {
      localStorage.setItem = origSetItem
    }
    // Recovery: a subsequent successful write clears the latch.
    await mutateAllSessions((all) => { all['probe-q3'] = { serverUrl: 'wss://probe', baseRevision: null, baseState: {} } })
    assert.equal(triageSync.persistenceDegraded, false, 'latch clears on subsequent successful write')
  })

  it('a write failure RAISES the latch from a clean state (disk full now surfaces, not just stays)', async () => {
    // The quota/vault-locked path is itself degraded persistence — the
    // user's state isn't being saved and won't survive a reload. It now
    // RAISES the latch (badge + dialog), where before a failed write
    // from a clean state was silent (console.warn only).
    triageSync.closeSession()
    // Clean start: recognised (empty) blob; a successful write proves
    // the latch is off to begin with.
    localStorage.setItem('deepview.sync.sessions', JSON.stringify({ version: 1, sessions: {} }))
    await hydrateSecureStorage()
    await mutateAllSessions((all) => { all['probe-clean'] = { serverUrl: 'wss://probe', baseRevision: null, baseState: {} } })
    assert.equal(triageSync.persistenceDegraded, false, 'pre-condition: latch off on a clean recognised blob')
    // Patch setItem to throw on the sessions key (disk full) and mutate.
    const origSetItem = localStorage.setItem
    localStorage.setItem = function (k, v) {
      if (k === 'deepview.sync.sessions') {
        const err = new Error('quota exceeded (simulated)')
        err.name = 'QuotaExceededError'
        throw err
      }
      return origSetItem.call(this, k, v)
    }
    try {
      await mutateAllSessions((all) => { all['probe-full'] = { serverUrl: 'wss://probe', baseRevision: null, baseState: {} } })
      assert.equal(triageSync.persistenceDegraded, true, 'failed write raises the latch from clean')
    } finally {
      localStorage.setItem = origSetItem
    }
    // Recovery: once writes succeed again, the latch clears.
    await mutateAllSessions((all) => { all['probe-full2'] = { serverUrl: 'wss://probe', baseRevision: null, baseState: {} } })
    assert.equal(triageSync.persistenceDegraded, false, 'latch clears once writes succeed again')
  })

  it('persistenceDegraded latch syncs across tabs via the `storage` event', async () => {
    // Audit follow-up: with no cross-tab listener, tab-A's latch
    // wouldn't reflect tab-B clearing the blob. Now the global
    // `storage` event handler re-probes the load result and aligns.
    triageSync.closeSession()
    const futurePayload = JSON.stringify({ version: 99, sessions: {} })
    localStorage.setItem('deepview.sync.sessions', futurePayload)
    await hydrateSecureStorage()
    await mutateAllSessions((all) => { all['probe-xtab'] = { serverUrl: 'wss://probe', baseRevision: null, baseState: {} } })
    assert.equal(triageSync.persistenceDegraded, true)
    // Simulate another tab clearing the blob via DevTools. In real
    // browsers the sibling tab's setItem fires a `storage` event in
    // our tab, which secure-storage's listener turns into a
    // hydrate; the after-hydrate hook then re-probes the
    // load-result. node:test has no cross-tab storage plumbing, so
    // we drive `hydrateSecureStorage()` directly — same effect
    // as the real-browser flow once secure-storage's hydrate
    // resolves.
    const recovered = JSON.stringify({ version: 1, sessions: {} })
    localStorage.setItem('deepview.sync.sessions', recovered)
    await hydrateSecureStorage()
    assert.equal(triageSync.persistenceDegraded, false, 'cross-tab clear realigns the latch')
  })

  // ─────────── membership-drop propagation (PR #118 + refreshSession) ───────────

  it('addReportToWorkspace into a workspace with NO live session auto-opens it and propagates triage', async () => {
    // Models the drag-into-workspace UI gesture for a workspace the
    // user hasn't navigated into yet. Pre-fix the membership listener
    // bailed on `!session`, so the workspace's chain never picked up
    // the dropped report's triage. Post-fix `openSession` is invoked
    // synchronously by the listener, and the follow-up `trySendSave`
    // lands the first revision once key derivation completes.
    triageSync.closeSession()
    clearTriageState()
    setReports([{ id: 'finding-A', _id: 'finding-A' }], 'A.md')
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    const wsId = `ws-${Math.random().toString(36).slice(2, 10)}`
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: randomBase64(), reports: [] })
    triageSync.setServerUrl(serverUrl)
    assert.equal(triageSync.sessionInfo(wsId), null, 'no session before drop')

    // Drop A.md into the workspace.
    await addReportToWorkspace('A.md', wsId)

    // Membership listener should auto-open + propagate.
    await waitFor(() => settledAfterAck(wsId), 'session opened + save ack landed after drop')
    const info = triageSync.sessionInfo(wsId)
    assert.ok(info != null && info.baseRevision != null, 'session live + has revision')
    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  // ─────────── refreshSession API (issue 3: focus dragged report later) ───────────

  it('refreshSession propagates triage for a report loaded AFTER the session opened', async () => {
    // Models the bug where a non-focused report is dragged into a
    // workspace, the user later focuses it, and triage-sync's stale
    // `session.ids` still excludes the new report's finding-ids until
    // a re-subscribe forces a rebuild. Post-fix the switch path calls
    // `triageSync.refreshSession(workspaceId)` after `state.reports`
    // is repopulated by `ingestReport`, so the next save includes the
    // freshly-loaded report's ids.
    triageSync.closeSession()
    clearTriageState()
    // Workspace claims TWO reports, but only A is currently loaded
    // (mirrors single-file view of A in a multi-report workspace).
    setReports([{ id: 'finding-A', _id: 'finding-A' }], 'A.md')
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    const wsId = `ws-${Math.random().toString(36).slice(2, 10)}`
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: randomBase64(), reports: ['A.md', 'B.md'] })
    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'sync online')
    await waitFor(() => settledAfterAck(wsId), 'first ack with A only')
    const baseRevisionAfterA = triageSync.sessionInfo(wsId).baseRevision
    assert.ok(baseRevisionAfterA, 'first save landed')

    // User edits a finding in B while B is unloaded. With session.ids
    // stuck on A's ids, this triage IS captured in state.markers but
    // not propagated by any subsequent save.
    patchEntry(state.triage, 'finding-B', { color: 'green' })

    // Simulate `switchToFile('B.md')`: ingest repopulates
    // state.reports with B (+ A, if multi-file — here we model the
    // single-file view path where state.reports is the just-loaded
    // file). Then the new `refreshSession` call kicks the rebuild.
    state.reports.length = 0
    state.reports.push({ fileName: 'B.md', groups: [[{ id: 'finding-B', _id: 'finding-B' }]] })
    triageSync.refreshSession(wsId)

    // A new save should land carrying finding-B → green. baseRevision
    // advances; pre-fix it would have stayed at baseRevisionAfterA.
    await waitFor(
      () => triageSync.sessionInfo(wsId).baseRevision !== baseRevisionAfterA,
      'revision advanced after refreshSession picked up the loaded report',
    )
    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('refreshSession on a workspace with no live session is a safe no-op', () => {
    // Defensive contract: callers (the UI switch paths) invoke
    // refreshSession without first checking whether a session is
    // open. The method must silently no-op rather than throw.
    triageSync.refreshSession('nonexistent-workspace-' + Math.random().toString(36).slice(2))
  })

  // ─────────── session-preservation across switchToWorkspace (issue 1) ───────────

  it('opening an already-open session is idempotent (no re-subscribe on workspace title click)', async () => {
    // Models the UI's `switchToWorkspace` post-fix shape:
    // intersection-close (don't tear down the target session) plus
    // openSession (no-op if already open) plus refreshSession.
    // Pre-fix `switchToWorkspace` did a blanket `closeSession()`
    // followed by `openSession(target)`, which destroyed + recreated
    // the session struct AND issued a fresh `workspace-subscribe` on
    // every click of the workspace title.
    const wsId = await startSession(['finding-A'])
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'first ack')
    const infoBefore = triageSync.sessionInfo(wsId)
    const baseRevisionBefore = infoBefore.baseRevision
    const workspaceTagBefore = infoBefore.workspaceTag

    // Idempotent re-open: nothing should change about the session.
    // Pre-fix this would have been a no-op only because the prior
    // closeSession() was called separately; here we exercise just
    // the openSession path to verify its idempotence contract.
    triageSync.openSession(wsId)
    // refreshSession with no state.reports change is a no-op for
    // propagation purposes — verify it doesn't perturb the session.
    triageSync.refreshSession(wsId)
    // Drain microtasks so any spurious save would have queued.
    await new Promise((resolve) => { setTimeout(resolve, 50) })

    const infoAfter = triageSync.sessionInfo(wsId)
    assert.equal(infoAfter.baseRevision, baseRevisionBefore, 'baseRevision unchanged (no re-subscribe / fresh chain)')
    assert.equal(infoAfter.workspaceTag, workspaceTagBefore, 'workspaceTag unchanged')
    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  // ─────────── multi-workspace and cross-membership scenarios ───────────

  it('same report dropped into TWO workspaces propagates triage to BOTH chains', async () => {
    // Multi-workspace membership: a report can belong to N workspaces.
    // Each workspace's chain MUST receive the report's triage —
    // pre-fix both listeners bailed for the second workspace if the
    // user hadn't navigated into it, leaving one chain stale.
    triageSync.closeSession()
    clearTriageState()
    setReports([{ id: 'finding-A', _id: 'finding-A' }], 'shared.md')
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    const wsA = `ws-${Math.random().toString(36).slice(2, 8)}`
    const wsB = `ws-${Math.random().toString(36).slice(2, 8)}`
    await upsertWorkspace({ id: wsA, name: wsA, privateKey: randomBase64(), reports: [] })
    await upsertWorkspace({ id: wsB, name: wsB, privateKey: randomBase64(), reports: [] })
    triageSync.setServerUrl(serverUrl)

    // Drop the report into BOTH workspaces.
    await addReportToWorkspace('shared.md', wsA)
    await addReportToWorkspace('shared.md', wsB)

    // Each workspace's chain should land its own first revision.
    await waitFor(() => settledAfterAck(wsA), 'wsA chain acked')
    await waitFor(() => settledAfterAck(wsB), 'wsB chain acked')
    const infoA = triageSync.sessionInfo(wsA)
    const infoB = triageSync.sessionInfo(wsB)
    assert.ok(infoA?.baseRevision, 'wsA has revision')
    assert.ok(infoB?.baseRevision, 'wsB has revision')
    // Distinct workspaces ⇒ distinct workspaceTags ⇒ chains can't
    // collide on the relay.
    assert.notEqual(infoA.workspaceTag, infoB.workspaceTag, 'distinct workspace tags')
    triageSync.closeSession()
    await deleteWorkspace(wsA)
    await deleteWorkspace(wsB)
  })

  it('re-dropping an already-attached report does NOT trigger a spurious save', async () => {
    // Idempotence: setReportWorkspace / addReportToWorkspace into a
    // workspace that already claims the file is a no-op on the
    // workspace blob — and therefore must NOT fire the membership
    // listener (the workspaces-store dedups). Asserted here so a
    // regression in the dedup would visibly bump baseRevision.
    const wsId = await startSession(['finding-A'])
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'first save ack')
    const baseRevisionBefore = triageSync.sessionInfo(wsId).baseRevision

    // Re-attach the same report — workspaces.js's set-equal guard
    // should suppress the membership event, so no save fires.
    await addReportToWorkspace('test.md', wsId)
    await new Promise((resolve) => { setTimeout(resolve, 50) })

    assert.equal(
      triageSync.sessionInfo(wsId).baseRevision,
      baseRevisionBefore,
      'no spurious save on re-attach (baseRevision unchanged)',
    )
    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('detaching a report via setReportWorkspace(name, null) does NOT remove existing chain data', async () => {
    // Multi-workspace semantics: a report may belong to N workspaces.
    // Detaching from ONE workspace must not wipe the corresponding
    // finding-ids from that workspace's chain — a peer who still has
    // the report attached (in this workspace, in another tab) keeps
    // seeing the triage. The detach is a local-membership update,
    // not a remote-deletion request. `refreshAndPropagate` runs the
    // rebuild + calls `trySendSave`, which computes a changeset of
    // `baseState` vs `effectiveLocalState(baseState, ids)` and bails
    // on `changesetEmpty` before encrypting — out-of-scope ids stay
    // as baseState had them, so no revision lands on the wire.
    const wsId = await startSession(['finding-A'])
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'attached state acked')
    const baseRevisionAttached = triageSync.sessionInfo(wsId).baseRevision

    // Detach the report from this workspace.
    await setReportWorkspace('test.md', null)
    await new Promise((resolve) => { setTimeout(resolve, 100) })

    // No new revision — the chain's data persists for other peers /
    // future re-attaches.
    assert.equal(
      triageSync.sessionInfo(wsId).baseRevision,
      baseRevisionAttached,
      'detach is a local-membership op; no chain revision fired',
    )
    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('drop while sync is offline + enable later: propagates eventually', async () => {
    // Models the boot-with-sync-disabled-then-enable flow. The
    // membership listener auto-opens a session even with no server
    // URL; the session sits in `pendingSave` until the transport
    // acquires. Once the URL is set the deferred save flushes.
    triageSync.closeSession()
    clearTriageState()
    setReports([{ id: 'finding-A', _id: 'finding-A' }], 'offline.md')
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    triageSync.setServerUrl('')  // sync offline

    const wsId = `ws-${Math.random().toString(36).slice(2, 8)}`
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: randomBase64(), reports: [] })

    // Drop into a workspace while offline — session auto-opens but
    // can't talk to the wire yet. baseRevision stays null.
    await addReportToWorkspace('offline.md', wsId)
    await new Promise((resolve) => { setTimeout(resolve, 50) })
    assert.equal(
      triageSync.sessionInfo(wsId)?.baseRevision,
      null,
      'session deferred while offline (no server URL)',
    )

    // Turn sync on — the queued save should flush.
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'sync online')
    await waitFor(() => settledAfterAck(wsId), 'deferred save flushed after enable')
    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('refreshSession is a no-op when state.reports did not change (no spurious save)', async () => {
    // Pin the idempotence contract: the UI's switch paths now
    // unconditionally call `refreshSession` after `ingestReport`,
    // and a same-file re-render of an unchanged workspace MUST NOT
    // bump the chain. Otherwise click-spam on the workspace title
    // would generate fresh revisions for no reason.
    const wsId = await startSession(['finding-A'])
    patchEntry(state.triage, 'finding-A', { color: 'red' })
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'first save ack')
    const baseRevisionBefore = triageSync.sessionInfo(wsId).baseRevision

    // Call refreshSession repeatedly with no underlying change.
    triageSync.refreshSession(wsId)
    triageSync.refreshSession(wsId)
    triageSync.refreshSession(wsId)
    await new Promise((resolve) => { setTimeout(resolve, 50) })

    assert.equal(
      triageSync.sessionInfo(wsId).baseRevision,
      baseRevisionBefore,
      'no spurious save (baseRevision unchanged)',
    )
    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })
})

// ─────────── second-client helper: push a chain via raw WS ───────────
//
// Encrypts a changeset under the workspace's session key, signs
// the save, and waits for the server's ack. We re-use the client's
// own crypto helpers for symmetry with what triage-sync would have
// produced — just driven from outside the active session so the
// arriving chain looks like another peer's edit.

const cryptoMod = await import('../client/sync/sync-crypto.ts')
// Native WebSocket on the client side — same API surface as the
// browser, which is the production environment the client actually
// runs against. The `ws` package is kept strictly to the server side
// (its WebSocketServer); its EventEmitter-shaped client drifts from
// the browser implementation and the production code won't ever see
// it, so exercising it from the test would test the wrong thing.
const { WebSocketServer } = await import('ws')

// In-process WebSocket server the test fully controls. Used for
// scenarios the real server (server/index.ts) won't ever produce —
// content-id mismatches, bad signatures, bogus continuity in the
// chain — so we can exercise the client's defensive skip / resync
// paths without altering the relay.
async function startFakeRelay(onConnection) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((resolve) => { wss.once('listening', resolve) })
  const url = `ws://127.0.0.1:${wss.address().port}`
  // Round-9 H2: the real server emits a `challenge` frame on
  // connect, before the client can subscribe. Mimic that here so
  // the production client (which now defers `trySendSubscribe`
  // until the nonce arrives) doesn't hang on a fake relay.
  wss.on('connection', (sock, req) => {
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')
    sock.send(JSON.stringify({ type: 'challenge', nonce }))
    onConnection(sock, req)
  })
  return {
    url,
    close: () => new Promise((resolve) => { wss.close(resolve) }),
  }
}

async function pushRemoteChange(url, workspaceTag, seedB64, changeset) {
  // Open a fresh socket; we'll subscribe + save + close. Attach
  // the message listener BEFORE waiting for 'open' so the server's
  // `challenge` frame (sent immediately on connection accept,
  // round-9 H2) doesn't race past us. With the listener-after-open
  // ordering the challenge could land between the open event firing
  // and us calling addEventListener, leaving `buffered` empty and
  // the subsequent waitFor stuck.
  const buffered = []
  const ws = await new Promise((resolve, reject) => {
    const s = new WebSocket(url)
    s.addEventListener('message', (event) => buffered.push(JSON.parse(event.data)))
    s.addEventListener('open', () => resolve(s), { once: true })
    s.addEventListener('error', (event) => reject(event.error ?? new Error('websocket error')), { once: true })
  })
  const key = await cryptoMod.deriveSessionKey(seedB64)
  // deriveSigningKeypair takes the workspaceId as an HKDF info
  // string; we only have the seed + tag here, so look the id up by
  // matching the seed against the persisted workspace record.
  const _persistedRaw = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const persisted = Array.isArray(_persistedRaw) ? _persistedRaw : _persistedRaw.workspaces
  const candidate = persisted.find((w) => w.privateKey === seedB64)
  const { privateKey: signingKey } = await cryptoMod.deriveSigningKeypair(seedB64, candidate.id)

  // Wait for the per-connection challenge nonce (round-9 H2). Every
  // subscribe sig must bind to it; without this we'd send a stale
  // (or empty-nonce) signature the server rejects.
  await waitFor(() => buffered.some((m) => m.type === 'challenge'), 'remote challenge')
  const challenge = buffered.find((m) => m.type === 'challenge')
  const subSig = await cryptoMod.signSubscribePayload(signingKey, workspaceTag, null, challenge.nonce)
  ws.send(JSON.stringify({ type: 'workspace-subscribe', workspaceTag, from: null, signature: subSig }))
  await waitFor(() => buffered.some((m) => m.type === 'workspace-state'), 'remote subscribe chain')

  // Use the latest revision id as `base` so the save lands cleanly.
  const states = buffered.filter((m) => m.type === 'workspace-state')
  const lastChain = states.flatMap((s) => s.revisions)
  const base = lastChain.length > 0 ? lastChain.at(-1).id : null

  const aad = cryptoMod.buildAad(workspaceTag, base)
  const { nonce, ciphertext } = await cryptoMod.encryptJson(key, changeset, aad)
  const payload = { publicKeyB64: workspaceTag, base, nonceB64: nonce, ciphertextB64: ciphertext }
  const signature = await cryptoMod.signSavePayload(signingKey, payload)
  ws.send(JSON.stringify({ type: 'workspace-save', workspaceTag, base, nonce, ciphertext, signature }))
  await waitFor(() => buffered.some((m) => m.type === 'workspace-save-ack'), 'remote save ack')
  ws.close()
}
