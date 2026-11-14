import type { BundleCache, BundleSummary } from './bundle-cache.ts'
import type { AdminBundle, UserTeamBundle } from './db.ts'
import { eachOf } from './queue.ts'

const SUMMARY_READ_CONCURRENCY = 8
type ListedBundle = AdminBundle | UserTeamBundle

// The bundles, one of each content hash.
const byIntegrity = (bundles: readonly ListedBundle[]) => [...new Map(bundles.map(bundle => [bundle.integrity, bundle])).values()]

// Read only existing summaries: cold/malformed bundles must never trigger
// parsing or wait for metadata builds before the catalog response is sent.
export async function bundleSummaries(bundles: readonly ListedBundle[], cache?: BundleCache) {
  const summaries = new Map<string, { summary: BundleSummary | null; summaryRetryAt: number | null }>()
  if (cache) {
    // Cold reads may each access remote storage. Bound those requests as well
    // as the subsequent backfill, without dropping entries from large catalogs.
    await eachOf(byIntegrity(bundles), SUMMARY_READ_CONCURRENCY, async bundle => {
      summaries.set(bundle.integrity, await cache.summaryStatus(bundle).catch(() => ({ summary: null, summaryRetryAt: null })))
    })
  }
  return summaries
}

// Called after sending the response. Each cache permits one small batch at a
// time, deduplicated by content hash, and skips persisted retry-backoff markers.
export async function backfillBundleSummaries(bundles: readonly ListedBundle[], cache?: BundleCache) {
  await cache?.backfillSummaries(byIntegrity(bundles))
}
