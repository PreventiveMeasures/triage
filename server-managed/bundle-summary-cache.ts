import { Buffer } from 'node:buffer'
import { setImmediate } from 'node:timers/promises'
import { BUNDLE_METADATA_VERSION } from '../common/bundle-metadata.js'
import { decodeUtf8 } from '../common/utf8.js'
import type { BundleCacheRecord, BundleCacheStorage, BundleSummary } from './bundle-cache.ts'

export const SUMMARY_FILENAME = `v${BUNDLE_METADATA_VERSION}-summary.json`
const RETRY_MS = 5 * 60_000
const BACKFILL_LIMIT = 4
type CachedSummary = BundleSummary | { retryAt: number }

async function readSummary(storage: BundleCacheStorage, id: string): Promise<CachedSummary> {
  const cached = await storage.open(id, SUMMARY_FILENAME)
  try {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of cached.stream) {
      size += chunk.length
      if (size > 1024) throw new Error('Invalid bundle summary')
      chunks.push(Buffer.from(chunk))
    }
    const summary = JSON.parse(decodeUtf8(Buffer.concat(chunks))) as CachedSummary
    if (summary && 'retryAt' in summary && Number.isSafeInteger(summary.retryAt) && summary.retryAt > 0) return summary
    const counts = summary as BundleSummary
    if (!counts || ![counts.files, counts.codeFiles, counts.lines].every(value => Number.isSafeInteger(value) && value >= 0)
        || counts.codeFiles > counts.files) throw new Error('Invalid bundle summary')
    return counts
  } finally { cached.stream.destroy() }
}

export function createBundleSummaryCache(storage: BundleCacheStorage, build: (record: BundleCacheRecord) => Promise<BundleSummary>, exists: (id: string) => Promise<unknown>) {
  const entries = new Map<string, { id: string; value: CachedSummary }>()
  let pending: Promise<void> | null = null
  function remember(record: BundleCacheRecord, value: CachedSummary) {
    if (entries.size >= 256) entries.delete(entries.keys().next().value!)
    entries.set(record.integrity, { id: record.id, value })
  }
  async function read(record: BundleCacheRecord) {
    const known = entries.get(record.integrity)
    if (known) return known.value
    if (!await storage.exists(record.id, SUMMARY_FILENAME)) return null
    const value = await readSummary(storage, record.id)
    remember(record, value)
    return value
  }
  async function publish(record: BundleCacheRecord, value: CachedSummary) {
    if (!await exists(record.id)) return
    await storage.put(record.id, SUMMARY_FILENAME, Buffer.from(JSON.stringify(value)))
    if (!await exists(record.id)) { await storage.delete(record.id); return }
    remember(record, value)
  }
  async function backfill(records: readonly BundleCacheRecord[]) {
    // Start after the catalog has been sent. Keep this work awaited by the
    // request owner (including serverless), with no detached tasks or backlog.
    await setImmediate()
    let attempts = 0
    for (const record of records) {
      if (!['stasis', 'sourcemap'].includes(record.kind ?? '')) continue
      const cached = await read(record).catch(() => null)
      if (cached && (!('retryAt' in cached) || cached.retryAt > Date.now())) continue
      if (attempts++ >= BACKFILL_LIMIT) break
      try { await publish(record, await build(record)) }
      catch { await publish(record, { retryAt: Date.now() + RETRY_MS }).catch(() => {}) }
    }
  }
  return {
    remember,
    async summary(record: BundleCacheRecord): Promise<BundleSummary | null> {
      if (!['stasis', 'sourcemap'].includes(record.kind ?? '')) return null
      const value = await read(record)
      return value && !('retryAt' in value) ? value : null
    },
    backfill(records: readonly BundleCacheRecord[]) {
      if (pending) return Promise.resolve() // Another catalog already owns the bounded batch.
      const job = backfill(records).finally(() => { if (pending === job) pending = null })
      pending = job
      return job
    },
    async forget(id: string) {
      await pending
      for (const [hash, entry] of entries) if (entry.id === id) entries.delete(hash)
    },
  }
}
