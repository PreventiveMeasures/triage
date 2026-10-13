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
// - `npm/tarballs`: none asked, as tarballs are read as the viewer's loads
//   read them, kept where they keep them (npm-loads.ts loadNpmTarball), and
//   an assessment kept needs none.
//
// What memory keeps is held to 2,000 records and 64 MiB as JSON, the first
// kept going first.
//
// A cache failure is a miss, never a failed assessment. Packages' documents
// are read as every other npm document here is, within their bounds and
// shared budget (npm-packages.ts readNpmPackument), and tarballs as the
// viewer's loads read them, bounded as they arrive and among the loads made
// at once. Assessments made at once are bounded as those loads are, each
// unpacking up to two tarballs: one past them is refused as busy.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { buffer } from 'node:stream/consumers'
import type { CacheStore } from '@preventive/upstream/npm.js'
import { DEFAULT_MINIMUM_RELEASE_AGE, type NpmAssessment, assessNpm } from '../risk/index.js'
import { CacheMissError, type CacheStorage } from './cache-storage.ts'
import { loadNpmTarball } from './npm-loads.ts'
import { NpmPackageError, type NpmVersionDocument, readNpmPackument } from './npm-packages.ts'
import type { UpstreamCacheStore } from './upstream-cache.ts'

const MEMORY_ENTRIES = 2000
// As npm-loads.ts MAX_ACTIVE_LOADS.
const MAX_ACTIVE_ASSESSMENTS = 4
let assessing = 0
// What memory holds at most, by its records' length as JSON: the first kept
// go first past it, and a record past an eighth of it isn't kept at all.
const MEMORY_LENGTH = 64 * 1024 * 1024
let memoryLength = 0
const memory = new Map<string, { value: unknown; length: number }>()
function forget(key: string) {
  const kept = memory.get(key)
  if (!kept) return
  memory.delete(key)
  memoryLength -= kept.length
}
function remember(key: string, value: unknown) {
  forget(key)
  const length = JSON.stringify(value)?.length ?? 0
  if (length > MEMORY_LENGTH / 8) return
  memory.set(key, { value, length })
  memoryLength += length
  while (memory.size > MEMORY_ENTRIES || memoryLength > MEMORY_LENGTH) forget(memory.keys().next().value!)
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
      return memory.get(`${isPublic ? '' : 'private\0'}${type}\0${key}`)?.value ?? null
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

// A version's tarball as the viewer's loads read it (npm-loads.ts), its bytes
// held to the integrity its reader's document names: given up on, and the
// load released, once `signal` aborts, the load going on for its other
// readers, so that a reader gone holds no assessment's place.
async function tarballOf(doc: NpmVersionDocument | undefined, signal: AbortSignal): Promise<Uint8Array> {
  if (!doc) throw new NpmPackageError(502, 'upstream-invalid')
  signal.throwIfAborted()
  const load = loadNpmTarball(doc)
  let onAbort = () => {}
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener('abort', onAbort, { once: true }) })
  try { return await Promise.race([load.result, aborted]) } finally {
    signal.removeEventListener('abort', onAbort)
    load.release()
  }
}

// The version `doc` names assessed against `old`'s, where given, each as the
// reader's readNpmVersion read it: trusted however new and however few
// download it where a team lists its scope (`teamScoped`), its own packages;
// else held to risk's minimum release age and flagged as unpopular. Its documents are read with npm's token where the reader may have it
// (`privileged`, as readNpmVersion), its dependencies' without; what is kept
// of it is shared only where neither version is private.
export async function npmRisk(doc: NpmVersionDocument, old: NpmVersionDocument | null,
  { teamScoped, privileged, signal, ...stores }: NpmRiskStores & { teamScoped: boolean; privileged: boolean; signal: AbortSignal }): Promise<NpmAssessment> {
  if (assessing >= MAX_ACTIVE_ASSESSMENTS) throw new NpmPackageError(429, 'npm-busy')
  assessing++
  try {
    return await assessNpm(doc.name, doc.version, { oldVersion: old?.version ?? null, minimumReleaseAge: teamScoped ? 0 : DEFAULT_MINIMUM_RELEASE_AGE, popularity: !teamScoped,
      cache: npmRiskCache(stores, !doc.private && !old?.private), signal,
      packument: (name, { authorized }) => readNpmPackument(name, privileged && authorized, signal),
      tarball: (_name, version) => tarballOf([doc, old].find(read => read?.version === version) ?? undefined, signal) })
  } finally { assessing-- }
}
