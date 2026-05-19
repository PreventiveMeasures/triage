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
// API shape: `neon(connectionString)` returns a tagged-template +
// callable function. We use the function-call form
// `sql(text, params)`. Per-statement transactions are not used by
// `commitRevision` — Neon's HTTP transport doesn't carry session
// state across calls, so the module-private per-(workspace_tag)
// `writeLock` from `./db.ts` (registered via `_attachWriteLock`) is
// what keeps `commitRevision`'s dup-check + base-check + MAX(seq) +
// INSERT atomic against concurrent saves. DDL bootstrap (below)
// DOES use the driver's `transaction([...])` pipelined-transaction
// API so the schema creates either fully or not at all on a
// transient network failure mid-DDL.
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
import { type CommitResult, type Handle, type RevisionInsert, type RevisionRow, _attachWriteLock } from './db.ts'

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
// `transaction` is typed against the query promise the call form
// returns (NOT plain `Promise<unknown>`) so a misuse like
// `sql.transaction([Promise.resolve(123)])` fails at compile time
// rather than failing opaquely inside the driver. The driver itself
// inspects each promise's internal shape and rejects non-query
// promises at runtime; the type narrows that to a static error.
type NeonQueryPromise = ReturnType<NeonSqlCall>
type NeonSqlCall = (queryText: string, params?: readonly unknown[]) => Promise<unknown[]>
export type NeonSql = NeonSqlCall & {
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

// Namespace for the per-(workspace_tag) commit advisory lock taken
// inside `tryCommitNeon`'s pipelined transaction. Held only for the
// transaction's lifetime (`_xact_lock`), so a long-running commit
// can't strand it. The namespace partitions these locks from the
// DDL bootstrap locks above: PG's two-arg `pg_advisory_xact_lock`
// treats (key1, key2) as the lock identity, and the first int4
// differing (`cmrt` vs `depv`) guarantees no collision between
// per-tag commits and DDL boots — without this partition a boot-
// time DDL holder could stall every commit, or vice versa.
// `0x636d_7274` is just the ASCII bytes c/m/r/t packed into an int4
// — mnemonic for "commit revision tag", same convention as the DDL
// keys above. Any value would work; matching the existing namespace
// style keeps `git grep` for the four-letter tag finding all sites.
const COMMIT_LOCK_NAMESPACE = 0x636d_7274 // 'cmrt'

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
  const rows = await sql(`SHOW synchronous_commit`, []) as Array<{ synchronous_commit?: unknown }>
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
  // `CHECK (keyframe IN (0, 1))` mirrors what SQLite's STRICT type
  // affinity buys us implicitly — without it, a direct DB write of
  // `keyframe = 2` would silently coerce to 0 in `mapRevisionRow`'s
  // `=== 1` check, diverging from the signed canonical the row was
  // hashed against. Same operator-attack vector the SQLite STRICT
  // guard in db.ts catches.
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

// Postgres BIGINT can round-trip through the Neon driver as a string
// when the value would lose precision. For our use (per-workspace
// monotonic seq, epoch ms) the JS safe-integer range is fine —
// coerce to number for parity with the SQLite shape so chain
// consumers don't need to special-case the backend.
// Strict: throw on anything that isn't a safe-integer-compatible
// value. Silently returning `null` for unexpected shapes would mask
// driver-shape changes and let bogus values feed `seq` / `head`
// comparisons. The `null` return is reserved for genuine SQL NULL.
function toNumberOrNull(v: unknown): number | null {
  if (v == null) return null
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v
  if (typeof v === 'string' && v.length > 0) {
    const n = Number(v)
    if (Number.isSafeInteger(n)) return n
  }
  if (typeof v === 'bigint' && v >= -9_007_199_254_740_991n && v <= 9_007_199_254_740_991n) {
    return Number(v)
  }
  throw new TypeError(`toNumberOrNull: expected safe-integer value or null, got ${typeof v} ${String(v)}`)
}

function mapRevisionRow(r: Record<string, unknown>): RevisionRow {
  return {
    base: (r['base'] as string | null) ?? null,
    id: String(r['id']),
    // SMALLINT round-trips as `number`; coerce defensively so a
    // driver upgrade returning `string` doesn't silently break the
    // strict-equality `keyframe === 1` check downstream.
    keyframe: toNumberOrNull(r['keyframe']) === 1 ? 1 : 0,
    nonce: String(r['nonce']),
    ciphertext: String(r['ciphertext']),
    signature: String(r['signature']),
  }
}

// Per-statement builders — extracted so `openNeonDb` stays small
// (max-lines-per-function budget). Each closes over the Neon `sql`
// callable.
function buildHeadFor(sql: NeonSql): GetStmt<[string], { id: string }> {
  return { get: async (tag) => {
    const rows = await sql(
      `SELECT id FROM workspace_revision WHERE workspace_tag = $1 ORDER BY seq DESC LIMIT 1`,
      [tag],
    ) as Array<{ id: string }>
    return rows[0]
  } }
}

function buildHeadSeq(sql: NeonSql): GetStmt<[string], { s: number | null }> {
  return { get: async (tag) => {
    const rows = await sql(
      `SELECT MAX(seq) AS s FROM workspace_revision WHERE workspace_tag = $1`,
      [tag],
    ) as Array<{ s: number | string | null }>
    const r = rows[0]
    return r ? { s: toNumberOrNull(r.s) } : undefined
  } }
}

function buildSeqOfId(sql: NeonSql): GetStmt<[string, string], { seq: number }> {
  return { get: async (tag, id) => {
    const rows = await sql(
      `SELECT seq FROM workspace_revision WHERE workspace_tag = $1 AND id = $2`,
      [tag, id],
    ) as Array<{ seq: number | string }>
    const r = rows[0]
    if (!r) return undefined
    const n = toNumberOrNull(r.seq)
    return n == null ? undefined : { seq: n }
  } }
}

function buildLastKeyframeSeq(sql: NeonSql): GetStmt<[string], { s: number | null }> {
  return { get: async (tag) => {
    const rows = await sql(
      `SELECT MAX(seq) AS s FROM workspace_revision WHERE workspace_tag = $1 AND keyframe = 1`,
      [tag],
    ) as Array<{ s: number | string | null }>
    const r = rows[0]
    return r ? { s: toNumberOrNull(r.s) } : undefined
  } }
}

function buildChain(sql: NeonSql, query: string): AllStmt<[string], RevisionRow> {
  return { all: async (tag) => {
    const rows = await sql(query, [tag]) as Array<Record<string, unknown>>
    return rows.map(mapRevisionRow)
  } }
}

function buildChainSeq(sql: NeonSql, query: string): AllStmt<[string, number], RevisionRow> {
  return { all: async (tag, seq) => {
    const rows = await sql(query, [tag, seq]) as Array<Record<string, unknown>>
    return rows.map(mapRevisionRow)
  } }
}

function buildRevisionExists(sql: NeonSql): GetStmt<[string, string], unknown> {
  return { get: async (tag, id) => {
    const rows = await sql(
      `SELECT 1 AS one FROM workspace_revision WHERE workspace_tag = $1 AND id = $2`,
      [tag, id],
    ) as Array<{ one: number }>
    return rows[0]
  } }
}

function buildInsertRevision(sql: NeonSql): RunStmt<[string, number, string, string | null, number, string, string, string, number]> {
  return { run: async (tag, seq, id, base, keyframe, nonce, ciphertext, signature, createdAt) => {
    await sql(
      `INSERT INTO workspace_revision
         (workspace_tag, seq, id, base, keyframe, nonce, ciphertext, signature, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [tag, seq, id, base, keyframe, nonce, ciphertext, signature, createdAt],
    )
  } }
}

// Atomic commit of a single revision (Neon backend). Wraps the
// dup-check, head-check and gated INSERT in one pipelined
// transaction whose first statement is a transaction-scoped
// advisory lock keyed on `workspace_tag`. The lock is database-
// wide, so it serialises commits per-tag across replicas — the
// only safe primitive for the multi-replica deployment shape this
// backend supports.
//
// Why the lock is required: without it, replica A reads head=X,
// computes seq=N+1, INSERTs and COMMITs. Replica B (started a
// moment earlier) reads head=X (from its own snapshot taken before
// A's commit), reads MAX(seq)=N+1 (from a fresh statement-snapshot
// AFTER A's commit), computes seq=N+2 with base=X, and INSERTs.
// Both rows now exist: (seq=N+1, base=X), (seq=N+2, base=X) —
// same base, different seq, no PK conflict. The chain has forked
// silently. The README's claim that "the DB schema's PRIMARY KEY
// is the multi-process backstop" only holds when the racing seqs
// collide; the interleaved-MAX(seq) read defeats it. The advisory
// lock closes that window by making the four statements run
// strictly serially per tag — only one commit holds the lock at a
// time, and the COMMIT auto-releases.
//
// The gated INSERT-SELECT-WHERE fires only when there's no
// duplicate id AND the current head matches the proposed base.
// Under the advisory lock these checks are stable for the
// statement's duration, so `RETURNING seq` rows.length === 1
// implies a successful insert. Empty rows mean one of the gates
// failed; we then look at the dup-check / head-check results to
// decide between `duplicate` and `stale-base`.
function tryCommitNeon(sql: NeonSql): (input: RevisionInsert) => Promise<CommitResult> {
  return async ({ tag, id, base, keyframe, nonce, ciphertext, signature }) => {
    const baseNorm = base ?? null
    const keyframeCol = keyframe === true ? 1 : 0
    const createdAt = Date.now()
    const results = await sql.transaction([
      // Per-tag advisory lock. `hashtext` returns an int4; combined
      // with the int4 namespace, the pair uniquely identifies this
      // tag's lock. False collisions across distinct tags (birthday-
      // bound at ~65k tags by int4 width) merely cause those two
      // tags' commits to serialise — correctness is unaffected,
      // throughput on the colliding pair degrades to the slower of
      // the two flows. Acceptable for a small-collision-rate space.
      sql(`SELECT pg_advisory_xact_lock($1, hashtext($2))`, [COMMIT_LOCK_NAMESPACE, tag]),
      // Dup-id check.
      sql(`SELECT 1 AS one FROM workspace_revision WHERE workspace_tag = $1 AND id = $2`, [tag, id]),
      // Current head id (NULL when the chain is empty).
      sql(`SELECT id FROM workspace_revision WHERE workspace_tag = $1 ORDER BY seq DESC LIMIT 1`, [tag]),
      // Gated INSERT. `seq` is computed via the same MAX(seq)
      // subquery as the head-check's snapshot. The WHERE clause
      // re-asserts both gates so the INSERT is a no-op when either
      // fails. RETURNING seq lets us discriminate inserted vs
      // not-inserted by row count.
      //
      // `IS NOT DISTINCT FROM` is the NULL-safe equality needed to
      // match `base = NULL` on the first revision against the
      // empty-chain head (also NULL). Plain `=` would always be
      // NULL → false → first revision would never insert.
      sql(
        `INSERT INTO workspace_revision
           (workspace_tag, seq, id, base, keyframe, nonce, ciphertext, signature, created_at)
         SELECT $1,
                COALESCE((SELECT MAX(seq) FROM workspace_revision WHERE workspace_tag = $1), 0) + 1,
                $2, $3, $4, $5, $6, $7, $8
         WHERE NOT EXISTS (SELECT 1 FROM workspace_revision WHERE workspace_tag = $1 AND id = $2)
           AND (SELECT id FROM workspace_revision WHERE workspace_tag = $1 ORDER BY seq DESC LIMIT 1)
               IS NOT DISTINCT FROM $3
         RETURNING seq`,
        [tag, id, baseNorm, keyframeCol, nonce, ciphertext, signature, createdAt],
      ),
    ])
    const dupRows = results[1] as Array<unknown>
    const headRows = results[2] as Array<{ id: string }>
    const insertRows = results[3] as Array<unknown>
    if (insertRows.length > 0) return { kind: 'inserted' }
    if (dupRows.length > 0) return { kind: 'duplicate' }
    return { kind: 'stale-base', head: headRows[0]?.id ?? null }
  }
}

const CHAIN_ALL_SQL = `SELECT base, id, keyframe, nonce, ciphertext, signature
  FROM workspace_revision WHERE workspace_tag = $1 ORDER BY seq ASC`
const CHAIN_AFTER_SQL = `SELECT base, id, keyframe, nonce, ciphertext, signature
  FROM workspace_revision WHERE workspace_tag = $1 AND seq > $2 ORDER BY seq ASC`
const CHAIN_FROM_SQL = `SELECT base, id, keyframe, nonce, ciphertext, signature
  FROM workspace_revision WHERE workspace_tag = $1 AND seq >= $2 ORDER BY seq ASC`

export async function openNeonDb(connectionString: string): Promise<Handle> {
  // Dynamic import so the dep is only required when the Neon path
  // is selected. A missing peer dep surfaces here with a clear
  // module-not-found, not at the SQLite-deployment's startup.
  // `@ts-ignore` rather than `@ts-expect-error`: when the peer dep
  // IS installed (e.g. an operator runs `pnpm add @neondatabase/
  // serverless`), the import resolves and tsc sees a real type —
  // `@ts-expect-error` would flip to a `TS2578: unused directive`
  // error and break the operator's `tsc --noEmit`.
  // @ts-ignore optional peer dep: '@neondatabase/serverless'
  const mod = (await import('@neondatabase/serverless')) as { neon: (url: string) => NeonSql }
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
    sql(`SELECT pg_advisory_xact_lock($1, $2)`, [DDL_LOCK_KEY_REVISION, DDL_LOCK_KEY_REVISION_SUB]),
    ...SCHEMA_PG.map((stmt) => sql(stmt, [])),
  ])

  const handle: Handle = {
    // `db` intentionally unset — Neon has no `DatabaseSync`. The
    // Handle type makes it optional precisely for this case.
    headFor: buildHeadFor(sql),
    headSeq: buildHeadSeq(sql),
    seqOfId: buildSeqOfId(sql),
    lastKeyframeSeq: buildLastKeyframeSeq(sql),
    chainAll: buildChain(sql, CHAIN_ALL_SQL),
    chainAfterSeq: buildChainSeq(sql, CHAIN_AFTER_SQL),
    chainFromSeq: buildChainSeq(sql, CHAIN_FROM_SQL),
    revisionExists: buildRevisionExists(sql),
    insertRevision: buildInsertRevision(sql),
    tryCommit: tryCommitNeon(sql),
    // The serverless HTTP client is stateless — no socket to close.
    // Async no-op so shutdown's `handle.close()` works uniformly
    // across backends.
    close: async () => {},
  }
  _attachWriteLock(handle)
  return handle
}
