import { Buffer } from 'node:buffer'
import { setImmediate } from 'node:timers/promises'
import { CacheMissError } from './cache-storage.ts'
import { decodeUtf8 } from '../common/utf8.js'
import { bundleCommitHash } from '../common/bundle-commit.js'
import type { OpenedBlob } from './blob-store.ts'
import type { BundleCacheRecord, BundleCacheStorage, BundleSummary } from './bundle-cache.ts'

// Version 3 adds the optional source commit; version 4 counts lines of code
// without blank lines; version 5 adds a Stasis bundle's format version and
// versioned package count. Older bundles use bounded backfill; until it
// reaches one, catalogs serve its version 4 summary, which lacks only those.
export const SUMMARY_FILENAME = 'v5-summary.json'
const PREVIOUS_SUMMARY_FILENAME = 'v4-summary.json'
const RETRY_MS = 5 * 60_000
const BACKFILL_LIMIT = 4
type CachedSummary = BundleSummary | { retryAt: number } | { previous: BundleSummary }

async function readCurrentSummary(storage: BundleCacheStorage, id: string): Promise<CachedSummary> {
  try { return await readSummary(storage, id, SUMMARY_FILENAME) }
  catch (error) {
    if (!(error instanceof CacheMissError)) throw error
    const previous = await readSummary(storage, id, PREVIOUS_SUMMARY_FILENAME)
    return 'retryAt' in previous ? previous : { previous }
  }
}

// A cached file's bytes, read whole and its stream destroyed; null past `max`.
export async function readCachedBytes(cached: OpenedBlob, max: number): Promise<Buffer | null> {
  try {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of cached.stream) {
      size += chunk.length
      if (size > max) return null
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  } finally { cached.stream.destroy() }
}

async function readSummary(storage: BundleCacheStorage, id: string, file: string): Promise<BundleSummary | { retryAt: number }> {
  const bytes = await readCachedBytes(await storage.open(id, file), 1024)
  if (!bytes) throw new Error('Invalid bundle summary')
  const summary = JSON.parse(decodeUtf8(bytes)) as BundleSummary | { retryAt: number }
  if (summary && 'retryAt' in summary && Number.isSafeInteger(summary.retryAt) && summary.retryAt > 0) return summary
  const counts = summary as BundleSummary
  if (!counts || ![counts.files, counts.codeFiles, counts.lines].every(value => Number.isSafeInteger(value) && value >= 0)
      || counts.codeFiles > counts.files || (counts.commit !== undefined && !bundleCommitHash(counts.commit))
      || [counts.stasisVersion, counts.versionedPackages].some(value => value !== undefined && !(Number.isSafeInteger(value) && value >= 0))) throw new Error('Invalid bundle summary')
  return counts
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
    const job: Promise<CachedSummary | null> = readCurrentSummary(storage, record.id).then(value => {
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
    return { summary: !value || 'retryAt' in value ? null : 'previous' in value ? value.previous : value,
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
      if (cached && !('previous' in cached) && (!('retryAt' in cached) || cached.retryAt > Date.now())) continue
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
