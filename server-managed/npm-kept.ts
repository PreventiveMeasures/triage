// What the npm viewer and repository risk scans keep in the database
// (managed_upstream_cache, upstream-cache.ts), beyond the instance, so that
// neither asks for it again on every read, nor after a restart or on another
// instance: public versions' documents, of the fields read of them
// (npm-manifest.ts npmVersionFields), for a day (readNpmVersion asks npm again
// then, as a version can be deprecated, its package made private, or itself
// removed); and, for scans, each package's risk line, for as long as a scan
// keeps it, and what a scan read of GitHub, for a day, and of npm's
// advisories, for an hour (repository-risk.ts); and what the code viewer read
// of a repository's GitHub, its issues, pull requests and agents' work, for a
// day (http.ts keptAnswer), and its history, a page from a commit at a time,
// for a month (repository-history.ts historyFrom), as are the files each of
// its commits changes and holds (repository-changes.ts), and the packages a
// pull request's lockfiles add (pull-dependencies.ts). Each store removes its own rows kept longer
// than that as it writes, at most once an hour a database (pruneKept), so
// that rows no read will take again don't pile up.
// The database is an optimization: a failure reads as a miss, and writes
// nothing.
import { createHash } from 'node:crypto'
import { plainObject } from './npm-manifest.ts'
import { type NpmVersionStore, VERSION_KEPT_MS } from './npm-packages.ts'
import type { UpstreamCacheStore } from './upstream-cache.ts'

// A value kept by key, as JSON, `at` when it was.
export interface KeptStore<T> {
  read(key: string): Promise<{ at: number; value: T } | null>
  // Those of `keys` kept, by key, in one read of the database.
  readMany(keys: string[]): Promise<Map<string, { at: number; value: T }>>
  write(key: string, value: T, at: number): Promise<void>
  // Removes what is kept by `key`.
  remove(key: string): Promise<void>
}

// When each database last had the rows under each prefix removed.
const PRUNE_EVERY_MS = 60 * 60_000
const pruned = new WeakMap<UpstreamCacheStore, Map<string, number>>()

// Removes the rows under `prefix` kept `keptMs` before `at`, at most once an
// hour a database, as rows under it are written: here, and risk's downloads
// (npm-risk.ts). A failure is `warn`ed of, and removes nothing.
export async function pruneKept(db: UpstreamCacheStore, prefix: string, keptMs: number, at: number, warn: (error: unknown) => void) {
  const times = pruned.get(db) ?? pruned.set(db, new Map()).get(db)!
  if (at - (times.get(prefix) ?? -Infinity) < PRUNE_EVERY_MS) return
  times.set(prefix, at)
  try { await db.deleteUpstreamCacheEntries(prefix, at - keptMs) } catch (error) { warn(error) }
}

// Values of `type`, each read for `keptMs` after it was kept.
function keptStore<T>(db: UpstreamCacheStore, type: string, keptMs: number, debug: boolean): KeptStore<T> {
  const warn = (what: string, error: unknown) => { if (debug) console.warn(`managed: kept ${type} ${what} failed:`, error) }
  // Kept for good (Infinity): none removed.
  const prune = (at: number) => keptMs === Infinity ? Promise.resolve() : pruneKept(db, `${type}/`, keptMs, at, error => { warn('prune', error) })
  // Keys of any length or character, as the database's: hashed.
  const keyOf = (key: string) => `${type}/${createHash('sha256').update(key).digest('hex')}`
  const valueOf = (row: string | null | undefined) => {
    const kept: unknown = JSON.parse(row ?? 'null')
    return plainObject(kept) && typeof kept['at'] === 'number' && 'value' in kept ? { at: kept['at'], value: kept['value'] as T } : null
  }
  return {
    async read(key) {
      try { return valueOf(await db.getUpstreamCacheEntry(keyOf(key))) } catch (error) { warn('read', error); return null }
    },
    async readMany(keys) {
      try {
        const rows = await db.getUpstreamCacheEntries(keys.map(keyOf))
        return new Map(keys.flatMap(key => { const kept = valueOf(rows.get(keyOf(key))); return kept ? [[key, kept] as const] : [] }))
      } catch (error) { warn('read', error); return new Map() }
    },
    async write(key, value, at) {
      try { await db.setUpstreamCacheEntry(keyOf(key), JSON.stringify({ at, value }), at) } catch (error) { warn('write', error) }
      await prune(at)
    },
    async remove(key) {
      try { await db.deleteUpstreamCacheEntries(keyOf(key), Number.MAX_SAFE_INTEGER) } catch (error) { warn('remove', error) }
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

// Risk lines, each kept `keptMs`, for good where Infinity, a scan telling one
// past RISK_KEPT_MS as stale (repository-risk.ts).
export const riskLineStore = <T>(db: UpstreamCacheStore, keptMs: number, debug = false): KeptStore<T> => keptStore<T>(db, 'repository-risk/lines', keptMs, debug)
// What a scan read, each read for keptMs (repository-risk.ts): of GitHub, a
// repository's lockfiles as listed at a commit (`listings`) and a lockfile's
// packages by its blob (`lockfiles`), for SCAN_READ_KEPT_MS; of npm, a
// lockfile's advisories by its blob (`advisories`), for RISK_KEPT_MS; and the
// repositories a scan in parts told whole (`progress`).
export const scanReadStore = <T>(db: UpstreamCacheStore, type: 'listings' | 'lockfiles' | 'advisories' | 'progress', keptMs: number, debug = false): KeptStore<T> =>
  keptStore<T>(db, `repository-risk/${type}`, keptMs, debug)
// What the code viewer read of a repository (http.ts readWholeRepository), by
// its id and what was asked, each kept REPOSITORY_READ_KEPT_MS.
export const REPOSITORY_READ_KEPT_MS = 24 * 60 * 60_000
export const repositoryReadStore = (db: UpstreamCacheStore, debug = false): KeptStore<object> =>
  keptStore<object>(db, 'repository/reads', REPOSITORY_READ_KEPT_MS, debug)
// Pages of a repository's history (repository-history.ts historyFrom), by its
// id and the commit each starts at, which never change: kept a month after
// they were last read from GitHub.
export const HISTORY_PAGE_KEPT_MS = 30 * 24 * 60 * 60_000
export const historyPageStore = <T>(db: UpstreamCacheStore, debug = false): KeptStore<T> => keptStore<T>(db, 'repository/history', HISTORY_PAGE_KEPT_MS, debug)
// The pull requests squashed into a repository's commits, by the commit
// (repository-history.ts squashedPulls): kept as its history's pages are.
export const historySquashStore = <T>(db: UpstreamCacheStore, debug = false): KeptStore<T> => keptStore<T>(db, 'repository/squashes', HISTORY_PAGE_KEPT_MS, debug)
// The files each of a repository's commits changes (repository-changes.ts
// repositoryChanges), by the commit, which never change: kept as its
// history's pages are.
export const historyChangeStore = <T>(db: UpstreamCacheStore, debug = false): KeptStore<T> => keptStore<T>(db, 'repository/changes', HISTORY_PAGE_KEPT_MS, debug)
// The files a repository's commit holds (repository-changes.ts
// repositoryTree), by the commit, which never change: kept as its history's
// pages are.
export const historyTreeStore = <T>(db: UpstreamCacheStore, debug = false): KeptStore<T> => keptStore<T>(db, 'repository/trees', HISTORY_PAGE_KEPT_MS, debug)
// The packages a repository's pull request's lockfiles add
// (pull-dependencies.ts), by the commits of its base and head, which never
// change: kept as its history's pages are.
export const pullDependencyStore = <T>(db: UpstreamCacheStore, debug = false): KeptStore<T> => keptStore<T>(db, 'repository/pull-dependencies', HISTORY_PAGE_KEPT_MS, debug)
// The versions a repository's lockfiles locked at the commit its dependencies
// are reviewed since (pull-dependency-reviews.ts reviewBaseline), by the
// commit, which never change: kept as its history's pages are, never stored
// as reviews.
export const reviewBaselineStore = (db: UpstreamCacheStore, debug = false): KeptStore<string[]> => keptStore<string[]>(db, 'repository/review-baselines', HISTORY_PAGE_KEPT_MS, debug)
