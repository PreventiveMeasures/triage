// Metadata is cached as Brotli. Contents use the stored Brotli bytes directly:
// unchanged Stasis uploads or sourcemaps compressed once at upload.
import { Buffer } from 'node:buffer'
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { brotliDecompress } from 'node:zlib'
import { promisify } from 'node:util'
import { BUNDLE_METADATA_VERSION, type BundleDetails, createBundleMetadata, createBundleSummary, parseBundleContents } from '../common/bundle-metadata.js'
import { bundleReasons } from '../common/bundle-reasons.js'
import { bundlePackageVersions } from '../common/bundle-sources.js'
import { decodeUtf8 } from '../common/utf8.js'
import type { OpenedBlob } from './blob-store.ts'
import type { BundleStore } from './bundle-store.ts'
import { encodeBrotli } from './brotli.ts'
import type { ManagedBundle, ManagedDb } from './db.ts'

const decompress = promisify(brotliDecompress)
const MAX_DECODED_BYTES = 512 * 1024 * 1024
export const MAX_PACKAGE_INVENTORY_BYTES = 1024 * 1024
export type BundleCachePart = 'metadata' | 'contents'
type BundleCacheRecord = Pick<ManagedBundle, 'id' | 'integrity' | 'filename' | 'kind' | 'byteSize'>
export interface BundleSummary { files: number; codeFiles: number; lines: number }

export async function readBundleDetails(record: BundleCacheRecord, store: BundleStore) {
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
const packagesFilename = 'v2-package-versions.json'
const summaryFilename = `v${BUNDLE_METADATA_VERSION}-summary.json`

// All scopes share one bounded derivative. Never decode full bundle metadata
// on advisory requests, including when selecting a reason. Persist null when
// the combined inventory exceeds the budget, without disabling metadata.
function encodePackageInventory(details: BundleDetails): Buffer {
  const parts: string[] = []
  let size = 0
  function append(part: string) {
    size += Buffer.byteLength(part)
    if (size > MAX_PACKAGE_INVENTORY_BYTES) return false
    parts.push(part)
    return true
  }
  function inventory(paths: Set<string> | null) {
    if (!append('{')) return false
    let first = true
    for (const [name, versions] of bundlePackageVersions(details, paths)) {
      if (!append(`${first ? '' : ','}${JSON.stringify(name)}:${JSON.stringify([...versions].toSorted())}`)) return false
      first = false
    }
    return append('}')
  }
  append('{"all":')
  if (!inventory(null) || !append(',"reasons":{')) return Buffer.from('null')
  let first = true
  for (const [reason, paths] of bundleReasons(details)) {
    if (!append(`${first ? '' : ','}${JSON.stringify(reason)}:`) || !inventory(paths)) return Buffer.from('null')
    first = false
  }
  if (!append('}}')) return Buffer.from('null')
  return Buffer.from(parts.join(''))
}

async function readSummary(storage: BundleCacheStorage, id: string): Promise<BundleSummary> {
  const cached = await storage.open(id, summaryFilename)
  try {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of cached.stream) {
      size += chunk.length
      if (size > 1024) throw new Error('Invalid bundle summary')
      chunks.push(Buffer.from(chunk))
    }
    const summary = JSON.parse(decodeUtf8(Buffer.concat(chunks))) as BundleSummary
    if (!summary || ![summary.files, summary.codeFiles, summary.lines].every(value => Number.isSafeInteger(value) && value >= 0)
        || summary.codeFiles > summary.files) throw new Error('Invalid bundle summary')
    return summary
  } finally { cached.stream.destroy() }
}

async function build(record: BundleCacheRecord, storage: BundleCacheStorage, db: ManagedDb, store: BundleStore) {
  const details = await readBundleDetails(record, store)
  if (!details) throw new Error('Bundle bytes unavailable')
  const metadata = { ...await createBundleMetadata(details), id: record.id, filename: record.filename }
  const body = await encodeBrotli(Buffer.from(JSON.stringify(metadata)))
  if (!(await db.getBundle(record.id))) throw new Error('Bundle deleted')
  await storage.put(record.id, filename, body)
  if (record.kind === 'stasis') await storage.put(record.id, packagesFilename, encodePackageInventory(details))
  await storage.put(record.id, summaryFilename, Buffer.from(JSON.stringify(createBundleSummary(details, metadata))))
  // A different instance may have deleted the row while these writes ran.
  // Reconcile after publishing so its cleanup cannot be undone by us.
  if (!(await db.getBundle(record.id))) {
    await storage.delete(record.id)
    throw new Error('Bundle deleted')
  }
}

export function createBundleCache(storage: BundleCacheStorage, db: ManagedDb, store: BundleStore) {
  const pending = new Map<string, Promise<void>>()
  // The database deduplicates by integrity, so each hash has one persistent
  // bundle/cache directory, shared across teams and repeated uploads.
  const summaries = new Map<string, { id: string; summary: BundleSummary }>()
  let queue = Promise.resolve()
  async function ensure(record: BundleCacheRecord): Promise<void> {
    const existing = pending.get(record.id)
    if (existing) return existing
    const job = (async () => {
      if (await storage.exists(record.id, filename) && await storage.exists(record.id, summaryFilename)
          && (record.kind !== 'stasis' || await storage.exists(record.id, packagesFilename))) return
      const work = queue.then(() => build(record, storage, db, store))
      queue = work.catch(() => {})
      await work
    })()
    pending.set(record.id, job)
    try { await job } finally { if (pending.get(record.id) === job) pending.delete(record.id) }
  }
  return {
    prebuild: ensure,
    async summary(record: BundleCacheRecord): Promise<BundleSummary | null> {
      if (record.kind !== 'stasis' && record.kind !== 'sourcemap') return null
      const known = summaries.get(record.integrity)
      if (known) return known.summary
      await ensure(record)
      const summary = await readSummary(storage, record.id)
      if (summaries.size >= 256) summaries.delete(summaries.keys().next().value!)
      summaries.set(record.integrity, { id: record.id, summary })
      return summary
    },
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
    async packageVersions(record: ManagedBundle, reason = ''): Promise<Record<string, string[]> | null | undefined> {
      if (record.kind !== 'stasis') return {}
      await ensure(record)
      const cached = await storage.open(record.id, packagesFilename)
      try {
        if (cached.size != null && cached.size > MAX_PACKAGE_INVENTORY_BYTES) return null
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of cached.stream) {
          size += chunk.length
          if (size > MAX_PACKAGE_INVENTORY_BYTES) return null
          chunks.push(Buffer.from(chunk))
        }
        const inventory = JSON.parse(decodeUtf8(Buffer.concat(chunks)))
        if (inventory === null) return null
        return reason ? (Object.hasOwn(inventory.reasons, reason) ? inventory.reasons[reason] : undefined) : inventory.all
      } finally { cached.stream.destroy() }
    },
    async delete(id: string) {
      // Call after deleting the row. Waiting prevents an in-flight builder
      // from recreating its files after deletion has completed.
      await pending.get(id)?.catch(() => {})
      for (const [hash, entry] of summaries) if (entry.id === id) summaries.delete(hash)
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
