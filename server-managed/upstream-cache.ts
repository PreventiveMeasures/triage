import type { CacheStore, Package } from '@preventive/upstream/advisories.js'
import type { ManagedSql } from './sql.ts'

// Records @preventive/upstream would otherwise keep in its disk cache, shared
// by every instance: each repository's published advisory listing, written by
// dependency audits that ask repositories, keyed `github/advisories/owner/name`.
// Upstream stamps, validates and expires each value (90 minutes for a listing);
// a refresh replaces the row, and there is one row per repository, so rows are
// not evicted. Only public repositories publish advisories: rows are shared
// across viewers.
export const UPSTREAM_CACHE_SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_upstream_cache (
  cache_key TEXT PRIMARY KEY,
  value     TEXT NOT NULL,
  cached_at INTEGER NOT NULL
) STRICT;
`

export interface UpstreamCacheStore {
  getUpstreamCacheEntry(key: string): Promise<string | null>
  // Key → value for those of `keys` that are kept.
  getUpstreamCacheEntries(keys: string[]): Promise<Map<string, string>>
  setUpstreamCacheEntry(key: string, value: string, cachedAt: number): Promise<void>
}

export function upstreamCacheMethods(db: ManagedSql): UpstreamCacheStore {
  const get = db.prepare('SELECT value FROM managed_upstream_cache WHERE cache_key = ?')
  const getMany = db.prepare('SELECT cache_key, value FROM managed_upstream_cache WHERE cache_key IN (SELECT value FROM json_each(?))')
  // A slower concurrent audit cannot replace a newer listing with an older one.
  const set = db.prepare(`INSERT INTO managed_upstream_cache (cache_key, value, cached_at) VALUES (?, ?, ?)
    ON CONFLICT (cache_key) DO UPDATE SET value = excluded.value, cached_at = excluded.cached_at
    WHERE managed_upstream_cache.cached_at <= excluded.cached_at`)
  return {
    async getUpstreamCacheEntry(key) {
      const row = await get.get(key) as { value: string } | undefined
      return row?.value ?? null
    },
    async getUpstreamCacheEntries(keys) {
      if (keys.length === 0) return new Map()
      const rows = await getMany.all(JSON.stringify(keys)) as { cache_key: string; value: string }[]
      return new Map(rows.map(row => [row.cache_key, row.value]))
    },
    async setUpstreamCacheEntry(key, value, cachedAt) {
      await set.run(key, value, cachedAt)
    },
  }
}

// An audit's `cache`: where the server has an upstream disk cache (off Vercel,
// set at startup), that keeps everything; else this store keeps listings.
export function auditCache(cacheDir: string | null | undefined, db: UpstreamCacheStore, signal: AbortSignal, debug = false, repos: Iterable<string> = []): CacheStore | undefined {
  return cacheDir ? undefined : upstreamCache(db, signal, debug, repos)
}

// The repositories whose listings an audit of `packages` asks for, where they
// are already known: each `github` package, each `soldeer` package's given
// repository, and with `repoAdvisories`, every other package's. Upstream looks
// up the rest itself.
export function auditedRepos(packages: Iterable<Package>, repoAdvisories: boolean): string[] {
  const repos = [...packages].map(pkg => (pkg.ecosystem === 'github' ? pkg.name
    : pkg.ecosystem === 'soldeer' || repoAdvisories ? pkg.github : undefined))
  return [...new Set(repos.filter(repo => repo !== undefined))]
}

// Only listings are kept: upstream's other records (npm version documents,
// registries' repository lookups) read as misses and are not written.
const CACHED_TYPE = 'github/advisories'

// The cache is an optimization: a database failure is a miss, never a failed
// audit. Upstream keeps listing after an abandoned audit; once `signal` aborts,
// the request's database work is over and the store is left alone.
// Upstream reads one listing at a time per repository, and a request's queries
// share one connection (Neon), so a recheck of hundreds of packages would wait
// on as many round trips: the first read asks for every listing of `repos`
// at once. Any other key, or all of them if that read fails, is read alone.
export function upstreamCache(db: UpstreamCacheStore, signal: AbortSignal, debug = false, repos: Iterable<string> = []): CacheStore {
  // Upstream asks for a listing by its repository's lowercased name.
  const batched = new Set([...repos].map(repo => `${CACHED_TYPE}/${repo.toLowerCase()}`))
  let batch: Promise<Map<string, string> | null> | undefined
  const readBatch = () => batch ??= db.getUpstreamCacheEntries([...batched]).catch((error: unknown) => {
    if (debug) console.warn('managed: upstream cache read failed:', error)
    return null
  })
  return {
    async read(type, key) {
      if (type !== CACHED_TYPE || signal.aborted) return null
      const cacheKey = `${type}/${key}`
      try {
        const found = batched.has(cacheKey) ? await readBatch() : null
        const value = found ? found.get(cacheKey) ?? null : await db.getUpstreamCacheEntry(cacheKey)
        return value === null ? null : JSON.parse(value) as unknown
      } catch (error) {
        if (debug) console.warn('managed: upstream cache read failed:', error)
        return null
      }
    },
    async write(type, key, value) {
      if (type !== CACHED_TYPE || signal.aborted) return
      try { await db.setUpstreamCacheEntry(`${type}/${key}`, JSON.stringify(value), Date.now()) } catch (error) {
        if (debug) console.warn('managed: upstream cache write failed:', error)
      }
    },
  }
}
