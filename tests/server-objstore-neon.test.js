// Runs the backend-agnostic v1.objstore storage suite against the NEON
// backend (`server/objstore/store-neon.ts`) instead of SQLite, with an
// in-process Postgres (PGlite) standing in for the real driver and a
// REAL filesystem byte plane (the same `openFsBlobBackend` the SQLite
// path uses). `openNeonObjstore` has no direct coverage otherwise.
//
// The objstore plane is lock-free: commits are an atomic version-CAS
// (insertLiveIfAbsent / updateLiveCAS) and live blobs are content-
// addressed (`${tag}/${contentHash}.bin`). The metadata-plane scenarios
// mirror `server-objstore.test.js`; the CAS-race scenarios pin the
// "exactly one of N racing commits wins, the rest conflict" invariant —
// run with TWO Handles over ONE PGlite, which is the real multi-replica
// shape the lock-free design targets (more faithful than the SQLite
// two-connections-to-one-file simulation).
//
// NOT ported: the reaper sweeps, FS directory-layout assertions, and the
// pure-unit token / input-shape tests — none are metadata-backend-
// specific. The Neon Handle leaves `dir` unset, so staging/live paths
// are computed from the returned `objDir` (live = content-addressed).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Buffer } from 'node:buffer'
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { createHash } from 'node:crypto'

import { MAX_RESOURCES_PER_WORKSPACE, abortPut, beginPut, commitPut, deleteObject, getLive, listLive } from '../server/objstore/store.ts'
import { liveFilePath, stagingFilePath } from '../server/objstore/fs.ts'
import { freshNeonObjstore, twoNeonReplicas } from './_neon-pglite.js'

function b64u64() { return 'a'.repeat(86) }
// Deterministic valid 43-char base64url content hash from a seed. Live
// blobs are content-addressed, so distinct seeds give distinct blob
// addresses; fakeBegin keys the default off the resourceTag.
function chash(seed) { return createHash('sha256').update(String(seed)).digest('base64url') }

function fakeBegin(over = {}) {
  const resourceTag = over.resourceTag ?? 'resource-tag-1'
  return {
    workspaceTag: 'workspace-tag-1',
    resourceTag,
    prevVersion: null,
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

// Seed N live rows directly — faster than N begin/commit cycles when a
// test only needs the resource COUNT to hit the cap. Exercises the same
// `workspace_object` shape `countLive` reads.
async function seedLiveRows(pg, tag, n) {
  for (let i = 0; i < n; i++) {
    await pg.query(
      `INSERT INTO workspace_object
         (workspace_tag, resource_tag, version, content_hash, content_length, signature, put_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tag, `seed-res-${i}`, 1, chash(`seed-${i}`), 8, b64u64(), Date.now()],
    )
  }
}

describe('openNeonObjstore — schema (PGlite)', () => {
  it('creates the two objstore tables on a fresh DB', async () => {
    const { pg, cleanup } = await freshNeonObjstore()
    try {
      const { rows } = await pg.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name LIKE 'workspace_object%'
         ORDER BY table_name`,
      )
      assert.deepEqual(rows.map((r) => r.table_name), ['workspace_object', 'workspace_object_staging'])
    } finally { await cleanup() }
  })

  it('a second openNeonObjstore on the same DB is idempotent (committed row visible cross-handle)', async () => {
    const { handle1, handle2, objDir, cleanup } = await twoNeonReplicas()
    try {
      const b = await beginPut(handle1, fakeBegin())
      writeStaging(stagingFilePath(objDir, 'workspace-tag-1', b.stagingId), Buffer.alloc(16))
      await commitPut(handle1, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: b.stagingId })
      const rows = await listLive(handle2, 'workspace-tag-1')
      assert.equal(rows.length, 1)
      assert.equal(rows[0].version, 1)
    } finally { await cleanup() }
  })
})

describe('beginPut → commitPut happy path (Neon)', () => {
  it('produces a live row at version 1 with the staged bytes at the content-addressed path', async () => {
    const { handle, objDir, cleanup } = await freshNeonObjstore()
    try {
      const begin = await beginPut(handle, fakeBegin())
      assert.equal(begin.ok, true)
      writeStaging(stagingFilePath(objDir, 'workspace-tag-1', begin.stagingId), Buffer.alloc(16))
      const commit = await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: begin.stagingId })
      assert.equal(commit.ok, true)
      assert.equal(commit.row.version, 1)
      assert.equal(commit.row.contentLength, 16)
      assert.equal(statSync(liveFilePath(objDir, 'workspace-tag-1', chash('resource-tag-1'))).size, 16)
      assert.equal(existsSync(stagingFilePath(objDir, 'workspace-tag-1', begin.stagingId)), false, 'staging promoted away')
      const rows = await listLive(handle, 'workspace-tag-1')
      assert.equal(rows.length, 1)
      assert.equal(rows[0].resourceTag, 'resource-tag-1')
    } finally { await cleanup() }
  })

  it('a second PUT with prevVersion=1 bumps to v2 and lands new bytes at a new content-addressed path', async () => {
    const { handle, objDir, cleanup } = await freshNeonObjstore()
    try {
      const b1 = await beginPut(handle, fakeBegin({ expectedLength: 8 }))
      writeStaging(stagingFilePath(objDir, 'workspace-tag-1', b1.stagingId), Buffer.alloc(8))
      await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: b1.stagingId })
      const v1blob = liveFilePath(objDir, 'workspace-tag-1', chash('resource-tag-1'))
      const h2 = chash('resource-tag-1@v2')
      const b2 = await beginPut(handle, fakeBegin({ prevVersion: 1, expectedLength: 24, contentHash: h2 }))
      assert.equal(b2.ok, true)
      writeStaging(stagingFilePath(objDir, 'workspace-tag-1', b2.stagingId), Buffer.alloc(24))
      const c2 = await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: b2.stagingId })
      assert.equal(c2.ok, true)
      assert.equal(c2.row.version, 2)
      assert.equal(c2.row.contentHash, h2)
      assert.equal(statSync(liveFilePath(objDir, 'workspace-tag-1', h2)).size, 24, 'v2 bytes at the new address')
      assert.equal(statSync(v1blob).size, 8, "v1's immutable blob left for the reaper GC")
    } finally { await cleanup() }
  })

  it('round-trips a payload byte-for-byte through put → commit → content-addressed read', async () => {
    const { handle, objDir, cleanup } = await freshNeonObjstore()
    try {
      const payload = Buffer.from('the quick brown fox jumps over!!', 'utf8') // 32 bytes
      const h = chash('roundtrip')
      const begin = await beginPut(handle, fakeBegin({ expectedLength: payload.length, contentHash: h }))
      writeStaging(stagingFilePath(objDir, 'workspace-tag-1', begin.stagingId), payload)
      const commit = await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: begin.stagingId })
      assert.equal(commit.ok, true)
      assert.deepEqual(readFileSync(liveFilePath(objDir, 'workspace-tag-1', h)), payload)
    } finally { await cleanup() }
  })
})

describe('beginPut — version preconditions (Neon)', () => {
  it('rejects a fresh PUT with prevVersion=N when the row is missing', async () => {
    const { handle, cleanup } = await freshNeonObjstore()
    try {
      const begin = await beginPut(handle, fakeBegin({ prevVersion: 1 }))
      assert.equal(begin.ok, false)
      assert.equal(begin.reason, 'conflict')
      assert.equal(begin.conflict, null)
    } finally { await cleanup() }
  })

  it('rejects a stale PUT after a successful overwrite — conflict echoes the live row', async () => {
    const { handle, objDir, cleanup } = await freshNeonObjstore()
    try {
      const b1 = await beginPut(handle, fakeBegin({ expectedLength: 4 }))
      writeStaging(stagingFilePath(objDir, 'workspace-tag-1', b1.stagingId), Buffer.alloc(4))
      await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: b1.stagingId })
      const b2 = await beginPut(handle, fakeBegin({ prevVersion: null }))
      assert.equal(b2.ok, false)
      assert.equal(b2.conflict.version, 1)
      assert.equal(b2.conflict.resourceTag, 'resource-tag-1')
    } finally { await cleanup() }
  })
})

describe('beginPut — per-workspace resource cap (Neon)', () => {
  it('rejects the (MAX+1)th NEW resource with reason=workspace-full', async () => {
    const { handle, pg, cleanup } = await freshNeonObjstore()
    try {
      await seedLiveRows(pg, 'workspace-tag-1', MAX_RESOURCES_PER_WORKSPACE)
      const begin = await beginPut(handle, fakeBegin({ resourceTag: 'res-overflow' }))
      assert.equal(begin.ok, false)
      assert.equal(begin.reason, 'workspace-full')
    } finally { await cleanup() }
  })

  it('allows re-uploads (new versions) of existing resources at the cap', async () => {
    const { handle, pg, cleanup } = await freshNeonObjstore()
    try {
      await seedLiveRows(pg, 'workspace-tag-1', MAX_RESOURCES_PER_WORKSPACE)
      const begin = await beginPut(handle, fakeBegin({ resourceTag: 'seed-res-0', prevVersion: 1 }))
      assert.equal(begin.ok, true)
    } finally { await cleanup() }
  })

  it('caps are per-workspace, not global', async () => {
    const { handle, pg, cleanup } = await freshNeonObjstore()
    try {
      await seedLiveRows(pg, 'workspace-tag-1', MAX_RESOURCES_PER_WORKSPACE)
      const begin = await beginPut(handle, fakeBegin({ workspaceTag: 'ws-2', resourceTag: 'res-new' }))
      assert.equal(begin.ok, true)
    } finally { await cleanup() }
  })
})

describe('commitPut — size + race checks (Neon)', () => {
  it('rejects size-mismatch when the staged file is shorter than expected', async () => {
    const { handle, objDir, cleanup } = await freshNeonObjstore()
    try {
      const b = await beginPut(handle, fakeBegin({ expectedLength: 100 }))
      writeStaging(stagingFilePath(objDir, 'workspace-tag-1', b.stagingId), Buffer.alloc(50))
      const c = await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: b.stagingId })
      assert.equal(c.ok, false)
      assert.equal(c.reason, 'size-mismatch')
      assert.equal((await listLive(handle, 'workspace-tag-1')).length, 0)
    } finally { await cleanup() }
  })

  it('rejects on conflict: a competing commit landed between our begin and commit', async () => {
    const { handle, objDir, cleanup } = await freshNeonObjstore()
    try {
      const a = await beginPut(handle, fakeBegin({ expectedLength: 4, contentHash: chash('a') }))
      const b = await beginPut(handle, fakeBegin({ expectedLength: 4, contentHash: chash('b') }))
      writeStaging(stagingFilePath(objDir, 'workspace-tag-1', a.stagingId), Buffer.alloc(4))
      writeStaging(stagingFilePath(objDir, 'workspace-tag-1', b.stagingId), Buffer.alloc(4))
      const c1 = await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: a.stagingId })
      assert.equal(c1.ok, true)
      const c2 = await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: b.stagingId })
      assert.equal(c2.ok, false)
      assert.equal(c2.reason, 'conflict')
      assert.equal(c2.conflict.version, 1)
    } finally { await cleanup() }
  })

  it('returns no-staging for an unknown stagingId', async () => {
    const { handle, cleanup } = await freshNeonObjstore()
    try {
      const c = await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: 'never-seen-before' })
      assert.equal(c.ok, false)
      assert.equal(c.reason, 'no-staging')
    } finally { await cleanup() }
  })

  it('maps a vanished staging file (raced abort / reaper) to io-error, not size-mismatch', async () => {
    const { handle, objDir, cleanup } = await freshNeonObjstore()
    try {
      const b = await beginPut(handle, fakeBegin({ expectedLength: 8 }))
      const staged = stagingFilePath(objDir, 'workspace-tag-1', b.stagingId)
      writeStaging(staged, Buffer.alloc(8))
      rmSync(staged)
      const c = await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: b.stagingId })
      assert.equal(c.ok, false)
      assert.equal(c.reason, 'io-error')
      assert.equal((await listLive(handle, 'workspace-tag-1')).length, 0)
    } finally { await cleanup() }
  })
})

describe('abortPut — cleanup (Neon)', () => {
  it('drops the staging row and unlinks the staging file; idempotent on re-call', async () => {
    const { handle, objDir, cleanup } = await freshNeonObjstore()
    try {
      const b = await beginPut(handle, fakeBegin())
      const staged = stagingFilePath(objDir, 'workspace-tag-1', b.stagingId)
      writeStaging(staged, Buffer.alloc(16))
      assert.equal(existsSync(staged), true)
      await abortPut(handle, 'workspace-tag-1', 'resource-tag-1', b.stagingId)
      assert.equal(existsSync(staged), false)
      await abortPut(handle, 'workspace-tag-1', 'resource-tag-1', b.stagingId) // no-op, no throw
    } finally { await cleanup() }
  })
})

describe('deleteObject (Neon)', () => {
  it('drops the row when prevVersion matches; the content-addressed blob is left for the reaper GC', async () => {
    const { handle, objDir, cleanup } = await freshNeonObjstore()
    try {
      const b = await beginPut(handle, fakeBegin({ expectedLength: 4 }))
      writeStaging(stagingFilePath(objDir, 'workspace-tag-1', b.stagingId), Buffer.alloc(4))
      await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: b.stagingId })
      const live = liveFilePath(objDir, 'workspace-tag-1', chash('resource-tag-1'))
      const d = await deleteObject(handle, 'workspace-tag-1', 'resource-tag-1', 1)
      assert.equal(d.ok, true)
      assert.equal(d.deletedVersion, 1)
      assert.equal(await getLive(handle, 'workspace-tag-1', 'resource-tag-1'), null)
      // Blob is NOT unlinked inline (content dedup) — left for reaper GC.
      assert.equal(existsSync(live), true)
    } finally { await cleanup() }
  })

  it('returns a conflict when prevVersion mismatches', async () => {
    const { handle, objDir, cleanup } = await freshNeonObjstore()
    try {
      const b = await beginPut(handle, fakeBegin({ expectedLength: 4 }))
      writeStaging(stagingFilePath(objDir, 'workspace-tag-1', b.stagingId), Buffer.alloc(4))
      await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: b.stagingId })
      const d = await deleteObject(handle, 'workspace-tag-1', 'resource-tag-1', 99)
      assert.equal(d.ok, false)
      assert.equal(d.reason, 'conflict')
      assert.equal(d.conflict.version, 1)
    } finally { await cleanup() }
  })

  it('idempotent: prevVersion=null on a missing row succeeds with sentinel deletedVersion=0', async () => {
    const { handle, cleanup } = await freshNeonObjstore()
    try {
      const d = await deleteObject(handle, 'workspace-tag-1', 'resource-missing', null)
      assert.equal(d.ok, true)
      assert.equal(d.deletedVersion, 0)
    } finally { await cleanup() }
  })
})

describe('commit version-CAS — cross-replica races (two Handles, one PGlite) (Neon)', () => {
  // The lock-free correctness core: two replicas sharing one Neon DB +
  // blob store. The atomic insert/update CAS must yield exactly one
  // winner per race regardless of how the (PGlite-serialised) statements
  // interleave; losers rebase off a `conflict`.

  it('two replicas racing a first-write: exactly one inserts v1, the other conflicts', async () => {
    const { handle1, handle2, objDir, cleanup } = await twoNeonReplicas()
    try {
      const bA = await beginPut(handle1, fakeBegin({ contentHash: chash('A') }))
      const bB = await beginPut(handle2, fakeBegin({ contentHash: chash('B') }))
      writeStaging(stagingFilePath(objDir, 'workspace-tag-1', bA.stagingId), Buffer.alloc(16))
      writeStaging(stagingFilePath(objDir, 'workspace-tag-1', bB.stagingId), Buffer.alloc(16))
      const [rA, rB] = await Promise.all([
        commitPut(handle1, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: bA.stagingId }),
        commitPut(handle2, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: bB.stagingId }),
      ])
      assert.equal([rA, rB].filter((r) => r.ok).length, 1, 'exactly one first-write wins (insertLiveIfAbsent)')
      assert.equal([rA, rB].filter((r) => !r.ok && r.reason === 'conflict').length, 1)
      assert.equal((await listLive(handle1, 'workspace-tag-1')).length, 1, 'one live row, no fork')
    } finally { await cleanup() }
  })

  it('two replicas racing a re-upload off the same base version: one wins v2, the other conflicts', async () => {
    const { handle1, handle2, objDir, cleanup } = await twoNeonReplicas()
    try {
      const b0 = await beginPut(handle1, fakeBegin({ expectedLength: 4 }))
      writeStaging(stagingFilePath(objDir, 'workspace-tag-1', b0.stagingId), Buffer.alloc(4))
      await commitPut(handle1, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: b0.stagingId })

      const bA = await beginPut(handle1, fakeBegin({ prevVersion: 1, contentHash: chash('A@v2') }))
      const bB = await beginPut(handle2, fakeBegin({ prevVersion: 1, contentHash: chash('B@v2') }))
      writeStaging(stagingFilePath(objDir, 'workspace-tag-1', bA.stagingId), Buffer.alloc(16))
      writeStaging(stagingFilePath(objDir, 'workspace-tag-1', bB.stagingId), Buffer.alloc(16))
      const [rA, rB] = await Promise.all([
        commitPut(handle1, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: bA.stagingId }),
        commitPut(handle2, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: bB.stagingId }),
      ])
      const winners = [rA, rB].filter((r) => r.ok)
      const losers = [rA, rB].filter((r) => !r.ok && r.reason === 'conflict')
      assert.equal(winners.length, 1, 'exactly one re-upload wins (updateLiveCAS)')
      assert.equal(winners[0].row.version, 2)
      assert.equal(losers.length, 1)
      assert.equal(losers[0].conflict.version, 2, "loser sees the winner's v2")
    } finally { await cleanup() }
  })

  it('delete vs concurrent re-upload off the same version: exactly one wins, no lost update', async () => {
    const { handle1, handle2, objDir, cleanup } = await twoNeonReplicas()
    try {
      const b0 = await beginPut(handle1, fakeBegin({ expectedLength: 4 }))
      writeStaging(stagingFilePath(objDir, 'workspace-tag-1', b0.stagingId), Buffer.alloc(4))
      await commitPut(handle1, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: b0.stagingId })

      const bB = await beginPut(handle2, fakeBegin({ prevVersion: 1, contentHash: chash('B@v2') }))
      writeStaging(stagingFilePath(objDir, 'workspace-tag-1', bB.stagingId), Buffer.alloc(16))
      const [del, commit] = await Promise.all([
        deleteObject(handle1, 'workspace-tag-1', 'resource-tag-1', 1),
        commitPut(handle2, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: bB.stagingId }),
      ])
      assert.notEqual(del.ok, commit.ok, 'exactly one of {delete, commit} wins — no lost update')
      const live = await getLive(handle1, 'workspace-tag-1', 'resource-tag-1')
      if (commit.ok) {
        assert.equal(commit.row.version, 2)
        assert.equal(live?.version, 2, 'commit won → row at v2')
        assert.equal(del.ok, false)
        assert.equal(del.reason, 'conflict')
      } else {
        assert.equal(del.ok, true)
        assert.equal(del.deletedVersion, 1)
        assert.equal(live, null, 'delete won → row gone')
        assert.equal(commit.reason, 'conflict')
      }
    } finally { await cleanup() }
  })
})
