// What calls for a look at an npm version, as risk tells it (risk/), for the
// managed viewer: risk is asked on the server alone, its records kept where
// each belongs by its type (risk/npm/registry.js, assess.js):
//
// - `risk/npm/assessments`, what of an assessment holds whatever the time:
//   a public package's in the public npm cache, as its pretty-printed files
//   are (storage-payload.ts PUBLIC_CACHE), by a hash of its key; a private
//   one's in this instance's memory alone.
// - `risk/npm/versions`, what a version's document says, which npm never
//   changes once published: a public package's in the database's upstream
//   cache table, shared by every instance; a private one's in memory.
// - `risk/npm/packages`, `risk/npm/public` and `risk/npm/downloads`, kept an
//   hour or a day by risk itself: in memory.
// - `npm/tarballs`: none kept, upstream reading npm's own cache first, as an
//   assessment kept needs none.
//
// A cache failure is a miss, never a failed assessment.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { buffer } from 'node:stream/consumers'
import type { CacheStore } from '@preventive/upstream/npm.js'
import { DEFAULT_MINIMUM_RELEASE_AGE, type NpmAssessment, assessNpm } from '../risk/index.js'
import { CacheMissError, type CacheStorage } from './cache-storage.ts'
import type { UpstreamCacheStore } from './upstream-cache.ts'

const MEMORY_ENTRIES = 2000
const memory = new Map<string, unknown>()
function remember(key: string, value: unknown) {
  memory.delete(key)
  memory.set(key, value)
  while (memory.size > MEMORY_ENTRIES) memory.delete(memory.keys().next().value!)
}

const hashed = (type: string, key: string) => `risk/${createHash('sha256').update(`${type}\0${key}`).digest('hex')}`

export interface NpmRiskStores {
  db: UpstreamCacheStore
  npmCache?: CacheStorage | undefined
  debug?: boolean | undefined
}

// Risk's cache for one package: `isPublic` whether anyone can read it, so
// that what is kept of it can be shared.
export function npmRiskCache({ db, npmCache, debug }: NpmRiskStores, isPublic: boolean): CacheStore {
  const warn = (what: string, error: unknown) => { if (debug) console.warn(`managed: risk cache ${what} failed:`, error) }
  return {
    async read(type, key) {
      if (type === 'npm/tarballs') return null
      try {
        if (isPublic && type === 'risk/npm/assessments' && npmCache) return JSON.parse((await buffer((await npmCache.open(hashed(type, key))).stream)).toString('utf8'))
        if (isPublic && type === 'risk/npm/versions') { const value = await db.getUpstreamCacheEntry(`${type}/${key}`); return value === null ? null : JSON.parse(value) }
      } catch (error) { if (!(error instanceof CacheMissError)) warn('read', error); return null }
      return memory.get(`${isPublic ? '' : 'private\0'}${type}\0${key}`) ?? null
    },
    async write(type, key, value) {
      if (type === 'npm/tarballs') return
      try {
        if (isPublic && type === 'risk/npm/assessments' && npmCache) { await npmCache.put(hashed(type, key), Buffer.from(JSON.stringify(value))); return }
        if (isPublic && type === 'risk/npm/versions') { await db.setUpstreamCacheEntry(`${type}/${key}`, JSON.stringify(value), Date.now()); return }
      } catch (error) { warn('write', error); return }
      remember(`${isPublic ? '' : 'private\0'}${type}\0${key}`, value)
    },
  }
}

// `version` of package `name` assessed against `oldVersion`, where given:
// trusted however new where a team lists its scope (`teamScoped`), its own
// packages; else held to risk's minimum release age.
export function npmRisk(name: string, version: string, oldVersion: string | null,
  { teamScoped, isPublic, signal, ...stores }: NpmRiskStores & { teamScoped: boolean; isPublic: boolean; signal: AbortSignal }): Promise<NpmAssessment> {
  return assessNpm(name, version, { oldVersion, minimumReleaseAge: teamScoped ? 0 : DEFAULT_MINIMUM_RELEASE_AGE, cache: npmRiskCache(stores, isPublic), signal })
}
