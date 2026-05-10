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
// stable in 24+). Synchronous API — fine here because the server
// is single-process and the WebSocket handler is the only writer.
// JS event-loop atomicity guarantees head + insert can't interleave
// with another save's head + insert.

import { DatabaseSync, type StatementSync } from 'node:sqlite'

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

// Bag of pre-prepared statements + the underlying connection. Held
// for the process lifetime; `close()` runs from `shutdown()`. Pre-
// preparing once means call sites read as `handle.headFor.get(tag)`
// rather than re-preparing every call.
export type Handle = {
  db: DatabaseSync
  headFor: StatementSync
  headSeq: StatementSync
  seqOfId: StatementSync
  lastKeyframeSeq: StatementSync
  chainAll: StatementSync
  chainAfterSeq: StatementSync
  chainFromSeq: StatementSync
  revisionExists: StatementSync
  insertRevision: StatementSync
  close: () => void
}

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

// Input to `insertRevision`. `keyframe` is a strict boolean here —
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

export function openDb(path: string): Handle {
  const db = new DatabaseSync(path)
  // WAL gives concurrent readers + faster writes and survives
  // crashes between commits without corrupting the file. Foreign
  // keys aren't strictly needed here (single-table schema) but
  // turning them on preserves the option to add referential
  // tables later without revisiting init.
  db.exec('PRAGMA journal_mode = WAL;')
  // FULL (not NORMAL): the server emits `workspace-save-ack` BEFORE
  // returning to the event loop after `insertRevision`. With NORMAL,
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
  return {
    db,
    headFor: db.prepare(`
      SELECT id FROM workspace_revision
      WHERE workspace_tag = ?
      ORDER BY seq DESC LIMIT 1
    `),
    headSeq: db.prepare(`
      SELECT MAX(seq) AS s FROM workspace_revision WHERE workspace_tag = ?
    `),
    seqOfId: db.prepare(`
      SELECT seq FROM workspace_revision
      WHERE workspace_tag = ? AND id = ?
    `),
    lastKeyframeSeq: db.prepare(`
      SELECT MAX(seq) AS s FROM workspace_revision
      WHERE workspace_tag = ? AND keyframe = 1
    `),
    chainAll: db.prepare(`
      SELECT base, id, keyframe, nonce, ciphertext, signature
      FROM workspace_revision
      WHERE workspace_tag = ?
      ORDER BY seq ASC
    `),
    chainAfterSeq: db.prepare(`
      SELECT base, id, keyframe, nonce, ciphertext, signature
      FROM workspace_revision
      WHERE workspace_tag = ? AND seq > ?
      ORDER BY seq ASC
    `),
    chainFromSeq: db.prepare(`
      SELECT base, id, keyframe, nonce, ciphertext, signature
      FROM workspace_revision
      WHERE workspace_tag = ? AND seq >= ?
      ORDER BY seq ASC
    `),
    revisionExists: db.prepare(`
      SELECT 1 FROM workspace_revision
      WHERE workspace_tag = ? AND id = ?
    `),
    insertRevision: db.prepare(`
      INSERT INTO workspace_revision
        (workspace_tag, seq, id, base, keyframe, nonce, ciphertext, signature, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    close: () => db.close(),
  }
}

export function headFor(handle: Handle, tag: string): string | null {
  const row = handle.headFor.get(tag) as { id: string } | undefined
  return row?.id ?? null
}

export function chainFrom(handle: Handle, tag: string, fromId: string | null): RevisionRow[] {
  // No base id, OR a base id the server doesn't recognise (db reset,
  // chain compaction, malicious peer): in either case the client has
  // no anchor we can incrementally serve from. Skip past everything
  // before the latest keyframe — the keyframe replaces baseState, so
  // anything older is redundant — and fall through to the full chain
  // only when no keyframe has been emitted yet (small workspace
  // hasn't crossed the threshold). Keeps the catch-up cost O(keyframe
  // interval) instead of O(history length) for either entry point.
  if (fromId != null) {
    const row = handle.seqOfId.get(tag, fromId) as { seq: number } | undefined
    if (row) return handle.chainAfterSeq.all(tag, row.seq) as RevisionRow[]
    // fall through to the from=null path below
  }
  const kf = handle.lastKeyframeSeq.get(tag) as { s: number | null } | undefined
  if (kf?.s != null) return handle.chainFromSeq.all(tag, kf.s) as RevisionRow[]
  return handle.chainAll.all(tag) as RevisionRow[]
}

export function revisionExists(handle: Handle, tag: string, id: string): boolean {
  return Boolean(handle.revisionExists.get(tag, id))
}

export function insertRevision(
  handle: Handle,
  { tag, id, base, keyframe, nonce, ciphertext, signature }: RevisionInsert,
): void {
  const row = handle.headSeq.get(tag) as { s: number | null } | undefined
  const seq = (row?.s ?? 0) + 1
  handle.insertRevision.run(tag, seq, id, base ?? null, keyframe ? 1 : 0, nonce, ciphertext, signature, Date.now())
}
