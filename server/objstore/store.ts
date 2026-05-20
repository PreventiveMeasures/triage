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
// keeping the WAL out of the multi-MB bundle path. Live blobs are
// CONTENT-ADDRESSED (`${tag}/${contentHash}.bin`): the hash names
// exactly one immutable byte-string, so two racing commits write to
// DIFFERENT addresses and the live row's `content_hash` literally
// names its blob file (a metadata-vs-bytes desync is impossible).
// Commit is therefore a plain version compare-and-set on the row —
// no distributed lock. Commit/delete order is asymmetric so a crash
// at the worst moment leaves at most a STRANDED FILE (reaper-cleaned,
// once unreferenced AND past the GC grace window), never a row
// pointing at nothing:
//   PUT commit:  fsync(staging) → rename → fsync(parent) → DB CAS
//   DELETE:      DB row drop (the reaper GCs the unreferenced blob)

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { type BlobBackend } from './blob.ts'
import { openFsBlobBackend } from './blob-fs.ts'
import { stagingFilePath } from './fs.ts'
import { KeyedAsyncLock } from './lock.ts'
import { type AllStmt, type GetStmt, type RunStmt, wrapAll, wrapGet, wrapRun } from '../db-stmt.ts'
import { errMsg, randomId } from '../util.ts'

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
// `objstore-conflict`; `accepted` hands back the staging id the REST
// PUT will reference. `workspace-full` is the per-workspace resource-
// count cap rejection — see `MAX_RESOURCES_PER_WORKSPACE`.
//
// `filePath` is set only for the FS-backed handle (where it's the
// absolute on-disk staging path); the Vercel-Blob handle omits it
// since "path" isn't a meaningful concept against a remote object
// store. Production code (rest.ts) never reads this field — the
// REST layer goes through `handle.blob.openStagingWriter(tag, sid)`.
// Tests for the FS path use it as a convenience to write fixture
// bytes directly to the staging slot.
export type BeginPutResult =
  | { ok: true; stagingId: string; filePath?: string }
  | { ok: false; reason: 'conflict'; conflict: ObjectRow | null }
  | { ok: false; reason: 'workspace-full' }

export type CommitPutInput = {
  workspaceTag: string
  resourceTag: string
  stagingId: string
  // Optional: the storage-side byte count the caller already
  // verified after the upload landed. When provided, commitPut
  // skips the otherwise-redundant `statStaging` round-trip — for
  // the Vercel backend that's one fewer HTTP HEAD per PUT.
  // Caller must ONLY pass a value it observed under the same
  // per-resource lock holding through commitPut (i.e. the REST
  // PUT path's post-upload `statStaging`). Tests that drive
  // commitPut directly without the REST layer should omit this
  // and let commitPut stat for itself.
  observedSize?: number
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

// Pre-prepared statements + the byte-plane backend + the per-
// resource lock that serialises commit / delete / reaper. Held for
// process lifetime, closed from `shutdown()`. Bundling the lock
// into the handle means everyone (handlers, REST, reaper) pulls
// the same lock instance from the same place — no separate
// plumbing per call site.
//
// There is no distributed commit lock: content-addressed live blobs
// make the metadata-vs-bytes desync impossible, so commit is a plain
// version compare-and-set (`insertLiveIfAbsent` / `updateLiveCAS`).
// The in-process `KeyedAsyncLock` is still bundled here — it's cheap
// and reduces churn against concurrent ops on the same key within a
// single process — but cross-replica correctness rests on the CAS,
// not on any lock.
export type Handle = {
  // SQLite-only: the underlying `DatabaseSync`. Unset on the Neon
  // backend (see ./store-neon.ts). Test-only fixture SQL routes
  // through `handle.db.prepare(...)` and is therefore SQLite-coupled
  // by construction.
  db?: DatabaseSync
  // Byte-plane backend (local FS or Vercel Blob). All bytes-side
  // operations go through this — there is no direct fs.* call in
  // store / rest / reaper. Selected at boot in server/index.ts.
  blob: BlobBackend
  // Storage root for the FS backend — set only when `blob` was
  // constructed from `openFsBlobBackend(dir)`. Production code
  // never touches this; it's a back-channel for tests that compute
  // canonical paths via `stagingFilePath(handle.dir, …)`. The
  // Vercel-backed Handle omits it.
  dir?: string
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
  // Version-CAS commit primitives. Exactly one of the two runs per
  // commit, picked by whether the staging row had a `prev_version`:
  //
  // `insertLiveIfAbsent(tag, res, contentHash, contentLength,
  //   signature, putAt)` — the prev_version == null (first-write)
  //   path. Inserts the row at version 1 IF ABSENT
  //   (`ON CONFLICT (tag,res) DO NOTHING RETURNING 1`). Returns
  //   `{ ok: 1 }` if we won the insert; undefined if a racer already
  //   created the row (caller → conflict + re-read).
  //
  // `updateLiveCAS(tag, res, nextVersion, contentHash, contentLength,
  //   signature, putAt, expectedVersion)` — the re-upload path
  //   (prev_version == v). Bumps the row to `nextVersion`
  //   `WHERE tag AND resource AND version = expectedVersion
  //   RETURNING 1`. Returns `{ ok: 1 }` if our CAS matched the live
  //   version; undefined if a racer bumped it first (caller →
  //   conflict + re-read). Exactly one racer wins; the loser rebases.
  insertLiveIfAbsent: GetStmt<[string, string, string, number, string, number], { ok: number }>
  updateLiveCAS: GetStmt<[string, string, number, string, number, string, number, number], { ok: number }>
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
// `randomId()` (16 random bytes → base64url) produces exactly this
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

// The live-row fields every objstore wire frame carries (list result,
// fetch token, PUT broadcast). `putAt` is a server-only debug column
// the wire never includes. One projection so the three emit sites
// (handlers.ts handleList / handleFetch, rest.ts PUT broadcast) can't
// drift on the shape.
export type ObjectMetaWire = {
  resourceTag: string; version: number; contentHash: string; contentLength: number; signature: string
}
export function objectMetaWire(row: ObjectRow): ObjectMetaWire {
  return {
    resourceTag: row.resourceTag, version: row.version, contentHash: row.contentHash,
    contentLength: row.contentLength, signature: row.signature,
  }
}

// Convenience signature for the SQLite + local-FS pairing — the
// only pairing the SQLite DB plane supports (single-process). The
// second argument is the FS root path passed to the FS BlobBackend;
// kept as a string (rather than an opaque BlobBackend) so the
// existing test corpus (`openObjstore(db, objDir)`) doesn't have to
// thread a backend constructor through every fixture.
export function openObjstore(db: DatabaseSync, dir: string): SqliteHandle {
  // Ensure the root storage directory exists. The server defaults
  // this to `dirname(DB_PATH)/objstore`; an operator-supplied path
  // with parents that don't exist also gets created here. Eager
  // (vs lazy-on-first-beginPut) so the reaper's startup sweep over
  // an empty root doesn't ENOENT.
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
  const blob = openFsBlobBackend(dir)
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
    blob,
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
    // First-write CAS: insert the live row at version 1 IF ABSENT.
    // `ON CONFLICT … DO NOTHING RETURNING 1` returns a row only when
    // OUR insert won — a racing first-write commit that landed first
    // (same prev_version == null precondition) makes this a no-op and
    // RETURNING comes back empty → caller maps to conflict. Bind
    // order: (tag, res, hash, len, sig, put_at); version is the
    // literal 1.
    insertLiveIfAbsent: wrapGet(db.prepare(`
      INSERT INTO workspace_object
        (workspace_tag, resource_tag, version, content_hash, content_length,
         signature, put_at)
      VALUES (?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT (workspace_tag, resource_tag) DO NOTHING
      RETURNING 1 AS ok
    `)),
    // Re-upload CAS: bump the row to `?3` (next version) only when the
    // live version still equals `?8` (the version we read as our
    // precondition). `RETURNING 1` comes back only when the WHERE
    // matched — exactly one of N racing re-uploads against the same
    // base version wins; the losers get an empty result → conflict +
    // rebase. Bind order: (tag, res, nextVersion, hash, len, sig,
    // put_at, expectedVersion).
    updateLiveCAS: wrapGet(db.prepare(`
      UPDATE workspace_object
      SET version        = ?3,
          content_hash   = ?4,
          content_length = ?5,
          signature      = ?6,
          put_at         = ?7
      WHERE workspace_tag = ?1 AND resource_tag = ?2 AND version = ?8
      RETURNING 1 AS ok
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
// inserts the staging row. Async — `ensureWorkspace` is genuinely
// async on the FS backend (mkdir) and a no-op on the Vercel backend;
// the DB calls are async-shaped wrappers around the sync
// `node:sqlite` driver. Callers MUST serialise
// per-(tag, resourceTag) with the KeyedAsyncLock — see handlers.ts.
//
// Returns the stagingId the REST PUT layer pairs with the bytes; the
// optional `filePath` is set only for the FS backend (test seam, see
// BeginPutResult).
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
  const stagingId = randomId()
  await handle.blob.ensureWorkspace(input.workspaceTag)
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
  return handle.dir === undefined
    ? { ok: true, stagingId }
    : { ok: true, stagingId, filePath: stagingFilePath(handle.dir, input.workspaceTag, stagingId) }
}

// Validates the on-disk staged size, promotes the staging blob to its
// content-addressed live path, then commits via an atomic version
// compare-and-set on the live row: a first-write inserts at version 1
// IF ABSENT; a re-upload bumps the version IFF it still matches the
// precondition we read. Exactly one of N racing commits wins the CAS;
// the losers get `conflict` (with the current live row) and rebase.
// Because the live blob is content-addressed, a losing racer's promote
// only ever (idempotently) re-writes the SAME bytes the winner's row
// names — there is no metadata-vs-bytes desync to guard against, so no
// distributed lock is needed. The in-process `KeyedAsyncLock` the
// caller holds gives concurrency atomicity within a single process; the
// CAS gives it across replicas. A crash between the promote and the CAS
// leaves the staging blob/row intact alongside (at most) a stranded,
// unreferenced live blob — the reaper's stale-staging sweep cleans the
// row, and the GC reaps the unreferenced live blob once it's past the
// grace window, matching the "stranded state, reaper-cleaned, never
// row-pointing-at-nothing" crash-safety contract.
export async function commitPut(handle: Handle, input: CommitPutInput): Promise<CommitPutResult> {
  const staging = await handle.selectStaging.get(input.workspaceTag, input.resourceTag, input.stagingId)
  if (!staging) return { ok: false, reason: 'no-staging' }
  let stagedSize: number | null
  // statStaging failure here is a server-side issue (staging file
  // was unlinked by a racing abort / reaper, EACCES, EIO, backend
  // unreachable, …) — not a client length-mismatch. Route through
  // `io-error` so the REST layer returns 5xx, not 400. PR #4 review.
  //
  // The REST PUT layer already statted post-upload under the
  // per-resource lock and threads the result in via `observedSize` —
  // skipping the round-trip saves one Vercel HEAD per PUT. The
  // staging blob can't have been resized between that stat and here
  // because the in-process lock (held continuously across the
  // post-upload stat and this commit) excludes every writer of this
  // stagingId within the process, and staging ids are random so no
  // other request targets the same blob. WS / test paths that omit
  // `observedSize` fall through to the explicit stat.
  if (input.observedSize === undefined) {
    try { stagedSize = await handle.blob.statStaging(input.workspaceTag, input.stagingId) }
    catch { return { ok: false, reason: 'io-error' } }
    if (stagedSize == null) return { ok: false, reason: 'io-error' }
  } else {
    stagedSize = input.observedSize
  }
  // Truncation invariant: a partial upload (received < declared, or a
  // mid-stream abort that left a short staging file) MUST NEVER be
  // promoted to live. The REST layer already gates on
  // `received !== declared` before reaching here, but commitPut re-
  // stats under the per-resource lock as the last line of defense —
  // if the storage-side size doesn't match what the signature
  // committed to, we bail BEFORE the promotion. A client that
  // retries the upload under the same resourceTag gets a fresh
  // stagingId + fresh staging slot; the truncated original is
  // untouched by the retry's promote. Together with the per-(tag,
  // resourceTag) lock, this guarantees the live blob's bytes are
  // always a complete signed payload.
  if (stagedSize !== staging.expected_length) return { ok: false, reason: 'size-mismatch' }
  // Cheap early-out conflict check: a concurrent commit / delete may
  // have raced past us between begin and now. The authoritative test
  // is the CAS below (it's atomic against concurrent writers); this
  // read just lets us skip the promote when we already know we've
  // lost, and gives us the current row for the conflict result.
  const live = await getLive(handle, input.workspaceTag, input.resourceTag)
  const liveVersion = live?.version ?? null
  if (liveVersion !== staging.prev_version) {
    // Don't unlink the staging blob here — the caller routes
    // through abortPut to clean up consistently.
    return { ok: false, reason: 'conflict', ...(live ? { conflict: live } : {}) }
  }
  // Promote to the CONTENT-ADDRESSED live path `${tag}/${hash}.bin`.
  // `promoteStagingToLive` returns false on any backend error (FS:
  // EACCES / ENOSPC / EIO / a racing abort that already unlinked
  // the staging file; Vercel: copy failure). 'io-error' is mapped
  // to HTTP 500 by the REST layer — it's a server-side fault, not
  // a client-fixable one. Because the destination is the content
  // hash, a racing commit promoting the same bytes (or a different
  // resource committing identical content) lands at the SAME path —
  // an idempotent re-write of identical bytes, never a clobber.
  if (!await handle.blob.promoteStagingToLive(input.workspaceTag, input.stagingId, staging.content_hash)) {
    return { ok: false, reason: 'io-error' }
  }
  const nextVersion = (liveVersion ?? 0) + 1
  const putAt = Date.now()
  // Version-CAS in try/catch so a Neon transient (5xx, network
  // hiccup, connection-pool exhaustion) doesn't bypass the abortPut
  // ladder by throwing out of commitPut. Without this guard, a thrown
  // rejection skips the REST layer's `if (!r.ok) abortPut` branch and
  // bubbles to handleRest's outer catch — the live blob is already
  // promoted, the staging blob + row stay, and the client sees a 500.
  // The reaper reconciles (stale-staging sweep + unreferenced-blob
  // GC) but the surface is a 500 the caller can retry.
  let won: { ok: number } | undefined
  try {
    if (staging.prev_version == null) {
      // First write: insert at version 1 IF ABSENT. A racing
      // first-write that landed first occupies the slot → our insert
      // is a no-op → empty RETURNING → conflict.
      won = await handle.insertLiveIfAbsent.get(
        input.workspaceTag,
        input.resourceTag,
        staging.content_hash,
        staging.expected_length,
        staging.signature,
        putAt,
      )
    } else {
      // Re-upload: bump version IFF the live version still equals our
      // precondition. Exactly one of N racers against the same base
      // version wins; the losers' CAS matches no row → conflict.
      won = await handle.updateLiveCAS.get(
        input.workspaceTag,
        input.resourceTag,
        nextVersion,
        staging.content_hash,
        staging.expected_length,
        staging.signature,
        putAt,
        staging.prev_version,
      )
    }
  } catch (err) {
    console.warn('commitPut version-CAS failed:', errMsg(err))
    // Caller's `if (!r.ok) abortPut` cleans the staging side. The
    // just-promoted live blob is unreferenced; the reaper's GC unlinks
    // it once it's past the grace window.
    return { ok: false, reason: 'io-error' }
  }
  if (!won) {
    // A racer won the CAS between our pre-check `getLive` and the
    // write. Re-read the live row so the caller can surface the
    // current version in the conflict (the client rebases off it).
    // Our promoted blob is content-addressed: if the racer committed
    // the SAME content its row already names our bytes; if different
    // content, our bytes are simply an unreferenced blob the GC reaps.
    // Either way there is no desync — just a conflict to rebase.
    const current = await getLive(handle, input.workspaceTag, input.resourceTag)
    return { ok: false, reason: 'conflict', ...(current ? { conflict: current } : {}) }
  }
  // Staging cleanup AFTER the CAS so a crash between the promote and
  // the CAS leaves the staging blob intact and the live row at its
  // prior value — a state a retry can re-commit from. The alternative
  // ordering (cleanup before the DB write) would drop the staging
  // bytes a failed/retried commit still needs.
  //
  // FS backend: unlinkStaging is a no-op here because `rename`
  // already removed the source file; the tolerant ENOENT path
  // handles it. Vercel backend: actually deletes the staging blob.
  await handle.blob.unlinkStaging(input.workspaceTag, input.stagingId)
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

// Idempotent — DELETE row is a no-op when already gone, not-found
// unlink is ignored. Routes through `handle.blob.unlinkStaging` so
// the FS backend uses async unlink (no event-loop stall on a slow
// disk) and the Vercel backend issues an HTTP DELETE.
export async function abortPut(handle: Handle, tag: string, resourceTag: string, stagingId: string): Promise<void> {
  await handle.blob.unlinkStaging(tag, stagingId)
  await handle.deleteStaging.run(tag, resourceTag, stagingId)
}

// `prevVersion = null` + missing row = already-deleted-or-never-
// existed; treat as success so retried DELETEs are idempotent. The
// `deletedVersion = 0` sentinel tells the broadcast path to skip.
// Callers serialise per-resource via KeyedAsyncLock.
//
// On success we ONLY drop the live row — we do NOT unlink the live
// blob. With content-addressing the blob at `${tag}/${hash}.bin` may
// still be referenced by another resource (or a not-yet-cleaned older
// version) that committed byte-identical content, so unlinking here
// could pull bytes out from under a live row that names the same hash.
// The reaper's GC unlinks the blob once no live row references its
// hash AND it's past the grace window.
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
  return { ok: true, deletedVersion: live.version }
}
