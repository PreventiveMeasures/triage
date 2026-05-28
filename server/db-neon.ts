// Neon Postgres backend for `workspace_revision`. Mirrors the
// SQLite-backed `openDb` in ./db.ts — same `Handle` shape (with
// `db: DatabaseSync` unset), same queries by intent, Postgres
// dialect on the wire.
//
// `@neondatabase/serverless` is an OPTIONAL peer dep — selected by
// the `DATABASE_URL` branch in `server/index.ts`. The peer dep
// itself is loaded lazily via the dynamic `import()` inside
// `openNeonDb` below, so a SQLite-only deployment never installs it
// (`autoInstallPeers: false` in `pnpm-workspace.yaml`) and never
// reaches the import.
//
// API shape: `neon(connectionString)` returns a tagged-template
// callable with a `.query(text, params)` value-placeholder method.
// We use the `sql.query(text, params)` form everywhere — our queries
// are dynamically composed strings + parameter arrays from
// `./db-revision-sql.ts`, so the tagged-template form doesn't fit.
// The function-call form (`sql(text, params)`) that the 0.x driver
// accepted was removed in `@neondatabase/serverless@1.0.0`; the peer
// dep declares `^1.0.2`. `tryCommitNeon` (below) folds the dup-check
// + head-check + gated INSERT into a single pipelined
// `sql.transaction([...])` — NO commit-time advisory lock. The gated
// INSERT's head-check and `MAX(seq)` run inside one Postgres
// READ-COMMITTED statement snapshot, and the
// `UNIQUE(workspace_tag, seq)` PK rejects a cross-replica racer that
// computed the same seq, so a racer either collides on the PK
// (→ recovery → stale-base) or sees the advanced head (→ no insert →
// stale-base) — never a silent fork. See `tryCommitNeon` for the
// per-statement argument, including the caveat that PGlite
// (single-connection) can't empirically exercise the cross-replica
// race — a real-Postgres concurrency test is the way to confirm it.
// The DDL bootstrap (below) keeps its own advisory lock (it
// serialises concurrent schema boots, unrelated to commits) and runs
// as a pipelined transaction so the schema creates either fully or
// not at all on a transient network failure mid-DDL.
//
// Durability: the SQLite path sets `PRAGMA synchronous = FULL` so
// `workspace-save-ack` is only emitted after the row is fsynced.
// The Neon path inherits whatever durability the Neon endpoint
// provides — by default Postgres `synchronous_commit = on`, which
// commits to durable WAL on the primary before returning. Neon
// additionally replicates synchronously to multiple AZs, so the
// "ack means durable" contract holds without explicit per-statement
// configuration here. `openNeonDb` runs a boot-time `SHOW
// synchronous_commit` and throws if the endpoint has been
// configured `off` — the only level that skips the primary's WAL
// fsync. `local` / `on` / `remote_*` all preserve the
// ack-implies-durable contract that `workspace-save-ack` carries.

import type { AllStmt, GetStmt, RunStmt } from './db-stmt.ts'
import { type CommitResult, type Handle, type RevisionInsert, type RevisionRow, isUniqueViolation } from './db.ts'
import {
  CHAIN_AFTER_SQL, CHAIN_ALL_SQL, CHAIN_FROM_SQL, GATED_INSERT_SQL_PG, HEAD_FOR_SQL,
  LAST_KEYFRAME_SEQ_SQL, REVISION_BY_ID_SQL, REVISION_EXISTS_SQL, SEQ_OF_ID_SQL,
  mapRevisionRow, num, numOrNull,
} from './db-revision-sql.ts'

// `num` / `numOrNull` (safe-integer BIGINT coercion) live in the shared
// `./db-revision-sql.ts` so the shared `mapRevisionRow` can use them
// without a backend→backend import cycle. Re-exported here because the
// objstore Neon plane (`./objstore/store-neon.ts`) imports them from
// this module — keeping that import working without touching the
// objstore code, and keeping a single definition shared by all three
// call sites (revision Neon, revision SQLite mapper, objstore Neon).
export { num, numOrNull }

// Minimal structural type for the `neon()` callable. We don't pull
// `@neondatabase/serverless`'s types in at the top level because
// the peer dep may be absent; the runtime `import()` lands the real
// implementation. Anything we use here is at the wire level (SQL
// string + positional params + returned rows array).
//
// `transaction` is the driver's pipelined-transaction primitive —
// a single HTTP round-trip carries `BEGIN; <stmt>; …; COMMIT` so
// the whole batch atomically applies or fully aborts on the server
// side. Used by the DDL bootstrap below to prevent partial schema
// creation on a transient mid-batch network failure.
//
// `transaction` is typed against the query promise `sql.query`
// returns (NOT plain `Promise<unknown>`) so a misuse like
// `sql.transaction([Promise.resolve(123)])` fails at compile time
// rather than failing opaquely inside the driver. The driver itself
// inspects each promise's internal shape and rejects non-query
// promises at runtime; the type narrows that to a static error.
type NeonQueryPromise = ReturnType<NeonQueryCall>
type NeonQueryCall = (queryText: string, params?: readonly unknown[]) => Promise<unknown[]>
export type NeonSql = {
  query: NeonQueryCall
  transaction: (queries: NeonQueryPromise[]) => Promise<unknown[][]>
}

// Advisory-lock keys (signed-int64 split into two int32s for the
// two-arg `pg_advisory_xact_lock` form). Distinct per-table so the
// triage-revision + objstore DDL bootstraps don't serialize against
// each other; same value across replicas so multiple boot-races
// converge on a single DDL run. Chosen to be unlikely to collide
// with operator-issued advisory locks.
const DDL_LOCK_KEY_REVISION = 0x6465_7670 // 'depv'
const DDL_LOCK_KEY_REVISION_SUB = 0x7273_6e72 // 'rsnr'

// Durability levels that satisfy the ack-implies-durable contract.
// `local` fsyncs the primary's WAL before returning — matches what
// SQLite's `PRAGMA synchronous = FULL` enforces (single-node fsync)
// and the contract that server acks imply durable commit. `on`
// (the Postgres default) is `local` plus waiting for any sync
// standbys. `remote_write` waits for sync replicas to receive WAL;
// `remote_apply` for them to apply it. Only `off` is rejected — it
// skips the WAL fsync entirely so a primary crash mid-ack loses
// the committed row.
const DURABLE_SYNC_COMMIT_LEVELS = new Set(['local', 'on', 'remote_write', 'remote_apply'])

export async function assertDurableSyncCommit(sql: NeonSql): Promise<void> {
  const rows = await sql.query(`SHOW synchronous_commit`, []) as Array<{ synchronous_commit?: unknown }>
  const level = String(rows[0]?.synchronous_commit ?? '').trim().toLowerCase()
  if (!DURABLE_SYNC_COMMIT_LEVELS.has(level)) {
    throw new Error(
      `Neon endpoint has synchronous_commit='${level}' — refuses to start because server acks ` +
      `imply durable commit; configure the Postgres role / project to use 'local', 'on' (default), ` +
      `'remote_write', or 'remote_apply'.`,
    )
  }
}

// Postgres DDL. Statement-per-array-element because Neon's HTTP
// transport runs one statement per request — there's no
// multi-statement support like SQLite's `db.exec`. INTEGER → BIGINT
// for `seq` and `created_at` (epoch millis) so a long-running
// workspace doesn't overflow at 2^31. `keyframe` stays a small int
// that the row mapper coerces to 0 / 1 for parity with the SQLite
// shape. No `STRICT` clause — Postgres columns are strictly typed
// by default.
const SCHEMA_PG = [
  // `CHECK (keyframe IN (0, 1))` is the value-domain guard: without
  // it, a direct DB write of `keyframe = 2` would silently coerce to
  // 0 in `mapRevisionRow`'s `=== 1` check, diverging from the signed
  // canonical the row was hashed against. The SQLite path carries the
  // identical CHECK (see `db.ts`) — note STRICT there enforces only
  // the column TYPE (INTEGER), NOT this {0, 1} domain (`keyframe = 2`
  // is a valid integer STRICT accepts), so BOTH backends need the
  // explicit CHECK. Same operator-with-DB-write attack vector on both
  // planes.
  `CREATE TABLE IF NOT EXISTS workspace_revision (
     workspace_tag TEXT NOT NULL,
     seq BIGINT NOT NULL,
     id TEXT NOT NULL,
     base TEXT,
     keyframe SMALLINT NOT NULL DEFAULT 0 CHECK (keyframe IN (0, 1)),
     nonce TEXT NOT NULL,
     ciphertext TEXT NOT NULL,
     signature TEXT NOT NULL,
     created_at BIGINT NOT NULL,
     PRIMARY KEY (workspace_tag, seq),
     UNIQUE (workspace_tag, id)
   )`,
  // NOTE: no separate `workspace_revision_tag_id_idx` on the Neon
  // path. Postgres' UNIQUE constraint already builds a btree index
  // on (workspace_tag, id); duplicating it would only cost extra
  // write amplification + storage per INSERT. The SQLite path keeps
  // a separate `CREATE INDEX` because SQLite's query planner
  // historically did not always use the implicit UNIQUE index for
  // covering lookups — Postgres' planner does.
]

// Generic statement-builder helpers shared by both Neon planes
// (workspace_revision here + the objstore tables in store-neon.ts).
// They remove the repeated `{ run/get: async (...args) => sql.query(...) }`
// wrapper for the statements whose positional args map straight to
// the query's `$1..$N` placeholders and whose rows need no coercion.
// Statements that coerce BIGINT (via `num`) or map snake_case rows
// stay bespoke. `args as readonly unknown[]` widens the call-site
// tuple to the driver's positional-params type.

// Trivial passthrough write: args → $1..$N in order, no result shape.
export function runStmt<P extends unknown[]>(sql: NeonSql, query: string): RunStmt<P> {
  return { run: async (...args: P) => { await sql.query(query, args as readonly unknown[]) } }
}

// First-row read with no coercion (callers needing BIGINT→number or
// snake_case mapping build their own). Returns `undefined` on the
// empty result set, matching the SQLite `wrapGet` contract.
export function getRowStmt<P extends unknown[], T>(sql: NeonSql, query: string): GetStmt<P, T> {
  return { get: async (...args: P) => (await sql.query(query, args as readonly unknown[]) as T[])[0] }
}

// Per-statement builders — extracted so `openNeonDb` stays small
// (max-lines-per-function budget). Each closes over the Neon `sql`
// callable.
function buildHeadFor(sql: NeonSql): GetStmt<[string], { id: string }> {
  return getRowStmt(sql, HEAD_FOR_SQL)
}

function buildSeqOfId(sql: NeonSql): GetStmt<[string, string], { seq: number }> {
  return { get: async (tag, id) => {
    const rows = await sql.query(SEQ_OF_ID_SQL, [tag, id]) as Array<{ seq: number | string }>
    const r = rows[0]
    if (!r) return undefined
    const n = numOrNull(r.seq)
    return n == null ? undefined : { seq: n }
  } }
}

function buildLastKeyframeSeq(sql: NeonSql): GetStmt<[string], { s: number | null }> {
  return { get: async (tag) => {
    const rows = await sql.query(LAST_KEYFRAME_SEQ_SQL, [tag]) as Array<{ s: number | string | null }>
    const r = rows[0]
    return r ? { s: numOrNull(r.s) } : undefined
  } }
}

function buildChain(sql: NeonSql, query: string): AllStmt<[string], RevisionRow> {
  return { all: async (tag) => {
    const rows = await sql.query(query, [tag]) as Array<Record<string, unknown>>
    return rows.map(mapRevisionRow)
  } }
}

function buildChainSeq(sql: NeonSql, query: string): AllStmt<[string, number], RevisionRow> {
  return { all: async (tag, seq) => {
    const rows = await sql.query(query, [tag, seq]) as Array<Record<string, unknown>>
    return rows.map(mapRevisionRow)
  } }
}

function buildRevisionExists(sql: NeonSql): GetStmt<[string, string], unknown> {
  return getRowStmt(sql, REVISION_EXISTS_SQL)
}

function buildRevisionById(sql: NeonSql): GetStmt<[string, string], RevisionRow> {
  return { get: async (tag, id) => {
    const rows = await sql.query(REVISION_BY_ID_SQL, [tag, id]) as Array<Record<string, unknown>>
    const r = rows[0]
    return r ? mapRevisionRow(r) : undefined
  } }
}

// Atomic commit of a single revision (Neon backend). Wraps the
// dup-check, head-check and gated INSERT in one pipelined
// transaction — NO commit-time advisory lock. Cross-replica
// fork-safety rests on two Postgres guarantees:
//
//   • Single-statement snapshot (READ COMMITTED, the default): the
//     gated INSERT's head-check `(SELECT id … ORDER BY seq DESC
//     LIMIT 1)` and its `COALESCE(MAX(seq),0)+1` seq computation
//     evaluate against ONE snapshot taken at the start of that
//     statement. A racer can't read `head` from one snapshot and
//     `MAX(seq)` from a later one within the same INSERT.
//   • The `UNIQUE(workspace_tag, seq)` PK.
//
// Walk the only race that mattered: replica A commits (seq=N+1,
// base=X). Replica B's gated INSERT runs concurrently. Either B's
// statement snapshot is BEFORE A's commit — B sees head=X AND
// MAX(seq)=N, computes seq=N+1, and its INSERT collides with A's row
// on the PK (recovery → `stale-base`) — or B's snapshot is AFTER A's
// commit — B sees head=A's-id ≠ X, the `head IS NOT DISTINCT FROM
// base` gate fails, and B inserts nothing (→ `stale-base`). The
// forked (seq=N+2, base=X) outcome the old advisory lock guarded
// against required head and MAX(seq) from DIFFERENT snapshots, which
// a single statement does not permit. Exactly one replica commits;
// the loser gets `stale-base`. So the per-tag advisory lock was
// belt-and-suspenders and is removed.
//
// CAVEAT (honesty): this cross-replica argument has NOT been
// empirically exercised. The PGlite test backend is single-
// connection, so it can't reproduce two replicas racing on one
// database — it only confirms the commit-outcome + recovery logic.
// Before relying on the lockless commit under genuine multi-replica
// load, add a real-Postgres concurrency test (two pooled
// connections racing same-base commits) to confirm the snapshot + PK
// argument holds against the actual server.
//
// The gated INSERT-SELECT-WHERE fires only when there's no duplicate
// id AND the current head matches the proposed base, so `RETURNING
// seq` rows.length === 1 implies a successful insert. Empty rows mean
// one of the gates failed; we then look at the dup-check / head-check
// results to decide between `duplicate` and `stale-base`.
function tryCommitNeon(sql: NeonSql): (input: RevisionInsert) => Promise<CommitResult> {
  return async ({ tag, id, base, keyframe, nonce, ciphertext, signature }) => {
    const baseNorm = base ?? null
    const keyframeCol = keyframe === true ? 1 : 0
    const createdAt = Date.now()
    let results: unknown[][]
    try {
      results = await sql.transaction([
        // Gated INSERT (shared `$N` builder, Postgres null-safe equality
        // `IS NOT DISTINCT FROM`). `seq` is `COALESCE(MAX(seq),0)+1`; the
        // WHERE re-asserts both gates (no dup AND head IS base) so the
        // INSERT is a no-op when either fails, and a non-empty
        // `RETURNING seq` means "inserted". The null-safe equality
        // matches `base = NULL` on the first revision against the
        // empty-chain head (also NULL); plain `=` would be NULL → false
        // and the first revision would never insert.
        sql.query(
          GATED_INSERT_SQL_PG,
          [tag, id, baseNorm, keyframeCol, nonce, ciphertext, signature, createdAt],
        ),
        // Discrimination reads, run AFTER the INSERT so they reflect
        // post-INSERT state. With no advisory lock serialising the
        // transaction, running these BEFORE the INSERT (READ COMMITTED
        // takes a fresh snapshot per statement) could miss a duplicate or
        // head-advance that landed concurrently and misclassify a no-op
        // INSERT — e.g. report `stale-base` for what is actually a
        // duplicate retransmit. Read after the INSERT, a no-op's cause is
        // stable: our id present ⇒ duplicate, else the head moved ⇒
        // stale-base. (The INSERT itself is still authoritative — its own
        // single-statement snapshot is what prevents a chain fork.)
        sql.query(REVISION_EXISTS_SQL, [tag, id]),
        sql.query(HEAD_FOR_SQL, [tag]),
      ])
    } catch (err) {
      // A unique-violation reaches here when a cross-replica racer (or
      // a direct INSERT from an admin migration / repair script / future
      // code path) landed our computed (workspace_tag, seq) or our
      // (workspace_tag, id) first — the PK / UNIQUE the snapshot
      // argument above relies on doing its job. Mirror the SQLite
      // path's recovery — refetch and route the outcome through
      // `inserted` / `stale-base` — so the originator gets a
      // workspace-state catch-up instead of a raw driver rejection
      // escaping to `handleSave`'s IIFE. Other errors (network, syntax,
      // type mismatch) rethrow.
      if (!isUniqueViolation(err)) throw err
      const dupRows = await sql.query(REVISION_EXISTS_SQL, [tag, id]) as Array<unknown>
      if (dupRows.length > 0) return { kind: 'inserted' }
      const headRows = await sql.query(HEAD_FOR_SQL, [tag]) as Array<{ id: string }>
      return { kind: 'stale-base', head: headRows[0]?.id ?? null }
    }
    const insertRows = results[0] as Array<unknown>
    const dupRows = results[1] as Array<unknown>
    const headRows = results[2] as Array<{ id: string }>
    if (insertRows.length > 0) return { kind: 'inserted' }
    if (dupRows.length > 0) return { kind: 'duplicate' }
    return { kind: 'stale-base', head: headRows[0]?.id ?? null }
  }
}

export async function openNeonDb(connectionString: string): Promise<Handle> {
  // Dynamic import so the dep is only required when the Neon path is
  // selected — a SQLite-only deployment never evaluates this. We go
  // through the local `./neon-driver.ts` re-export wrapper rather than
  // the bare specifier so tests can swap the real driver for an
  // in-process Postgres (PGlite) via `mock.module`: that hook can only
  // intercept a specifier it can RESOLVE, and the optional peer dep
  // isn't installed in a SQLite-only checkout. The wrapper path always
  // resolves — see `server/neon-driver.ts`. Cast through `unknown`
  // because the wrapper's `export *` re-exports a `@ts-ignore`'d
  // (possibly-absent) module, so tsc can't see `neon`'s type here.
  const mod = (await import('./neon-driver.ts')) as unknown as { neon: (url: string) => NeonSql }
  const sql: NeonSql = mod.neon(connectionString)
  // Boot-time durability gate — refuses to open against an endpoint
  // configured `synchronous_commit = off` (skips primary WAL fsync,
  // breaking the ack-implies-durable contract). All other levels —
  // `local`, `on`, `remote_write`, `remote_apply` — preserve parity
  // with the SQLite path's `PRAGMA synchronous = FULL`. See
  // DURABLE_SYNC_COMMIT_LEVELS.
  await assertDurableSyncCommit(sql)
  // DDL bootstrap under one pipelined transaction so a transient
  // network failure mid-batch rolls back, AND a transaction-scoped
  // advisory lock so two replicas booting concurrently serialize
  // their DDL (the advisory lock releases at COMMIT; the
  // `IF NOT EXISTS` clauses then make the second runner a no-op).
  await sql.transaction([
    sql.query(`SELECT pg_advisory_xact_lock($1, $2)`, [DDL_LOCK_KEY_REVISION, DDL_LOCK_KEY_REVISION_SUB]),
    ...SCHEMA_PG.map((stmt) => sql.query(stmt, [])),
  ])

  const handle: Handle = {
    // `db` (and the SQLite-only `gatedInsert` statement) intentionally
    // unset — Neon has no `DatabaseSync`, and its gated INSERT lives
    // inside `tryCommitNeon`'s pipelined transaction. The Handle type
    // makes both optional precisely for this case.
    headFor: buildHeadFor(sql),
    seqOfId: buildSeqOfId(sql),
    lastKeyframeSeq: buildLastKeyframeSeq(sql),
    chainAll: buildChain(sql, CHAIN_ALL_SQL),
    chainAfterSeq: buildChainSeq(sql, CHAIN_AFTER_SQL),
    chainFromSeq: buildChainSeq(sql, CHAIN_FROM_SQL),
    revisionExists: buildRevisionExists(sql),
    revisionById: buildRevisionById(sql),
    tryCommit: tryCommitNeon(sql),
    // The serverless HTTP client is stateless — no socket to close.
    // Async no-op so shutdown's `handle.close()` works uniformly
    // across backends.
    close: async () => {},
  }
  // No commit-time lock of any kind: `tryCommitNeon`'s single gated
  // INSERT relies on the Postgres single-statement snapshot + the
  // `UNIQUE(workspace_tag, seq)` PK for cross-replica fork-safety
  // (see `tryCommitNeon`), so neither an in-process lock nor a
  // per-tag advisory lock is needed.
  return handle
}
