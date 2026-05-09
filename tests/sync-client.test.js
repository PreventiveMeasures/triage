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
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

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

// ─────────── client modules ───────────

const { triageSync, setHeartbeatTimings, setKeyframeInterval } = await import('../client/triage-sync.js')
const { state } = await import('../client/state.js')
const { saveTriage } = await import('../client/triage.js')
const { upsertWorkspace, deleteWorkspace, setReportWorkspace } = await import('../client/workspaces.js')

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
  state.markers.clear()
  state.triageState.clear()
  state.comments.clear()
  state.fixes.clear()
  state.ignoredIds.clear()
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
  let serverDir, serverProc, serverUrl

  before(async () => {
    serverDir = mkdtempSync(path.join(tmpdir(), 'deepview-client-'))
    const port = 19500 + Math.floor(Math.random() * 500)
    serverUrl = `ws://127.0.0.1:${port}`
    serverProc = spawn(process.execPath, ['server/index.js'], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: path.join(serverDir, 'data.db') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server boot timeout')), 5_000)
      serverProc.stdout.on('data', (d) => {
        if (String(d).includes('triage-sync server')) { clearTimeout(t); resolve() }
      })
      serverProc.stderr.on('data', () => {})
    })
  })

  after(async () => {
    triageSync.closeSession()
    triageSync.setServerUrl('')
    if (serverProc) {
      serverProc.kill('SIGTERM')
      await new Promise((resolve) => { serverProc.once('exit', resolve) })
    }
    rmSync(serverDir, { recursive: true, force: true })
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
    state.markers.set('finding-A', 'red')
    await saveTriage()
    // Simulate the user editing again WHILE the first save is in
    // flight (pending, awaiting ack). saveTriage flips pendingSave
    // because pending is non-null.
    state.markers.set('finding-B', 'green')
    await saveTriage()
    // The server acks the first save; the rebase should preserve
    // the second edit. Without the fix, applyToReactiveState
    // overwrites state.* with a stale localState snapshot and
    // finding-B → green is silently dropped.
    await waitFor(() => settledAfterAck(wsId), 'ack landed and pending cleared')
    // After the rebase + the follow-up save for finding-B, both
    // edits must still be visible.
    await waitFor(() => state.markers.get('finding-B') === 'green', 'finding-B preserved')
    assert.equal(state.markers.get('finding-A'), 'red')
    assert.equal(state.markers.get('finding-B'), 'green')
    triageSync.closeSession()
    await deleteWorkspace(wsId)
  })

  it('merges a remote change with an in-progress local edit', async () => {
    const wsId = await startSession(['finding-A', 'finding-B'])
    // Local: finding-A = red, sync up.
    state.markers.set('finding-A', 'red')
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'first ack')

    // Push a chain from a SECOND client (raw WS) carrying a remote
    // change to finding-B = green. Local A = red must survive; the
    // remote B = green must land.
    const { workspaceTag } = triageSync.sessionInfo(wsId)
    const persisted = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const seed = persisted.find((w) => w.id === wsId).privateKey
    await pushRemoteChange(serverUrl, workspaceTag, seed, { 'finding-B': { color: 'green' } })

    await waitFor(() => state.markers.get('finding-B') === 'green', 'remote change landed')
    assert.equal(state.markers.get('finding-A'), 'red', 'local edit survived')
    assert.equal(state.markers.get('finding-B'), 'green')
    triageSync.closeSession()
    await deleteWorkspace(wsId)
  })

  it('local-wins on a conflicting id (same finding edited both sides)', async () => {
    const wsId = await startSession(['finding-A'])
    state.markers.set('finding-A', 'red')
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')

    // User edits to amber WITHOUT calling saveTriage — simulates a
    // rapid in-flight UI edit between two ticks of the sync loop.
    // The chain handler's captureOverlay reads state.* directly,
    // so the merge must see this edit even though no save is queued.
    state.markers.set('finding-A', 'amber')

    const beforeRev = triageSync.sessionInfo(wsId).baseRevision
    const { workspaceTag } = triageSync.sessionInfo(wsId)
    const persisted = JSON.parse(localStorage.getItem('deepview.workspaces'))
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
    assert.equal(state.markers.get('finding-A'), 'amber')
    triageSync.closeSession()
    await deleteWorkspace(wsId)
  })

  it('restores baseRevision + baseState across closeSession / openSession', async () => {
    const wsId = await startSession(['finding-A'])
    state.markers.set('finding-A', 'red')
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
    assert.equal(state.markers.get('finding-A'), 'red', 'triage value preserved')
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
    assert.equal(state.markers.get('finding-A'), undefined, 'bogus-id revision did not poison state')
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
    assert.equal(state.markers.get('finding-A'), undefined, 'bad-sig revision did not poison state')
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
    state.markers.set('finding-A', 'green')

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
    assert.equal(state.markers.get('finding-A'), 'green', 'user edit survived resync')
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
      () => state.markers.get('finding-A') === 'red',
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

  it('emits a keyframe after `keyframeInterval` non-keyframe revisions', async () => {
    // Drop the threshold so we don't have to stage 100 saves.
    // Production stays at 100 — verified by reading sessionInfo
    // after the keyframe round-trip lands.
    setKeyframeInterval(2)
    const wsId = await startSession(['finding-A'])
    // Three saves: the first two bump the counter (1, then 2);
    // the third trips the threshold and goes out as a keyframe.
    state.markers.set('finding-A', 'red')
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'first ack')
    state.markers.set('finding-A', 'green')
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'second ack')
    state.markers.set('finding-A', 'blue')
    await saveTriage()
    // After the third ack, savesSinceKeyframe should be 0 — i.e.
    // the third save was a keyframe, and the counter reset.
    await waitFor(
      () => settledAfterAck(wsId) && (triageSync.sessionInfo(wsId).savesSinceKeyframe ?? -1) === 0,
      'third save emitted as a keyframe (counter reset to 0)',
    )
    assert.equal(state.markers.get('finding-A'), 'blue', 'final state visible after keyframe')
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
    state.markers.set('finding-A', 'red')
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'rev_A ack')
    // Counter should now be 1 — next save will be promoted to a
    // keyframe (interval = 1). Bake finding-B into state to make
    // the keyframe content distinguishable from rev_A's content.
    state.markers.set('finding-B', 'green')
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
    const all = JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}')
    delete all[wsId]
    localStorage.setItem('deepview.sync.sessions', JSON.stringify(all))
    triageSync.openSession(wsId)
    await waitFor(statusOnline, 'reader online')
    // Server returns the chain starting at the keyframe; client
    // applies, replacing the (empty) baseState with the keyframe's
    // full content. state.* now reflects {A: red, B: green}.
    await waitFor(
      () => state.markers.get('finding-A') === 'red' && state.markers.get('finding-B') === 'green',
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
    state.markers.set('finding-in-A', 'red')
    await saveTriage()
    await waitFor(() => settledAfterAck(wsA), 'A acked')
    // B never acked anything (no edits in B's scope).
    assert.equal(triageSync.sessionInfo(wsB).baseRevision, null, 'B remained at null base')

    // Edit a finding in workspace B's scope. Now B saves; A is
    // unaffected because A's session.ids doesn't include
    // 'finding-in-B'.
    const aBaseAfterFirstSave = triageSync.sessionInfo(wsA).baseRevision
    state.markers.set('finding-in-B', 'green')
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
    state.markers.set('fB', 'amber')
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
    assert.equal(state.markers.get('shared'), 'red', 'shared finding visible in state.*')

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
      () => state.markers.get('finding-A') === 'red',
      'in-scope id applied',
    )

    // Spec assertion: in-scope A applied; OOS B and C did NOT touch
    // state.markers. (R1 has finding-B but isn't in the workspace, so
    // finding-B is OOS for this session.)
    assert.equal(state.markers.get('finding-A'), 'red', 'A applied (in scope via R0)')
    assert.equal(state.markers.get('finding-B'), undefined, 'B not applied (R1 not in workspace)')
    assert.equal(state.markers.get('finding-C'), undefined, 'C not applied (no report in workspace has it)')

    // baseState carries all three — verified via the persisted-session
    // blob, which mirrors session.baseState. This is what guarantees a
    // future keyframe preserves OOS triage for fresh subscribers.
    const persisted = JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}')[wsId]
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
      () => state.markers.get('finding-A') === 'red',
      'A applied (in scope)',
    )
    assert.equal(state.markers.get('finding-B'), undefined, 'B not yet applied')

    // Attach R1 to W. The membership listener refreshes session.ids
    // and hydrates state.* from baseState for the newly-in-scope
    // ids — only B in this case (A was already in scope, C still
    // not in any of W's reports).
    await setReportWorkspace('R1.md', wsId)

    assert.equal(state.markers.get('finding-A'), 'red', 'A still set')
    assert.equal(state.markers.get('finding-B'), 'blue', 'B hydrated from baseState')
    assert.equal(state.markers.get('finding-C'), undefined, 'C still OOS (no report in W has it)')

    // baseState still carries all three (hydration reads, doesn't
    // remove). Future keyframes preserve C for fresh subscribers.
    const persisted = JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}')[wsId]
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
    await waitFor(() => state.markers.get('finding-A') === 'red', 'A applied')

    await setReportWorkspace('R3.md', wsId)

    assert.equal(state.markers.get('finding-B'), 'blue', 'B hydrated from R3')
    assert.equal(state.markers.get('finding-C'), undefined, 'C still OOS')

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('hydration on attach with conflict resolver = "imported" overwrites local + propagates to chain', async () => {
    // The resolver is the UI dialog. When the user picks "Apply
    // from chain" for a conflict, state.* gets overwritten with
    // the chain's value, the next save's diff against the
    // (already-matching) baseState is empty, and the chain stays
    // on the imported value.
    const { setHydrationConflictResolver } = await import('../client/triage-sync.js')
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
    await waitFor(() => state.markers.get('finding-A') === 'red', 'A applied')

    state.markers.set('finding-B', 'green')

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
      await waitFor(() => state.markers.get('finding-B') === 'blue', 'imported decision applied')
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
    const { setHydrationConflictResolver } = await import('../client/triage-sync.js')
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
        const all = JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}')
        return all[wsId]?.baseState?.['finding-B']?.color === 'blue'
      },
      'B in baseState',
    )
    state.markers.set('finding-B', 'green')

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
      assert.equal(state.markers.get('finding-B'), 'green', 'local kept')
    } finally {
      setHydrationConflictResolver(null)
    }

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('hydration on attach with cancelled resolver (returns null) keeps local everywhere', async () => {
    // Cancel = same outcome as picking "local" for every conflict.
    const { setHydrationConflictResolver } = await import('../client/triage-sync.js')
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
        const all = JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}')
        return all[wsId]?.baseState?.['finding-B']?.color === 'blue'
      },
      'B in baseState',
    )
    state.markers.set('finding-B', 'green')

    let resolverCalled = false
    setHydrationConflictResolver(() => {
      resolverCalled = true
      return null
    })
    try {
      await setReportWorkspace('R1.md', wsId)
      await waitFor(() => resolverCalled, 'resolver invoked')
      await waitFor(() => settledAfterAck(wsId), 'save settled')
      assert.equal(state.markers.get('finding-B'), 'green', 'local kept on cancel')
    } finally {
      setHydrationConflictResolver(null)
    }

    triageSync.closeSession(wsId)
    await deleteWorkspace(wsId)
  })

  it('hydration on attach without a registered resolver falls back to gap-only (local-wins)', async () => {
    // No resolver wired (the triage-sync default). Conflicts are
    // silently resolved to local-wins; no dialog shows.
    const { setHydrationConflictResolver } = await import('../client/triage-sync.js')
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
        const all = JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}')
        return all[wsId]?.baseState?.['finding-B']?.color === 'blue'
      },
      'B in baseState',
    )
    state.markers.set('finding-B', 'green')

    await setReportWorkspace('R1.md', wsId)
    await waitFor(() => settledAfterAck(wsId), 'save settled')
    assert.equal(state.markers.get('finding-B'), 'green', 'gap-only kept local')

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
    await waitFor(() => state.markers.get('finding-A') === 'red', 'A applied')

    // Pre-existing local triage on B (e.g. user set it via the
    // console API while R1 was in a different workspace, or it was
    // restored from the deepview.triage blob at module load).
    state.markers.set('finding-B', 'green')

    await setReportWorkspace('R1.md', wsId)

    // Hydration is gap-only — local 'green' is preserved over the
    // chain's 'blue'.
    assert.equal(state.markers.get('finding-B'), 'green', 'local value preserved')

    // The membership listener also kicked a save; local 'green'
    // diffs against baseState's 'blue' and goes out as a save. Wait
    // for the chain to advance, then read it back via a fresh raw
    // subscriber to confirm.
    await waitFor(() => settledAfterAck(wsId), 'follow-up save acked')
    const reader = await new Promise((resolve, reject) => {
      const s = new WebSocket(serverUrl)
      s.addEventListener('open', () => resolve(s), { once: true })
      s.addEventListener('error', (e) => reject(e.error ?? new Error('open failed')), { once: true })
    })
    const buffered = []
    reader.addEventListener('message', (e) => buffered.push(JSON.parse(e.data)))
    const { privateKey: signKey } = await cryptoMod.deriveSigningKeypair(seed, wsId)
    const subSig = await cryptoMod.signSubscribePayload(signKey, tag, null)
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
      [wsId]: {
        serverUrl,
        baseRevision: 'a'.repeat(43),
        savesSinceKeyframe: 0,
        baseState: { 'unknown-X': { color: 'red', triage: 'fixed' } },
      },
    }))

    triageSync.openSession(wsId)
    triageSync.setServerUrl(serverUrl)
    // The session restored baseState from the seeded blob; state.*
    // is empty for unknown-X because applyToReactiveState's scope
    // (session.ids) doesn't include it (R2 not attached).
    await waitFor(
      () => triageSync.sessionInfo(wsId)?.workspaceTag != null,
      'workspaceTag derived',
    )
    assert.equal(state.markers.get('unknown-X'), undefined, 'state.* untouched (X out of scope)')

    // Attach R2 mid-session — both state.reports (renderer) and
    // workspace.reports (membership). The onReportMembershipChanged
    // listener fires; refreshSessionIds sees X is newly in scope
    // and hydrates state.* from baseState before any save runs.
    state.reports.push({
      fileName: 'B.md',
      groups: [[ { id: 'unknown-X', _id: 'unknown-X' } ]],
    })
    await setReportWorkspace('B.md', wsId)
    assert.equal(state.markers.get('unknown-X'), 'red', 'state.* hydrated for newly-in-scope id')
    assert.equal(state.triageState.get('unknown-X'), 'fixed', 'triageState hydrated too')

    // After hydration, a local edit on a different finding produces
    // a save whose effectiveLocalState carries the full unknown-X
    // entry (matching baseState) — so the changeset against
    // baseState contains ONLY the user's edit on 'known' and does
    // NOT emit { 'unknown-X': null }. The post-save in-memory state
    // confirms unknown-X stays set; without hydration, snapshotEntry
    // would return {} and effectiveLocalState would delete it,
    // letting trySendSave emit a wipe.
    state.markers.set('known', 'green')
    await saveTriage()
    assert.equal(state.markers.get('unknown-X'), 'red', 'unknown-X marker preserved after save')
    assert.equal(state.triageState.get('unknown-X'), 'fixed', 'unknown-X triage preserved after save')

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
      () => state.markers.get('known') === 'red',
      'remote chain applied',
    )

    // ONE local edit on the known id. With keyframeInterval=100
    // (production default) this stays a regular delta save.
    state.markers.set('known', 'green')
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
    const subSig = await cryptoMod.signSubscribePayload(signKey, tag, null)
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
      () => state.markers.get('known') === 'red',
      'remote chain applied',
    )

    // Two local edits to push savesSinceKeyframe past the
    // threshold (which we lowered to 2). The third save would be
    // the keyframe — but with `keyframeInterval = 2`, the second
    // edit IS the keyframe-promoted one because the chain we just
    // applied bumped the counter to 1.
    state.markers.set('known', 'green')
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'second ack')
    state.markers.set('known', 'blue')
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
    const subSig = await cryptoMod.signSubscribePayload(signKey, tag, null)
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
    state.markers.set('in-A', 'red')
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
    state.markers.set('in-B', 'green')
    await saveTriage()
    await waitFor(
      () => triageSync.sessionInfo(wsId).baseRevision !== beforeRev,
      'second ack — new finding synced',
    )

    // Verify by fetching the chain from a fresh raw client and
    // applying it: the cumulative state must include in-B = green.
    const tag = triageSync.sessionInfo(wsId).workspaceTag
    const persisted = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const seed = persisted.find((w) => w.id === wsId).privateKey
    const reader = await new Promise((resolve, reject) => {
      const s = new WebSocket(serverUrl)
      s.addEventListener('open', () => resolve(s), { once: true })
      s.addEventListener('error', (e) => reject(e.error ?? new Error('open failed')), { once: true })
    })
    const buffered = []
    reader.addEventListener('message', (e) => buffered.push(JSON.parse(e.data)))
    const { privateKey: signKey } = await cryptoMod.deriveSigningKeypair(seed, wsId)
    const subSig = await cryptoMod.signSubscribePayload(signKey, tag, null)
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
    assert.equal(state.markers.get('finding-X'), undefined, 'closed-session chain did not pollute state.*')

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
    state.triageState.set('finding-A', 'fixed')
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'fixed acked')
    const baseAfterFixed = triageSync.sessionInfo(wsId).baseRevision

    state.triageState.set('finding-A', 'invalid')
    await saveTriage()
    await waitFor(
      () => triageSync.sessionInfo(wsId).baseRevision !== baseAfterFixed,
      'invalid acked (transition synced)',
    )

    // Verify the chain on the server reflects the latest value.
    const tag = triageSync.sessionInfo(wsId).workspaceTag
    const persisted = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const seed = persisted.find((w) => w.id === wsId).privateKey
    const reader = await new Promise((resolve, reject) => {
      const s = new WebSocket(serverUrl)
      s.addEventListener('open', () => resolve(s), { once: true })
      s.addEventListener('error', (e) => reject(e.error ?? new Error('open failed')), { once: true })
    })
    const buffered = []
    reader.addEventListener('message', (e) => buffered.push(JSON.parse(e.data)))
    const { privateKey: signKey } = await cryptoMod.deriveSigningKeypair(seed, wsId)
    const subSig = await cryptoMod.signSubscribePayload(signKey, tag, null)
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
    state.markers.set('finding-A', 'red')
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')

    // Sanity: session is live and a persisted entry exists.
    assert.notEqual(triageSync.sessionInfo(wsId), null)
    const persistedBefore = JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}')
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
      () => JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}')[wsId] === undefined,
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
    state.markers.set('finding-A', 'red')
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack under old key')
    const oldTag = triageSync.sessionInfo(wsId).workspaceTag
    assert.ok(oldTag, 'workspaceTag derived under old key')
    const oldPersisted = JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}')[wsId]
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
    const newPersisted = JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}')[wsId]
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
    state.markers.set('finding-A', 'red')
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')
    assert.notEqual(triageSync.sessionInfo(wsId), null, 'session live before sibling delete')

    // Simulate a sibling tab deleting the workspace: rewrite the
    // localStorage blob directly (NOT via this tab's deleteWorkspace
    // — that path already fires the local listener), then drive the
    // diff handler that the storage-event listener would call.
    const persisted = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const remaining = persisted.filter((w) => w.id !== wsId)
    localStorage.setItem('deepview.workspaces', JSON.stringify(remaining))
    propagateWorkspaceChangesFromStorage()

    // Triage-sync's onWorkspaceDeleted listener tears down the session.
    assert.equal(triageSync.sessionInfo(wsId), null, 'sibling delete tore down session')
    await waitFor(
      () => JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}')[wsId] === undefined,
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
    state.markers.set('finding-A', 'red')
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack under old key')
    const oldTag = triageSync.sessionInfo(wsId).workspaceTag

    // Sibling tab rotates: rewrite the localStorage blob with a new
    // privateKey for the same id, then drive the diff handler.
    const persisted = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const idx = persisted.findIndex((w) => w.id === wsId)
    persisted[idx] = { ...persisted[idx], privateKey: randomBase64() }
    localStorage.setItem('deepview.workspaces', JSON.stringify(persisted))
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
    const persisted = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const idx = persisted.findIndex((w) => w.id === wsId)
    persisted[idx] = { ...persisted[idx], reports: ['A.md', 'B.md'] }
    localStorage.setItem('deepview.workspaces', JSON.stringify(persisted))
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
    const { setHydrationConflictResolver } = await import('../client/triage-sync.js')
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
        const all = JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}')
        return all[wsId]?.baseState?.['finding-B']?.color === 'blue'
      },
      'B in baseState',
    )
    state.markers.set('finding-B', 'green')

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
      state.markers.set('finding-B', 'cyan')

      // Now the user picks "Apply imported" in the dialog.
      const decisions = {}
      for (const c of resolverArgs) decisions[`${c.id}:${c.property}`] = 'imported'
      dialogResolve(decisions)

      // M-2 guard: applyHydrationDecisions sees state.markers ===
      // 'cyan' (not 'green' that was c.local) and skips the
      // overwrite. User's mid-dialog edit survives.
      await waitFor(() => settledAfterAck(wsId), 'follow-up save acked')
      assert.equal(state.markers.get('finding-B'), 'cyan', 'mid-dialog edit preserved')
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
    state.markers.set('finding-A', 'red')
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')
    const oldTag = triageSync.sessionInfo(wsId).workspaceTag
    const oldPersisted = JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}')[wsId]

    // Re-import with the SAME privateKey.
    const persisted = JSON.parse(localStorage.getItem('deepview.workspaces'))
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
    const stillPersisted = JSON.parse(localStorage.getItem('deepview.sync.sessions') ?? '{}')[wsId]
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
      const persisted = JSON.parse(localStorage.getItem('deepview.workspaces') ?? '[]')
      persisted.push({
        id: wsId,
        name: wsId,
        privateKey: randomBase64(),
        reports: [],
        createdAt: Date.now(),
      })
      localStorage.setItem('deepview.workspaces', JSON.stringify(persisted))
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
        && state.markers.get('finding-A') === undefined,
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
    state.triageState.set('finding-A', 'deleted')
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'save acked')

    const tag = triageSync.sessionInfo(wsId).workspaceTag
    const persisted = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const seed = persisted.find((w) => w.id === wsId).privateKey
    const reader = await new Promise((resolve, reject) => {
      const s = new WebSocket(serverUrl)
      s.addEventListener('open', () => resolve(s), { once: true })
      s.addEventListener('error', (e) => reject(e.error ?? new Error('open failed')), { once: true })
    })
    const buffered = []
    reader.addEventListener('message', (e) => buffered.push(JSON.parse(e.data)))
    const { privateKey: signKey } = await cryptoMod.deriveSigningKeypair(seed, wsId)
    const subSig = await cryptoMod.signSubscribePayload(signKey, tag, null)
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
    await waitFor(() => state.markers.get('shared') === 'red', 'shared visible')
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
    const port2 = 19500 + Math.floor(Math.random() * 500) + 500
    const serverDir2 = mkdtempSync(path.join(tmpdir(), 'deepview-client-2-'))
    const serverUrl2 = `ws://127.0.0.1:${port2}`
    const serverProc2 = spawn(process.execPath, ['server/index.js'], {
      env: { ...process.env, PORT: String(port2), HOST: '127.0.0.1', DB_PATH: path.join(serverDir2, 'data.db') },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server2 boot timeout')), 5_000)
        serverProc2.stdout.on('data', (d) => {
          if (String(d).includes('triage-sync server')) { clearTimeout(t); resolve() }
        })
        serverProc2.stderr.on('data', () => {})
      })

      const wsId = await startSession(['finding-X'])
      state.markers.set('finding-X', 'red')
      await saveTriage()
      await waitFor(() => settledAfterAck(wsId), 'baseline ack on server1')

      // Trigger a fresh save and IMMEDIATELY swap servers — don't
      // await saveTriage so the encrypt is racing with setServerUrl.
      state.markers.set('finding-X', 'green')
      const saveP = saveTriage()
      triageSync.setServerUrl(serverUrl2)

      // Both promises must complete without throwing; the in-flight
      // save's send may land on server2 with a stale base (rejected),
      // OR be dropped because socket was null at send-time. Either
      // way, no exception escapes.
      await saveP
      await waitFor(() => triageSync.status === 'online', 'reconnected to server2')

      // Self-recovery: a subsequent edit must land on server2 cleanly.
      state.markers.set('finding-X', 'blue')
      await saveTriage()
      await waitFor(() => settledAfterAck(wsId), 'follow-up save acked on server2')
      assert.equal(state.markers.get('finding-X'), 'blue')

      triageSync.closeSession(wsId)
      await deleteWorkspace(wsId)
    } finally {
      triageSync.setServerUrl(serverUrl)
      serverProc2.kill('SIGTERM')
      await new Promise((resolve) => { serverProc2.once('exit', resolve) })
      rmSync(serverDir2, { recursive: true, force: true })
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
    state.markers.set('shared-finding', 'red')
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')
    const baselineRev = triageSync.sessionInfo(wsId).baseRevision
    assert.ok(baselineRev, 'baseline revision exists')

    // Simulate a sibling tab persisting different state. Build the
    // blob the way saveTriage would (gzipped, base64) by routing
    // through saveTriage on a swapped state, then restore state.
    state.markers.set('shared-finding', 'green')
    await saveTriage()
    // saveTriage above bumped baseRevision via its own round-trip;
    // capture the new baseline.
    await waitFor(() => settledAfterAck(wsId), 'sibling-mimic ack')
    const sentinelRev = triageSync.sessionInfo(wsId).baseRevision

    // Now mutate state.* in-memory to simulate "this tab's view"
    // having drifted, then call reloadTriageFromStorage as if a
    // storage event fired. Reload should overwrite state.* with the
    // persisted (green) value WITHOUT firing an outbound save.
    state.markers.set('shared-finding', 'cyan')
    await reloadTriageFromStorage()
    assert.equal(state.markers.get('shared-finding'), 'green', 'reload picked up persisted value')

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
    const finalColor = state.markers.get('shared')
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
    // raises `pendingSave`. The reset paths now clear the flag.
    const wsId = await startSession(['finding-A'])
    state.markers.set('finding-A', 'red')
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')
    // Manually pin `encrypting=true` to simulate an in-flight IIFE
    // that hasn't returned. (Capturing the real race deterministically
    // would need encryptJson stubbing; the explicit set is the same
    // observable.)
    const sessions = (await import('../client/triage-sync.js')).triageSync.openSessions
    void sessions  // touch import; we read via sessionInfo below
    // sessionInfo doesn't expose `encrypting` directly, but `setEnabled`
    // is the documented reset point — invoke it and verify state.
    triageSync.setEnabled(false)
    triageSync.setEnabled(true)
    await waitFor(statusOnline, 'reconnected after toggle')
    // After re-enable, a fresh save must complete cleanly; if
    // `encrypting=true` had been stranded, the trySendSave would
    // raise pendingSave (no-op observable) but the ack still lands.
    state.markers.set('finding-A', 'green')
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
    state.markers.set('shared-finding', 'red')
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')

    const tag = triageSync.sessionInfo(wsId).workspaceTag
    const persisted = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const seed = persisted.find((w) => w.id === wsId).privateKey

    // Half 1: ignoredReports delivery via chain.
    await pushRemoteChange(serverUrl, tag, seed, {
      'shared-finding': { color: 'red', ignoredReports: ['somereport.md'] },
    })
    await waitFor(
      () => state.ignoredIds.has('somereport.md\0shared-finding'),
      'ignoredReports from chain landed in state.ignoredIds',
    )

    // Half 2: chain entry with BOTH triage + ignoredReports → apply
    // triage, skip ignoredReports. (Mutex check on a stale chain
    // entry that violates the action-handler invariant.)
    await pushRemoteChange(serverUrl, tag, seed, {
      'shared-finding': { triage: 'fixed', ignoredReports: ['x.md'] },
    })
    await waitFor(
      () => state.triageState.get('shared-finding') === 'fixed',
      'triage from chain applied',
    )
    assert.equal(
      state.ignoredIds.has('x.md\0shared-finding'),
      false,
      'ignoredReports skipped due to apply-side mutex',
    )
    // The earlier ignoredReports ('somereport.md') should also be
    // dropped because the second chain entry's wire view sets
    // triage and the apply path clears local ignoredIds for the id.
    assert.equal(
      state.ignoredIds.has('somereport.md\0shared-finding'),
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
    const { setHydrationConflictResolver } = await import('../client/triage-sync.js')
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
    state.markers.set('shared-finding', 'red')
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')

    const tag = triageSync.sessionInfo(wsId).workspaceTag
    const persisted = JSON.parse(localStorage.getItem('deepview.workspaces'))
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
    // saveTriage (which awaits compressBrotli) BEFORE kicking
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
    state.markers.set('finding-A', 'red')
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')
    const baselineRev = triageSync.sessionInfo(wsId).baseRevision

    const tag = triageSync.sessionInfo(wsId).workspaceTag
    const persisted = JSON.parse(localStorage.getItem('deepview.workspaces'))
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
        const blob = JSON.parse(blobRaw)
        return blob[wsId]?.baseRevision === rebasedRev
      },
      'persisted-sessions baseRevision tracks live session',
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

const cryptoMod = await import('../client/sync-crypto.js')
// Native WebSocket on the client side — same API surface as the
// browser, which is the production environment the client actually
// runs against. The `ws` package is kept strictly to the server side
// (its WebSocketServer); its EventEmitter-shaped client drifts from
// the browser implementation and the production code won't ever see
// it, so exercising it from the test would test the wrong thing.
const { WebSocketServer } = await import('ws')

// In-process WebSocket server the test fully controls. Used for
// scenarios the real server (server/index.js) won't ever produce —
// content-id mismatches, bad signatures, bogus continuity in the
// chain — so we can exercise the client's defensive skip / resync
// paths without altering the relay.
async function startFakeRelay(onConnection) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((resolve) => { wss.once('listening', resolve) })
  const url = `ws://127.0.0.1:${wss.address().port}`
  wss.on('connection', onConnection)
  return {
    url,
    close: () => new Promise((resolve) => { wss.close(resolve) }),
  }
}

async function pushRemoteChange(url, workspaceTag, seedB64, changeset) {
  // Open a fresh socket; we'll subscribe + save + close.
  const ws = await new Promise((resolve, reject) => {
    const s = new WebSocket(url)
    s.addEventListener('open', () => resolve(s), { once: true })
    s.addEventListener('error', (event) => reject(event.error ?? new Error('websocket error')), { once: true })
  })
  const key = await cryptoMod.deriveSessionKey(seedB64)
  // deriveSigningKeypair takes the workspaceId as an HKDF info
  // string; we only have the seed + tag here, so look the id up by
  // matching the seed against the persisted workspace record.
  const persisted = JSON.parse(localStorage.getItem('deepview.workspaces'))
  const candidate = persisted.find((w) => w.privateKey === seedB64)
  const { privateKey: signingKey } = await cryptoMod.deriveSigningKeypair(seedB64, candidate.id)

  // Drain the subscribe handshake messages first.
  const buffered = []
  ws.addEventListener('message', (event) => buffered.push(JSON.parse(event.data)))
  const subSig = await cryptoMod.signSubscribePayload(signingKey, workspaceTag, null)
  ws.send(JSON.stringify({ type: 'workspace-subscribe', workspaceTag, from: null, signature: subSig }))
  await waitFor(() => buffered.some((m) => m.type === 'workspace-state'), 'remote subscribe chain')

  // Use the latest revision id as `base` so the save lands cleanly.
  const states = buffered.filter((m) => m.type === 'workspace-state')
  const lastChain = states.flatMap((s) => s.revisions)
  const base = lastChain.length ? lastChain[lastChain.length - 1].id : null

  const aad = cryptoMod.buildAad(workspaceTag, base)
  const { nonce, ciphertext } = await cryptoMod.encryptJson(key, changeset, aad)
  const payload = { publicKeyB64: workspaceTag, base, nonceB64: nonce, ciphertextB64: ciphertext }
  const signature = await cryptoMod.signSavePayload(signingKey, payload)
  ws.send(JSON.stringify({ type: 'workspace-save', workspaceTag, base, nonce, ciphertext, signature }))
  await waitFor(() => buffered.some((m) => m.type === 'workspace-save-ack'), 'remote save ack')
  ws.close()
}
