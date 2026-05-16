// SQLite-backed revision storage. Two columns identify a revision:
//   `seq`  monotonic per workspace_tag, server-assigned at insert.
//          Drives chain ordering and `from`-cutoff filtering.
//   `id`   content-addressed identifier — SHA-256 of the canonical
//          save bytes (workspaceTag, base, keyframe, nonce,
//          ciphertext), base64url-encoded. Computed by client AND
//          server from the same input, so the server can't
//          reassign or relabel revisions; UNIQUE on
//          (workspace_tag, id) makes retransmits idempotent.
// `base` points at the previous revision's `id` (or null for the
// first revision in a workspace).
//
// `keyframe` is `1` for a revision the client emits with the full
// state baked in (rather than just a delta). The wire-level flag
// is also covered by the signature, so the column value MUST match
// what the signed canonical bytes claim — `verifySaveSigAndCanonical`
// in server/sign.ts enforces this. Client-driven: the server only
// stores what the client sent and treats keyframes as catch-up
// roots when a from=null subscriber arrives.
//
// `node:sqlite` is the built-in driver (Node ≥ 22 experimental,
// stable in 24+). The driver is synchronous under the hood; the
// Handle wraps each prepared statement so call sites `await`
// uniformly. This is async-ready surface for a future async DB
// backend — every operation today resolves in the current microtask
// off a sync `node:sqlite` call.
//
// Because operations are now async, two handlers can interleave
// across an `await`. `commitRevision` (below) collapses the entire
// post-signature critical section — dup recheck, base-equality
// check, MAX(seq) + INSERT — into a single `KeyedAsyncLock.run` per
// workspace_tag. The lock instance is module-private (stored in
// `writeLocks`, a `WeakMap<Handle, …>`), so only this module's
// `commitRevision` can serialise against itself; no caller can
// accidentally over- or under-serialise the wrong region.

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { KeyedAsyncLock } from './objstore/lock.ts'
import { type AllStmt, type GetStmt, type RunStmt, wrapAll, wrapGet, wrapRun } from './db-stmt.ts'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS workspace_revision (
    workspace_tag TEXT NOT NULL,
    seq INTEGER NOT NULL,
    id TEXT NOT NULL,
    base TEXT,
    keyframe INTEGER NOT NULL DEFAULT 0,
    nonce TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    signature TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_tag, seq),
    UNIQUE (workspace_tag, id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS workspace_revision_tag_id_idx
    ON workspace_revision (workspace_tag, id);
`

// Row shape returned by the chain queries. SQLite stores `keyframe`
// as INTEGER (0 / 1); `chainForWire` in server/index.ts normalises
// to a strict boolean before broadcasting, but the raw row carries
// the integer. `base` is nullable on the very first revision.
export type RevisionRow = {
  base: string | null
  id: string
  keyframe: number
  nonce: string
  ciphertext: string
  signature: string
}

// Input to `commitRevision`. `keyframe` is a strict boolean here —
// the canonical-payload contract uses `=== true`, and the storage
// path coerces to 0 / 1 via `keyframe ? 1 : 0` before hitting the
// STRICT INTEGER column.
export type RevisionInsert = {
  tag: string
  id: string
  base: string | null
  keyframe: boolean
  nonce: string
  ciphertext: string
  signature: string
}

// Outcome of `commitRevision`. `duplicate` means the id is already
// in the chain (a retransmit landed during our await window).
// `stale-base` means a concurrent save advanced the head past the
// caller's claimed base — the caller renders this as a
// `workspace-state` catch-up. `inserted` is the success path.
export type CommitResult =
  | { kind: 'inserted' }
  | { kind: 'duplicate' }
  | { kind: 'stale-base'; head: string | null }

// Bag of pre-prepared statements + the underlying connection.
// Held for the process lifetime; `close()` runs from `shutdown()`.
// The per-(workspace_tag) write lock is kept OFF this type and
// stored in a module-private WeakMap — only `commitRevision` here
// touches it, so no caller can accidentally acquire a lock for the
// wrong scope.
//
// `db` is the raw `DatabaseSync` and is SQLite-only. The Neon
// backend (`./db-neon.ts`) constructs a Handle with `db` unset.
// Callers that reach into `db` directly (e.g. `openObjstore`,
// test-only fixture SQL) are SQLite-coupled by construction —
// passing them a Neon-backed Handle is the operator's mistake to
// catch at the `if (DATABASE_URL)` switch in `server/index.ts`.
export type Handle = {
  db?: DatabaseSync
  headFor: GetStmt<[string], { id: string }>
  headSeq: GetStmt<[string], { s: number | null }>
  seqOfId: GetStmt<[string, string], { seq: number }>
  lastKeyframeSeq: GetStmt<[string], { s: number | null }>
  chainAll: AllStmt<[string], RevisionRow>
  chainAfterSeq: AllStmt<[string, number], RevisionRow>
  chainFromSeq: AllStmt<[string, number], RevisionRow>
  revisionExists: GetStmt<[string, string], unknown>
  insertRevision: RunStmt<[string, number, string, string | null, number, string, string, string, number]>
  close: () => Promise<void>
}

// Narrowing alias for the SQLite-backed Handle: `db` is guaranteed
// to be set. `openDb` returns this so call sites that need direct
// `DatabaseSync` access (e.g. `openObjstore(handle.db, …)` in
// `server/index.ts`'s SQLite branch) can reach `handle.db` without
// an optional-chain or non-null assertion. A Neon-backed Handle
// (`openNeonDb`) keeps the wider `db?: DatabaseSync` shape; routing
// a Neon Handle into a SQLite-coupled call site is a compile-time
// error. Mirrors the same pattern in `server/objstore/store.ts`.
export type SqliteHandle = Handle & { db: DatabaseSync }

// Module-private per-handle write lock. `commitRevision` is the
// sole caller; exposing it on the Handle would invite a future
// caller to grab it for an unrelated operation and either over- or
// under-serialise the wrong critical section. WeakMap so a closed
// handle's lock is GC'd alongside it without a manual delete.
const writeLocks = new WeakMap<Handle, KeyedAsyncLock<string>>()

// Internal helper used by alternative backends (currently just
// `db-neon.ts`) to register their handle's lock without touching
// the module-private `writeLocks` map directly. Underscore-prefix
// signals "internal API, do not call from application code".
export function _attachWriteLock(handle: Handle): void {
  writeLocks.set(handle, new KeyedAsyncLock<string>())
}

export function openDb(path: string): SqliteHandle {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  // Any throw between the DatabaseSync constructor and the return
  // would otherwise leak the underlying file / WAL / shm locks until
  // process exit — close before re-raising so the operator can fix
  // the underlying issue (failed STRICT check, ALTER TABLE error,
  // …) and re-run without a stale lock pinning the file.
  try {
    return openDbInner(db)
  } catch (err) {
    try { db.close() } catch {}
    throw err
  }
}

function openDbInner(db: DatabaseSync): SqliteHandle {
  // WAL gives concurrent readers + faster writes and survives
  // crashes between commits without corrupting the file. Foreign
  // keys aren't strictly needed here (single-table schema) but
  // turning them on preserves the option to add referential
  // tables later without revisiting init.
  db.exec('PRAGMA journal_mode = WAL;')
  // FULL (not NORMAL): the server emits `workspace-save-ack` BEFORE
  // returning to the event loop after `commitRevision`. With NORMAL,
  // SQLite only fsyncs at WAL checkpoint, so a power loss between
  // ack and the next checkpoint loses the row even though the
  // originator and broadcast peers were told the revision committed.
  // FULL fsyncs per commit; durability matches the contract the
  // ack implies. Trade-off is per-commit fsync latency, acceptable
  // for the protocol's edit-driven write pattern (triage edits, not
  // streaming throughput). Audit round-9 M1.
  db.exec('PRAGMA synchronous = FULL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  // Fail-loud on a pre-existing non-STRICT table — `CREATE TABLE IF
  // NOT EXISTS … STRICT` is a no-op when the table already exists,
  // so a deployment that predates the STRICT marker would silently
  // keep its non-STRICT shape. Without STRICT, an operator with
  // direct DB write access could insert mis-typed rows (e.g. a
  // `keyframe = "1\nfoo"` text value in the INTEGER column) and
  // poison the chain — the signed canonical the client originally
  // hashed says `keyframe = 1`, but the stored `keyframe = "1\nfoo"`
  // round-trips back into the canonical as a different string,
  // making every subsequent verify fail. Operator must migrate
  // before this server boots.
  const meta = db.prepare(
    `SELECT strict FROM pragma_table_list WHERE schema = 'main' AND name = 'workspace_revision'`,
  ).get() as { strict: number } | undefined
  if (meta && meta.strict !== 1) {
    throw new Error('workspace_revision is non-STRICT — migrate via rename+create+copy before booting')
  }
  // Idempotent migration for DBs created before the keyframe column
  // existed. Inspect the column list rather than catching every
  // ALTER error — the previous shape swallowed `try { ALTER } catch
  // {}` for ANY failure (lock contention, disk full, corrupt page),
  // masking real problems as "column already exists". Now we only
  // ALTER when the column is genuinely missing, and any failure of
  // the ALTER itself bubbles up as an open-time crash where the
  // operator can act on it.
  const columns = db.prepare(`PRAGMA table_info(workspace_revision)`).all() as Array<{ name: string }>
  if (!columns.some((c) => c.name === 'keyframe')) {
    db.exec(`ALTER TABLE workspace_revision ADD COLUMN keyframe INTEGER NOT NULL DEFAULT 0`)
  }
  const handle: SqliteHandle = {
    db,
    headFor: wrapGet<[string], { id: string }>(db.prepare(`
      SELECT id FROM workspace_revision
      WHERE workspace_tag = ?
      ORDER BY seq DESC LIMIT 1
    `)),
    headSeq: wrapGet<[string], { s: number | null }>(db.prepare(`
      SELECT MAX(seq) AS s FROM workspace_revision WHERE workspace_tag = ?
    `)),
    seqOfId: wrapGet<[string, string], { seq: number }>(db.prepare(`
      SELECT seq FROM workspace_revision
      WHERE workspace_tag = ? AND id = ?
    `)),
    lastKeyframeSeq: wrapGet<[string], { s: number | null }>(db.prepare(`
      SELECT MAX(seq) AS s FROM workspace_revision
      WHERE workspace_tag = ? AND keyframe = 1
    `)),
    chainAll: wrapAll<[string], RevisionRow>(db.prepare(`
      SELECT base, id, keyframe, nonce, ciphertext, signature
      FROM workspace_revision
      WHERE workspace_tag = ?
      ORDER BY seq ASC
    `)),
    chainAfterSeq: wrapAll<[string, number], RevisionRow>(db.prepare(`
      SELECT base, id, keyframe, nonce, ciphertext, signature
      FROM workspace_revision
      WHERE workspace_tag = ? AND seq > ?
      ORDER BY seq ASC
    `)),
    chainFromSeq: wrapAll<[string, number], RevisionRow>(db.prepare(`
      SELECT base, id, keyframe, nonce, ciphertext, signature
      FROM workspace_revision
      WHERE workspace_tag = ? AND seq >= ?
      ORDER BY seq ASC
    `)),
    revisionExists: wrapGet<[string, string], unknown>(db.prepare(`
      SELECT 1 FROM workspace_revision
      WHERE workspace_tag = ? AND id = ?
    `)),
    insertRevision: wrapRun<[string, number, string, string | null, number, string, string, string, number]>(db.prepare(`
      INSERT INTO workspace_revision
        (workspace_tag, seq, id, base, keyframe, nonce, ciphertext, signature, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)),
    // Match the wrap{Get,All,Run} contract: async-wrapped so a sync
    // throw from `db.close()` (already closed, locked transaction, …)
    // surfaces as a Promise rejection rather than escaping the
    // wrapper synchronously.
    // eslint-disable-next-line require-await
    close: async () => { db.close() },
  }
  writeLocks.set(handle, new KeyedAsyncLock<string>())
  return handle
}

export async function headFor(handle: Handle, tag: string): Promise<string | null> {
  const row = await handle.headFor.get(tag)
  return row?.id ?? null
}

export async function chainFrom(handle: Handle, tag: string, fromId: string | null): Promise<RevisionRow[]> {
  // No base id, OR a base id the server doesn't recognise (db reset,
  // chain compaction, malicious peer): in either case the client has
  // no anchor we can incrementally serve from. Skip past everything
  // before the latest keyframe — the keyframe replaces baseState, so
  // anything older is redundant — and fall through to the full chain
  // only when no keyframe has been emitted yet (small workspace
  // hasn't crossed the threshold). Keeps the catch-up cost O(keyframe
  // interval) instead of O(history length) for either entry point.
  if (fromId != null) {
    const row = await handle.seqOfId.get(tag, fromId)
    if (row) return handle.chainAfterSeq.all(tag, row.seq)
    // fall through to the from=null path below
  }
  const kf = await handle.lastKeyframeSeq.get(tag)
  if (kf?.s != null) return handle.chainFromSeq.all(tag, kf.s)
  return handle.chainAll.all(tag)
}

export async function revisionExists(handle: Handle, tag: string, id: string): Promise<boolean> {
  return Boolean(await handle.revisionExists.get(tag, id))
}

// Driver shapes for a primary-key or unique-index violation.
// `commitRevision`'s INSERT can hit either constraint under a
// multi-process race against the same database: the
// `(workspace_tag, seq)` PK if a sibling process landed a row with
// our computed seq, or the `(workspace_tag, id)` UNIQUE if a
// sibling retransmit slipped in with the same id. Both are
// recoverable.
//
// We accept several driver-error shapes so the recovery path
// doesn't silently regress under a driver upgrade:
//   • Postgres / Neon: SQLSTATE `23505` via `err.code`.
//   • node:sqlite: `SQLITE_CONSTRAINT_UNIQUE` /
//     `SQLITE_CONSTRAINT_PRIMARYKEY` via `err.code`.
//   • SQLite fallback by message-shape: modern releases emit
//     "UNIQUE constraint failed: …" for both UNIQUE-index and
//     PRIMARY-KEY violations; older / certain paths instead emit
//     "PRIMARY KEY must be unique". Match both so a future Node
//     `node:sqlite` change can't silently turn a recoverable
//     conflict into an unhandled rejection.
function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { code?: string }).code
  if (code === '23505') return true
  if (code === 'SQLITE_CONSTRAINT_UNIQUE') return true
  if (code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true
  if (err.message.includes('UNIQUE constraint failed')) return true
  if (err.message.includes('PRIMARY KEY must be unique')) return true
  // Postgres / Neon message-shape fallback. The Postgres phrasing
  // is "duplicate key value violates unique constraint …" — caught
  // by SQLSTATE `23505` above today, but the message-shape match
  // is belt-and-suspenders against a future Neon driver release
  // that omits or renames `err.code`. Without it a missing `code`
  // would silently regress the recovery path to "rethrow as an
  // operational error" and the originator would never see the
  // `stale-base` / `duplicate` catch-up.
  if (err.message.includes('duplicate key value violates unique constraint')) return true
  return false
}

// Atomic commit of a single revision. Dup-id check, base-equality
// check, MAX(seq) computation, and INSERT all run inside one
// `writeLock.run(tag, …)` block — the previously sync-atomic span
// in `handleSave`'s post-signature path. Without the lock:
//
//   • Concurrent saves with the same `base` and DIFFERENT id would
//     both pass an out-of-lock base-match check, both insert, and
//     fork the chain (two rows with the same `base`). The schema
//     allows it — UNIQUE is on (workspace_tag, id), not on `base`.
//   • Concurrent retransmits with the same id would both pass an
//     out-of-lock dup recheck, both reach INSERT, and the second
//     would throw on UNIQUE — the originator never sees an ack.
//
// Within one process the lock closes both manifestations.
//
// ACROSS processes — supported on the Neon backend — the in-process
// lock can't serialise; two Node processes connected to the same DB
// can both pass all four pre-INSERT checks and both INSERT. The
// `PRIMARY KEY (workspace_tag, seq)` and `UNIQUE (workspace_tag, id)`
// constraints are the multi-process backstops: at least one loser's
// INSERT raises a unique-violation. The `try` below catches it and
// refetches `revisionExists` + `headFor` while still under our own
// per-`workspace_tag` lock. The refetch reads from whatever is
// committed in the DB at refetch time — possibly advanced past the
// immediate winner by a third process — and that's intentional:
// the recovery is read-after-write-failure with no isolation-level
// assumption, and any committed head we see is a valid stale-base
// target. Returns the standard `duplicate` / `stale-base` outcome;
// the caller's WS handler renders these as ack-only /
// `workspace-state` catch-up. No silent failure, no chain fork.
export function commitRevision(
  handle: Handle,
  { tag, id, base, keyframe, nonce, ciphertext, signature }: RevisionInsert,
): Promise<CommitResult> {
  const lock = writeLocks.get(handle)
  // The WeakMap is populated by `openDbInner`; the only way to hit
  // this is to construct a `Handle` literal by hand (e.g. a test
  // mock). Surface as a rejection rather than a sync throw so the
  // function's Promise-returning contract holds for every caller —
  // an unawaited write would otherwise leak an uncaught exception.
  if (!lock) return Promise.reject(new Error('commitRevision: handle not opened via openDb'))
  return lock.run(tag, async () => {
    if (await handle.revisionExists.get(tag, id)) return { kind: 'duplicate' }
    const headRow = await handle.headFor.get(tag)
    const head = headRow?.id ?? null
    const baseNorm = base ?? null
    const matches = baseNorm == null ? head == null : baseNorm === head
    if (!matches) return { kind: 'stale-base', head }
    const seqRow = await handle.headSeq.get(tag)
    const seq = (seqRow?.s ?? 0) + 1
    try {
      // Strict-boolean coercion via `=== true`. The canonical signed
      // by the client uses `keyframe === true ? '1' : ''` — anything
      // truthy-but-not-strictly-true (e.g. `1`, `"true"`, `{}`) would
      // canonicalize to `''` (non-keyframe) on the verifier side but
      // would round-trip to `1` here via the looser ternary, diverging
      // signed bytes from stored bytes. TS narrows `keyframe` to
      // `boolean` upstream; the strict comparison is defense-in-depth
      // against a future caller that loosens the field type or a
      // direct invocation from a non-typed context. Input-validation
      // audit `server/db.ts:389`.
      const keyframeCol = keyframe === true ? 1 : 0
      await handle.insertRevision.run(tag, seq, id, baseNorm, keyframeCol, nonce, ciphertext, signature, Date.now())
      return { kind: 'inserted' }
    } catch (err) {
      // Only convert unique-violations; rethrow other driver errors
      // (network, connection-closed, …) so they surface as real
      // failures rather than masking as a stale-base catch-up.
      if (!isUniqueViolation(err)) throw err
      // The PK / UNIQUE was the only thing standing between us and
      // a chain fork. Refetch and route through one of two outcomes:
      //
      //   • The row IS in the chain — return `inserted`. We can't
      //     distinguish "we successfully INSERTed but the driver's
      //     retry layer wrapped the response as a unique-violation"
      //     from "a sibling process committed our id first". In the
      //     first case the row IS our save and peers MUST receive
      //     the broadcast; in the second it's still safe to
      //     broadcast because clients dedup by content-addressed
      //     `id` (and the id collision implies the canonical bytes
      //     are byte-identical, so a peer can't tell the difference
      //     anyway). Treating recovery-exists as `inserted` is the
      //     defensive choice — broadcast on possibly-ours rather
      //     than silently drop the broadcast on definitely-ours.
      //
      //   • The row is NOT in the chain — head advanced past our
      //     computed seq via a sibling commit with a different id.
      //     `stale-base` so the caller renders a `workspace-state`
      //     catch-up.
      if (await handle.revisionExists.get(tag, id)) return { kind: 'inserted' }
      const newHeadRow = await handle.headFor.get(tag)
      return { kind: 'stale-base', head: newHeadRow?.id ?? null }
    }
  })
}
