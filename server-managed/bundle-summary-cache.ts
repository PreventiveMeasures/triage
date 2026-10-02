import { Buffer } from 'node:buffer'
import { setImmediate } from 'node:timers/promises'
import { BUNDLE_METADATA_VERSION } from '../common/bundle-metadata.js'
import { CacheMissError } from './cache-storage.ts'
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
  const reads = new Map<string, { id: string; job: Promise<CachedSummary | null> }>()
  const active = new Map<string, Promise<void>>()
  let pending: Promise<void> | null = null
  function remember(record: BundleCacheRecord, value: CachedSummary) {
    // A completed build supersedes any older storage read still in flight.
    reads.delete(record.integrity)
    // Summaries are tiny and immutable by integrity. Refuse overflow admission
    // instead of evicting the next hit during a scan larger than the cache.
    if (entries.size >= 4096 && !entries.has(record.integrity)) return
    entries.set(record.integrity, { id: record.id, value })
  }
  function read(record: BundleCacheRecord): Promise<CachedSummary | null> {
    const known = entries.get(record.integrity)
    if (known) return Promise.resolve(known.value)
    const existing = reads.get(record.integrity)
    if (existing) return existing.job
    // Concurrent catalogs share the decoded summary, never the response stream.
    // Only in-flight work is shared: misses and failures remain retryable.
    const job: Promise<CachedSummary | null> = readSummary(storage, record.id).then(value => {
      if (reads.get(record.integrity)?.job === job) remember(record, value)
      return entries.get(record.integrity)?.value ?? value
    }).catch(error => {
      if (error instanceof CacheMissError) return null
      throw error
    }).finally(() => { if (reads.get(record.integrity)?.job === job) reads.delete(record.integrity) })
    reads.set(record.integrity, { id: record.id, job })
    return job
  }
  async function publish(record: BundleCacheRecord, value: CachedSummary) {
    if (!await exists(record.id)) return
    await storage.put(record.id, SUMMARY_FILENAME, Buffer.from(JSON.stringify(value)))
    if (!await exists(record.id)) { await storage.delete(record.id); return }
    remember(record, value)
  }
  async function buildOne(record: BundleCacheRecord) {
    try { await publish(record, await build(record)) }
    catch { await publish(record, { retryAt: Date.now() + RETRY_MS }).catch(() => {}) }
  }
  async function summaryStatus(record: BundleCacheRecord) {
    const value = ['stasis', 'sourcemap'].includes(record.kind ?? '') ? await read(record) : null
    return { summary: value && !('retryAt' in value) ? value : null,
      summaryRetryAt: value && 'retryAt' in value ? value.retryAt : null }
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
      if (!await exists(record.id)) continue
      if (attempts++ >= BACKFILL_LIMIT) break
      const job = buildOne(record)
      active.set(record.id, job)
      try { await job } finally { active.delete(record.id) }
    }
  }
  return {
    remember,
    summaryStatus,
    async summary(record: BundleCacheRecord): Promise<BundleSummary | null> {
      return (await summaryStatus(record)).summary
    },
    backfill(records: readonly BundleCacheRecord[]) {
      if (pending) return Promise.resolve() // Another catalog already owns the bounded batch.
      const job = backfill(records).finally(() => { if (pending === job) pending = null })
      pending = job
      return job
    },
    async forget(id: string) {
      // Only this bundle can republish its cache during deletion. A stalled
      // backfill elsewhere must not delay removing these bytes or responding.
      await active.get(id)
      for (const [hash, entry] of entries) if (entry.id === id) entries.delete(hash)
      // Do not wait for remote reads during deletion. Their callers still own
      // and drain them, but a late response must not repopulate this cache.
      for (const [hash, entry] of reads) if (entry.id === id) reads.delete(hash)
    },
  }
}
