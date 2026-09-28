import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { type StorageKey, decryptStorageStream, encryptStorageStream } from '../server-common/storage-crypto.ts'
import { ENCRYPTED_PREFIX, type ObjectStorage, type RawObjectStorage, objectPath } from './object-storage.ts'
import type { StorageDb } from './storage-db.ts'

// A candidate can only be published during this interval. GC's 24-hour grace
// is deliberately much longer, so it cannot collect a publishable candidate.
export const STORAGE_WRITE_MS = 180_000
export const STORAGE_GC_MS = 86_400_000

function encryptedIdentity(identity: string, objectKey: string): string {
  // Bind both the logical object and its immutable generation. Replaying an
  // older ciphertext at the current physical path must not roll content back.
  return JSON.stringify([identity, objectKey])
}

export function logicalKey(key: string): string {
  objectPath(key)
  if (key.startsWith(ENCRYPTED_PREFIX)) throw new Error('Encrypted objects are internal')
  return key
}

async function readBytes(stored: Awaited<ReturnType<ObjectStorage['open']>>): Promise<Buffer | null> {
  if (!stored) return null
  const parts: Buffer[] = []
  try { for await (const part of stored.stream) parts.push(Buffer.from(part)); return Buffer.concat(parts) }
  finally { stored.stream.destroy() }
}

export async function stageEncrypted(raw: RawObjectStorage, key: StorageKey, identity: string,
  source: Readable, size: number | null, signal: AbortSignal) {
  const objectKey = `${ENCRYPTED_PREFIX}${randomUUID()}`
  const hash = createHash('sha256')
  async function* measured() {
    try { for await (const chunk of source) { hash.update(chunk); yield chunk } }
    finally { source.destroy() }
  }
  const measuredStream = Readable.from(measured(), { objectMode: false })
  measuredStream.once('close', () => source.destroy())
  const encrypted = encryptStorageStream(measuredStream, key, encryptedIdentity(identity, objectKey), size)
  try {
    await raw.put(objectKey, encrypted, signal)
    return { objectKey, digest: hash.digest('hex') }
  } catch (err) {
    // No SQL publication has been attempted yet. Cleanup is safe even when a
    // timed-out PUT actually completed. Unknown SQL commit outcomes differ.
    await raw.delete(objectKey).catch(() => {})
    throw err
  } finally { encrypted.destroy(); measuredStream.destroy(); source.destroy() }
}

export async function verifyEncrypted(raw: RawObjectStorage, key: StorageKey, identity: string,
  objectKey: string, digest: string, signal: AbortSignal): Promise<void> {
  const stored = await raw.open(objectKey, signal)
  if (!stored) throw new Error('Encrypted candidate unavailable')
  const decoded = await decryptStorageStream(stored.stream, key, encryptedIdentity(identity, objectKey))
  const hash = createHash('sha256')
  try { for await (const part of decoded.stream) hash.update(part) }
  finally { decoded.stream.destroy() }
  if (hash.digest('hex') !== digest) throw new Error('Encrypted candidate verification failed')
}

export async function removeLegacy(raw: RawObjectStorage, identity: string): Promise<void> {
  const stored = await raw.open(identity)
  if (!stored) return
  stored.stream.destroy()
  if (!await raw.delete(identity, stored.version)) throw new Error('Legacy storage changed during encryption migration')
}

export async function removeLegacyPrefix(raw: RawObjectStorage, prefix: string): Promise<void> {
  // Restart from the beginning after deleting a page. Offset-based listings
  // must not skip objects when earlier entries disappear.
  for (;;) {
    const page = await raw.list(prefix, null, 100)
    if (page.objects.length === 0) return
    for (const object of page.objects) await removeLegacy(raw, object.key)
  }
}

export async function createEncryptedObjectStorage(raw: RawObjectStorage, db: StorageDb, key: StorageKey | null): Promise<ObjectStorage> {
  await db.initializeStorageEncryption(key?.id ?? null)
  if (!key) return plainStorage(raw, db)
  const activeKey = key
  async function open(identity: string) {
    logicalKey(identity)
    for (let attempt = 0; attempt < 3; attempt++) {
      const ref = await db.getStorageReference(activeKey.id, identity)
      if (!ref.objectKey && !ref.legacy) return null
      const stored = await raw.open(ref.objectKey ?? identity)
      if (stored) return ref.objectKey ? decryptStorageStream(stored.stream, activeKey, encryptedIdentity(identity, ref.objectKey)) : stored
      // Migration may publish and remove plaintext between the reference read
      // and raw open. Likewise, GC may collect a replaced immutable version.
      const current = await db.getStorageReference(activeKey.id, identity)
      if (current.revision !== ref.revision) continue
      if (ref.objectKey) throw new Error('Encrypted storage object unavailable')
      return null
    }
    throw new Error('Storage object repeatedly changed during read')
  }
  return {
    open,
    get: async identity => readBytes(await open(identity)),
    async exists(identity) {
      logicalKey(identity)
      const ref = await db.getStorageReference(key.id, identity)
      if (!ref.objectKey) {
        if (!ref.legacy) return false
        if (await raw.exists(identity)) return true
        const current = await db.getStorageReference(key.id, identity)
        return current.objectKey ? raw.exists(current.objectKey) : false
      }
      if (!await raw.exists(ref.objectKey)) throw new Error('Encrypted storage object unavailable')
      return true
    },
    async put(identity, bytes) {
      logicalKey(identity)
      const snapshot = await db.getStorageReference(key.id, identity)
      const deadline = Date.now() + STORAGE_WRITE_MS
      const candidate = await stageEncrypted(raw, key, identity, Readable.from([bytes]), bytes.length, AbortSignal.timeout(STORAGE_WRITE_MS))
      // On an ambiguous commit failure retain the ciphertext. GC will check
      // references later; deleting it here could destroy a successful write.
      const published = await db.publishStorageObject(key.id, identity, snapshot.revision,
        candidate.objectKey, candidate.digest, deadline, false)
      if (published) return
      await raw.delete(candidate.objectKey)
      const current = await db.getStorageReference(key.id, identity)
      if (current.objectKey && current.digest === candidate.digest) return
      throw new Error('Storage object changed during write')
    },
    async delete(identity) {
      logicalKey(identity)
      await db.deleteStorageObject(key.id, identity, false)
      await removeLegacy(raw, identity)
    },
    async deletePrefix(prefix) {
      logicalKey(`${prefix}validate`)
      if (!prefix.endsWith('/')) throw new Error('Invalid storage prefix')
      await db.deleteStorageObject(key.id, prefix, true)
      await removeLegacyPrefix(raw, prefix)
    },
  }
}

function plainStorage(raw: RawObjectStorage, db: StorageDb): ObjectStorage {
  async function check(identity: string) { logicalKey(identity); await db.getStorageEncryption(null) }
  async function open(identity: string) { await check(identity); return raw.open(identity) }
  return {
    open,
    get: async identity => readBytes(await open(identity)),
    async exists(identity) { await check(identity); return raw.exists(identity) },
    async put(identity, bytes) { await check(identity); await raw.put(identity, bytes) },
    async delete(identity) { await check(identity); await raw.delete(identity) },
    async deletePrefix(prefix) { await check(`${prefix}validate`); await removeLegacyPrefix(raw, prefix) },
  }
}
