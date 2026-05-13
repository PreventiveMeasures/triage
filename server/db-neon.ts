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
// `sql(text, params)`. Transactions are NOT used — Neon's HTTP
// transport doesn't carry them across calls. The module-private
// per-(workspace_tag) `writeLock` from `./db.ts` (registered via
// `_attachWriteLock`) is what keeps `commitRevision`'s dup-check +
// base-check + MAX(seq) + INSERT atomic against concurrent saves.
//
// Durability: the SQLite path sets `PRAGMA synchronous = FULL` so
// `workspace-save-ack` is only emitted after the row is fsynced.
// The Neon path inherits whatever durability the Neon endpoint
// provides — by default Postgres `synchronous_commit = on`, which
// commits to durable WAL on the primary before returning. Neon
// additionally replicates synchronously to multiple AZs, so the
// "ack means durable" contract holds without explicit per-statement
// configuration here.

import type { AllStmt, GetStmt, RunStmt } from './db-stmt.ts'
import { type Handle, type RevisionRow, _attachWriteLock } from './db.ts'

// Minimal structural type for the `neon()` callable. We don't pull
// `@neondatabase/serverless`'s types in at the top level because
// the peer dep may be absent; the runtime `import()` lands the real
// implementation. Anything we use here is at the wire level (SQL
// string + positional params + returned rows array).
type NeonSql = {
  (queryText: string, params?: readonly unknown[]): Promise<unknown[]>
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
  for (const stmt of SCHEMA_PG) await sql(stmt, [])

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
    // The serverless HTTP client is stateless — no socket to close.
    // Async no-op so shutdown's `handle.close()` works uniformly
    // across backends.
    close: async () => {},
  }
  _attachWriteLock(handle)
  return handle
}
