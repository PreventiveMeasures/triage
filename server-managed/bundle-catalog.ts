import type { BundleCache, BundleSummary } from './bundle-cache.ts'
import type { AdminBundle, UserTeamBundle } from './db.ts'

// Read only existing summaries: cold/malformed bundles must never trigger
// parsing or wait for metadata builds before the catalog response is sent.
export async function bundleSummaries(bundles: readonly (AdminBundle | UserTeamBundle)[], cache?: BundleCache) {
  const summaries = new Map<string, BundleSummary | null>()
  if (cache) {
    await Promise.all([...new Map(bundles.map(bundle => [bundle.integrity, bundle])).values()].map(async bundle => {
      summaries.set(bundle.integrity, await cache.summary(bundle).catch(() => null))
    }))
  }
  return summaries
}

// Called after sending the response. Each cache permits one small batch at a
// time, deduplicated by content hash, and skips persisted retry-backoff markers.
export async function backfillBundleSummaries(bundles: readonly (AdminBundle | UserTeamBundle)[], cache?: BundleCache) {
  await cache?.backfillSummaries([...new Map(bundles.map(bundle => [bundle.integrity, bundle])).values()])
}
