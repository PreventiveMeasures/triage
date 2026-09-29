import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { type StorageKey, decryptStorageStream, encryptStorageStream, wrapStorageValue } from '../server-common/storage-crypto.ts'
import { ENCRYPTED_CACHE_PREFIX, type ObjectStorage, type RawObjectStorage, objectPath } from './object-storage.ts'
import { type StorageDb, type StorageEncryptionState, dataKeyIdentity, unwrapDataKey } from './storage-db.ts'
import { inspectStorageObject, storageOwner, storageRowPath, verifyStoragePayload } from './storage-payload.ts'

export const STORAGE_WRITE_MS = 180_000
export const STORAGE_UPLOAD_TTL_MS = 86_400_000

export async function removeLegacyPrefix(raw: RawObjectStorage, prefix: string): Promise<void> {
  for (;;) {
    const page = await raw.list(prefix, null, 100)
    if (page.objects.length === 0) return
    for (const object of page.objects) {
      const stored = await raw.open(object.key)
      if (!stored) continue
      stored.stream.destroy()
      if (!await raw.delete(object.key, stored.version)) throw new Error('Storage changed during deletion')
    }
  }
}
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
    if (!owner.cache && storageRowPath(owner.type, row) !== identity) return null
    if (owner.cache && !row.dataKey) return null
    const stored = await raw.open(owner.cache ? encryptedCachePath(identity) : identity)
    if (!stored) {
      if (!owner.cache && await db.getStorageRow(owner.type, owner.id)) throw new Error('Stored payload unavailable')
      return null
    }
    let inspected = await inspectStorageObject(stored)
    if (inspected.encrypted && !row.dataKey && (await db.getStorageRow(owner.type, owner.id))?.dataKey) {
      inspected.stream.destroy(); continue
    }
    if (inspected.encrypted && row.dataKey) {
      let bytes: Buffer | undefined
      try { bytes = unwrapDataKey(key, owner.type, row); return await decryptStorageStream(inspected.stream, bytes, identity) }
      catch (err) {
        inspected.stream.destroy()
        if (row.encrypted || owner.cache || state.complete) throw err
        // An arbitrary legacy upload can begin with our magic bytes. Only
        // its original SQL hash can authorize that plaintext interpretation.
        const legacy = await raw.open(identity)
        if (!legacy || legacy.version !== stored.version) { legacy?.stream.destroy(); continue }
        inspected = { ...legacy, encrypted: false }
      }
      finally { bytes?.fill(0) }
    }
    if (row.encrypted || owner.cache || state.complete) {
      inspected.stream.destroy()
      throw new Error('Unexpected plaintext storage payload')
    }
    // Only a pending row may read plaintext, and only the original upload.
    // Verify first, then reopen that exact version before exposing bytes.
    await verifyStoragePayload(owner.type, row, inspected.stream)
    const current = await raw.open(identity)
    if (current?.version === stored.version) return current
    current?.stream.destroy()
  }
  throw new Error('Storage changed repeatedly during read')
}

export async function createEncryptedObjectStorage(raw: RawObjectStorage, db: StorageDb, key: StorageKey | null): Promise<ObjectStorage> {
  // Read-only: the CLI's explicit enable command is the sole activation path.
  await db.getStorageEncryption()
  async function mode() {
    const state = await db.getStorageEncryption()
    if (state && !key) throw new Error('Managed storage requires its configured encryption key')
    return state
  }
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
      try { current = await mode() } catch (err) { inspected.stream.destroy(); throw err }
      if (current) { inspected.stream.destroy(); return openEncrypted(raw, db, key!, identity, current) }
    }
    return inspected
  }
  return {
    open,
    get: async identity => readBytes(await open(identity)),
    async exists(identity) { const value = await open(identity); value?.stream.destroy(); return value !== null },
    async put(identity, bytes) {
      logicalKey(identity)
      const state = await mode()
      if (identity.startsWith('avatars/')) { await raw.put(identity, bytes); return null }
      if (!state) {
        await raw.put(identity, bytes)
        try {
          if (!await mode()) return null
          throw new Error('Storage encryption was enabled during upload; retry the upload')
        } catch (err) {
          // A pre-activation write may finish after activation. Remove only
          // plaintext, never a concurrent migration's encrypted replacement.
          const current = await raw.open(identity)
          if (current) {
            const inspected = await inspectStorageObject(current)
            inspected.stream.destroy()
            if (!inspected.encrypted) await raw.delete(identity, current.version)
          }
          throw err
        }
      }
      const owner = storageOwner(identity)
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
        await raw.put(target, encrypted, AbortSignal.timeout(STORAGE_WRITE_MS))
        // A late cache builder must not leave a readable cache for a deleted
        // bundle. The missing SQL key also makes failed cleanup unreadable.
        if (owner?.cache && !await db.getStorageRow(owner.type, owner.id)) await raw.delete(target)
        return wrapped
      } finally { encrypted.destroy(); dataKey.fill(0) }
    },
    async delete(identity) {
      logicalKey(identity)
      const state = await mode()
      await raw.delete(state && identity.startsWith('cache/') ? encryptedCachePath(identity) : identity)
    },
    async deletePrefix(prefix) {
      logicalKey(`${prefix}validate`)
      if (!prefix.endsWith('/')) throw new Error('Invalid storage prefix')
      const state = await mode()
      await removeLegacyPrefix(raw, state && prefix.startsWith('cache/') ? encryptedCachePath(prefix) : prefix)
    },
  }
}
