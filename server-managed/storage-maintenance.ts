import { type StorageKey, decryptStorageStream, encryptStorageStream } from '../server-common/storage-crypto.ts'
import { type RawObjectStorage } from './object-storage.ts'
import { type StorageDb, type StorageEncryptionState, type StorageMigrationRow, unwrapDataKey } from './storage-db.ts'
import { STORAGE_UPLOAD_TTL_MS } from './storage-encryption.ts'
import { inspectStorageObject, storageOwner, storageRowPath, verifyStoragePayload } from './storage-payload.ts'

async function migrateRow(raw: RawObjectStorage, db: StorageDb, key: StorageKey, item: StorageMigrationRow, signal: AbortSignal) {
  if (item.type === 'user') { await db.migrateStorageUserTokens(item.id); return }
  const row = await db.ensureStorageDataKey(item.type, item.id)
  if (!row || row.encrypted) return
  const dataKey = unwrapDataKey(key, item.type, row), identity = storageRowPath(item.type, row)
  try {
    const source = await raw.open(identity, signal)
    if (!source) {
      if (!await db.getStorageRow(item.type, item.id)) return
      throw new Error('Migration payload unavailable')
    }
    let inspected = await inspectStorageObject(source)
    if (inspected.encrypted) {
      // A previous PUT may have completed before a timeout or lost SQL ack.
      try {
        const decoded = await decryptStorageStream(inspected.stream, dataKey, identity)
        await verifyStoragePayload(item.type, row, decoded.stream, signal)
      } catch {
        signal.throwIfAborted()
        // Legacy arbitrary bytes can share the magic prefix. A matching
        // original upload hash is required before encrypting them as plaintext.
        const legacy = await raw.open(identity, signal)
        if (!legacy || legacy.version !== source.version) { legacy?.stream.destroy(); return }
        inspected = { ...legacy, encrypted: false }
      }
    }
    if (!inspected.encrypted) {
      await verifyStoragePayload(item.type, row, inspected.stream, signal)
      signal.throwIfAborted()
      const current = await raw.open(identity, signal)
      if (!current) return
      if (current.version !== source.version) { current.stream.destroy(); return }
      const encrypted = encryptStorageStream(current.stream, dataKey, identity, current.size)
      let replaced: boolean
      try { replaced = await raw.put(identity, encrypted, signal, source.version, current.size ?? undefined) }
      finally { encrypted.destroy(); current.stream.destroy() }
      if (!replaced) return
      // Do not mark the row encrypted until the stored bytes authenticate and
      // match the original upload (including decompression for sourcemaps).
      const replacement = await raw.open(identity, signal)
      if (!replacement) {
        if (!await db.getStorageRow(item.type, item.id)) return
        throw new Error('Migrated payload unavailable')
      }
      const decoded = await decryptStorageStream(replacement.stream, dataKey, identity)
      await verifyStoragePayload(item.type, row, decoded.stream, signal)
    }
    signal.throwIfAborted()
    // Another process may have renamed ciphertext but stopped before syncing
    // the directory. Persist the observed rename even on the resume path.
    await raw.sync?.(identity, signal)
    await db.markStorageEncrypted(item.type, item.id, row.dataKey!)
  } finally { dataKey.fill(0) }
}

const LEGACY = ['cache/', 'reports/', 'bundles/']
function cleanupPosition(state: StorageEncryptionState): { prefix: number; cursor: string | null } {
  const value = state.cleanupCursor === null ? { prefix: 0, cursor: null } : JSON.parse(state.cleanupCursor)
  if (!Number.isInteger(value.prefix) || value.prefix < 0 || value.prefix >= LEGACY.length
    || (value.cursor !== null && typeof value.cursor !== 'string')) throw new Error('Invalid legacy cleanup cursor')
  return value
}

// Referenced-data migration never depends on Blob listings. A separate bounded
// inventory removes legacy caches and unreferenced plaintext; ciphertext
// orphans do not hold a recoverable data key and need no manifest-based GC.
async function cleanupLegacy(raw: RawObjectStorage, db: StorageDb, state: StorageEncryptionState, limit: number, signal: AbortSignal) {
  const position = cleanupPosition(state), prefix = LEGACY[position.prefix]!
  const page = await raw.list(prefix, position.cursor, Math.min(limit, 16), signal)
  let found = 0, retryAt: number | null = null
  for (const object of page.objects) {
    signal.throwIfAborted()
    // A process killed during a pre-activation disk write can leave a temp
    // file. Give live writes time to finish before collecting those files.
    if (object.key.endsWith('.tmp') && object.modifiedAt > Date.now() - STORAGE_UPLOAD_TTL_MS) {
      found++
      retryAt = Math.min(retryAt ?? Infinity, object.modifiedAt + STORAGE_UPLOAD_TTL_MS)
      continue
    }
    const owner = storageOwner(object.key)
    if (owner && !owner.cache) {
      const row = await db.getStorageRow(owner.type, owner.id)
      if (row && storageRowPath(owner.type, row) === object.key) continue
    }
    const stored = await raw.head(object.key, signal)
    if (!stored) continue
    // Old pre-activation orphans are legacy even when their arbitrary bytes
    // share the magic prefix. Keep a full staging grace window around enable:
    // Blob Last-Modified has only second precision, and a new encrypted upload
    // may still be waiting for its SQL insert.
    let legacy = prefix === 'cache/' || stored.modifiedAt < state.enabledAt - STORAGE_UPLOAD_TTL_MS
    if (!legacy) {
      const source = await raw.open(object.key, signal)
      if (!source) continue
      try {
        if (source.version !== stored.version) throw new Error('Legacy object changed during cleanup')
        const inspected = await inspectStorageObject(source)
        legacy = !inspected.encrypted
        inspected.stream.destroy()
      } finally { source.stream.destroy() }
    }
    if (legacy) {
      found++
      if (!await raw.delete(object.key, stored.version, signal)) throw new Error('Legacy object changed during cleanup')
    }
  }
  const next = page.cursor === null ? position.prefix + 1 < LEGACY.length ? { prefix: position.prefix + 1, cursor: null } : null
    : { ...position, cursor: page.cursor }
  // A full pass without removals closes offset-pagination gaps left by deletes.
  await db.advanceStorageCleanup(state.cleanupCursor, next === null ? null : JSON.stringify(next), found)
  return { processed: page.objects.length || 1, retryAt }
}

export interface StorageMigrationResult extends StorageEncryptionState { retryAt: number | null }
export async function migrateStorage(raw: RawObjectStorage, db: StorageDb, key: StorageKey,
  { maxObjects = 64, maxMs = 150_000 } = {}): Promise<StorageMigrationResult> {
  if (!Number.isSafeInteger(maxObjects) || maxObjects < 1 || !Number.isSafeInteger(maxMs) || maxMs < 1) throw new Error('Invalid migration budget')
  const deadline = Date.now() + maxMs, signal = AbortSignal.timeout(maxMs)
  const errors: unknown[] = []
  let processed = 0, retryAt: number | null = null, state = await db.getStorageEncryption()
  if (!state) throw new Error('Storage encryption is not enabled; configure MANAGED_STORAGE_ENCRYPTION_KEY')
  // At most one SQL pass per invocation. Checkpoint each row, including a
  // failure: other rows progress, and the failed row is retried next pass.
  while (!state.complete && processed < maxObjects && Date.now() < deadline) {
    const rows = await db.listStorageMigrationRows(state.cursor, Math.min(16, maxObjects - processed))
    if (rows.length === 0) { await db.advanceStorageMigration(state.cursor, null); break }
    for (const row of rows) {
      if (Date.now() >= deadline) break
      try { await migrateRow(raw, db, key, row, signal) }
      catch (err) {
        if (signal.aborted) break // Leave this row pending for the next batch.
        errors.push(new Error(`Could not migrate ${row.type} ${row.id}`, { cause: err }))
      }
      await db.advanceStorageMigration(state.cursor, row.position)
      processed++
      state = (await db.getStorageEncryption())!
    }
  }
  state = (await db.getStorageEncryption())!
  while (!state.cleanupComplete && processed < maxObjects && Date.now() < deadline) {
    try {
      const cleanup = await cleanupLegacy(raw, db, state, maxObjects - processed, signal)
      processed += cleanup.processed
      retryAt = cleanup.retryAt
    }
    catch (err) { if (!signal.aborted) errors.push(err); break }
    state = (await db.getStorageEncryption())!
    if (retryAt !== null) break // Wait for staging grace rather than spinning over live temp files.
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Storage migration has pending failures', { cause: errors[0] })
  return { ...state, retryAt }
}

export async function reapStorageUploads(raw: RawObjectStorage, db: StorageDb, now = Date.now()): Promise<number> {
  const signal = AbortSignal.timeout(150_000)
  await db.getStorageEncryption()
  const before = now - STORAGE_UPLOAD_TTL_MS
  // Finish listing before deleting: Vercel cursors can be offset-based.
  const cursors = new Set<string>(), expired: string[] = []
  let cursor: string | null = null
  do {
    const page = await raw.list('uploads/', cursor, 100, signal)
    expired.push(...page.objects.filter(object => object.modifiedAt < before).map(object => object.key))
    cursor = page.cursor
    if (cursor !== null && cursors.has(cursor)) throw new Error('Invalid blob pagination')
    if (cursor !== null) cursors.add(cursor)
  } while (cursor !== null)
  let removed = 0
  for (const identity of expired) {
    const stored = await raw.head(identity, signal)
    if (!stored) continue
    if (stored.modifiedAt < before && await raw.delete(identity, stored.version, signal)) removed++
  }
  return removed
}
