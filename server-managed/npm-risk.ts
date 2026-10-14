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
// - `risk/npm/downloads`, a package's downloads a day, which risk keys by the
//   days they count, so a day: a public package's in the database too, so
//   that another instance, or this one restarted, asks npm's downloads API,
//   which answers some 40 lookups a minute, none of them again that day,
//   each removed two days on (npm-kept.ts pruneKept); a private one's in
//   memory.
// - `risk/npm/packages`, `risk/npm/public` and `risk/npm/advisories`, kept an
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
import { DEFAULT_MINIMUM_RELEASE_AGE, type NpmAssessment, assessNpm, npmReadyDownload, npmReadyDownloads } from '../risk/index.js'
import { CacheMissError, type CacheStorage } from './cache-storage.ts'
import { loadNpmTarball } from './npm-loads.ts'
import { NpmPackageError, type NpmVersionDocument, readNpmPackument, readNpmVersion } from './npm-packages.ts'
import { npmPackageScope } from '../common/managed/npm-packages.js'
import { pruneKept } from './npm-kept.ts'
import type { UpstreamCacheStore } from './upstream-cache.ts'

const MEMORY_ENTRIES = 2000
// As npm-loads.ts MAX_ACTIVE_LOADS.
const MAX_ACTIVE_ASSESSMENTS = 4
// Of them, those no reader waits on (`spare`), such as a scan's: the rest are
// left for readers.
export const MAX_SPARE_ASSESSMENTS = 2
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
// What of a public package is kept in the database, and for how long its
// downloads are, a day's for a day more.
const IN_DATABASE = new Set(['risk/npm/versions', 'risk/npm/downloads'])
const DOWNLOADS_KEPT_MS = 2 * 24 * 60 * 60_000

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
        if (isPublic && IN_DATABASE.has(type)) { const value = await db.getUpstreamCacheEntry(`${type}/${key}`); return value === null ? null : JSON.parse(value) }
      } catch (error) { if (!(error instanceof CacheMissError)) warn('read', error); return null }
      return memory.get(`${isPublic ? '' : 'private\0'}${type}\0${key}`)?.value ?? null
    },
    async write(type, key, value) {
      if (type === 'npm/tarballs') return
      try {
        if (isPublic && type === 'risk/npm/assessments' && npmCache) { await npmCache.put(hashed(type, key), Buffer.from(JSON.stringify(value))); return }
        if (isPublic && IN_DATABASE.has(type)) {
          const at = Date.now()
          await db.setUpstreamCacheEntry(`${type}/${key}`, JSON.stringify(value), at)
          if (type === 'risk/npm/downloads') await pruneKept(db, `${type}/`, DOWNLOADS_KEPT_MS, at, error => { warn('prune', error) })
          return
        }
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
// reader's readNpmVersion read it, or against the one risk picks of its
// versions (`'pick'`, assessNpm `oldVersion: true`), its document read as the
// open version's is where its tarball is wanted: trusted however new and however few
// download it where a team lists its scope (`teamScoped`), its own packages;
// else held to risk's minimum release age and flagged as unpopular. A new
// dependency on a package of a scope a team lists (`ownScope`, asked once a
// scope) is told no tier nor age, as an own package. Its
// documents are read with npm's token where the reader may have it
// (`privileged`, as readNpmVersion), its dependencies' without; what is kept
// of it is shared only where neither version is private, and OSV is asked of
// its advisories only where it isn't, a private package's name never sent to
// OSV, as it never is to Socket (http.ts). A `spare` one, no
// reader waiting on it, is made only within MAX_SPARE_ASSESSMENTS, and tells
// its dependencies without asking npm of their packages (assessNpm
// `dependencies`), nor its advisories, which a scan asks of a lockfile's
// packages at once (repository-risk.ts).
export function npmRisk(doc: NpmVersionDocument, old: NpmVersionDocument | 'pick' | null,
  { teamScoped, ownScope = () => Promise.resolve(false), fromEmpty = false, privileged, signal, spare = false, ...stores }: NpmRiskStores & { teamScoped: boolean;
    ownScope?: (scope: string) => Promise<boolean>; fromEmpty?: boolean; privileged: boolean; signal: AbortSignal; spare?: boolean }): Promise<NpmAssessment> {
  const scopes = new Map<string, Promise<boolean>>()
  const owned = (name: string) => {
    const scope = npmPackageScope(name)
    if (scope === null) return false
    if (!scopes.has(scope)) scopes.set(scope, ownScope(scope))
    return scopes.get(scope)!
  }
  const given = old === 'pick' ? null : old
  const documentOf = async (version: string) => [doc, given].find(read => read?.version === version) ?? await readNpmVersion(doc.name, version, privileged, signal) ?? undefined
  return bounded(spare, () => assessNpm(doc.name, doc.version, { oldVersion: old === 'pick' ? true : old?.version ?? null, fromEmpty,
    minimumReleaseAge: teamScoped ? 0 : DEFAULT_MINIMUM_RELEASE_AGE,
    popularity: !teamScoped, cache: npmRiskCache(stores, !doc.private && !given?.private), signal, dependencies: !spare, advisories: !spare, osv: !doc.private, owned,
    packument: (name, { authorized }) => readNpmPackument(name, privileged && authorized, signal),
    tarball: async (_name, version) => tarballOf(await documentOf(version), signal) }))
}

// An assessment made within MAX_ACTIVE_ASSESSMENTS, a `spare` one within
// MAX_SPARE_ASSESSMENTS, all across the server; one past them refused as
// busy (`npm-busy`).
async function bounded(spare: boolean, assess: () => Promise<NpmAssessment>): Promise<NpmAssessment> {
  if (assessing >= (spare ? MAX_SPARE_ASSESSMENTS : MAX_ACTIVE_ASSESSMENTS)) throw new NpmPackageError(429, 'npm-busy')
  assessing++
  try { return await assess() } finally { assessing-- }
}

// A version npm has no document of, as risk tells one npm removed, as it
// removes every one it finds malware in (assessNpm): its package taken down
// by npm, as a scan's (`spare`), and its advisories of malware, npm's and,
// where anyone can read its package, OSV's, which alone has some of those
// npm removed (nx's), a private package's name never sent to OSV. Its
// package's document read anonymously, else with npm's token where the
// reader may have it (`privileged`), and kept as a private package's is; no
// tarball read, nothing of the version being left. Spare, within
// MAX_SPARE_ASSESSMENTS as a scan's others are. An NpmRiskError where
// nothing tells of it.
export function npmRiskRemoved(name: string, version: string,
  { teamScoped, privileged, signal, ...stores }: NpmRiskStores & { teamScoped: boolean; privileged: boolean; signal: AbortSignal }): Promise<NpmAssessment> {
  return bounded(true, async () => {
    const open = await readNpmPackument(name, false, signal)
    return assessNpm(name, version, { minimumReleaseAge: teamScoped ? 0 : DEFAULT_MINIMUM_RELEASE_AGE, popularity: false, downloads: false, dependencies: false,
      osv: open !== null, cache: npmRiskCache(stores, false), signal,
      packument: (read, { authorized }) => read === name && open ? Promise.resolve(open) : readNpmPackument(read, privileged && authorized, signal),
      tarball: () => Promise.reject(new NpmPackageError(502, 'upstream-invalid')) })
  })
}

// What a scan readies before assessing its packages (repository-risk.ts):
// their downloads, as risk asks them, kept where a public package's are
// (npmRiskCache), so that their assessments wait on npm's downloads API for
// none. At once, those kept and unscoped ones, in bulk; each other one on its
// own (npmReadyScanDownload).
export const npmReadyScanDownloads = (names: string[], ready: (name: string) => void, stores: NpmRiskStores, signal: AbortSignal) =>
  npmReadyDownloads(names, ready, { cache: npmRiskCache(stores, true), signal })
export const npmReadyScanDownload = (name: string, stores: NpmRiskStores, signal: AbortSignal) =>
  npmReadyDownload(name, { cache: npmRiskCache(stores, true), signal })
