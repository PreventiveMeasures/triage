// Race-condition + complex-scenario tests for `server-e2e/objstore/`.
//
// Sibling of tests/server-objstore.test.js (which pins the core
// happy-path + single-event semantics). This file targets the
// concurrency surface: independent-resource isolation, reaper × put ×
// delete interleavings, delete-then-recreate cycles, and the
// (workspace_tag, resource_tag, staging_id) tuple integrity that
// keeps a stagingId minted under one resource from being usable
// against another. The objstore plane takes NO in-process lock; its
// races are resolved by the version-CAS + content-addressing + the
// reaper's atomic conditional staging delete (see server-e2e/objstore).
//
// User data is the priority: anywhere a race could promote a
// truncated upload, drop a live row whose file still exists (or
// vice-versa), or let a fresh commit's bytes get unlinked, we want
// an assertion. The reaper is the most subtle piece — it runs
// asynchronously and must never unlink a blob the live row references.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'

import {
  MAX_RESOURCES_PER_WORKSPACE,
  abortPut,
  beginPut,
  commitPut,
  deleteObject,
  getLive,
  listLive,
  openObjstore,
} from '../server-e2e/objstore/store.ts'
import { liveFilePath } from '../server-e2e/objstore/fs.ts'
import { reapOrphans } from '../server-e2e/objstore/reaper.ts'

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

// 64-byte b64url (SIG_RE — 86 chars)
function b64u64() { return 'a'.repeat(86) }

// Deterministic, valid (43-char base64url) content hash from a seed.
// Live blobs are content-addressed (`${tag}/${contentHash}.bin`), so
// keying each test payload's hash off its resourceTag gives each
// resource its own blob — mirroring the OLD per-resourceTag on-disk
// layout so the concurrency coverage carries straight over. A test
// that wants a NEW address for new bytes passes a distinct seed.
function chash(seed) { return createHash('sha256').update(String(seed)).digest('base64url') }

// Backdate a live blob's mtime so the reaper's GC grace window
// (default = STAGING_TTL_MS_DEFAULT) treats it as collectible.
// Mirrors how the staging-TTL tests backdate `begun_at`; avoids
// depending on a grace=0 edge case (fs mtime can round a just-written
// file slightly ahead of Date.now()).
function ageBlob(filePath, msAgo = 2 * 60 * 60 * 1000) {
  const t = (Date.now() - msAgo) / 1000
  utimesSync(filePath, t, t)
}

function fakeBegin(over = {}) {
  const resourceTag = over.resourceTag ?? 'res-1'
  return {
    workspaceTag: 'ws-1',
    resourceTag,
    prevVersion: null,
    prevIncarnation: null,
    expectedLength: 16,
    contentHash: chash(resourceTag),
    signature: b64u64(),
    ...over,
  }
}

function writeStaging(filePath, bytes) {
  const fd = openSync(filePath, 'a')
  try { writeSync(fd, bytes) } finally { closeSync(fd) }
}

// A beginPut + body-write + commit triple, mimicking the production
// REST PUT path. The objstore plane takes no lock anymore (the
// version-CAS arbitrates concurrent commits), so these run as direct
// calls. The name is retained from the lock era to minimise churn at
// the ~30 call sites. Returns the commit result; bytes default to a
// buffer of `expectedLength` zeros.
async function lockedPut(handle, input, bytes) {
  const begin = await beginPut(handle, input)
  if (!begin.ok) return begin
  writeStaging(begin.filePath, bytes ?? Buffer.alloc(input.expectedLength))
  return commitPut(handle, {
    workspaceTag: input.workspaceTag,
    resourceTag: input.resourceTag,
    stagingId: begin.stagingId,
  })
}

// Convenience: a direct deleteObject (no lock — see lockedPut). The
// precondition is the (version, incarnation) pair the caller observed;
// `prevIncarnation` is null iff `prev` is null (the must-not-exist /
// idempotent-ack gate), matching deleteObject's null-iff-null rule.
function lockedDelete(handle, tag, res, prev, prevIncarnation = null) {
  return deleteObject(handle, tag, res, prev, prevIncarnation)
}

describe('isolation: many concurrent puts on distinct resources', () => {
  // No lock keys on (workspaceTag, resourceTag) anymore — but the same
  // observable property must hold: N puts on DIFFERENT resources fired
  // in parallel must EACH commit to version 1 with not a single
  // conflict. Each is a fresh-write CAS against its own (tag,
  // resourceTag) slot, so they're mutually independent.
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

describe('CAS serialisation: many concurrent commits on the SAME resource', () => {
  // 20 concurrent racers, all begin against `prevVersion=null`. The
  // first-write version-CAS (`insertLiveIfAbsent`) lets exactly one
  // land the live row at v1; the other 19 find the row already present
  // → empty RETURNING → `conflict`. None should silently land at v1 on
  // top of the winner's bytes, none should produce a row with version
  // > 1 when only one PUT actually succeeded.
  it('20 concurrent commits — exactly one wins, rest see conflict, the winner row names a blob holding the winner bytes', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const N = 20
      // Each racer writes a unique 8-byte payload with a MATCHING,
      // distinct content hash — content-addressing's real invariant
      // (the hash is of the bytes). So each racer promotes to its OWN
      // immutable address; no racer clobbers another's blob (unlike the
      // old same-hash-different-bytes fixture, which only worked because
      // the lock serialised promotes to a shared path). We then prove
      // exactly one CAS winner and that its row's hash names its bytes.
      const inputs = Array.from({ length: N }, (_, i) => {
        const bytes = Buffer.from(`RACE${i.toString().padStart(4, '0')}`)
        return {
          ...fakeBegin({ resourceTag: 'race', expectedLength: 8, contentHash: chash(`race@${i}`) }),
          racerId: i,
          bytes,
        }
      })
      const results = await Promise.all(inputs.map(async (input) => {
        const r = await lockedPut(handle, input, input.bytes)
        return { ...r, racerId: input.racerId, bytes: input.bytes, hash: input.contentHash }
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
      // The live row names the WINNER's content hash, and the blob at
      // that content-addressed path holds the winner's bytes exactly.
      // Losers' blobs (distinct hashes) are unreferenced — never the
      // live row's bytes.
      assert.equal(live.contentHash, winners[0].hash, 'live row names the winner content hash')
      const onDisk = readFileSync(liveFilePath(objDir, 'ws-1', live.contentHash))
      assert.equal(Buffer.compare(onDisk, winners[0].bytes), 0, 'winner blob holds the winner bytes')
    } finally { cleanup() }
  })

  it('long chain: 10 sequential put-with-correct-prevVersion → version increments cleanly to 10', async () => {
    // Sequential happy-path version ladder. Inserted because the
    // race tests above don't pin the linear-update case where every
    // commit IS supposed to succeed.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      let lastVer = null
      let lastInc = null
      let lastBytes = null
      for (let i = 1; i <= 10; i++) {
        const bytes = Buffer.from(`v${i}-${'x'.repeat(8 - String(i).length)}`)
        const r = await lockedPut(
          handle,
          fakeBegin({ resourceTag: 'chain', expectedLength: bytes.byteLength, prevVersion: lastVer, prevIncarnation: lastInc }),
          bytes,
        )
        assert.equal(r.ok, true)
        assert.equal(r.row.version, i)
        lastVer = i
        lastInc = r.row.incarnation
        lastBytes = bytes
      }
      // Live file contains v10's bytes specifically. Every version
      // declared chash('chain'), so each commit promoted to the same
      // content-addressed path; v10 is the last writer.
      const onDisk = readFileSync(liveFilePath(objDir, 'ws-1', chash('chain')))
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

  it('two concurrent identical commits for the SAME (ws, res, sid) — exactly one succeeds, the other loses', async () => {
    // Models the deduplicated-request case where the same token
    // commit is issued twice in parallel (NOT the in-flight HTTP
    // dedup that rest.ts owns — here it's direct DB-level), now with
    // NO lock. Both may read the staging row, but only one outcome is
    // possible per the version-CAS: exactly ONE commit lands the live
    // row. The loser's reason depends on how far it got before the
    // winner consumed the shared staging slot:
    //   - `conflict` — it raced the version-CAS and lost;
    //   - `no-staging` — the winner's `deleteStaging` ran before the
    //     loser's `selectStaging`;
    //   - `io-error` — on the FS backend the winner's promote (rename)
    //     removed the staging file before the loser's own promote.
    // All three are correct losses; the invariant is exactly one ok,
    // a single live row at v1, and never a double-commit.
    const { handle, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ expectedLength: 4 }))
      writeStaging(b.filePath, Buffer.alloc(4))
      const commit = () => commitPut(handle, {
        workspaceTag: 'ws-1', resourceTag: 'res-1', stagingId: b.stagingId,
      })
      const [c1, c2] = await Promise.all([commit(), commit()])
      const oks = [c1, c2].filter((c) => c.ok)
      const losers = [c1, c2].filter((c) => !c.ok && (c.reason === 'conflict' || c.reason === 'no-staging' || c.reason === 'io-error'))
      assert.equal(oks.length, 1, 'exactly one commit succeeds')
      assert.equal(losers.length, 1, 'the other loses with conflict / no-staging / io-error — never a second success')
      // The live row landed exactly once, at v1.
      const live = await getLive(handle, 'ws-1', 'res-1')
      assert.equal(live?.version, 1)
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
      // Distinct bytes ⇒ distinct content hashes ⇒ distinct blob
      // addresses — the realistic model, and what makes a byte-leak
      // structurally impossible: the new incarnation never shares a
      // file with the deleted predecessor.
      const hOrig = chash('recycled@orig')
      const hRepl = chash('recycled@repl')
      const r1 = await lockedPut(handle, fakeBegin({ resourceTag: 'recycled', expectedLength: 32, contentHash: hOrig }), original)
      assert.equal(r1.ok, true)
      assert.equal(r1.row.version, 1)
      const origBlob = liveFilePath(objDir, 'ws-1', hOrig)
      assert.equal(existsSync(origBlob), true)
      // Delete the live row. The blob is NOT unlinked inline — the row
      // drops, the now-unreferenced original blob is left for the
      // reaper's GC (deferred, post-grace-window).
      const d = await lockedDelete(handle, 'ws-1', 'recycled', 1, r1.row.incarnation)
      assert.equal(d.ok, true)
      assert.equal(await getLive(handle, 'ws-1', 'recycled'), null)
      assert.equal(existsSync(origBlob), true, 'delete drops the row but leaves the blob for the reaper')
      // Re-put under the same tag, prev=null (must-not-exist gate),
      // with NEW bytes → new content address.
      const r2 = await lockedPut(handle, fakeBegin({ resourceTag: 'recycled', expectedLength: 32, contentHash: hRepl }), replacement)
      assert.equal(r2.ok, true)
      assert.equal(r2.row.version, 1, 'new incarnation starts back at v1 (no tombstone)')
      // Live file (at the replacement's own address) holds the
      // replacement bytes — never the original.
      const onDisk = readFileSync(liveFilePath(objDir, 'ws-1', hRepl))
      assert.equal(Buffer.compare(onDisk, replacement), 0)
      assert.equal(onDisk.indexOf('ORIGINAL'), -1, 'no leak of the deleted predecessor')
      // The orphaned original blob the GC reaps once aged past the
      // grace window; the new incarnation's blob (referenced) stays.
      ageBlob(origBlob)
      await reapOrphans(handle)
      assert.equal(existsSync(origBlob), false, 'unreferenced predecessor blob GCd once aged')
      assert.equal(Buffer.compare(readFileSync(liveFilePath(objDir, 'ws-1', hRepl)), replacement), 0, 'live incarnation untouched by the GC')
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
        // Verify bytes match this cycle's payload exactly. Every cycle
        // declares chash('flip'), so each put promotes this cycle's
        // bytes to the same content-addressed path; we read it while
        // the row is still live (before this cycle's delete).
        const onDisk = readFileSync(liveFilePath(objDir, 'ws-1', chash('flip')))
        assert.equal(Buffer.compare(onDisk, bytes), 0, `cycle ${cycle}: live bytes match this cycle's payload`)
        const d = await lockedDelete(handle, 'ws-1', 'flip', 1, r.row.incarnation)
        assert.equal(d.ok, true)
      }
    } finally { cleanup() }
  })

  it('mid-cycle interleave: delete arrives between two commit phases on the same resource', async () => {
    // Resource exists at v1. Begin a v2 put-attempt, body writes. Before
    // the commit runs, a DELETE lands and drops the row (the v1 blob is
    // left for the reaper). The commit's precondition-recheck sees no
    // row; staging.prev_version is 1 but live is null → conflict, BEFORE
    // the promote (the version-CAS would also fail). The row STAYS
    // deleted; v2's bytes never reach their content-addressed live path.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Seed v1 (its own content hash).
      const v1 = Buffer.from('v1-content-staying-around')
      const hV1 = chash('mid@v1')
      const r1 = await lockedPut(handle, fakeBegin({ resourceTag: 'mid', expectedLength: v1.byteLength, contentHash: hV1 }), v1)
      assert.equal(r1.ok, true)
      const v1Blob = liveFilePath(objDir, 'ws-1', hV1)
      // Begin v2 — distinct bytes + distinct hash so we can assert v2's
      // specific blob is never promoted.
      const hV2 = chash('mid@v2')
      const begin = await beginPut(handle, fakeBegin({
        resourceTag: 'mid', prevVersion: 1, prevIncarnation: r1.row.incarnation, expectedLength: 4, contentHash: hV2,
      }))
      assert.equal(begin.ok, true)
      writeStaging(begin.filePath, Buffer.alloc(4))
      // Interleave: DELETE the v1 row. Row drops; v1 blob lingers
      // (deferred GC), but it is now unreferenced.
      const d = await lockedDelete(handle, 'ws-1', 'mid', 1, r1.row.incarnation)
      assert.equal(d.ok, true)
      assert.equal(await getLive(handle, 'ws-1', 'mid'), null)
      // Now commit v2. commitPut's getLive returns null and the
      // staging row's prev_version = 1 — mismatch → conflict (the
      // version-CAS would also fail, but the precheck short-circuits).
      const c = await commitPut(handle, {
        workspaceTag: 'ws-1', resourceTag: 'mid', stagingId: begin.stagingId,
      })
      assert.equal(c.ok, false)
      assert.equal(c.reason, 'conflict')
      // No live row. The delete won, the v2 attempt lost: v2's bytes
      // were never promoted to their content-addressed path.
      assert.equal(await getLive(handle, 'ws-1', 'mid'), null)
      assert.equal(existsSync(liveFilePath(objDir, 'ws-1', hV2)), false, 'v2 bytes never promoted (conflict precedes the promote)')
      // The stranded v1 blob is unreferenced → GCd once aged.
      ageBlob(v1Blob)
      await reapOrphans(handle)
      assert.equal(existsSync(v1Blob), false, 'unreferenced v1 blob GCd once aged')
      // Cleanup the abandoned staging.
      await abortPut(handle, 'ws-1', 'mid', begin.stagingId)
    } finally { cleanup() }
  })

  it('many concurrent peers each doing delete-then-recreate cycles — final state is consistent (no partial bytes)', async () => {
    // The CAS + content-addressing guarantee: a commit's promote +
    // version-CAS and a delete's row-drop on the same resource resolve
    // deterministically (the version is the arbiter), and a losing
    // commit's promoted blob is content-addressed (immutable, GC'd if
    // unreferenced) — so the live row can NEVER end up naming a blob
    // that holds the wrong bytes. We model the chaos by running 10
    // concurrent "peers" each doing a delete-then-put cycle. The final
    // invariant: a surviving live row names a content hash whose blob
    // holds that payload byte-for-byte (NEVER a mix or a truncation).
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Both payloads have the SAME byte length so a length-based
      // sanity check is meaningful. Distinct bytes ⇒ distinct content
      // hashes ⇒ distinct immutable blob addresses, so the live row's
      // content_hash unambiguously names which blob is the live one.
      const seed = Buffer.from('SEED-PAYLOAD-XYZ12')   // 18 bytes
      const fresh = Buffer.from('FRESH-PAYLOAD-AB99')  // 18 bytes
      assert.equal(seed.byteLength, fresh.byteLength)
      const hSeed = chash('churn@seed')
      const hFresh = chash('churn@fresh')
      const byHash = new Map([[hSeed, seed], [hFresh, fresh]])
      await lockedPut(handle, fakeBegin({ resourceTag: 'churn', expectedLength: seed.byteLength, contentHash: hSeed }), seed)
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
          if (live) await lockedDelete(handle, 'ws-1', 'churn', live.version, live.incarnation)
          return lockedPut(
            handle,
            fakeBegin({ resourceTag: 'churn', expectedLength: fresh.byteLength, contentHash: hFresh }),
            fresh,
          )
        })())
      }
      await Promise.all(cycles)
      // Invariant: a surviving live row names one of the two known
      // hashes, and the blob at THAT hash holds the matching payload
      // byte-for-byte. Either:
      //  - the seed survived (no cycle's delete-then-put landed cleanly),
      //  - or some cycle's recreate landed → row names hFresh,
      //  - or the row was deleted last → no live row.
      const live = await getLive(handle, 'ws-1', 'churn')
      if (live) {
        assert.equal(live.version, 1, 'live row is v1 (seed v1 or fresh-incarnation v1)')
        assert.equal(live.contentLength, 18, 'declared length matches both known payloads')
        const expected = byHash.get(live.contentHash)
        assert.ok(expected, `live row must name a known content hash, got ${live.contentHash}`)
        const onDisk = readFileSync(liveFilePath(objDir, 'ws-1', live.contentHash))
        assert.equal(onDisk.byteLength, 18, 'on-disk size matches declared length')
        assert.equal(
          Buffer.compare(onDisk, expected), 0,
          `live blob bytes must be byte-for-byte the payload its hash names — never partial. got: ${onDisk.toString()}`,
        )
      } else {
        // No live row. Any blobs still on disk are unreferenced
        // (delete defers to the reaper now), so a grace-0 sweep that
        // can only be blocked by a live reference collects everything.
        await reapOrphans(handle, 0)
        assert.equal(existsSync(liveFilePath(objDir, 'ws-1', hSeed)), false, 'no live row ⇒ seed blob unreferenced, GCd')
        assert.equal(existsSync(liveFilePath(objDir, 'ws-1', hFresh)), false, 'no live row ⇒ fresh blob unreferenced, GCd')
      }
    } finally { cleanup() }
  })
})

describe('reaper × concurrent ops — never unlink a live file', () => {
  // The reaper's most-dangerous failure mode is unlinking a blob a
  // live row references. The protection (no lock): content-addressed
  // immutable blobs + the age grace window + a live-reference re-read
  // immediately before each unlink. These tests fire real concurrent
  // operations and confirm the live blob survives.
  it('reaper running concurrent with a delete-then-put cycle preserves the recreate file', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Seed: put + reap (no orphans yet).
      const original = Buffer.from('reap-orig-bytes')
      const seed = await lockedPut(handle, fakeBegin({ resourceTag: 'reap-race', expectedLength: original.byteLength }), original)
      // Cycle: delete + recreate + reap, all kicked together so the
      // reaper's snapshot is racing the row-state changes. The
      // recreate reuses the same content hash as the seed (default),
      // so its row continuously references chash('reap-race') — the
      // reaper's live-set re-check must spare that blob even though a
      // delete dropped the intervening row.
      const replacement = Buffer.from('reap-replacement-x')
      const [, , reapResult] = await Promise.all([
        lockedDelete(handle, 'ws-1', 'reap-race', 1, seed.row.incarnation),
        lockedPut(handle, fakeBegin({ resourceTag: 'reap-race', expectedLength: replacement.byteLength }), replacement),
        reapOrphans(handle),
      ])
      // The recreate may have raced ahead of the delete (in which
      // case the conflict resolution drops one of them) or behind it
      // (in which case both succeed sequentially). Either way the
      // INVARIANT is: a surviving live row has the blob its hash names
      // intact, with matching size.
      const live = await getLive(handle, 'ws-1', 'reap-race')
      if (live) {
        const onDisk = readFileSync(liveFilePath(objDir, 'ws-1', live.contentHash))
        assert.equal(onDisk.byteLength, live.contentLength, 'live row content_length matches on-disk size')
      } else {
        // No live row → the blob is unreferenced. The default sweep
        // already ran (grace window protects a young blob); a grace-0
        // sweep now collects it deterministically, proving nothing but
        // the absent reference protected it.
        await reapOrphans(handle, 0)
        assert.equal(existsSync(liveFilePath(objDir, 'ws-1', chash('reap-race'))), false, 'no live row ⇒ blob unreferenced, GCd by a grace-0 sweep')
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
      // Every seeded resource still has its file — each is referenced
      // by its live row, so the reaper's referenced-set check spares it.
      for (const t of seeded) {
        assert.equal(existsSync(liveFilePath(objDir, 'ws-1', chash(t))), true, `seeded resource ${t} file survives reap`)
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
    // guard — so parallel calls hit list/unlink concurrently.
    // Each per-blob unlink is itself ENOENT-tolerant, so two
    // sweeps trying to unlink the same stranded blob must both
    // return cleanly (one wins, the other sees ENOENT). We assert
    // the ENOENT-tolerance by running 5 reapers in parallel and
    // checking the cleanup is correct.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Manufacture 20 stranded blobs (committed → row deleted). Each
      // resource has its own content hash (chash(resourceTag)), so the
      // 20 blobs are 20 distinct files. Age each past the grace window
      // so the unreferenced-blob GC is eligible to collect it.
      for (let i = 0; i < 20; i++) {
        const t = `strand-${i}`
        await lockedPut(handle, fakeBegin({ resourceTag: t, expectedLength: 4 }), Buffer.alloc(4))
        // Direct row drop — simulates a delete that left the blob.
        handle.db.prepare('DELETE FROM workspace_object WHERE workspace_tag = ? AND resource_tag = ?').run('ws-1', t)
        ageBlob(liveFilePath(objDir, 'ws-1', chash(t)))
      }
      // Files exist on disk.
      for (let i = 0; i < 20; i++) {
        assert.equal(existsSync(liveFilePath(objDir, 'ws-1', chash(`strand-${i}`))), true)
      }
      // Run 5 reapers concurrently — they should not throw.
      await Promise.all([
        reapOrphans(handle), reapOrphans(handle), reapOrphans(handle),
        reapOrphans(handle), reapOrphans(handle),
      ])
      // All stranded files gone (unreferenced + aged past grace).
      for (let i = 0; i < 20; i++) {
        assert.equal(existsSync(liveFilePath(objDir, 'ws-1', chash(`strand-${i}`))), false, `stranded file strand-${i} reaped`)
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
      assert.equal(existsSync(liveFilePath(objDir, 'ws-1', chash('staging-only'))), true)
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
  // Subtle: a delete drops R's row, leaving its (now unreferenced)
  // blob for the GC. A fresh begin+commit then re-adds R. Under
  // content-addressing the danger is dedup: if the recreate commits
  // BYTE-IDENTICAL content, it lands at the SAME content hash as the
  // just-deleted predecessor's stranded blob — so that blob becomes
  // referenced again. The reaper must never unlink a blob whose hash
  // a live row references. The old commit-lock + selectLiveOne recheck
  // is gone; the protections now are (1) the grace window for a
  // just-promoted young blob and (2) `gcBlobIfUnreferenced` re-reading
  // the live reference set immediately before each unlink. This pair
  // of tests pins both halves deterministically (mirroring how the
  // template replaced its lock-interpose test).
  it('referenced-set: a recreate that re-references the predecessor blob hash protects it from the delete-aimed sweep', async () => {
    // Model the danger directly: a stranded unreferenced blob at hash
    // H (the deleted predecessor), then a recreate commits the SAME
    // bytes → its live row references H again. A sweep aimed at the
    // orphan must spare H because a live row now names it — even aged
    // past the grace window and swept with grace 0, so ONLY the live
    // reference (not youth) can be what protects it.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Seed an unrelated live resource so listLiveTags iterates ws-1.
      await lockedPut(handle, fakeBegin({ resourceTag: 'other', expectedLength: 4 }), Buffer.alloc(4))
      const bytes = Buffer.from('FRESH-RECREATE-BYTES')
      const h = chash('R@dedup')
      // Predecessor's stranded blob at H (no row references it yet).
      const blob = liveFilePath(objDir, 'ws-1', h)
      mkdirSync(path.dirname(blob), { recursive: true })
      writeFileSync(blob, bytes)
      // Recreate lands a live row referencing H (byte-identical
      // content dedup → same content hash). This is the row + blob
      // that commitPut+delete produce in production.
      handle.db.prepare(`
        INSERT INTO workspace_object
          (workspace_tag, resource_tag, version, incarnation, content_hash, content_length,
           signature, put_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('ws-1', 'R', 1, 'aaaaaaaaaaaaaaaaaaaaaa', h, bytes.byteLength, b64u64(), Date.now())
      // Age the blob and sweep with grace 0: neither youth nor grace
      // can be what spares it — only the live row's reference to H.
      ageBlob(blob)
      await reapOrphans(handle, 0)
      assert.equal(existsSync(blob), true, 'reaper must not unlink a blob whose hash a live row references')
      const onDisk = readFileSync(blob)
      assert.equal(Buffer.compare(onDisk, bytes), 0, 'recreate bytes preserved')
      const row = handle.db.prepare('SELECT 1 FROM workspace_object WHERE workspace_tag = ? AND resource_tag = ?').get('ws-1', 'R')
      assert.ok(row)
    } finally { cleanup() }
  })

  it('grace-window: a just-promoted recreate blob survives a default sweep; aged + unreferenced → GCd', async () => {
    // The other half of the old mid-sweep race: a recreate's commit
    // that lands a YOUNG blob is protected by the grace window even
    // before its row's reference is observed. We pin that the grace
    // window alone spares a recent unreferenced blob (the not-yet-
    // CAS'd promote window's real-world shape), and that once aged AND
    // unreferenced it is collected.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      await lockedPut(handle, fakeBegin({ resourceTag: 'other', expectedLength: 4 }), Buffer.alloc(4))
      // A freshly-promoted blob with no row yet (commit between
      // promote and CAS) — unreferenced but YOUNG.
      const h = chash('R@young')
      const blob = liveFilePath(objDir, 'ws-1', h)
      mkdirSync(path.dirname(blob), { recursive: true })
      writeFileSync(blob, Buffer.from('JUST-PROMOTED-BYTES'))
      // Default sweep: the grace window protects the recent blob.
      await reapOrphans(handle)
      assert.equal(existsSync(blob), true, 'grace window protects a just-promoted (young) blob from a concurrent sweep')
      // Aged past the grace window and still unreferenced → GCd.
      ageBlob(blob)
      await reapOrphans(handle)
      assert.equal(existsSync(blob), false, 'an aged, unreferenced blob is collected')
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
            await lockedDelete(handle, 'ws-1', tag, put.ok ? put.row.version : null, put.ok ? put.row.incarnation : null)
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
      // Every final put landed and its blob holds the final bytes. The
      // final put's row references chash(tag), so the reapers' live-set
      // re-check spares the blob; in the brief unreferenced windows
      // between cycles the blob is too young for the grace window — so
      // the final bytes survive all 50 sweeps.
      for (const { tag, finalPut, finalBytes } of cycleResults) {
        assert.equal(finalPut.ok, true, `final put for ${tag} succeeded`)
        const onDisk = readFileSync(liveFilePath(objDir, 'ws-1', chash(tag)))
        assert.equal(Buffer.compare(onDisk, finalBytes), 0, `${tag}: final bytes intact despite reapers`)
      }
      // Live row count matches resources × 1 (final put = v1 fresh
      // incarnation after a delete in each cycle).
      const live = await listLive(handle, 'ws-1')
      assert.equal(live.length, 12)
    } finally { cleanup() }
  })

  it('reaper does NOT reap a `.bin` whose row references its hash (rename-then-CAS ordering)', async () => {
    // commitPut promotes (rename) to the content-addressed path BEFORE
    // the version CAS lands the row — the blob exists momentarily with
    // no row referencing it. The reaper must not collect it once the
    // row lands. With the distributed commit lock removed, the guard is
    // `gcBlobIfUnreferenced`'s live-reference re-read immediately
    // before each unlink: a row that references the blob's hash by the
    // time the reaper reaches the unlink spares it. (The grace window
    // is the separate guard for the narrow promote→CAS window while no
    // row yet exists; covered by the grace-window test above.) We pin
    // the referenced-set half deterministically: blob present + a live
    // row naming its hash ⇒ never collected, even aged + grace 0.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const content = 'just-renamed-here'
      const h = chash('R@renamed')
      // A blob promoted to its content-addressed live path.
      const livePath = liveFilePath(objDir, 'ws-1', h)
      mkdirSync(path.dirname(livePath), { recursive: true })
      writeFileSync(livePath, content)
      // The CAS landed the row referencing the blob's hash.
      handle.db.prepare(`
        INSERT INTO workspace_object
          (workspace_tag, resource_tag, version, incarnation, content_hash, content_length,
           signature, put_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('ws-1', 'R', 1, 'aaaaaaaaaaaaaaaaaaaaaa', h, content.length, b64u64(), Date.now())
      // Age it and sweep with grace 0 so only the live row's reference
      // (not the grace window) can be what spares it.
      ageBlob(livePath)
      await reapOrphans(handle, 0)
      // The blob survives — its hash is referenced by a live row.
      assert.equal(existsSync(livePath), true)
      assert.equal(readFileSync(livePath, 'utf8'), content)
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
  it('two concurrent deleteObject(prev=N) calls on the same row → exactly one drops it (ok), the other not-found', async () => {
    // Lockless model: both deletes read v1 and pass the prev check, then
    // each runs the version-CAS drop (`deleteLiveCAS` — DELETE WHERE
    // version = 1 RETURNING). Only ONE can match the v1 row; the other
    // matches no row → re-read → not-found. Exactly one ok + one
    // not-found, the same outcome the old lock produced. (An
    // unconditional DELETE here would let both "succeed"; the CAS
    // prevents that — and, more importantly, prevents a delete dropping
    // a row a concurrent commit just bumped: see the next test.)
    const { handle, cleanup } = freshHandle()
    try {
      const seed = await lockedPut(handle, fakeBegin({ expectedLength: 4 }), Buffer.alloc(4))
      const inc1 = seed.row.incarnation
      const [d1, d2] = await Promise.all([
        lockedDelete(handle, 'ws-1', 'res-1', 1, inc1),
        lockedDelete(handle, 'ws-1', 'res-1', 1, inc1),
      ])
      const oks = [d1, d2].filter((d) => d.ok)
      const notFounds = [d1, d2].filter((d) => !d.ok && d.reason === 'not-found')
      assert.equal(oks.length, 1, 'exactly one delete drops the row')
      assert.equal(oks[0].deletedVersion, 1)
      assert.equal(notFounds.length, 1, 'the loser sees the row already gone → not-found')
      assert.equal(await getLive(handle, 'ws-1', 'res-1'), null, 'row deleted')
    } finally { cleanup() }
  })

  it('concurrent delete(prev=1) and commit(prev=1) — exactly one wins; a committed version is never lost', async () => {
    // THE lost-update guard. With an unconditional delete, deleteObject
    // could read v1, a concurrent commit bump v1→v2, and the delete then
    // destroy v2 while the commit reported success. The version-CAS
    // (`deleteLiveCAS` WHERE version = prev) makes the loser conflict
    // instead. Loop to exercise both interleavings.
    for (let i = 0; i < 40; i++) {
      const { handle, cleanup } = freshHandle()
      try {
        const seed = await lockedPut(handle, fakeBegin({ expectedLength: 4 }), Buffer.alloc(4))
        const inc1 = seed.row.incarnation
        const newBytes = Buffer.from('UPDATED-CONTENT')
        const h2 = chash('res-1@v2')
        const [commitRes, delRes] = await Promise.all([
          lockedPut(handle, fakeBegin({ prevVersion: 1, prevIncarnation: inc1, expectedLength: newBytes.byteLength, contentHash: h2 }), newBytes),
          lockedDelete(handle, 'ws-1', 'res-1', 1, inc1),
        ])
        const live = await getLive(handle, 'ws-1', 'res-1')
        if (commitRes.ok) {
          // Commit won: its v2 MUST still be live (never silently
          // deleted), and the delete MUST have lost with a conflict.
          assert.ok(live, `iter ${i}: committed v2 must not be lost to a racing delete`)
          assert.equal(live.version, 2)
          assert.equal(live.contentHash, h2)
          assert.equal(delRes.ok, false, `iter ${i}: delete must not also succeed`)
          assert.equal(delRes.reason, 'conflict')
        } else {
          // Delete won (or commit lost its begin/commit CAS): row gone,
          // commit conflicted.
          assert.equal(commitRes.reason, 'conflict', `iter ${i}: commit lost → conflict`)
          assert.equal(delRes.ok, true, `iter ${i}: delete won`)
          assert.equal(delRes.deletedVersion, 1)
          assert.equal(live, null, `iter ${i}: delete won → row gone`)
        }
      } finally { cleanup() }
    }
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
      // Both deletes read the row (v1) and both compare it against
      // prev=null → mismatch → conflict. The conflict check is
      // read-only, so the lockless interleaving doesn't change the
      // outcome: neither succeeds; the row survives.
      assert.equal(d1.ok, false); assert.equal(d1.reason, 'conflict')
      assert.equal(d2.ok, false); assert.equal(d2.reason, 'conflict')
      const live = await getLive(handle, 'ws-1', 'res-1')
      assert.ok(live, 'row survives — neither prev=null delete should drop an existing row')
    } finally { cleanup() }
  })

  it('deleteObject(prev=null) on a missing row twice in a row — both ack zero', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const d1 = await deleteObject(handle, 'ws-1', 'res-1', null, null)
      const d2 = await deleteObject(handle, 'ws-1', 'res-1', null, null)
      assert.equal(d1.ok, true); assert.equal(d1.deletedVersion, 0)
      assert.equal(d2.ok, true); assert.equal(d2.deletedVersion, 0)
    } finally { cleanup() }
  })

  it('deleteObject drops the row and leaves the blob for the reaper GC (no inline unlink)', async () => {
    // The commit/delete asymmetry doc in store.ts:
    //   DELETE:   DB row drop (the reaper GCs the unreferenced blob)
    // deleteObject no longer unlinks the blob inline — content dedup
    // means another resource may reference the same hash, so the GC
    // unlinks only once NO live row references it AND it's past the
    // grace window. Here we use deleteObject itself (not a direct row
    // drop), then assert the blob lingers immediately and is collected
    // once unreferenced + aged.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ resourceTag: 'will-strand', expectedLength: 4 }))
      writeStaging(b.filePath, Buffer.alloc(4))
      const c = await commitPut(handle, { workspaceTag: 'ws-1', resourceTag: 'will-strand', stagingId: b.stagingId })
      const live = liveFilePath(objDir, 'ws-1', chash('will-strand'))
      assert.equal(existsSync(live), true)
      const d = await deleteObject(handle, 'ws-1', 'will-strand', 1, c.row.incarnation)
      assert.equal(d.ok, true)
      // Row gone, blob lingers — delete defers the unlink to the GC.
      assert.equal(await getLive(handle, 'ws-1', 'will-strand'), null)
      assert.equal(existsSync(live), true, 'blob lingers after the row drop — GC owns the unlink')
      // Unreferenced + past the grace window → reaper collects it.
      ageBlob(live)
      await reapOrphans(handle)
      assert.equal(existsSync(live), false, 'reaper GCs the stranded unreferenced blob')
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

describe('many concurrent ops settle correctly (no lock to leak)', () => {
  // The objstore plane holds no in-process lock, so there is no lock
  // map to drain. (Neither does the revision-chain plane any more — its
  // commit is a single gated INSERT, no mutex.) What still matters under
  // heavy concurrency is that the version-CAS produces the right
  // outcomes: independent keys all land, same-key racers resolve to
  // exactly one winner.
  it('100 concurrent commits on 100 distinct keys all land at v1', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const ops = []
      for (let i = 0; i < 100; i++) {
        const t = `r-${i.toString().padStart(4, '0')}`
        ops.push(lockedPut(handle, fakeBegin({ resourceTag: t, expectedLength: 4 }), Buffer.alloc(4)))
      }
      const results = await Promise.all(ops)
      for (const r of results) { assert.equal(r.ok, true); assert.equal(r.row.version, 1) }
      assert.equal((await listLive(handle, 'ws-1')).length, 100)
    } finally { cleanup() }
  })

  it('5 concurrent puts on the SAME resource resolve to exactly one winner', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      // 5 concurrent first-writes on the SAME resource — the version-
      // CAS lets exactly one land; the other 4 reject with conflict.
      const ops = []
      for (let i = 0; i < 5; i++) {
        ops.push(lockedPut(handle, fakeBegin({ resourceTag: 'one', expectedLength: 4 }), Buffer.alloc(4)))
      }
      const results = await Promise.all(ops)
      const ok = results.filter((r) => r.ok).length
      const conflict = results.filter((r) => !r.ok && r.reason === 'conflict').length
      assert.equal(ok, 1)
      assert.equal(conflict, 4)
    } finally { cleanup() }
  })
})

describe('reaper at scale', () => {
  it('100 stranded files across 4 workspaces — single reapOrphans sweep cleans them all', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Set up 25 stranded blobs per workspace × 4 workspaces. Each
      // resource's blob is content-addressed at chash(tag); after the
      // row drop the blob is unreferenced. Age each past the grace
      // window so a single sweep is eligible to GC it.
      const stranded = []
      for (let w = 0; w < 4; w++) {
        const ws = `ws-${w}`
        for (let r = 0; r < 25; r++) {
          const tag = `r-${w}-${r.toString().padStart(4, '0')}`
          const b = await beginPut(handle, fakeBegin({ workspaceTag: ws, resourceTag: tag, expectedLength: 4 }))
          writeStaging(b.filePath, Buffer.alloc(4))
          await commitPut(handle, { workspaceTag: ws, resourceTag: tag, stagingId: b.stagingId })
          // Drop row → blob becomes unreferenced.
          handle.db.prepare('DELETE FROM workspace_object WHERE workspace_tag = ? AND resource_tag = ?').run(ws, tag)
          const blob = liveFilePath(objDir, ws, chash(tag))
          ageBlob(blob)
          stranded.push(blob)
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
      // 3 stranded committed blobs (drop-row simulating crashed
      // delete). Age each so the unreferenced-blob GC is eligible.
      const stranded = []
      for (let i = 0; i < 3; i++) {
        const t = `stranded-${i}`
        const b = await beginPut(handle, fakeBegin({ resourceTag: t, expectedLength: 4 }))
        writeStaging(b.filePath, Buffer.alloc(4))
        await commitPut(handle, { workspaceTag: 'ws-1', resourceTag: t, stagingId: b.stagingId })
        handle.db.prepare('DELETE FROM workspace_object WHERE workspace_tag = ? AND resource_tag = ?').run('ws-1', t)
        const blob = liveFilePath(objDir, 'ws-1', chash(t))
        ageBlob(blob)
        stranded.push(blob)
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
      // 3 fully-committed live rows (no reap needed). Each blob is
      // referenced by its live row, so the GC's referenced-set check
      // spares it.
      const live = []
      for (let i = 0; i < 3; i++) {
        const t = `live-${i}`
        const r = await lockedPut(handle, fakeBegin({ resourceTag: t, expectedLength: 16 }), Buffer.alloc(16))
        assert.equal(r.ok, true)
        live.push(liveFilePath(objDir, 'ws-1', chash(t)))
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
    // it, but the on-disk dir might still contain stranded live blobs
    // from a since-deleted incarnation. The top-level walk
    // post-listLiveTags catches this. The blob must carry a valid
    // content-hash name (the reaper's GC skips non-content-hash names
    // as foreign/defensive) and be aged past the grace window.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Stranded unreferenced live blob in a workspace WITHOUT any live
      // rows. Manually create the dir + content-addressed blob; the
      // reaper's top-level walk should pick it up even though
      // listLiveTags returns nothing for ws-empty.
      const wsDir = path.join(objDir, 'ws-empty')
      mkdirSync(wsDir, { recursive: true })
      const stranded = liveFilePath(objDir, 'ws-empty', chash('stray-resource'))
      writeFileSync(stranded, 'stranded-from-deleted-workspace')
      ageBlob(stranded)
      await reapOrphans(handle)
      assert.equal(existsSync(stranded), false, 'top-level walk GCs unreferenced blobs in workspaces with no live rows')
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
  // The cap check + insert are not atomic. Under heavy concurrent
  // NEW-resource creation, transient over-shoot is documented and
  // bounded — but the BIG INVARIANT (eventually settles at ≤
  // MAX_RESOURCES_PER_WORKSPACE + a small race window per the
  // docstring) needs holding.
  it.todo('99 already-live + 10 concurrent new-resource begins: cap should be strict (currently overshoots up to (parallel-1))', async () => {
    // OBSERVATION: the cap check (`count >= MAX`) and the staging
    // insert are not atomic — beginPut reads the count, then inserts,
    // with `await`s between. Ten concurrent NEW-resource begins each
    // read the count before any has inserted, so all ten can pass the
    // check. (Removing the per-resource lock didn't change this: that
    // lock keyed on (workspaceTag, resourceTag), so concurrent
    // begins for DIFFERENT resources never serialised against each
    // other anyway.) The store.ts docstring documents this as
    // accepted: "transient over-shoot under high concurrency across
    // DIFFERENT resources is bounded by (parallel new-resource begins
    // - 1) and is accepted (the cap is a soft policy bound, not a
    // security invariant)".
    //
    // SHOULD-BE: the cap is a cap. With 99 already-live + 10
    // concurrent begins, exactly 1 should land and 9 should be
    // rejected with `workspace-full`. The current "soft policy" is
    // a description of the bug, not a justification.
    //
    // FIX HINT: make the count + insert atomic for NEW-resource
    // creation per workspace — e.g. a per-workspaceTag mutex, a SQLite
    // transaction with appropriate isolation, or an INSERT guarded by
    // a `WHERE (SELECT count(*) ...) < MAX` predicate.
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
      const incByTag = new Map()
      for (let i = 0; i < MAX_RESOURCES_PER_WORKSPACE; i++) {
        const t = `r-${i.toString().padStart(4, '0')}`
        const c = await lockedPut(handle, fakeBegin({ resourceTag: t, expectedLength: 4 }), Buffer.alloc(4))
        incByTag.set(t, c.row.incarnation)
      }
      // Fire 5 concurrent updates on existing rows — should all
      // succeed (cap check skipped for existing resource).
      const updates = []
      for (let i = 0; i < 5; i++) {
        const t = `r-${i.toString().padStart(4, '0')}`
        updates.push(lockedPut(handle, fakeBegin({ resourceTag: t, prevVersion: 1, prevIncarnation: incByTag.get(t), expectedLength: 8 }), Buffer.alloc(8)))
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
  it('a refreshed-fresh row is not a reaper candidate, so a concurrent sweep + commit both win', async () => {
    // Replays the production sequence in the lockless model:
    //   1. beginPut → row inserted (begun_at = NOW)
    //   2. (REST PUT body takes a while, hand-aged begun_at)
    //   3. body finishes → refreshStagingBegunAt bumps begun_at = NOW
    //      (this is the after-body refresh, which happens BEFORE the
    //      commit and before any sweep could treat the row as stale)
    //   4. commit + a concurrent reaper sweep race; the sweep's
    //      `listAllStaging(now − TTL)` snapshot no longer matches the
    //      fresh row, so no conditional delete is even attempted, and
    //      the commit lands cleanly.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ resourceTag: 'slow-upload', expectedLength: 8 }))
      writeStaging(b.filePath, Buffer.alloc(8))
      // Body looked stale mid-stream...
      handle.db.prepare('UPDATE workspace_object_staging SET begun_at = ? WHERE staging_id = ?').run(
        Date.now() - 2 * 60 * 60 * 1000, b.stagingId,
      )
      // ...but the after-body refresh restamps begun_at to NOW before
      // the commit step (production order). This is what keeps the
      // conditional delete from matching.
      await handle.refreshStagingBegunAt.run(Date.now(), 'ws-1', 'slow-upload', b.stagingId)
      // Now race the commit against a sweep — no lock.
      const commit = commitPut(handle, { workspaceTag: 'ws-1', resourceTag: 'slow-upload', stagingId: b.stagingId })
      const sweep = reapOrphans(handle)
      const [c, _] = await Promise.all([commit, sweep])
      void _
      assert.equal(c.ok, true, 'fresh-upload commit succeeded despite a racing reaper sweep')
      assert.equal(c.row.version, 1)
      assert.equal(existsSync(liveFilePath(objDir, 'ws-1', chash('slow-upload'))), true)
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

  it.todo('reaper-vs-commit: a body that finishes AFTER exceeding the staging TTL can still be reaped mid-flight (accepted tradeoff)', async () => {
    // OBSERVATION: with the per-resource lock removed, the reaper no
    // longer WAITS for an in-flight upload. The F1 protection is now
    // the atomic conditional delete `deleteStagingIfStale` (predicate
    // `begun_at < staleBefore`). For a SUB-TTL upload this is airtight:
    // begun_at (set at begin) stays within the TTL through the body,
    // so the predicate can't match and the row is never reaped (see
    // the passing tests in this block). But for an upload whose body
    // streams LONGER than the staging TTL (default 1 h), the row's
    // begun_at is genuinely older than staleBefore at sweep time, so a
    // sweep that runs before the after-body refresh DOES match and
    // deletes the row; the subsequent commit then sees `no-staging`
    // → REST 410.
    //
    // SHOULD-BE (aspirational): an upload whose body finished
    // streaming should ALWAYS land, even past the 1 h TTL.
    //
    // ACTUAL: this is now a DOCUMENTED ACCEPTED TRADEOFF of removing
    // the lock (see commitPut + reaper comments). The old lock made
    // the reaper block on any in-flight upload (unbounded); the
    // bounded-staleness conditional delete trades that unbounded wait
    // for a >1h-upload reap window. Pinned as `it.todo` because the
    // >1h data-loss window is real — a future fix (e.g. a heartbeat
    // refresh during the body, or a "commit-intent" marker the reaper
    // honors) could close it without reintroducing an unbounded wait.
    //
    // Modelled against the conditional delete (no lock seam exists):
    // the reaper's stale-row delete runs (and matches the genuinely-
    // stale row) BEFORE the commit's after-body refresh.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ resourceTag: 'lose-commit', expectedLength: 8 }))
      writeStaging(b.filePath, Buffer.alloc(8))
      // Body has been streaming for hours; begun_at is genuinely stale.
      handle.db.prepare('UPDATE workspace_object_staging SET begun_at = ? WHERE staging_id = ?').run(
        Date.now() - 2 * 60 * 60 * 1000, b.stagingId,
      )
      // Reaper sweep runs first and its conditional delete matches the
      // genuinely-stale row → row + blob reaped.
      await reapOrphans(handle)
      // Commit attempts after the body finishes (refresh + commit).
      await handle.refreshStagingBegunAt.run(Date.now(), 'ws-1', 'lose-commit', b.stagingId)
      const c = await commitPut(handle, { workspaceTag: 'ws-1', resourceTag: 'lose-commit', stagingId: b.stagingId })
      // SHOULD BE: the commit succeeds. ACTUAL: `no-staging` (the row
      // was reaped) — the accepted >1h tradeoff.
      assert.equal(c.ok, true, 'an upload that finished streaming must not be lost to a racing reaper')
      assert.equal(c.row.version, 1)
      assert.equal(existsSync(liveFilePath(objDir, 'ws-1', chash('lose-commit'))), true)
    } finally { cleanup() }
  })

  it('commit that finishes before a sweep removes the staging row, so the sweep is a no-op', async () => {
    // The companion scenario: the commit runs to completion (refresh +
    // promote + CAS + deleteStaging) BEFORE the reaper sweep's stale-
    // row pass. The row is already gone, so the sweep's snapshot finds
    // nothing to delete. Commit wins cleanly. (Sequencing the commit
    // first makes this deterministic; the lockless model has no queue.)
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ resourceTag: 'commit-wins', expectedLength: 8 }))
      writeStaging(b.filePath, Buffer.alloc(8))
      // Hand-age begun_at — it would look stale to a sweep, but the
      // commit consumes the row before any sweep runs.
      handle.db.prepare('UPDATE workspace_object_staging SET begun_at = ? WHERE staging_id = ?').run(
        Date.now() - 2 * 60 * 60 * 1000, b.stagingId,
      )
      await handle.refreshStagingBegunAt.run(Date.now(), 'ws-1', 'commit-wins', b.stagingId)
      const c = await commitPut(handle, { workspaceTag: 'ws-1', resourceTag: 'commit-wins', stagingId: b.stagingId })
      // Reaper runs after the commit already dropped the staging row.
      await reapOrphans(handle)
      assert.equal(c.ok, true, 'commit lands first → success')
      assert.equal(c.row.version, 1)
      assert.equal(existsSync(liveFilePath(objDir, 'ws-1', chash('commit-wins'))), true)
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
      // Simulate commitPut's first half: promote staging → the
      // content-addressed live path + upsertLive (the row references
      // that same hash), SKIP the final deleteStaging (the "crash"
      // point).
      const { durableRenameStagedToLive } = await import('../server-e2e/objstore/fs.ts')
      const hHalf = chash('half-commit')
      const livePath = liveFilePath(objDir, 'ws-1', hHalf)
      const renamed = await durableRenameStagedToLive(b.filePath, livePath)
      assert.equal(renamed, true)
      handle.db.prepare(`
        INSERT INTO workspace_object
          (workspace_tag, resource_tag, version, incarnation, content_hash, content_length,
           signature, put_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('ws-1', 'half-commit', 1, 'aaaaaaaaaaaaaaaaaaaaaa', hHalf, 8, b64u64(), Date.now())
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
      const livePath = liveFilePath(objDir, 'ws-1', chash('crash-del'))
      assert.equal(existsSync(livePath), true)
      // "Crash" between DB drop and unlink: drop row directly, skip
      // the GC. The blob is now unreferenced; age it past the grace
      // window so the reaper's unreferenced-blob GC collects it.
      handle.db.prepare('DELETE FROM workspace_object WHERE workspace_tag = ? AND resource_tag = ?').run('ws-1', 'crash-del')
      assert.equal(existsSync(livePath), true, 'blob still on disk after row drop')
      assert.equal(await getLive(handle, 'ws-1', 'crash-del'), null)
      ageBlob(livePath)
      // Reaper's unreferenced-blob GC finds the orphan.
      await reapOrphans(handle)
      assert.equal(existsSync(livePath), false, 'reaper GCs orphan')
    } finally { cleanup() }
  })

  it('multiple consecutive crash points across many resources: reaper restores consistency', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Manufacture several partial states in parallel:
      // - 5 stranded committed blobs (DELETE crashed before the GC),
      //   aged so the unreferenced-blob GC is eligible
      // - 5 stranded staging rows (commit crashed before deleteStaging)
      // - 3 healthy committed rows (no crash)
      for (let i = 0; i < 5; i++) {
        const t = `crashed-del-${i}`
        const b = await beginPut(handle, fakeBegin({ resourceTag: t, expectedLength: 4 }))
        writeStaging(b.filePath, Buffer.alloc(4))
        await commitPut(handle, { workspaceTag: 'ws-1', resourceTag: t, stagingId: b.stagingId })
        handle.db.prepare('DELETE FROM workspace_object WHERE workspace_tag = ? AND resource_tag = ?').run('ws-1', t)
        ageBlob(liveFilePath(objDir, 'ws-1', chash(t)))
      }
      for (let i = 0; i < 5; i++) {
        const t = `crashed-commit-${i}`
        const b = await beginPut(handle, fakeBegin({ resourceTag: t, expectedLength: 4 }))
        writeStaging(b.filePath, Buffer.alloc(4))
        const { durableRenameStagedToLive } = await import('../server-e2e/objstore/fs.ts')
        // Promote to the content-addressed path; the live row
        // references that same hash (the metadata-vs-bytes binding).
        const h = chash(t)
        await durableRenameStagedToLive(b.filePath, liveFilePath(objDir, 'ws-1', h))
        handle.db.prepare(`
          INSERT INTO workspace_object
            (workspace_tag, resource_tag, version, incarnation, content_hash, content_length, signature, put_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run('ws-1', t, 1, 'aaaaaaaaaaaaaaaaaaaaaa', h, 4, b64u64(), Date.now())
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
      // Stranded blobs (from crashed-del) GC'd.
      for (let i = 0; i < 5; i++) {
        assert.equal(existsSync(liveFilePath(objDir, 'ws-1', chash(`crashed-del-${i}`))), false)
      }
      // Crashed-commit live rows + blobs intact (referenced); staging
      // rows cleaned.
      for (let i = 0; i < 5; i++) {
        const t = `crashed-commit-${i}`
        assert.equal(existsSync(liveFilePath(objDir, 'ws-1', chash(t))), true)
        const live = await getLive(handle, 'ws-1', t)
        assert.equal(live?.version, 1)
        // No staging row left.
        const stagingRows = handle.db.prepare('SELECT 1 FROM workspace_object_staging WHERE workspace_tag = ? AND resource_tag = ?').get('ws-1', t)
        assert.equal(stagingRows, undefined, `crashed-commit-${i}: staging row reaped`)
      }
      // Healthy untouched (referenced).
      for (const t of healthy) {
        assert.equal(existsSync(liveFilePath(objDir, 'ws-1', chash(t))), true)
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
          // Live blobs are content-addressed: the row's content hash
          // names its blob file.
          assert.equal(existsSync(liveFilePath(objDir, 'ws-1', r.contentHash)), true)
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
      // "Crash" before the GC: drop row, leave the blob. Age it past
      // the grace window so the startup sweep is eligible to GC it.
      handle1.db.prepare('DELETE FROM workspace_object WHERE workspace_tag = ? AND resource_tag = ?').run('ws-1', 'pre-crash')
      const livePath = liveFilePath(objDir, 'ws-1', chash('pre-crash'))
      assert.equal(existsSync(livePath), true)
      ageBlob(livePath)
      db1.close()
      // "Boot": fresh handle, startup reaper sweep.
      const db2 = new DatabaseSync(dbPath)
      const handle2 = openObjstore(db2, objDir)
      try {
        await reapOrphans(handle2)
        assert.equal(existsSync(livePath), false, 'startup reaper GCs pre-crash stranded blob')
      } finally { db2.close() }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('reaper × in-flight upload (slow streaming body)', () => {
  // The H4 / F1 protection is most visible when a body streams for
  // longer than the TTL. The after-body refresh restamps begun_at so
  // a row that LOOKED stale mid-stream is fresh by commit time, and
  // the reaper's conditional delete (predicate `begun_at < staleBefore`)
  // no longer matches it.
  it('a row whose begun_at was refreshed before commit survives a later reaper sweep', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ resourceTag: 'long-up', expectedLength: 8 }))
      writeStaging(b.filePath, Buffer.alloc(8))
      // Body has been streaming for hours — begun_at is stale.
      handle.db.prepare('UPDATE workspace_object_staging SET begun_at = ? WHERE staging_id = ?').run(
        Date.now() - 2 * 60 * 60 * 1000, b.stagingId,
      )
      // After-body refresh, then commit drops the staging row (no lock).
      await handle.refreshStagingBegunAt.run(Date.now(), 'ws-1', 'long-up', b.stagingId)
      const c = await commitPut(handle, { workspaceTag: 'ws-1', resourceTag: 'long-up', stagingId: b.stagingId })
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
    // `server-e2e/objstore/rest.ts handleRestGet` says of the 503
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
      const livePath = liveFilePath(objDir, 'ws-1', chash('broken'))
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
      // Every live blob's bytes match what we wrote — byte-for-byte.
      // Each resource has its own content hash (chash(tag)).
      for (const [tag, bytes] of written) {
        const onDisk = readFileSync(liveFilePath(objDir, 'ws-1', chash(tag)))
        assert.equal(onDisk.byteLength, bytes.byteLength, `${tag}: size matches`)
        assert.equal(Buffer.compare(onDisk, bytes), 0, `${tag}: bytes match exactly`)
        const live = await getLive(handle, 'ws-1', tag)
        assert.equal(live.contentLength, bytes.byteLength)
      }
    } finally { cleanup() }
  })

  it('write-then-rewrite-then-fetch: only the latest bytes are live on disk (no echo of prior version)', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const v1 = Buffer.from('VERSION-1-OLD-BYTES-MUST-NOT-LEAK'.padEnd(64, '_'))
      const v2 = Buffer.from('VERSION-2-NEW-BYTES'.padEnd(64, '#'))
      // Distinct bytes ⇒ distinct content hashes ⇒ distinct blob
      // addresses. v2 lands at a NEW path; v1's immutable blob is left
      // untouched (now unreferenced — the reaper GCs it once aged).
      const hV1 = chash('rew@v1')
      const hV2 = chash('rew@v2')
      const r1 = await lockedPut(handle, fakeBegin({ resourceTag: 'rew', expectedLength: 64, contentHash: hV1 }), v1)
      assert.equal(r1.ok, true)
      const v1Blob = liveFilePath(objDir, 'ws-1', hV1)
      const r2 = await lockedPut(
        handle,
        fakeBegin({ resourceTag: 'rew', prevVersion: 1, prevIncarnation: r1.row.incarnation, expectedLength: 64, contentHash: hV2 }),
        v2,
      )
      assert.equal(r2.ok, true)
      assert.equal(r2.row.version, 2)
      assert.equal(r2.row.contentHash, hV2)
      // The live blob (named by the live row's hash) holds only v2.
      const live = await getLive(handle, 'ws-1', 'rew')
      assert.equal(live.contentHash, hV2)
      const onDisk = readFileSync(liveFilePath(objDir, 'ws-1', live.contentHash))
      assert.equal(Buffer.compare(onDisk, v2), 0)
      assert.equal(onDisk.indexOf('VERSION-1'), -1, 'v1 substring must not survive in the v2 blob')
      // v1's blob is now unreferenced; once aged past the grace window
      // the reaper GCs it, while the live v2 blob (referenced) stays.
      ageBlob(v1Blob)
      await reapOrphans(handle)
      assert.equal(existsSync(v1Blob), false, 'unreferenced v1 blob GCd once aged')
      assert.equal(Buffer.compare(readFileSync(liveFilePath(objDir, 'ws-1', hV2)), v2), 0, 'live v2 blob untouched by the GC')
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
      assert.equal(existsSync(liveFilePath(objDir, 'ws-1', chash('res-1'))), false)
    } finally { cleanup() }
  })
})

describe('GET (openLiveReader) immutability under concurrent re-upload + GC', () => {
  // The lockless GET (rest.ts openLiveSnapshot) rests entirely on
  // content-addressed blobs being immutable: a reader opened on hash H
  // keeps reading H's bytes even as the resource is re-uploaded to a new
  // hash and H is GC'd. So a GET can NEVER serve torn / wrong bytes under
  // a concurrent write — at worst it sees a clean not-found if its hash
  // was already collected.
  it('an in-flight reader keeps its bytes across a re-upload + GC of its (now-unreferenced) hash', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const v1 = Buffer.from('VERSION-ONE-BYTES')
      const hV1 = chash('rsrc@v1')
      const seed = await lockedPut(handle, fakeBegin({ resourceTag: 'rsrc', expectedLength: v1.byteLength, contentHash: hV1 }), v1)
      // Open a reader on hV1 — models an in-flight GET holding its snapshot.
      const opened = await handle.blob.openLiveReader('ws-1', hV1)
      assert.equal(opened.ok, true)
      // Re-upload v2 at a NEW hash → hV1 becomes unreferenced.
      const v2 = Buffer.from('VERSION-TWO-DIFFERENT-LEN')
      const hV2 = chash('rsrc@v2')
      await lockedPut(handle, fakeBegin({ resourceTag: 'rsrc', prevVersion: 1, prevIncarnation: seed.row.incarnation, expectedLength: v2.byteLength, contentHash: hV2 }), v2)
      // Age + sweep: hV1 is unreferenced and past grace → GC'd.
      ageBlob(liveFilePath(objDir, 'ws-1', hV1))
      await reapOrphans(handle)
      assert.equal(existsSync(liveFilePath(objDir, 'ws-1', hV1)), false, 'unreferenced hV1 blob GCd')
      // The reader opened BEFORE the GC still streams hV1's ORIGINAL bytes
      // intact (FS pins the inode at open). Never torn / mixed with v2.
      const chunks = []
      for await (const chunk of opened.reader.stream) chunks.push(chunk)
      assert.equal(Buffer.compare(Buffer.concat(chunks), v1), 0, 'in-flight reader sees v1 bytes intact')
      // A FRESH open of the GC'd hash now fails cleanly (→ 503), never wrong bytes.
      const reopened = await handle.blob.openLiveReader('ws-1', hV1)
      assert.equal(reopened.ok, false)
      assert.equal(reopened.reason, 'unavailable')
      // The live row points at hV2, whose blob holds v2 exactly.
      assert.equal((await getLive(handle, 'ws-1', 'rsrc')).contentHash, hV2)
      assert.equal(Buffer.compare(readFileSync(liveFilePath(objDir, 'ws-1', hV2)), v2), 0)
    } finally { cleanup() }
  })
})

describe('content dedup — shared blob safety across resources', () => {
  // Two DISTINCT resources committing byte-identical content land the
  // SAME content hash → one shared blob. deleteObject drops only the row
  // (never an inline unlink), and the reaper GCs by the referenced-hash
  // SET — so deleting one sharer must never pull the bytes out from under
  // the other.
  it('two resources with identical bytes share one blob; deleting one keeps the other readable', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const bytes = Buffer.from('SHARED-IDENTICAL-BYTES')
      const h = chash('shared-content') // both resources carry the SAME hash (same bytes)
      const ra = await lockedPut(handle, fakeBegin({ resourceTag: 'res-A', expectedLength: bytes.byteLength, contentHash: h }), bytes)
      const rb = await lockedPut(handle, fakeBegin({ resourceTag: 'res-B', expectedLength: bytes.byteLength, contentHash: h }), bytes)
      const blobPath = liveFilePath(objDir, 'ws-1', h)
      assert.equal(existsSync(blobPath), true, 'shared blob exists')
      assert.equal((await getLive(handle, 'ws-1', 'res-A')).contentHash, h)
      assert.equal((await getLive(handle, 'ws-1', 'res-B')).contentHash, h)
      // Delete res-A. Even aged + a full sweep, the shared blob must
      // survive — res-B still references its hash.
      assert.equal((await deleteObject(handle, 'ws-1', 'res-A', 1, ra.row.incarnation)).ok, true)
      ageBlob(blobPath)
      await reapOrphans(handle)
      assert.equal(existsSync(blobPath), true, 'shared blob survives — still referenced by res-B')
      // res-B remains readable with the correct bytes.
      const opened = await handle.blob.openLiveReader('ws-1', h)
      assert.equal(opened.ok, true)
      const chunks = []
      for await (const chunk of opened.reader.stream) chunks.push(chunk)
      assert.equal(Buffer.compare(Buffer.concat(chunks), bytes), 0, 'res-B bytes intact after res-A deleted')
      // Delete res-B too → no resource references the hash → GC'd once aged.
      assert.equal((await deleteObject(handle, 'ws-1', 'res-B', 1, rb.row.incarnation)).ok, true)
      ageBlob(blobPath)
      await reapOrphans(handle)
      assert.equal(existsSync(blobPath), false, 'blob GCd once no live row references it')
    } finally { cleanup() }
  })
})

describe('reaper stale-staging — conditional-delete batch predicate', () => {
  // The lockless reaper uses an atomic conditional delete
  // (`deleteStagingIfStale` — DELETE ... WHERE begun_at < staleBefore),
  // replacing the old lock + in-lock begun_at re-read. One sweep must
  // remove EXACTLY the rows still stale at delete time, sparing any whose
  // begun_at was refreshed fresh (a slow upload that just completed).
  it('one sweep reaps exactly the stale staging rows and spares the fresh / refreshed ones', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const old = Date.now() - 2 * 60 * 60 * 1000
      const a = await beginPut(handle, fakeBegin({ resourceTag: 'A', expectedLength: 4 })); writeStaging(a.filePath, Buffer.alloc(4))
      const b = await beginPut(handle, fakeBegin({ resourceTag: 'B', expectedLength: 4 })); writeStaging(b.filePath, Buffer.alloc(4))
      const c = await beginPut(handle, fakeBegin({ resourceTag: 'C', expectedLength: 4 })); writeStaging(c.filePath, Buffer.alloc(4))
      // A and B both look stale at snapshot time...
      handle.db.prepare('UPDATE workspace_object_staging SET begun_at = ? WHERE staging_id IN (?, ?)').run(old, a.stagingId, b.stagingId)
      // ...but B's upload "just completed" — its begun_at is refreshed
      // fresh before the sweep, so the conditional delete won't match it.
      await handle.refreshStagingBegunAt.run(Date.now(), 'ws-1', 'B', b.stagingId)
      await reapOrphans(handle)
      // A (genuinely stale) reaped; B (refreshed) and C (fresh) survive.
      assert.equal(await handle.selectStaging.get('ws-1', 'A', a.stagingId), undefined, 'stale A row reaped')
      assert.equal(existsSync(a.filePath), false, 'stale A blob unlinked')
      assert.ok(await handle.selectStaging.get('ws-1', 'B', b.stagingId), 'refreshed B row spared')
      assert.equal(existsSync(b.filePath), true, 'refreshed B blob spared')
      assert.ok(await handle.selectStaging.get('ws-1', 'C', c.stagingId), 'fresh C row spared')
      assert.equal(existsSync(c.filePath), true, 'fresh C blob spared')
    } finally { cleanup() }
  })
})
