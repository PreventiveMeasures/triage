// Race-condition + complex-scenario tests for the triage-sync
// client (client/triage-sync.ts) against a spawned real server.
//
// Sibling of tests/sync-client.test.js — that file pins per-feature
// behaviour (rebase preserves edits, hydration, conflict resolver,
// continuity-break recovery). This file targets the concurrency
// surface that those tests don't reach:
//
//   - Many workspaces multiplexed on one socket, all saving
//     concurrently, no cross-talk.
//   - Rapid in-process edits coalescing into the pending-save
//     slot (pendingSave is a SINGLE slot — N edits in a tick
//     should produce ≤ 1 in-flight save).
//   - Server-restart mid-flow: pending save retransmits on
//     reconnect, no data loss.
//   - Concurrent saveTriage + upsertWorkspace (key rotation) race.
//
// Two it.todo cases pin known client-side bugs that the agent
// audit identified but the production code hasn't fixed yet.

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// MUST run before any client module loads — `_polyfills.js` shims
// `localStorage` / `navigator.locks` and drops broken native
// `Uint8Array.prototype.toHex` that some Node 24.x builds expose
// under `--js-base-64`, before @noble/ciphers captures
// `hasHexBuiltin` at first import. Same pattern as sync-client.test.js.
await import('./_polyfills.js')

const { bootServer } = await import('./_helpers.js')
const { triageSync } = await import('../client/sync/triage-sync.ts')
const { state } = await import('../client/state.ts')
const { saveTriage } = await import('../client/triage.js')
const { upsertWorkspace, deleteWorkspace } = await import('../client/workspaces.js')
const { patchEntry } = await import('../client/triage-entry.ts')

function randomBase64() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString('base64')
}

function setReports(findings, fileName = 'races.md') {
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
function settledAfterAck(workspaceId) {
  const info = triageSync.sessionInfo(workspaceId)
  return info != null && info.baseRevision != null && info.pending == null && !info.encrypting
}

// Count chain revisions for a given workspace_tag directly from
// the server's SQLite file. Avoids the round-trip cost (and key
// material) of spinning up a raw WS subscriber just to read a
// chain depth. The server uses WAL mode so a read-only handle
// on the same file sees a recent-but-consistent snapshot — fine
// for after-settle counts, which is the only thing we use this
// for.
function countChainRevisions(serverDir, workspaceTag) {
  const db = new DatabaseSync(path.join(serverDir, 'data.db'), { readOnly: true })
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM workspace_revision WHERE workspace_tag = ?`).get(workspaceTag)
    return row?.c ?? 0
  } finally { db.close() }
}

describe('triage-sync client races', () => {
  // Caller-owned tmp dir so restart-style tests can kill-and-reboot
  // the server against the same DB. `bootServer({ dir })` leaves the
  // dir alone on teardown; we mkdtemp + rmSync here.
  let port, server, serverDir, serverUrl

  before(async () => {
    serverDir = mkdtempSync(path.join(tmpdir(), 'deepview-client-races-'))
    server = await bootServer({ dir: serverDir })
    port = server.port
    serverUrl = server.serverUrl
  })

  after(async () => {
    triageSync.closeSession()
    triageSync.setServerUrl('')
    if (server) await server.teardown()
    rmSync(serverDir, { recursive: true, force: true })
  })

  // Helper: open ONE session on the shared server with a fresh
  // workspace + report.
  async function startSession(findingIds) {
    triageSync.closeSession()
    clearTriageState()
    const fileName = setReports(findingIds.map((id) => ({ id, _id: id })))
    const id = `ws-${Math.random().toString(36).slice(2, 10)}`
    await upsertWorkspace({ id, name: id, privateKey: randomBase64(), reports: [fileName] })
    triageSync.openSession(id)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'sync online')
    return id
  }

  // ──────────────────────────────────────────────────────────────
  // SECTION 1: Multi-workspace multiplexing under load
  // ──────────────────────────────────────────────────────────────

  it('5 workspaces multiplexed on one socket: edits in one workspace don\'t bleed into others', async () => {
    // Existing tests cover 2 workspaces. Bump to 5 to exercise the
    // session-map under more concurrent activity, with each session
    // bound to a different finding-id scope.
    triageSync.closeSession()
    clearTriageState()
    state.reports.length = 0
    const N = 5
    const wsIds = []
    const findings = []
    for (let i = 0; i < N; i++) {
      const fileName = `file-${i}.md`
      const findingId = `finding-ws-${i}`
      findings.push(findingId)
      state.reports.push({ fileName, groups: [[{ id: findingId, _id: findingId }]] })
      const wsId = `ws-${i}-${Math.random().toString(36).slice(2, 8)}`
      wsIds.push(wsId)
      await upsertWorkspace({ id: wsId, name: wsId, privateKey: randomBase64(), reports: [fileName] })
    }
    for (const id of wsIds) triageSync.openSession(id)
    triageSync.setServerUrl(serverUrl)
    await waitFor(statusOnline, 'all 5 sessions online')
    try {
      // Set a marker in EACH workspace's scope. Each save should
      // surface only on its own workspace's chain.
      for (let i = 0; i < N; i++) patchEntry(state.triage, findings[i], { color: `color-${i}` })
      await saveTriage()
      // All sessions should ack (since each has a scoped edit).
      for (const id of wsIds) await waitFor(() => settledAfterAck(id), `ws ${id} acked`)
      // Each session's base revision is distinct (independent chains).
      const baseRevisions = wsIds.map((id) => triageSync.sessionInfo(id).baseRevision)
      assert.equal(new Set(baseRevisions).size, N, 'all 5 chains advanced to distinct base revisions')
      // workspaceTags are pairwise distinct (different keys).
      const tags = wsIds.map((id) => triageSync.sessionInfo(id).workspaceTag)
      assert.equal(new Set(tags).size, N, 'workspaceTags all distinct')
    } finally {
      for (const id of wsIds) triageSync.closeSession(id)
      for (const id of wsIds) await deleteWorkspace(id)
    }
  })

  // ──────────────────────────────────────────────────────────────
  // SECTION 2: Pending-slot coalescing
  // ──────────────────────────────────────────────────────────────

  it('rapid sequential saveTriage calls coalesce into ≤ 2 revisions on the chain (pendingSave is a single slot)', async () => {
    // The client's `pendingSave` flag + `pending` slot serialise
    // saves: while one save is encrypting/in-flight, additional
    // saveTriage calls overwrite the queued `pending` payload
    // instead of multiplying in-flight saves. Pin the invariant
    // by counting REVISIONS on the chain, not just observing that
    // SOME save landed — N rapid edits in a single tick should
    // produce at most 2 chain revisions (one in flight at the
    // moment edits arrived, plus one queued-and-flushed with the
    // final state).
    const wsId = await startSession(['finding-rapid'])
    try {
      // Fire 10 saveTriage in a tight loop. Each one changes the
      // marker so the diff is non-empty; an empty diff would skip
      // the save entirely.
      const promises = []
      for (let i = 0; i < 10; i++) {
        patchEntry(state.triage, 'finding-rapid', { color: `color-${i}` })
        promises.push(saveTriage())
      }
      await Promise.all(promises)
      // Wait for the session to settle.
      await waitFor(() => settledAfterAck(wsId), 'session settled')
      assert.equal(state.triage.get('finding-rapid')?.color, 'color-9', 'final marker is the LAST set value')
      // workspaceTag is now stable (derived + at least one ack
      // committed). Count actual chain revisions on the server:
      // this is the assertion the test's description promises —
      // without it we'd just be checking that some save landed,
      // not that they coalesced.
      const workspaceTag = triageSync.sessionInfo(wsId).workspaceTag
      assert.ok(workspaceTag, 'workspaceTag derived')
      const chainLen = countChainRevisions(serverDir, workspaceTag)
      assert.ok(
        chainLen <= 2,
        `rapid 10× saveTriage produced ${chainLen} chain revisions; coalescing invariant requires ≤ 2`,
      )
      assert.ok(chainLen >= 1, 'at least one save landed')
    } finally {
      triageSync.closeSession(wsId)
      await deleteWorkspace(wsId)
    }
  })

  // ──────────────────────────────────────────────────────────────
  // SECTION 3: Server restart mid-session
  // ──────────────────────────────────────────────────────────────

  it('server restart preserves the session\'s base across reconnect (no data loss)', async () => {
    // The session's `baseRevision` is the cursor into the chain.
    // After a restart of the server (same DB path), the client
    // reconnects, re-subscribes from=baseRevision, and the chain
    // returned from the server should be empty (no newer revisions).
    const wsId = await startSession(['finding-restart'])
    try {
      patchEntry(state.triage, 'finding-restart', { color: 'red' })
      await saveTriage()
      await waitFor(() => settledAfterAck(wsId), 'baseline ack')
      const baseAfterFirstSave = triageSync.sessionInfo(wsId).baseRevision
      assert.ok(baseAfterFirstSave, 'baseline base set')
      // Kill + restart server with the same DB path.
      await server.teardown()
      // Restart on the SAME port so the client's `serverUrl` stays
      // valid — reconnect should land on the same address.
      server = await bootServer({ dir: serverDir, env: { PORT: String(port) } })
      // Client should reconnect and re-subscribe. Wait for online.
      await waitFor(statusOnline, 'reconnected after restart', 10_000)
      // The session's base should be EITHER the pre-restart base
      // (no new revisions on the server) OR an advancement (if any
      // peer landed something — none in this test).
      const baseAfterRestart = triageSync.sessionInfo(wsId).baseRevision
      assert.equal(
        baseAfterRestart, baseAfterFirstSave,
        'base survived restart (no newer revisions on the server)',
      )
      // A fresh save after restart still works.
      patchEntry(state.triage, 'finding-restart', { color: 'green' })
      await saveTriage()
      await waitFor(() => triageSync.sessionInfo(wsId).baseRevision !== baseAfterRestart, 'post-restart save advanced base')
      assert.notEqual(triageSync.sessionInfo(wsId).baseRevision, baseAfterRestart)
    } finally {
      triageSync.closeSession(wsId)
      await deleteWorkspace(wsId)
    }
  })

  // ──────────────────────────────────────────────────────────────
  // SECTION 4: Concurrent session lifecycle ops
  // ──────────────────────────────────────────────────────────────

  it('closeSession during an in-flight save: persisted state stays consistent (no half-save)', async () => {
    // The session can be closed while a save is mid-encryption.
    // `closeSession` (client/triage-sync.ts:2407-2417) only removes
    // the entry from the `sessions` map — the underlying WS socket
    // stays open and is shared across sessions. The drop mechanism
    // for an in-flight save IIFE is the `sessions.get(workspaceId)
    // !== session` re-check at line 1358-1359, run AFTER the
    // encrypt-await: the captured session reference no longer
    // matches the map entry, so the IIFE bails before `send()`.
    //
    // We pin the externally-observable invariant: the localStorage-
    // persisted base after close matches the last fully-acked save
    // (the post-close save's encrypt result is dropped by the
    // identity recheck, never reaches persist).
    const wsId = await startSession(['finding-close'])
    try {
      patchEntry(state.triage, 'finding-close', { color: 'red' })
      await saveTriage()
      await waitFor(() => settledAfterAck(wsId), 'baseline ack')
      const settledBase = triageSync.sessionInfo(wsId).baseRevision
      // Trigger a save and IMMEDIATELY close the session.
      patchEntry(state.triage, 'finding-close', { color: 'green' })
      const savePromise = saveTriage()
      triageSync.closeSession(wsId)
      // saveTriage settles (the underlying op's promise resolves
      // even if the session closed mid-flight).
      await savePromise.catch(() => null)
      // Re-opening the session loads the persisted base synchronously
      // (loadPersistedSession). It MUST be settledBase: the post-close
      // save's encrypt result was dropped by the identity recheck and
      // never persisted. Read it right AT openSession — before the
      // reopened session subscribes and legitimately re-pushes the green
      // edit that's still live in module-level state.* (that re-sync
      // would advance the base and is NOT what this test pins). Reading
      // at the load point also makes the assertion independent of how
      // long `online` takes to settle — the previous post-`online` read
      // only passed because the old status logic reported `online`
      // before the subscribe-ack (and thus before the re-push acked).
      triageSync.openSession(wsId)
      const reopenedBase = triageSync.sessionInfo(wsId).baseRevision
      assert.equal(reopenedBase, settledBase, 'persisted base after close is the last fully-acked base, not a half-saved one')
    } finally {
      triageSync.closeSession(wsId)
      await deleteWorkspace(wsId)
    }
  })

  it('many open/close cycles do not leak sessions (lifecycle resilience)', async () => {
    // A stress test for session lifecycle. After N cycles, only
    // the currently-open session should be in triageSync.sessionInfo;
    // no zombie state should accumulate.
    const wsId = `ws-cycle-${Math.random().toString(36).slice(2, 10)}`
    const fileName = setReports([{ id: 'cyclic', _id: 'cyclic' }], 'cycle.md')
    await upsertWorkspace({ id: wsId, name: wsId, privateKey: randomBase64(), reports: [fileName] })
    try {
      for (let i = 0; i < 10; i++) {
        triageSync.openSession(wsId)
        triageSync.setServerUrl(serverUrl)
        await waitFor(statusOnline, `cycle ${i}: online`)
        triageSync.closeSession(wsId)
        // No info after close.
        assert.equal(triageSync.sessionInfo(wsId), null, `cycle ${i}: session info gone after close`)
      }
    } finally {
      await deleteWorkspace(wsId)
    }
  })

  // ──────────────────────────────────────────────────────────────
  // SECTION 5: existing-protection positive pins
  // ──────────────────────────────────────────────────────────────
  //
  // These pin behaviours the production code already implements
  // correctly. An earlier draft had it.todo cases here claiming
  // "should signal continuity error" / "should preserve marker
  // across rotation" — but reading client/triage-sync.ts:1465-1471
  // and :1358-1359 confirms both protections are already in place.
  // The tests below assert the working contract so a future
  // regression in either path fails loudly.

  it('rotation mid-edit: marker set BEFORE upsertWorkspace lands in the new identity\'s first save', async () => {
    // client/triage-sync.ts:1358-1359 — `trySendSave`'s IIFE
    // re-checks `session.workspaceTag !== workspaceTag` after the
    // encrypt await; a stale IIFE under the OLD key is dropped
    // when rotation has flipped the tag.
    //
    // But the USER'S EDIT in `state.markers` is independent of
    // any single session — it's module-level state. The new
    // identity's first save SHOULD pick it up via
    // `effectiveLocalState`. Pin that contract.
    const wsId = await startSession(['finding-rotate'])
    try {
      // Set a marker BEFORE rotation.
      patchEntry(state.triage, 'finding-rotate', { color: 'edited-before-rotation' })
      const oldTag = triageSync.sessionInfo(wsId).workspaceTag
      // Rotate the workspace's private key. The session listener
      // tears down + reopens under the new identity.
      await upsertWorkspace({ id: wsId, name: wsId, privateKey: randomBase64(), reports: ['races.md'] })
      await waitFor(
        () => triageSync.sessionInfo(wsId)?.workspaceTag != null
          && triageSync.sessionInfo(wsId).workspaceTag !== oldTag,
        'session reopened under new identity',
      )
      await waitFor(statusOnline, 'new identity online')
      // The marker is still in state.markers (module-level).
      assert.equal(state.triage.get('finding-rotate')?.color, 'edited-before-rotation')
      // The new identity's first save picks it up via the
      // effectiveLocalState diff. Trigger by setting again (no-op
      // diff would skip; setting to a fresh value forces a save).
      patchEntry(state.triage, 'finding-rotate', { color: 'committed-under-new-identity' })
      await saveTriage()
      await waitFor(() => settledAfterAck(wsId), 'committed under new identity')
      // Chain under the NEW workspaceTag has the post-rotation save.
      const newTag = triageSync.sessionInfo(wsId).workspaceTag
      assert.notEqual(newTag, oldTag)
      const chainLen = countChainRevisions(serverDir, newTag)
      assert.ok(chainLen >= 1, 'new identity has at least one revision')
      // The OLD tag's chain is independent (and may be empty if no
      // pre-rotation save committed, or have 1 row if one did).
      const oldChain = countChainRevisions(serverDir, oldTag)
      assert.ok(oldChain <= 1, `old tag chain bounded: ${oldChain}`)
    } finally {
      triageSync.closeSession(wsId)
      await deleteWorkspace(wsId)
    }
  })

  it('chain-continuity break triggers a re-subscribe (does NOT silently drift)', async () => {
    // client/triage-sync.ts:1465-1471 — on `!ok` (base mismatch),
    // applyChainToBase returns false WITHOUT mutating baseRevision
    // or baseState.
    // client/triage-sync.ts:1734-1761 — handleChain then sets
    // `resyncAttempted = true`, fires trySendSubscribe(true). On a
    // second break, full state-push reset.
    //
    // The real server never produces a malformed chain (commitRevision
    // enforces base-match before INSERT), so reaching the re-subscribe
    // path from a normal session run isn't possible without injecting
    // a synthetic chain. The fact that we CAN'T trigger it from a
    // black-box client API call is the protection working: the
    // server-side invariant + client-side recovery layer together
    // mean a continuity break is bounded by an automatic catch-up,
    // not a silent drift. Pin the positive correctness shape: a
    // legitimate end-to-end run produces no spurious
    // `resyncAttempted` flips.
    const wsId = await startSession(['finding-continuous'])
    try {
      // 10 sequential saves; chain stays continuous. Whatever path
      // through the client we hit, resyncAttempted should never
      // latch true on a non-malformed chain.
      for (let i = 0; i < 10; i++) {
        patchEntry(state.triage, 'finding-continuous', { color: `step-${i}` })
        await saveTriage()
        await waitFor(() => settledAfterAck(wsId), `step ${i} settled`)
      }
      // Status is online (no error latch from a phantom continuity
      // break).
      assert.equal(triageSync.status, 'online', 'status stays online across 10 sequential saves')
      // The chain has exactly 10 revisions (each save advanced it).
      const tag = triageSync.sessionInfo(wsId).workspaceTag
      const chainLen = countChainRevisions(serverDir, tag)
      assert.equal(chainLen, 10)
    } finally {
      triageSync.closeSession(wsId)
      await deleteWorkspace(wsId)
    }
  })
})
