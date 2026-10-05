import type { Buffer } from 'node:buffer'
import { type StorageKey, decryptStorageStream, encryptStorageStream } from '../server-common/storage-crypto.ts'
import { ENCRYPTED_CACHE_PREFIX, type RawObjectStorage, deleteObjects, isBlobId, openObjectVersion } from './object-storage.ts'
import { type StorageDb, type StorageEncryptionState, type StorageMigrationRow, type StorageRow, type StorageRowKind, unwrapDataKey } from './storage-db.ts'
import { STORAGE_UPLOAD_TTL_MS } from './storage-encryption.ts'
import { StoragePayloadError, inspectStorageObject, storageOwner, storageRowPaths, verifiedStoragePayload, verifyStoragePayload } from './storage-payload.ts'

async function replacementFailure(raw: RawObjectStorage, identity: string, version: string, signal: AbortSignal): Promise<string> {
  const format = (value: string) => value.startsWith('W/') ? 'weak' : value.startsWith('"') && value.endsWith('"') ? 'quoted' : 'unquoted'
  const reason = `Conditional replacement rejected (object version precondition failed); download=${format(version)}`
  // Diagnose only failed writes. A metadata read cannot authorize a retry with
  // a different version: the downloaded bytes must remain bound to their own.
  let current
  try { current = await raw.head(identity, signal) }
  catch { return `${reason}; metadata=unavailable` }
  if (!current) return `${reason}; metadata=missing`
  // Normalization is diagnostic only. Never use it for conditional writes or
  // log the actual ETags, which can contain hashes of private payloads.
  const value = (tag: string) => tag.replace(/^W\//u, '').replace(/^"(.*)"$/u, '$1')
  const comparison = current.version === version ? 'same' : value(current.version) === value(version) ? 'format-only' : 'different'
  return `${reason}; metadata=${format(current.version)}; comparison=${comparison}`
}

type MigrationPhase = 'prepare-key' | 'open-payload' | 'verify-existing' | 'encrypt-upload' | 'verify-replacement' | 'checkpoint'
async function migratePayload(raw: RawObjectStorage, db: StorageDb, type: StorageRowKind, row: StorageRow,
  dataKey: Buffer, identity: string, signal: AbortSignal, progress: (phase: MigrationPhase) => void): Promise<boolean | string | null> {
  progress('open-payload')
  const source = await raw.open(identity, signal)
  if (!source) return false
  let inspected = await inspectStorageObject(source)
  if (inspected.encrypted) {
    progress('verify-existing')
    // A previous PUT may have completed before a timeout or lost SQL ack.
    try {
      const decoded = await decryptStorageStream(inspected.stream, dataKey, identity)
      await verifyStoragePayload(type, row, decoded.stream, signal, identity)
    } catch {
      signal.throwIfAborted()
      // Legacy arbitrary bytes can share the magic prefix. A matching
      // original upload hash is required before encrypting them as plaintext.
      const legacy = await openObjectVersion(raw, identity, source.version, signal)
      if (!legacy) return 'Payload disappeared or changed version before plaintext verification'
      inspected = { ...legacy, encrypted: false }
    }
  }
  if (!inspected.encrypted) {
    progress('encrypt-upload')
    signal.throwIfAborted()
    const verified = verifiedStoragePayload(type, row, inspected.stream, signal, identity)
    const encrypted = encryptStorageStream(verified, dataKey, identity, inspected.size)
    let replaced: boolean
    try { replaced = await raw.put(identity, encrypted, signal, source.version, inspected.size ?? undefined) }
    // A provider may wrap a request-body error; keep safe payload diagnostics.
    catch (err) { throw verified.errored ?? err }
    finally { encrypted.destroy(); verified.destroy(); inspected.stream.destroy(); source.stream.destroy() }
    if (!replaced) return await replacementFailure(raw, identity, source.version, signal)
    // Do not mark the row encrypted until the stored bytes authenticate and
    // match the original upload (including Brotli decompression).
    progress('verify-replacement')
    const replacement = await raw.open(identity, signal)
    if (!replacement) {
      if (!await db.getStorageRow(type, row.id)) return null
      throw new StoragePayloadError('Migrated payload unavailable')
    }
    const decoded = await decryptStorageStream(replacement.stream, dataKey, identity)
    await verifyStoragePayload(type, row, decoded.stream, signal, identity)
  }
  signal.throwIfAborted()
  // Persist observed replacements, including both report representations
  // if they coexist, before marking the whole row encrypted.
  progress('checkpoint')
  await raw.sync?.(identity, signal)
  return true
}

async function migrateRow(raw: RawObjectStorage, db: StorageDb, key: StorageKey, item: StorageMigrationRow, signal: AbortSignal,
  progress: (phase: MigrationPhase) => void): Promise<string | void> {
  if (item.type === 'user') { await db.migrateStorageUserTokens(item.id); return }
  progress('prepare-key')
  const row = await db.ensureStorageDataKey(item.type, item.id)
  if (!row || row.encrypted) return
  const dataKey = unwrapDataKey(key, item.type, row)
  try {
    let found = false
    for (const identity of storageRowPaths(item.type, row)) {
      const result = await migratePayload(raw, db, item.type, row, dataKey, identity, signal, progress)
      if (result === null) return
      if (typeof result === 'string') return result
      found ||= result
    }
    if (!found) {
      if (!await db.getStorageRow(item.type, item.id)) return
      throw new StoragePayloadError('Migration payload unavailable')
    }
    signal.throwIfAborted()
    await db.markStorageEncrypted(item.type, item.id, row.dataKey!)
  } finally { dataKey.fill(0) }
}

const CLEANUP_PREFIXES = ['cache/', 'reports/', 'bundles/', ENCRYPTED_CACHE_PREFIX]
function cleanupPosition(state: StorageEncryptionState): { prefix: number; cursor: string | null } {
  const value = state.cleanupCursor === null ? { prefix: 0, cursor: null } : JSON.parse(state.cleanupCursor)
  if (!Number.isInteger(value.prefix) || value.prefix < 0 || value.prefix >= CLEANUP_PREFIXES.length
    || (value.cursor !== null && typeof value.cursor !== 'string')) throw new Error('Invalid legacy cleanup cursor')
  return value
}

// The database directory may be shared. Recognize managed paths, including
// disk atomic-write temps, before treating any listed file as ours to remove.
function cleanupTarget(identity: string) {
  const temp = /^(.+)\.([^.]+)\.tmp$/u.exec(identity)
  const temporary = !!temp && isBlobId(temp[2]!)
  const path = temporary ? temp![1]! : identity
  const encryptedCache = path.startsWith(ENCRYPTED_CACHE_PREFIX)
  if (encryptedCache && !temporary) return null
  const owner = storageOwner(encryptedCache ? `cache/${path.slice(ENCRYPTED_CACHE_PREFIX.length)}` : path)
  return owner ? { owner, temporary } : null
}

// Referenced-data migration never depends on Blob listings. A separate bounded
// inventory removes legacy caches and unreferenced plaintext; ciphertext
// orphans do not hold a recoverable data key and need no manifest-based GC.
async function cleanupLegacy(raw: RawObjectStorage, db: StorageDb, state: StorageEncryptionState, limit: number, signal: AbortSignal) {
  const position = cleanupPosition(state), prefix = CLEANUP_PREFIXES[position.prefix]!
  const page = await raw.list(prefix, position.cursor, Math.min(limit, 16), signal)
  let found = 0, retryAt: number | null = null
  for (const object of page.objects) {
    signal.throwIfAborted()
    const target = cleanupTarget(object.key)
    if (!target) continue
    const { owner, temporary } = target
    if (!temporary && !owner.cache) {
      const row = await db.getStorageRow(owner.type, owner.id)
      if (row && storageRowPaths(owner.type, row).includes(object.key)) continue
    }
    const stored = await raw.head(object.key, signal)
    if (!stored) continue
    // A killed disk writer can leave plaintext or ciphertext in its temp file.
    // Recheck its current age and give live writes a full staging grace window.
    if (temporary && stored.modifiedAt > Date.now() - STORAGE_UPLOAD_TTL_MS) {
      found++
      retryAt = Math.min(retryAt ?? Infinity, stored.modifiedAt + STORAGE_UPLOAD_TTL_MS)
      continue
    }
    // Old pre-activation orphans are legacy even when their arbitrary bytes
    // share the magic prefix. Keep a full staging grace window around enable:
    // Blob Last-Modified has only second precision, and a new encrypted upload
    // may still be waiting for its SQL insert.
    let legacy = temporary || owner.cache || stored.modifiedAt < state.enabledAt - STORAGE_UPLOAD_TTL_MS
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
  const next = page.cursor === null ? position.prefix + 1 < CLEANUP_PREFIXES.length ? { prefix: position.prefix + 1, cursor: null } : null
    : { ...position, cursor: page.cursor }
  // A full pass without removals closes offset-pagination gaps left by deletes.
  await db.advanceStorageCleanup(state.cleanupCursor, next === null ? null : JSON.stringify(next), found)
  return { processed: page.objects.length || 1, retryAt }
}

interface StorageMigrationResult extends StorageEncryptionState {
  retryAt: number | null
  failures: { type: StorageMigrationRow['type']; id: string; message: string }[]
}
function rowFailure(row: StorageMigrationRow, message: string) {
  const failure = { type: row.type, id: row.id, message }
  // Emit before continuing: a later failure or terminated invocation must not
  // hide earlier diagnostics. Never include provider errors or storage values.
  console.warn('managed-storage-migration-row:', JSON.stringify(failure))
  return failure
}
interface MigrationOptions { maxObjects?: number; maxMs?: number | undefined; signal?: AbortSignal | undefined }
export async function migrateStorage(raw: RawObjectStorage, db: StorageDb, key: StorageKey,
  { maxObjects = 64, maxMs = 150_000, signal: stopping }: MigrationOptions = {}): Promise<StorageMigrationResult> {
  if (!Number.isSafeInteger(maxObjects) || maxObjects < 1 || !Number.isSafeInteger(maxMs) || maxMs < 1) throw new Error('Invalid migration budget')
  const deadline = Date.now() + maxMs, timeout = AbortSignal.timeout(maxMs)
  const signal = stopping ? AbortSignal.any([stopping, timeout]) : timeout
  const errors: unknown[] = []
  const failures: StorageMigrationResult['failures'] = []
  let processed = 0, retryAt: number | null = null, state = await db.getStorageEncryption()
  if (!state) throw new Error('Storage encryption is not enabled; configure MANAGED_STORAGE_ENCRYPTION_KEY')
  // At most one SQL pass per invocation. Checkpoint each row, including a
  // failure: other rows progress, and the failed row is retried next pass.
  while (!state.complete && processed < maxObjects && Date.now() < deadline && !signal.aborted) {
    const rows = await db.listStorageMigrationRows(state.cursor, Math.min(16, maxObjects - processed))
    if (stopping?.aborted) break
    if (rows.length === 0) { await db.advanceStorageMigration(state.cursor, null); break }
    for (const row of rows) {
      if (Date.now() >= deadline || signal.aborted) break
      console.info('managed-storage-migration-row-start:', JSON.stringify({ type: row.type, id: row.id }))
      const startedAt = Date.now()
      let phase: MigrationPhase | 'tokens' = 'tokens'
      const logPhase = (aborted = false) => console.info('managed-storage-migration-row-phase:', JSON.stringify({
        type: row.type, id: row.id, phase, elapsedMs: Date.now() - startedAt, ...(aborted ? { aborted: true } : {}),
      }))
      // Log directly on cancellation even if an underlying operation stalls
      // while unwinding. These fixed phases contain no object/provider data.
      const aborted = () => logPhase(true)
      signal.addEventListener('abort', aborted, { once: true })
      try {
        const pending = await migrateRow(raw, db, key, row, signal, next => { phase = next; logPhase() })
        if (pending) failures.push(rowFailure(row, pending))
      }
      catch (err) {
        // A row started late gets a full budget next time. Skip an oversized
        // first row until the next pass so later rows and tokens can advance.
        if (stopping?.aborted || (signal.aborted && processed > 0)) break
        const failure = signal.aborted
          ? `Could not migrate ${row.type} ${row.id} within MANAGED_STORAGE_ENCRYPTION_MIGRATE_MAX_MS=${maxMs}; increase the budget`
          : err instanceof StoragePayloadError ? err.message : null
        if (failure === null) {
          rowFailure(row, 'Migration operation failed')
          errors.push(new Error(`Could not migrate ${row.type} ${row.id}`, { cause: err }))
        } else failures.push(rowFailure(row, failure))
      }
      finally { signal.removeEventListener('abort', aborted) }
      if (stopping?.aborted) break
      await db.advanceStorageMigration(state.cursor, row.position)
      processed++
      state = (await db.getStorageEncryption())!
    }
  }
  state = (await db.getStorageEncryption())!
  while (!state.cleanupComplete && processed < maxObjects && Date.now() < deadline && !signal.aborted) {
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
  return { ...state, retryAt, failures }
}

export async function reapStorageUploads(raw: RawObjectStorage, db: StorageDb, now = Date.now(), stopping?: AbortSignal): Promise<number> {
  if (stopping?.aborted) return 0
  const timeout = AbortSignal.timeout(150_000)
  const signal = stopping ? AbortSignal.any([stopping, timeout]) : timeout
  await db.getStorageEncryption()
  try { return await deleteObjects(raw, 'uploads/', signal, now - STORAGE_UPLOAD_TTL_MS) }
  catch (err) { if (stopping?.aborted) return 0; throw err }
}
