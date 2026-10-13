// What the npm viewer and repository risk scans keep in the database
// (managed_upstream_cache, upstream-cache.ts), beyond the instance, so that
// neither asks for it again on every read, nor after a restart or on another
// instance: public versions' documents, of the fields read of them
// (npm-manifest.ts npmVersionFields), for a day (readNpmVersion asks npm again
// then, as a version can be deprecated, its package made private, or itself
// removed); and, for scans, each package's risk line, for as long as a scan
// keeps it (repository-risk.ts). Each store removes its own rows kept longer
// than that as it writes, at most once an hour a database, so that rows no
// read will take again don't pile up.
// The database is an optimization: a failure reads as a miss, and writes
// nothing.
import { createHash } from 'node:crypto'
import { plainObject } from './npm-manifest.ts'
import { type NpmVersionStore, VERSION_KEPT_MS } from './npm-packages.ts'
import type { UpstreamCacheStore } from './upstream-cache.ts'

// A value kept by key, as JSON, `at` when it was.
export interface KeptStore<T> {
  read(key: string): Promise<{ at: number; value: T } | null>
  write(key: string, value: T, at: number): Promise<void>
}

// When each database last had each type's old rows removed.
const PRUNE_EVERY_MS = 60 * 60_000
const pruned = new WeakMap<UpstreamCacheStore, Map<string, number>>()

// Values of `type`, each read for `keptMs` after it was kept.
function keptStore<T>(db: UpstreamCacheStore, type: string, keptMs: number, debug: boolean): KeptStore<T> {
  const warn = (what: string, error: unknown) => { if (debug) console.warn(`managed: kept ${type} ${what} failed:`, error) }
  const prune = async (at: number) => {
    const times = pruned.get(db) ?? pruned.set(db, new Map()).get(db)!
    if (at - (times.get(type) ?? -Infinity) < PRUNE_EVERY_MS) return
    times.set(type, at)
    try { await db.deleteUpstreamCacheEntries(`${type}/`, at - keptMs) } catch (error) { warn('prune', error) }
  }
  // Keys of any length or character, as the database's: hashed.
  const keyOf = (key: string) => `${type}/${createHash('sha256').update(key).digest('hex')}`
  return {
    async read(key) {
      try {
        const kept: unknown = JSON.parse(await db.getUpstreamCacheEntry(keyOf(key)) ?? 'null')
        return plainObject(kept) && typeof kept['at'] === 'number' && 'value' in kept ? { at: kept['at'], value: kept['value'] as T } : null
      } catch (error) { warn('read', error); return null }
    },
    async write(key, value, at) {
      try { await db.setUpstreamCacheEntry(keyOf(key), JSON.stringify({ at, value }), at) } catch (error) { warn('write', error) }
      await prune(at)
    },
  }
}

export function npmVersionStore(db: UpstreamCacheStore, debug = false): NpmVersionStore {
  const kept = keptStore<Record<string, unknown>>(db, 'npm/version-documents', VERSION_KEPT_MS, debug)
  return {
    async read(name, version) {
      const hit = await kept.read(`${name}@${version}`)
      return hit && plainObject(hit.value) ? { at: hit.at, json: hit.value } : null
    },
    write: (name, version, json) => kept.write(`${name}@${version}`, json, Date.now()),
  }
}

// Risk lines, each read for `keptMs`, as long as a scan keeps them.
export const riskLineStore = <T>(db: UpstreamCacheStore, keptMs: number, debug = false): KeptStore<T> => keptStore<T>(db, 'repository-risk/lines', keptMs, debug)
