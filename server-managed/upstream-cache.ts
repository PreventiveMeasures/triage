import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'
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
  // Removes those under `prefix` (no LIKE wildcard in it) kept before `before`;
  // how many.
  deleteUpstreamCacheEntries(prefix: string, before: number): Promise<number>
}

export function upstreamCacheMethods(db: ManagedSql): UpstreamCacheStore {
  const get = db.prepare('SELECT value FROM managed_upstream_cache WHERE cache_key = ?')
  const getMany = db.prepare('SELECT cache_key, value FROM managed_upstream_cache WHERE cache_key IN (SELECT value FROM json_each(?))')
  // A slower concurrent audit cannot replace a newer listing with an older one.
  const set = db.prepare(`INSERT INTO managed_upstream_cache (cache_key, value, cached_at) VALUES (?, ?, ?)
    ON CONFLICT (cache_key) DO UPDATE SET value = excluded.value, cached_at = excluded.cached_at
    WHERE managed_upstream_cache.cached_at <= excluded.cached_at`)
  const remove = db.prepare('DELETE FROM managed_upstream_cache WHERE cache_key LIKE ? AND cached_at < ?')
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
    async deleteUpstreamCacheEntries(prefix, before) {
      return Number((await remove.run(`${prefix}%`, before)).changes)
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

// The file upstream keeps `file` in, under `dir` of its disk cache
// (setCacheDir), as its cachePath names it: `@babel+core@7.29.7.tgz`, a
// capital written `!` and the letter, and a Windows device name's first
// letter escaped.
export function upstreamCachePath(root: string, dir: string, file: string): string {
  const name = encodeURIComponent(file.replaceAll(/[!A-Z]/gu, char => `!${char.toLowerCase()}`))
    .replaceAll('%40', '@').replaceAll('%2F', '+')
    .replace(/^(?=(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$))./u, char => `%${char.codePointAt(0)!.toString(16).toUpperCase()}`)
  return join(root, dir, name)
}

// A kept file, where it is a regular file of at most `max` bytes, checked on
// the file as opened (a FIFO or device would block or never end), and read
// to the size it had then.
export async function readKeptFile(path: string, max: number): Promise<Uint8Array | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null)
  if (!handle) return null
  try {
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size > max) return null
    const bytes = Buffer.allocUnsafe(stats.size)
    for (let at = 0; at < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, at, bytes.length - at, at)
      if (bytesRead === 0) return null
      at += bytesRead
    }
    return bytes
  } catch { return null }
  finally { await handle.close() }
}

// `bytes` kept at `path`, written whole beside it first and then moved in, so a
// reader finds the old file or the new one, never part of one; a failure
// keeps nothing.
let tmpSeq = 0
export async function keepFile(path: string, bytes: Uint8Array) {
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, bytes)
    await rename(tmp, path)
  } catch { await rm(tmp, { force: true }).catch(() => {}) }
}

const gunzipAsync = promisify(gunzip)
const gzipAsync = promisify(gzip)

// An upstream's JSON object kept with its ETag, gzipped, as keepJson keeps it:
// `{ etag, json }`, or null where none is kept, or what is can't be read
// within `limit` bytes.
export async function readKeptJson(path: string, limit: number): Promise<{ etag: string; json: Record<string, unknown> } | null> {
  const bytes = await readKeptFile(path, limit)
  if (!bytes) return null
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  try {
    const kept: unknown = JSON.parse((await gunzipAsync(bytes, { maxOutputLength: limit + 1024 })).toString('utf8'))
    return object(kept) && typeof kept['etag'] === 'string' && object(kept['json']) ? { etag: kept['etag'], json: kept['json'] } : null
  } catch { return null }
}

// `body`, an upstream's JSON object as it wrote it, kept with its `etag`.
export async function keepJson(path: string, etag: string, body: Buffer) {
  await keepFile(path, await gzipAsync(Buffer.concat([Buffer.from(`{"etag":${JSON.stringify(etag)},"json":`), body, Buffer.from('}')])))
}

// A kept listing is read to no more than this, gzipped or not: one runs to
// some hundreds of KiB.
const LISTING_BYTES = 64 * 1024 * 1024

// A repository's listing as last kept where audits keep them (auditCache),
// however old, for when GitHub can't be reached to refresh it: `at`, when it
// was kept, and `cache`, a store answering it to upstream as kept just now,
// so that upstream takes it rather than ask GitHub, and keeping nothing.
// Upstream checks it as it checks its own. Null where none is kept, or it
// can't be read.
export async function lastListing(cacheDir: string | null | undefined, db: UpstreamCacheStore, repo: string, debug = false): Promise<{ at: number; cache: CacheStore } | null> {
  const key = repo.toLowerCase()
  let kept: { at?: unknown } | null
  try {
    if (cacheDir) {
      const bytes = await readKeptFile(upstreamCachePath(cacheDir, CACHED_TYPE, `${key}.json.gz`), LISTING_BYTES)
      kept = bytes && JSON.parse((await gunzipAsync(bytes, { maxOutputLength: LISTING_BYTES })).toString('utf8'))
    } else {
      const value = await db.getUpstreamCacheEntry(`${CACHED_TYPE}/${key}`)
      kept = value === null ? null : JSON.parse(value)
    }
  } catch (error) {
    if (debug) console.warn('managed: kept listing read failed:', error)
    return null
  }
  const at = kept?.at
  if (typeof at !== 'number') return null
  return { at, cache: {
    read: (type, name) => Promise.resolve(type === CACHED_TYPE && name === key ? { ...kept, at: Date.now() } : null),
    write: () => Promise.resolve(),
  } }
}
