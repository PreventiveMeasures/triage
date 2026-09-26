// Metadata is cached as Brotli. Contents use the stored Brotli bytes directly:
// unchanged Stasis uploads or sourcemaps compressed once at upload.
import { Buffer } from 'node:buffer'
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { brotliDecompress } from 'node:zlib'
import { promisify } from 'node:util'
import { BUNDLE_METADATA_VERSION, createBundleMetadata, parseBundleContents } from '../common/bundle-metadata.js'
import { decodeUtf8 } from '../common/utf8.js'
import type { OpenedBlob } from './blob-store.ts'
import type { BundleStore } from './bundle-store.ts'
import { encodeBrotli } from './brotli.ts'
import type { ManagedBundle, ManagedDb } from './db.ts'

const decompress = promisify(brotliDecompress)
const MAX_DECODED_BYTES = 512 * 1024 * 1024
export type BundleCachePart = 'metadata' | 'contents'

export async function readBundleDetails(record: ManagedBundle, store: BundleStore) {
  const bytes = await store.get(record.id, record.kind)
  if (!bytes) return null
  const decoded = record.kind === 'stasis' || record.kind === 'sourcemap' ? await decompress(bytes, { maxOutputLength: MAX_DECODED_BYTES }) : bytes
  if (decoded.length > MAX_DECODED_BYTES) throw new Error('Decoded bundle too large')
  return parseBundleContents(decodeUtf8(decoded), { integrity: record.integrity, kind: record.kind, size: record.byteSize })
}

export interface BundleCacheStorage {
  exists(id: string, file: string): Promise<boolean>
  put(id: string, file: string, bytes: Buffer): Promise<void>
  open(id: string, file: string): Promise<OpenedBlob>
  // Remove all cached versions for this bundle, including legacy derivatives.
  delete(id: string): Promise<void>
}

const filename = `v${BUNDLE_METADATA_VERSION}-metadata.json.br`

export function createBundleCache(storage: BundleCacheStorage, db: ManagedDb, store: BundleStore) {
  const pending = new Map<string, Promise<void>>()
  let queue = Promise.resolve()
  async function build(record: ManagedBundle) {
    const details = await readBundleDetails(record, store)
    if (!details) throw new Error('Bundle bytes unavailable')
    const metadata = { ...await createBundleMetadata(details), id: record.id, filename: record.filename }
    const body = await encodeBrotli(Buffer.from(JSON.stringify(metadata)))
    if (!(await db.getBundle(record.id))) throw new Error('Bundle deleted')
    await storage.put(record.id, filename, body)
    // A different instance may have deleted the row while these writes ran.
    // Reconcile after publishing so its cleanup cannot be undone by us.
    if (!(await db.getBundle(record.id))) {
      await storage.delete(record.id)
      throw new Error('Bundle deleted')
    }
  }
  async function ensure(record: ManagedBundle): Promise<void> {
    const existing = pending.get(record.id)
    if (existing) return existing
    const job = (async () => {
      if (await storage.exists(record.id, filename)) return
      const work = queue.then(() => build(record))
      queue = work.catch(() => {})
      await work
    })()
    pending.set(record.id, job)
    try { await job } finally { if (pending.get(record.id) === job) pending.delete(record.id) }
  }
  return {
    prebuild: ensure,
    async open(record: ManagedBundle, part: BundleCachePart) {
      if (part === 'contents') {
        if (record.kind !== 'stasis' && record.kind !== 'sourcemap') throw new Error('Unsupported bundle')
        const stored = await store.open(record.id, record.kind)
        if (!stored) throw new Error('Bundle bytes unavailable')
        return stored
      }
      await ensure(record)
      return storage.open(record.id, filename)
    },
    async delete(id: string) {
      // Call after deleting the row. Waiting prevents an in-flight builder
      // from recreating its files after deletion has completed.
      await pending.get(id)?.catch(() => {})
      await storage.delete(id)
    },
  }
}
export type BundleCache = ReturnType<typeof createBundleCache>

export function createDiskBundleCache(dir: string, db: ManagedDb, store: BundleStore): BundleCache {
  function directory(id: string) {
    if (!/^[a-f\d-]{36}$/iu.test(id)) throw new Error('Invalid bundle id')
    return join(dir, id)
  }
  return createBundleCache({
    async exists(id, file) {
      try { await stat(join(directory(id), file)); return true }
      catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw err }
    },
    async put(id, file, bytes) {
      await mkdir(directory(id), { recursive: true })
      const target = join(directory(id), file), temp = `${target}.${randomUUID()}.tmp`
      try { await writeFile(temp, bytes); await rename(temp, target) }
      finally { await rm(temp, { force: true }) }
    },
    async open(id, name) {
      const file = await open(join(directory(id), name), 'r')
      try { return { size: (await file.stat()).size, stream: file.createReadStream() } }
      catch (err) { await file.close(); throw err }
    },
    async delete(id) { await rm(directory(id), { recursive: true, force: true }) },
  }, db, store)
}
