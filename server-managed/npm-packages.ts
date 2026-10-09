// The managed npm package viewer: a published version's files, read from the
// registry's tarball, for the Overview and Code tabs the bundle view shows.
//
// Anyone with workspace access may read a public package. A private one also
// needs NPM_TOKEN on the server, and a reader with access to it: an admin or
// manager, or a member of a visible team listing its scope (team-npm-scopes.ts).
// For everyone else, a version is public only when the registry answers for
// it without credentials, asked on every request and never from a cache:
// upstream reads tarballs from caches an admin's read or a bundle build may
// have filled using the token, so the absence of a token proves nothing. The
// tarball is then held to the integrity that anonymous answer gives.
import { Buffer } from 'node:buffer'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import { HttpError, getTarball } from '@preventive/upstream/npm.js'
import { getRepo } from '@preventive/upstream/package.js'
import { isNpmPackageName, isNpmPackageSpec, npmPackageScope } from '../common/managed/npm-packages.js'
import type { Role } from '../common/managed/roles.ts'

export const NPM_REGISTRY = 'https://registry.npmjs.org'
const VERSION_DOCUMENT_BYTES = 8 * 1024 * 1024
// Abbreviated packuments of packages with thousands of versions run to tens of MiB.
const PACKUMENT_BYTES = 64 * 1024 * 1024
const REGISTRY_TIMEOUT_MS = 30_000
// What a package may unpack to: the files' bytes, their count, and the tar
// stream holding them, headers and padding included.
export const MAX_NPM_PACKAGE_BYTES = 64 * 1024 * 1024
export const MAX_NPM_PACKAGE_FILES = 20_000
const MAX_TAR_BYTES = 96 * 1024 * 1024
// Loads in flight per process; each can hold a tarball, its tar and its files.
const MAX_ACTIVE_LOADS = 4

const gunzipAsync = promisify(gunzip)

export class NpmPackageError extends Error {
  status: number
  constructor(status: number, code: string) { super(code); this.status = status }
}

// Who reads, as the session has it now: the role, and the scopes of the
// visible teams they are a member of.
export interface NpmReader { role: Role; scopes: ReadonlySet<string> }

// Whether a reader may have a package read with the server's token.
export function canReadPrivateNpm(reader: NpmReader, name: string): boolean {
  if (reader.role === 'admin' || reader.role === 'manage') return true
  const scope = npmPackageScope(name)
  return scope !== null && reader.scopes.has(scope)
}

const npmToken = () => process.env['NPM_TOKEN'] || null

function registryUrl(name: string, spec?: string): string {
  return `${NPM_REGISTRY}/${name}${spec === undefined ? '' : `/${encodeURIComponent(spec)}`}`
}

async function readLimited(res: Response, limit: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length'))
  if (declared > limit) { await res.body?.cancel(); throw new NpmPackageError(502, 'upstream-too-large') }
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength
    if (size > limit) throw new NpmPackageError(502, 'upstream-too-large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

// A registry document, or null where the registry has none for this caller:
// 404, or 401/403 as it answers some private packages asked anonymously.
// Credentials go only with `token`; nothing is cached on either side.
async function registryDocument(url: string, { token, accept, limit, signal }: { token: string | null; accept: string; limit: number; signal: AbortSignal }): Promise<Record<string, unknown> | null> {
  let res: Response
  try {
    res = await fetch(url, {
      headers: { accept, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(REGISTRY_TIMEOUT_MS)]),
    })
  } catch (err) {
    if (signal.aborted) throw err
    throw new NpmPackageError(502, 'upstream-unavailable')
  }
  if ([401, 403, 404].includes(res.status)) { await res.body?.cancel(); return null }
  if (!res.ok) { await res.body?.cancel(); throw new NpmPackageError(502, 'upstream-unavailable') }
  try {
    const json = JSON.parse((await readLimited(res, limit)).toString('utf8')) as unknown
    if (json && typeof json === 'object' && !Array.isArray(json)) return json as Record<string, unknown>
  } catch (err) {
    if (err instanceof NpmPackageError) throw err
  }
  throw new NpmPackageError(502, 'upstream-invalid')
}

// Asked anonymously first: a reader without private access stops there. One
// with it asks again with the token, where there is one and the package is
// scoped (npm's private packages always are), and the answer is private.
async function readDocument(name: string, url: string, privileged: boolean, options: { accept: string; limit: number; signal: AbortSignal }) {
  const open = await registryDocument(url, { ...options, token: null })
  if (open) return { json: open, private: false }
  const token = npmToken()
  if (!privileged || !token || npmPackageScope(name) === null) return null
  const json = await registryDocument(url, { ...options, token })
  return json ? { json, private: true } : null
}

export interface NpmVersionDocument {
  name: string
  version: string
  private: boolean
  dist: { tarball: string; integrity: string; unpackedSize: number | null; fileCount: number | null }
  manifest: Record<string, unknown>
}

const plainObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const stringRecord = (value: unknown) => plainObject(value)
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'string')) as Record<string, string> : undefined

// The fields the Overview shows, in the shapes package.json gives them; each
// left out where the document has none, or has another shape.
function manifestOf(json: Record<string, unknown>): Record<string, unknown> {
  const pick: Record<string, unknown> = {}
  for (const key of ['description', 'license', 'homepage', 'main', 'module', 'types', 'type', 'deprecated', 'gitHead']) {
    if (typeof json[key] === 'string') pick[key] = json[key]
  }
  const author = json['author']
  if (typeof author === 'string') pick['author'] = author
  else if (plainObject(author) && typeof author['name'] === 'string') pick['author'] = author['name']
  if (Array.isArray(json['keywords'])) pick['keywords'] = json['keywords'].filter(item => typeof item === 'string').slice(0, 50)
  if (typeof json['bin'] === 'string') pick['bin'] = { [String(json['name'])]: json['bin'] }
  else if (stringRecord(json['bin'])) pick['bin'] = stringRecord(json['bin'])
  for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies', 'engines']) {
    const record = stringRecord(json[key])
    if (record && Object.keys(record).length > 0) pick[key] = record
  }
  if (json['hasInstallScript'] === true) pick['hasInstallScript'] = true
  const scripts = stringRecord(json['scripts'])
  const install = scripts ? ['preinstall', 'install', 'postinstall', 'prepare'].filter(script => script in scripts) : []
  if (install.length > 0) pick['installScripts'] = Object.fromEntries(install.map(script => [script, scripts![script]]))
  try {
    const repo = getRepo(json)
    if (repo.github) pick['github'] = { github: repo.github, ...(repo.directory === undefined ? {} : { directory: repo.directory }) }
  } catch {}
  return pick
}

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null

// The version a spec names, a dist-tag resolved by the registry, with its
// dist. Null where the registry has none for this reader.
export async function readNpmVersion(name: string, spec: string, privileged: boolean, signal: AbortSignal): Promise<NpmVersionDocument | null> {
  if (!isNpmPackageName(name) || !isNpmPackageSpec(spec)) throw new NpmPackageError(400, 'bad-package')
  const found = await readDocument(name, registryUrl(name, spec), privileged, { accept: 'application/json', limit: VERSION_DOCUMENT_BYTES, signal })
  if (!found) return null
  const { json } = found
  const dist = json['dist']
  if (json['name'] !== name || typeof json['version'] !== 'string' || !isNpmPackageSpec(json['version']) || !plainObject(dist)
      || typeof dist['tarball'] !== 'string' || typeof dist['integrity'] !== 'string') throw new NpmPackageError(502, 'upstream-invalid')
  return {
    name, version: json['version'], private: found.private,
    dist: { tarball: dist['tarball'], integrity: dist['integrity'], unpackedSize: count(dist['unpackedSize']), fileCount: count(dist['fileCount']) },
    manifest: manifestOf(json),
  }
}

// The package's dist-tags and versions, newest published first, from its
// abbreviated document. Null where the registry has none for this reader.
export async function readNpmVersions(name: string, privileged: boolean, signal: AbortSignal) {
  if (!isNpmPackageName(name)) throw new NpmPackageError(400, 'bad-package')
  const found = await readDocument(name, registryUrl(name), privileged, { accept: 'application/vnd.npm.install-v1+json', limit: PACKUMENT_BYTES, signal })
  if (!found) return null
  const { json } = found
  if (json['name'] !== name || !plainObject(json['versions'])) throw new NpmPackageError(502, 'upstream-invalid')
  const versions = Object.keys(json['versions']).filter(isNpmPackageSpec).toReversed()
  const distTags = Object.fromEntries(Object.entries(stringRecord(json['dist-tags']) ?? {}).filter(([, version]) => versions.includes(version)))
  return { name, private: found.private, distTags, versions }
}

export interface NpmPackageFile { path: string; bytes: Uint8Array }

const textOf = (bytes: Uint8Array, start: number, length: number) => {
  const field = bytes.subarray(start, start + length)
  const end = field.indexOf(0)
  return Buffer.from(end === -1 ? field : field.subarray(0, end)).toString('utf8')
}

function sizeOf(bytes: Uint8Array, offset: number): number {
  // GNU base-256 for sizes past the 11 octal digits.
  if (bytes[offset]! & 0x80) {
    let size = bytes[offset]! & 0x7f
    for (let i = 1; i < 12; i++) size = size * 256 + bytes[offset + i]!
    return size
  }
  const text = textOf(bytes, offset, 12).trim()
  return /^[0-7]+$/u.test(text) ? Number.parseInt(text, 8) : Number.NaN
}

// The path a package's file is installed at: npm drops the first component
// (`package/`, or whatever the archive used), and a path that would escape the
// package, or names nothing, is not extracted.
function packagePath(raw: string): string | null {
  const parts = raw.split('/').slice(1).filter(part => part !== '' && part !== '.')
  return parts.length === 0 || parts.includes('..') ? null : parts.join('/')
}

function paxPath(data: Uint8Array): string | null {
  let path = null
  let at = 0
  const text = Buffer.from(data).toString('utf8')
  while (at < text.length) {
    const space = text.indexOf(' ', at)
    const length = Number.parseInt(text.slice(at, space), 10)
    if (space === -1 || !Number.isSafeInteger(length) || length <= 0) break
    const record = text.slice(space + 1, at + length - 1)
    if (record.startsWith('path=')) path = record.slice(5)
    at += length
  }
  return path
}

// The regular files of a tar stream, by package path, a later entry
// replacing an earlier one as extraction would. Directories, links and
// devices hold no file content and are skipped.
export function readNpmTar(tar: Uint8Array): NpmPackageFile[] {
  const files = new Map<string, Uint8Array>()
  let total = 0
  let longName: string | null = null
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const size = sizeOf(header, 124)
    const type = String.fromCodePoint(header[156]!)
    const start = offset + 512
    if (!Number.isSafeInteger(size) || size < 0 || start + size > tar.length) throw new NpmPackageError(422, 'bad-tarball')
    const data = tar.subarray(start, start + size)
    offset = start + Math.ceil(size / 512) * 512
    if (type === 'x' || type === 'L') { longName = type === 'x' ? paxPath(data) : textOf(data, 0, data.length); continue }
    if (type === 'g' || type === 'K') continue
    const prefix = textOf(header, 257, 6) === 'ustar' ? textOf(header, 345, 155) : ''
    const name = longName ?? (prefix ? `${prefix}/${textOf(header, 0, 100)}` : textOf(header, 0, 100))
    longName = null
    if (!['0', '\0', '7'].includes(type)) continue
    const path = packagePath(name)
    if (path === null) continue
    total += size - (files.get(path)?.length ?? 0)
    files.set(path, data)
    if (files.size > MAX_NPM_PACKAGE_FILES || total > MAX_NPM_PACKAGE_BYTES) throw new NpmPackageError(413, 'package-too-large')
  }
  return [...files].map(([path, bytes]) => ({ path, bytes })).toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

const loads = new Map<string, Promise<{ tarball: Uint8Array; files: NpmPackageFile[] }>>()

// The version's tarball and files. Upstream checks the bytes against the
// dist's integrity wherever it reads them from; loads of one tarball share
// the work while it is in flight, and nothing is kept after.
export function loadNpmPackage(doc: NpmVersionDocument): Promise<{ tarball: Uint8Array; files: NpmPackageFile[] }> {
  const { unpackedSize, fileCount } = doc.dist
  if ((unpackedSize ?? 0) > MAX_NPM_PACKAGE_BYTES || (fileCount ?? 0) > MAX_NPM_PACKAGE_FILES) {
    return Promise.reject(new NpmPackageError(413, 'package-too-large'))
  }
  const key = `${doc.dist.integrity} ${doc.dist.tarball}`
  const pending = loads.get(key)
  if (pending) return pending
  if (loads.size >= MAX_ACTIVE_LOADS) return Promise.reject(new NpmPackageError(429, 'npm-busy'))
  const job = (async () => {
    let tarball: Uint8Array
    try { tarball = await getTarball(doc.name, doc.version, { tarball: doc.dist.tarball, integrity: doc.dist.integrity }) }
    catch (err) {
      if (err instanceof HttpError && err.status === 404) throw new NpmPackageError(404, 'package-not-found')
      throw new NpmPackageError(502, 'upstream-unavailable')
    }
    let tar: Buffer
    try { tar = await gunzipAsync(tarball, { maxOutputLength: MAX_TAR_BYTES }) }
    catch (err) {
      throw new NpmPackageError((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 413 : 422,
        (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'package-too-large' : 'bad-tarball')
    }
    return { tarball, files: readNpmTar(tar) }
  })()
  loads.set(key, job)
  job.finally(() => loads.delete(key)).catch(() => {})
  return job
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// A file's text, or null for bytes that are not UTF-8 text.
export function npmFileText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null
  try { return utf8.decode(bytes) } catch { return null }
}

// The tarball's filename as `npm pack` writes it.
export function npmTarballFilename(name: string, version: string): string {
  return `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`
}
