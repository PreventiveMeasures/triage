// Loading a published version for the npm package viewer (npm-packages.ts):
// its tarball, read from the registry alone, and the viewer's response built
// from it, each shared by the readers asking for it meanwhile and held to a
// few at once per process.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
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

// The version's tarball, from the registry alone, at the package's own path:
// with the token only for a private version, its size bounded as it arrives,
// and its bytes held to the document's sha512.
async function readTarball(doc: NpmVersionDocument): Promise<Uint8Array> {
  const expected = sha512Of(doc.dist.integrity), url = doc.dist.tarball
  if (!url.startsWith(`${NPM_REGISTRY}/${doc.name}/-/`) || URL.parse(url)?.href !== url || expected === null) throw new NpmPackageError(502, 'upstream-invalid')
  const token = doc.private ? npmToken() : null
  let res: Response
  try {
    res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, redirect: 'error', signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS) })
  } catch { throw new NpmPackageError(502, 'upstream-unavailable') }
  if ([401, 403, 404].includes(res.status)) { await res.body?.cancel(); throw new NpmPackageError(404, 'package-not-found') }
  if (!res.ok) { await res.body?.cancel(); throw new NpmPackageError(502, 'upstream-unavailable') }
  let bytes: Buffer
  try { bytes = await readLimited(res, MAX_TAR_BYTES) }
  catch (err) {
    if (err instanceof NpmPackageError) throw new NpmPackageError(413, 'package-too-large')
    throw new NpmPackageError(502, 'upstream-unavailable')
  }
  if (createHash('sha512').update(bytes).digest('base64') !== expected) throw new NpmPackageError(502, 'upstream-invalid')
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
