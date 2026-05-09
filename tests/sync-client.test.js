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

if (typeof globalThis.localStorage === 'undefined') {
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
    upsertWorkspace({ id, name: id, privateKey: randomBase64(), reports: [fileName] })
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
    deleteWorkspace(wsId)
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
    deleteWorkspace(wsId)
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
    deleteWorkspace(wsId)
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
    deleteWorkspace(wsId)
  })

  it('skips a revision whose id does not match its content hash', async () => {
    // Fake relay so we can fabricate a chain entry the real server
    // would never produce. The signature is valid; only the `id`
    // field is wrong, hitting the content-hash check that runs
    // before signature verification.
    const wsId = `ws-${Math.random().toString(36).slice(2, 10)}`
    const seed = randomBase64()
    upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['t.md'] })
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
    // Give the queued message handler a chance to run.
    await new Promise((resolve) => { setTimeout(resolve, 200) })
    // The revision was skipped: state.markers must NOT have the
    // 'red' value the (bogus) chain tried to set.
    assert.equal(state.markers.get('finding-A'), undefined, 'bogus-id revision did not poison state')
    // baseRevision advances past the skipped rev (so subsequent
    // revisions in the same chain can build on it), but baseState
    // stays empty since no content was applied.
    assert.equal(triageSync.sessionInfo(wsId).baseRevision, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    triageSync.closeSession()
    triageSync.setServerUrl('')
    deleteWorkspace(wsId)
    await relay.close()
  })

  it('skips a revision whose signature does not verify', async () => {
    const wsId = `ws-${Math.random().toString(36).slice(2, 10)}`
    const seed = randomBase64()
    upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['t.md'] })
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
    deleteWorkspace(wsId)
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
    upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['t.md'] })
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
    deleteWorkspace(wsId)
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
    upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['t.md'] })
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
    deleteWorkspace(wsId)
    await relay.close()
  })

  it('heartbeat closes the socket when the server stops responding to pings', async () => {
    // Fake relay accepts the connection but never replies to a
    // `ping`. With heartbeat enabled, the client should hit its
    // pong-timeout and close the socket; status flips to `offline`
    // and the reconnect path takes over.
    const wsId = `ws-${Math.random().toString(36).slice(2, 10)}`
    upsertWorkspace({ id: wsId, name: wsId, privateKey: randomBase64(), reports: ['t.md'] })
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
    deleteWorkspace(wsId)
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
    deleteWorkspace(wsId)
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
    const all = JSON.parse(localStorage.getItem('deepview.sync.sessions.v2') ?? '{}')
    delete all[wsId]
    localStorage.setItem('deepview.sync.sessions.v2', JSON.stringify(all))
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
    deleteWorkspace(wsId)
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
    upsertWorkspace({ id: wsA, name: wsA, privateKey: randomBase64(), reports: ['A.md'] })
    upsertWorkspace({ id: wsB, name: wsB, privateKey: randomBase64(), reports: ['B.md'] })

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
    deleteWorkspace(wsA)
    deleteWorkspace(wsB)
  })

  it('closeSession(id) only closes that one; the other keeps syncing', async () => {
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    state.reports.push({ fileName: 'A.md', groups: [[ { id: 'fA', _id: 'fA' } ]] })
    state.reports.push({ fileName: 'B.md', groups: [[ { id: 'fB', _id: 'fB' } ]] })
    const wsA = `ws-A-${Math.random().toString(36).slice(2, 8)}`
    const wsB = `ws-B-${Math.random().toString(36).slice(2, 8)}`
    upsertWorkspace({ id: wsA, name: wsA, privateKey: randomBase64(), reports: ['A.md'] })
    upsertWorkspace({ id: wsB, name: wsB, privateKey: randomBase64(), reports: ['B.md'] })

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
    deleteWorkspace(wsA)
    deleteWorkspace(wsB)
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
    upsertWorkspace({ id: wsA, name: wsA, privateKey: seedA, reports: ['A.md'] })
    upsertWorkspace({ id: wsB, name: wsB, privateKey: seedB, reports: ['B.md'] })

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
    deleteWorkspace(wsA)
    deleteWorkspace(wsB)
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
    upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['A.md'] })

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
    deleteWorkspace(wsId)
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
    upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['A.md'] })

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
    deleteWorkspace(wsId)
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
    upsertWorkspace({ id: wsId, name: wsId, privateKey: randomBase64(), reports: ['A.md'] })

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
    setReportWorkspace('B.md', wsId)

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
    deleteWorkspace(wsId)
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
    upsertWorkspace({ id: wsId, name: wsId, privateKey: seed, reports: ['A.md'] })
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
    deleteWorkspace(wsId)
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
    upsertWorkspace({ id: wsId, name: wsId, privateKey: 'AAAA', reports: ['A.md'] })

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
    assert.match(triageSync.sessionInfo(wsId).error, /key derivation failed/i)
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
    deleteWorkspace(wsId)
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
    upsertWorkspace({ id: wsId, name: wsId, privateKey: 'AAAA', reports: ['A.md'] })

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
    upsertWorkspace({ id: wsId, name: wsId, privateKey: randomBase64(), reports: ['A.md'] })

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
    deleteWorkspace(wsId)
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
    deleteWorkspace(wsId)
  })

  it('deleteWorkspace tears down the live session and drops persisted base', async () => {
    const wsId = await startSession(['finding-A'])
    state.markers.set('finding-A', 'red')
    await saveTriage()
    await waitFor(() => settledAfterAck(wsId), 'baseline ack')

    // Sanity: session is live and a persisted entry exists.
    assert.notEqual(triageSync.sessionInfo(wsId), null)
    const persistedBefore = JSON.parse(localStorage.getItem('deepview.sync.sessions.v2') ?? '{}')
    assert.ok(persistedBefore[wsId], 'persisted session entry exists pre-delete')

    // Workspace deletion goes through the listener wired up in
    // triage-sync at module init: in-memory session is dropped AND
    // the persisted-base entry is wiped, so the same id can't get
    // reanimated from a stale chain on the next page load.
    deleteWorkspace(wsId)

    assert.equal(triageSync.sessionInfo(wsId), null, 'session removed in-memory')
    const persistedAfter = JSON.parse(localStorage.getItem('deepview.sync.sessions.v2') ?? '{}')
    assert.equal(persistedAfter[wsId], undefined, 'persisted session entry dropped')
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
