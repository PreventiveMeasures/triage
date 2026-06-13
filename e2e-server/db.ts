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
// `keyframe` is `1` for a revision the client emits with full state
// baked in (rather than a delta). The wire flag is covered by the
// signature, so the column value MUST match the signed canonical
// bytes: `canonicalSave` (e2e-server/sign.ts, via `handleSave`) encodes
// `keyframe ? '1' : ''` into the bytes `verifyEd25519` checks, so a
// mismatched wire flag fails verify and never reaches this column.
// Client-driven: the server stores what the client sent and treats
// keyframes as catch-up roots when a from=null subscriber arrives.
//
// `node:sqlite` is the built-in driver (Node ≥ 22 experimental,
// stable in 24+), synchronous under the hood; the Handle wraps each
// prepared statement so call sites `await` uniformly — async-ready
// surface for a future async DB backend (every op resolves in the
// current microtask off a sync call).
//
// Operations being async, two handlers can interleave across an
// `await`. `commitRevision` (below) takes NO in-process lock — it
// folds the dup recheck, base-equality check, MAX(seq) and INSERT
// into ONE gated INSERT (`commitRevisionSqlite`). `node:sqlite` runs
// that statement to completion without yielding, so its head-check +
// MAX(seq) read ONE snapshot, which is what makes a per-tag lock
// redundant. SQLite also serialises writers internally, and the PK
// backstops the unsupported multi-connection case. See
// `commitRevisionSqlite` for the full fork-safety argument.

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { type AllStmt, type GetStmt, wrapAll, wrapGet } from './db-stmt.ts'
import {
  CHAIN_AFTER_SQL, CHAIN_ALL_SQL, CHAIN_FROM_SQL, GATED_INSERT_SQL_SQLITE, HEAD_FOR_SQL,
  LAST_KEYFRAME_SEQ_SQL, REVISION_BY_ID_SQL, REVISION_EXISTS_SQL, SEQ_OF_ID_SQL,
  mapRevisionRow, toSqlitePlaceholders,
} from './db-revision-sql.ts'

// `CHECK (keyframe IN (0, 1))` is the value-domain guard. STRICT
// (the table marker) enforces the column TYPE (an INTEGER stays an
// INTEGER) but NOT its value range: `keyframe = 2` is a valid integer
// STRICT accepts, which `mapRevisionRow`'s `=== 1` check then coerces
// back to 0. That divergence from the signed canonical (only ever
// 0 / 1) poisons chain-replay verifies for any recomputing peer — the
// same operator-with-direct-DB-write vector the STRICT guard in
// `openDbInner` catches for TYPE. The CHECK closes the value-domain
// half, matching the Neon schema's identical CHECK (see `db-neon.ts`).
//
// Parenthesised column + constraint body (plus STRICT marker), shared
// by the initial `CREATE TABLE` and the `migrateAddKeyframeCheck`
// rebuild below — so a rebuilt table is byte-identical in shape to a
// fresh one and a future column edit can't drift the two apart.
const WORKSPACE_REVISION_DEF = `(
    workspace_tag TEXT NOT NULL,
    seq INTEGER NOT NULL,
    id TEXT NOT NULL,
    base TEXT,
    keyframe INTEGER NOT NULL DEFAULT 0 CHECK (keyframe IN (0, 1)),
    nonce TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    signature TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_tag, seq),
    UNIQUE (workspace_tag, id)
  ) STRICT`

const WORKSPACE_REVISION_TAG_ID_INDEX = `CREATE INDEX IF NOT EXISTS workspace_revision_tag_id_idx
    ON workspace_revision (workspace_tag, id)`

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS workspace_revision ${WORKSPACE_REVISION_DEF};

  ${WORKSPACE_REVISION_TAG_ID_INDEX};
`

// Row shape from the chain queries. `keyframe` is stored as INTEGER
// (0 / 1); the raw row carries the integer — `chainForWire` in
// e2e-server/index.ts normalises to a strict boolean before broadcasting.
// `base` is nullable on the very first revision.
export type RevisionRow = {
  base: string | null
  id: string
  keyframe: number
  nonce: string
  ciphertext: string
  signature: string
}

// Input to `commitRevision`. `keyframe` is a strict boolean here —
// the canonical-payload contract uses `=== true`; the storage path
// coerces to 0 / 1 before hitting the STRICT INTEGER column.
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

// Pre-prepared statements + the underlying connection, held for the
// process lifetime; `close()` runs from `shutdown()`.
//
// `db` is the raw `DatabaseSync`, SQLite-only — the Neon backend
// (`./db-neon.ts`) constructs a Handle with `db` unset. Callers that
// reach into `db` directly (e.g. `openObjstore`, test-only fixture
// SQL) are SQLite-coupled by construction; passing them a Neon-backed
// Handle is the operator's mistake to catch at the `if (DATABASE_URL)`
// switch in `e2e-server/index.ts`.
//
// `tryCommit` is the backend-specific atomic-commit primitive
// `commitRevision` dispatches through. SQLite runs one synchronous
// gated INSERT (see `commitRevisionSqlite`); Neon wraps it in a
// pipelined transaction (see `db-neon.ts`'s `tryCommitNeon`). Both
// rely on a single-statement snapshot + the `UNIQUE(workspace_tag,
// seq)` PK for fork-safety; see those functions for the argument.
//
// `gatedInsert` is SQLite-only (like `db`): it backs
// `commitRevisionSqlite`'s single gated INSERT. The Neon backend
// leaves it unset — its gated INSERT lives inside the pipelined
// `sql.transaction([...])`, not a standalone statement object. Kept
// on the Handle (not a module-private closure) so SQLite white-box
// tests can wrap `.get` to inject a unique-violation / non-unique
// failure into the commit, exercising the same recovery paths the
// Neon suite stages via `failNextCommit`.
export type Handle = {
  db?: DatabaseSync
  headFor: GetStmt<[string], { id: string }>
  seqOfId: GetStmt<[string, string], { seq: number }>
  lastKeyframeSeq: GetStmt<[string], { s: number | null }>
  chainAll: AllStmt<[string], RevisionRow>
  chainAfterSeq: AllStmt<[string, number], RevisionRow>
  chainFromSeq: AllStmt<[string, number], RevisionRow>
  revisionExists: GetStmt<[string, string], unknown>
  // Single-revision fetch by content-addressed id. The cross-instance
  // pubsub receiver uses this to assemble a `workspace-state` from a
  // NOTIFY hint (see `e2e-server/pubsub.ts`).
  revisionById: GetStmt<[string, string], RevisionRow>
  gatedInsert?: GetStmt<[string, string, string | null, number, string, string, string, number], { seq: number }>
  tryCommit: (input: RevisionInsert) => Promise<CommitResult>
  close: () => Promise<void>
}

// Narrowing alias for the SQLite-backed Handle: `db` is guaranteed
// set. `openDb` returns this so call sites needing direct
// `DatabaseSync` access (e.g. `openObjstore(handle.db, …)` in
// `e2e-server/index.ts`'s SQLite branch) reach `handle.db` without an
// optional-chain or non-null assertion. A Neon-backed Handle
// (`openNeonDb`) keeps the wider `db?: DatabaseSync` shape, so routing
// one into a SQLite-coupled call site is a compile-time error. Mirrors
// `e2e-server/objstore/store.ts`.
export type SqliteHandle = Handle & { db: DatabaseSync }

export function openDb(path: string): SqliteHandle {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  // A throw between the DatabaseSync constructor and the return would
  // leak the file / WAL / shm locks until process exit — close before
  // re-raising so the operator can fix the cause (failed STRICT check,
  // ALTER TABLE error, …) and re-run without a stale lock on the file.
  try {
    return openDbInner(db)
  } catch (err) {
    try { db.close() } catch {}
    throw err
  }
}

function openDbInner(db: DatabaseSync): SqliteHandle {
  // WAL gives concurrent readers + faster writes and survives crashes
  // between commits without corrupting the file. Foreign keys aren't
  // needed here (single-table schema) but turning them on keeps the
  // option to add referential tables later without revisiting init.
  db.exec('PRAGMA journal_mode = WAL;')
  // FULL (not NORMAL): the server emits `workspace-save-ack` BEFORE
  // returning to the event loop after `commitRevision`. NORMAL only
  // fsyncs at WAL checkpoint, so a power loss between ack and the next
  // checkpoint loses a row the originator + peers were told committed.
  // FULL fsyncs per commit, matching the durability the ack implies.
  // Trade-off is per-commit fsync latency, acceptable for the edit-
  // driven write pattern (triage edits, not streaming). Audit round-9 M1.
  db.exec('PRAGMA synchronous = FULL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  // Fail-loud on a pre-existing non-STRICT table — `CREATE TABLE IF
  // NOT EXISTS … STRICT` is a no-op when the table exists, so a
  // deployment predating the STRICT marker keeps its non-STRICT shape.
  // Without STRICT, an operator with direct DB write access could
  // insert mis-typed rows (e.g. `keyframe = "1\nfoo"` text in the
  // INTEGER column) and poison the chain: the signed canonical says
  // `keyframe = 1`, but the stored text round-trips into the canonical
  // as a different string, failing every subsequent verify. Operator
  // must migrate before this server boots.
  const meta = db.prepare(
    `SELECT strict FROM pragma_table_list WHERE schema = 'main' AND name = 'workspace_revision'`,
  ).get() as { strict: number } | undefined
  if (meta && meta.strict !== 1) {
    throw new Error('workspace_revision is non-STRICT — migrate via rename+create+copy before booting')
  }
  // Idempotent migration for DBs created before the keyframe column
  // existed. Inspect the column list rather than `try { ALTER } catch
  // {}`: a blanket catch swallows ANY failure (lock contention, disk
  // full, corrupt page) as "column already exists". ALTER only when
  // the column is genuinely missing, so an ALTER failure bubbles up as
  // an open-time crash the operator can act on.
  const columns = db.prepare(`PRAGMA table_info(workspace_revision)`).all() as Array<{ name: string }>
  if (!columns.some((c) => c.name === 'keyframe')) {
    // ADD COLUMN carries the CHECK so a legacy DB migrating up lands
    // the value-domain guard alongside the column. Existing rows take
    // the DEFAULT 0, which satisfies the CHECK, so the ALTER succeeds.
    db.exec(`ALTER TABLE workspace_revision ADD COLUMN keyframe INTEGER NOT NULL DEFAULT 0 CHECK (keyframe IN (0, 1))`)
  }
  // Auto-migrate a pre-existing keyframe column that lacks the CHECK.
  // `CREATE TABLE IF NOT EXISTS … CHECK` is a no-op when the table
  // already exists, and SQLite cannot ALTER a CHECK onto an existing
  // column, so a DB created before this CHECK existed keeps its
  // unconstrained keyframe column — silently dropping the value-domain
  // guard. The freshly-added ALTER column above already carries the
  // CHECK, so only a genuinely pre-CHECK keyframe column reaches the
  // rebuild. Detect it from the stored DDL (SQLite folds an
  // ALTER-added column's CHECK back into the table's CREATE text, so
  // this matches both creation paths) and rebuild the table in place.
  const ddl = (db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspace_revision'`,
  ).get() as { sql: string } | undefined)?.sql ?? ''
  if (!/CHECK\s*\(\s*keyframe\s+IN\b/iu.test(ddl)) {
    migrateAddKeyframeCheck(db)
  }
  // Prepare a chain SELECT (shared `$N` source → `?N`) and map each row
  // through the shared `mapRevisionRow` — same `AllStmt<…, RevisionRow>`
  // contract the Neon backend exposes, so consumers see identical rows.
  // Reuses `wrapAll` (the sync-throw→rejection wrapper) for the raw rows
  // and layers the row mapper on top.
  const chainStmt = <P extends unknown[]>(query: string): AllStmt<P, RevisionRow> => {
    const raw = wrapAll<P, Record<string, unknown>>(db.prepare(toSqlitePlaceholders(query)))
    return { all: async (...args: P) => (await raw.all(...args)).map(mapRevisionRow) }
  }
  // Reuses `wrapGet` for the prepared statement, then maps the row
  // through the shared coercion so the returned shape matches `chainFrom`.
  const revisionByIdStmt: GetStmt<[string, string], RevisionRow> = (() => {
    const raw = wrapGet<[string, string], Record<string, unknown>>(
      db.prepare(toSqlitePlaceholders(REVISION_BY_ID_SQL)),
    )
    return { get: async (tag, id) => {
      const row = await raw.get(tag, id)
      return row ? mapRevisionRow(row) : undefined
    } }
  })()
  const handle: SqliteHandle = {
    db,
    headFor: wrapGet<[string], { id: string }>(db.prepare(toSqlitePlaceholders(HEAD_FOR_SQL))),
    seqOfId: wrapGet<[string, string], { seq: number }>(db.prepare(toSqlitePlaceholders(SEQ_OF_ID_SQL))),
    lastKeyframeSeq: wrapGet<[string], { s: number | null }>(db.prepare(toSqlitePlaceholders(LAST_KEYFRAME_SEQ_SQL))),
    chainAll: chainStmt<[string]>(CHAIN_ALL_SQL),
    chainAfterSeq: chainStmt<[string, number]>(CHAIN_AFTER_SQL),
    chainFromSeq: chainStmt<[string, number]>(CHAIN_FROM_SQL),
    revisionExists: wrapGet<[string, string], unknown>(db.prepare(toSqlitePlaceholders(REVISION_EXISTS_SQL))),
    revisionById: revisionByIdStmt,
    // SQLite null-safe equality is `IS`; the numbered `?N` form (with
    // reuse) maps `$1`/`$2`/`$3` to repeated positional binds. `RETURNING
    // seq` works in node:sqlite (see objstore's `insertLiveIfAbsent`).
    gatedInsert: wrapGet<
      [string, string, string | null, number, string, string, string, number],
      { seq: number }
    >(db.prepare(GATED_INSERT_SQL_SQLITE)),
    tryCommit: (input) => commitRevisionSqlite(handle, input),
    // Match the wrap{Get,All,Run} contract: async-wrapped so a sync
    // throw from `db.close()` (already closed, locked transaction, …)
    // surfaces as a Promise rejection rather than escaping the
    // wrapper synchronously.
    // eslint-disable-next-line require-await
    close: async () => { db.close() },
  }
  return handle
}

// Rebuild `workspace_revision` in place to add the
// `CHECK (keyframe IN (0, 1))` a pre-CHECK DB lacks. SQLite can't ALTER
// a CHECK onto an existing column, so this runs the documented
// create-new + copy + drop + rename rebuild, wrapped in ONE transaction
// so a crash mid-rebuild rolls back to the original table rather than
// losing it. No table in this DB file carries a foreign key referencing
// workspace_revision (the objstore tables are independent), so the DROP
// can't cascade and `foreign_keys` can stay ON. If any existing row
// holds a keyframe outside {0, 1} — the exact poison the CHECK exists
// to reject — the copy trips the new CHECK, the whole transaction rolls
// back, and the original table survives intact; the violation surfaces
// to the operator (openDb's catch closes the handle and rethrows)
// rather than silently coercing or dropping the bad row. Reuses
// `WORKSPACE_REVISION_DEF` so the rebuilt table matches a fresh one.
function migrateAddKeyframeCheck(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`CREATE TABLE workspace_revision_new ${WORKSPACE_REVISION_DEF}`)
    db.exec(
      `INSERT INTO workspace_revision_new
         (workspace_tag, seq, id, base, keyframe, nonce, ciphertext, signature, created_at)
       SELECT workspace_tag, seq, id, base, keyframe, nonce, ciphertext, signature, created_at
       FROM workspace_revision`,
    )
    db.exec('DROP TABLE workspace_revision')
    db.exec('ALTER TABLE workspace_revision_new RENAME TO workspace_revision')
    db.exec(WORKSPACE_REVISION_TAG_ID_INDEX)
    db.exec('COMMIT')
  } catch (err) {
    // Best-effort rollback so the original table survives a failed
    // rebuild (e.g. a poison keyframe row tripping the new CHECK). The
    // ROLLBACK's own error is irrelevant — we always rethrow the
    // original cause, which is what the operator needs to act on.
    try { db.exec('ROLLBACK') } catch {}
    throw err
  }
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
export function isUniqueViolation(err: unknown): boolean {
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

// Atomic commit of a single revision. Backends dispatch through
// `handle.tryCommit` (set up at openDb / openNeonDb time):
//
//   • SQLite uses `commitRevisionSqlite` (below) — ONE synchronous
//     gated INSERT, no in-process lock. `node:sqlite` doesn't yield
//     mid-statement, so the head-check and MAX(seq) read from one
//     snapshot; a racer is forced onto either the same seq (PK
//     rejects → recovery → stale-base) or a stale head (no insert →
//     stale-base). Single-process is the only supported SQLite
//     deployment shape; the PK backstops the multi-connection case.
//   • Neon wraps the dup-check + head-check + gated INSERT in a
//     pipelined transaction. No commit-time advisory lock: the
//     gated INSERT's head-check and MAX(seq) read one Postgres
//     READ-COMMITTED statement snapshot, and the
//     `UNIQUE(workspace_tag, seq)` PK rejects a racer that computed
//     the same seq — so a cross-replica racer either collides on the
//     PK (→ recovery → stale-base) or sees the advanced head (→ no
//     insert → stale-base), never a silent fork. See `db-neon.ts`'s
//     `tryCommitNeon` for the per-statement rationale.
export function commitRevision(handle: Handle, input: RevisionInsert): Promise<CommitResult> {
  // A hand-rolled Handle literal (e.g. a test mock) won't carry a
  // `tryCommit` impl. Surface as a Promise rejection rather than a
  // sync TypeError so the function's Promise-returning contract
  // holds for every caller. Matches the previous-shape error
  // string ("handle not opened via openDb") so existing tests /
  // log alerts that match on it keep firing.
  if (typeof handle.tryCommit !== 'function') {
    return Promise.reject(new Error('commitRevision: handle not opened via openDb'))
  }
  return handle.tryCommit(input)
}

// SQLite-style atomic commit. NO in-process lock — it fires the SAME
// single gated INSERT the Neon path uses —
// `INSERT … SELECT COALESCE(MAX(seq),0)+1 … WHERE NOT EXISTS(dup) AND
// head IS base RETURNING seq` (SQLite's `IS` is the null-safe equality;
// Neon uses `IS NOT DISTINCT FROM`) — then discriminates the outcome.
//
// Why the lock is gone (the fork-safety argument):
//   • `node:sqlite` is SYNCHRONOUS: the gated INSERT runs to completion
//     in one turn without yielding the event loop, so no concurrent
//     `commitRevision` can interleave in the middle of it. The
//     head-check `(SELECT id … ORDER BY seq DESC LIMIT 1)` and the
//     `COALESCE(MAX(seq),0)+1` seq computation therefore read from ONE
//     consistent snapshot of the table.
//   • The lock formerly existed ONLY to stop a chain fork in which a
//     racer read `head=X` from one snapshot but `MAX(seq)=N+1` from a
//     LATER one (after a sibling committed (seq=N+1, base=X)), then
//     inserted (seq=N+2, base=X) — same base, different seq, no PK
//     conflict. With head-check and MAX(seq) in ONE statement that
//     split snapshot can't happen: a racer's snapshot is either BEFORE
//     the winner's commit (→ it computes the same seq=N+1 → the
//     `UNIQUE(workspace_tag, seq)` PK rejects the second INSERT →
//     recovery → `stale-base`) or AFTER it (→ head ≠ base → the WHERE
//     gate fails → no insert → `stale-base`). Exactly one commits.
//   • The WHERE re-asserts BOTH checks: `NOT EXISTS(dup-id)` is the dup
//     recheck; `head IS $3` is the base-equality check (NULL-safe so
//     the FIRST revision — base = NULL against an empty-chain head,
//     also NULL — matches and inserts).
//   • A non-empty `RETURNING seq` ⇔ both gates passed → `inserted`. An
//     empty result means a gate failed; we re-read to discriminate
//     `duplicate` (dup gate) from `stale-base` (base gate).
//
// Concurrency hazards closed WITHOUT the lock:
//   • Two saves with the same `base` and DIFFERENT id never both insert
//     (UNIQUE is on id, not base): the synchronous gated INSERTs run
//     one after the other, so the second sees the first's head and the
//     base gate fails → `stale-base`.
//   • Two retransmits with the same id: the second's dup gate fails →
//     `duplicate`.
// Covered by the no-fork concurrency tests in `tests/server-db.test.js`
// (two/N concurrent same-base, mixed, chainFrom-during-commits).
//
// SQLite serialises writers internally even ACROSS connections, but a
// multi-connection deployment is unsupported regardless. The
// unique-violation catch below is the residual backstop for that
// scenario (e.g. a test fixture opening two `openDb` handles to one
// file): a sibling landing our computed seq / id makes the gated INSERT
// throw a PK / UNIQUE violation, which we refetch through `inserted` /
// `stale-base` — read-after-write-failure with no isolation-level
// assumption, any committed head we see being a valid stale-base
// target. No silent failure, no chain fork.
export async function commitRevisionSqlite(
  handle: Handle,
  { tag, id, base, keyframe, nonce, ciphertext, signature }: RevisionInsert,
): Promise<CommitResult> {
  // `gatedInsert` is populated by `openDbInner` only (the Neon backend
  // folds its gated INSERT into a transaction and leaves this unset —
  // see `db-neon.ts`); the only way to reach a missing one here is to
  // construct a `Handle` literal by hand (e.g. a test mock) or to route
  // a Neon-backed Handle into this SQLite primitive. Throwing inside
  // this `async` function surfaces as a Promise REJECTION (not a sync
  // throw), so the function's Promise-returning contract holds for
  // every caller — an unawaited write would otherwise leak an uncaught
  // exception.
  const gatedInsert = handle.gatedInsert
  if (!gatedInsert) {
    throw new Error('commitRevisionSqlite: handle not opened via openDb')
  }
  // Strict-boolean coercion via `=== true`. The canonical signed by
  // the client uses `keyframe === true ? '1' : ''` — anything
  // truthy-but-not-strictly-true (e.g. `1`, `"true"`, `{}`) would
  // canonicalize to `''` (non-keyframe) on the verifier side but
  // would round-trip to `1` here via the looser ternary, diverging
  // signed bytes from stored bytes. TS narrows `keyframe` to
  // `boolean` upstream; the strict comparison is defense-in-depth
  // against a future caller that loosens the field type or a direct
  // invocation from a non-typed context. Input-validation audit.
  const keyframeCol = keyframe === true ? 1 : 0
  const baseNorm = base ?? null
  try {
    // Gated INSERT: inserts (and RETURNs the assigned seq) only when
    // there is no dup id AND the current head equals the proposed
    // base. A returned row ⇔ inserted. `node:sqlite` runs this whole
    // statement synchronously, so the head-check and MAX(seq) it
    // contains read one snapshot — no concurrent commit interleaves.
    const inserted = await gatedInsert.get(tag, id, baseNorm, keyframeCol, nonce, ciphertext, signature, Date.now())
    if (inserted) return { kind: 'inserted' }
    // No insert → a gate failed. Re-assert the dup gate first (a
    // retransmit landed) before falling back to the base gate
    // (head advanced past our base) — same dup-then-base precedence.
    if (await handle.revisionExists.get(tag, id)) return { kind: 'duplicate' }
    const headRow = await handle.headFor.get(tag)
    return { kind: 'stale-base', head: headRow?.id ?? null }
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
}
