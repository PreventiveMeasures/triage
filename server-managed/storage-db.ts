// Keys belong to the existing upload rows. Only installation state and bounded
// migration progress need a separate table; payload paths never move.
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { type StorageKey, unwrapStorageValue, wrapStorageValue } from '../server-common/storage-crypto.ts'
import type { ManagedSql } from './sql.ts'

export const STORAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_storage_encryption (
  id INTEGER PRIMARY KEY CHECK (id = 1), test_value TEXT NOT NULL,
  enabled_at INTEGER NOT NULL, cursor TEXT, complete INTEGER NOT NULL DEFAULT 0,
  migrated INTEGER NOT NULL DEFAULT 0, cleanup_cursor TEXT,
  cleanup_found INTEGER NOT NULL DEFAULT 0, cleanup_complete INTEGER NOT NULL DEFAULT 0
) STRICT;
`
const SENTINEL = Buffer.from('deepview.storage.required.v1')
export type StorageRowKind = 'report' | 'bundle'
export interface StorageEncryptionState {
  enabledAt: number; cursor: string | null; complete: number; migrated: number
  cleanupCursor: string | null; cleanupFound: number; cleanupComplete: number
}
export interface StorageRow {
  id: string; dataKey: string | null; encrypted: number; hash: string; kind: string | null
}
export interface StorageMigrationRow { position: string; id: string; type: StorageRowKind | 'user' }
export interface StorageDb {
  enableStorageEncryption(): Promise<StorageEncryptionState>
  getStorageEncryption(): Promise<StorageEncryptionState | null>
  getStorageRow(type: StorageRowKind, id: string): Promise<StorageRow | null>
  ensureStorageDataKey(type: StorageRowKind, id: string): Promise<StorageRow | null>
  markStorageEncrypted(type: StorageRowKind, id: string, dataKey: string): Promise<void>
  listStorageMigrationRows(after: string | null, limit: number): Promise<StorageMigrationRow[]>
  advanceStorageMigration(expected: string | null, next: string | null): Promise<void>
  advanceStorageCleanup(expected: string | null, next: string | null, removed: number): Promise<void>
  migrateStorageUserTokens(id: string): Promise<void>
}

function table(type: StorageRowKind): string {
  if (type !== 'report' && type !== 'bundle') throw new Error('Invalid storage row type')
  return `managed_${type}`
}
export const dataKeyIdentity = (type: StorageRowKind, id: string): string => `${table(type)}:${id}`
export function unwrapDataKey(key: StorageKey, type: StorageRowKind, row: Pick<StorageRow, 'id' | 'dataKey'>): Buffer {
  if (!row.dataKey) throw new Error('Missing storage data key')
  const value = unwrapStorageValue(key, dataKeyIdentity(type, row.id), row.dataKey)
  if (value.length !== 32) { value.fill(0); throw new Error('Invalid storage data key') }
  return value
}

export async function storageState(db: ManagedSql, key: StorageKey | null): Promise<StorageEncryptionState | null> {
  const row = await db.prepare(`SELECT test_value AS testValue, enabled_at AS enabledAt, cursor, complete, migrated,
    cleanup_cursor AS cleanupCursor, cleanup_found AS cleanupFound, cleanup_complete AS cleanupComplete
    FROM managed_storage_encryption WHERE id = 1`).get() as (StorageEncryptionState & { testValue: string }) | undefined
  if (!row) return null
  if (!key) throw new Error('Managed storage requires its configured encryption key')
  const plain = unwrapStorageValue(key, 'managed_storage_encryption:1', row.testValue)
  try { if (!plain.equals(SENTINEL)) throw new Error('Invalid storage encryption test value') }
  finally { plain.fill(0) }
  const { testValue: _testValue, ...state } = row
  return state
}

// Called inside the insert transaction, fencing an old/plain upload that raced
// activation. The wrapped key never enters public report/bundle DTOs.
export async function validateStorageUpload(db: ManagedSql, key: StorageKey | null, type: StorageRowKind,
  id: string, dataKey: string | null | undefined): Promise<void> {
  const state = await storageState(db, key)
  if (state) unwrapDataKey(key!, type, { id, dataKey: dataKey ?? null }).fill(0)
  else if (dataKey) throw new Error('Storage encryption is not enabled')
}

export interface StoredTokens { access: string | null; refresh: string | null; exp: number | null; encrypted: number }
// A user holds up to two GitHub tokens: the login App's ('login') and, when the
// repository App authorizes users separately, the repository App's ('app').
// Each slot has its own columns, so each ciphertext is bound to its column.
export type GithubTokenSlot = 'login' | 'app'
const TOKEN_COLUMNS = {
  login: { access: 'gh_access_token', refresh: 'gh_refresh_token', expires: 'gh_token_expires_at', encrypted: 'gh_tokens_encrypted' },
  app: { access: 'gh_app_access_token', refresh: 'gh_app_refresh_token', expires: 'gh_app_token_expires_at', encrypted: 'gh_app_tokens_encrypted' },
} as const
export const GITHUB_TOKEN_SLOTS = Object.keys(TOKEN_COLUMNS) as GithubTokenSlot[]
// Column names reach SQL, so an unknown slot is an error, never a default.
export function tokenColumns(slot: GithubTokenSlot) {
  if (!Object.hasOwn(TOKEN_COLUMNS, slot)) throw new Error('Invalid GitHub token slot')
  return TOKEN_COLUMNS[slot]
}
export const selectTokensSql = (slot: GithubTokenSlot) => {
  const c = tokenColumns(slot)
  return `SELECT ${c.access} AS access, ${c.refresh} AS refresh, ${c.expires} AS exp, ${c.encrypted} AS encrypted FROM managed_user WHERE id = ?`
}
const tokenIdentity = (id: string, column: string) => `managed_user.${column}:${id}`
export function encodeStorageTokens(key: StorageKey, id: string, access: string | null, refresh: string | null, slot: GithubTokenSlot = 'login') {
  const c = tokenColumns(slot)
  const encode = (column: string, value: string | null) => value === null ? null : wrapStorageValue(key, tokenIdentity(id, column), Buffer.from(value))
  return { access: encode(c.access, access), refresh: encode(c.refresh, refresh) }
}
export function decodeStorageTokens(key: StorageKey, id: string, row: StoredTokens, slot: GithubTokenSlot = 'login') {
  const c = tokenColumns(slot)
  const decode = (column: string, value: string | null) => {
    if (value === null) return null
    const plain = unwrapStorageValue(key, tokenIdentity(id, column), value)
    try { return plain.toString('utf8') } finally { plain.fill(0) }
  }
  return { access: decode(c.access, row.access), refresh: decode(c.refresh, row.refresh) }
}
const PLAINTEXT_TOKENS = GITHUB_TOKEN_SLOTS.map(slot => {
  const c = tokenColumns(slot)
  return `(${c.encrypted} = 0 AND (${c.access} IS NOT NULL OR ${c.refresh} IS NOT NULL))`
}).join(' OR ')

// Fixed-width sizes make the saved position sort by type, then numeric byte
// size, then ID in both SQLite and Postgres. Sixteen digits cover JS safe sizes.
const PADDED_SIZE = "substr('0000000000000000', 1, 16 - length(CAST(byte_size AS TEXT))) || CAST(byte_size AS TEXT)"
const PENDING = `SELECT '0:' || ${PADDED_SIZE} || ':' || id AS position, id, 'report' AS type FROM managed_report WHERE storage_encrypted = 0
  UNION ALL SELECT '1:' || ${PADDED_SIZE} || ':' || id AS position, id, 'bundle' AS type FROM managed_bundle WHERE storage_encrypted = 0
  UNION ALL SELECT '2:0000000000000000:' || id AS position, id, 'user' AS type FROM managed_user
    WHERE ${PLAINTEXT_TOKENS}`

// Restart the pending pass for a cursor saved under the previous ID ordering.
// Completed rows are excluded by PENDING; the original cursor still fences CAS.
const orderedCursor = (cursor: string | null): string => cursor && /^[012]:[0-9]{16}:/u.test(cursor) ? cursor : ''

export function storageMethods(db: ManagedSql, key: StorageKey | null): StorageDb {
  async function requireEnabled() {
    const state = await storageState(db, key)
    if (!state) throw new Error('Storage encryption is not enabled; configure MANAGED_STORAGE_ENCRYPTION_KEY')
    return state
  }
  async function getRow(type: StorageRowKind, id: string): Promise<StorageRow | null> {
    const row = await db.prepare(`SELECT id, data_key AS dataKey, storage_encrypted AS encrypted,
      ${type === 'report' ? 'sha256 AS hash, NULL AS kind' : 'integrity AS hash, kind'} FROM ${table(type)} WHERE id = ?`).get(id) as StorageRow | undefined ?? null
    if (row && row.encrypted !== 0 && row.encrypted !== 1) throw new Error('Invalid storage encryption state')
    if (row?.encrypted && !row.dataKey) throw new Error('Encrypted storage row is missing its data key')
    return row
  }
  return {
    async enableStorageEncryption() {
      if (!key) throw new Error('Set MANAGED_STORAGE_ENCRYPTION_KEY before enabling storage encryption')
      // Called during startup in a writer transaction. Concurrent instances
      // must reuse the marker and validate its key before serving requests.
      const existing = await storageState(db, key)
      if (existing) return existing
      await db.prepare('INSERT INTO managed_storage_encryption (id, test_value, enabled_at) VALUES (1, ?, ?)')
        .run(wrapStorageValue(key, 'managed_storage_encryption:1', SENTINEL), Date.now())
      return (await storageState(db, key))!
    },
    getStorageEncryption: () => storageState(db, key),
    getStorageRow: getRow,
    async ensureStorageDataKey(type, id) {
      await requireEnabled()
      const current = await getRow(type, id)
      if (!current || current.dataKey) return current
      const bytes = randomBytes(32)
      let wrapped: string
      try { wrapped = wrapStorageValue(key!, dataKeyIdentity(type, id), bytes) } finally { bytes.fill(0) }
      await db.prepare(`UPDATE ${table(type)} SET data_key = ? WHERE id = ? AND data_key IS NULL`).run(wrapped, id)
      // Return the persisted winner, never a worker's uncommitted candidate.
      return getRow(type, id)
    },
    async markStorageEncrypted(type, id, wrapped) {
      await requireEnabled()
      const result = await db.prepare(`UPDATE ${table(type)} SET storage_encrypted = 1
        WHERE id = ? AND data_key = ? AND storage_encrypted = 0`).run(id, wrapped)
      if (Number(result.changes)) await db.prepare('UPDATE managed_storage_encryption SET migrated = migrated + 1 WHERE id = 1').run()
    },
    async listStorageMigrationRows(after, limit) {
      await requireEnabled()
      return await db.prepare(`SELECT position, id, type FROM (${PENDING}) AS pending
        WHERE position > ? ORDER BY position LIMIT ?`).all(orderedCursor(after), limit) as StorageMigrationRow[]
    },
    async advanceStorageMigration(expected, next) {
      await requireEnabled()
      if (next !== null && next <= orderedCursor(expected)) return
      // End-of-pass completion checks every pending row, including failed rows
      // before the cursor. A failure cannot be mistaken for a finished pass.
      await db.prepare(`UPDATE managed_storage_encryption SET cursor = ?, complete =
        CASE WHEN ? IS NULL AND NOT EXISTS (SELECT 1 FROM (${PENDING}) AS pending) THEN 1 ELSE 0 END
        WHERE id = 1 AND (cursor = ? OR (cursor IS NULL AND ? IS NULL))`).run(next, next, expected, expected)
    },
    async advanceStorageCleanup(expected, next, removed) {
      const state = await requireEnabled()
      const found = state.cleanupFound + removed
      await db.prepare(`UPDATE managed_storage_encryption SET cleanup_cursor = ?, cleanup_found = ?, cleanup_complete = ?
        WHERE id = 1 AND (cleanup_cursor = ? OR (cleanup_cursor IS NULL AND ? IS NULL))`).run(next, next === null ? 0 : found, next === null && found === 0 ? 1 : 0, expected, expected)
    },
    async migrateStorageUserTokens(id) {
      await requireEnabled()
      let migrated = false
      for (const slot of GITHUB_TOKEN_SLOTS) {
        const row = await db.prepare(selectTokensSql(slot)).get(id) as StoredTokens | undefined
        if (!row || row.encrypted || (row.access === null && row.refresh === null)) continue
        const value = encodeStorageTokens(key!, id, row.access, row.refresh, slot)
        const c = tokenColumns(slot)
        // This operation holds the writer transaction; token refresh cannot be
        // overwritten by a migration that read an earlier token value.
        await db.prepare(`UPDATE managed_user SET ${c.access} = ?, ${c.refresh} = ?, ${c.encrypted} = 1 WHERE id = ?`)
          .run(value.access, value.refresh, id)
        migrated = true
      }
      if (migrated) await db.prepare('UPDATE managed_storage_encryption SET migrated = migrated + 1 WHERE id = 1').run()
    },
  }
}
