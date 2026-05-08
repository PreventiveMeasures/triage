// SQLite-backed revision storage. Two columns identify a revision:
//   `seq`  monotonic per workspace_tag, server-assigned at insert.
//          Drives chain ordering and `from`-cutoff filtering.
//   `id`   content-addressed identifier — SHA-256 of the canonical
//          save bytes (workspaceTag, base, nonce, ciphertext),
//          base64url-encoded. Computed by client AND server from
//          the same input, so the server can't reassign or relabel
//          revisions; UNIQUE on (workspace_tag, id) makes
//          retransmits idempotent.
// `base` points at the previous revision's `id` (or null for the
// first revision in a workspace).
//
// `node:sqlite` is the built-in driver (Node ≥ 22 experimental,
// stable in 24+). Synchronous API — fine here because the server
// is single-process and the WebSocket handler is the only writer.
// JS event-loop atomicity guarantees head + insert can't interleave
// with another save's head + insert.

import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS workspace_revision (
    workspace_tag TEXT NOT NULL,
    seq INTEGER NOT NULL,
    id TEXT NOT NULL,
    base TEXT,
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

export function openDb(path) {
  const db = new DatabaseSync(path)
  // WAL gives concurrent readers + faster writes and survives
  // crashes between commits without corrupting the file. Foreign
  // keys aren't strictly needed here (single-table schema) but
  // turning them on preserves the option to add referential
  // tables later without revisiting init.
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
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
    chainAll: db.prepare(`
      SELECT base, id, nonce, ciphertext, signature
      FROM workspace_revision
      WHERE workspace_tag = ?
      ORDER BY seq ASC
    `),
    chainAfterSeq: db.prepare(`
      SELECT base, id, nonce, ciphertext, signature
      FROM workspace_revision
      WHERE workspace_tag = ? AND seq > ?
      ORDER BY seq ASC
    `),
    revisionExists: db.prepare(`
      SELECT 1 FROM workspace_revision
      WHERE workspace_tag = ? AND id = ?
    `),
    insertRevision: db.prepare(`
      INSERT INTO workspace_revision
        (workspace_tag, seq, id, base, nonce, ciphertext, signature, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    close: () => db.close(),
  }
}

export function headFor(handle, tag) {
  const row = handle.headFor.get(tag)
  return row?.id ?? null
}

export function chainFrom(handle, tag, fromId) {
  if (fromId == null) return handle.chainAll.all(tag)
  const row = handle.seqOfId.get(tag, fromId)
  // Unknown fromId — server might have lost the revision the
  // client refers to (db reset, history compaction). Return the
  // full chain so the client can rebuild from the start. Safer
  // than returning empty (which would leave them out of sync).
  if (!row) return handle.chainAll.all(tag)
  return handle.chainAfterSeq.all(tag, row.seq)
}

export function revisionExists(handle, tag, id) {
  return Boolean(handle.revisionExists.get(tag, id))
}

export function insertRevision(handle, { tag, id, base, nonce, ciphertext, signature }) {
  const row = handle.headSeq.get(tag)
  const seq = (row?.s ?? 0) + 1
  handle.insertRevision.run(tag, seq, id, base ?? null, nonce, ciphertext, signature, Date.now())
}
