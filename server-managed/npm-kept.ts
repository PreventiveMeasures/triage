// What the npm viewer and repository risk scans keep in the database
// (managed_upstream_cache, upstream-cache.ts), beyond the instance, so that
// neither asks for it again on every read, nor after a restart or on another
// instance: public versions' documents, of the fields read of them
// (npm-manifest.ts npmVersionFields), for a day (readNpmVersion asks npm again
// then, as a version can be deprecated, its package made private, or itself
// removed), and when each was published, for a month (npmPublishTimeStore);
// and, for scans, each package's risk line, for as long as a scan
// keeps it, and what a scan read of GitHub, for a day, and of npm's
// advisories, for an hour (repository-risk.ts); and what the code viewer read
// of a repository's GitHub, its issues, pull requests and agents' work, for a
// day (http.ts keptAnswer), and its history, a page from a commit at a time,
// for a month (repository-history.ts historyFrom), as are the files each of
// its commits changes and holds (repository-changes.ts), the packages a
// pull request's lockfiles add (pull-dependencies.ts), and the lockfiles a
// commit lists and each one's packages, as its dependency review reads them
// (commit-lockfiles.ts). Each store removes its own rows kept longer
// than that as it writes, at most once an hour a database (pruneKept), so
// that rows no read will take again don't pile up.
// The database is an optimization: a failure reads as a miss, and writes
// nothing.
import { createHash } from 'node:crypto'
import { plainObject } from './npm-manifest.ts'
import { type NpmPublishTimeStore, type NpmVersionStore, VERSION_KEPT_MS } from './npm-packages.ts'
import type { UpstreamCacheStore } from './upstream-cache.ts'

// A value kept by key, as JSON, `at` when it was.
export interface KeptStore<T> {
  read(key: string): Promise<{ at: number; value: T } | null>
  // Those of `keys` kept, by key, in one read of the database.
  readMany(keys: string[]): Promise<Map<string, { at: number; value: T }>>
  // Those of `first` kept; where none is, those of `then`, in one read of the
  // database (`first` whether they are `first`'s).
  readFirst(first: string[], then: string[]): Promise<{ first: boolean; found: Map<string, { at: number; value: T }> }>
  write(key: string, value: T, at: number): Promise<void>
  // Removes what is kept by `key`.
  remove(key: string): Promise<void>
}

// When each database last had the rows under each prefix removed.
const PRUNE_EVERY_MS = 60 * 60_000
const pruned = new WeakMap<UpstreamCacheStore, Map<string, number>>()
// Who sees each database's prunes through (index.ts: its app, which waits
// for them before closing it, and on serverless keeps its invocation alive
// till they settle), as a write no longer waits for one.
const pruneOwners = new WeakMap<UpstreamCacheStore, (prune: Promise<unknown>) => void>()
export function ownKeptPrunes(db: UpstreamCacheStore, own: (prune: Promise<unknown>) => void) {
  pruneOwners.set(db, own)
}

// Removes the rows under `prefix` kept `keptMs` before `at`, at most once an
// hour a database, as rows under it are written: here, and risk's downloads
// (npm-risk.ts), each one run handed to the database's owner. A failure is
// `warn`ed of, and removes nothing.
export function pruneKept(db: UpstreamCacheStore, prefix: string, keptMs: number, at: number, warn: (error: unknown) => void): Promise<void> {
  const times = pruned.get(db) ?? pruned.set(db, new Map()).get(db)!
  if (at - (times.get(prefix) ?? -Infinity) < PRUNE_EVERY_MS) return Promise.resolve()
  times.set(prefix, at)
  const prune = (async () => { try { await db.deleteUpstreamCacheEntries(prefix, at - keptMs) } catch (error) { warn(error) } })()
  pruneOwners.get(db)?.(prune)
  return prune
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
    async readFirst(first, then) {
      try {
        const { first: answered, entries } = await db.getFirstUpstreamCacheEntries(first.map(keyOf), then.map(keyOf))
        const asked = answered ? first : then
        return { first: answered, found: new Map(asked.flatMap(key => { const kept = valueOf(entries.get(keyOf(key))); return kept ? [[key, kept] as const] : [] })) }
      } catch (error) { warn('read', error); return { first: false, found: new Map() } }
    },
    async write(key, value, at) {
      try { await db.setUpstreamCacheEntry(keyOf(key), JSON.stringify({ at, value }), at) } catch (error) { warn('write', error) }
      // Behind the write, not before it is done: the prune reads the whole
      // table (no index serves its prefix), which no writer need wait on.
      // Its hour is marked before it runs, so writes meanwhile start none,
      // and its database's owner sees it through (ownKeptPrunes).
      void prune(at)
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
    async readMany(versions) {
      const hits = await kept.readMany(versions.map(({ name, version }) => `${name}@${version}`))
      return new Map([...hits].flatMap(([key, hit]) => plainObject(hit.value) ? [[key, { at: hit.at, json: hit.value }] as const] : []))
    },
    write: (name, version, json) => kept.write(`${name}@${version}`, json, Date.now()),
  }
}

// When public versions were published (npm-packages.ts npmPublishTime), which
// never changes once they are: kept a month, and kept again by the next view
// of the version past it.
const PUBLISH_TIME_KEPT_MS = 30 * 24 * 60 * 60_000
export function npmPublishTimeStore(db: UpstreamCacheStore, debug = false): NpmPublishTimeStore {
  const kept = keptStore<string>(db, 'npm/publish-times', PUBLISH_TIME_KEPT_MS, debug)
  return {
    async read(name, version) {
      const hit = await kept.read(`${name}@${version}`)
      return typeof hit?.value === 'string' ? hit.value : null
    },
    write: (name, version, at) => kept.write(`${name}@${version}`, at, Date.now()),
  }
}

// Risk lines, each kept `keptMs`, for good where Infinity, a scan telling one
// past RISK_KEPT_MS as stale (repository-risk.ts).
export const riskLineStore = <T>(db: UpstreamCacheStore, keptMs: number, debug = false): KeptStore<T> => keptStore<T>(db, 'repository-risk/lines', keptMs, debug)
// What a scan read, each read for keptMs (repository-risk.ts): of GitHub, a
// repository's lockfiles as listed at a commit (`listings`) and a lockfile's
// packages by its blob (`lockfiles`), for SCAN_READ_KEPT_MS; of npm, a
// lockfile's advisories by its blob (`advisories`), for RISK_KEPT_MS; the
// repositories a scan in parts told whole (`progress`); a repository's
// Actions' files by the commit read (`action-files`), and the actions and
// reusable workflows of others they name, each resolved (`actions`), of
// public repositories alone (repository-actions.ts).
export const scanReadStore = <T>(db: UpstreamCacheStore, type: 'listings' | 'lockfiles' | 'advisories' | 'progress' | 'action-files' | 'actions', keptMs: number, debug = false): KeptStore<T> =>
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
// (repository-squashes.ts squashedPulls): kept as its history's pages are.
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
// The lines a version changes against another, or none (npm-delta.ts), by
// both sides' integrities, each kept HISTORY_PAGE_KEPT_MS.
export const npmDeltaStore = <T>(db: UpstreamCacheStore, debug = false): KeptStore<T> => keptStore<T>(db, 'npm/deltas', HISTORY_PAGE_KEPT_MS, debug)
export const reviewBaselineStore = (db: UpstreamCacheStore, debug = false): KeptStore<{ versions: string[]; unread: string[] }> =>
  keptStore<{ versions: string[]; unread: string[] }>(db, 'repository/review-baselines', HISTORY_PAGE_KEPT_MS, debug)
// What a repository's dependency review read of GitHub (pull-dependencies.ts
// LockfileStore): the lockfiles a commit lists (`listings`), by the commit,
// and a lockfile's packages with what their reviews are held to
// (`lockfiles`), by its blob, which never change: kept as its history's
// pages are, apart from a scan's (scanReadStore), which reads them without
// what their reviews are held to.
export const lockfileReadStore = <T>(db: UpstreamCacheStore, type: 'listings' | 'lockfiles', debug = false): KeptStore<T> =>
  keptStore<T>(db, `repository/review-${type}`, HISTORY_PAGE_KEPT_MS, debug)
