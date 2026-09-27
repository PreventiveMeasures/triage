import type { BundleCache, BundleSummary } from './bundle-cache.ts'
import type { AdminBundle, UserTeamBundle } from './db.ts'

// One lookup per hash even when several teams list the same bundle. Unreadable
// or unsupported uploads must not prevent the rest of the catalog from loading.
export async function bundleSummaries(bundles: readonly (AdminBundle | UserTeamBundle)[], cache?: BundleCache) {
  const summaries = new Map<string, BundleSummary | null>()
  if (cache) {
    await Promise.all([...new Map(bundles.map(bundle => [bundle.integrity, bundle])).values()].map(async bundle => {
      summaries.set(bundle.integrity, await cache.summary(bundle).catch(() => null))
    }))
  }
  return summaries
}
