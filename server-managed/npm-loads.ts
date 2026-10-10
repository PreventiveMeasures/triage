// Loading a published version for the npm package viewer (npm-packages.ts):
// its tarball, kept on disk as bundle builds keep theirs, else read from the
// registry, and the viewer's response built from it, each shared by the
// readers asking for it meanwhile and held to a few at once per process.
import { Buffer } from 'node:buffer'
import { constants } from 'node:fs'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import { encodeBrotli } from './brotli.ts'
import { MAX_NPM_PACKAGE_BYTES, MAX_NPM_PACKAGE_FILES, NPM_REGISTRY, NpmPackageError, type NpmPackageFile, type NpmVersionDocument,
  npmFileRows, npmToken, readLimited, readNpmTar } from './npm-packages.ts'

// The tar stream a package's files may come in, headers and padding included.
// A tarball larger than that cannot unpack within it, so it is refused as it
// arrives.
export const MAX_TAR_BYTES = 96 * 1024 * 1024
const TARBALL_TIMEOUT_MS = 120_000
// Loads in flight per process; each can hold a tarball, its tar, its files
// and their encoded JSON.
const MAX_ACTIVE_LOADS = 4

const gunzipAsync = promisify(gunzip)

// A load's result, shared by its readers, and a reader's release of it.
export interface NpmLoad<T> { result: Promise<T>; release: () => void }

interface Load { job: Promise<unknown>; readers: number; settled: boolean }

// Loads by what they read; readers asking for the same share one. A load
// keeps its place among the active ones until its work is done and each
// reader has released it, as a reader does once its response is written or
// abandoned, so what responses still hold counts too.
const loads = new Map<string, Load>()

const refused = <T>(status: number, code: string): NpmLoad<T> => {
  const result = Promise.reject(new NpmPackageError(status, code))
  result.catch(() => {})
  return { result, release() {} }
}

function shared<T>(key: string, doc: NpmVersionDocument, work: () => Promise<T>): NpmLoad<T> {
  const { unpackedSize, fileCount } = doc.dist
  if ((unpackedSize ?? 0) > MAX_NPM_PACKAGE_BYTES || (fileCount ?? 0) > MAX_NPM_PACKAGE_FILES) return refused(413, 'package-too-large')
  let load = loads.get(key)
  if (!load) {
    if (loads.size >= MAX_ACTIVE_LOADS) return refused(429, 'npm-busy')
    const created: Load = { job: work(), readers: 0, settled: false }
    const settle = () => {
      created.settled = true
      if (created.readers === 0 && loads.get(key) === created) loads.delete(key)
    }
    created.job.then(settle, settle)
    loads.set(key, created)
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
      if (--held.readers === 0 && held.settled && loads.get(key) === held) loads.delete(key)
    },
  }
}

// The sha512 an integrity names, in base64, or null where it names none.
const sha512Of = (integrity: string) => /(?:^|\s)sha512-([\d+/A-Za-z]{86}==)(?=\s|$)/u.exec(integrity)?.[1] ?? null
// Hashed off the event loop: a tarball runs to tens of MiB.
const sha512 = async (bytes: Uint8Array) => Buffer.from(await crypto.subtle.digest('SHA-512', bytes as Uint8Array<ArrayBuffer>)).toString('base64')

// Upstream's disk cache (setCacheDir), where tarballs are kept between
// loads, or null to keep none and read none.
let tarballCache: string | null = null
let tmpSeq = 0

export function setNpmTarballCache(dir: string | null) {
  tarballCache = dir === null ? null : resolve(dir)
}

// The file upstream keeps a version's tarball in, as its cachePath names
// it: `@babel+core@7.29.7.tgz`, a capital written `!` and the letter, and a
// Windows device name's first letter escaped.
function keptTarballPath(root: string, name: string, version: string): string {
  const file = encodeURIComponent(`${name}@${version}.tgz`.replaceAll(/[!A-Z]/gu, char => `!${char.toLowerCase()}`))
    .replaceAll('%40', '@').replaceAll('%2F', '+')
    .replace(/^(?=(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$))./u, char => `%${char.codePointAt(0)!.toString(16).toUpperCase()}`)
  return join(root, 'npm', 'tarballs', file)
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

// A kept file, where it is a regular file within the tar stream's bound,
// checked on the file as opened (a FIFO or device would block or never
// end), and read to the size it had then.
async function readKept(path: string): Promise<Uint8Array | null> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => null)
  if (!handle) return null
  try {
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size > MAX_TAR_BYTES) return null
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

async function keep(path: string, bytes: Uint8Array) {
  const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(tmp, bytes)
    await rename(tmp, path)
  } catch { await rm(tmp, { force: true }).catch(() => {}) }
}

// The version's tarball from the registry, at the package's own path: with
// the token only for a private version, and its size bounded as it arrives.
async function downloadTarball(url: string, isPrivate: boolean): Promise<Buffer> {
  const token = isPrivate ? npmToken() : null
  let res: Response
  try {
    res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, redirect: 'error', signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS) })
  } catch { throw new NpmPackageError(502, 'upstream-unavailable') }
  if ([401, 403, 404].includes(res.status)) { await res.body?.cancel(); throw new NpmPackageError(404, 'package-not-found') }
  if (!res.ok) { await res.body?.cancel(); throw new NpmPackageError(502, 'upstream-unavailable') }
  try { return await readLimited(res, MAX_TAR_BYTES) }
  catch (err) {
    if (err instanceof NpmPackageError) throw new NpmPackageError(413, 'package-too-large')
    throw new NpmPackageError(502, 'upstream-unavailable')
  }
}

// The version's tarball, its bytes held to the document's sha512 wherever
// they come from: kept in the cache, where bundle builds keep what they
// fetch with the token, or in npm's; else downloaded, and then kept. Bytes
// matching the sha512 the reader's own document names are the tarball that
// reader may download, wherever they were kept and whoever fetched them.
async function readTarball(doc: NpmVersionDocument): Promise<Uint8Array> {
  const expected = sha512Of(doc.dist.integrity), url = doc.dist.tarball
  if (!url.startsWith(`${NPM_REGISTRY}/${doc.name}/-/`) || URL.parse(url)?.href !== url || expected === null) throw new NpmPackageError(502, 'upstream-invalid')
  const kept = tarballCache === null ? null : keptTarballPath(tarballCache, doc.name, doc.version)
  if (kept !== null) {
    for (const path of [kept, npmCachePath(expected)]) {
      const bytes = path === null ? null : await readKept(path)
      if (bytes && await sha512(bytes) === expected) return bytes
    }
  }
  const bytes = await downloadTarball(url, doc.private)
  if (await sha512(bytes) !== expected) throw new NpmPackageError(502, 'upstream-invalid')
  if (kept !== null) await keep(kept, bytes)
  return bytes
}

async function readFiles(tarball: Uint8Array): Promise<NpmPackageFile[]> {
  let tar: Buffer
  try { tar = await gunzipAsync(tarball, { maxOutputLength: MAX_TAR_BYTES }) }
  catch (err) {
    throw new NpmPackageError((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 413 : 422,
      (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'package-too-large' : 'bad-tarball')
  }
  return readNpmTar(tar)
}

// The version's tarball, for download.
export function loadNpmTarball(doc: NpmVersionDocument): NpmLoad<Uint8Array> {
  return shared(`tarball ${doc.dist.integrity} ${doc.dist.tarball}`, doc, () => readTarball(doc))
}

// The version's files, for one of them to be pretty-printed (pretty-print.ts).
export function loadNpmFiles(doc: NpmVersionDocument): NpmLoad<NpmPackageFile[]> {
  return shared(`files ${doc.dist.integrity} ${doc.dist.tarball}`, doc, async () => readFiles(await readTarball(doc)))
}

// The version as the viewer reads it, as brotli-encoded JSON: `{ name,
// version, private, integrity, tarballSize, manifest, files }`, its files as
// npmFileRows gives them. Encoding is where a load holds the most, so it
// takes its place among the active loads until its body is done, and readers
// asking meanwhile share that body, the first one's manifest in it; nothing
// is kept once its readers are done.
export function loadNpmPackageBody(doc: NpmVersionDocument): NpmLoad<Buffer> {
  return shared(`package ${doc.dist.integrity} ${doc.dist.tarball} ${doc.private}`, doc, async () => {
    const tarball = await readTarball(doc)
    const files = await readFiles(tarball)
    return encodeBrotli(Buffer.from(JSON.stringify({
      name: doc.name, version: doc.version, private: doc.private, integrity: doc.dist.integrity, tarballSize: tarball.byteLength,
      manifest: doc.manifest, files: npmFileRows(files),
    })))
  })
}
