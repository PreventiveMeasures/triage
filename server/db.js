// SQLite-backed revision storage. One row per workspace revision;
// `(workspace_tag, id)` is the primary key. `id` is sequential per
// workspace_tag — assigned by the server at insert time as
// `(MAX(id) + 1)`. `base` points at the previous revision in the
// chain (null only on the very first revision in a workspace).
//
// `node:sqlite` is the built-in driver (Node >=22 experimental,
// stable in 24+). Synchronous API — fine here because the server
// is single-process and the WebSocket handler is the only writer.
// JS event-loop atomicity guarantees head + insert can't interleave
// with another save's head + insert.

import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS workspace_revision (
    workspace_tag TEXT NOT NULL,
    id INTEGER NOT NULL,
    base INTEGER,
    nonce TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    signature TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_tag, id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS workspace_revision_created_idx
    ON workspace_revision (workspace_tag, created_at);
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
    headFor: db.prepare('SELECT MAX(id) AS head FROM workspace_revision WHERE workspace_tag = ?'),
    chainFrom: db.prepare(`
      SELECT base, id, nonce, ciphertext, signature
      FROM workspace_revision
      WHERE workspace_tag = ? AND id > ?
      ORDER BY id ASC
    `),
    insertRevision: db.prepare(`
      INSERT INTO workspace_revision
        (workspace_tag, id, base, nonce, ciphertext, signature, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    close: () => db.close(),
  }
}

export function headFor(handle, tag) {
  const row = handle.headFor.get(tag)
  return row?.head ?? null
}

export function chainFrom(handle, tag, fromBase) {
  // `id > ?` walks the chain forward from after `fromBase`. Null
  // means "start from the beginning" — `id > 0` matches all.
  return handle.chainFrom.all(tag, fromBase ?? 0)
}

export function insertRevision(handle, { tag, id, base, nonce, ciphertext, signature }) {
  handle.insertRevision.run(tag, id, base ?? null, nonce, ciphertext, signature, Date.now())
}
