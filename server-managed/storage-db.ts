// Immutable encrypted bytes are published by a short SQL transaction. Neither
// migration nor a stalled writer can undo a concurrent deletion or replacement.
import { randomUUID } from 'node:crypto'
import type { ManagedSql } from './sql.ts'

export const STORAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_storage_encryption (
  id INTEGER PRIMARY KEY CHECK (id = 1), key_id TEXT NOT NULL,
  revision TEXT NOT NULL, cursor TEXT, scan_found INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0, migrated INTEGER NOT NULL DEFAULT 0,
  gc_cursor TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS managed_storage_object (
  key TEXT PRIMARY KEY, revision TEXT NOT NULL, object_key TEXT,
  digest TEXT, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS managed_storage_object_bytes_idx ON managed_storage_object(object_key);
CREATE TABLE IF NOT EXISTS managed_storage_prefix (
  prefix TEXT PRIMARY KEY, revision TEXT NOT NULL
) STRICT;
`

export interface StorageEncryptionState {
  keyId: string; revision: string; cursor: string | null; scanFound: number
  complete: number; migrated: number; gcCursor: string | null
}
export interface StorageReference {
  revision: string
  objectKey: string | null
  digest: string | null
  updatedAt: number | null
  legacy: boolean
}
export interface StorageDb {
  initializeStorageEncryption(keyId: string | null): Promise<StorageEncryptionState | null>
  getStorageEncryption(keyId: string | null): Promise<StorageEncryptionState | null>
  getStorageReference(keyId: string, key: string): Promise<StorageReference>
  publishStorageObject(keyId: string, key: string, expected: string, objectKey: string, digest: string, deadline: number, migration: boolean): Promise<boolean>
  deleteStorageObject(keyId: string, key: string, prefix: boolean, expected?: string): Promise<boolean>
  advanceStorageMigration(keyId: string, revision: string, cursor: string | null, found: number): Promise<boolean>
  advanceStorageGc(keyId: string, cursor: string | null): Promise<void>
  canCollectStorageObject(keyId: string, objectKey: string): Promise<boolean>
  listExpiredStorageUploads(keyId: string, before: number, limit: number): Promise<string[]>
}

function ancestors(key: string): string[] {
  return [...key.matchAll(/\//gu)].map(match => key.slice(0, match.index + 1))
}

export function storageMethods(db: ManagedSql): StorageDb {
  const stateStmt = db.prepare(`SELECT key_id AS keyId, revision, cursor, scan_found AS scanFound,
    complete, migrated, gc_cursor AS gcCursor FROM managed_storage_encryption WHERE id = 1`)
  async function state(keyId: string | null) {
    const row = await stateStmt.get() as StorageEncryptionState | undefined
    if (row && row.keyId !== keyId) throw new Error('Managed storage requires its configured encryption key')
    if (!row && keyId !== null) throw new Error('Managed storage encryption is not initialized')
    return row ?? null
  }
  async function reference(keyId: string, key: string): Promise<StorageReference> {
    const mode = await state(keyId)
    const row = await db.prepare('SELECT revision, object_key AS objectKey, digest, updated_at AS updatedAt FROM managed_storage_object WHERE key = ?').get(key) as
      { revision: string; objectKey: string | null; digest: string | null; updatedAt: number } | undefined
    const prefixes = ancestors(key)
    const deleted = prefixes.length > 0 ? await db.prepare(`SELECT prefix, revision FROM managed_storage_prefix
      WHERE prefix IN (${prefixes.map(() => '?').join(',')}) ORDER BY prefix`).all(...prefixes) : []
    return { revision: JSON.stringify([row?.revision ?? null, deleted]), objectKey: row?.objectKey ?? null,
      digest: row?.digest ?? null, updatedAt: row?.updatedAt ?? null, legacy: !row && deleted.length === 0 && mode?.complete === 0 }
  }
  return makeMethods(db, state, reference)
}

function makeMethods(db: ManagedSql, state: (id: string | null) => Promise<StorageEncryptionState | null>,
  reference: (id: string, key: string) => Promise<StorageReference>): StorageDb {
  return {
    async initializeStorageEncryption(keyId) {
      if (keyId !== null) await db.prepare(`INSERT OR IGNORE INTO managed_storage_encryption (id, key_id, revision) VALUES (1, ?, ?)`).run(keyId, randomUUID())
      return state(keyId)
    },
    getStorageEncryption: state,
    getStorageReference: reference,
    async publishStorageObject(keyId, key, expected, objectKey, digest, deadline, migration) {
      const current = await reference(keyId, key)
      if (Date.now() >= deadline || current.revision !== expected || (migration && !current.legacy)) return false
      await db.prepare(`INSERT INTO managed_storage_object (key, revision, object_key, digest, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET revision = excluded.revision, object_key = excluded.object_key,
        digest = excluded.digest, updated_at = excluded.updated_at`).run(key, randomUUID(), objectKey, digest, Date.now())
      if (migration) await db.prepare('UPDATE managed_storage_encryption SET migrated = migrated + 1 WHERE id = 1').run()
      return true
    },
    async deleteStorageObject(keyId, key, prefix, expected) {
      await state(keyId)
      if (expected !== undefined && (await reference(keyId, key)).revision !== expected) return false
      const revision = randomUUID()
      if (prefix) {
        await db.prepare(`INSERT INTO managed_storage_prefix (prefix, revision) VALUES (?, ?)
          ON CONFLICT(prefix) DO UPDATE SET revision = excluded.revision`).run(key, revision)
        await db.prepare(`UPDATE managed_storage_object SET revision = ?, object_key = NULL, digest = NULL, updated_at = ?
          WHERE key LIKE ?`).run(revision, Date.now(), `${key}%`)
      } else {
        await db.prepare(`INSERT INTO managed_storage_object (key, revision, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET revision = excluded.revision, object_key = NULL, digest = NULL,
          updated_at = excluded.updated_at`).run(key, revision, Date.now())
      }
      return true
    },
    async advanceStorageMigration(keyId, revision, cursor, found) {
      const current = await state(keyId)
      if (!current || current.revision !== revision) return false
      const total = current.scanFound + found
      await db.prepare(`UPDATE managed_storage_encryption SET revision = ?, cursor = ?, scan_found = ?, complete = ? WHERE id = 1`)
        .run(randomUUID(), cursor, cursor === null ? 0 : total, cursor === null && total === 0 ? 1 : 0)
      return true
    },
    async advanceStorageGc(keyId, cursor) {
      await state(keyId)
      await db.prepare('UPDATE managed_storage_encryption SET gc_cursor = ? WHERE id = 1').run(cursor)
    },
    async canCollectStorageObject(keyId, objectKey) {
      // The name deliberately selects the writer transaction in sql.ts. Wait
      // for any pending publication before checking references. A candidate
      // old enough for GC cannot start a new publication (its deadline passed).
      await state(keyId)
      return (await db.prepare('SELECT key FROM managed_storage_object WHERE object_key = ? LIMIT 1').get(objectKey)) == null
    },
    async listExpiredStorageUploads(keyId, before, limit) {
      await state(keyId)
      const rows = await db.prepare(`SELECT key FROM managed_storage_object
        WHERE key LIKE 'uploads/%' AND object_key IS NOT NULL AND updated_at < ? ORDER BY key LIMIT ?`).all(before, limit) as { key: string }[]
      return rows.map(row => row.key)
    },
  }
}
