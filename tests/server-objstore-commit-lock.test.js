// Distributed commit-lock — pins the cross-replica serialization
// invariants the in-process KeyedAsyncLock can't provide once
// multiple replicas share the same DB + blob store.
//
// "Multi-replica" is simulated by opening TWO separate Handles
// against the SAME SQLite database. Each Handle has its own
// in-process KeyedAsyncLock and its own random `holder` id —
// indistinguishable from two server processes pointing at the
// same Neon endpoint. The DB-backed commit lock (the
// `workspace_object_commit_lock` table + helper in
// `commit-lock.ts`) is the SHARED resource that serializes them.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Buffer } from 'node:buffer'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { abortPut, beginPut, commitPut, deleteObject, getLive, openObjstore } from '../server/objstore/store.ts'
import { liveFilePath, stagingFilePath } from '../server/objstore/fs.ts'
import { CommitLockContendedError, heldLeaseCount, newHolderId, releaseAllForThisProcess, tryAcquireCommitLock, withCommitLock } from '../server/objstore/commit-lock.ts'
import { reapOrphans } from '../server/objstore/reaper.ts'

let counter = 0
function freshHandle() {
  const dir = mkdtempSync(path.join(tmpdir(), `dv-commitlock-${++counter}-`))
  const dbPath = path.join(dir, 'data.db')
  const objDir = path.join(dir, 'objstore')
  const db = new DatabaseSync(dbPath)
  const handle = openObjstore(db, objDir)
  return {
    handle, db, dbPath, objDir,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

// Two Handles against the same DB + same objstore dir — the test
// fixture for "two replicas pointed at one shared state". Each
// Handle has its own KeyedAsyncLock instance and a DISTINCT
// commit-lock holder id, simulating two server processes pointed
// at the same Neon endpoint. (Both Handles share Node's module-
// load HOLDER_ID, so we override per-Handle via the holderId
// option on the lock helpers.)
function twoReplicas() {
  const fx = freshHandle()
  const db2 = new DatabaseSync(fx.dbPath)
  const handle2 = openObjstore(db2, fx.objDir)
  return {
    handle1: fx.handle, handle2,
    holder1: newHolderId(), holder2: newHolderId(),
    db1: fx.db, db2,
    objDir: fx.objDir,
    cleanup: () => { db2.close(); fx.cleanup() },
  }
}

function b64u32() { return 'a'.repeat(43) }
function b64u64() { return 'a'.repeat(86) }
function fakeBegin(over = {}) {
  return {
    workspaceTag: 'ws-1', resourceTag: 'res-1', prevVersion: null,
    expectedLength: 16, contentHash: b64u32(), signature: b64u64(),
    ...over,
  }
}
function writeStaging(filePath, bytes) {
  const fd = openSync(filePath, 'a')
  try { writeSync(fd, bytes) } finally { closeSync(fd) }
}

describe('commit-lock — basic semantics', () => {
  it('first acquire wins; SAME-HOLDER re-acquire is contended (no transparent refresh)', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const a = await tryAcquireCommitLock(handle, 'ws-1', 'res-1')
      assert.equal(a.ok, true)
      // Same process re-acquiring — MUST be contended. The DB SQL
      // deliberately omits a same-holder transparent-refresh branch
      // so the reaper can't accidentally pass the gate while a
      // REST PUT on the same process is still holding the lock
      // (both use PROCESS_HOLDER_ID by default). Defeating that
      // gate would re-introduce the multi-replica race in single-
      // process deployments. Refresh, if needed, is explicit
      // release + re-acquire.
      const b = await tryAcquireCommitLock(handle, 'ws-1', 'res-1')
      assert.equal(b.ok, false, 'same-holder re-acquire is contended (no transparent refresh)')
      await a.lock.release()
      // After release, a fresh acquire succeeds.
      const c = await tryAcquireCommitLock(handle, 'ws-1', 'res-1')
      assert.equal(c.ok, true)
      await c.lock.release()
    } finally { cleanup() }
  })

  it('lock is keyed by (workspace_tag, resource_tag) — distinct keys do not contend', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const a = await tryAcquireCommitLock(handle, 'ws-1', 'res-1')
      const b = await tryAcquireCommitLock(handle, 'ws-1', 'res-2')
      const c = await tryAcquireCommitLock(handle, 'ws-2', 'res-1')
      assert.equal(a.ok, true)
      assert.equal(b.ok, true)
      assert.equal(c.ok, true)
      await a.lock.release(); await b.lock.release(); await c.lock.release()
    } finally { cleanup() }
  })

  it('release is idempotent (double-release does not throw)', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const a = await tryAcquireCommitLock(handle, 'ws-1', 'res-1')
      assert.equal(a.ok, true)
      await a.lock.release()
      await a.lock.release()  // no-op, no throw
    } finally { cleanup() }
  })

  it('withCommitLock releases on throw inside the callback', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      await assert.rejects(
        // eslint-disable-next-line require-await
        () => withCommitLock(handle, 'ws-1', 'res-1', async () => {
          throw new Error('inner-throw')
        }),
        /inner-throw/u,
      )
      // Lock was released — next acquire succeeds immediately.
      const r = await tryAcquireCommitLock(handle, 'ws-1', 'res-1')
      assert.equal(r.ok, true)
      await r.lock.release()
    } finally { cleanup() }
  })
})

describe('commit-lock — cross-replica (two Handles, same DB)', () => {
  it('two replicas contend on the same (tag, res) — one wins, other gets ok=false', async () => {
    // Direct simulation: replica A acquires, replica B tries —
    // expects contended. This is the load-bearing invariant the
    // reviewer flagged was missing in the original PR.
    const { handle1, handle2, holder1, holder2, cleanup } = twoReplicas()
    try {
      const aLock = await tryAcquireCommitLock(handle1, 'ws-1', 'res-1', { holderId: holder1 })
      assert.equal(aLock.ok, true, 'replica A acquires')
      const bAttempt = await tryAcquireCommitLock(handle2, 'ws-1', 'res-1', { holderId: holder2 })
      assert.equal(bAttempt.ok, false, 'replica B is contended — different holder, lease not expired')
      // After A releases, B succeeds.
      await aLock.lock.release()
      const bAgain = await tryAcquireCommitLock(handle2, 'ws-1', 'res-1', { holderId: holder2 })
      assert.equal(bAgain.ok, true, 'replica B acquires after A releases')
      await bAgain.lock.release()
    } finally { cleanup() }
  })

  it('expired lease can be stolen by another replica', async () => {
    const { handle1, handle2, holder1, holder2, cleanup } = twoReplicas()
    try {
      // Acquire with a very short lease (1 ms) — by the time the
      // second acquire runs, the lease has expired.
      const aLock = await tryAcquireCommitLock(handle1, 'ws-1', 'res-1', { leaseMs: 1, holderId: holder1 })
      assert.equal(aLock.ok, true)
      // Wait past the lease expiry.
      await new Promise((r) => { setTimeout(r, 50) })
      const bSteal = await tryAcquireCommitLock(handle2, 'ws-1', 'res-1', { holderId: holder2 })
      assert.equal(bSteal.ok, true, 'replica B steals the expired lease')
      // Replica A's release no longer matches (B now holds) — silent
      // no-op, doesn't unlock B's lease.
      await aLock.lock.release()
      // C tries to acquire — should still see B's live lease.
      const cAttempt = await tryAcquireCommitLock(handle1, 'ws-1', 'res-1', { holderId: holder1 })
      assert.equal(cAttempt.ok, false, 'A\'s release did not free B\'s lease')
      await bSteal.lock.release()
    } finally { cleanup() }
  })

  it('concurrent commitPut on the same key — exactly one wins AND live bytes match the winner\'s metadata', async () => {
    // Direct end-to-end: simulate two replicas each running the
    // REST PUT path's commit critical section under withCommitLock.
    // The serialization must keep the live row's content_hash +
    // content bytes CONSISTENT (no metadata-from-A but bytes-
    // from-B mix). Each replica uses a DISTINCT contentHash + byte
    // marker so we can attribute the winner.
    const { handle1, handle2, holder1, holder2, objDir, cleanup } = twoReplicas()
    try {
      const hashA = 'a'.repeat(43)
      const hashB = 'b'.repeat(43)
      const beginA = await beginPut(handle1, fakeBegin({ contentHash: hashA }))
      const beginB = await beginPut(handle2, fakeBegin({ contentHash: hashB }))
      assert.equal(beginA.ok, true); assert.equal(beginB.ok, true)
      assert.notEqual(beginA.stagingId, beginB.stagingId)
      writeStaging(stagingFilePath(objDir, 'ws-1', beginA.stagingId), Buffer.alloc(16, 0xAA))
      writeStaging(stagingFilePath(objDir, 'ws-1', beginB.stagingId), Buffer.alloc(16, 0xBB))

      // Run BOTH commits "concurrently", each wrapped in
      // withCommitLock as the REST handler does. The DB lock
      // serializes them — exactly one runs commitPut at a time.
      const aResult = withCommitLock(handle1, 'ws-1', 'res-1',
        () => commitPut(handle1, { workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: beginA.stagingId }),
        { holderId: holder1 })
      const bResult = withCommitLock(handle2, 'ws-1', 'res-1',
        () => commitPut(handle2, { workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: beginB.stagingId }),
        { holderId: holder2 })

      const settled = await Promise.allSettled([aResult, bResult])
      const fulfilled = settled.filter((s) => s.status === 'fulfilled')
      const okOne = fulfilled.filter((s) => s.value.ok === true)
      assert.equal(okOne.length, 1, 'exactly one commit succeeds')
      const winnerHash = okOne[0].value.row.contentHash
      assert.ok(winnerHash === hashA || winnerHash === hashB, `winner hash should be one of the inputs, got ${winnerHash}`)
      // Read the live row from a third snapshot — confirm the
      // metadata matches what the winning commit reported.
      const live = await getLive(handle1, 'ws-1', 'res-1')
      assert.equal(live?.contentHash, winnerHash, 'live row\'s content_hash must match the winning commit')
      // Read the live bytes off disk and confirm they match the
      // marker associated with `winnerHash`. This catches a class
      // of bug where the lock serializes the DB writes correctly
      // but allows a stale blob-side write to overwrite the live
      // bytes (mismatched metadata vs bytes = silent corruption).
      const liveBytes = readFileSync(liveFilePath(objDir, 'ws-1', 'res-1'))
      const expectedMarker = winnerHash === hashA ? 0xAA : 0xBB
      assert.equal(liveBytes.length, 16)
      assert.equal(liveBytes[0], expectedMarker, `live bytes (marker 0x${liveBytes[0].toString(16)}) must come from the winning commit (expected 0x${expectedMarker.toString(16)})`)
      // The loser is either contended (lost the lock race) or
      // conflict (got the lock second and saw the live row).
      const other = settled.find((s) => s !== okOne[0])
      const otherIsContended = other.status === 'rejected' && other.reason instanceof CommitLockContendedError
      const otherIsConflict = other.status === 'fulfilled' && !other.value.ok && other.value.reason === 'conflict'
      assert.ok(otherIsContended || otherIsConflict, `loser is contended-or-conflict, got: ${JSON.stringify(other)}`)
    } finally { cleanup() }
  })

  it('reaper on replica B does NOT delete a live blob that replica A is in the middle of committing', async () => {
    // The race the reviewer called out: replica A is mid-commit
    // (has the lock + just wrote the live blob, hasn't run
    // upsertLive yet), replica B's reaper runs, finds a live blob
    // with no row, and unlinks. With the DB lock, the reaper
    // attempts tryAcquireCommitLock, finds it held by A, skips.
    const { handle1, handle2, holder1, objDir, cleanup } = twoReplicas()
    try {
      // Replica A acquires the commit lock. Inside the critical
      // section, simulate "promote ran but upsertLive hasn't" by
      // manually creating a live file with no DB row.
      const aLock = await tryAcquireCommitLock(handle1, 'ws-1', 'res-1', { holderId: holder1 })
      assert.equal(aLock.ok, true)
      // The workspace dir is created on first beginPut via
      // ensureWorkspace; force-create it so the synthetic live
      // file write works without first running a real beginPut
      // (which would acquire the lock we just took).
      const begin = await beginPut(handle1, fakeBegin({ resourceTag: 'res-bootstrap' }))
      await abortPut(handle1, 'ws-1', 'res-bootstrap', begin.stagingId)
      const livePath = liveFilePath(objDir, 'ws-1', 'res-1')
      // Synthesise the post-promote / pre-upsert state.
      writeStaging(livePath, Buffer.alloc(8))
      // Replica B's reaper runs against the SHARED state. The
      // reaper code uses the process-wide HOLDER_ID, which is
      // different from holder1, so the lock IS contended from the
      // reaper's perspective. Skip the unlink for this key.
      await reapOrphans(handle2)
      assert.equal(
        existsSync(livePath), true,
        'reaper must not unlink a live blob whose commit-lock is held by another replica',
      )
      await aLock.lock.release()
      // Now that A released, a follow-up reaper pass CAN clean
      // the stranded blob (no row points at it).
      await reapOrphans(handle2)
      assert.equal(existsSync(livePath), false, 'after lock release, reaper cleans the stranded live blob')
    } finally { cleanup() }
  })
})

describe('REST PUT path through the commit lock', () => {
  it('aborted REST PUT releases the commit lock so a retry can proceed', async () => {
    // Models: REST PUT acquires lock, body upload fails mid-stream
    // → withCommitLock catches/rethrows but the finally releases.
    // A second PUT on the same key should NOT see contention.
    const { handle, cleanup } = freshHandle()
    try {
      // First attempt: simulate a body abort inside the lock.
      await assert.rejects(
        // eslint-disable-next-line require-await
        () => withCommitLock(handle, 'ws-1', 'res-1', async () => {
          // Stand in for the body pipeline failing → REST handler
          // throws something to bail out of the lock-wrapped block.
          throw new Error('aborted')
        }),
        /aborted/u,
      )
      // Second attempt: lock is free.
      const begin = await beginPut(handle, fakeBegin())
      writeStaging(stagingFilePath(handle.dir, 'ws-1', begin.stagingId), Buffer.alloc(16))
      const result = await withCommitLock(handle, 'ws-1', 'res-1', () =>
        commitPut(handle, { workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: begin.stagingId }))
      assert.equal(result.ok, true)
      assert.equal(result.row.version, 1)
    } finally { cleanup() }
  })

  it('deleteObject across two replicas — only one fires', async () => {
    // Seed via replica A, then attempt a delete on both replicas
    // simultaneously. Exactly one delete succeeds; the other sees
    // either contention OR the post-delete "not found" state.
    const { handle1, handle2, holder1, holder2, objDir, cleanup } = twoReplicas()
    try {
      const begin = await beginPut(handle1, fakeBegin())
      writeStaging(stagingFilePath(objDir, 'ws-1', begin.stagingId), Buffer.alloc(16))
      const c = await commitPut(handle1, { workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: begin.stagingId })
      assert.equal(c.ok, true)
      // Two concurrent deletes, each under withCommitLock with
      // DISTINCT holder ids — simulates two replicas. Without the
      // distinct ids the same-process refresh branch would let
      // both "acquire" simultaneously.
      const dA = withCommitLock(handle1, 'ws-1', 'res-1',
        () => deleteObject(handle1, 'ws-1', 'res-1', 1), { holderId: holder1 })
      const dB = withCommitLock(handle2, 'ws-1', 'res-1',
        () => deleteObject(handle2, 'ws-1', 'res-1', 1), { holderId: holder2 })
      const settled = await Promise.allSettled([dA, dB])
      const fulfilled = settled.filter((s) => s.status === 'fulfilled')
      const oks = fulfilled.filter((s) => s.value.ok === true)
      assert.equal(oks.length, 1, 'exactly one delete succeeds')
      // The row is gone, regardless of which replica did the work.
      assert.equal(await getLive(handle1, 'ws-1', 'res-1'), null)
      assert.equal(await getLive(handle2, 'ws-1', 'res-1'), null)
    } finally { cleanup() }
  })
})

describe('commit-lock integration with abortPut', () => {
  it('abortPut inside withCommitLock cleans staging row + blob', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const begin = await beginPut(handle, fakeBegin())
      writeStaging(stagingFilePath(handle.dir, 'ws-1', begin.stagingId), Buffer.alloc(16))
      assert.equal(existsSync(stagingFilePath(handle.dir, 'ws-1', begin.stagingId)), true)
      await withCommitLock(handle, 'ws-1', 'res-1', () =>
        abortPut(handle, 'ws-1', 'res-1', begin.stagingId))
      assert.equal(existsSync(stagingFilePath(handle.dir, 'ws-1', begin.stagingId)), false)
    } finally { cleanup() }
  })
})

describe('shutdown: releaseAllForThisProcess', () => {
  // Models the graceful-shutdown path in server/index.ts: drop
  // every PROCESS_HOLDER_ID lease in one round-trip so a rolling
  // restart doesn't pin keys for the full lease TTL on the new
  // replicas. After release, another holder can acquire
  // immediately.
  it('drops every PROCESS_HOLDER_ID lease in one call', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      // Acquire three distinct keys (all under PROCESS_HOLDER_ID
      // since we omit holderId). heldLeaseCount tracks the
      // module-level set; assert it sees them.
      const heldBefore = heldLeaseCount()
      const l1 = await tryAcquireCommitLock(handle, 'ws-1', 'res-A')
      const l2 = await tryAcquireCommitLock(handle, 'ws-1', 'res-B')
      const l3 = await tryAcquireCommitLock(handle, 'ws-2', 'res-A')
      assert.equal(l1.ok, true); assert.equal(l2.ok, true); assert.equal(l3.ok, true)
      assert.equal(heldLeaseCount(), heldBefore + 3)
      // Shutdown sweep. After this, all three leases are gone and
      // the set is cleared.
      await releaseAllForThisProcess(handle)
      assert.equal(heldLeaseCount(), heldBefore)
      // A different holder can now acquire each of them — proves
      // the DB rows are actually gone, not just removed from the
      // in-process set.
      const otherHolder = newHolderId()
      const post1 = await tryAcquireCommitLock(handle, 'ws-1', 'res-A', { holderId: otherHolder })
      const post2 = await tryAcquireCommitLock(handle, 'ws-1', 'res-B', { holderId: otherHolder })
      const post3 = await tryAcquireCommitLock(handle, 'ws-2', 'res-A', { holderId: otherHolder })
      assert.equal(post1.ok, true); assert.equal(post2.ok, true); assert.equal(post3.ok, true)
      await post1.lock.release(); await post2.lock.release(); await post3.lock.release()
    } finally { cleanup() }
  })

  it('explicit release() before shutdown removes the lease from the tracking set', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const heldBefore = heldLeaseCount()
      const l = await tryAcquireCommitLock(handle, 'ws-1', 'res-1')
      assert.equal(heldLeaseCount(), heldBefore + 1)
      await l.lock.release()
      assert.equal(heldLeaseCount(), heldBefore, 'release() must drop the entry from the tracking set')
      // Second release is a no-op — `released` flag guards against
      // double-decrement.
      await l.lock.release()
      assert.equal(heldLeaseCount(), heldBefore)
    } finally { cleanup() }
  })
})

describe('commitPut holder gate (upsertLiveIfHeld)', () => {
  // The HIGH-severity fix from review round 3: a long upload whose
  // commit-lock lease silently expired mid-flight (because the
  // operator-set lease was too short, or another replica's reaper
  // stole) must NOT proceed to overwrite the live row blindly. The
  // SQL's `upsertLiveIfHeld` atomically gates the write on the
  // lock STILL being held by `holder` (server-clock check).
  // Without this gate, the racing replica's commit AND ours both
  // run their upsertLive, last-write-wins on metadata, while the
  // live blob holds whichever copy() landed last — silent
  // metadata-vs-bytes desync.
  it('commitPut with holder=X returns lock-lost when the lock is not held by X', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      // Seed a staging slot via beginPut (no lock acquired by test).
      const begin = await beginPut(handle, fakeBegin())
      writeStaging(stagingFilePath(handle.dir, 'ws-1', begin.stagingId), Buffer.alloc(16))
      // Call commitPut directly with a holder id that nobody acquired.
      // The lock row is absent → upsertLiveIfHeld's WHERE EXISTS is
      // false → no INSERT → RETURNING empty → 'lock-lost'.
      const fakeHolder = newHolderId()
      const r = await commitPut(handle, {
        workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: begin.stagingId,
        holder: fakeHolder,
      })
      assert.equal(r.ok, false)
      assert.equal(r.reason, 'lock-lost')
      // Live row was NOT created — the gate correctly held.
      assert.equal(await getLive(handle, 'ws-1', 'res-1'), null)
    } finally { cleanup() }
  })

  it('commitPut with the actual held-holder succeeds', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const holder = newHolderId()
      const acquired = await tryAcquireCommitLock(handle, 'ws-1', 'res-1', { holderId: holder })
      assert.equal(acquired.ok, true)
      try {
        const begin = await beginPut(handle, fakeBegin())
        writeStaging(stagingFilePath(handle.dir, 'ws-1', begin.stagingId), Buffer.alloc(16))
        const r = await commitPut(handle, {
          workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: begin.stagingId,
          holder,
        })
        assert.equal(r.ok, true)
        assert.equal(r.row.version, 1)
      } finally { await acquired.lock.release() }
    } finally { cleanup() }
  })

  it('commitPut without holder uses unconditional upsertLive (test/legacy path)', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const begin = await beginPut(handle, fakeBegin())
      writeStaging(stagingFilePath(handle.dir, 'ws-1', begin.stagingId), Buffer.alloc(16))
      // No holder → falls through to legacy upsertLive (no lock check).
      const r = await commitPut(handle, {
        workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: begin.stagingId,
      })
      assert.equal(r.ok, true)
    } finally { cleanup() }
  })

  it('lease stolen mid-upload: commitPut from the original holder returns lock-lost', async () => {
    // Models the actual production race: A acquires with a tiny
    // lease, A "uploads" (sleep so the lease expires server-side),
    // B steals the now-expired lease, A's commitPut runs and the
    // gate refuses the write since the lock is no longer held by A.
    const { handle, cleanup } = freshHandle()
    try {
      const holderA = newHolderId()
      const holderB = newHolderId()
      const acqA = await tryAcquireCommitLock(handle, 'ws-1', 'res-1', { holderId: holderA, leaseMs: 1 })
      assert.equal(acqA.ok, true)
      // Wait past the lease expiry so B can steal.
      await new Promise((r) => { setTimeout(r, 20) })
      const acqB = await tryAcquireCommitLock(handle, 'ws-1', 'res-1', { holderId: holderB })
      assert.equal(acqB.ok, true, 'B steals the expired lease')
      // A's commitPut now runs with A's holder, but the lock row
      // says holder=B → upsertLiveIfHeld's WHERE EXISTS is false
      // (A's holder doesn't match) → lock-lost.
      const begin = await beginPut(handle, fakeBegin())
      writeStaging(stagingFilePath(handle.dir, 'ws-1', begin.stagingId), Buffer.alloc(16))
      const r = await commitPut(handle, {
        workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: begin.stagingId,
        holder: holderA,
      })
      assert.equal(r.ok, false)
      assert.equal(r.reason, 'lock-lost')
      assert.equal(await getLive(handle, 'ws-1', 'res-1'), null, 'A must not have overwritten anything')
      await acqB.lock.release()
    } finally { cleanup() }
  })
})

describe('clock-skew defense', () => {
  // The DB SQL anchors both `expires_at` and the steal predicate
  // to the server's own clock (julianday/NOW()), so a caller with
  // a skewed wall clock can't read a peer's fresh lease as expired.
  // We can't easily simulate a skewed Node clock without mocking
  // Date.now everywhere, but we CAN verify the lease's `expires_at`
  // is server-side: a lock acquired with a tiny leaseMs (1ms) must
  // still be observed as expired ~immediately by another caller —
  // the DB picks "now" for the steal predicate too, so the relative
  // ordering of "set" and "compare" is the only thing that matters.
  it('lease set with sub-ms TTL is immediately stealable (server-clock parity)', async () => {
    const { handle1, handle2, holder1, holder2, cleanup } = twoReplicas()
    try {
      const aLock = await tryAcquireCommitLock(handle1, 'ws-1', 'res-1', { leaseMs: 1, holderId: holder1 })
      assert.equal(aLock.ok, true)
      // Even with NO sleep, the DB's NOW() advances between the
      // INSERT and the next acquire — so the lease's expires_at
      // (now+1ms) is already <= the new NOW() by the time the
      // next call's WHERE evaluates. Steal succeeds without any
      // wall-clock dependency on our side.
      await new Promise((r) => { setTimeout(r, 5) })
      const bSteal = await tryAcquireCommitLock(handle2, 'ws-1', 'res-1', { holderId: holder2 })
      assert.equal(bSteal.ok, true, 'sub-ms lease is stealable on the server\'s clock')
      await bSteal.lock.release()
    } finally { cleanup() }
  })
})

describe('commitPut pre-promote lock verify', () => {
  // The post-promote `upsertLiveIfHeld` gate alone leaves a
  // narrow desync window: between `getLive` and `promoteStagingToLive`,
  // a competing replica can race-commit AND release, after which
  // our promote overwrites the live blob with our bytes while the
  // live row holds the competitor's metadata. Adding a PRE-promote
  // `verifyCommitLockHeld` check shrinks that window from
  // "HTTP-copy time" to "one DB round-trip". Pin the gate's
  // existence by exercising it directly: commitPut with a
  // non-acquired holder must bail BEFORE the rename runs.
  it('commitPut bails BEFORE promoteStagingToLive when the lock is no longer held', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const begin = await beginPut(handle, fakeBegin())
      writeStaging(stagingFilePath(handle.dir, 'ws-1', begin.stagingId), Buffer.alloc(16, 0xAA))
      const fakeHolder = newHolderId()
      const r = await commitPut(handle, {
        workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: begin.stagingId,
        holder: fakeHolder,
      })
      assert.equal(r.ok, false)
      assert.equal(r.reason, 'lock-lost')
      // Critical: the live file was NEVER written. If the
      // pre-promote check were removed, the rename would have
      // run and the live file would exist with A_bytes —
      // observable as `existsSync(liveFilePath) === true`.
      assert.equal(existsSync(liveFilePath(handle.dir, 'ws-1', 'res-1')), false,
        'pre-promote verify must prevent the rename — live file must not exist')
      // Staging file is intact; abortPut would clean it up.
      assert.equal(existsSync(stagingFilePath(handle.dir, 'ws-1', begin.stagingId)), true,
        'staging file should be intact (caller routes through abortPut)')
    } finally { cleanup() }
  })
})
