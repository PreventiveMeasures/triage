// What the npm viewer and repository risk scans keep in the database
// (managed_upstream_cache, upstream-cache.ts), beyond the instance, so that
// neither asks for it again on every read, nor after a restart or on another
// instance: public versions' documents, of the fields read of them
// (npm-manifest.ts npmVersionFields), as npm never changes a version (whether
// npm still has one, risk tells; whether a scoped one is still public,
// readNpmVersion asks again a day on); and, for scans, each package's risk
// line, for as long as a scan keeps it (repository-risk.ts), those older
// removed as a scan starts (pruneRiskLines).
// The database is an optimization: a failure reads as a miss, and writes
// nothing.
import { createHash } from 'node:crypto'
import { plainObject } from './npm-manifest.ts'
import type { NpmVersionStore } from './npm-packages.ts'
import type { UpstreamCacheStore } from './upstream-cache.ts'

// A value kept by key, as JSON, `at` when it was.
export interface KeptStore<T> {
  read(key: string): Promise<{ at: number; value: T } | null>
  write(key: string, value: T, at: number): Promise<void>
}

function keptStore<T>(db: UpstreamCacheStore, type: string, debug: boolean): KeptStore<T> {
  const warn = (what: string, error: unknown) => { if (debug) console.warn(`managed: kept ${type} ${what} failed:`, error) }
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
    },
  }
}

export function npmVersionStore(db: UpstreamCacheStore, debug = false): NpmVersionStore {
  const kept = keptStore<Record<string, unknown>>(db, 'npm/version-documents', debug)
  return {
    async read(name, version) {
      const hit = await kept.read(`${name}@${version}`)
      return hit && plainObject(hit.value) ? { at: hit.at, json: hit.value } : null
    },
    write: (name, version, json) => kept.write(`${name}@${version}`, json, Date.now()),
  }
}

const RISK_LINES = 'repository-risk/lines'
export const riskLineStore = <T>(db: UpstreamCacheStore, debug = false): KeptStore<T> => keptStore<T>(db, RISK_LINES, debug)

// Risk lines kept longer ago than `ms`, which no scan reads, removed.
export async function pruneRiskLines(db: UpstreamCacheStore, ms: number, debug = false) {
  try { await db.deleteUpstreamCacheEntries(`${RISK_LINES}/`, Date.now() - ms) } catch (error) { if (debug) console.warn('managed: pruning kept risk lines failed:', error) }
}
