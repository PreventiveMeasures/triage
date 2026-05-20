// Neon Postgres backend for the v1.objstore tables. Mirrors the
// SQLite-backed `openObjstore` in ./store.ts — same `Handle` shape
// (with `db: DatabaseSync` unset), same queries by intent, Postgres
// dialect on the wire.
//
// `@neondatabase/serverless` is an OPTIONAL peer dep — selected by
// the `DATABASE_URL` branch in `server/index.ts`. The peer dep
// itself is loaded lazily inside `openNeonObjstore` below. A single
// Neon project / database holds both `workspace_revision` and the
// two objstore tables; each plane opens its own stateless
// `neon(url)` HTTP callable independently — there is no shared
// connection. Calling `neon()` is cheap; no resource is held to
// release.
//
// Byte plane: passed in as a `BlobBackend` (./blob.ts). The
// supported pairings selected by server/index.ts are:
//   - Neon + Vercel Blob Private Storage (multi-replica, the only
//     pairing that survives a replica restart without local-disk
//     coordination). Activated by setting BLOB_READ_WRITE_TOKEN
//     alongside DATABASE_URL.
//   - Neon + local FS (development / operator escape hatch — bytes
//     still need to live on a shared filesystem if you run more
//     than one replica).

import type { BlobBackend } from './blob.ts'
import { KeyedAsyncLock } from './lock.ts'
import type { AllStmt, GetStmt, RunStmt } from '../db-stmt.ts'
import type { Handle } from './store.ts'
import { type NeonSql, assertDurableSyncCommit, getRowStmt, num, numOrNull, runStmt } from '../db-neon.ts'

// Advisory-lock keys (two int32s for the two-arg form). Distinct
// from the workspace_revision DDL keys in `db-neon.ts` so the two
// bootstraps don't serialize against each other. See db-neon.ts for
// the choice rationale.
const DDL_LOCK_KEY_OBJSTORE = 0x6465_7670 // 'depv'
const DDL_LOCK_KEY_OBJSTORE_SUB = 0x6f62_6a73 // 'objs'

// Statement-per-array-element because Neon's HTTP transport runs
// one statement per request — there's no multi-statement support
// like SQLite's `db.exec`. The DDL bootstrap in `openNeonObjstore`
// wraps the full array in a pipelined `sql.transaction` so the
// whole schema either applies or rolls back, AND grabs a
// transaction-scoped advisory lock so concurrent boots serialize.
//
// `CHECK (version >= 0)` / `CHECK (content_length >= 0)` defend the
// commitPut conflict arithmetic — a manual `UPDATE workspace_object
// SET version = -1` would otherwise round-trip through `num()`
// (which only rejects non-safe-integers) and corrupt the version
// monotonicity invariant. Same vector covered for SQLite by the
// STRICT type affinity + boot-time `pragma_table_list` check.
const SCHEMA_PG = [
  `CREATE TABLE IF NOT EXISTS workspace_object (
     workspace_tag  TEXT    NOT NULL,
     resource_tag   TEXT    NOT NULL,
     version        BIGINT  NOT NULL CHECK (version >= 0),
     content_hash   TEXT    NOT NULL,
     content_length BIGINT  NOT NULL CHECK (content_length >= 0),
     signature      TEXT    NOT NULL,
     put_at         BIGINT  NOT NULL,
     PRIMARY KEY (workspace_tag, resource_tag)
   )`,
  `CREATE TABLE IF NOT EXISTS workspace_object_staging (
     workspace_tag   TEXT    NOT NULL,
     resource_tag    TEXT    NOT NULL,
     staging_id      TEXT    NOT NULL,
     prev_version    BIGINT  CHECK (prev_version IS NULL OR prev_version >= 0),
     expected_length BIGINT  NOT NULL CHECK (expected_length >= 0),
     content_hash    TEXT    NOT NULL,
     signature       TEXT    NOT NULL,
     begun_at        BIGINT  NOT NULL,
     PRIMARY KEY (workspace_tag, resource_tag, staging_id)
   )`,
  `CREATE INDEX IF NOT EXISTS workspace_object_staging_begun_at_idx
     ON workspace_object_staging (begun_at)`,
  // Distributed commit mutex — see store.ts SCHEMA for rationale.
  // `expires_at` is set from `(EXTRACT(EPOCH FROM NOW())*1000)::BIGINT
  // + lease_ms` and the steal predicate also compares against the DB
  // server's NOW() — NEVER the caller's Date.now(). This anchoring
  // closes the clock-skew theft scenario where a replica with a
  // fast wall clock would read a peer's fresh lease as expired and
  // steal it, causing concurrent commitPut → silent data corruption.
  `CREATE TABLE IF NOT EXISTS workspace_object_commit_lock (
     workspace_tag  TEXT   NOT NULL,
     resource_tag   TEXT   NOT NULL,
     holder         TEXT   NOT NULL,
     expires_at     BIGINT NOT NULL,
     PRIMARY KEY (workspace_tag, resource_tag)
   )`,
]

// `num` / `numOrNull` (safe-integer BIGINT coercion) are shared with
// the workspace_revision Neon plane — imported from ../db-neon.ts so
// the two planes can't drift on the coercion / range-check rules.

type LiveDbRow = {
  resource_tag: string; version: number; content_hash: string; content_length: number
  signature: string; put_at: number
}

function mapLiveRow(r: Record<string, unknown>): LiveDbRow {
  return {
    resource_tag: String(r['resource_tag']),
    version: num(r['version']),
    content_hash: String(r['content_hash']),
    content_length: num(r['content_length']),
    signature: String(r['signature']),
    put_at: num(r['put_at']),
  }
}

// Per-statement builders — extracted so `openNeonObjstore` stays
// within the max-lines-per-function budget. Each closes over the
// Neon `sql` callable.

function buildInsertStaging(sql: NeonSql): RunStmt<[string, string, string, number | null, number, string, string, number]> {
  return runStmt(sql, `INSERT INTO workspace_object_staging
         (workspace_tag, resource_tag, staging_id, prev_version,
          expected_length, content_hash, signature, begun_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`)
}

type StagingRow = {
  prev_version: number | null
  expected_length: number
  content_hash: string
  signature: string
  begun_at: number
}

function buildSelectStaging(sql: NeonSql): GetStmt<[string, string, string], StagingRow> {
  return { get: async (tag, resourceTag, stagingId) => {
    const rows = await sql(
      `SELECT prev_version, expected_length, content_hash, signature, begun_at
       FROM workspace_object_staging
       WHERE workspace_tag = $1 AND resource_tag = $2 AND staging_id = $3`,
      [tag, resourceTag, stagingId],
    ) as Array<Record<string, unknown>>
    const r = rows[0]
    if (!r) return undefined
    return {
      prev_version: numOrNull(r['prev_version']),
      expected_length: num(r['expected_length']),
      content_hash: String(r['content_hash']),
      signature: String(r['signature']),
      begun_at: num(r['begun_at']),
    }
  } }
}

function buildSelectStagingByWsSid(sql: NeonSql): GetStmt<[string, string], unknown> {
  return getRowStmt(sql, `SELECT 1 AS one FROM workspace_object_staging WHERE workspace_tag = $1 AND staging_id = $2`)
}

function buildRefreshStagingBegunAt(sql: NeonSql): RunStmt<[number, string, string, string]> {
  return runStmt(sql, `UPDATE workspace_object_staging SET begun_at = $1
       WHERE workspace_tag = $2 AND resource_tag = $3 AND staging_id = $4`)
}

function buildDeleteStaging(sql: NeonSql): RunStmt<[string, string, string]> {
  return runStmt(sql, `DELETE FROM workspace_object_staging
       WHERE workspace_tag = $1 AND resource_tag = $2 AND staging_id = $3`)
}

function buildSelectLive(sql: NeonSql): AllStmt<[string], LiveDbRow> {
  return { all: async (tag) => {
    const rows = await sql(
      `SELECT resource_tag, version, content_hash, content_length,
              signature, put_at
       FROM workspace_object
       WHERE workspace_tag = $1
       ORDER BY resource_tag ASC`,
      [tag],
    ) as Array<Record<string, unknown>>
    return rows.map(mapLiveRow)
  } }
}

function buildSelectLiveOne(sql: NeonSql): GetStmt<[string, string], LiveDbRow> {
  return { get: async (tag, resourceTag) => {
    const rows = await sql(
      `SELECT resource_tag, version, content_hash, content_length,
              signature, put_at
       FROM workspace_object
       WHERE workspace_tag = $1 AND resource_tag = $2`,
      [tag, resourceTag],
    ) as Array<Record<string, unknown>>
    const r = rows[0]
    return r ? mapLiveRow(r) : undefined
  } }
}

function buildUpsertLive(sql: NeonSql): RunStmt<[string, string, number, string, number, string, number]> {
  return runStmt(sql, `INSERT INTO workspace_object
         (workspace_tag, resource_tag, version, content_hash, content_length,
          signature, put_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workspace_tag, resource_tag) DO UPDATE SET
         version        = EXCLUDED.version,
         content_hash   = EXCLUDED.content_hash,
         content_length = EXCLUDED.content_length,
         signature      = EXCLUDED.signature,
         put_at         = EXCLUDED.put_at`)
}

// Conditional upsert that gates on the commit-lock still being
// held by `holder` with a fresh `expires_at`. Same single-
// statement atomicity as the SQLite version (the WHERE EXISTS
// evaluates against the same snapshot as the INSERT). Returns
// `{ committed: 1 }` on success, undefined when the lease was
// stolen / expired during the long upload phase. Both `expires_at`
// and the time comparison anchor to the DB SERVER's NOW(), not
// the caller's clock — clock-skew between replicas can't cause
// the gate to incorrectly pass.
function buildUpsertLiveIfHeld(sql: NeonSql): GetStmt<[string, string, number, string, number, string, number, string], { committed: number }> {
  return { get: async (tag, resourceTag, version, contentHash, contentLength, signature, putAt, holder) => {
    const rows = await sql(
      `INSERT INTO workspace_object
         (workspace_tag, resource_tag, version, content_hash, content_length,
          signature, put_at)
       SELECT $1, $2, $3, $4, $5, $6, $7
       WHERE EXISTS (
         SELECT 1 FROM workspace_object_commit_lock
         WHERE workspace_tag = $1 AND resource_tag = $2 AND holder = $8
           AND expires_at > (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
       )
       ON CONFLICT (workspace_tag, resource_tag) DO UPDATE SET
         version        = EXCLUDED.version,
         content_hash   = EXCLUDED.content_hash,
         content_length = EXCLUDED.content_length,
         signature      = EXCLUDED.signature,
         put_at         = EXCLUDED.put_at
       RETURNING 1 AS committed`,
      [tag, resourceTag, version, contentHash, contentLength, signature, putAt, holder],
    ) as Array<{ committed: number | string }>
    const r = rows[0]
    return r ? { committed: num(r.committed) } : undefined
  } }
}

function buildDeleteLive(sql: NeonSql): RunStmt<[string, string]> {
  return runStmt(sql, `DELETE FROM workspace_object WHERE workspace_tag = $1 AND resource_tag = $2`)
}

function buildListAllStaging(sql: NeonSql): AllStmt<[number], { workspace_tag: string; resource_tag: string; staging_id: string; begun_at: number }> {
  return { all: async (staleBefore) => {
    // `WHERE begun_at < $1` uses workspace_object_staging_begun_at_idx
    // so the reaper sweep is O(stale-rows) cluster-wide. DB-layout
    // audit follow-up.
    const rows = await sql(
      `SELECT workspace_tag, resource_tag, staging_id, begun_at
       FROM workspace_object_staging
       WHERE begun_at < $1`,
      [staleBefore],
    ) as Array<Record<string, unknown>>
    return rows.map((r) => ({
      workspace_tag: String(r['workspace_tag']),
      resource_tag: String(r['resource_tag']),
      staging_id: String(r['staging_id']),
      begun_at: num(r['begun_at']),
    }))
  } }
}

function buildListLiveTags(sql: NeonSql): AllStmt<[], { workspace_tag: string }> {
  return { all: async () => {
    const rows = await sql(
      `SELECT DISTINCT workspace_tag FROM workspace_object`,
      [],
    ) as Array<Record<string, unknown>>
    return rows.map((r) => ({ workspace_tag: String(r['workspace_tag']) }))
  } }
}

function buildCountLive(sql: NeonSql): GetStmt<[string], { c: number }> {
  return { get: async (tag) => {
    const rows = await sql(
      `SELECT COUNT(*) AS c FROM workspace_object WHERE workspace_tag = $1`,
      [tag],
    ) as Array<{ c: number | string | bigint }>
    const r = rows[0]
    return r ? { c: num(r.c) } : undefined
  } }
}

// Distributed mutex on (workspace_tag, resource_tag). Same
// INSERT-or-take-expired semantics as the SQLite path:
//   - No row → INSERT, RETURNING acquired=1.
//   - Row held by another but expired (expires_at <= server now) →
//     UPDATE steals the lease, RETURNING acquired=1.
//   - Row held (by us or by another) and not expired → no row
//     returned, caller treats as not-acquired. Same-holder refresh
//     is intentionally NOT supported here (mirror the SQLite path);
//     letting same-holder transparently re-acquire would defeat
//     cross-replica serialization in single-process deployments
//     where reaper + REST PUT share PROCESS_HOLDER_ID.
//
// CRITICAL: all time comparisons use Postgres's `NOW()` (server
// clock), NOT the caller's `Date.now()`. Multi-replica deployments
// with NTP-disagreement of even seconds would otherwise let a
// clock-ahead replica read a fresh peer-held lease as expired and
// steal it → concurrent commitPut → the exact data corruption the
// lock prevents. The DB has one authoritative clock; we anchor
// everything to it. Bind order matches the SQLite path:
// (tag, res, holder, lease_ms, lease_ms).
function buildTryAcquireCommitLock(sql: NeonSql): GetStmt<[string, string, string, number, number], { acquired: number }> {
  return { get: async (tag, resourceTag, holder, leaseMsInsert, leaseMsUpdate) => {
    const rows = await sql(
      `INSERT INTO workspace_object_commit_lock
         (workspace_tag, resource_tag, holder, expires_at)
       VALUES ($1, $2, $3, (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT + $4)
       ON CONFLICT (workspace_tag, resource_tag) DO UPDATE SET
         holder     = EXCLUDED.holder,
         expires_at = (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT + $5
       WHERE workspace_object_commit_lock.expires_at <= (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
       RETURNING 1 AS acquired`,
      [tag, resourceTag, holder, leaseMsInsert, leaseMsUpdate],
    ) as Array<{ acquired: number | string }>
    const r = rows[0]
    return r ? { acquired: num(r.acquired) } : undefined
  } }
}

function buildReleaseCommitLock(sql: NeonSql): RunStmt<[string, string, string]> {
  return runStmt(sql, `DELETE FROM workspace_object_commit_lock
       WHERE workspace_tag = $1 AND resource_tag = $2 AND holder = $3`)
}

function buildReleaseAllCommitLocksFor(sql: NeonSql): RunStmt<[string]> {
  return runStmt(sql, `DELETE FROM workspace_object_commit_lock WHERE holder = $1`)
}

function buildVerifyCommitLockHeld(sql: NeonSql): GetStmt<[string, string, string], { held: number }> {
  return { get: async (tag, resourceTag, holder) => {
    const rows = await sql(
      `SELECT 1 AS held FROM workspace_object_commit_lock
       WHERE workspace_tag = $1 AND resource_tag = $2 AND holder = $3
         AND expires_at > (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT`,
      [tag, resourceTag, holder],
    ) as Array<{ held: number | string }>
    const r = rows[0]
    return r ? { held: num(r.held) } : undefined
  } }
}

export async function openNeonObjstore(connectionString: string, blob: BlobBackend): Promise<Handle> {
  // Same dynamic-import pattern as db-neon.ts — routed through the
  // local `../neon-driver.ts` re-export wrapper so the peer dep stays
  // optional AND tests can mock the driver (a local path is always
  // resolvable; the bare specifier isn't when the dep is absent). See
  // `server/neon-driver.ts`. Cast through `unknown` because the
  // wrapper's `export *` re-exports a `@ts-ignore`'d module.
  const mod = (await import('../neon-driver.ts')) as unknown as { neon: (url: string) => NeonSql }
  const sql: NeonSql = mod.neon(connectionString)
  // Boot-time durability gate (see db-neon.ts) — `openNeonDb` runs
  // the same assertion when it opens, but `openNeonObjstore` is
  // independently invoked for the objstore plane and an operator
  // who runs only this plane (future stand-alone deployment) must
  // be gated too.
  await assertDurableSyncCommit(sql)
  // DDL bootstrap under one pipelined transaction so a transient
  // network failure mid-batch rolls back, AND a transaction-scoped
  // advisory lock so two replicas booting concurrently serialize
  // their DDL (the advisory lock releases at COMMIT).
  await sql.transaction([
    sql(`SELECT pg_advisory_xact_lock($1, $2)`, [DDL_LOCK_KEY_OBJSTORE, DDL_LOCK_KEY_OBJSTORE_SUB]),
    ...SCHEMA_PG.map((stmt) => sql(stmt, [])),
  ])

  return {
    // `db` intentionally unset — Neon has no `DatabaseSync`.
    // `dir` intentionally unset — the byte plane goes through the
    // `blob` backend, which may not have an on-disk layout at all.
    blob,
    lock: new KeyedAsyncLock<string>(),
    insertStaging: buildInsertStaging(sql),
    selectStaging: buildSelectStaging(sql),
    selectStagingByWsSid: buildSelectStagingByWsSid(sql),
    refreshStagingBegunAt: buildRefreshStagingBegunAt(sql),
    deleteStaging: buildDeleteStaging(sql),
    selectLive: buildSelectLive(sql),
    selectLiveOne: buildSelectLiveOne(sql),
    upsertLive: buildUpsertLive(sql),
    upsertLiveIfHeld: buildUpsertLiveIfHeld(sql),
    deleteLive: buildDeleteLive(sql),
    listAllStaging: buildListAllStaging(sql),
    listLiveTags: buildListLiveTags(sql),
    countLive: buildCountLive(sql),
    tryAcquireCommitLock: buildTryAcquireCommitLock(sql),
    releaseCommitLock: buildReleaseCommitLock(sql),
    releaseAllCommitLocksFor: buildReleaseAllCommitLocksFor(sql),
    verifyCommitLockHeld: buildVerifyCommitLockHeld(sql),
  }
}
