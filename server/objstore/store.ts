// SQLite + filesystem-backed object store for the v1.objstore
// protocol extension. Sibling of `server/db.ts`; shares the
// underlying DatabaseSync handle but keeps its own tables.
//
//   workspace_object         — one row per LIVE resource (no
//                              tombstones; new subscribers must
//                              not learn a deleted resource ever
//                              existed).
//   workspace_object_staging — one row per IN-FLIGHT upload, so a
//                              restart between begin and commit
//                              can be reaped (see ./reaper.ts).
// Bytes live OUTSIDE sqlite at
//   ${OBJSTORE_DIR}/${workspaceTag}/[.staging/]${id}.bin
// keeping the WAL out of the multi-MB bundle path. Commit/delete
// order is asymmetric so a crash at the worst moment leaves at
// most a STRANDED FILE (reaper-cleaned), never a row pointing at
// nothing:
//   PUT commit:  fsync(staging) → rename → fsync(parent) → DB write
//   DELETE:      DB write → unlink (best-effort; ENOENT ok)

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import {
  durableRenameStagedToLive,
  ensureStagingDir,
  liveFilePath,
  stagingFilePath,
  unlinkIfExists,
} from './fs.ts'
import { KeyedAsyncLock } from './lock.ts'
import { type AllStmt, type GetStmt, type RunStmt, wrapAll, wrapGet, wrapRun } from '../db-stmt.ts'

// Default 1h, comfortably over a 50 MiB upload on a slow line. The
// reaper walks the staging table on this cadence; rows older than
// the TTL are dropped and their on-disk files unlinked.
export const STAGING_TTL_MS_DEFAULT = 60 * 60 * 1000

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS workspace_object (
    workspace_tag  TEXT    NOT NULL,
    resource_tag   TEXT    NOT NULL,
    version        INTEGER NOT NULL,
    content_hash   TEXT    NOT NULL,
    content_length INTEGER NOT NULL,
    signature      TEXT    NOT NULL,
    put_at         INTEGER NOT NULL,
    PRIMARY KEY (workspace_tag, resource_tag)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS workspace_object_staging (
    workspace_tag   TEXT    NOT NULL,
    resource_tag    TEXT    NOT NULL,
    staging_id      TEXT    NOT NULL,
    prev_version    INTEGER,
    expected_length INTEGER NOT NULL,
    content_hash    TEXT    NOT NULL,
    signature       TEXT    NOT NULL,
    begun_at        INTEGER NOT NULL,
    PRIMARY KEY (workspace_tag, resource_tag, staging_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS workspace_object_staging_begun_at_idx
    ON workspace_object_staging (begun_at);
`

// One LIVE row, exactly the shape `objstore-list-result` carries on
// the wire (minus `keyframe`-style server-only flags). `put_at` is a
// debug aid the wire format doesn't include — operators can inspect
// it via the DB but the server never volunteers it.
export type ObjectRow = {
  resourceTag: string
  version: number
  contentHash: string
  contentLength: number
  signature: string
  putAt: number
}

// Input to `beginPut`. `prevVersion` is the precondition version the
// client thinks the server holds; mismatch means the resource raced
// and the client must rebase before retrying.
export type BeginPutInput = {
  workspaceTag: string
  resourceTag: string
  prevVersion: number | null
  expectedLength: number
  contentHash: string
  signature: string
}

// `conflict` echoes the live row so the wire layer can include it in
// `objstore-conflict`; `accepted` hands back the staging id + the
// absolute path the REST PUT will write to. `workspace-full` is the
// per-workspace resource-count cap rejection — see
// `MAX_RESOURCES_PER_WORKSPACE`.
export type BeginPutResult =
  | { ok: true; stagingId: string; filePath: string }
  | { ok: false; reason: 'conflict'; conflict: ObjectRow | null }
  | { ok: false; reason: 'workspace-full' }

export type CommitPutInput = {
  workspaceTag: string
  resourceTag: string
  stagingId: string
}

export type CommitPutResult =
  | { ok: true; row: ObjectRow }
  | { ok: false; reason: 'no-staging' | 'size-mismatch' | 'io-error' | 'conflict'; conflict?: ObjectRow }

export type DeleteResult =
  | { ok: true; deletedVersion: number }
  | { ok: false; reason: 'not-found' | 'conflict'; conflict?: ObjectRow }

// Async statement shapes are shared with server/db.ts via
// ../db-stmt.ts — same `.get/.all/.run` → Promise contract across
// both planes.

// Row shape coming back from SELECTs (snake_case columns). The
// public `ObjectRow` is camelCased by `rowFromDb` at the call site.
type DbRow = {
  resource_tag: string; version: number; content_hash: string; content_length: number
  signature: string; put_at: number
}

// Pre-prepared statements + the underlying connection + the
// per-resource lock that serialises commit / delete / reaper.
// Held for process lifetime, closed from `shutdown()`. Bundling
// the lock into the handle means everyone (handlers, REST, reaper)
// pulls the same lock instance from the same place — no separate
// plumbing per call site.
export type Handle = {
  // SQLite-only: the underlying `DatabaseSync`. Unset on the Neon
  // backend (see ./store-neon.ts). Test-only fixture SQL routes
  // through `handle.db.prepare(...)` and is therefore SQLite-coupled
  // by construction.
  db?: DatabaseSync
  dir: string
  lock: KeyedAsyncLock<string>
  insertStaging: RunStmt<[string, string, string, number | null, number, string, string, number]>
  selectStaging: GetStmt<[string, string, string], {
    prev_version: number | null
    expected_length: number
    content_hash: string
    signature: string
    begun_at: number
  }>
  selectStagingByWsSid: GetStmt<[string, string], unknown>
  refreshStagingBegunAt: RunStmt<[number, string, string, string]>
  deleteStaging: RunStmt<[string, string, string]>
  selectLive: AllStmt<[string], DbRow>
  selectLiveOne: GetStmt<[string, string], DbRow>
  upsertLive: RunStmt<[string, string, number, string, number, string, number]>
  deleteLive: RunStmt<[string, string]>
  // `[staleBefore]` — only rows whose `begun_at < staleBefore` are
  // returned. The reaper passes `Date.now() - stagingTtlMs` so the
  // index `workspace_object_staging_begun_at_idx` is used and the
  // sweep is O(stale-rows) instead of O(in-flight-uploads-cluster-
  // wide). DB-layout audit `server/objstore/store.ts:312`.
  listAllStaging: AllStmt<[number], { workspace_tag: string; resource_tag: string; staging_id: string; begun_at: number }>
  listLiveTags: AllStmt<[], { workspace_tag: string }>
  countLive: GetStmt<[string], { c: number }>
}

// Narrowing alias for the SQLite-backed Handle: `db` is guaranteed
// to be set. `openObjstore` returns this so call sites (production
// shutdown plumbing in `server/index.ts` + the entire SQLite-only
// test suite in `tests/server-objstore.test.js`) can reach
// `handle.db.prepare(...)` without an optional-chain or non-null
// assertion. A Neon-backed Handle (`openNeonObjstore`) keeps the
// wider `db?: DatabaseSync` shape; routing a Neon Handle into a
// SQLite-coupled call site is a type error at compile time.
export type SqliteHandle = Handle & { db: DatabaseSync }

// Per-workspace resource cap. Caps the live row count for a single
// workspace_tag so a holder of the seed (until per-account GitHub-auth
// quotas land) can't grow `workspace_object` without bound. Enforced
// at `beginPut` time for NEW resources only — re-uploads of an existing
// resourceTag (a new version of the same row) don't change the count
// and are allowed regardless. Checked under the per-resource lock, so
// the count is consistent with the live-row check on the same path;
// transient over-shoot under high concurrency across DIFFERENT
// resources is bounded by `(parallel new-resource begins - 1)` and is
// accepted (the cap is a soft policy bound, not a security invariant).
export const MAX_RESOURCES_PER_WORKSPACE = 100

// Per-upload byte cap, shared by the WS plane (rejects oversize
// `expectedLength` in `objstore-put-begin`) and the REST plane (gates
// the PUT body via Content-Length + post-upload stat). Single source
// of truth so the two planes can't drift apart on a future bump.
export const MAX_CONTENT_LENGTH = 100 * 1024 * 1024

// Lock key for the per-resource mutex. Exported so handler / REST /
// reaper share one shape.
export function lockKey(tag: string, resourceTag: string): string {
  return `${tag}|${resourceTag}`
}

const TAG_RE = /^[\w-]+$/u
const CONTENT_HASH_RE = /^[\w-]{43}$/u   // 32 raw bytes → 43 b64url chars (no padding)
const SIG_RE = /^[\w-]{86}$/u            // 64 raw bytes → 86 b64url chars (no padding)
const STAGING_ID_RE = /^[\w-]{22}$/u     // 16 raw bytes → 22 b64url chars (no padding)
const MAX_TAG_LEN = 256

// Strict shape gate. The ed25519 signature on every PUT/DELETE binds
// these fields, so a malformed value here means either a buggy
// client or someone fuzzing the relay — drop without inserting.
export function isValidTag(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= MAX_TAG_LEN && TAG_RE.test(s)
}
export function isValidContentHash(s: unknown): s is string {
  return typeof s === 'string' && CONTENT_HASH_RE.test(s)
}
export function isValidSignature(s: unknown): s is string {
  return typeof s === 'string' && SIG_RE.test(s)
}
// `randomBytes(16).toString('base64url')` produces exactly this
// shape (22 chars, base64url alphabet, no padding). Validated on
// the reaper-side path constructions so a tampered or migrated
// row whose `staging_id` somehow contains separators / `..` can't
// trick the reaper into unlinking outside `OBJSTORE_DIR`. PR #4
// review.
export function isValidStagingId(s: unknown): s is string {
  return typeof s === 'string' && STAGING_ID_RE.test(s)
}

function rowFromDb(r: DbRow): ObjectRow {
  return {
    resourceTag: r.resource_tag, version: r.version, contentHash: r.content_hash,
    contentLength: r.content_length, signature: r.signature, putAt: r.put_at,
  }
}

export function openObjstore(db: DatabaseSync, dir: string): SqliteHandle {
  // Ensure the root storage directory exists. The server defaults
  // this to `dirname(DB_PATH)/objstore`; an operator-supplied path
  // with parents that don't exist also gets created here.
  mkdirSync(dir, { recursive: true })
  db.exec(SCHEMA)
  // Fail-loud on a pre-existing non-STRICT table — same rationale as
  // server/db.ts: `CREATE TABLE IF NOT EXISTS … STRICT` doesn't
  // upgrade an existing non-STRICT table, and dropping strict type
  // affinity opens an operator-attack path. PR #4 review F3.
  for (const name of ['workspace_object', 'workspace_object_staging']) {
    const meta = db.prepare(`SELECT strict FROM pragma_table_list WHERE schema = 'main' AND name = ?`).get(name) as { strict: number } | undefined
    if (meta && meta.strict !== 1) throw new Error(`${name} is non-STRICT — migrate before booting`)
  }
  // No `close` method on the returned Handle: the underlying
  // `DatabaseSync` is owned by the caller (in production, the
  // workspace_revision handle in `server/db.ts`, which closes it
  // from `shutdown()`). Exposing `close()` here was misleading —
  // a callsite reading `await objstoreHandle.close()` would
  // reasonably assume it closes something, when in practice it
  // either no-op'd (production) or left the connection open
  // (tests construct their own DB and `db.close()` separately).
  return {
    db,
    dir,
    lock: new KeyedAsyncLock<string>(),
    insertStaging: wrapRun(db.prepare(`
      INSERT INTO workspace_object_staging
        (workspace_tag, resource_tag, staging_id, prev_version,
         expected_length, content_hash, signature, begun_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)),
    selectStaging: wrapGet(db.prepare(`
      SELECT prev_version, expected_length, content_hash, signature, begun_at
      FROM workspace_object_staging
      WHERE workspace_tag = ? AND resource_tag = ? AND staging_id = ?
    `)),
    // Reaper orphan-file sweep: lookup by (ws, sid) only, no resource_tag
    // (the staging filename doesn't carry it). PR #4 review H1.
    selectStagingByWsSid: wrapGet(db.prepare(
      `SELECT 1 FROM workspace_object_staging WHERE workspace_tag = ? AND staging_id = ?`,
    )),
    // Restamp `begun_at` post-upload so TTL counts from upload-done.
    // PR #4 review H4.
    refreshStagingBegunAt: wrapRun(db.prepare(
      `UPDATE workspace_object_staging SET begun_at = ? WHERE workspace_tag = ? AND resource_tag = ? AND staging_id = ?`,
    )),
    deleteStaging: wrapRun(db.prepare(`
      DELETE FROM workspace_object_staging
      WHERE workspace_tag = ? AND resource_tag = ? AND staging_id = ?
    `)),
    selectLive: wrapAll(db.prepare(`
      SELECT resource_tag, version, content_hash, content_length,
             signature, put_at
      FROM workspace_object
      WHERE workspace_tag = ?
      ORDER BY resource_tag ASC
    `)),
    selectLiveOne: wrapGet(db.prepare(`
      SELECT resource_tag, version, content_hash, content_length,
             signature, put_at
      FROM workspace_object
      WHERE workspace_tag = ? AND resource_tag = ?
    `)),
    upsertLive: wrapRun(db.prepare(`
      INSERT INTO workspace_object
        (workspace_tag, resource_tag, version, content_hash, content_length,
         signature, put_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_tag, resource_tag) DO UPDATE SET
        version        = excluded.version,
        content_hash   = excluded.content_hash,
        content_length = excluded.content_length,
        signature      = excluded.signature,
        put_at         = excluded.put_at
    `)),
    deleteLive: wrapRun(db.prepare(`
      DELETE FROM workspace_object
      WHERE workspace_tag = ? AND resource_tag = ?
    `)),
    listAllStaging: wrapAll(db.prepare(`
      SELECT workspace_tag, resource_tag, staging_id, begun_at
      FROM workspace_object_staging
      WHERE begun_at < ?
    `)),
    listLiveTags: wrapAll(db.prepare(`
      SELECT DISTINCT workspace_tag FROM workspace_object
    `)),
    countLive: wrapGet(db.prepare(`
      SELECT COUNT(*) AS c FROM workspace_object WHERE workspace_tag = ?
    `)),
  }
}

export async function getLive(handle: Handle, tag: string, resourceTag: string): Promise<ObjectRow | null> {
  const row = await handle.selectLiveOne.get(tag, resourceTag)
  return row ? rowFromDb(row) : null
}

export async function listLive(handle: Handle, tag: string): Promise<ObjectRow[]> {
  const rows = await handle.selectLive.all(tag)
  return rows.map(rowFromDb)
}

// Mints a staging id, validates the prev_version precondition,
// inserts the staging row. Async — `ensureStagingDir` is genuinely
// async; the DB calls are async-shaped wrappers around the sync
// `node:sqlite` driver. Callers MUST serialise
// per-(tag, resourceTag) with the KeyedAsyncLock — see handlers.ts.
export async function beginPut(handle: Handle, input: BeginPutInput): Promise<BeginPutResult> {
  const live = await getLive(handle, input.workspaceTag, input.resourceTag)
  const liveVersion = live?.version ?? null
  if (liveVersion !== input.prevVersion) {
    return { ok: false, reason: 'conflict', conflict: live }
  }
  // Per-workspace resource cap. Only enforced for NEW resources —
  // re-uploads of an existing resourceTag (live != null) don't
  // change the count, so they're always allowed. The check sits
  // inside the per-resource lock (caller-acquired), so it's
  // consistent with the live-row read above.
  if (!live) {
    const count = await handle.countLive.get(input.workspaceTag) as { c: number } | undefined
    if ((count?.c ?? 0) >= MAX_RESOURCES_PER_WORKSPACE) {
      return { ok: false, reason: 'workspace-full' }
    }
  }
  const stagingId = randomBytes(16).toString('base64url')
  await ensureStagingDir(handle.dir, input.workspaceTag)
  await handle.insertStaging.run(
    input.workspaceTag,
    input.resourceTag,
    stagingId,
    input.prevVersion,
    input.expectedLength,
    input.contentHash,
    input.signature,
    Date.now(),
  )
  return { ok: true, stagingId, filePath: stagingFilePath(handle.dir, input.workspaceTag, stagingId) }
}

// Re-checks prev_version (a concurrent commit/delete may have raced
// past us between begin and commit), validates the on-disk staged
// size, runs the durable rename. The upsertLive + deleteStaging
// pair runs under the per-resource lock the caller already holds —
// concurrency atomicity, not crash atomicity. A crash between
// upsertLive and deleteStaging leaves the staging row alongside the
// new live row; the reaper's stale-staging sweep cleans the orphan
// row + (already-renamed-away) staging file on its next pass,
// matching the README's "stranded state, reaper-cleaned, never
// row-pointing-at-nothing" crash-safety contract.
export async function commitPut(handle: Handle, input: CommitPutInput): Promise<CommitPutResult> {
  const staging = await handle.selectStaging.get(input.workspaceTag, input.resourceTag, input.stagingId)
  if (!staging) return { ok: false, reason: 'no-staging' }
  const stagingPath = stagingFilePath(handle.dir, input.workspaceTag, input.stagingId)
  let stagedSize: number
  // stat failure here is a server-side issue (staging file was
  // unlinked by a racing abort / reaper, EACCES, EIO, …) — not a
  // client length-mismatch. Route through `io-error` so the REST
  // layer returns 5xx, not 400. PR #4 review.
  try { stagedSize = (await stat(stagingPath)).size } catch { return { ok: false, reason: 'io-error' } }
  // Truncation invariant: a partial upload (received < declared, or a
  // mid-stream abort that left a short staging file) MUST NEVER be
  // promoted to live. The REST layer already gates on
  // `received !== declared` before reaching here, but commitPut re-
  // stats the file under the per-resource lock as the last line of
  // defense — if the on-disk size doesn't match what the signature
  // committed to, we bail BEFORE the rename. A client that retries
  // the upload under the same resourceTag gets a fresh stagingId +
  // fresh staging file path; the truncated original is untouched by
  // the retry's rename. Together with the per-(tag,resourceTag) lock,
  // this guarantees the live file's bytes are always a complete
  // signed payload.
  if (stagedSize !== staging.expected_length) return { ok: false, reason: 'size-mismatch' }
  const live = await getLive(handle, input.workspaceTag, input.resourceTag)
  const liveVersion = live?.version ?? null
  if (liveVersion !== staging.prev_version) {
    // Don't unlink the staging file here — the caller routes
    // through abortPut to clean up consistently.
    return { ok: false, reason: 'conflict', ...(live ? { conflict: live } : {}) }
  }
  const livePath = liveFilePath(handle.dir, input.workspaceTag, input.resourceTag)
  // `durableRenameStagedToLive` returns false on any FS error
  // (EACCES / ENOSPC / EIO / a racing abort that already unlinked
  // the staging file). 'io-error' is mapped to HTTP 500 by the
  // REST layer — it's a server-side fault, not a client-fixable
  // one. PR #4 review.
  if (!await durableRenameStagedToLive(stagingPath, livePath)) {
    return { ok: false, reason: 'io-error' }
  }
  const nextVersion = (liveVersion ?? 0) + 1
  const putAt = Date.now()
  await handle.upsertLive.run(
    input.workspaceTag,
    input.resourceTag,
    nextVersion,
    staging.content_hash,
    staging.expected_length,
    staging.signature,
    putAt,
  )
  await handle.deleteStaging.run(input.workspaceTag, input.resourceTag, input.stagingId)
  return {
    ok: true,
    row: {
      resourceTag: input.resourceTag,
      version: nextVersion,
      contentHash: staging.content_hash,
      contentLength: staging.expected_length,
      signature: staging.signature,
      putAt,
    },
  }
}

// Idempotent — DELETE row is a no-op when already gone, ENOENT
// unlink is ignored. Async unlink so a slow disk doesn't stall the
// event loop.
export async function abortPut(handle: Handle, tag: string, resourceTag: string, stagingId: string): Promise<void> {
  await unlinkIfExists(stagingFilePath(handle.dir, tag, stagingId))
  await handle.deleteStaging.run(tag, resourceTag, stagingId)
}

// `prevVersion = null` + missing row = already-deleted-or-never-
// existed; treat as success so retried DELETEs are idempotent. The
// `deletedVersion = 0` sentinel tells the broadcast path to skip.
// Callers serialise per-resource via KeyedAsyncLock.
export async function deleteObject(
  handle: Handle, tag: string, resourceTag: string, prevVersion: number | null,
): Promise<DeleteResult> {
  const live = await getLive(handle, tag, resourceTag)
  if (!live) {
    if (prevVersion == null) return { ok: true, deletedVersion: 0 }
    return { ok: false, reason: 'not-found' }
  }
  if (live.version !== prevVersion) return { ok: false, reason: 'conflict', conflict: live }
  await handle.deleteLive.run(tag, resourceTag)
  await unlinkIfExists(liveFilePath(handle.dir, tag, resourceTag))
  return { ok: true, deletedVersion: live.version }
}
