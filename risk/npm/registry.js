// What risk asks npm for, each kept in the caller's cache where it gives one
// (`cache`, as @preventive/upstream's CacheStore: `read(type, key)` and
// `write(type, key, value)`, each type its caller's to keep where it will):
//
// - `npm/tarballs`, `<name>@<version>`: a version's tarball, its bytes, as
//   upstream's getTarball keeps one, checked against its integrity.
// - `risk/npm/versions`, `<name>@<version>`: what a version's document says,
//   which npm never changes once published: its manifest (manifest.js, its
//   deprecation aside), when it was published, and its dist.
// - `risk/npm/packages`, `<name>`: the versions npm says are deprecated, as
//   `at` a time, asked again after an hour, as npm deprecates a version any
//   time.
// - `risk/npm/old-versions`, `<name>@<version>`: the version it is compared
//   with where risk picks it (old-version.js npmOldVersion), or none, as `at`
//   a time, picked again after an hour, as npm publishes and deprecates
//   versions any time and those it has grow older.
// - `risk/npm/public`, `<name>`: when a package anyone can read was first
//   published, or `{ missing: true }`, as `at` a time, asked again after an
//   hour.
// - `risk/npm/downloads`, `<name>@<from>:<to>`: its downloads a day over those
//   days, `{ start, end, days }`, or `{ none: true }` where npm counts none.
//
// The package assessed is asked for as upstream asks, with the npm token the
// environment has for a scoped one (PREVENTIVE_MEASURES_NPM_TOKEN,
// STASIS_NPM_TOKEN or NPM_TOKEN), so a private one can be read; its
// dependencies' public facts and downloads with none. A caller may ask for
// packages' documents (`packument`) and versions' tarballs (`tarball`)
// itself, as the managed server does, within the bounds it holds every read
// of npm to; else a tarball is upstream's getTarball's, bounded as upstream
// bounds it. What risk asks npm itself is given up on after 30 seconds, and
// read no further than its bounds, `upstream-too-large` past them, as is a
// tarball unpacking past tarball.js's, `package-too-large`.
import { advisories } from '@preventive/upstream/advisories.js'
import { getTarball } from '@preventive/upstream/npm.js'
import { npmVersionManifest } from './manifest.js'
import { npmPlaceholder } from './malware.js'
import { npmOldVersion } from './old-version.js'
import { npmTarballVersion } from './tarball.js'
import { DAY_MS } from './downloads.js'

const REGISTRY = 'https://registry.npmjs.org'
const DOWNLOADS = 'https://api.npmjs.org/downloads/range'
const PACKAGE_MS = 60 * 60_000
// How long a version's advisories are kept, as the managed server keeps a
// package's and a lockfile's: an hour, as a new one may come at any time.
const ADVISORIES_MS = 60 * 60_000
// How much of npm's answers is read: a whole document, as the managed server
// reads one (server-managed/npm-packages.ts PACKUMENT_BYTES), and a few
// months' downloads a day.
const PACKUMENT_BYTES = 64 * 1024 * 1024
const DOWNLOADS_BYTES = 1024 * 1024
// How long npm is waited on for an answer, as the managed server waits on its
// upstreams (server-managed/npm-packages.ts askUpstream).
const REQUEST_MS = 30_000

export class NpmRiskError extends Error {
  constructor(code, message = code) { super(message); this.code = code }
}

const isTime = value => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value))
// A scoped name in a downloads API path, its slash escaped.
const encoded = name => name.replace('/', '%2f')
const token = () => typeof process === 'undefined' ? null
  : ['PREVENTIVE_MEASURES_NPM_TOKEN', 'STASIS_NPM_TOKEN', 'NPM_TOKEN'].map(key => process.env[key]).find(Boolean) ?? null

// A value kept under `type` and `key`, else `ask`ed and kept; one `fresh`
// says is stale asked again.
async function kept({ cache }, type, key, ask, fresh = () => true) {
  const hit = cache ? await cache.read(type, key) : null
  if (hit != null && fresh(hit)) return hit
  const value = await ask()
  if (cache && value != null) await cache.write(type, key, value)
  return value
}

// An answer's body as JSON, read no further than `limit` bytes.
async function jsonOf(res, limit, what) {
  const tooLarge = () => new NpmRiskError('upstream-too-large', `npm's answer for ${what} is over ${limit} bytes`)
  if (Number(res.headers.get('content-length')) > limit) { await res.body?.cancel(); throw tooLarge() }
  const chunks = []
  let size = 0
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength
    if (size > limit) throw tooLarge()
    chunks.push(chunk)
  }
  try { return JSON.parse(await new Blob(chunks).text()) } catch { throw new NpmRiskError('upstream-invalid', `npm's answer for ${what} isn't JSON`) }
}

// What npm answers `url` as JSON (jsonOf), null where it answers 404; given up
// on after REQUEST_MS, or once the caller's `signal` aborts, its abort
// rethrown as it is. `upstream-busy` where npm asks to be asked later (429),
// as its downloads API does past a burst of requests;
// `upstream-unavailable` where it can't be asked or answers otherwise.
async function askNpm(url, headers, limit, what, { signal }) {
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(REQUEST_MS), ...signal ? [signal] : []]) })
    if (res.status === 404) { await res.body?.cancel(); return null }
    if (!res.ok) { await res.body?.cancel(); throw new NpmRiskError(res.status === 429 ? 'upstream-busy' : 'upstream-unavailable', `npm answered ${res.status} for ${what}`) }
    return await jsonOf(res, limit, what)
  } catch (error) {
    if (error instanceof NpmRiskError || signal?.aborted) throw error
    throw new NpmRiskError('upstream-unavailable', `npm couldn't be asked for ${what}: ${error.message}`)
  }
}

// A package's whole document, null where npm has none for this asker: the
// caller's (`packument`) where it gives one, else risk's own.
function packageDocument(name, context, authorized) {
  if (context.packument) return context.packument(name, { authorized, signal: context.signal })
  const secret = authorized && name.startsWith('@') ? token() : null
  return askNpm(`${REGISTRY}/${name}`, secret ? { authorization: `Bearer ${secret}` } : {}, PACKUMENT_BYTES, name, context)
}

// When a document says its package's first version was published, one since
// unpublished among them: the earliest time it lists.
const firstPublished = doc => Object.entries(doc?.time ?? {}).filter(([key, at]) => key !== 'modified' && isTime(at)).map(([, at]) => at)
  .reduce((first, at) => first === null || Date.parse(at) < Date.parse(first) ? at : first, null)

// Each version a package's document lists, as old-version.js npmOldVersion
// picks among them: `{ version, published, publisher, known, deprecated,
// removed }`, its publisher's account as manifest.js reads it, and whether
// that is known; and each it lists a time of and no document, as one since
// removed from npm, `removed`, its time alone, as npmPackageFacts reads none
// of it. Its times' other keys (`created`, `modified`) are no versions.
const releasesOf = (doc, deprecated) => [...new Set([...Object.keys(doc.versions ?? {}), ...Object.keys(doc.time ?? {})])].map(version => {
  const json = doc.versions?.[version]
  const { publisher = null, knownAccounts } = json ? npmVersionManifest(json) : {}
  return { version, published: isTime(doc.time?.[version]) ? doc.time[version] : null, publisher, known: Boolean(knownAccounts),
    deprecated: Object.hasOwn(deprecated, version), removed: !json }
})

// What risk reads of `version` of a package, of the one it is compared with
// (`oldVersion`: one, null for none, or true for the one old-version.js
// npmOldVersion picks of its versions, by its document), and of the package:
// `versions`, each one's `{ manifest, published, dist }`, those of them npm
// removed since they were published (`removed`, each one's when), none
// picked to compare a removed one with, `deprecated`, by version, whether
// npm's security team took the package down (`takenDown`, its latest version
// npm's placeholder, malware.js npmPlaceholder), and `oldVersion`, the one
// compared with or null. Its document is read once at most, and not at all
// where all of it is kept and fresh. A version's facts are kept for good, as
// npm never changes a version, but npm may remove it: the package's, kept an
// hour, has which it removed, and they go by that.
export async function npmPackageFacts(name, version, oldVersion, context) {
  const { cache, now } = context
  const fresh = hit => hit != null && now - hit.at < PACKAGE_MS
  const picked = cache && oldVersion === true ? await cache.read('risk/npm/old-versions', `${name}@${version}`) : null
  const given = oldVersion === true ? fresh(picked) ? picked.oldVersion : undefined : oldVersion
  if (cache && given !== undefined) {
    const wanted = given === null ? [version] : [version, given]
    const [facts, pkg] = await Promise.all([Promise.all(wanted.map(at => cache.read('risk/npm/versions', `${name}@${at}`))), cache.read('risk/npm/packages', name)])
    const gone = at => Object.hasOwn(pkg.removed, at)
    if (fresh(pkg) && 'removed' in pkg && wanted.every((at, i) => facts[i] || gone(at))) {
      return { versions: new Map(wanted.flatMap((at, i) => gone(at) ? [] : [[at, facts[i]]])), removed: new Map(wanted.filter(gone).map(at => [at, pkg.removed[at]])),
        deprecated: pkg.deprecated, takenDown: pkg.takenDown, oldVersion: given }
    }
  }
  const doc = await packageDocument(name, context, true)
  if (!doc) throw new NpmRiskError('package-not-found', `npm has no package ${name}`)
  const removed = new Map()
  const factsOf = at => {
    const json = doc.versions?.[at]
    if (!json && isTime(doc.time?.[at])) { removed.set(at, doc.time[at]); return null }
    if (!json) throw new NpmRiskError('version-not-found', `npm has no ${name}@${at}`)
    const { deprecated: _, ...manifest } = npmVersionManifest(json)
    return { manifest, published: isTime(doc.time?.[at]) ? doc.time[at] : null, dist: { tarball: json.dist?.tarball, integrity: json.dist?.integrity } }
  }
  const opened = factsOf(version)
  const deprecated = Object.fromEntries(Object.entries(doc.versions ?? {}).filter(([, json]) => typeof json?.deprecated === 'string' && json.deprecated !== '').map(([at, json]) => [at, json.deprecated]))
  const old = oldVersion === true ? opened && npmOldVersion(version, releasesOf(doc, deprecated), now) : oldVersion
  const read = new Map([...opened ? [[version, opened]] : [], ...old === null ? [] : [[old, factsOf(old)]]].filter(([, fact]) => fact))
  const takenDown = npmPlaceholder(doc.versions?.[doc['dist-tags']?.latest])
  if (cache) {
    const gone = Object.fromEntries(Object.entries(doc.time ?? {}).filter(([at, when]) => at !== 'created' && at !== 'modified' && isTime(when) && !doc.versions?.[at]))
    await Promise.all([...read].map(([at, fact]) => cache.write('risk/npm/versions', `${name}@${at}`, fact)))
    await cache.write('risk/npm/packages', name, { at: now, deprecated, takenDown, removed: gone })
    if (oldVersion === true) await cache.write('risk/npm/old-versions', `${name}@${version}`, { at: now, oldVersion: old })
  }
  return { versions: read, removed, deprecated, takenDown, oldVersion: old }
}

// npm's advisories of `version` of a package, as `npm audit` asks them
// (upstream's `advisories`), each `{ id, url?, title?, cwe }`: kept
// ADVISORIES_MS, and given up on once `signal` aborts.
export async function npmVersionAdvisories(name, version, context) {
  const what = `${name}@${version}`
  const { rows } = await kept(context, 'risk/npm/advisories', what, async () => {
    context.signal?.throwIfAborted()
    const asked = await untilAborted(advisories([{ ecosystem: 'npm', name, versions: [version] }], { cache: false }), context.signal).catch(error => {
      throw context.signal?.aborted ? error : new NpmRiskError(error?.status === 429 ? 'upstream-busy' : 'upstream-unavailable', `npm's advisories of ${what} couldn't be had: ${error.message}`)
    })
    return { at: context.now, rows: asked.map(({ id, url, title, cwe }) => ({ id, ...url ? { url } : {}, ...title ? { title } : {}, cwe })) }
  }, hit => context.now - hit.at < ADVISORIES_MS)
  return rows
}

// `promise`, given up on once `signal` aborts, its reason thrown: what it
// waits on, which takes no signal (upstream's getTarball), left to settle
// unheeded.
function untilAborted(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

// A version's files, as compare.js takes a version, from its tarball
// (tarball.js): the caller's (`tarball`) where it gives one, its failures
// thrown as they are, else upstream's, given up on once `signal` aborts; with
// `npm` its `{ name, version, manifest, published }`.
export async function npmVersionFiles(name, version, { manifest, published, dist }, { cache, tarball: read, signal }) {
  const what = `${name}@${version}`
  signal?.throwIfAborted()
  const tarball = read ? await read(name, version, { signal }) : await untilAborted(getTarball(name, version, dist, cache === undefined ? {} : { cache }), signal).catch(error => {
    throw signal?.aborted ? error : new NpmRiskError('upstream-unavailable', `npm's tarball of ${what} couldn't be had: ${error.message}`)
  })
  try { return { npm: { name, version, manifest, published }, ...await npmTarballVersion(tarball) } } catch (error) {
    throw new NpmRiskError(error.message === 'package-too-large' ? 'package-too-large' : 'upstream-invalid', `npm's tarball of ${what}: ${error.message}`)
  }
}

// When a package anyone can read was first published, `{ created }`, or null
// for one npm has none of for anyone.
export async function npmPublicFacts(name, context) {
  const facts = await kept(context, 'risk/npm/public', name,
    async () => { const doc = await packageDocument(name, context, false); return doc ? { at: context.now, created: firstPublished(doc) } : { at: context.now, missing: true } },
    hit => context.now - hit.at < PACKAGE_MS)
  return facts.missing ? null : { created: facts.created }
}

// The days a package's downloads are asked over at `now`: from the first of
// the month before last to yesterday, as the npm viewer asks them.
const day = time => new Date(time).toISOString().slice(0, 10)
function rangeAt(now) {
  const today = new Date(now)
  return `${day(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 2, 1))}:${day(now - DAY_MS)}`
}

// A package's downloads a day over rangeAt's days, `{ start, end, days }`,
// null where npm counts none.
export async function npmDownloads(name, context) {
  const range = rangeAt(context.now)
  const answer = await kept(context, 'risk/npm/downloads', `${name}@${range}`, async () => {
    const json = await askNpm(`${DOWNLOADS}/${range}/${encoded(name)}`, {}, DOWNLOADS_BYTES, `${name}'s downloads`, context)
    if (json === null) return { none: true }
    const start = Date.parse(json.start)
    const length = Math.round((Date.parse(json.end) - start) / DAY_MS) + 1
    const days = Array.from({ length: Number.isSafeInteger(length) && length > 0 && length <= 400 ? length : 0 }, () => 0)
    for (const row of json.downloads ?? []) {
      const at = Math.round((Date.parse(row.day) - start) / DAY_MS)
      if (at >= 0 && at < days.length && Number.isSafeInteger(row.downloads)) days[at] = row.downloads
    }
    return { start: json.start, end: json.end, days }
  })
  return answer.none ? null : answer
}
