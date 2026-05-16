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
// Bytes still live on local disk under `OBJSTORE_DIR` regardless of
// backend — multi-MB blobs don't belong in the DB. The byte plane
// is single-process today; multi-process / multi-replica support
// awaits a shared object-storage backend (S3 or similar).

import { mkdirSync } from 'node:fs'
import { KeyedAsyncLock } from './lock.ts'
import type { AllStmt, GetStmt, RunStmt } from '../db-stmt.ts'
import type { Handle } from './store.ts'
import { type NeonSql, assertDurableSyncCommit } from '../db-neon.ts'

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
]

// BIGINT can round-trip as a JS string when it would lose precision.
// For our use (epoch ms, version counters, byte lengths up to
// 100 MiB) the safe-integer range is fine — coerce to `number` so
// the row shape matches the SQLite path's INTEGER round-trip.
// Strict: throw on anything that isn't a safe-integer-compatible
// value. Silently returning 0 / NaN would mask driver-shape
// changes (e.g. a future Neon release switching BIGINT to a
// `{ toString() }` object) and propagate bogus values into
// length / version / put_at fields.
function num(v: unknown): number {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v
  if (typeof v === 'string' && v.length > 0) {
    const n = Number(v)
    if (Number.isSafeInteger(n)) return n
  }
  if (typeof v === 'bigint' && v >= -9_007_199_254_740_991n && v <= 9_007_199_254_740_991n) {
    return Number(v)
  }
  throw new TypeError(`num: expected safe-integer value, got ${typeof v} ${String(v)}`)
}
function numOrNull(v: unknown): number | null {
  if (v == null) return null
  return num(v)
}

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
  return { run: async (tag, resourceTag, stagingId, prevVersion, expectedLength, contentHash, signature, begunAt) => {
    await sql(
      `INSERT INTO workspace_object_staging
         (workspace_tag, resource_tag, staging_id, prev_version,
          expected_length, content_hash, signature, begun_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tag, resourceTag, stagingId, prevVersion, expectedLength, contentHash, signature, begunAt],
    )
  } }
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
  return { get: async (tag, stagingId) => {
    const rows = await sql(
      `SELECT 1 AS one FROM workspace_object_staging WHERE workspace_tag = $1 AND staging_id = $2`,
      [tag, stagingId],
    ) as Array<{ one: number }>
    return rows[0]
  } }
}

function buildRefreshStagingBegunAt(sql: NeonSql): RunStmt<[number, string, string, string]> {
  return { run: async (now, tag, resourceTag, stagingId) => {
    await sql(
      `UPDATE workspace_object_staging SET begun_at = $1
       WHERE workspace_tag = $2 AND resource_tag = $3 AND staging_id = $4`,
      [now, tag, resourceTag, stagingId],
    )
  } }
}

function buildDeleteStaging(sql: NeonSql): RunStmt<[string, string, string]> {
  return { run: async (tag, resourceTag, stagingId) => {
    await sql(
      `DELETE FROM workspace_object_staging
       WHERE workspace_tag = $1 AND resource_tag = $2 AND staging_id = $3`,
      [tag, resourceTag, stagingId],
    )
  } }
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
  return { run: async (tag, resourceTag, version, contentHash, contentLength, signature, putAt) => {
    await sql(
      `INSERT INTO workspace_object
         (workspace_tag, resource_tag, version, content_hash, content_length,
          signature, put_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workspace_tag, resource_tag) DO UPDATE SET
         version        = EXCLUDED.version,
         content_hash   = EXCLUDED.content_hash,
         content_length = EXCLUDED.content_length,
         signature      = EXCLUDED.signature,
         put_at         = EXCLUDED.put_at`,
      [tag, resourceTag, version, contentHash, contentLength, signature, putAt],
    )
  } }
}

function buildDeleteLive(sql: NeonSql): RunStmt<[string, string]> {
  return { run: async (tag, resourceTag) => {
    await sql(
      `DELETE FROM workspace_object WHERE workspace_tag = $1 AND resource_tag = $2`,
      [tag, resourceTag],
    )
  } }
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

export async function openNeonObjstore(connectionString: string, dir: string): Promise<Handle> {
  // Same dynamic-import pattern as db-neon.ts — the peer dep is
  // only required when the Neon path was selected. `@ts-ignore`
  // rather than `@ts-expect-error` so an operator who installs the
  // dep doesn't trip a TS2578 "unused directive" error in tsc.
  // @ts-ignore optional peer dep: '@neondatabase/serverless'
  const mod = (await import('@neondatabase/serverless')) as { neon: (url: string) => NeonSql }
  const sql: NeonSql = mod.neon(connectionString)
  // Bytes still live on local disk regardless of backend; mirror
  // the SQLite path's `mkdirSync(dir, { recursive: true })` so
  // callers can rely on the dir being ready post-open.
  mkdirSync(dir, { recursive: true })
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
    dir,
    lock: new KeyedAsyncLock<string>(),
    insertStaging: buildInsertStaging(sql),
    selectStaging: buildSelectStaging(sql),
    selectStagingByWsSid: buildSelectStagingByWsSid(sql),
    refreshStagingBegunAt: buildRefreshStagingBegunAt(sql),
    deleteStaging: buildDeleteStaging(sql),
    selectLive: buildSelectLive(sql),
    selectLiveOne: buildSelectLiveOne(sql),
    upsertLive: buildUpsertLive(sql),
    deleteLive: buildDeleteLive(sql),
    listAllStaging: buildListAllStaging(sql),
    listLiveTags: buildListLiveTags(sql),
    countLive: buildCountLive(sql),
  }
}
