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

const { triageSync } = await import('../client/triage-sync.js')
const { state } = await import('../client/state.js')
const { saveTriage } = await import('../client/triage.js')
const { upsertWorkspace, deleteWorkspace } = await import('../client/workspaces.js')

// ─────────── helpers ───────────

function randomBase64() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64')
}

function setReports(findings) {
  state.reports.length = 0
  state.reports.push({ groups: [findings] })
}

function clearTriageState() {
  state.markers.clear()
  state.deletedIds.clear()
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
function settledAfterAck() {
  const info = triageSync.sessionInfo
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
    setReports(findingIds.map((id) => ({ id, _id: id })))
    const id = `ws-${Math.random().toString(36).slice(2, 10)}`
    upsertWorkspace({ id, name: id, privateKey: randomBase64(), reports: [] })
    triageSync.openSession(id)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'sync online')
    return id
  }

  it('preserves a user edit made between save and ack', async () => {
    const ws = await startSession(['finding-A', 'finding-B'])
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
    await waitFor(settledAfterAck, 'ack landed and pending cleared')
    // After the rebase + the follow-up save for finding-B, both
    // edits must still be visible.
    await waitFor(() => state.markers.get('finding-B') === 'green', 'finding-B preserved')
    assert.equal(state.markers.get('finding-A'), 'red')
    assert.equal(state.markers.get('finding-B'), 'green')
    triageSync.closeSession()
    deleteWorkspace(ws)
  })

  it('merges a remote change with an in-progress local edit', async () => {
    const wsId = await startSession(['finding-A', 'finding-B'])
    // Local: finding-A = red, sync up.
    state.markers.set('finding-A', 'red')
    await saveTriage()
    await waitFor(settledAfterAck, 'first ack')

    // Push a chain from a SECOND client (raw WS) carrying a remote
    // change to finding-B = green. Local A = red must survive; the
    // remote B = green must land.
    const { workspaceTag } = triageSync.sessionInfo
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
    await waitFor(settledAfterAck, 'baseline ack')

    // User edits to amber WITHOUT calling saveTriage — simulates a
    // rapid in-flight UI edit between two ticks of the sync loop.
    // The chain handler's captureOverlay reads state.* directly,
    // so the merge must see this edit even though no save is queued.
    state.markers.set('finding-A', 'amber')

    const beforeRev = triageSync.sessionInfo.baseRevision
    const { workspaceTag } = triageSync.sessionInfo
    const persisted = JSON.parse(localStorage.getItem('deepview.workspaces'))
    const seed = persisted.find((w) => w.id === wsId).privateKey
    // Remote pushes A = blue. Server appends, broadcasts to client A.
    await pushRemoteChange(serverUrl, workspaceTag, seed, { 'finding-A': { color: 'blue' } })

    // Wait for client A's chain handler to advance baseRevision.
    await waitFor(
      () => triageSync.sessionInfo.baseRevision !== beforeRev,
      'remote chain processed by client A',
    )
    // Local edit (amber) wins over the conflicting remote (blue).
    // Without the rebase fix, captureOverlay-equivalent code would
    // collapse to identity and the user would see the remote value.
    assert.equal(state.markers.get('finding-A'), 'amber')
    triageSync.closeSession()
    deleteWorkspace(wsId)
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
const { WebSocket: WSClient } = await import('ws')

async function pushRemoteChange(url, workspaceTag, seedB64, changeset) {
  // Open a fresh socket; we'll subscribe + save + close.
  const ws = await new Promise((resolve, reject) => {
    const s = new WSClient(url)
    s.once('open', () => resolve(s))
    s.once('error', reject)
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
  ws.on('message', (buf) => buffered.push(JSON.parse(buf.toString())))
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
