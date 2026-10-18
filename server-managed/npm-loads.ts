// Loading a published version for the npm package viewer (npm-packages.ts):
// its tarball, kept on disk as bundle builds keep theirs, else read from the
// registry, its files unpacked from it, and the viewer's response built from
// them, each shared by the readers asking for it meanwhile and held to a few
// versions at once per process; its files kept a little while after.
import { Buffer } from 'node:buffer'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { CompressionError, decompress } from '@preventive/archive/compression.js'
import { encodeBrotli } from './brotli.ts'
import { keptBriefly } from './kept-briefly.ts'
import { MAX_NPM_PACKAGE_BYTES, MAX_NPM_PACKAGE_FILES, NPM_REGISTRY, NpmPackageError, type NpmPackageFile, type NpmVersionDocument, type TarReading,
  askUpstream, npmFileRows, npmPublishTime, npmToken, readNpmTar } from './npm-packages.ts'
import { keepFile, readKeptFile, upstreamCachePath } from './upstream-cache.ts'

// The tar stream a package's files may come in, headers and padding included.
// A tarball larger than that cannot unpack within it, so it is refused as it
// arrives.
export const MAX_TAR_BYTES = 96 * 1024 * 1024
const TARBALL_TIMEOUT_MS = 120_000
// Loads in flight per process, those of one version (its tarball, its files,
// its response) as one, as they read its tarball and unpack it once between
// them; each can hold a tarball, its tar, its files and their encoded JSON.
const MAX_ACTIVE_LOADS = 4
// How long a public version's files are kept once unpacked, and what they
// may take between them, the least lately read going first past it:
// Compare's requests for a pair of versions, and the Code tab's, come one
// after another, each loading the same files. A private version's are never
// kept, as nothing else of it is past its readers.
const UNPACKED_KEPT_MS = 60_000
const MAX_UNPACKED_BYTES = 128 * 1024 * 1024

// A load's result, shared by its readers, and a reader's release of it.
export interface NpmLoad<T> { result: Promise<T>; release: () => void }

interface Load { job: Promise<unknown>; readers: number; settled: boolean; slot: string }

// Loads by what they read; readers asking for the same share one. A load
// keeps its place among the active ones until its work is done and each
// reader has released it, as a reader does once its response is written or
// abandoned, so what responses still hold counts too. Places by the slot
// their loads share, with how many hold each.
const loads = new Map<string, Load>()
const slots = new Map<string, number>()

const refused = <T>(status: number, code: string): NpmLoad<T> => {
  const result = Promise.reject(new NpmPackageError(status, code))
  result.catch(() => {})
  return { result, release() {} }
}

// What names a version's tarball, and so its files: its integrity and URL,
// and whether it is read with the token.
const tarballKey = (doc: NpmVersionDocument) => `${doc.dist.integrity} ${doc.dist.tarball} ${doc.private}`

function shared<T>(what: string, doc: NpmVersionDocument, work: () => Promise<T>): NpmLoad<T> {
  const { unpackedSize, fileCount } = doc.dist
  if ((unpackedSize ?? 0) > MAX_NPM_PACKAGE_BYTES || (fileCount ?? 0) > MAX_NPM_PACKAGE_FILES) return refused(413, 'package-too-large')
  const slot = tarballKey(doc)
  return sharedLoad(`${what} ${slot}`, work, 'npm-busy', slot)
}

// A load among the active ones, by `key`, refused as `busy` past them: a
// repository directory's (repository-code.ts) as a package's, each holding
// alike a tarball, its tar, its files and their encoded JSON. Loads of one
// `slot` take one place between them.
export function sharedLoad<T>(key: string, work: () => Promise<T>, busy: string, slot = key): NpmLoad<T> {
  let load = loads.get(key)
  if (!load) {
    if (!slots.has(slot) && slots.size >= MAX_ACTIVE_LOADS) return refused(429, busy)
    const created: Load = { job: work(), readers: 0, settled: false, slot }
    const finish = () => { settle(key, created) }
    created.job.then(finish, finish)
    loads.set(key, created)
    slots.set(slot, (slots.get(slot) ?? 0) + 1)
    load = created
  }
  const held = load
  held.readers++
  let released = false
  return {
    result: held.job as Promise<T>,
    release() {
      if (released) return
      released = true
      held.readers--
      done(key, held)
    },
  }
}

function settle(key: string, load: Load) {
  load.settled = true
  done(key, load)
}

// A load gone from the active ones, and its place with it, once its work is
// done and its readers have released it.
function done(key: string, load: Load) {
  if (load.readers !== 0 || !load.settled || loads.get(key) !== load) return
  loads.delete(key)
  const holding = slots.get(load.slot)! - 1
  if (holding === 0) slots.delete(load.slot)
  else slots.set(load.slot, holding)
}

// The sha512 an integrity names, in base64, or null where it names none.
const sha512Of = (integrity: string) => /(?:^|\s)sha512-([\d+/A-Za-z]{86}==)(?=\s|$)/u.exec(integrity)?.[1] ?? null
// Hashed off the event loop: a tarball runs to tens of MiB.
const sha512 = async (bytes: Uint8Array) => Buffer.from(await crypto.subtle.digest('SHA-512', bytes as Uint8Array<ArrayBuffer>)).toString('base64')

// Upstream's disk cache (setCacheDir), where tarballs are kept between
// loads, or null to keep none and read none.
let tarballCache: string | null = null

export function setNpmTarballCache(dir: string | null) {
  tarballCache = dir === null ? null : resolve(dir)
}

// Where npm's own cache files content by its sha512, short of an .npmrc
// moving the cache.
function npmCachePath(hash: string): string | null {
  const configured = process.env['npm_config_cache'] || process.env['NPM_CONFIG_CACHE']
  let root
  try {
    root = configured ? resolve(configured.replace(/^~(?=[/\\])/u, homedir()))
      : process.platform === 'win32' ? join(process.env['LOCALAPPDATA'] || homedir(), 'npm-cache') : join(homedir(), '.npm')
  } catch { return null }
  const hex = Buffer.from(hash, 'base64').toString('hex')
  return join(root, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4))
}

// The version's tarball from the registry, at the package's own path: with
// the token only for a private version, and its size bounded as it arrives.
async function downloadTarball(url: string, isPrivate: boolean): Promise<Buffer> {
  const token = isPrivate ? npmToken() : null
  const bytes = await askUpstream(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, limit: MAX_TAR_BYTES, ms: TARBALL_TIMEOUT_MS, absent: [401, 403, 404] })
    .catch((err: unknown) => { throw err instanceof NpmPackageError && err.message === 'upstream-too-large' ? new NpmPackageError(413, 'package-too-large') : err })
  if (bytes === null) throw new NpmPackageError(404, 'package-not-found')
  return bytes
}

// The version's tarball, its bytes held to the document's sha512 wherever
// they come from: kept in the cache, where bundle builds keep what they
// fetch with the token, or in npm's; else downloaded, and then kept. Bytes
// matching the sha512 the reader's own document names are the tarball that
// reader may download, wherever they were kept and whoever fetched them.
async function readTarball(doc: NpmVersionDocument): Promise<Uint8Array> {
  const expected = sha512Of(doc.dist.integrity), url = doc.dist.tarball
  if (!url.startsWith(`${NPM_REGISTRY}/${doc.name}/-/`) || URL.parse(url)?.href !== url || expected === null) throw new NpmPackageError(502, 'upstream-invalid')
  const kept = tarballCache === null ? null : upstreamCachePath(tarballCache, 'npm/tarballs', `${doc.name}@${doc.version}.tgz`)
  if (kept !== null) {
    for (const path of [kept, npmCachePath(expected)]) {
      const bytes = path === null ? null : await readKeptFile(path, MAX_TAR_BYTES)
      if (bytes && await sha512(bytes) === expected) return bytes
    }
  }
  const bytes = await downloadTarball(url, doc.private)
  if (await sha512(bytes) !== expected) throw new NpmPackageError(502, 'upstream-invalid')
  if (kept !== null) await keepFile(kept, bytes)
  return bytes
}

// Tarballs being read, and versions' files being unpacked, by what names
// them (tarballKey): readers asking for one meanwhile share it, its bytes
// those each one's own document names.
const reading = new Map<string, Promise<Uint8Array>>()
const unpacking = new Map<string, Promise<Unpacked>>()

function sharedRead<T>(pending: Map<string, Promise<T>>, key: string, read: () => Promise<T>): Promise<T> {
  let job = pending.get(key)
  if (!job) {
    const started = read().finally(() => { if (pending.get(key) === started) pending.delete(key) })
    pending.set(key, job = started)
  }
  return job
}

const sharedTarball = (doc: NpmVersionDocument) => sharedRead(reading, tarballKey(doc), () => readTarball(doc))

// A version's files, and the size of the tarball they came in.
interface Unpacked { files: NpmPackageFile[]; tarballSize: number }

// Public versions' files lately unpacked, by tarballKey.
const unpacked = keptBriefly<Unpacked>({ keptMs: UNPACKED_KEPT_MS, maxBytes: MAX_UNPACKED_BYTES })

// The version's files, kept from a load of them a little while since, else
// unpacked from its tarball (and kept, a public version's): bytes its
// reader's own document names, as its tarball's are.
function unpackedOf(doc: NpmVersionDocument): Promise<Unpacked> {
  const key = tarballKey(doc)
  const kept = unpacked.get(key)
  if (kept) return Promise.resolve(kept)
  return sharedRead(unpacking, key, async () => {
    const tarball = await sharedTarball(doc)
    const value = { files: await readTarballFiles(tarball), tarballSize: tarball.byteLength }
    if (!doc.private) unpacked.keep(key, value, value.files.reduce((sum, file) => sum + file.path.length + file.bytes.byteLength, 0))
    return value
  })
}

// A gzipped tarball's files, its top directory left out, as npm extracts
// a package's: a repository tree's as GitHub archives it, too, its symlinks
// let climb as readNpmTar's `symlinksAbove` says, and its tar stream and
// files bounded as `options` give, a package's bounds unless given.
export async function readTarballFiles(tarball: Uint8Array, { maxTarBytes = MAX_TAR_BYTES, ...options }: TarReading & { maxTarBytes?: number } = {}): Promise<NpmPackageFile[]> {
  let tar: Uint8Array
  try { tar = await decompress(tarball, 'gzip', { limit: maxTarBytes }) }
  catch (err) {
    const limited = err instanceof CompressionError && err.limited
    throw new NpmPackageError(limited ? 413 : 422, limited ? 'package-too-large' : 'bad-tarball')
  }
  return readNpmTar(tar, options)
}

// The version's tarball, for download.
export function loadNpmTarball(doc: NpmVersionDocument): NpmLoad<Uint8Array> {
  return shared('tarball', doc, () => sharedTarball(doc))
}

// The version's files, for one of them to be pretty-printed (pretty-print.ts).
export function loadNpmFiles(doc: NpmVersionDocument): NpmLoad<NpmPackageFile[]> {
  return shared('files', doc, async () => (await unpackedOf(doc)).files)
}

// The version as the viewer reads it, as brotli-encoded JSON: `{ name,
// version, private, integrity, tarballSize, published, manifest, files,
// known }`, its files as npmFileRows gives them, and with them, as its files
// are encoded, when it was published where that is kept (`published`, asked
// then, else null) and what `known` gives: what is kept about its package
// (npm-insights.ts npmKnown), which the viewer need not then ask for. Encoding
// is where a load holds the most, so it takes its place among the active
// loads until its body is done, and readers asking meanwhile share that body,
// the first one's manifest, `published` and `known` in it; the body is not
// kept once its readers are done, its files a little while (unpackedOf).
export function loadNpmPackageBody(doc: NpmVersionDocument, known: () => object = () => ({}),
  published: () => Promise<string | null> = npmPublishTime(doc).read): NpmLoad<Buffer> {
  return shared('package', doc, async () => {
    const { files, tarballSize } = await unpackedOf(doc)
    return encodeBrotli(Buffer.from(JSON.stringify({
      name: doc.name, version: doc.version, private: doc.private, integrity: doc.dist.integrity, tarballSize,
      published: await published(), manifest: doc.manifest, files: npmFileRows(files), known: known(),
    })))
  })
}
