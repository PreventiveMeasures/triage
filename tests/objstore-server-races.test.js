// Race-condition + complex-scenario tests for `server/objstore/`.
//
// Sibling of tests/server-objstore.test.js (which pins the core
// happy-path + single-event semantics). This file targets the
// concurrency surface: per-resource lock isolation, reaper × put ×
// delete interleavings, delete-then-recreate cycles, and the
// (workspace_tag, resource_tag, staging_id) tuple integrity that
// keeps a stagingId minted under one resource from being usable
// against another.
//
// User data is the priority: anywhere a race could promote a
// truncated upload, drop a live row whose file still exists (or
// vice-versa), or let a fresh commit's bytes get unlinked, we want
// an assertion. The reaper is the most subtle piece — it runs
// asynchronously, holds the per-resource lock only briefly per
// candidate, and must never unlink a file the live row points at.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  MAX_RESOURCES_PER_WORKSPACE,
  STAGING_TTL_MS_DEFAULT,
  abortPut,
  beginPut,
  commitPut,
  deleteObject,
  getLive,
  listLive,
  lockKey,
  openObjstore,
} from '../server/objstore/store.ts'
import { liveFilePath, stagingFilePath, unlinkIfExists } from '../server/objstore/fs.ts'
import { reapOrphans } from '../server/objstore/reaper.ts'

let counter = 0
function freshHandle() {
  const dir = mkdtempSync(path.join(tmpdir(), `deepview-obj-races-${++counter}-`))
  const db = new DatabaseSync(path.join(dir, 'data.db'))
  const objDir = path.join(dir, 'objstore')
  const handle = openObjstore(db, objDir)
  return {
    handle,
    objDir,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

// 32-byte b64url (CONTENT_HASH_RE — 43 chars)
function b64u32() { return 'a'.repeat(43) }
// 64-byte b64url (SIG_RE — 86 chars)
function b64u64() { return 'a'.repeat(86) }

function fakeBegin(over = {}) {
  return {
    workspaceTag: 'ws-1',
    resourceTag: 'res-1',
    prevVersion: null,
    expectedLength: 16,
    contentHash: b64u32(),
    signature: b64u64(),
    ...over,
  }
}

function writeStaging(filePath, bytes) {
  const fd = openSync(filePath, 'a')
  try { writeSync(fd, bytes) } finally { closeSync(fd) }
}

// Wrap a beginPut + body-write + commit triple under the per-resource
// lock to mimic the production REST PUT path. Returns the commit
// result. Bytes default to a buffer of `expectedLength` zeros.
async function lockedPut(handle, input, bytes) {
  const key = lockKey(input.workspaceTag, input.resourceTag)
  const begin = await handle.lock.run(key, () => beginPut(handle, input))
  if (!begin.ok) return begin
  writeStaging(begin.filePath, bytes ?? Buffer.alloc(input.expectedLength))
  return handle.lock.run(key, () => commitPut(handle, {
    workspaceTag: input.workspaceTag,
    resourceTag: input.resourceTag,
    stagingId: begin.stagingId,
  }))
}

// Convenience: locked deleteObject.
function lockedDelete(handle, tag, res, prev) {
  return handle.lock.run(lockKey(tag, res), () => deleteObject(handle, tag, res, prev))
}

describe('lock isolation: many concurrent puts on distinct resources', () => {
  // The per-resource lock keys on (workspaceTag, resourceTag). If two
  // puts on DIFFERENT resources somehow contended on the same lock
  // (e.g. someone keyed on workspaceTag alone), throughput would
  // collapse and the ordering would be observable in the version
  // ladder. Here we fire N puts in parallel and check every one
  // committed to version 1 without a single conflict — proves keys
  // are distinct and the lock map handles concurrent acquisitions.
  it('MAX_RESOURCES_PER_WORKSPACE different resources commit in parallel without conflicts', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      // Right up to the cap — derive bounds from the constant so a
      // future tweak to the cap doesn't quietly break this test.
      const ops = []
      for (let i = 0; i < MAX_RESOURCES_PER_WORKSPACE; i++) {
        const tag = `r-${i.toString().padStart(4, '0')}`
        ops.push(lockedPut(handle, fakeBegin({ resourceTag: tag, expectedLength: 4 }), Buffer.alloc(4)))
      }
      const results = await Promise.all(ops)
      for (let i = 0; i < MAX_RESOURCES_PER_WORKSPACE; i++) {
        assert.equal(results[i].ok, true, `commit ${i} should succeed`)
        assert.equal(results[i].row.version, 1, `commit ${i} should be v1`)
      }
      assert.equal((await listLive(handle, 'ws-1')).length, MAX_RESOURCES_PER_WORKSPACE)
      // The lock map should drain back to 0 once nothing's in flight.
      assert.equal(handle.lock.size, 0, 'lock map GCs after all in-flight ops complete')
    } finally { cleanup() }
  })

  it('100 different resources across 4 workspaces — no cross-workspace contention', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const ops = []
      for (let i = 0; i < 100; i++) {
        const ws = `ws-${i % 4}`
        const tag = `r-${i.toString().padStart(4, '0')}`
        ops.push(lockedPut(handle, fakeBegin({ workspaceTag: ws, resourceTag: tag, expectedLength: 4 }), Buffer.alloc(4)))
      }
      const results = await Promise.all(ops)
      for (const r of results) assert.equal(r.ok, true)
      for (let w = 0; w < 4; w++) {
        // 25 resources per workspace, each at v1.
        const live = await listLive(handle, `ws-${w}`)
        assert.equal(live.length, 25)
      }
    } finally { cleanup() }
  })
})

describe('lock serialisation: many concurrent commits on the SAME resource', () => {
  // 20 concurrent racers, all begin against `prevVersion=null`. Under
  // the lock, exactly one upserts the live row to v1; the other 19
  // hit the precondition recheck inside `commitPut` and fail with
  // `conflict`. None should silently land at v1 on top of the
  // winner's bytes, none should produce a row with version > 1
  // when only one PUT actually succeeded.
  it('20 concurrent commits — exactly one wins, rest see conflict, only winner bytes are live', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const N = 20
      // Each racer writes a unique 8-byte payload so we can identify
      // the winner from the live file's bytes.
      const inputs = Array.from({ length: N }, (_, i) => ({
        ...fakeBegin({ resourceTag: 'race', expectedLength: 8 }),
        racerId: i,
        bytes: Buffer.from(`RACE${i.toString().padStart(4, '0')}`),
      }))
      const results = await Promise.all(inputs.map(async (input) => {
        const r = await lockedPut(handle, input, input.bytes)
        return { ...r, racerId: input.racerId, bytes: input.bytes }
      }))
      const winners = results.filter((r) => r.ok)
      const losers = results.filter((r) => !r.ok)
      assert.equal(winners.length, 1, 'exactly one PUT must win')
      assert.equal(losers.length, N - 1, `${N - 1} PUTs must lose`)
      for (const loser of losers) {
        assert.equal(loser.reason, 'conflict', 'loser must report conflict, not size-mismatch or no-staging')
      }
      // Live row is v1 (NOT v20 / not the sum-of-attempts).
      const live = await getLive(handle, 'ws-1', 'race')
      assert.equal(live?.version, 1, 'only one upsert landed — version stays at 1')
      // Live FILE contains the WINNER's bytes — losers' bytes were
      // staged + abandoned, never promoted via rename.
      const onDisk = readFileSync(liveFilePath(objDir, 'ws-1', 'race'))
      assert.equal(Buffer.compare(onDisk, winners[0].bytes), 0, 'live file bytes match the winner')
    } finally { cleanup() }
  })

  it('long chain: 10 sequential put-with-correct-prevVersion → version increments cleanly to 10', async () => {
    // Sequential happy-path version ladder. Inserted because the
    // race tests above don't pin the linear-update case where every
    // commit IS supposed to succeed.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      let lastVer = null
      let lastBytes = null
      for (let i = 1; i <= 10; i++) {
        const bytes = Buffer.from(`v${i}-${'x'.repeat(8 - String(i).length)}`)
        const r = await lockedPut(
          handle,
          fakeBegin({ resourceTag: 'chain', expectedLength: bytes.byteLength, prevVersion: lastVer }),
          bytes,
        )
        assert.equal(r.ok, true)
        assert.equal(r.row.version, i)
        lastVer = i
        lastBytes = bytes
      }
      // Live file contains v10's bytes specifically.
      const onDisk = readFileSync(liveFilePath(objDir, 'ws-1', 'chain'))
      assert.equal(Buffer.compare(onDisk, lastBytes), 0)
    } finally { cleanup() }
  })
})

describe('(ws, res, sid) tuple integrity — stagingIds are scoped', () => {
  // The (workspace_tag, resource_tag, staging_id) primary key means a
  // stagingId minted for resource R1 cannot be used to commit against
  // resource R2 (the staging-row lookup fails). Same across
  // workspaces. Without this, a confused-deputy commit could splice
  // bytes from one PUT into another resource's live row.
  it('commit with sid from a DIFFERENT resource → no-staging (cross-resource)', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ resourceTag: 'r-real', expectedLength: 4 }))
      writeStaging(b.filePath, Buffer.alloc(4))
      // Use the staging file (which is fine) but ask to commit it as
      // a DIFFERENT resource — the SELECT keyed on (ws, res, sid)
      // returns nothing, so no-staging is the reply.
      const wrongRes = await commitPut(handle, {
        workspaceTag: 'ws-1', resourceTag: 'r-other', stagingId: b.stagingId,
      })
      assert.equal(wrongRes.ok, false)
      assert.equal(wrongRes.reason, 'no-staging')
      // Sanity: the right (ws, res, sid) tuple still commits cleanly,
      // proving the wrongRes failure was the lookup mismatch, not
      // some side effect we accidentally caused.
      const rightRes = await commitPut(handle, {
        workspaceTag: 'ws-1', resourceTag: 'r-real', stagingId: b.stagingId,
      })
      assert.equal(rightRes.ok, true)
      assert.equal(rightRes.row.version, 1)
    } finally { cleanup() }
  })

  it('commit with sid from a DIFFERENT workspace → no-staging (cross-workspace)', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ workspaceTag: 'ws-A', resourceTag: 'r-1', expectedLength: 4 }))
      writeStaging(b.filePath, Buffer.alloc(4))
      const otherWs = await commitPut(handle, {
        workspaceTag: 'ws-B', resourceTag: 'r-1', stagingId: b.stagingId,
      })
      assert.equal(otherWs.ok, false)
      assert.equal(otherWs.reason, 'no-staging')
    } finally { cleanup() }
  })

  it('abortPut with sid from a DIFFERENT resource leaves the original staging row intact', async () => {
    // PR #4 review pattern: abort is keyed on (ws, res, sid). An
    // accidental abort against the wrong resourceTag must not drop
    // the legitimate row. (The on-disk file is unlinked because
    // abort's file-path is built from (ws, sid) only — but that's
    // the documented contract: the file unlinks idempotently and
    // the next commit would fail io-error. The ROW is the integrity
    // sentinel here.)
    const { handle, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ resourceTag: 'r-real', expectedLength: 4 }))
      writeStaging(b.filePath, Buffer.alloc(4))
      // Abort against the wrong resourceTag.
      await abortPut(handle, 'ws-1', 'r-other', b.stagingId)
      // The legitimate row is untouched.
      const row = await handle.selectStaging.get('ws-1', 'r-real', b.stagingId)
      assert.ok(row, 'staging row keyed on (ws, r-real, sid) survives an abort against (ws, r-other, sid)')
    } finally { cleanup() }
  })

  it('two concurrent identical commits for the SAME (ws, res, sid) — exactly one succeeds, the other gets no-staging', async () => {
    // Models the deduplicated-request case where the same token
    // commit is issued twice in parallel (NOT the in-flight HTTP
    // dedup that rest.ts owns — here it's direct DB-level). The
    // first commit drops the staging row; the second's SELECT
    // misses → no-staging.
    const { handle, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ expectedLength: 4 }))
      writeStaging(b.filePath, Buffer.alloc(4))
      const key = lockKey('ws-1', 'res-1')
      const commit = () => handle.lock.run(key, () => commitPut(handle, {
        workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: b.stagingId,
      }))
      const [c1, c2] = await Promise.all([commit(), commit()])
      const oks = [c1, c2].filter((c) => c.ok)
      const nons = [c1, c2].filter((c) => !c.ok && c.reason === 'no-staging')
      assert.equal(oks.length, 1, 'exactly one commit succeeds')
      assert.equal(nons.length, 1, 'the other sees no-staging (row already consumed)')
    } finally { cleanup() }
  })
})

describe('delete-then-recreate (the user-data scenario)', () => {
  // The fragile path: a resource is deleted, then re-added under the
  // SAME resourceTag. Server-side this is a brand-new row at v1, not
  // a resurrection. The file on disk for the new incarnation must
  // contain ONLY the new bytes; no echo of the deleted predecessor
  // can leak through.
  it('delete then put-fresh under same tag → live file holds NEW bytes only', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const original = Buffer.from('ORIGINAL-BYTES-32B'.padEnd(32, 'X'))
      const replacement = Buffer.from('REPLACEMENT-BYTES-32B'.padEnd(32, 'Y'))
      const r1 = await lockedPut(handle, fakeBegin({ resourceTag: 'recycled', expectedLength: 32 }), original)
      assert.equal(r1.ok, true)
      assert.equal(r1.row.version, 1)
      // Delete the live row.
      const d = await lockedDelete(handle, 'ws-1', 'recycled', 1)
      assert.equal(d.ok, true)
      // File is gone (delete unlinked it inline).
      assert.equal(existsSync(liveFilePath(objDir, 'ws-1', 'recycled')), false)
      // Re-put under the same tag, prev=null (must-not-exist gate).
      const r2 = await lockedPut(handle, fakeBegin({ resourceTag: 'recycled', expectedLength: 32 }), replacement)
      assert.equal(r2.ok, true)
      assert.equal(r2.row.version, 1, 'new incarnation starts back at v1 (no tombstone)')
      // Live file holds the replacement bytes — never the original.
      const onDisk = readFileSync(liveFilePath(objDir, 'ws-1', 'recycled'))
      assert.equal(Buffer.compare(onDisk, replacement), 0)
      assert.equal(onDisk.indexOf('ORIGINAL'), -1, 'no leak of the deleted predecessor')
    } finally { cleanup() }
  })

  it('delete-recreate loop × 20 cycles — every cycle isolates bytes; version resets to 1 each time', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      for (let cycle = 0; cycle < 20; cycle++) {
        const bytes = Buffer.from(`CYCLE-${cycle.toString().padStart(4, '0')}-${'z'.repeat(16)}`)
        const r = await lockedPut(handle, fakeBegin({ resourceTag: 'flip', expectedLength: bytes.byteLength }), bytes)
        assert.equal(r.ok, true)
        assert.equal(r.row.version, 1, `cycle ${cycle}: version always 1 after delete+recreate`)
        // Verify bytes match this cycle's payload exactly.
        const onDisk = readFileSync(liveFilePath(objDir, 'ws-1', 'flip'))
        assert.equal(Buffer.compare(onDisk, bytes), 0, `cycle ${cycle}: live bytes match this cycle's payload`)
        const d = await lockedDelete(handle, 'ws-1', 'flip', 1)
        assert.equal(d.ok, true)
      }
    } finally { cleanup() }
  })

  it('mid-cycle interleave: delete arrives between two commit phases on the same resource', async () => {
    // Resource exists at v1. Begin a v2 put-attempt (under lock,
    // releases lock). Body writes (no lock). Before commit acquires
    // the lock, a DELETE lands and drops the row + file. The
    // commit's precondition-recheck (inside lock) sees no row;
    // staging.prev_version is 1 but live is null → conflict. The
    // row STAYS deleted; v2 bytes never become live.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Seed v1.
      const v1 = Buffer.from('v1-content-staying-around')
      const r1 = await lockedPut(handle, fakeBegin({ resourceTag: 'mid', expectedLength: v1.byteLength }), v1)
      assert.equal(r1.ok, true)
      // Begin v2 (lock held briefly).
      const begin = await handle.lock.run(lockKey('ws-1', 'mid'), () => beginPut(handle, fakeBegin({
        resourceTag: 'mid', prevVersion: 1, expectedLength: 4,
      })))
      assert.equal(begin.ok, true)
      writeStaging(begin.filePath, Buffer.alloc(4))
      // Interleave: DELETE the v1 row.
      const d = await lockedDelete(handle, 'ws-1', 'mid', 1)
      assert.equal(d.ok, true)
      assert.equal(existsSync(liveFilePath(objDir, 'ws-1', 'mid')), false)
      // Now commit v2. Inside the lock, getLive returns null and the
      // staging row's prev_version = 1 — mismatch → conflict.
      const c = await handle.lock.run(lockKey('ws-1', 'mid'), () => commitPut(handle, {
        workspaceTag: 'ws-1', resourceTag: 'mid', stagingId: begin.stagingId,
      }))
      assert.equal(c.ok, false)
      assert.equal(c.reason, 'conflict')
      // No live row, no live file. The delete won, the v2 attempt lost.
      assert.equal(await getLive(handle, 'ws-1', 'mid'), null)
      assert.equal(existsSync(liveFilePath(objDir, 'ws-1', 'mid')), false)
      // Cleanup the abandoned staging.
      await abortPut(handle, 'ws-1', 'mid', begin.stagingId)
    } finally { cleanup() }
  })

  it('many concurrent peers each doing delete-then-recreate cycles — final state is consistent (no partial bytes)', async () => {
    // The lock guarantee: a delete under lock unlinks v1's file
    // INSIDE the lock; any concurrent begin/commit for the same
    // resource queues behind. If the lock leaked, a commit could
    // rename a NEW staging file over the OLD live path while the
    // delete's unlink raced — leaving us with either no file or
    // the new file unlinked seconds later. We model the chaos by
    // running 10 concurrent "peers" each doing a delete-then-put
    // cycle. The final invariant: any surviving file's bytes are
    // byte-for-byte equal to one of the known payloads (NEVER a
    // mix or a truncation).
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Both payloads have the SAME byte length so a length-based
      // sanity check is meaningful: any surviving live row's
      // content_length must match whichever bytes are on disk.
      const seed = Buffer.from('SEED-PAYLOAD-XYZ12')   // 18 bytes
      const fresh = Buffer.from('FRESH-PAYLOAD-AB99')  // 18 bytes
      assert.equal(seed.byteLength, fresh.byteLength)
      await lockedPut(handle, fakeBegin({ resourceTag: 'churn', expectedLength: seed.byteLength }), seed)
      const cycles = []
      for (let i = 0; i < 10; i++) {
        cycles.push((async () => {
          // Read current version (may already be gone if a peer
          // deleted between our check and now). Best-effort delete
          // against whatever version we saw, then unconditional
          // attempt to write `fresh`. Both helpers RETURN result
          // objects (not throw) on the legitimate race outcomes
          // (conflict / not-found / no-staging), so no catch is
          // needed — any rejection here is a real defect and
          // should fail the test loudly.
          const live = await getLive(handle, 'ws-1', 'churn')
          if (live) await lockedDelete(handle, 'ws-1', 'churn', live.version)
          return lockedPut(
            handle,
            fakeBegin({ resourceTag: 'churn', expectedLength: fresh.byteLength }),
            fresh,
          )
        })())
      }
      await Promise.all(cycles)
      // Invariant: surviving file matches a KNOWN payload byte-for-byte.
      // Either:
      //  - the seed survived (no cycle's delete-then-put landed cleanly),
      //  - or some cycle's recreate landed → file is `fresh`,
      //  - or the row was deleted last → no file.
      const live = await getLive(handle, 'ws-1', 'churn')
      if (live) {
        assert.equal(live.version, 1, 'live row is v1 (seed v1 or fresh-incarnation v1)')
        assert.equal(live.contentLength, 18, 'declared length matches both known payloads')
        const onDisk = readFileSync(liveFilePath(objDir, 'ws-1', 'churn'))
        assert.equal(onDisk.byteLength, 18, 'on-disk size matches declared length')
        const matchesFresh = Buffer.compare(onDisk, fresh) === 0
        const matchesSeed = Buffer.compare(onDisk, seed) === 0
        assert.ok(
          matchesFresh || matchesSeed,
          `live bytes must be byte-for-byte one of {seed, fresh} — never partial. got: ${onDisk.toString()}`,
        )
      } else {
        assert.equal(
          existsSync(liveFilePath(objDir, 'ws-1', 'churn')),
          false,
          'absent row implies absent file (delete is symmetric)',
        )
      }
    } finally { cleanup() }
  })
})

describe('reaper × concurrent ops — never unlink a live file', () => {
  // The reaper's most-dangerous failure mode is unlinking a file
  // that a live row points at. The fix is a per-resource lock +
  // re-check of `selectLiveOne` inside the lock. These tests fire
  // real concurrent operations (not just hand-acquired locks) and
  // confirm the live file survives.
  it('reaper running concurrent with a delete-then-put cycle preserves the recreate file', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Seed: put + reap (no orphans yet).
      const original = Buffer.from('reap-orig-bytes')
      await lockedPut(handle, fakeBegin({ resourceTag: 'reap-race', expectedLength: original.byteLength }), original)
      // Cycle: delete + recreate + reap, all kicked together so the
      // reaper's snapshot is racing the row-state changes.
      const replacement = Buffer.from('reap-replacement-x')
      const [, , reapResult] = await Promise.all([
        lockedDelete(handle, 'ws-1', 'reap-race', 1),
        lockedPut(handle, fakeBegin({ resourceTag: 'reap-race', expectedLength: replacement.byteLength }), replacement),
        reapOrphans(handle),
      ])
      // The recreate may have raced ahead of the delete (in which
      // case the conflict resolution drops one of them) or behind it
      // (in which case both succeed sequentially). Either way the
      // INVARIANT is: a surviving live row has its file intact.
      const live = await getLive(handle, 'ws-1', 'reap-race')
      if (live) {
        const onDisk = readFileSync(liveFilePath(objDir, 'ws-1', 'reap-race'))
        assert.equal(onDisk.byteLength, live.contentLength, 'live row content_length matches on-disk size')
      } else {
        // No row → no live file (either delete cleaned it or reaper
        // legitimately swept a stranded `.bin`).
        assert.equal(existsSync(liveFilePath(objDir, 'ws-1', 'reap-race')), false)
      }
      void reapResult
    } finally { cleanup() }
  })

  it('reaper while many puts on different resources are mid-flight: zero collateral unlinks', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const N = 30
      // Pre-commit half of them so the reaper has something to walk
      // past. Leave the other half running concurrently with reap.
      const seeded = []
      for (let i = 0; i < N / 2; i++) {
        const t = `r-${i.toString().padStart(4, '0')}`
        await lockedPut(handle, fakeBegin({ resourceTag: t, expectedLength: 4 }), Buffer.alloc(4))
        seeded.push(t)
      }
      // Now race: live-table reaper + N/2 concurrent puts.
      const inflight = []
      for (let i = N / 2; i < N; i++) {
        const t = `r-${i.toString().padStart(4, '0')}`
        inflight.push(lockedPut(handle, fakeBegin({ resourceTag: t, expectedLength: 4 }), Buffer.alloc(4)))
      }
      const reaps = [reapOrphans(handle), reapOrphans(handle), reapOrphans(handle)]
      await Promise.all([...inflight, ...reaps])
      // Every seeded resource still has its file.
      for (const t of seeded) {
        assert.equal(existsSync(liveFilePath(objDir, 'ws-1', t)), true, `seeded resource ${t} file survives reap`)
      }
      // Every in-flight commit landed successfully too.
      for (const r of inflight) {
        const result = await r
        assert.equal(result.ok, true, 'in-flight put landed despite concurrent reapers')
      }
      const live = await listLive(handle, 'ws-1')
      assert.equal(live.length, N, `all ${N} live rows present`)
    } finally { cleanup() }
  })

  it('multiple concurrent reaper sweeps run safely (idempotent, no missing files)', async () => {
    // The init.ts wrapper guards concurrent sweeps with an
    // `inFlight` Promise. The reaper module itself has no such
    // guard — so parallel calls hit readdir/unlink concurrently.
    // Each per-resource unlink is itself ENOENT-tolerant, so two
    // sweeps trying to unlink the same stranded file must both
    // return cleanly (one wins, the other sees ENOENT). We assert
    // the ENOENT-tolerance by running 5 reapers in parallel and
    // checking the cleanup is correct.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Manufacture 20 stranded files (committed → row deleted).
      for (let i = 0; i < 20; i++) {
        const t = `strand-${i}`
        await lockedPut(handle, fakeBegin({ resourceTag: t, expectedLength: 4 }), Buffer.alloc(4))
        // Direct row drop — simulates a delete that crashed pre-unlink.
        handle.db.prepare('DELETE FROM workspace_object WHERE workspace_tag = ? AND resource_tag = ?').run('ws-1', t)
      }
      // Files exist on disk.
      for (let i = 0; i < 20; i++) {
        assert.equal(existsSync(liveFilePath(objDir, 'ws-1', `strand-${i}`)), true)
      }
      // Run 5 reapers concurrently — they should not throw.
      await Promise.all([
        reapOrphans(handle), reapOrphans(handle), reapOrphans(handle),
        reapOrphans(handle), reapOrphans(handle),
      ])
      // All stranded files gone.
      for (let i = 0; i < 20; i++) {
        assert.equal(existsSync(liveFilePath(objDir, 'ws-1', `strand-${i}`)), false, `stranded file strand-${i} reaped`)
      }
    } finally { cleanup() }
  })

  it('reaper preserves a foreign file in the workspace dir (operator-seeded, non-base64url name)', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Manufacture a workspace dir without going through beginPut
      // so the dir exists for the reaper to walk.
      const wsDir = path.join(objDir, 'ws-1')
      mkdirSync(path.join(wsDir, '.staging'), { recursive: true })
      // Drop a foreign file with a non-`.bin` extension — won't
      // happen via the public API but operator paste or external-
      // tool can produce it. The reaper's `name.endsWith('.bin')`
      // gate is the guard.
      const foreign = path.join(wsDir, 'NOT-bin-file.txt')
      writeFileSync(foreign, 'preserve me')
      // And a `.bin` whose basename's resourceTag fails
      // `isValidTag` — `+` is outside the base64url alphabet.
      const invalidName = path.join(wsDir, 'bad+resource.bin')
      writeFileSync(invalidName, 'also preserve me — invalid base64url name')
      await reapOrphans(handle)
      assert.equal(existsSync(foreign), true, 'non-.bin foreign file preserved')
      assert.equal(existsSync(invalidName), true, '.bin with non-base64url name preserved (defensive)')
    } finally { cleanup() }
  })

  it('reaper preserves a `.staging/*.bin` whose name fails staging-id validation', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const stagingDir = path.join(objDir, 'ws-1', '.staging')
      mkdirSync(stagingDir, { recursive: true })
      // Wrong length: sid must be exactly 22 chars (`{22}` in
      // STAGING_ID_RE); 30 fails the length gate.
      const wrongLen = path.join(stagingDir, 'a'.repeat(30) + '.bin')
      writeFileSync(wrongLen, 'preserve me')
      // Wrong charset: `+` is outside the base64url alphabet
      // (`[\w-]` = `[A-Za-z0-9_-]`). 22-char basename so length
      // alone passes, but the charset check fires.
      const wrongCharset = path.join(stagingDir, 'bad+charsXXXXXXXXXXXXX.bin')
      writeFileSync(wrongCharset, 'keep')
      await reapOrphans(handle)
      assert.equal(existsSync(wrongLen), true, 'malformed-length .staging .bin preserved (defensive)')
      assert.equal(existsSync(wrongCharset), true, 'malformed-charset .staging .bin preserved (defensive)')
    } finally { cleanup() }
  })

  it('reaper handles a workspace dir with ONLY a `.staging` subdir (no .bin) — no errors', async () => {
    // Edge case: a workspace whose only artefact is an in-flight
    // staging row (so the `.staging` dir exists, but no committed
    // `.bin` files at the top level).
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ resourceTag: 'staging-only', expectedLength: 8 }))
      writeStaging(b.filePath, Buffer.alloc(8))
      // No commit yet.
      // Workspace dir has only `.staging` — listLiveTags returns []
      // (no live rows), but the dir exists from beginPut's mkdir.
      await reapOrphans(handle)
      // Staging file + row are well within TTL, both preserved.
      assert.equal(existsSync(b.filePath), true)
      // Now commit and re-reap — file should still survive.
      const c = await commitPut(handle, {
        workspaceTag: 'ws-1', resourceTag: 'staging-only', stagingId: b.stagingId,
      })
      assert.equal(c.ok, true)
      await reapOrphans(handle)
      assert.equal(existsSync(liveFilePath(objDir, 'ws-1', 'staging-only')), true)
    } finally { cleanup() }
  })

  it('reaper handles an empty workspace dir (no .staging, no .bin)', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      mkdirSync(path.join(objDir, 'ws-empty'), { recursive: true })
      // Just an empty dir, no .staging.
      await reapOrphans(handle)
      // Survives without error; dir is preserved (reaper doesn't
      // rmdir).
      assert.equal(existsSync(path.join(objDir, 'ws-empty')), true)
    } finally { cleanup() }
  })

  it('reaper handles a totally empty objDir (no workspaces yet)', async () => {
    // Boot-time race: reaper kicks before any client has registered.
    const { handle, cleanup } = freshHandle()
    try {
      // objDir exists (mkdirSync at openObjstore) but no content.
      await reapOrphans(handle)
      // No throw — that's the invariant.
    } finally { cleanup() }
  })
})

describe('reaper × delete-then-recreate (the danger zone)', () => {
  // Subtle: a reaper snapshot taken just before a delete sees live
  // R. The delete drops the row + unlinks the file. Then a fresh
  // begin+commit lands a NEW file at the canonical path. If the
  // reaper relied solely on its pre-snapshot live set without re-
  // checking under the lock, it would see "R wasn't supposed to be
  // here at snapshot time" and unlink the freshly-committed file.
  // The fix: per-resource lock + selectLiveOne re-check.
  it('snapshot-before-delete: a recreate landing during reap is preserved', async () => {
    // We model the "snapshot before delete" by pre-acquiring the
    // lock under our test driver. The reaper queues behind on the
    // lock; while we hold it, we delete + recreate manually (DB +
    // FS at-the-row level). When we release, the reaper's inside-
    // lock re-check sees a live row and skips the unlink — even
    // though its pre-snapshot saw "no R row" at that moment.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Seed R v1 so reapCommittedForTag actually iterates ws-1.
      await lockedPut(handle, fakeBegin({ resourceTag: 'other', expectedLength: 4 }), Buffer.alloc(4))
      // Pre-acquire the lock on R, hold it.
      let release
      const held = handle.lock.run(lockKey('ws-1', 'R'), () => new Promise((r) => { release = r }))
      // Manufacture the pre-existing condition: drop a stranded
      // `.bin` for R at the live path, no row. This is the shape
      // reapCommittedForTag is supposed to find and unlink.
      const stranded = liveFilePath(objDir, 'ws-1', 'R')
      writeFileSync(stranded, 'STRANDED-PRE-RECREATE')
      // Kick reapOrphans. It will:
      //   - listLiveTags → [ws-1]
      //   - reapCommittedForTag(ws-1) → selectLive → [other], NOT R
      //   - sees R.bin on disk, queues for lock on (ws-1, R)
      const sweep = reapOrphans(handle)
      await new Promise((r) => { setImmediate(r) }) // yield to reaper
      // While we hold the lock, simulate the recreate landing INSIDE
      // the lock (which is what production commitPut + delete do).
      // We overwrite the stranded file with the "fresh" recreate
      // bytes and insert a live row.
      const fresh = Buffer.from('FRESH-RECREATE-BYTES')
      writeFileSync(stranded, fresh)
      handle.db.prepare(`
        INSERT INTO workspace_object
          (workspace_tag, resource_tag, version, content_hash, content_length,
           signature, put_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('ws-1', 'R', 1, b64u32(), fresh.byteLength, b64u64(), Date.now())
      release()
      await held
      await sweep
      // The fresh file MUST survive — reaper's inside-lock recheck
      // saw the row and bailed.
      assert.equal(existsSync(stranded), true, 'reaper must not unlink a file whose recreate row landed mid-sweep')
      const onDisk = readFileSync(stranded)
      assert.equal(Buffer.compare(onDisk, fresh), 0, 'fresh bytes preserved')
      const row = handle.db.prepare('SELECT 1 FROM workspace_object WHERE workspace_tag = ? AND resource_tag = ?').get('ws-1', 'R')
      assert.ok(row)
    } finally { cleanup() }
  })

  it('rapid delete-recreate cycle while reaper sweeps periodically — no data loss across 50 reaps', async () => {
    // Stress version: run many delete+recreate cycles while
    // reapOrphans fires in parallel. After all cycles complete,
    // every "final state" survives — either the row is gone (last
    // op was delete) or the row + file are intact (last op was put).
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // 12 distinct resources, each cycling 5 times.
      const cycles = []
      for (let r = 0; r < 12; r++) {
        const tag = `cycle-${r}`
        cycles.push((async () => {
          let lastPut = null
          for (let c = 0; c < 5; c++) {
            const bytes = Buffer.from(`r${r}-c${c}-${'p'.repeat(8)}`)
            const put = await lockedPut(
              handle,
              fakeBegin({ resourceTag: tag, expectedLength: bytes.byteLength }),
              bytes,
            )
            if (put.ok) lastPut = { put, bytes }
            // lockedDelete returns a result object on every
            // outcome (ok / not-found / conflict); no catch needed.
            await lockedDelete(handle, 'ws-1', tag, put.ok ? put.row.version : null)
          }
          // Final put — leaves the resource at v1.
          const finalBytes = Buffer.from(`r${r}-final-${'q'.repeat(8)}`)
          const finalPut = await lockedPut(
            handle,
            fakeBegin({ resourceTag: tag, expectedLength: finalBytes.byteLength }),
            finalBytes,
          )
          return { tag, finalPut, finalBytes, lastPut }
        })())
      }
      // 50 parallel reapers — guarantees overlap with every cycle.
      const reapers = []
      for (let i = 0; i < 50; i++) reapers.push(reapOrphans(handle))
      const [cycleResults] = await Promise.all([Promise.all(cycles), Promise.all(reapers)])
      // Every final put landed and its file holds the final bytes.
      for (const { tag, finalPut, finalBytes } of cycleResults) {
        assert.equal(finalPut.ok, true, `final put for ${tag} succeeded`)
        const onDisk = readFileSync(liveFilePath(objDir, 'ws-1', tag))
        assert.equal(Buffer.compare(onDisk, finalBytes), 0, `${tag}: final bytes intact despite reapers`)
      }
      // Live row count matches resources × 1 (final put = v1 fresh
      // incarnation after a delete in each cycle).
      const live = await listLive(handle, 'ws-1')
      assert.equal(live.length, 12)
    } finally { cleanup() }
  })

  it('reaper does NOT reap a `.bin` whose row landed AFTER reapCommittedForTag began iterating', async () => {
    // The reaper iterates `readdir` entries and for each not-in-snapshot
    // queues on the lock. A commit landing between readdir and the
    // lock acquire could land its row WITHOUT the file (yet). When the
    // reaper's lock-recheck runs, the row IS there → skip. Good.
    // The dangerous case is the converse: a commit landing the file
    // (via rename) BEFORE its row — but commitPut order is
    // rename-then-upsert, so the file lands first. Bad if reaper
    // sees the new file in readdir, queues on the lock, the commit's
    // upsertLive hasn't run yet at the time reaper enters its lock
    // block. Production: the rename is INSIDE the lock, so the
    // reaper can't enter the lock block until commitPut releases —
    // by which time the row exists. We pin this ordering by holding
    // the lock and simulating the same sequence.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Pre-acquire lock for R.
      let release
      const held = handle.lock.run(lockKey('ws-1', 'R'), () => new Promise((r) => { release = r }))
      // Drop a `.bin` for R at the live path (pretending a rename
      // just landed it INSIDE this lock — production commitPut runs
      // the rename here).
      const livePath = liveFilePath(objDir, 'ws-1', 'R')
      mkdirSync(path.dirname(livePath), { recursive: true })
      writeFileSync(livePath, 'just-renamed-here')
      // Kick reaper. It snapshots live tags (none — workspace was
      // empty before we wrote the file via writeFileSync). It won't
      // see ws-1 in liveTags. The top-level walk DOES find ws-1 dir
      // and processes the .bin there, queuing on the lock.
      const sweep = reapOrphans(handle)
      await new Promise((r) => { setImmediate(r) })
      // Insert the live row (production commitPut's upsertLive,
      // also INSIDE the lock).
      handle.db.prepare(`
        INSERT INTO workspace_object
          (workspace_tag, resource_tag, version, content_hash, content_length,
           signature, put_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('ws-1', 'R', 1, b64u32(), 'just-renamed-here'.length, b64u64(), Date.now())
      release()
      await held
      await sweep
      // The file survives.
      assert.equal(existsSync(livePath), true)
      assert.equal(readFileSync(livePath, 'utf8'), 'just-renamed-here')
    } finally { cleanup() }
  })
})

describe('abortPut idempotency + races', () => {
  it('abortPut concurrent with the reaper unlinking the same file is safe', async () => {
    // The reaper's orphan-staging sweep finds files whose row is
    // missing. If a concurrent abortPut already unlinked the file
    // (ENOENT), the reaper's `unlinkIfExists` MUST tolerate it. We
    // pre-drop the row to manufacture the orphan, then race
    // abortPut + reapOrphans on the same staging file.
    const { handle, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ expectedLength: 8 }))
      writeStaging(b.filePath, Buffer.alloc(8))
      // Drop the row — file becomes an orphan from the reaper's POV.
      // abortPut still finds the file (no row to consult) and unlinks.
      // Delete by the full PK `(workspace_tag, resource_tag,
      // staging_id)` so a future schema collision can't silently
      // affect multiple rows.
      handle.db.prepare(
        'DELETE FROM workspace_object_staging WHERE workspace_tag = ? AND resource_tag = ? AND staging_id = ?',
      ).run('ws-1', 'res-1', b.stagingId)
      const [_, __] = await Promise.all([
        abortPut(handle, 'ws-1', 'res-1', b.stagingId),
        reapOrphans(handle),
      ])
      void _; void __
      // File is gone (one of the two unlinked it; the other got
      // ENOENT and didn't throw).
      assert.equal(existsSync(b.filePath), false)
    } finally { cleanup() }
  })

  it('abortPut on a never-existed (ws, res, sid) tuple is a safe no-op', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      // 16 random bytes b64url'd → 22 chars; canonical sid shape.
      await abortPut(handle, 'ws-never', 'res-never', 'a'.repeat(22))
      // No throw — that's the invariant. No row was created either.
      const row = handle.db.prepare('SELECT COUNT(*) AS c FROM workspace_object_staging').get()
      assert.equal(row.c, 0)
    } finally { cleanup() }
  })

  it('abortPut after the row was already abortPut\'d: still idempotent', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin())
      writeStaging(b.filePath, Buffer.alloc(16))
      await abortPut(handle, 'ws-1', 'res-1', b.stagingId)
      assert.equal(existsSync(b.filePath), false)
      // Second abort — same call, file already gone, row already gone.
      await abortPut(handle, 'ws-1', 'res-1', b.stagingId)
    } finally { cleanup() }
  })
})

describe('deleteObject idempotency + races', () => {
  it('two concurrent deleteObject(prev=N) calls on the same row → one succeeds, one not-found', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      await lockedPut(handle, fakeBegin({ expectedLength: 4 }), Buffer.alloc(4))
      const [d1, d2] = await Promise.all([
        lockedDelete(handle, 'ws-1', 'res-1', 1),
        lockedDelete(handle, 'ws-1', 'res-1', 1),
      ])
      // The lock serialises them. The first sees v1 and drops; the
      // second sees missing row + prev=1 → not-found.
      const oks = [d1, d2].filter((d) => d.ok)
      const nfs = [d1, d2].filter((d) => !d.ok && d.reason === 'not-found')
      assert.equal(oks.length, 1, 'one delete actually drops the row')
      assert.equal(nfs.length, 1, 'the other sees not-found')
    } finally { cleanup() }
  })

  it('two concurrent deleteObject(prev=null) calls — at-most-one drops, the other ack-zero', async () => {
    // prev=null on a missing row is the idempotent-ack-zero path.
    // On an existing row prev=null is a conflict.
    const { handle, cleanup } = freshHandle()
    try {
      await lockedPut(handle, fakeBegin({ expectedLength: 4 }), Buffer.alloc(4))
      const [d1, d2] = await Promise.all([
        lockedDelete(handle, 'ws-1', 'res-1', null),
        lockedDelete(handle, 'ws-1', 'res-1', null),
      ])
      // Both see the row at the start of their lock-block — both
      // conflict (prev=null !== 1). Neither succeeds; the row
      // survives.
      assert.equal(d1.ok, false); assert.equal(d1.reason, 'conflict')
      assert.equal(d2.ok, false); assert.equal(d2.reason, 'conflict')
      const live = await getLive(handle, 'ws-1', 'res-1')
      assert.ok(live, 'row survives — neither prev=null delete should drop an existing row')
    } finally { cleanup() }
  })

  it('deleteObject(prev=null) on a missing row twice in a row — both ack zero', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const d1 = await deleteObject(handle, 'ws-1', 'res-1', null)
      const d2 = await deleteObject(handle, 'ws-1', 'res-1', null)
      assert.equal(d1.ok, true); assert.equal(d1.deletedVersion, 0)
      assert.equal(d2.ok, true); assert.equal(d2.deletedVersion, 0)
    } finally { cleanup() }
  })

  it('deleteObject DB-row drop happens BEFORE file unlink: a crash between leaves the file (reaper-cleaned)', async () => {
    // The commit/delete asymmetry doc in store.ts:
    //   DELETE:   DB write → unlink (best-effort; ENOENT ok)
    // A crash between the DB write and the unlink leaves the file
    // stranded — reaper sweep picks it up. We manufacture the crash
    // by replacing handle.deleteLive with a wrapper that runs the
    // SQL but skips the unlink path, then assert the reaper cleans up.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ resourceTag: 'will-strand', expectedLength: 4 }))
      writeStaging(b.filePath, Buffer.alloc(4))
      await commitPut(handle, { workspaceTag: 'ws-1', resourceTag: 'will-strand', stagingId: b.stagingId })
      const live = liveFilePath(objDir, 'ws-1', 'will-strand')
      assert.equal(existsSync(live), true)
      // Simulate "crashed before unlink": drop row directly via the
      // DB, don't unlink.
      handle.db.prepare('DELETE FROM workspace_object WHERE workspace_tag = ? AND resource_tag = ?').run('ws-1', 'will-strand')
      assert.equal(existsSync(live), true, 'file lingers when DB row drop happens but unlink crashed')
      // Reaper cleans up.
      await reapOrphans(handle)
      assert.equal(existsSync(live), false, 'reaper unlinks the stranded committed file')
    } finally { cleanup() }
  })
})

describe('commitPut size + truncation defenses', () => {
  it('staged file LARGER than expected → size-mismatch (over-size is not silently accepted)', async () => {
    // The truncation invariant test in server-objstore.test.js
    // covers the under-size case. The over-size case is the inverse
    // — Node's HTTP parser usually rejects at the wire, but a
    // buggy proxy or direct DB-fixture write could produce it.
    const { handle, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ expectedLength: 10 }))
      // Write MORE than the signed length.
      writeStaging(b.filePath, Buffer.alloc(20))
      const c = await commitPut(handle, {
        workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: b.stagingId,
      })
      assert.equal(c.ok, false)
      assert.equal(c.reason, 'size-mismatch')
      assert.equal(await getLive(handle, 'ws-1', 'res-1'), null)
    } finally { cleanup() }
  })

  it('staged file with EXACTLY the right size commits to a row whose contentLength reports staged size', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ expectedLength: 12345 }))
      writeStaging(b.filePath, Buffer.alloc(12345))
      const c = await commitPut(handle, {
        workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: b.stagingId,
      })
      assert.equal(c.ok, true)
      assert.equal(c.row.contentLength, 12345)
      const live = await getLive(handle, 'ws-1', 'res-1')
      assert.equal(live.contentLength, 12345)
    } finally { cleanup() }
  })
})

describe('listLive consistency under concurrent writes', () => {
  it('listLive reflects every committed row; never a half-state showing some-but-not-all of a multi-resource commit batch', async () => {
    // Fire 20 commits on distinct resources, run listLive
    // concurrently with them at multiple points, then once they
    // all settle. The final list MUST contain every committed
    // resource. Intermediate calls may show partial states (any
    // prefix is acceptable) but never a wrong total.
    const { handle, cleanup } = freshHandle()
    try {
      const N = 20
      const commits = []
      for (let i = 0; i < N; i++) {
        const t = `r-${i.toString().padStart(4, '0')}`
        commits.push(lockedPut(handle, fakeBegin({ resourceTag: t, expectedLength: 4 }), Buffer.alloc(4)))
      }
      // Fire several listLive calls interleaved.
      const lists = []
      for (let i = 0; i < 5; i++) lists.push(listLive(handle, 'ws-1'))
      const [commitResults, listResults] = await Promise.all([
        Promise.all(commits), Promise.all(lists),
      ])
      // Every commit OK.
      for (const c of commitResults) assert.equal(c.ok, true)
      // Each intermediate list is a subset of the final state — no
      // duplicates, no wrong resourceTags.
      const expectedTags = new Set(
        Array.from({ length: N }, (_, i) => `r-${i.toString().padStart(4, '0')}`),
      )
      for (const list of listResults) {
        for (const r of list) {
          assert.equal(expectedTags.has(r.resourceTag), true, `unexpected tag ${r.resourceTag} in interim list`)
          assert.equal(r.version, 1)
        }
      }
      // Final list (after all commits drained) has the full set.
      const final = await listLive(handle, 'ws-1')
      assert.equal(final.length, N)
      assert.deepEqual(final.map((r) => r.resourceTag).toSorted(), [...expectedTags].toSorted())
    } finally { cleanup() }
  })
})

describe('lock GC after many concurrent ops', () => {
  // After every op completes, refs drop to 0 and the entry is
  // deleted from the map. A leak here would grow `handle.lock.size`
  // by total-resources-ever-seen, eventually OOM'ing a long-running
  // server. The KeyedAsyncLock test in server-objstore.test.js
  // covers a single op; this is the stress version.
  it('lock map drains to 0 after 100 concurrent commits on 100 distinct keys', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const ops = []
      for (let i = 0; i < 100; i++) {
        const t = `r-${i.toString().padStart(4, '0')}`
        ops.push(lockedPut(handle, fakeBegin({ resourceTag: t, expectedLength: 4 }), Buffer.alloc(4)))
      }
      await Promise.all(ops)
      assert.equal(handle.lock.size, 0)
    } finally { cleanup() }
  })

  it('lock map drains even when ops reject (commitPut conflicts)', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      // 5 concurrent puts on the SAME resource — 4 will reject.
      const ops = []
      for (let i = 0; i < 5; i++) {
        ops.push(lockedPut(handle, fakeBegin({ resourceTag: 'one', expectedLength: 4 }), Buffer.alloc(4)))
      }
      const results = await Promise.all(ops)
      const ok = results.filter((r) => r.ok).length
      const conflict = results.filter((r) => !r.ok && r.reason === 'conflict').length
      assert.equal(ok, 1)
      assert.equal(conflict, 4)
      assert.equal(handle.lock.size, 0, 'rejected ops still release their lock entry')
    } finally { cleanup() }
  })
})

describe('reaper at scale', () => {
  it('100 stranded files across 4 workspaces — single reapOrphans sweep cleans them all', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Set up 25 stranded files per workspace × 4 workspaces.
      const stranded = []
      for (let w = 0; w < 4; w++) {
        const ws = `ws-${w}`
        for (let r = 0; r < 25; r++) {
          const tag = `r-${w}-${r.toString().padStart(4, '0')}`
          const b = await beginPut(handle, fakeBegin({ workspaceTag: ws, resourceTag: tag, expectedLength: 4 }))
          writeStaging(b.filePath, Buffer.alloc(4))
          await commitPut(handle, { workspaceTag: ws, resourceTag: tag, stagingId: b.stagingId })
          // Drop row → file becomes stranded.
          handle.db.prepare('DELETE FROM workspace_object WHERE workspace_tag = ? AND resource_tag = ?').run(ws, tag)
          stranded.push(liveFilePath(objDir, ws, tag))
        }
      }
      for (const f of stranded) assert.equal(existsSync(f), true)
      await reapOrphans(handle)
      for (const f of stranded) assert.equal(existsSync(f), false, `stranded ${f} cleaned`)
    } finally { cleanup() }
  })

  it('mixed state: stranded committed files + stale staging rows + fresh in-flight rows — reaper distinguishes correctly', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // 3 stranded committed files (drop-row simulating crashed delete).
      const stranded = []
      for (let i = 0; i < 3; i++) {
        const t = `stranded-${i}`
        const b = await beginPut(handle, fakeBegin({ resourceTag: t, expectedLength: 4 }))
        writeStaging(b.filePath, Buffer.alloc(4))
        await commitPut(handle, { workspaceTag: 'ws-1', resourceTag: t, stagingId: b.stagingId })
        handle.db.prepare('DELETE FROM workspace_object WHERE workspace_tag = ? AND resource_tag = ?').run('ws-1', t)
        stranded.push(liveFilePath(objDir, 'ws-1', t))
      }
      // 3 stale staging rows (backdated begun_at).
      const staleStaging = []
      for (let i = 0; i < 3; i++) {
        const t = `stale-${i}`
        const b = await beginPut(handle, fakeBegin({ resourceTag: t, expectedLength: 8 }))
        writeStaging(b.filePath, Buffer.alloc(8))
        handle.db.prepare('UPDATE workspace_object_staging SET begun_at = ? WHERE staging_id = ?').run(
          Date.now() - 2 * 60 * 60 * 1000, b.stagingId,
        )
        staleStaging.push({ tag: t, sid: b.stagingId, path: b.filePath })
      }
      // 3 fresh in-flight staging rows (begun NOW, well within TTL).
      const freshStaging = []
      for (let i = 0; i < 3; i++) {
        const t = `fresh-${i}`
        const b = await beginPut(handle, fakeBegin({ resourceTag: t, expectedLength: 8 }))
        writeStaging(b.filePath, Buffer.alloc(8))
        freshStaging.push({ tag: t, sid: b.stagingId, path: b.filePath })
      }
      // 3 fully-committed live rows (no reap needed).
      const live = []
      for (let i = 0; i < 3; i++) {
        const t = `live-${i}`
        const r = await lockedPut(handle, fakeBegin({ resourceTag: t, expectedLength: 16 }), Buffer.alloc(16))
        assert.equal(r.ok, true)
        live.push(liveFilePath(objDir, 'ws-1', t))
      }
      await reapOrphans(handle)
      // Stranded files cleaned.
      for (const f of stranded) assert.equal(existsSync(f), false, `stranded ${f} cleaned`)
      // Stale staging cleaned (file + row).
      for (const { tag, sid, path: p } of staleStaging) {
        assert.equal(existsSync(p), false, `stale staging file ${tag} cleaned`)
        const row = handle.db.prepare('SELECT 1 FROM workspace_object_staging WHERE staging_id = ?').get(sid)
        assert.equal(row, undefined, `stale staging row ${tag} dropped`)
      }
      // Fresh staging preserved.
      for (const { tag, sid, path: p } of freshStaging) {
        assert.equal(existsSync(p), true, `fresh staging file ${tag} preserved`)
        const row = handle.db.prepare('SELECT 1 FROM workspace_object_staging WHERE staging_id = ?').get(sid)
        assert.ok(row, `fresh staging row ${tag} preserved`)
      }
      // Live files preserved.
      for (const f of live) assert.equal(existsSync(f), true, `live ${f} preserved`)
    } finally { cleanup() }
  })

  it('reaper across many workspaces — top-level walk discovers tag dirs not in liveTags snapshot', async () => {
    // Workspace-with-no-rows: the listLiveTags query won't surface
    // it, but the on-disk dir might still contain stranded `.bin`
    // files from a since-deleted incarnation. The top-level walk
    // post-listLiveTags catches this.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Stranded file in a workspace WITHOUT any live rows. Manually
      // create the dir + file; reaper's top-level walk should pick
      // it up even though listLiveTags returns nothing for ws-empty.
      const wsDir = path.join(objDir, 'ws-empty')
      mkdirSync(wsDir, { recursive: true })
      const stranded = path.join(wsDir, 'stray-resource.bin')
      writeFileSync(stranded, 'stranded-from-deleted-workspace')
      await reapOrphans(handle)
      assert.equal(existsSync(stranded), false, 'top-level walk catches files in workspaces with no live rows')
    } finally { cleanup() }
  })
})

describe('staging file management — paths and lifecycles', () => {
  it('two beginPuts for the same resourceTag get DIFFERENT stagingIds (no collision)', async () => {
    // The same scenario as the truncation-invariant test pins, here
    // re-pinned as a concurrent-pair so the random sid generation
    // is exercised in parallel.
    const { handle, cleanup } = freshHandle()
    try {
      const [b1, b2] = await Promise.all([
        beginPut(handle, fakeBegin({ expectedLength: 4 })),
        beginPut(handle, fakeBegin({ expectedLength: 4 })),
      ])
      assert.notEqual(b1.stagingId, b2.stagingId)
      assert.notEqual(b1.filePath, b2.filePath)
    } finally { cleanup() }
  })

  it('staging files persist across abortPut of a sibling stagingId on the same resource', async () => {
    // Two concurrent attempts: abort one, keep the other staged.
    // The unkept staging's file MUST survive — abortPut keys on
    // (ws, res, sid), not just (ws, res).
    const { handle, cleanup } = freshHandle()
    try {
      const b1 = await beginPut(handle, fakeBegin({ expectedLength: 8 }))
      const b2 = await beginPut(handle, fakeBegin({ expectedLength: 8 }))
      writeStaging(b1.filePath, Buffer.alloc(8))
      writeStaging(b2.filePath, Buffer.alloc(8))
      await abortPut(handle, 'ws-1', 'res-1', b1.stagingId)
      // b2's file + row untouched.
      assert.equal(existsSync(b1.filePath), false)
      assert.equal(existsSync(b2.filePath), true)
      const row2 = await handle.selectStaging.get('ws-1', 'res-1', b2.stagingId)
      assert.ok(row2)
      // Commit b2 and confirm it lands cleanly.
      const c = await commitPut(handle, { workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: b2.stagingId })
      assert.equal(c.ok, true)
    } finally { cleanup() }
  })
})

describe('cap enforcement under concurrent NEW resources', () => {
  // The cap is enforced under the per-resource lock. Under heavy
  // concurrent NEW-resource creation, transient over-shoot is
  // documented and bounded — but the BIG INVARIANT (eventually
  // settles at ≤ MAX_RESOURCES_PER_WORKSPACE + a small race window
  // per the docstring) needs holding.
  it.todo('99 already-live + 10 concurrent new-resource begins: cap should be strict (currently overshoots up to (parallel-1))', async () => {
    // OBSERVATION: the cap check (`count >= MAX`) lives inside the
    // per-resource lock — but per-resource locks are keyed on
    // (workspaceTag, resourceTag), not on workspaceTag alone. Ten
    // concurrent begins for NEW resources each hold a DIFFERENT
    // lock, so their `selectLive.all + count + insert` races. The
    // store.ts docstring documents this as accepted: "transient
    // over-shoot under high concurrency across DIFFERENT resources
    // is bounded by (parallel new-resource begins - 1) and is
    // accepted (the cap is a soft policy bound, not a security
    // invariant)".
    //
    // SHOULD-BE: the cap is a cap. With 99 already-live + 10
    // concurrent begins, exactly 1 should land and 9 should be
    // rejected with `workspace-full`. The current "soft policy" is
    // a description of the bug, not a justification.
    //
    // FIX HINT: introduce a per-workspaceTag lock (or use a SQLite
    // transaction with appropriate isolation) so the count + insert
    // are atomic across NEW-resource creation for the same workspace.
    //
    // IMPACT: a holder of the seed could grow `workspace_object`
    // past MAX_RESOURCES_PER_WORKSPACE by deliberately spawning
    // concurrent begins. The docstring calls this "not a security
    // invariant" — which is true — but it still means the cap
    // doesn't quite mean what it says.
    const { handle, cleanup } = freshHandle()
    try {
      for (let i = 0; i < MAX_RESOURCES_PER_WORKSPACE - 1; i++) {
        const t = `r-${i.toString().padStart(4, '0')}`
        await lockedPut(handle, fakeBegin({ resourceTag: t, expectedLength: 4 }), Buffer.alloc(4))
      }
      assert.equal((await listLive(handle, 'ws-1')).length, MAX_RESOURCES_PER_WORKSPACE - 1)
      const newOps = []
      for (let i = 0; i < 10; i++) {
        const t = `n-${i}`
        newOps.push(lockedPut(handle, fakeBegin({ resourceTag: t, expectedLength: 4 }), Buffer.alloc(4)))
      }
      const results = await Promise.all(newOps)
      const oks = results.filter((r) => r.ok).length
      // SHOULD-BE: exactly 1 lands; 9 rejected. Currently can be up
      // to 10 (full overshoot).
      assert.equal(oks, 1, 'cap should be strict: exactly one of 10 concurrent NEW begins lands when 99 already live')
      const finalCount = (await listLive(handle, 'ws-1')).length
      assert.equal(finalCount, MAX_RESOURCES_PER_WORKSPACE, 'final live count is exactly the cap')
    } finally { cleanup() }
  })

  it('update at the cap (re-upload of existing resource) always succeeds, regardless of concurrent attempts', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      // Fill to the cap.
      for (let i = 0; i < MAX_RESOURCES_PER_WORKSPACE; i++) {
        const t = `r-${i.toString().padStart(4, '0')}`
        await lockedPut(handle, fakeBegin({ resourceTag: t, expectedLength: 4 }), Buffer.alloc(4))
      }
      // Fire 5 concurrent updates on existing rows — should all
      // succeed (cap check skipped for existing resource).
      const updates = []
      for (let i = 0; i < 5; i++) {
        const t = `r-${i.toString().padStart(4, '0')}`
        updates.push(lockedPut(handle, fakeBegin({ resourceTag: t, prevVersion: 1, expectedLength: 8 }), Buffer.alloc(8)))
      }
      const results = await Promise.all(updates)
      for (const r of results) {
        assert.equal(r.ok, true, 'update at cap should always succeed (no count change)')
        assert.equal(r.row.version, 2)
      }
      // Live count unchanged.
      assert.equal((await listLive(handle, 'ws-1')).length, MAX_RESOURCES_PER_WORKSPACE)
    } finally { cleanup() }
  })
})

describe('reaper × stale-staging × refresh — F1/H4 corner cases', () => {
  it('refresh inside the commit lock prevents reaper from reaping a fresh upload', async () => {
    // Replays the production sequence:
    //   1. beginPut → row inserted (begun_at = NOW)
    //   2. (REST PUT body takes a LONG time, hand-aged begun_at)
    //   3. Reaper sees stale row, queues for the lock
    //   4. commit acquires the lock first; INSIDE the lock:
    //      refreshStagingBegunAt → row's begun_at = NOW; commitPut
    //      → row dropped; row gone, file renamed to live
    //   5. Reaper enters its lock block, sees no staging row → skip
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ resourceTag: 'slow-upload', expectedLength: 8 }))
      writeStaging(b.filePath, Buffer.alloc(8))
      // Backdate begun_at past the TTL.
      handle.db.prepare('UPDATE workspace_object_staging SET begun_at = ? WHERE staging_id = ?').run(
        Date.now() - 2 * 60 * 60 * 1000, b.stagingId,
      )
      const sweep = reapOrphans(handle)
      // Mimic the production commit: under the lock, refresh + commit.
      const commit = handle.lock.run(lockKey('ws-1', 'slow-upload'), async () => {
        await handle.refreshStagingBegunAt.run(Date.now(), 'ws-1', 'slow-upload', b.stagingId)
        return commitPut(handle, { workspaceTag: 'ws-1', resourceTag: 'slow-upload', stagingId: b.stagingId })
      })
      const [c, _] = await Promise.all([commit, sweep])
      void _
      // Commit MUST succeed — the row was promoted to live before the
      // reaper got the lock; even if reaper got the lock first, the
      // refresh would have moved begun_at to NOW and the inside-lock
      // re-check would have spared the row.
      assert.equal(c.ok, true, 'fresh-upload commit succeeded despite a racing reaper sweep')
      assert.equal(c.row.version, 1)
      assert.equal(existsSync(liveFilePath(objDir, 'ws-1', 'slow-upload')), true)
    } finally { cleanup() }
  })

  it('a row that DID exceed the TTL (no refresh) and has no in-flight commit gets reaped cleanly', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ expectedLength: 8 }))
      writeStaging(b.filePath, Buffer.alloc(8))
      handle.db.prepare('UPDATE workspace_object_staging SET begun_at = ? WHERE staging_id = ?').run(
        Date.now() - 2 * 60 * 60 * 1000, b.stagingId,
      )
      await reapOrphans(handle)
      assert.equal(existsSync(b.filePath), false)
      const row = await handle.selectStaging.get('ws-1', 'res-1', b.stagingId)
      assert.equal(row, undefined)
    } finally { cleanup() }
  })

  it.todo('reaper-first F1 race: a commit whose body finished must NOT be dropped just because the reaper got the per-resource lock first', async () => {
    // OBSERVATION: round-12 moved `refreshStagingBegunAt` INSIDE the
    // commit lock. The inline comment in rest.ts claims this "closes
    // the race", but it only closes it for the COMMIT-FIRST direction.
    //
    // When the reaper acquires the lock FIRST (its `lock.run` was
    // queued before the commit's), the reaper's inside-lock
    // fresh-read SELECT runs BEFORE the commit's refresh has
    // executed (because refresh now lives inside the commit's
    // lock block). The fresh-read sees the still-stale begun_at
    // and reaps the row + file. The commit then fails with
    // `no-staging` → REST 410.
    //
    // SHOULD-BE: an upload whose body finished streaming before the
    // reaper finalised its sweep should ALWAYS land. Round-11 had
    // refresh OUTSIDE the lock — refresh ran sync against SQLite
    // BEFORE either party queued for the lock, so the reaper's
    // in-lock fresh-read always saw the updated begun_at. Moving
    // refresh back outside the lock fixes this regression.
    //
    // IMPACT: an upload that streams for > TTL (default 1 h) loses
    // its bytes if the reaper-first lock ordering happens. The
    // client gets 410 and must retry. If the client can't retry
    // (network died, app closed), the user's data is lost.
    //
    // This test simulates the reaper-first ordering deterministically
    // by having the reaper's per-row logic run BEFORE the commit
    // tries — modelling the lock-queue ordering precisely. With the
    // current code, the commit fails with `no-staging`. With the
    // intended round-12 contract (or a round-13 fix that moves
    // refresh back outside the lock), the commit should succeed.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ resourceTag: 'lose-commit', expectedLength: 8 }))
      writeStaging(b.filePath, Buffer.alloc(8))
      // Body has been streaming for hours; begun_at is now stale.
      handle.db.prepare('UPDATE workspace_object_staging SET begun_at = ? WHERE staging_id = ?').run(
        Date.now() - 2 * 60 * 60 * 1000, b.stagingId,
      )
      // Simulate reaper acquiring the lock FIRST and running its
      // in-lock reap logic (mirroring reapStaleStagingRows).
      await handle.lock.run(lockKey('ws-1', 'lose-commit'), async () => {
        const fresh = await handle.selectStaging.get('ws-1', 'lose-commit', b.stagingId)
        if (fresh && Date.now() - fresh.begun_at >= STAGING_TTL_MS_DEFAULT) {
          await unlinkIfExists(stagingFilePath(handle.dir, 'ws-1', b.stagingId))
          await handle.deleteStaging.run('ws-1', 'lose-commit', b.stagingId)
        }
      })
      // Commit attempts — production order: refresh-then-commit
      // INSIDE the lock.
      const c = await handle.lock.run(lockKey('ws-1', 'lose-commit'), async () => {
        await handle.refreshStagingBegunAt.run(Date.now(), 'ws-1', 'lose-commit', b.stagingId)
        return commitPut(handle, { workspaceTag: 'ws-1', resourceTag: 'lose-commit', stagingId: b.stagingId })
      })
      // SHOULD BE: the commit succeeds even when the reaper raced
      // for the lock first. Currently fails with `no-staging`.
      assert.equal(c.ok, true, 'an upload that finished streaming must not be lost to a racing reaper')
      assert.equal(c.row.version, 1)
      assert.equal(existsSync(liveFilePath(objDir, 'ws-1', 'lose-commit')), true)
    } finally { cleanup() }
  })

  it('reaper queued AFTER commit lock: refresh-inside-lock keeps the commit valid', async () => {
    // The companion scenario: commit acquires the lock first. The
    // reaper queues behind. Inside the lock, refresh updates
    // begun_at; commit then drops the staging row + renames to
    // live. Reaper enters its lock block, finds no staging row,
    // skips. Commit wins cleanly.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ resourceTag: 'commit-wins', expectedLength: 8 }))
      writeStaging(b.filePath, Buffer.alloc(8))
      // Hand-age begun_at.
      handle.db.prepare('UPDATE workspace_object_staging SET begun_at = ? WHERE staging_id = ?').run(
        Date.now() - 2 * 60 * 60 * 1000, b.stagingId,
      )
      // Pre-acquire the commit lock briefly so the reaper has to
      // queue behind. We release immediately after kicking the
      // reaper; the commit's actual work happens AFTER reaper
      // queues but BEFORE reaper acquires.
      const commit = handle.lock.run(lockKey('ws-1', 'commit-wins'), async () => {
        await handle.refreshStagingBegunAt.run(Date.now(), 'ws-1', 'commit-wins', b.stagingId)
        return commitPut(handle, { workspaceTag: 'ws-1', resourceTag: 'commit-wins', stagingId: b.stagingId })
      })
      // Reaper runs after, queues behind the commit.
      const sweep = reapOrphans(handle)
      const [c, _] = await Promise.all([commit, sweep])
      void _
      assert.equal(c.ok, true, 'commit lands first → success')
      assert.equal(c.row.version, 1)
      assert.equal(existsSync(liveFilePath(objDir, 'ws-1', 'commit-wins')), true)
    } finally { cleanup() }
  })
})

describe('crash-recovery / partial-state cleanup', () => {
  // The asymmetric commit/delete order documented in store.ts:
  //   PUT commit:  fsync(staging) → rename → fsync(parent) → DB write
  //   DELETE:      DB write → unlink (best-effort; ENOENT ok)
  // A crash at any point leaves at most a STRANDED FILE (reaper-
  // cleaned), never a row pointing at nothing. The tests below
  // simulate each crash point by hand-manipulating the DB +
  // filesystem and confirm the reaper cleans up.
  it('crash AFTER upsertLive but BEFORE deleteStaging leaves a stranded staging row (live OK, staging cleaned after TTL)', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // beginPut + staging file.
      const b = await beginPut(handle, fakeBegin({ resourceTag: 'half-commit', expectedLength: 8 }))
      writeStaging(b.filePath, Buffer.alloc(8))
      // Simulate commitPut's first half: rename staging → live + upsertLive,
      // SKIP the final deleteStaging (the "crash" point).
      const { durableRenameStagedToLive } = await import('../server/objstore/fs.ts')
      const livePath = liveFilePath(objDir, 'ws-1', 'half-commit')
      const renamed = await durableRenameStagedToLive(b.filePath, livePath)
      assert.equal(renamed, true)
      handle.db.prepare(`
        INSERT INTO workspace_object
          (workspace_tag, resource_tag, version, content_hash, content_length,
           signature, put_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('ws-1', 'half-commit', 1, b64u32(), 8, b64u64(), Date.now())
      // State: live row + live file OK, staging row dangling (no file).
      assert.equal(existsSync(livePath), true)
      assert.equal(existsSync(b.filePath), false, 'staging file renamed away')
      const stagingRow = await handle.selectStaging.get('ws-1', 'half-commit', b.stagingId)
      assert.ok(stagingRow, 'staging row still present (crash before deleteStaging)')
      // Hand-age the staging row past TTL.
      handle.db.prepare('UPDATE workspace_object_staging SET begun_at = ? WHERE staging_id = ?').run(
        Date.now() - 2 * 60 * 60 * 1000, b.stagingId,
      )
      // Reaper cleans the orphan row.
      await reapOrphans(handle)
      const afterReap = await handle.selectStaging.get('ws-1', 'half-commit', b.stagingId)
      assert.equal(afterReap, undefined, 'stale staging row reaped')
      // Live row + file untouched.
      assert.equal((await getLive(handle, 'ws-1', 'half-commit'))?.version, 1)
      assert.equal(existsSync(livePath), true)
    } finally { cleanup() }
  })

  it('crash AFTER DELETE\'s row-drop but BEFORE unlink: file lingers, reaper cleans', async () => {
    // Already covered above but repinned here for the "crash point"
    // narrative: this is exactly the failure mode the commit/delete
    // asymmetry was designed to bound.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ resourceTag: 'crash-del', expectedLength: 4 }))
      writeStaging(b.filePath, Buffer.alloc(4))
      await commitPut(handle, { workspaceTag: 'ws-1', resourceTag: 'crash-del', stagingId: b.stagingId })
      const livePath = liveFilePath(objDir, 'ws-1', 'crash-del')
      assert.equal(existsSync(livePath), true)
      // "Crash" between DB drop and unlink: drop row directly, skip
      // unlink.
      handle.db.prepare('DELETE FROM workspace_object WHERE workspace_tag = ? AND resource_tag = ?').run('ws-1', 'crash-del')
      assert.equal(existsSync(livePath), true, 'file still on disk after row drop')
      assert.equal(await getLive(handle, 'ws-1', 'crash-del'), null)
      // Reaper's committed-file sweep finds the orphan.
      await reapOrphans(handle)
      assert.equal(existsSync(livePath), false, 'reaper unlinks orphan')
    } finally { cleanup() }
  })

  it('multiple consecutive crash points across many resources: reaper restores consistency', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Manufacture several partial states in parallel:
      // - 5 stranded committed files (DELETE crashed before unlink)
      // - 5 stranded staging rows (commit crashed before deleteStaging)
      // - 3 healthy committed rows (no crash)
      for (let i = 0; i < 5; i++) {
        const t = `crashed-del-${i}`
        const b = await beginPut(handle, fakeBegin({ resourceTag: t, expectedLength: 4 }))
        writeStaging(b.filePath, Buffer.alloc(4))
        await commitPut(handle, { workspaceTag: 'ws-1', resourceTag: t, stagingId: b.stagingId })
        handle.db.prepare('DELETE FROM workspace_object WHERE workspace_tag = ? AND resource_tag = ?').run('ws-1', t)
      }
      for (let i = 0; i < 5; i++) {
        const t = `crashed-commit-${i}`
        const b = await beginPut(handle, fakeBegin({ resourceTag: t, expectedLength: 4 }))
        writeStaging(b.filePath, Buffer.alloc(4))
        const { durableRenameStagedToLive } = await import('../server/objstore/fs.ts')
        await durableRenameStagedToLive(b.filePath, liveFilePath(objDir, 'ws-1', t))
        handle.db.prepare(`
          INSERT INTO workspace_object
            (workspace_tag, resource_tag, version, content_hash, content_length, signature, put_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('ws-1', t, 1, b64u32(), 4, b64u64(), Date.now())
        // Don't delete the staging row → crash-point.
        // Age it past TTL.
        handle.db.prepare('UPDATE workspace_object_staging SET begun_at = ? WHERE staging_id = ?').run(
          Date.now() - 2 * 60 * 60 * 1000, b.stagingId,
        )
      }
      const healthy = []
      for (let i = 0; i < 3; i++) {
        const t = `healthy-${i}`
        await lockedPut(handle, fakeBegin({ resourceTag: t, expectedLength: 4 }), Buffer.alloc(4))
        healthy.push(t)
      }
      // Pre-reap counts: 8 live rows (5 crashed-del rows are dropped,
      // but their files linger; 5 crashed-commit have live rows but
      // dangling staging rows; 3 healthy are clean).
      assert.equal((await listLive(handle, 'ws-1')).length, 5 + 3)
      await reapOrphans(handle)
      // Stranded files (from crashed-del) cleaned.
      for (let i = 0; i < 5; i++) {
        assert.equal(existsSync(liveFilePath(objDir, 'ws-1', `crashed-del-${i}`)), false)
      }
      // Crashed-commit live rows + files intact; staging rows cleaned.
      for (let i = 0; i < 5; i++) {
        const t = `crashed-commit-${i}`
        assert.equal(existsSync(liveFilePath(objDir, 'ws-1', t)), true)
        const live = await getLive(handle, 'ws-1', t)
        assert.equal(live?.version, 1)
        // No staging row left.
        const stagingRows = handle.db.prepare('SELECT 1 FROM workspace_object_staging WHERE workspace_tag = ? AND resource_tag = ?').get('ws-1', t)
        assert.equal(stagingRows, undefined, `crashed-commit-${i}: staging row reaped`)
      }
      // Healthy untouched.
      for (const t of healthy) {
        assert.equal(existsSync(liveFilePath(objDir, 'ws-1', t)), true)
      }
    } finally { cleanup() }
  })

  it('startup-equivalent: closing + reopening the handle preserves committed rows', async () => {
    // Simulates a server restart: close the DB connection, reopen
    // with the same path. The schema-load is idempotent (CREATE IF
    // NOT EXISTS) and the live rows survive.
    const dir = mkdtempSync(path.join(tmpdir(), `deepview-obj-restart-${++counter}-`))
    try {
      const dbPath = path.join(dir, 'data.db')
      const objDir = path.join(dir, 'objstore')
      // First "boot": put a few resources.
      const db1 = new DatabaseSync(dbPath)
      const handle1 = openObjstore(db1, objDir)
      for (let i = 0; i < 5; i++) {
        const t = `survives-${i}`
        await lockedPut(handle1, fakeBegin({ resourceTag: t, expectedLength: 4 }), Buffer.alloc(4))
      }
      // "Restart": close and reopen.
      db1.close()
      const db2 = new DatabaseSync(dbPath)
      const handle2 = openObjstore(db2, objDir)
      try {
        // Live rows survive.
        const live = await listLive(handle2, 'ws-1')
        assert.equal(live.length, 5)
        for (const r of live) {
          assert.equal(r.version, 1)
          assert.equal(existsSync(liveFilePath(objDir, 'ws-1', r.resourceTag)), true)
        }
        // Reaper-equivalent startup sweep finds nothing to clean.
        await reapOrphans(handle2)
        assert.equal((await listLive(handle2, 'ws-1')).length, 5)
      } finally { db2.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('startup-equivalent: reaper-on-boot cleans stranded files from before-the-crash', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), `deepview-obj-restart-${++counter}-`))
    try {
      const dbPath = path.join(dir, 'data.db')
      const objDir = path.join(dir, 'objstore')
      const db1 = new DatabaseSync(dbPath)
      const handle1 = openObjstore(db1, objDir)
      const b = await beginPut(handle1, fakeBegin({ resourceTag: 'pre-crash', expectedLength: 4 }))
      writeStaging(b.filePath, Buffer.alloc(4))
      await commitPut(handle1, { workspaceTag: 'ws-1', resourceTag: 'pre-crash', stagingId: b.stagingId })
      // "Crash" before unlinking: drop row, leave file.
      handle1.db.prepare('DELETE FROM workspace_object WHERE workspace_tag = ? AND resource_tag = ?').run('ws-1', 'pre-crash')
      const livePath = liveFilePath(objDir, 'ws-1', 'pre-crash')
      assert.equal(existsSync(livePath), true)
      db1.close()
      // "Boot": fresh handle, startup reaper sweep.
      const db2 = new DatabaseSync(dbPath)
      const handle2 = openObjstore(db2, objDir)
      try {
        await reapOrphans(handle2)
        assert.equal(existsSync(livePath), false, 'startup reaper cleans pre-crash stranded file')
      } finally { db2.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('reaper × in-flight upload (slow streaming body)', () => {
  // The H4 / F1 protection is most visible when a body streams
  // for longer than the TTL. The refresh INSIDE the commit lock
  // restamps begun_at so the reaper's freshness re-check (also
  // inside its lock-block) sees a fresh row and bails.
  it('a row whose begun_at was refreshed inside the commit lock survives a reaper sweep', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ resourceTag: 'long-up', expectedLength: 8 }))
      writeStaging(b.filePath, Buffer.alloc(8))
      // Body has been streaming for hours — begun_at is stale.
      handle.db.prepare('UPDATE workspace_object_staging SET begun_at = ? WHERE staging_id = ?').run(
        Date.now() - 2 * 60 * 60 * 1000, b.stagingId,
      )
      // Commit acquires the lock first, refreshes inside lock, drops staging row.
      const c = await handle.lock.run(lockKey('ws-1', 'long-up'), async () => {
        await handle.refreshStagingBegunAt.run(Date.now(), 'ws-1', 'long-up', b.stagingId)
        return commitPut(handle, { workspaceTag: 'ws-1', resourceTag: 'long-up', stagingId: b.stagingId })
      })
      assert.equal(c.ok, true)
      // Reaper sweep AFTER commit: finds no staging row, finds the
      // live row + matching file — nothing to do.
      await reapOrphans(handle)
      const live = await getLive(handle, 'ws-1', 'long-up')
      assert.equal(live?.version, 1)
    } finally { cleanup() }
  })

  it('a row that is genuinely stale AND has no inflight commit is reaped', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ resourceTag: 'abandoned', expectedLength: 8 }))
      writeStaging(b.filePath, Buffer.alloc(8))
      handle.db.prepare('UPDATE workspace_object_staging SET begun_at = ? WHERE staging_id = ?').run(
        Date.now() - 2 * 60 * 60 * 1000, b.stagingId,
      )
      await reapOrphans(handle)
      assert.equal(existsSync(b.filePath), false)
      const row = await handle.selectStaging.get('ws-1', 'abandoned', b.stagingId)
      assert.equal(row, undefined)
    } finally { cleanup() }
  })
})

describe('reaper × orphan row (row stays, file gone)', () => {
  it.todo('reapOrphans should clean live rows whose file is missing (currently leaves them pointing at nothing)', async () => {
    // OBSERVATION: the inline comment in
    // `server/objstore/rest.ts handleRestGet` says of the 503
    // path:
    //
    //   "the live row is there but the file is missing / wrong
    //    size, it's a transient inconsistency the reaper will
    //    sort out — 503 (vs 404) tells the client this is a
    //    server-side state, not a 'the resource truly isn't
    //    there' answer."
    //
    // But the reaper has NO sweep for live-row-without-file. Its
    // two passes both target the inverse (committed file without
    // row; stale staging row). A row pointing at a missing file
    // persists forever; every fetch on that row returns 503.
    //
    // HOW IT HAPPENS in production:
    //   - external `rm` by an operator
    //   - filesystem corruption / disk replacement
    //   - manual recovery that drops files but not rows
    // None of these are common, but the claim "the reaper will
    // sort it out" is the part this test pins.
    //
    // SHOULD-BE: a third reaper pass that, for each live row,
    // checks its file exists at the canonical path. If missing,
    // drop the row (effectively a server-side delete — the bytes
    // are irretrievable, so the only safe recovery is to remove
    // the row and let peers PUT a fresh version).
    //
    // IMPACT: a peer that catches a corruption window gets 503
    // forever; the only recovery today is a fresh PUT (which
    // requires the peer to know the file is corrupted, which
    // they can only learn by trying to fetch). Worse, listing
    // the workspace still shows the broken resource.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Seed a normal resource.
      const r = await lockedPut(handle, fakeBegin({ resourceTag: 'broken', expectedLength: 4 }), Buffer.alloc(4))
      assert.equal(r.ok, true)
      const livePath = liveFilePath(objDir, 'ws-1', 'broken')
      assert.equal(existsSync(livePath), true)
      // Simulate the corruption window: external `rm` of the
      // committed file.
      rmSync(livePath)
      assert.equal(existsSync(livePath), false)
      // The row STILL points at it (no consistency repair happened).
      assert.ok(await getLive(handle, 'ws-1', 'broken'), 'pre-condition: row exists, file gone')
      // Reaper sweep — should remove the orphan row.
      await reapOrphans(handle)
      // SHOULD BE: row is dropped (no recovery possible from a
      // missing file; refuse to leave the user with a broken
      // listLive entry).
      assert.equal(
        await getLive(handle, 'ws-1', 'broken'),
        null,
        'reaper should drop a row whose file is missing — currently leaves the row stuck',
      )
    } finally { cleanup() }
  })
})

describe('content integrity invariants', () => {
  // Final pin: regardless of how chaotic the concurrent operations
  // are, the LIVE FILE'S BYTES match the SIGNED contentHash. This
  // is the bedrock guarantee that protects user data — without it,
  // a put could land "succeeded" with the wrong bytes on disk.
  // Indirectly enforced by the staged file's size check at commit;
  // the content hash itself is checked client-side via the AAD-
  // bound AEAD. Here we just verify the byte count + ordering.
  it('100 puts of varying sizes on distinct resources — every live file matches its row\'s content_length and the bytes we wrote', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const written = new Map()
      const ops = []
      for (let i = 0; i < 100; i++) {
        // Tag is 11 chars (`random-NNNN`). Payload starts with the
        // tag (so we can identify it from on-disk bytes) then a
        // deterministic filler. Length ranges 32B → ~4.1 KiB.
        const tag = `random-${i.toString().padStart(4, '0')}`
        const padLen = 32 + (i * 37) % 4096
        const bytes = Buffer.from(`${tag}|${'x'.repeat(padLen)}`)
        written.set(tag, bytes)
        ops.push(lockedPut(handle, fakeBegin({ resourceTag: tag, expectedLength: bytes.byteLength }), bytes))
      }
      const results = await Promise.all(ops)
      for (const r of results) assert.equal(r.ok, true)
      // Every live file's bytes match what we wrote — byte-for-byte.
      for (const [tag, bytes] of written) {
        const onDisk = readFileSync(liveFilePath(objDir, 'ws-1', tag))
        assert.equal(onDisk.byteLength, bytes.byteLength, `${tag}: size matches`)
        assert.equal(Buffer.compare(onDisk, bytes), 0, `${tag}: bytes match exactly`)
        const live = await getLive(handle, 'ws-1', tag)
        assert.equal(live.contentLength, bytes.byteLength)
      }
    } finally { cleanup() }
  })

  it('write-then-rewrite-then-fetch: only the latest bytes survive on disk (no echo of prior version)', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const v1 = Buffer.from('VERSION-1-OLD-BYTES-MUST-NOT-LEAK'.padEnd(64, '_'))
      const v2 = Buffer.from('VERSION-2-NEW-BYTES'.padEnd(64, '#'))
      const r1 = await lockedPut(handle, fakeBegin({ resourceTag: 'rew', expectedLength: 64 }), v1)
      assert.equal(r1.ok, true)
      const r2 = await lockedPut(
        handle,
        fakeBegin({ resourceTag: 'rew', prevVersion: 1, expectedLength: 64 }),
        v2,
      )
      assert.equal(r2.ok, true)
      // Re-read; only v2 bytes survive.
      const onDisk = readFileSync(liveFilePath(objDir, 'ws-1', 'rew'))
      assert.equal(Buffer.compare(onDisk, v2), 0)
      assert.equal(onDisk.indexOf('VERSION-1'), -1, 'v1 substring must not survive in v2 file')
    } finally { cleanup() }
  })

  it('size-mismatch leaves no live row and no live file — strict failure semantics', async () => {
    // Repin from existing test, but using direct disk read to be
    // explicit. After a size-mismatch, listLive must be empty AND
    // the canonical live path must not exist (no half-state).
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ expectedLength: 1024 }))
      writeStaging(b.filePath, Buffer.alloc(512)) // short
      const c = await commitPut(handle, {
        workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: b.stagingId,
      })
      assert.equal(c.ok, false)
      assert.equal(c.reason, 'size-mismatch')
      assert.equal((await listLive(handle, 'ws-1')).length, 0)
      assert.equal(existsSync(liveFilePath(objDir, 'ws-1', 'res-1')), false)
    } finally { cleanup() }
  })
})
