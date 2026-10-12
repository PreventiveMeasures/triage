// What risk asks npm for, each kept in the caller's cache where it gives one
// (`cache`, as @preventive/upstream's CacheStore: `read(type, key)` and
// `write(type, key, value)`, each type its caller's to keep where it will):
//
// - `npm/tarballs`, `<name>@<version>`: a version's tarball, its bytes, as
//   upstream's getTarball keeps one, checked against its integrity.
// - `risk/npm/versions`, `<name>@<version>`: what a version's document says,
//   which npm never changes once published: its manifest (manifest.js, its
//   deprecation aside), when it was published, and its dist.
// - `risk/npm/packages`, `<name>`: the versions npm says are deprecated, and
//   when its first version was published, as `at` a time, asked again after
//   an hour, as npm deprecates a version any time.
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
// packages' documents itself (`packument`), as the managed server does,
// within the bounds it holds every read of npm to. What risk asks npm itself
// is read no further than its bounds, `upstream-too-large` past them, as is a
// tarball unpacking past tarball.js's, `package-too-large`.
import { getTarball } from '@preventive/upstream/npm.js'
import { npmVersionManifest } from './manifest.js'
import { npmTarballVersion } from './tarball.js'
import { DAY_MS } from './downloads.js'

const REGISTRY = 'https://registry.npmjs.org'
const DOWNLOADS = 'https://api.npmjs.org/downloads/range'
const PACKAGE_MS = 60 * 60_000
// How much of npm's answers is read: a whole document, as the managed server
// reads one (server-managed/npm-packages.ts PACKUMENT_BYTES), and a few
// months' downloads a day.
const PACKUMENT_BYTES = 64 * 1024 * 1024
const DOWNLOADS_BYTES = 1024 * 1024

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

// A package's whole document, null where npm has none for this asker: the
// caller's (`packument`) where it gives one, else risk's own.
async function packageDocument(name, { packument, signal }, authorized) {
  if (packument) return packument(name, { authorized, signal })
  const secret = authorized && name.startsWith('@') ? token() : null
  const res = await fetch(`${REGISTRY}/${name}`, { headers: { accept: 'application/json', ...secret && { authorization: `Bearer ${secret}` } }, redirect: 'error', signal })
  if (res.status === 404) { await res.body?.cancel(); return null }
  if (!res.ok) { await res.body?.cancel(); throw new NpmRiskError('upstream-unavailable', `npm answered ${res.status} for ${name}`) }
  return jsonOf(res, PACKUMENT_BYTES, name)
}

// When a document says its package's first version was published, one since
// unpublished among them: the earliest time it lists.
const firstPublished = doc => Object.entries(doc?.time ?? {}).filter(([key, at]) => key !== 'modified' && isTime(at)).map(([, at]) => at)
  .reduce((first, at) => first === null || Date.parse(at) < Date.parse(first) ? at : first, null)

// What risk reads of `versions` of a package, and of the package: `versions`,
// each one's `{ manifest, published, dist }`, `deprecated`, by version, and
// `created`, when its first version was published.
export async function npmPackageFacts(name, versions, context) {
  const { cache, now } = context
  const [facts, pkg] = await Promise.all([Promise.all(versions.map(version => cache ? cache.read('risk/npm/versions', `${name}@${version}`) : null)),
    cache ? cache.read('risk/npm/packages', name) : null])
  if (facts.every(Boolean) && pkg && now - pkg.at < PACKAGE_MS) return { versions: new Map(versions.map((version, i) => [version, facts[i]])), deprecated: pkg.deprecated, created: pkg.created }
  const doc = await packageDocument(name, context, true)
  if (!doc) throw new NpmRiskError('package-not-found', `npm has no package ${name}`)
  const read = new Map(versions.map(version => {
    const json = doc.versions?.[version]
    if (!json) throw new NpmRiskError('version-not-found', `npm has no ${name}@${version}`)
    const { deprecated: _, ...manifest } = npmVersionManifest(json)
    return [version, { manifest, published: isTime(doc.time?.[version]) ? doc.time[version] : null, dist: { tarball: json.dist?.tarball, integrity: json.dist?.integrity } }]
  }))
  const deprecated = Object.fromEntries(Object.entries(doc.versions ?? {}).filter(([, json]) => typeof json?.deprecated === 'string' && json.deprecated !== '').map(([version, json]) => [version, json.deprecated]))
  const created = firstPublished(doc)
  if (cache) {
    await Promise.all([...read].map(([version, fact]) => cache.write('risk/npm/versions', `${name}@${version}`, fact)))
    await cache.write('risk/npm/packages', name, { at: now, deprecated, created })
  }
  return { versions: read, deprecated, created }
}

// A version's files, as compare.js takes a version, from its tarball
// (tarball.js), with `npm` its `{ name, version, manifest, published }`.
export async function npmVersionFiles(name, version, { manifest, published, dist }, { cache, signal }) {
  const what = `${name}@${version}`
  const tarball = await getTarball(name, version, dist, cache === undefined ? {} : { cache }).catch(error => {
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
    const res = await fetch(`${DOWNLOADS}/${range}/${encoded(name)}`, { headers: { accept: 'application/json' }, redirect: 'error', signal: context.signal })
    if (res.status === 404) { await res.body?.cancel(); return { none: true } }
    if (!res.ok) { await res.body?.cancel(); throw new NpmRiskError('upstream-unavailable', `npm's downloads answered ${res.status} for ${name}`) }
    const json = await jsonOf(res, DOWNLOADS_BYTES, `${name}'s downloads`)
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
