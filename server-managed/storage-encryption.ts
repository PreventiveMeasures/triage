import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { type StorageKey, decryptStorageStream, encryptStorageStream, wrapStorageValue } from '../server-common/storage-crypto.ts'
import { ENCRYPTED_CACHE_PREFIX, type ObjectStorage, type RawObject, type RawObjectStorage, deleteObjects, objectPath, openObjectVersion } from './object-storage.ts'
import { type StorageDb, type StorageEncryptionState, type StorageRow, type StorageRowKind, dataKeyIdentity, unwrapDataKey } from './storage-db.ts'
import { inspectStorageObject, storageOwner, storageRowPaths, verifyStoragePayload } from './storage-payload.ts'

const STORAGE_WRITE_MS = 180_000
export const STORAGE_UPLOAD_TTL_MS = 86_400_000
export const STORAGE_DISABLED_TTL_MS = 5_000

async function readBytes(stored: Awaited<ReturnType<ObjectStorage['open']>>): Promise<Buffer | null> {
  if (!stored) return null
  const parts: Buffer[] = []
  try { for await (const part of stored.stream) parts.push(Buffer.from(part)); return Buffer.concat(parts) }
  finally { stored.stream.destroy() }
}
function logicalKey(identity: string) {
  objectPath(identity)
  if (identity.startsWith(ENCRYPTED_CACHE_PREFIX)) throw new Error('Encrypted cache paths are internal')
}
const encryptedCachePath = (identity: string) => `${ENCRYPTED_CACHE_PREFIX}${identity.slice('cache/'.length)}`
const deletionPaths = (identity: string) => identity.startsWith('cache/') ? [identity, encryptedCachePath(identity)] : [identity]

// A PUT can commit and still throw. Remove only this attempted plaintext,
// comparing bytes rather than magic: arbitrary uploads can share the header.
// A concurrent migration's ciphertext must survive this reconciliation.
async function discardPlaintextWrite(raw: RawObjectStorage, identity: string, bytes: Buffer): Promise<void> {
  // Leave time to report the original failure inside a serverless invocation.
  const signal = AbortSignal.timeout(30_000)
  const current = await raw.open(identity, signal)
  if (!current) return
  try {
    let offset = 0
    for await (const part of current.stream) {
      const chunk = Buffer.from(part)
      if (!chunk.equals(bytes.subarray(offset, offset + chunk.length))) return
      offset += chunk.length
    }
    if (offset === bytes.length) await raw.delete(identity, current.version, signal)
  } finally { current.stream.destroy() }
}

async function putPlaintext(raw: RawObjectStorage, identity: string, bytes: Buffer, mode: () => Promise<StorageEncryptionState | null>): Promise<null> {
  try {
    await raw.put(identity, bytes, AbortSignal.timeout(STORAGE_WRITE_MS))
    if (!await mode()) return null
    throw new Error('Storage encryption was enabled during upload; retry the upload')
  } catch (err) {
    try { await discardPlaintextWrite(raw, identity, bytes) }
    catch (cleanup) { throw new AggregateError([err, cleanup], 'Storage write and plaintext cleanup failed', { cause: cleanup }) }
    throw err
  }
}

async function decryptOwned(stored: RawObject, key: StorageKey, type: StorageRowKind, row: StorageRow, identity: string) {
  let dataKey: Buffer | undefined
  try {
    dataKey = unwrapDataKey(key, type, row)
    return await decryptStorageStream(stored.stream, dataKey, identity)
  } catch (err) { stored.stream.destroy(); throw err }
  finally { dataKey?.fill(0) }
}

async function openEncrypted(raw: RawObjectStorage, db: StorageDb, key: StorageKey, identity: string, state: StorageEncryptionState): ReturnType<ObjectStorage['open']> {
  const owner = storageOwner(identity)
  if (!owner) {
    if (!identity.startsWith('uploads/')) throw new Error('Unknown managed storage owner')
    const stored = await raw.open(identity)
    if (!stored) return null
    const inspected = await inspectStorageObject(stored)
    if (inspected.encrypted) return decryptStorageStream(inspected.stream, key.bytes, identity)
    if (stored.modifiedAt <= state.enabledAt && Date.now() < state.enabledAt + STORAGE_UPLOAD_TTL_MS) return inspected
    inspected.stream.destroy()
    throw new Error('Unexpected plaintext upload part')
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await db.getStorageRow(owner.type, owner.id)
    if (!row) return null
    if (!owner.cache && !storageRowPaths(owner.type, row).includes(identity)) return null
    if (owner.cache && !row.dataKey) return null
    if (!owner.cache && !row.encrypted) state = (await db.getStorageEncryption())!
    const stored = await raw.open(owner.cache ? encryptedCachePath(identity) : identity)
    if (!stored) return null
    // Completed uploads and all new caches are always encrypted. Only legacy
    // pending rows need header inspection and hash-verified plaintext fallback.
    if (row.encrypted || owner.cache || state.complete) {
      return decryptOwned(stored, key, owner.type, row, identity)
    }
    let inspected = await inspectStorageObject(stored)
    if (inspected.encrypted && !row.dataKey && (await db.getStorageRow(owner.type, owner.id))?.dataKey) {
      inspected.stream.destroy(); continue
    }
    if (inspected.encrypted && row.dataKey) {
      try { return await decryptOwned(inspected, key, owner.type, row, identity) }
      catch {
        // An arbitrary legacy upload can begin with our magic bytes. Only
        // its original SQL hash can authorize that plaintext interpretation.
        const legacy = await openObjectVersion(raw, identity, stored.version)
        if (!legacy) continue
        inspected = { ...legacy, encrypted: false }
      }
    }
    // Only a pending row may read plaintext, and only the original upload.
    // Verify first, then reopen that exact version before exposing bytes.
    await verifyStoragePayload(owner.type, row, inspected.stream, undefined, identity)
    const current = await openObjectVersion(raw, identity, stored.version)
    if (current) return current
  }
  throw new Error('Storage changed repeatedly during read')
}

async function verifyReportConversion(db: StorageDb, identity: string, bytes: Buffer): Promise<string> {
  const owner = storageOwner(identity)
  if (owner?.type !== 'report' || owner.cache || identity !== `reports/${owner.id}.br`) throw new Error('Invalid report conversion')
  const row = await db.getStorageRow('report', owner.id)
  if (!row) throw new Error('Report deleted during compression')
  // Representation changes must preserve the immutable upload hash.
  await verifyStoragePayload('report', row, Readable.from([bytes]), undefined, identity)
  return owner.id
}

async function finishReportConversion(raw: RawObjectStorage, db: StorageDb, id: string, encrypted: boolean): Promise<void> {
  const row = await db.getStorageRow('report', id)
  if (!row) { await raw.delete(`reports/${id}.br`); throw new Error('Report deleted during compression') }
  // Conversion preserves the original row/key. Keep the original until the
  // compressed PUT has succeeded, and mark encrypted only after removing it.
  await raw.delete(`reports/${id}`)
  if (encrypted) await db.markStorageEncrypted('report', id, row.dataKey!)
}

async function existingReportConversion(raw: RawObjectStorage, identity: string, row: StorageRow, key: StorageKey | null,
  encryptedMode: boolean): Promise<{ version: string; encrypted: boolean } | null> {
  const stored = await raw.open(identity)
  if (!stored) return null
  const inspected = await inspectStorageObject(stored)
  // Activation or a concurrent key allocation can win after the SQL read.
  // Retry with fresh policy/row state before interpreting any ciphertext.
  if (inspected.encrypted && (!encryptedMode || !row.dataKey)) {
    inspected.stream.destroy()
    return { version: stored.version, encrypted: true }
  }
  const source = inspected.encrypted ? await decryptOwned(inspected, key!, 'report', row, identity) : inspected
  await verifyStoragePayload('report', row, source.stream, undefined, identity)
  return { version: stored.version, encrypted: inspected.encrypted }
}

async function publishReportConversion(raw: RawObjectStorage, identity: string, bytes: Buffer, row: StorageRow,
  key: StorageKey | null, expected: string | null, encrypted: boolean): Promise<boolean> {
  if (!encrypted) return raw.put(identity, bytes, AbortSignal.timeout(STORAGE_WRITE_MS), expected)
  const dataKey = unwrapDataKey(key!, 'report', row)
  const source = encryptStorageStream(Readable.from([bytes]), dataKey, identity, bytes.length)
  try { return await raw.put(identity, source, AbortSignal.timeout(STORAGE_WRITE_MS), expected, bytes.length) }
  finally { source.destroy(); dataKey.fill(0) }
}

async function convertStoredReport(raw: RawObjectStorage, db: StorageDb, key: StorageKey | null, identity: string, bytes: Buffer,
  mode: (fresh?: boolean) => Promise<StorageEncryptionState | null>): Promise<null> {
  const id = await verifyReportConversion(db, identity, bytes)
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await mode(true)
    const row = state ? await db.ensureStorageDataKey('report', id) : await db.getStorageRow('report', id)
    if (!row) throw new Error('Report deleted during compression')
    const current = await existingReportConversion(raw, identity, row, key, Boolean(state))
    if (current?.encrypted && (!state || !row.dataKey)) continue
    // A stale plaintext writer must never replace a concurrent encrypted
    // winner. Retain the original on uncertain writes; the next open resumes.
    if ((!current || state && !current.encrypted) &&
      !await publishReportConversion(raw, identity, bytes, row, key, current?.version ?? null, Boolean(state))) continue
    if (!state && await mode(true)) continue
    await raw.sync?.(identity)
    await finishReportConversion(raw, db, id, Boolean(state))
    return null
  }
  throw new Error('Report changed repeatedly during compression')
}

// Startup enables encryption before constructing stores; validate the persisted
// requirement even when this adapter is opened without a key.
async function storagePolicy(db: StorageDb, key: StorageKey | null) {
  let enabled = await db.getStorageEncryption()
  let checkedAt = Date.now()
  return async (fresh = false) => {
    // Enabled is irreversible. Keyless instances cache "off" briefly, while
    // writes and detected ciphertext always recheck the activation fence.
    if (!enabled && (fresh || key || Date.now() - checkedAt >= STORAGE_DISABLED_TTL_MS)) {
      const state = await db.getStorageEncryption()
      if (state) enabled = state // A delayed disabled read cannot undo "on".
      checkedAt = Date.now()
    }
    if (enabled && !key) throw new Error('Managed storage requires its configured encryption key')
    return enabled
  }
}

export async function createEncryptedObjectStorage(raw: RawObjectStorage, db: StorageDb, key: StorageKey | null): Promise<ObjectStorage> {
  const mode = await storagePolicy(db, key)
  async function open(identity: string): ReturnType<ObjectStorage['open']> {
    logicalKey(identity)
    const state = await mode()
    if (identity.startsWith('avatars/')) return raw.open(identity)
    if (state) return openEncrypted(raw, db, key!, identity, state)
    const stored = await raw.open(identity)
    if (!stored) return null
    const inspected = await inspectStorageObject(stored)
    // Activation/migration can win after the disabled-state read. Never send
    // that ciphertext to a caller expecting the original plaintext bytes.
    if (inspected.encrypted) {
      let current: StorageEncryptionState | null
      try { current = await mode(true) } catch (err) { inspected.stream.destroy(); throw err }
      if (current) { inspected.stream.destroy(); return openEncrypted(raw, db, key!, identity, current) }
    }
    return inspected
  }
  return {
    open,
    get: async identity => readBytes(await open(identity)),
    async exists(identity) {
      logicalKey(identity)
      const owner = storageOwner(identity), state = await mode()
      if (state && owner) {
        const row = await db.getStorageRow(owner.type, owner.id)
        if (!row || (owner.cache ? !row.dataKey : !storageRowPaths(owner.type, row).includes(identity))) return false
      }
      // Existence is metadata only; open() authenticates the actual bytes.
      return await raw.head(state && owner?.cache ? encryptedCachePath(identity) : identity) !== null
    },
    async put(identity, bytes, { replaceReport = false } = {}) {
      logicalKey(identity)
      if (replaceReport) return convertStoredReport(raw, db, key, identity, bytes, mode)
      const state = await mode()
      const owner = storageOwner(identity)
      if (identity.startsWith('avatars/')) { await raw.put(identity, bytes); return null }
      if (!state) return putPlaintext(raw, identity, bytes, () => mode(true))
      let dataKey: Buffer, wrapped: string | null = null
      if (owner?.cache) {
        const row = await db.ensureStorageDataKey(owner.type, owner.id)
        if (!row) throw new Error('Cache owner unavailable')
        dataKey = unwrapDataKey(key!, owner.type, row)
      } else if (owner) {
        if (await db.getStorageRow(owner.type, owner.id)) throw new Error('Stored payloads are immutable')
        dataKey = randomBytes(32)
        wrapped = wrapStorageValue(key!, dataKeyIdentity(owner.type, owner.id), dataKey)
      } else {
        if (!identity.startsWith('uploads/')) throw new Error('Unknown managed storage owner')
        dataKey = Buffer.from(key!.bytes)
      }
      const target = owner?.cache ? encryptedCachePath(identity) : identity
      const encrypted = encryptStorageStream(Readable.from([bytes]), dataKey, identity, bytes.length)
      try {
        await raw.put(target, encrypted, AbortSignal.timeout(STORAGE_WRITE_MS), undefined, bytes.length)
        // A late cache builder must not leave a readable cache for a deleted
        // bundle. The missing SQL key also makes failed cleanup unreadable.
        if (owner?.cache && !await db.getStorageRow(owner.type, owner.id)) await raw.delete(target)
        return wrapped
      } finally { encrypted.destroy(); dataKey.fill(0) }
    },
    async delete(identity) {
      logicalKey(identity)
      await mode()
      // Always remove both generations, including caches predating activation
      // when migration is disabled or another instance has just enabled it.
      for (const target of deletionPaths(identity)) await raw.delete(target)
    },
    async deletePrefix(prefix) {
      logicalKey(`${prefix}validate`)
      if (!prefix.endsWith('/')) throw new Error('Invalid storage prefix')
      await mode()
      const signal = AbortSignal.timeout(STORAGE_WRITE_MS)
      for (const target of deletionPaths(prefix)) {
        await deleteObjects(raw, target, signal)
        await raw.prune?.(target, signal)
      }
    },
  }
}
