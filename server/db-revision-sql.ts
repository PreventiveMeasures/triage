// Shared SQL + row-mapping for the `workspace_revision` chain, used by
// BOTH backends — `./db.ts` (SQLite) and `./db-neon.ts` (Neon/Postgres).
// The two backends previously carried byte-for-byte-equal query strings
// (modulo `?`↔`$N` placeholders) and a copy of the same row mapper; that
// duplication is collapsed here so a query edit can't silently drift
// between backends.
//
// Single source of truth, in `$N` (Postgres) form:
//   • the read queries (`headFor`, `headSeq`, `seqOfId`,
//     `lastKeyframeSeq`, the three `chain*` selects, `revisionExists`),
//   • the gated commit INSERT (parameterised by the dialect's null-safe
//     equality operator — `IS` for SQLite, `IS NOT DISTINCT FROM` for
//     Postgres), and
//   • `mapRevisionRow`, the chain-row coercion.
// SQLite consumers run the strings through `toSqlitePlaceholders` first
// (`$N` → `?N`); `node:sqlite` supports the numbered `?N` form with reuse
// (see `updateLiveCAS` in `./objstore/store.ts`).
//
// This module deliberately holds NO driver state and imports NO runtime
// value from `./db.ts` (only the `RevisionRow` TYPE, which is erased), so
// there is no runtime import cycle: `./db.ts` and `./db-neon.ts` both
// import runtime values FROM here; the only edge back to `./db.ts` is a
// type-only import.

import type { RevisionRow } from './db.ts'

// Postgres BIGINT can round-trip through the Neon driver as a string
// when the value would lose precision. For our use (per-workspace
// monotonic seq, epoch ms, byte lengths up to 100 MiB) the JS safe-
// integer range is fine — coerce to number for parity with the
// SQLite shape so chain consumers don't need to special-case the
// backend. Strict: throw on anything that isn't a safe-integer-
// compatible value. Silently returning 0 / null for unexpected shapes
// would mask driver-shape changes and let bogus values feed `seq` /
// `head` / length / version comparisons. `numOrNull`'s null return is
// reserved for genuine SQL NULL.
//
// Defined here (rather than in `./db-neon.ts`) because the shared
// `mapRevisionRow` below depends on `numOrNull` and this module must not
// import a runtime value from a backend. `./db-neon.ts` re-exports both
// so the objstore Neon plane (`./objstore/store-neon.ts`) keeps importing
// them from there unchanged — all three sites still share one definition.
export function num(v: unknown): number {
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
export function numOrNull(v: unknown): number | null {
  if (v == null) return null
  return num(v)
}

// Chain-row coercion shared by both backends. The Neon driver hands back
// `Record<string, unknown>` rows whose `keyframe` may be a number OR (on
// a future driver change) a string; `node:sqlite` hands back native
// numbers. The `num`/`numOrNull` coercion is safe over both — a native
// `0`/`1` integer passes through unchanged, so SQLite rows round-trip
// identically to the bespoke pass-through they had before, while Neon
// rows keep their defensive string→number coercion. `base` is the only
// nullable column (first revision); `keyframe` collapses to a strict
// 0 / 1 via the `=== 1` check the chain-broadcast contract relies on.
export function mapRevisionRow(r: Record<string, unknown>): RevisionRow {
  return {
    base: (r['base'] as string | null) ?? null,
    id: String(r['id']),
    keyframe: numOrNull(r['keyframe']) === 1 ? 1 : 0,
    nonce: String(r['nonce']),
    ciphertext: String(r['ciphertext']),
    signature: String(r['signature']),
  }
}

// `$N` (Postgres) → `?N` (node:sqlite) placeholder rewrite. node:sqlite
// supports the numbered `?N` form WITH reuse (the same `?N` may appear
// more than once and binds to one positional param), which is exactly
// how the `$N` strings reuse e.g. `$1` for the workspace_tag across the
// gated INSERT's SELECT / NOT EXISTS / head subqueries. None of these
// queries contain a literal `$` in a string literal, so the bare numeric
// match is unambiguous.
export function toSqlitePlaceholders(query: string): string {
  return query.replaceAll(/\$(\d+)/gu, '?$1')
}

// The read queries, in `$N` form. Identical across backends — SQLite runs
// them through `toSqlitePlaceholders` at prepare time. `revisionExists`
// aliases `SELECT 1 AS one` so the column name is stable across drivers;
// callers only test truthiness of the returned row.
export const HEAD_FOR_SQL =
  `SELECT id FROM workspace_revision WHERE workspace_tag = $1 ORDER BY seq DESC LIMIT 1`
export const SEQ_OF_ID_SQL =
  `SELECT seq FROM workspace_revision WHERE workspace_tag = $1 AND id = $2`
export const LAST_KEYFRAME_SEQ_SQL =
  `SELECT MAX(seq) AS s FROM workspace_revision WHERE workspace_tag = $1 AND keyframe = 1`
export const CHAIN_ALL_SQL =
  `SELECT base, id, keyframe, nonce, ciphertext, signature
  FROM workspace_revision WHERE workspace_tag = $1 ORDER BY seq ASC`
export const CHAIN_AFTER_SQL =
  `SELECT base, id, keyframe, nonce, ciphertext, signature
  FROM workspace_revision WHERE workspace_tag = $1 AND seq > $2 ORDER BY seq ASC`
export const CHAIN_FROM_SQL =
  `SELECT base, id, keyframe, nonce, ciphertext, signature
  FROM workspace_revision WHERE workspace_tag = $1 AND seq >= $2 ORDER BY seq ASC`
export const REVISION_EXISTS_SQL =
  `SELECT 1 AS one FROM workspace_revision WHERE workspace_tag = $1 AND id = $2`

// The gated commit INSERT, in `$N` form. One statement folds the
// dup-check, the head-equals-base check, the server-assigned seq
// (`COALESCE(MAX(seq),0)+1`) and the INSERT, returning `seq` only when
// BOTH gates pass — so a non-empty result means "inserted" and an empty
// result means a gate failed (dup or stale base). The `$N` params are:
//   $1 tag, $2 id, $3 base, $4 keyframe, $5 nonce, $6 ciphertext,
//   $7 signature, $8 created_at
// `$1`/`$2`/`$3` are reused inside the subqueries.
//
// `nullSafeEq` is the dialect's null-safe equality operator between the
// current head id and the proposed `$3` base: `IS NOT DISTINCT FROM` on
// Postgres, `IS` on SQLite. It must be NULL-safe so the FIRST revision
// (base = NULL against an empty-chain head, also NULL) matches —
// plain `=` would be NULL → false and the first revision would never
// insert. This operator is the ONLY dialect difference in the statement,
// so it is the single parameter; everything else (column list, COALESCE,
// the `NOT EXISTS` dup gate, `RETURNING seq`) is shared verbatim.
export function buildGatedInsertSql(nullSafeEq: string): string {
  return `INSERT INTO workspace_revision
       (workspace_tag, seq, id, base, keyframe, nonce, ciphertext, signature, created_at)
     SELECT $1,
            COALESCE((SELECT MAX(seq) FROM workspace_revision WHERE workspace_tag = $1), 0) + 1,
            $2, $3, $4, $5, $6, $7, $8
     WHERE NOT EXISTS (SELECT 1 FROM workspace_revision WHERE workspace_tag = $1 AND id = $2)
       AND (SELECT id FROM workspace_revision WHERE workspace_tag = $1 ORDER BY seq DESC LIMIT 1)
           ${nullSafeEq} $3
     RETURNING seq`
}
