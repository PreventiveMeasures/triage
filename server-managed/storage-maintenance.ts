import type { StorageKey } from '../server-common/storage-crypto.ts'
import { ENCRYPTED_PREFIX, LEGACY_PREFIXES, type ListedObject, type RawObjectStorage } from './object-storage.ts'
import type { StorageDb, StorageEncryptionState } from './storage-db.ts'
import { STORAGE_GC_MS, STORAGE_WRITE_MS, removeLegacy, stageEncrypted, verifyEncrypted } from './storage-encryption.ts'

async function removePublishedLegacy(raw: RawObjectStorage, db: StorageDb, key: StorageKey, identity: string,
  signal: AbortSignal, version?: string): Promise<void> {
  const current = await db.getStorageReference(key.id, identity)
  if (current.legacy) return
  if (current.objectKey) {
    // A previous worker may have committed, then lost its acknowledgement or
    // stopped before deleting plaintext. Verify the current recovery target
    // again before removing the remaining copy, including after a lost CAS.
    if (!current.digest) throw new Error('Encrypted storage reference has no digest')
    await verifyEncrypted(raw, key, identity, current.objectKey, current.digest, signal)
    if ((await db.getStorageReference(key.id, identity)).revision !== current.revision) return
  }
  signal.throwIfAborted()
  if (version === undefined) await removeLegacy(raw, identity, signal)
  else if (!await raw.delete(identity, version)) throw new Error('Legacy storage changed during encryption migration')
}

async function migrateObject(raw: RawObjectStorage, db: StorageDb, key: StorageKey, identity: string, deadline: number, signal: AbortSignal) {
  const snapshot = await db.getStorageReference(key.id, identity)
  if (!snapshot.legacy) { await removePublishedLegacy(raw, db, key, identity, signal); return }
  const stored = await raw.open(identity, signal)
  if (!stored) return
  const candidate = await stageEncrypted(raw, key, identity, stored.stream, stored.size, signal)
  await verifyEncrypted(raw, key, identity, candidate.objectKey, candidate.digest, signal)
  const published = await db.publishStorageObject(key.id, identity, snapshot.revision, candidate.objectKey, candidate.digest, deadline, true)
  if (!published) {
    await raw.delete(candidate.objectKey)
    // A concurrent write/delete is authoritative. On timeout leave plaintext
    // available for a later attempt rather than removing the only live copy.
    await removePublishedLegacy(raw, db, key, identity, signal, stored.version)
    return
  }
  if (!await raw.delete(identity, stored.version)) throw new Error('Legacy storage changed during encryption migration')
}

function migrationCursor(state: StorageEncryptionState): { prefix: number; cursor: string | null } {
  if (state.cursor === null) return { prefix: 0, cursor: null }
  const value = JSON.parse(state.cursor)
  if (!Number.isInteger(value.prefix) || value.prefix < 0 || value.prefix >= LEGACY_PREFIXES.length
    || (value.cursor !== null && typeof value.cursor !== 'string')) throw new Error('Invalid storage migration cursor')
  return value
}

export async function migrateStorage(raw: RawObjectStorage, db: StorageDb, key: StorageKey,
  { maxObjects = 64, maxMs = 150_000 } = {}): Promise<StorageEncryptionState> {
  if (!Number.isSafeInteger(maxObjects) || maxObjects < 1 || !Number.isSafeInteger(maxMs) || maxMs < 1) throw new Error('Invalid migration budget')
  const deadline = Date.now() + Math.min(maxMs, STORAGE_WRITE_MS)
  const signal = AbortSignal.timeout(Math.min(maxMs, STORAGE_WRITE_MS))
  let processed = 0
  let state = (await db.getStorageEncryption(key.id))!
  while (!state.complete && processed < maxObjects && Date.now() < deadline) {
    const position = migrationCursor(state)
    const page = await raw.list(LEGACY_PREFIXES[position.prefix]!, position.cursor, Math.min(16, maxObjects - processed))
    for (const object of page.objects) {
      signal.throwIfAborted()
      await migrateObject(raw, db, key, object.key, deadline, signal)
      processed++
    }
    const next = page.cursor === null ? position.prefix + 1 < LEGACY_PREFIXES.length ? { prefix: position.prefix + 1, cursor: null } : null
      : { ...position, cursor: page.cursor }
    await db.advanceStorageMigration(key.id, state.revision, next === null ? null : JSON.stringify(next), page.objects.length)
    state = (await db.getStorageEncryption(key.id))!
  }
  return state
}

export async function reapEncryptedStorage(raw: RawObjectStorage, db: StorageDb, key: StorageKey, now = Date.now()): Promise<void> {
  const state = (await db.getStorageEncryption(key.id))!
  const page = await raw.list(ENCRYPTED_PREFIX, state.gcCursor, 100)
  for (const object of page.objects) {
    if (!(object.modifiedAt < now - STORAGE_GC_MS) || !await db.canCollectStorageObject(key.id, object.key)) continue
    await raw.delete(object.key)
  }
  await db.advanceStorageGc(key.id, page.cursor)
}

export async function reapStorageUploads(raw: RawObjectStorage, db: StorageDb, key: StorageKey | null, now = Date.now()): Promise<void> {
  const before = now - STORAGE_GC_MS
  if (key) {
    for (const identity of await db.listExpiredStorageUploads(key.id, before, 100)) {
      const ref = await db.getStorageReference(key.id, identity)
      if (ref.updatedAt === null || ref.updatedAt >= before) continue
      await db.deleteStorageObject(key.id, identity, false, ref.revision)
    }
  } else await db.getStorageEncryption(null)
  // Encrypted deployments have a resumable migration for the remaining legacy
  // pages. Without encryption, retain the existing full staging sweep.
  const cursors = new Set<string>(), expired: ListedObject[] = []
  let cursor: string | null = null
  do {
    const page = await raw.list('uploads/', cursor, 100)
    expired.push(...page.objects.filter(object => object.modifiedAt < before))
    cursor = key ? null : page.cursor
    if (cursor !== null && cursors.has(cursor)) throw new Error('Invalid blob pagination')
    if (cursor !== null) cursors.add(cursor)
  } while (cursor !== null)
  // Finish listing before deleting so opaque offset cursors do not skip parts.
  for (const object of expired) {
    const stored = await raw.open(object.key)
    if (!stored) continue
    stored.stream.destroy()
    // A retry can replace a part after listing. Expire the observed version
    // only, and recheck its age before changing the SQL reference.
    if (!(stored.modifiedAt < before)) continue
    if (key) {
      const ref = await db.getStorageReference(key.id, object.key)
      if (ref.legacy) await db.deleteStorageObject(key.id, object.key, false, ref.revision)
    } else await db.getStorageEncryption(null)
    await raw.delete(object.key, stored.version)
  }
}
