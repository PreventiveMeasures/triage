import type { CacheStore } from '@preventive/upstream/advisories.js'
import type { ManagedSql } from './sql.ts'

// Records @preventive/upstream would otherwise keep in its disk cache, shared
// by every instance: currently each repository's published advisory listing,
// written by dependency audits that ask repositories. Upstream stamps,
// validates and expires each value (an hour for a listing); a refresh replaces
// the row, and there is one row per repository, so rows are not evicted.
// Only public repositories publish advisories: rows are shared across viewers.
export const UPSTREAM_CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_upstream_cache (
  cache_key TEXT PRIMARY KEY,
  value     TEXT NOT NULL,
  cached_at INTEGER NOT NULL
) STRICT;
`

export interface UpstreamCacheStore {
  getUpstreamCacheEntry(key: string): Promise<string | null>
  setUpstreamCacheEntry(key: string, value: string, cachedAt: number): Promise<void>
}

export function upstreamCacheMethods(db: ManagedSql): UpstreamCacheStore {
  const get = db.prepare('SELECT value FROM managed_upstream_cache WHERE cache_key = ?')
  // A slower concurrent audit cannot replace a newer listing with an older one.
  const set = db.prepare(`INSERT INTO managed_upstream_cache (cache_key, value, cached_at) VALUES (?, ?, ?)
    ON CONFLICT (cache_key) DO UPDATE SET value = excluded.value, cached_at = excluded.cached_at
    WHERE managed_upstream_cache.cached_at <= excluded.cached_at`)
  return {
    async getUpstreamCacheEntry(key) {
      const row = await get.get(key) as { value: string } | undefined
      return row?.value ?? null
    },
    async setUpstreamCacheEntry(key, value, cachedAt) {
      await set.run(key, value, cachedAt)
    },
  }
}

// The cache is an optimization: a database failure is a miss, never a failed
// audit. Upstream keeps listing after an abandoned audit; once `signal` aborts,
// the request's database work is over and the store is left alone.
export function upstreamCache(db: UpstreamCacheStore, signal: AbortSignal, debug = false): CacheStore {
  return {
    async read(key) {
      if (signal.aborted) return null
      try {
        const value = await db.getUpstreamCacheEntry(key)
        return value === null ? null : JSON.parse(value) as unknown
      } catch (error) {
        if (debug) console.warn('managed: upstream cache read failed:', error)
        return null
      }
    },
    async write(key, value) {
      if (signal.aborted) return
      try { await db.setUpstreamCacheEntry(key, JSON.stringify(value), Date.now()) } catch (error) {
        if (debug) console.warn('managed: upstream cache write failed:', error)
      }
    },
  }
}
