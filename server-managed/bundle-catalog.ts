import type { BundleCache, BundleSummary } from './bundle-cache.ts'
import type { AdminBundle, UserTeamBundle } from './db.ts'

const SUMMARY_READ_CONCURRENCY = 8

// Read only existing summaries: cold/malformed bundles must never trigger
// parsing or wait for metadata builds before the catalog response is sent.
export async function bundleSummaries(bundles: readonly (AdminBundle | UserTeamBundle)[], cache?: BundleCache) {
  const summaries = new Map<string, { summary: BundleSummary | null; summaryRetryAt: number | null }>()
  if (cache) {
    const unique = [...new Map(bundles.map(bundle => [bundle.integrity, bundle])).values()]
    let next = 0
    // Cold reads may each access remote storage. Bound those requests as well
    // as the subsequent backfill, without dropping entries from large catalogs.
    await Promise.all(Array.from({ length: Math.min(SUMMARY_READ_CONCURRENCY, unique.length) }, async () => {
      while (next < unique.length) {
        const bundle = unique[next++]!
        summaries.set(bundle.integrity, await cache.summaryStatus(bundle).catch(() => ({ summary: null, summaryRetryAt: null })))
      }
    }))
  }
  return summaries
}

// Called after sending the response. Each cache permits one small batch at a
// time, deduplicated by content hash, and skips persisted retry-backoff markers.
export async function backfillBundleSummaries(bundles: readonly (AdminBundle | UserTeamBundle)[], cache?: BundleCache) {
  await cache?.backfillSummaries([...new Map(bundles.map(bundle => [bundle.integrity, bundle])).values()])
}
