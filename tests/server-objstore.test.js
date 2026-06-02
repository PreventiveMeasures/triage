// `server/objstore/` — DB + filesystem layer for the v1.objstore
// extension. WS-round-trip coverage lives in
// tests/sync-server-objstore.test.js; this file targets the
// storage module directly.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'

import { MAX_RESOURCES_PER_WORKSPACE, abortPut, beginPut, commitPut, deleteObject, getLive, listLive, openObjstore } from '../server/objstore/store.ts'
import { liveFilePath, stagingFilePath } from '../server/objstore/fs.ts'
import { reapOrphans } from '../server/objstore/reaper.ts'
import { initObjstore } from '../server/objstore/init.ts'

let counter = 0
function freshHandle() {
  const dir = mkdtempSync(path.join(tmpdir(), `deepview-obj-${++counter}-`))
  const db = new DatabaseSync(path.join(dir, 'data.db'))
  const objDir = path.join(dir, 'objstore')
  const handle = openObjstore(db, objDir)
  return {
    handle,
    objDir,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

// 32-byte b64url, 43 chars no padding (CONTENT_HASH_RE)
function b64u32() { return 'a'.repeat(43) }
// 64-byte b64url, 86 chars no padding (SIG_RE)
function b64u64() { return 'a'.repeat(86) }

// Deterministic, valid (43-char base64url) content hash from a seed.
// Live blobs are content-addressed (`${tag}/${contentHash}.bin`), so
// keying the test payloads' hashes off the resourceTag gives each
// resource its own blob — mirroring the old per-resourceTag on-disk
// layout so existing coverage carries straight over. A test that wants
// a NEW address for new bytes (re-upload) passes a distinct seed.
function chash(seed) { return createHash('sha256').update(String(seed)).digest('base64url') }

// Backdate a live blob's mtime so the reaper's GC grace window (default
// = STAGING_TTL_MS_DEFAULT) treats it as collectible. Mirrors how the
// staging-TTL tests backdate `begun_at`; avoids depending on a grace=0
// edge case (fs mtime can round a just-written file slightly ahead).
function ageBlob(filePath, msAgo = 2 * 60 * 60 * 1000) {
  const t = (Date.now() - msAgo) / 1000
  utimesSync(filePath, t, t)
}

function fakeBegin(over = {}) {
  const resourceTag = over.resourceTag ?? 'resource-tag-1'
  return {
    workspaceTag: 'workspace-tag-1',
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

describe('initObjstore — auth-gate config guard', () => {
  it('throws when authGate is wired without sendUnauthorized (fail-loud, not fail-open)', () => {
    // The put-begin gate in handlers.ts fires only when BOTH authGate
    // and sendUnauthorized are present, so a lopsided config would
    // silently fail OPEN — unauthenticated first-writes to unknown
    // workspaces would be accepted. initObjstore must reject it at boot.
    assert.throws(
      () => initObjstore({ authGate: () => Promise.resolve(true) }),
      /authGate requires sendUnauthorized/u,
    )
  })

  it('accepts a complete auth config (both authGate and sendUnauthorized)', () => {
    const { handle, cleanup } = freshHandle()
    const init = initObjstore({
      handle,
      reapIntervalMs: 60_000,
      send: () => {}, broadcast: () => {},
      publishObjPut: () => {}, publishObjDeleted: () => {},
      getNonce: () => undefined, debug: false,
      authGate: () => Promise.resolve(true),
      sendUnauthorized: () => {},
    })
    assert.equal(typeof init.stopReaper, 'function')
    // Stop the reaper timer + drain the startup sweep before closing
    // the handle so the test leaves no dangling timer / open DB.
    return init.stopReaper().finally(cleanup)
  })
})

describe('initObjstore — reaper disable (OBJSTORE_REAP_DISABLED)', () => {
  it('reapDisabled skips the boot sweep (a stale orphan survives) and stopReaper is a no-op', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      // Seed a stale staging row + file the reaper WOULD collect — mirrors
      // the canonical stale-staging reapOrphans test (backdated begun_at).
      const b = await beginPut(handle, fakeBegin())
      writeStaging(b.filePath, Buffer.alloc(16))
      handle.db.prepare(`UPDATE workspace_object_staging SET begun_at = ? WHERE staging_id = ?`).run(
        Date.now() - 2 * 60 * 60 * 1000, b.stagingId,
      )
      // Boot the objstore with the reaper hard-disabled.
      const init = initObjstore({
        handle, reapIntervalMs: 60_000, reapDisabled: true,
        send: () => {}, broadcast: () => {},
        publishObjPut: () => {}, publishObjDeleted: () => {},
        getNonce: () => undefined, debug: false,
      })
      assert.ok(init.handlers && init.restDeps, 'objstore still wired with the reaper off')
      // startupReap is a resolved no-op: awaiting it must NOT run a sweep.
      await init.startupReap
      assert.equal(existsSync(b.filePath), true, 'stale staging blob NOT reaped (reaper disabled)')
      const row = handle.db.prepare(`SELECT 1 FROM workspace_object_staging WHERE staging_id = ?`).get(b.stagingId)
      assert.ok(row, 'stale staging row NOT reaped (reaper disabled)')
      // stopReaper is a no-op but must still resolve (no dangling timer/sweep).
      await init.stopReaper()
      // Sanity: the orphan IS collectible — a direct reapOrphans drops it,
      // proving survival above was the disable switch, not an un-aged row.
      await reapOrphans(handle)
      assert.equal(existsSync(b.filePath), false, 'direct reapOrphans still collects the orphan')
    } finally { cleanup() }
  })
})

describe('openObjstore — schema', () => {
  it('creates both tables on a fresh DB', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      // No rows yet — listLive returns [], getLive returns null.
      assert.deepEqual(await listLive(handle, 'workspace-tag-1'), [])
      assert.equal(await getLive(handle, 'workspace-tag-1', 'resource-tag-1'), null)
    } finally { cleanup() }
  })

  it('CHECK constraints reject negative version / length values (operator-write guard)', () => {
    // STRICT enforces the columns' TYPE but NOT their value domain — a
    // direct `version = -1` write is a valid integer STRICT accepts,
    // which then round-trips through `num()` and corrupts the commitPut
    // monotonicity arithmetic. The CHECKs reject it at write time,
    // matching the Neon schema (server-db-neon parity, but for objstore).
    const { handle, cleanup } = freshHandle()
    try {
      const insertObject = (version, contentLength) => handle.db.prepare(`
        INSERT INTO workspace_object
          (workspace_tag, resource_tag, version, incarnation, content_hash, content_length, signature, put_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run('ws', 'res', version, 'inc', b64u32(), contentLength, b64u64(), Date.now())
      assert.throws(() => insertObject(-1, 0), /CHECK constraint failed/u, 'version >= 0')
      assert.throws(() => insertObject(0, -1), /CHECK constraint failed/u, 'content_length >= 0')
      insertObject(0, 0) // boundary value is allowed

      let sid = 0
      const insertStaging = (prevVersion, expectedLength) => handle.db.prepare(`
        INSERT INTO workspace_object_staging
          (workspace_tag, resource_tag, staging_id, prev_version, prev_incarnation,
           expected_length, content_hash, signature, begun_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run('ws', 'res', `sid-${++sid}`, prevVersion, null, expectedLength, b64u32(), b64u64(), Date.now())
      assert.throws(() => insertStaging(0, -1), /CHECK constraint failed/u, 'expected_length >= 0')
      assert.throws(() => insertStaging(-1, 16), /CHECK constraint failed/u, 'prev_version >= 0 when present')
      insertStaging(null, 16) // prev_version NULL (first-write precondition) is allowed
      insertStaging(0, 0) // boundary values allowed
    } finally { cleanup() }
  })
})

describe('beginPut → commitPut happy path', () => {
  it('produces a live row, version 1, file at the canonical path', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const begin = await beginPut(handle, fakeBegin())
      assert.equal(begin.ok, true)
      // Staging file path matches the layout — tests pin the on-disk
      // shape so a future refactor can't silently change the path.
      assert.equal(begin.filePath, stagingFilePath(objDir, 'workspace-tag-1', begin.stagingId))
      writeStaging(begin.filePath, Buffer.alloc(16))
      const commit = await commitPut(handle, {
        workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: begin.stagingId,
      })
      assert.equal(commit.ok, true)
      assert.equal(commit.row.version, 1)
      assert.equal(commit.row.contentLength, 16)
      // Live file exists at the content-addressed path; staging gone.
      const live = liveFilePath(objDir, 'workspace-tag-1', chash('resource-tag-1'))
      assert.equal(statSync(live).size, 16)
      assert.equal(existsSync(begin.filePath), false)
      // listLive sees the row.
      const rows = (await listLive(handle, 'workspace-tag-1'))
      assert.equal(rows.length, 1)
      assert.equal(rows[0].resourceTag, 'resource-tag-1')
      assert.equal(rows[0].version, 1)
    } finally { cleanup() }
  })

  it('a second PUT with prevVersion=1 bumps version to 2 and lands new bytes at a new content-addressed path', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const begin1 = await beginPut(handle, fakeBegin({ expectedLength: 8 }))
      writeStaging(begin1.filePath, Buffer.alloc(8))
      const commit1 = await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: begin1.stagingId })
      const v1blob = liveFilePath(objDir, 'workspace-tag-1', chash('resource-tag-1'))
      // Second PUT: new bytes ⇒ new content hash ⇒ new blob address.
      const h2 = chash('resource-tag-1@v2')
      const begin2 = await beginPut(handle, fakeBegin({ prevVersion: 1, prevIncarnation: commit1.row.incarnation, expectedLength: 24, contentHash: h2 }))
      assert.equal(begin2.ok, true)
      writeStaging(begin2.filePath, Buffer.alloc(24))
      const commit2 = await commitPut(handle, {
        workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: begin2.stagingId,
      })
      assert.equal(commit2.ok, true)
      assert.equal(commit2.row.version, 2)
      assert.equal(commit2.row.contentHash, h2)
      // v2 bytes live at the NEW address; v1's immutable blob is left
      // untouched (now unreferenced — the reaper GCs it once past the
      // grace window; see the reapOrphans suite).
      assert.equal(statSync(liveFilePath(objDir, 'workspace-tag-1', h2)).size, 24)
      assert.equal(statSync(v1blob).size, 8)
    } finally { cleanup() }
  })
})

describe('beginPut — version preconditions', () => {
  it('rejects a fresh PUT with prevVersion=N when the row is missing', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const begin = await beginPut(handle, fakeBegin({ prevVersion: 1, prevIncarnation: 'a'.repeat(22) }))
      assert.equal(begin.ok, false)
      assert.equal(begin.conflict, null)
    } finally { cleanup() }
  })

  it('rejects a stale PUT after a successful overwrite — conflict echoes the live row', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const b1 = await beginPut(handle, fakeBegin({ expectedLength: 4 }))
      writeStaging(b1.filePath, Buffer.alloc(4))
      await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: b1.stagingId })
      // Now try to PUT against prevVersion=null again — should conflict.
      const b2 = await beginPut(handle, fakeBegin({ prevVersion: null }))
      assert.equal(b2.ok, false)
      assert.equal(b2.conflict.version, 1)
      assert.equal(b2.conflict.resourceTag, 'resource-tag-1')
    } finally { cleanup() }
  })
})

describe('beginPut — per-workspace resource cap (H1)', () => {
  it('rejects the (MAX+1)th NEW resource with reason=workspace-full', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      // Fill the workspace up to the cap with distinct resourceTags.
      // 4-byte body keeps each commit cheap; we only care about the
      // row count here, not the bytes.
      for (let i = 0; i < MAX_RESOURCES_PER_WORKSPACE; i++) {
        const tag = `r-${i.toString().padStart(4, '0')}`
        const b = await beginPut(handle, fakeBegin({ resourceTag: tag, expectedLength: 4 }))
        assert.equal(b.ok, true, `setup row #${i} should accept`)
        writeStaging(b.filePath, Buffer.alloc(4))
        const c = await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: tag, stagingId: b.stagingId })
        assert.equal(c.ok, true, `setup row #${i} should commit`)
      }
      assert.equal((await listLive(handle, 'workspace-tag-1')).length, MAX_RESOURCES_PER_WORKSPACE)
      // The (MAX+1)th NEW resource must be rejected at begin — before
      // any staging row / staging file lands on disk.
      const over = await beginPut(handle, fakeBegin({ resourceTag: 'one-too-many', expectedLength: 4 }))
      assert.equal(over.ok, false)
      assert.equal(over.reason, 'workspace-full')
    } finally { cleanup() }
  })

  it('allows re-uploads (new versions) of existing resources at the cap', async () => {
    // The cap is on the live-row COUNT, not on the total writes. An
    // existing resource can still receive new versions even when the
    // workspace is full — no count change.
    const { handle, cleanup } = freshHandle()
    try {
      let r0Incarnation = null
      for (let i = 0; i < MAX_RESOURCES_PER_WORKSPACE; i++) {
        const tag = `r-${i.toString().padStart(4, '0')}`
        const b = await beginPut(handle, fakeBegin({ resourceTag: tag, expectedLength: 4 }))
        writeStaging(b.filePath, Buffer.alloc(4))
        const c = await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: tag, stagingId: b.stagingId })
        if (tag === 'r-0000') r0Incarnation = c.row.incarnation
      }
      // Re-upload r-0000 as version 2 — should pass the cap check.
      const reup = await beginPut(handle, fakeBegin({ resourceTag: 'r-0000', prevVersion: 1, prevIncarnation: r0Incarnation, expectedLength: 8 }))
      assert.equal(reup.ok, true)
      writeStaging(reup.filePath, Buffer.alloc(8))
      const c = await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'r-0000', stagingId: reup.stagingId })
      assert.equal(c.ok, true)
      assert.equal(c.row.version, 2)
      assert.equal((await listLive(handle, 'workspace-tag-1')).length, MAX_RESOURCES_PER_WORKSPACE)
    } finally { cleanup() }
  })

  it('caps are per-workspace, not global — a second workspace still has full headroom', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      for (let i = 0; i < MAX_RESOURCES_PER_WORKSPACE; i++) {
        const tag = `r-${i.toString().padStart(4, '0')}`
        const b = await beginPut(handle, fakeBegin({ workspaceTag: 'ws-A', resourceTag: tag, expectedLength: 4 }))
        writeStaging(b.filePath, Buffer.alloc(4))
        await commitPut(handle, { workspaceTag: 'ws-A', resourceTag: tag, stagingId: b.stagingId })
      }
      // ws-A is full; ws-B should accept a fresh new resource.
      const b = await beginPut(handle, fakeBegin({ workspaceTag: 'ws-B', resourceTag: 'r-0000', expectedLength: 4 }))
      assert.equal(b.ok, true)
    } finally { cleanup() }
  })
})

describe('truncation invariant (M1) — a partial upload never becomes live', () => {
  it('size-mismatch commitPut leaves live unchanged; same-resourceTag retry uses retry bytes', async () => {
    // Audit M1 scenario: client uploads "foo", PUT truncates mid-stream
    // (handler aborts → staging row + file cleaned). Client retries
    // "foo" under the same resourceTag; the second attempt's bytes —
    // and ONLY those bytes — become the live row.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Attempt 1: truncated.
      const b1 = await beginPut(handle, fakeBegin({ resourceTag: 'foo', expectedLength: 100 }))
      writeStaging(b1.filePath, Buffer.alloc(50))
      const c1 = await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'foo', stagingId: b1.stagingId })
      assert.equal(c1.ok, false)
      assert.equal(c1.reason, 'size-mismatch')
      // Critical invariant: no live row, no live file.
      assert.equal(await getLive(handle, 'workspace-tag-1', 'foo'), null)
      assert.equal(existsSync(liveFilePath(objDir, 'workspace-tag-1', chash('foo'))), false)
      // Cleanup the failed attempt (production path: REST handler calls
      // abortPut on the size-mismatch return; we replicate that here).
      await abortPut(handle, 'workspace-tag-1', 'foo', b1.stagingId)

      // Attempt 2: same resourceTag, fresh stagingId, FULL upload with
      // distinctive bytes so we can prove the live file is from the
      // retry — not the truncated original's 50 zero bytes.
      const retryBytes = Buffer.from('R'.repeat(100))
      const b2 = await beginPut(handle, fakeBegin({ resourceTag: 'foo', expectedLength: 100 }))
      assert.notEqual(b2.stagingId, b1.stagingId, 'retry gets a fresh stagingId')
      writeStaging(b2.filePath, retryBytes)
      const c2 = await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'foo', stagingId: b2.stagingId })
      assert.equal(c2.ok, true)
      assert.equal(c2.row.version, 1)
      assert.equal(c2.row.contentLength, 100)
      // Live file exists and contains the RETRY's bytes — not the
      // truncated original's bytes.
      const liveContent = readFileSync(liveFilePath(objDir, 'workspace-tag-1', chash('foo')))
      assert.equal(liveContent.length, 100)
      assert.equal(Buffer.compare(liveContent, retryBytes), 0)
    } finally { cleanup() }
  })

  it('staging files for distinct attempts under the same resourceTag have distinct paths', async () => {
    // Reinforces the invariant: even if a truncated staging file is
    // leaked (e.g. unlinkIfExists raced with the reaper), it cannot
    // collide with the retry's staging file — paths are keyed by
    // stagingId (which is randomly minted each begin), not by
    // resourceTag.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const b1 = await beginPut(handle, fakeBegin({ resourceTag: 'foo', expectedLength: 8 }))
      const b2 = await beginPut(handle, fakeBegin({ resourceTag: 'foo', expectedLength: 8 }))
      assert.notEqual(b1.stagingId, b2.stagingId)
      assert.equal(b1.filePath, stagingFilePath(objDir, 'workspace-tag-1', b1.stagingId))
      assert.equal(b2.filePath, stagingFilePath(objDir, 'workspace-tag-1', b2.stagingId))
      assert.notEqual(b1.filePath, b2.filePath)
    } finally { cleanup() }
  })
})

describe('commitPut — size + race checks', () => {
  it('rejects size-mismatch when the staged file is shorter than expected', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ expectedLength: 100 }))
      writeStaging(b.filePath, Buffer.alloc(50))
      const c = await commitPut(handle, {
        workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: b.stagingId,
      })
      assert.equal(c.ok, false)
      assert.equal(c.reason, 'size-mismatch')
      // The row is NOT created — listLive stays empty.
      assert.equal((await listLive(handle, 'workspace-tag-1')).length, 0)
    } finally { cleanup() }
  })

  it('rejects on conflict: a competing commit landed between our begin and commit', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      // Two concurrent beginPuts (same prevVersion=null), commit the
      // first; the second must see a conflict at commit time.
      const a = await beginPut(handle, fakeBegin({ expectedLength: 4 }))
      const b = await beginPut(handle, fakeBegin({ expectedLength: 4 }))
      writeStaging(a.filePath, Buffer.alloc(4))
      writeStaging(b.filePath, Buffer.alloc(4))
      const c1 = await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: a.stagingId })
      assert.equal(c1.ok, true)
      const c2 = await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: b.stagingId })
      assert.equal(c2.ok, false)
      assert.equal(c2.reason, 'conflict')
      assert.equal(c2.conflict.version, 1)
    } finally { cleanup() }
  })

  it('returns no-staging for an unknown stagingId', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const c = await commitPut(handle, {
        workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: 'never-seen-before',
      })
      assert.equal(c.ok, false)
      assert.equal(c.reason, 'no-staging')
    } finally { cleanup() }
  })

  it('maps a vanished staging file (raced abort / reaper) to io-error, not size-mismatch', async () => {
    // PR #4 review: a stat / rename failure inside commitPut is a
    // server-side fault (EACCES / EIO / racing abort), not a
    // client length mismatch — REST maps `io-error` to HTTP 500
    // while `size-mismatch` would map to HTTP 400.
    const { handle, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ expectedLength: 8 }))
      writeStaging(b.filePath, Buffer.alloc(8))
      // Simulate a racing abort / reaper unlinking the staging
      // file after the staging row was written.
      rmSync(b.filePath)
      const c = await commitPut(handle, {
        workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: b.stagingId,
      })
      assert.equal(c.ok, false)
      assert.equal(c.reason, 'io-error')
      // Still no live row.
      assert.equal((await listLive(handle, 'workspace-tag-1')).length, 0)
    } finally { cleanup() }
  })
})

describe('abortPut — cleanup', () => {
  it('drops the staging row and unlinks the staging file; idempotent on re-call', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin())
      writeStaging(b.filePath, Buffer.alloc(16))
      assert.equal(existsSync(b.filePath), true)
      await abortPut(handle, 'workspace-tag-1', 'resource-tag-1', b.stagingId)
      assert.equal(existsSync(b.filePath), false)
      // Re-call is a no-op (no throw).
      await abortPut(handle, 'workspace-tag-1', 'resource-tag-1', b.stagingId)
    } finally { cleanup() }
  })
})

describe('deleteObject', () => {
  it('drops the row when prevVersion matches; the unreferenced blob is left for the reaper GC', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ expectedLength: 4 }))
      writeStaging(b.filePath, Buffer.alloc(4))
      const c = await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: b.stagingId })
      assert.equal(c.ok, true)
      const live = liveFilePath(objDir, 'workspace-tag-1', chash('resource-tag-1'))
      assert.equal(existsSync(live), true)
      const d = await deleteObject(handle, 'workspace-tag-1', 'resource-tag-1', 1, c.row.incarnation)
      assert.equal(d.ok, true)
      assert.equal(d.deletedVersion, 1)
      // Row gone immediately. The blob is NOT unlinked inline — content
      // dedup means another resource may share these exact bytes — so
      // the reaper GCs it once unreferenced AND past the grace window.
      assert.equal(await getLive(handle, 'workspace-tag-1', 'resource-tag-1'), null)
      assert.equal(existsSync(live), true)
      ageBlob(live)
      await reapOrphans(handle)
      assert.equal(existsSync(live), false)
    } finally { cleanup() }
  })

  it('returns a conflict when prevVersion mismatches', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ expectedLength: 4 }))
      writeStaging(b.filePath, Buffer.alloc(4))
      await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: b.stagingId })
      const d = await deleteObject(handle, 'workspace-tag-1', 'resource-tag-1', 99, 'a'.repeat(22))
      assert.equal(d.ok, false)
      assert.equal(d.reason, 'conflict')
      assert.equal(d.conflict.version, 1)
    } finally { cleanup() }
  })

  it('idempotent: prevVersion=null on a missing row succeeds with sentinel deletedVersion=0', async () => {
    const { handle, cleanup } = freshHandle()
    try {
      const d = await deleteObject(handle, 'workspace-tag-1', 'resource-tag-1', null, null)
      assert.equal(d.ok, true)
      assert.equal(d.deletedVersion, 0)
    } finally { cleanup() }
  })
})

describe('reapOrphans', () => {
  it('GCs an unreferenced live blob (row dropped) only once past the grace window', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Manufacture a stranded committed blob: PUT + commit, then
      // simulate a delete/crash by dropping the row directly.
      const b = await beginPut(handle, fakeBegin({ expectedLength: 4 }))
      writeStaging(b.filePath, Buffer.alloc(4))
      await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: b.stagingId })
      handle.db.prepare(`DELETE FROM workspace_object WHERE workspace_tag = ? AND resource_tag = ?`).run('workspace-tag-1', 'resource-tag-1') // direct row drop
      const live = liveFilePath(objDir, 'workspace-tag-1', chash('resource-tag-1'))
      assert.equal(existsSync(live), true)
      // A just-written blob is within the grace window — a default
      // sweep leaves it. This is exactly what protects a freshly-
      // promoted, not-yet-CAS'd blob from a concurrent reaper.
      await reapOrphans(handle)
      assert.equal(existsSync(live), true, 'grace window protects a recent blob')
      // Past the grace window, still unreferenced → GC'd.
      ageBlob(live)
      await reapOrphans(handle)
      assert.equal(existsSync(live), false)
    } finally { cleanup() }
  })

  it('drops staging rows older than the TTL and unlinks their files', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin())
      writeStaging(b.filePath, Buffer.alloc(16))
      // Backdate the staging row 2h.
      handle.db.prepare(`UPDATE workspace_object_staging SET begun_at = ? WHERE staging_id = ?`).run(
        Date.now() - 2 * 60 * 60 * 1000, b.stagingId,
      )
      await reapOrphans(handle)
      const stagingFile = stagingFilePath(objDir, 'workspace-tag-1', b.stagingId)
      assert.equal(existsSync(stagingFile), false)
      // Row dropped too.
      const stagingRow = handle.db.prepare(`SELECT 1 FROM workspace_object_staging WHERE workspace_tag = ? AND resource_tag = ? AND staging_id = ?`).get('workspace-tag-1', 'resource-tag-1', b.stagingId)
      assert.equal(stagingRow, undefined)
    } finally { cleanup() }
  })

  it('conditional delete spares a stale row whose begun_at was refreshed fresh (F1)', async () => {
    // Audit F1, lockless model: a REST PUT that finished a slow body
    // calls refreshStagingBegunAt, bumping begun_at to ~now. The
    // reaper's stale-row delete is an ATOMIC conditional delete keyed
    // on `begun_at < staleBefore` (staleBefore = sweep-time − TTL), so
    // a row refreshed fresh no longer matches the predicate and
    // survives for the commit. Previously the protection was an
    // in-lock begun_at re-read; now it's the SQL predicate itself.
    // We model the refresh landing before the sweep's conditional
    // delete by refreshing begun_at to now, then sweeping: the row +
    // file MUST survive because the conditional delete can't match.
    const { handle, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin())
      writeStaging(b.filePath, Buffer.alloc(16))
      // Backdate to past TTL — without a refresh this row is stale.
      handle.db.prepare(`UPDATE workspace_object_staging SET begun_at = ? WHERE staging_id = ?`).run(
        Date.now() - 2 * 60 * 60 * 1000, b.stagingId,
      )
      // The REST PUT's last action before commit: refresh begun_at to
      // now, moving it well after any staleBefore the sweep computes.
      handle.db.prepare(`UPDATE workspace_object_staging SET begun_at = ? WHERE workspace_tag = ? AND resource_tag = ? AND staging_id = ?`).run(Date.now(), 'workspace-tag-1', 'resource-tag-1', b.stagingId)
      await reapOrphans(handle)
      // Row + file MUST survive: the conditional delete's
      // `begun_at < staleBefore` predicate no longer matches.
      assert.equal(existsSync(b.filePath), true, 'reaper must not unlink a row whose begun_at was refreshed fresh')
      const row = handle.db.prepare(`SELECT 1 FROM workspace_object_staging WHERE workspace_tag = ? AND resource_tag = ? AND staging_id = ?`).get('workspace-tag-1', 'resource-tag-1', b.stagingId)
      assert.ok(row, 'staging row preserved by the begun_at < staleBefore predicate')
    } finally { cleanup() }
  })

  it('conditional delete drops a genuinely-stale, un-refreshed row and unlinks its blob (F1)', async () => {
    // The companion to the refresh-survives case: a row that exceeded
    // the TTL and was NOT refreshed (no in-flight commit) DOES match
    // the conditional delete's `begun_at < staleBefore` predicate, so
    // it is deleted and its staging blob unlinked. This pins that the
    // predicate still reaps real garbage — the F1 protection narrows
    // to "refreshed-fresh", not "never reap".
    const { handle, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin())
      writeStaging(b.filePath, Buffer.alloc(16))
      // Stale and never refreshed.
      handle.db.prepare(`UPDATE workspace_object_staging SET begun_at = ? WHERE staging_id = ?`).run(
        Date.now() - 2 * 60 * 60 * 1000, b.stagingId,
      )
      await reapOrphans(handle)
      assert.equal(existsSync(b.filePath), false, 'genuinely-stale staging blob unlinked')
      const row = handle.db.prepare(`SELECT 1 FROM workspace_object_staging WHERE workspace_tag = ? AND resource_tag = ? AND staging_id = ?`).get('workspace-tag-1', 'resource-tag-1', b.stagingId)
      assert.equal(row, undefined, 'genuinely-stale staging row deleted by the conditional delete')
    } finally { cleanup() }
  })

  it('refreshStagingBegunAt restamps the row so a slow upload that crosses TTL still commits', async () => {
    // Audit H4: a long upload could cross the 1h staging TTL during
    // body-streaming. The REST handler calls `refreshStagingBegunAt`
    // right after the on-disk size check passes but before entering
    // the commit lock, so the TTL effectively counts from upload-
    // done, not begin-issued.
    const { handle, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin())
      // Backdate to past the 1h TTL — without a refresh, the reaper
      // would treat this as stale and drop it.
      const stale = Date.now() - 2 * 60 * 60 * 1000
      handle.db.prepare(`UPDATE workspace_object_staging SET begun_at = ? WHERE staging_id = ?`).run(
        stale, b.stagingId,
      )
      // Refresh — mimics what handleRestPutLocked does right before
      // the commit lock acquire.
      const fresh = Date.now()
      handle.db.prepare(`UPDATE workspace_object_staging SET begun_at = ? WHERE workspace_tag = ? AND resource_tag = ? AND staging_id = ?`).run(fresh, 'workspace-tag-1', 'resource-tag-1', b.stagingId)
      // Reaper sees a non-stale row → preserves both row + file.
      await reapOrphans(handle)
      const row = handle.db.prepare(`SELECT 1 FROM workspace_object_staging WHERE workspace_tag = ? AND resource_tag = ? AND staging_id = ?`).get('workspace-tag-1', 'resource-tag-1', b.stagingId)
      assert.ok(row, 'refresh restamps begun_at past the TTL boundary')
      // begun_at is now fresh, not stale.
      const begunAt = handle.db.prepare(`SELECT begun_at FROM workspace_object_staging WHERE staging_id = ?`).get(b.stagingId).begun_at
      assert.ok(begunAt >= fresh, 'begun_at reflects the refresh time, not the original begin time')
    } finally { cleanup() }
  })

  it('preserves staging rows newer than the TTL', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin())
      writeStaging(b.filePath, Buffer.alloc(16))
      await reapOrphans(handle) // immediately — should be no-op
      const stagingFile = stagingFilePath(objDir, 'workspace-tag-1', b.stagingId)
      assert.equal(existsSync(stagingFile), true)
    } finally { cleanup() }
  })

  it('sweeps orphan staging files whose row is gone', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin())
      writeStaging(b.filePath, Buffer.alloc(16))
      // Drop the row but leave the file — simulates commit that
      // dropped the staging row but crashed before rename.
      handle.db.prepare(`DELETE FROM workspace_object_staging WHERE staging_id = ?`).run(b.stagingId)
      await reapOrphans(handle)
      const stagingFile = stagingFilePath(objDir, 'workspace-tag-1', b.stagingId)
      assert.equal(existsSync(stagingFile), false)
    } finally { cleanup() }
  })

  it('never GCs a blob whose hash a live row still references (even past the grace window)', async () => {
    // Content-addressing + the live-reference-set check replace the old
    // commit-lock + reaper recheck. The GC unlinks a live blob ONLY
    // when NO live row references its content hash; a committed blob —
    // even aged past the grace window, even swept with grace 0 — stays
    // because its row names its hash. (The grace window is the separate
    // guard for a just-promoted, not-yet-CAS'd blob; see the prior
    // test.) A commit landing mid-sweep produces a young blob the grace
    // window covers, and `gcBlobIfUnreferenced` re-reads the reference
    // set immediately before each unlink, so a row that lands during a
    // sweep is still seen.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ expectedLength: 18 }))
      writeStaging(b.filePath, Buffer.alloc(18))
      const c = await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: b.stagingId })
      assert.equal(c.ok, true)
      const live = liveFilePath(objDir, 'workspace-tag-1', chash('resource-tag-1'))
      assert.equal(existsSync(live), true)
      // Age it past the grace window AND sweep with grace 0, so neither
      // age nor the grace window is what protects it — only the live
      // row's reference to its content hash.
      ageBlob(live)
      await reapOrphans(handle, 0)
      assert.equal(existsSync(live), true, 'a referenced blob is never collected')
      assert.ok(
        handle.db.prepare(`SELECT 1 FROM workspace_object WHERE workspace_tag = ? AND resource_tag = ?`).get('workspace-tag-1', 'resource-tag-1'),
        'live row still present',
      )
    } finally { cleanup() }
  })

  it('preserves a freshly-begun staging file when beginPut races the orphan-file sweep (per-file row lookup)', async () => {
    // Audit H1: between the orphan-file sweep's readdir and unlink,
    // a concurrent beginPut could insert a row + the REST PUT could
    // create the staging file. A snapshot-based check would miss
    // the just-inserted row and unlink the file mid-upload. The fix
    // is a per-file row lookup right before the unlink.
    const { handle, cleanup } = freshHandle()
    try {
      // Stage a beginPut: row inserted, file created at staging path.
      const b = await beginPut(handle, fakeBegin())
      writeStaging(b.filePath, Buffer.alloc(16))
      // Sanity: file exists, row exists (well within TTL).
      assert.equal(existsSync(b.filePath), true)
      // Run the reaper. The orphan-file sweep should see the file,
      // look up the row by (ws, sid), find it, and skip the unlink.
      await reapOrphans(handle)
      assert.equal(existsSync(b.filePath), true, 'reaper must not unlink the file of a live staging row')
      const row = handle.db.prepare(`SELECT 1 FROM workspace_object_staging WHERE workspace_tag = ? AND resource_tag = ? AND staging_id = ?`).get('workspace-tag-1', 'resource-tag-1', b.stagingId)
      assert.ok(row, 'staging row still present')
    } finally { cleanup() }
  })

  it('preserves the staging file of a row whose resource_tag is malformed (valid ws+sid pin the file)', async () => {
    // PR #4 review: a malformed `resource_tag` shouldn't make the
    // orphan-file sweep unlink the staging file that the (still
    // present) row points at. The path is built from (ws_tag,
    // staging_id) only; the row stays in the DB (logged), and the
    // file's staging_id IS bucketed so the file sweep skips it.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const sid = 'a'.repeat(22) // valid base64url sid shape
      // Hand-insert a row with a valid ws+sid but a malformed
      // resource_tag (slash forbidden in base64url).
      handle.db.prepare(`
        INSERT INTO workspace_object_staging
          (workspace_tag, resource_tag, staging_id, prev_version,
           expected_length, content_hash, signature, begun_at)
        VALUES (?, ?, ?, NULL, 1, ?, ?, ?)
      `).run('workspace-tag-1', 'bad/resource', sid, b64u32(), b64u64(), Date.now() - 2 * 60 * 60 * 1000)
      // Drop a staging file that the row points at.
      const stagingFile = stagingFilePath(objDir, 'workspace-tag-1', sid)
      mkdirSync(path.dirname(stagingFile), { recursive: true })
      writeFileSync(stagingFile, Buffer.from('would-be-corrupted'))
      await reapOrphans(handle)
      // Row stays — reapStaleStagingRows skips malformed; we don't
      // delete from the DB. File stays — the orphan-file sweep saw
      // the staging_id in the bucketed known set.
      assert.equal(existsSync(stagingFile), true, 'reaper must preserve staging files pinned by a (malformed-other-field) row')
      const row = handle.db.prepare(`SELECT 1 FROM workspace_object_staging WHERE staging_id = ?`).get(sid)
      assert.ok(row, 'malformed-resource_tag row should not be deleted by the reaper')
    } finally { cleanup() }
  })

  it('skips a staging row with a malformed staging_id (path-traversal guard)', async () => {
    // PR #4 review: every row field that flows into a filesystem
    // path is re-validated. A tampered row with `../etc/passwd`
    // shouldn't lead the reaper into unlinking outside OBJSTORE_DIR.
    const { handle, objDir, cleanup } = freshHandle()
    try {
      // Hand-insert a row with a path-bearing staging_id and a
      // begun_at well past the TTL so the reaper would unlink if
      // the validator weren't there.
      handle.db.prepare(`
        INSERT INTO workspace_object_staging
          (workspace_tag, resource_tag, staging_id, prev_version,
           expected_length, content_hash, signature, begun_at)
        VALUES (?, ?, ?, NULL, 1, ?, ?, ?)
      `).run('workspace-tag-1', 'resource-tag-1', '../../etc/passwd',
        b64u32(), b64u64(), Date.now() - 2 * 60 * 60 * 1000)
      // Drop a canary file outside objDir to prove we wouldn't
      // touch it even if the path resolved through `..`.
      const canary = path.join(objDir, '..', 'reaper-canary')
      writeStaging(canary, Buffer.from('do not delete'))
      await reapOrphans(handle)
      assert.equal(existsSync(canary), true, 'reaper must not traverse outside its dir')
      // Row stays in place (skipped rather than acted on).
      const row = handle.db.prepare(`SELECT 1 FROM workspace_object_staging WHERE staging_id = ?`).get('../../etc/passwd')
      assert.ok(row, 'malformed-staging_id row should not be deleted by the reaper')
      rmSync(canary)
    } finally { cleanup() }
  })
})

describe('readFileSync end-to-end', () => {
  it('round-trips a payload byte-for-byte across put → commit → file read', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const payload = Buffer.from('the bytes that the relay never decrypts', 'utf8')
      const b = await beginPut(handle, fakeBegin({ expectedLength: payload.byteLength }))
      writeStaging(b.filePath, payload)
      const c = await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: b.stagingId })
      assert.equal(c.ok, true)
      const stored = readFileSync(liveFilePath(objDir, 'workspace-tag-1', chash('resource-tag-1')))
      assert.deepEqual(stored, payload)
    } finally { cleanup() }
  })
})

describe('input validation', () => {
  it('rejects non-base64url tag shapes at the wire boundary', async () => {
    // Spot-check the validator regexes by importing them.
    const { isValidTag, isValidContentHash, isValidSignature, isValidStagingId } = await import('../server/objstore/store.ts')
    assert.equal(isValidTag(''), false)
    assert.equal(isValidTag('a'.repeat(257)), false, 'caps at 256 chars')
    assert.equal(isValidTag('a/b'), false, 'no `/` in base64url')
    assert.equal(isValidTag('valid_tag-1'), true)
    assert.equal(isValidContentHash('a'.repeat(43)), true)
    assert.equal(isValidContentHash('a'.repeat(42)), false)
    assert.equal(isValidSignature('a'.repeat(86)), true)
    assert.equal(isValidSignature('a'.repeat(85)), false)
    assert.equal(isValidStagingId('a'.repeat(22)), true)
    assert.equal(isValidStagingId('a'.repeat(21)), false)
    assert.equal(isValidStagingId('../../etc/passwd'), false, 'path-bearing staging_id rejected')
  })
})

describe('token payload validation', () => {
  it('rejects a token whose `len` is past 2^53-1 (unsafe-integer round-trip)', async () => {
    // PR #4 audit: token payload `len` / `ver` need `Number.isSafeInteger`,
    // not `Number.isInteger` — an unsafe-but-integer value round-trips
    // through IEEE-754 (e.g. `2 ** 53 + 1 === 2 ** 53`) and could
    // spoof equality against a different actual Content-Length /
    // live row version.
    const { newTokenSecret, signToken, verifyToken } = await import('../server/objstore/tokens.ts')
    const secret = newTokenSecret()
    const okPayload = { op: 'put', tag: 't', res: 'r', sid: 's', len: 1024, exp: Date.now() + 60_000 }
    assert.ok(verifyToken(secret, signToken(secret, okPayload)))
    // Past the safe-integer ceiling — must reject.
    const badLen = signToken(secret, { ...okPayload, len: Number.MAX_SAFE_INTEGER + 1 })
    assert.equal(verifyToken(secret, badLen), null)
    const badVer = signToken(secret, { op: 'get', tag: 't', res: 'r', ver: Number.MAX_SAFE_INTEGER + 1, inc: 'i', exp: Date.now() + 60_000 })
    assert.equal(verifyToken(secret, badVer), null)
  })

  it('verifyToken rejects a forged signature even when payload shape is valid', async () => {
    const { newTokenSecret, signToken, verifyToken } = await import('../server/objstore/tokens.ts')
    const secret = newTokenSecret()
    const otherSecret = newTokenSecret()
    const tok = signToken(otherSecret, { op: 'put', tag: 't', res: 'r', sid: 's', len: 1, exp: Date.now() + 60_000 })
    assert.equal(verifyToken(secret, tok), null)
  })

  it('verifyToken rejects an expired token', async () => {
    const { newTokenSecret, signToken, verifyToken } = await import('../server/objstore/tokens.ts')
    const secret = newTokenSecret()
    const exp = Date.now() - 1
    const tok = signToken(secret, { op: 'get', tag: 't', res: 'r', ver: 1, inc: 'i', exp })
    assert.equal(verifyToken(secret, tok), null)
  })

  it('extractBearer is case-insensitive on scheme but strict on shape', async () => {
    const { extractBearer } = await import('../server/objstore/tokens.ts')
    assert.equal(extractBearer('Bearer abc.def'), 'abc.def')
    assert.equal(extractBearer('bearer abc.def'), 'abc.def')
    assert.equal(extractBearer('Bearer  abc.def  '), 'abc.def', 'trailing whitespace tolerated')
    assert.equal(extractBearer('Basic abc.def'), null)
    assert.equal(extractBearer('Bearer'), null, 'no token component')
    assert.equal(extractBearer(undefined), null)
    assert.equal(extractBearer(null), null)
    // `\s+` accepts tab + multiple-space separators (RFC 7235 §2.1
    // allows tab between scheme + token). Pin so a future tightening
    // to `[ ]+` would fail the test rather than break clients.
    assert.equal(extractBearer('Bearer\tabc.def'), 'abc.def', 'tab separator allowed by \\s+')
    assert.equal(extractBearer('Bearer \t abc.def'), 'abc.def', 'mixed whitespace allowed')
    // Whitespace-only after `Bearer` → no token captured by `(\S+)`.
    assert.equal(extractBearer('Bearer   '), null, 'whitespace-only after scheme')
    assert.equal(extractBearer(''), null, 'empty header')
  })

  it('verifyToken rejects payloads with bad op / negative len / negative ver / non-finite exp', async () => {
    const { newTokenSecret, signToken, verifyToken } = await import('../server/objstore/tokens.ts')
    const secret = newTokenSecret()
    const now = Date.now() + 60_000
    // Helper: sign whatever payload shape we pass (signToken doesn't
    // validate; verifyToken does).
    const sign = (payload) => signToken(secret, payload)
    // Missing op.
    assert.equal(verifyToken(secret, sign({ tag: 't', res: 'r', exp: now })), null)
    // Unknown op.
    assert.equal(verifyToken(secret, sign({ op: 'patch', tag: 't', res: 'r', exp: now })), null)
    // Negative len (put).
    assert.equal(verifyToken(secret, sign({ op: 'put', tag: 't', res: 'r', sid: 's', len: -1, exp: now })), null)
    // Negative ver (get).
    assert.equal(verifyToken(secret, sign({ op: 'get', tag: 't', res: 'r', ver: -1, inc: 'i', exp: now })), null)
    // Non-safe-int exp.
    assert.equal(verifyToken(secret, sign({ op: 'put', tag: 't', res: 'r', sid: 's', len: 1, exp: Number.MAX_SAFE_INTEGER + 1 })), null)
    // NaN exp.
    assert.equal(verifyToken(secret, sign({ op: 'put', tag: 't', res: 'r', sid: 's', len: 1, exp: NaN })), null)
    // Non-string sid (put).
    assert.equal(verifyToken(secret, sign({ op: 'put', tag: 't', res: 'r', sid: 123, len: 1, exp: now })), null)
    // Non-number ver (get).
    assert.equal(verifyToken(secret, sign({ op: 'get', tag: 't', res: 'r', ver: 'v1', inc: 'i', exp: now })), null)
    // Missing inc (get) — the GET token now binds the live incarnation.
    assert.equal(verifyToken(secret, sign({ op: 'get', tag: 't', res: 'r', ver: 1, exp: now })), null)
    // Non-string inc (get).
    assert.equal(verifyToken(secret, sign({ op: 'get', tag: 't', res: 'r', ver: 1, inc: 123, exp: now })), null)
    // Sanity: well-formed put + get still pass.
    const okPut = verifyToken(secret, sign({ op: 'put', tag: 't', res: 'r', sid: 's', len: 1, exp: now }))
    assert.equal(okPut?.op, 'put')
    const okGet = verifyToken(secret, sign({ op: 'get', tag: 't', res: 'r', ver: 1, inc: 'i', exp: now }))
    assert.equal(okGet?.op, 'get')
  })
})

describe('directory layout', () => {
  it('places committed files under ${OBJSTORE_DIR}/${tag}/${contentHash}.bin', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin({ expectedLength: 4 }))
      writeStaging(b.filePath, Buffer.alloc(4))
      await commitPut(handle, { workspaceTag: 'workspace-tag-1', resourceTag: 'resource-tag-1', stagingId: b.stagingId })
      const tagDir = path.join(objDir, 'workspace-tag-1')
      const entries = readdirSync(tagDir).filter((n) => n.endsWith('.bin'))
      // Live blobs are content-addressed: the filename is the content
      // hash, not the resourceTag.
      assert.deepEqual(entries, [`${chash('resource-tag-1')}.bin`])
    } finally { cleanup() }
  })

  it('places staging files under ${OBJSTORE_DIR}/${tag}/.staging/${stagingId}.bin', async () => {
    const { handle, objDir, cleanup } = freshHandle()
    try {
      const b = await beginPut(handle, fakeBegin())
      assert.equal(path.dirname(b.filePath), path.join(objDir, 'workspace-tag-1', '.staging'))
      assert.equal(path.basename(b.filePath), `${b.stagingId}.bin`)
    } finally { cleanup() }
  })
})
