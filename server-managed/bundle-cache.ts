// Metadata is cached as Brotli. Contents use the stored Brotli bytes directly:
// unchanged Stasis uploads or sourcemaps compressed once at upload.
import { Buffer } from 'node:buffer'
import { brotliDecompress } from 'node:zlib'
import { promisify } from 'node:util'
import { bundleEdges } from '@preventive/sourcemap/edges.js'
import { BUNDLE_METADATA_VERSION, type BundleDetails, createBundleMetadata, createBundleSummary, parseBundleContents } from '../common/bundle-metadata.js'
import { bundleReasons } from '../common/bundle-reasons.js'
import { sourcemapEdges } from '../common/bundle-sourcemap.js'
import { type BundleAdvisoryInventory, bundleAdvisoryInventory } from './bundle-advisory-inventory.ts'
import { decodeUtf8 } from '../common/utf8.js'
import type { OpenedBlob } from './blob-store.ts'
import type { BundleStore } from './bundle-store.ts'
import { encodeBrotli } from './brotli.ts'
import type { ManagedBundle, ManagedDb } from './db.ts'
import { CacheMissError } from './cache-storage.ts'
import { SUMMARY_FILENAME, createBundleSummaryCache } from './bundle-summary-cache.ts'

const decompress = promisify(brotliDecompress)
const MAX_DECODED_BYTES = 512 * 1024 * 1024
export const MAX_PACKAGE_INVENTORY_BYTES = 1024 * 1024
export type BundleCachePart = 'metadata' | 'contents'
export type BundleCacheRecord = Pick<ManagedBundle, 'id' | 'integrity' | 'filename' | 'kind' | 'byteSize'>
export interface BundleSummary { files: number; codeFiles: number; lines: number; commit?: string; stasisVersion?: number; versionedPackages?: number }

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
const packagesFilename = 'v6-advisory-inventory.json'

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
  function entries(rows: unknown[]) {
    if (!append('[')) return false
    let first = true
    for (const row of rows) {
      if (!append(`${first ? '' : ','}${JSON.stringify(row)}`)) return false
      first = false
    }
    return append(']')
  }
  function inventory(paths: Set<string> | null) {
    const { packages, skipped } = bundleAdvisoryInventory(details, paths)
    return append('{"packages":') && entries(packages) && append(',"skipped":') && entries(skipped) && append('}')
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

// What a catalog sends of a bundle before it opens. A Stasis bundle's
// `versionedPackages` counts the name@version pairs its unscoped advisory
// audit covers, audited or skipped: with none, Advisories has nothing to show.
export function bundleSummary(details: BundleDetails, metadata?: Parameters<typeof createBundleSummary>[1]): BundleSummary {
  const summary = createBundleSummary(details, metadata)
  if (details.kind !== 'stasis') return summary
  const { packages, skipped } = bundleAdvisoryInventory(details)
  return { ...summary, versionedPackages: packages.reduce((count, pkg) => count + pkg.versions.length, 0) + skipped.length }
}

// A sourcemap's edges, read with the parser (edges.js) that the client goes
// without: every map's, where the client reads Metro's alone. Without it,
// the metadata keeps what the client would read.
function readSourcemapEdges(details: BundleDetails) {
  if (details.kind !== 'sourcemap' || !details.map) return
  try { details.edges = sourcemapEdges(details.map, bundleEdges) }
  catch (err) { console.warn('managed: sourcemap edges failed:', err) }
}

async function build(record: BundleCacheRecord, storage: BundleCacheStorage, db: ManagedDb, store: BundleStore) {
  const details = await readBundleDetails(record, store)
  if (!details) throw new Error('Bundle bytes unavailable')
  readSourcemapEdges(details)
  const metadata = { ...await createBundleMetadata(details), id: record.id, filename: record.filename }
  const body = await encodeBrotli(Buffer.from(JSON.stringify(metadata)))
  if (!(await db.getBundle(record.id))) throw new Error('Bundle deleted')
  await storage.put(record.id, filename, body)
  if (record.kind === 'stasis') await storage.put(record.id, packagesFilename, encodePackageInventory(details))
  const summary = bundleSummary(details, metadata)
  await storage.put(record.id, SUMMARY_FILENAME, Buffer.from(JSON.stringify(summary)))
  // A different instance may have deleted the row while these writes ran.
  // Reconcile after publishing so its cleanup cannot be undone by us.
  if (!(await db.getBundle(record.id))) {
    await storage.delete(record.id)
    throw new Error('Bundle deleted')
  }
  return summary
}

export function createBundleCache(storage: BundleCacheStorage, db: ManagedDb, store: BundleStore) {
  const pending = new Map<string, Promise<void>>()
  // The database deduplicates by integrity, so each hash has one persistent
  // bundle/cache directory, shared across teams and repeated uploads.
  const summaries = createBundleSummaryCache(storage, async record => {
    const details = await readBundleDetails(record, store)
    if (!details) throw new Error('Bundle bytes unavailable')
    return bundleSummary(details)
  }, id => db.getBundle(id))
  let queue = Promise.resolve()
  async function ensure(record: BundleCacheRecord): Promise<void> {
    const existing = pending.get(record.id)
    if (existing) return existing
    const job = (async () => {
      if (await storage.exists(record.id, filename) && (record.kind !== 'stasis' || await storage.exists(record.id, packagesFilename))) return
      const work = queue.then(async () => summaries.remember(record, await build(record, storage, db, store)))
      queue = work.catch(() => {})
      await work
    })()
    pending.set(record.id, job)
    try { await job } finally { if (pending.get(record.id) === job) pending.delete(record.id) }
  }
  async function openCached(record: BundleCacheRecord, file: string) {
    try { return await storage.open(record.id, file) }
    catch (error) { if (!(error instanceof CacheMissError)) throw error }
    await ensure(record)
    return storage.open(record.id, file)
  }
  return {
    prebuild: ensure,
    summary: summaries.summary,
    summaryStatus: summaries.summaryStatus,
    backfillSummaries: summaries.backfill,
    async open(record: ManagedBundle, part: BundleCachePart) {
      if (part === 'contents') {
        if (record.kind !== 'stasis' && record.kind !== 'sourcemap') throw new Error('Unsupported bundle')
        const stored = await store.open(record.id, record.kind)
        if (!stored) throw new Error('Bundle bytes unavailable')
        return stored
      }
      return openCached(record, filename)
    },
    async advisoryInventory(record: ManagedBundle, reason = ''): Promise<BundleAdvisoryInventory | null | undefined> {
      if (record.kind !== 'stasis') return { packages: [], skipped: [] }
      const cached = await openCached(record, packagesFilename)
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
      await summaries.forget(id)
      await storage.delete(id)
    },
  }
}
export type BundleCache = ReturnType<typeof createBundleCache>
