// The managed npm package viewer: a published version's files, read from the
// registry's tarball, for the Overview and Code tabs the bundle view shows.
//
// Anyone with workspace access may read a public package. A private one also
// needs NPM_TOKEN on the server, and a reader with access to it: an admin or
// manager, or a member of a visible team listing its scope (team-npm-scopes.ts).
// For everyone else, a version is public only when the registry answers for
// it without credentials, asked on every request and never from a cache:
// upstream's caches, which bundle builds fill using the token, hold no
// answer here. Its tarball may come from them (npm-loads.ts), as only bytes
// matching the integrity that anonymous answer gives are served; else it is
// read without credentials too, and held to that integrity.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { getRepo } from '@preventive/upstream/package.js'
import { isNpmPackageName, isNpmPackageSpec, npmPackageScope } from '../common/managed/npm-packages.js'
import type { Role } from '../common/managed/roles.ts'

export const NPM_REGISTRY = 'https://registry.npmjs.org'
const VERSION_DOCUMENT_BYTES = 8 * 1024 * 1024
// Abbreviated packuments of packages with thousands of versions run to tens of MiB.
const PACKUMENT_BYTES = 64 * 1024 * 1024
const REGISTRY_TIMEOUT_MS = 30_000
// What registry documents being read at once may hold, each counted at its
// limit until it is read and parsed: four packuments, or 32 version documents.
const MAX_DOCUMENT_BYTES = 4 * PACKUMENT_BYTES
// What a package may unpack to: the files' bytes and their count; the tar
// stream holding them is bounded in npm-loads.ts.
export const MAX_NPM_PACKAGE_BYTES = 64 * 1024 * 1024
export const MAX_NPM_PACKAGE_FILES = 20_000
// What the files may take as the viewer's JSON. Escaping grows a text up to
// six times (a control character becomes `\u0001`), so it is counted before
// anything is serialized.
export const MAX_NPM_JSON_LENGTH = 96 * 1024 * 1024
export class NpmPackageError extends Error {
  status: number
  constructor(status: number, code: string) { super(code); this.status = status }
}

// Who reads, as the session has it now: the role, and the scopes of the
// visible teams they are a member of.
export interface NpmReader { role: Role; scopes: ReadonlySet<string>; userId: string }

// Whether a reader may have a package read with the server's token.
export function canReadPrivateNpm(reader: NpmReader, name: string): boolean {
  if (reader.role === 'admin' || reader.role === 'manage') return true
  const scope = npmPackageScope(name)
  return scope !== null && reader.scopes.has(scope)
}

export const npmToken = () => process.env['NPM_TOKEN'] || null

function registryUrl(name: string, spec?: string): string {
  return `${NPM_REGISTRY}/${name}${spec === undefined ? '' : `/${encodeURIComponent(spec)}`}`
}

export async function readLimited(res: Response, limit: number): Promise<Buffer> {
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

let documentBytes = 0

async function withDocumentBudget<T>(limit: number, read: () => Promise<T>): Promise<T> {
  if (documentBytes + limit > MAX_DOCUMENT_BYTES) throw new NpmPackageError(429, 'npm-busy')
  documentBytes += limit
  try { return await read() } finally { documentBytes -= limit }
}

export interface NpmVersionDocument {
  name: string
  version: string
  private: boolean
  dist: { tarball: string; integrity: string; unpackedSize: number | null; fileCount: number | null }
  manifest: Record<string, unknown>
}

export const plainObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const stringRecord = (value: unknown) => plainObject(value)
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'string')) as Record<string, string> : undefined

// The fields the Overview shows, in the shapes package.json gives them; each
// left out where the document has none, or has another shape. A homepage that
// leads only where its repository does (the repository, its directory there,
// or its readme, npm's homepage where the package names none) is left out.
export function npmManifest(json: Record<string, unknown>): Record<string, unknown> {
  const pick: Record<string, unknown> = {}
  for (const key of ['description', 'license', 'homepage', 'main', 'module', 'types', 'type', 'deprecated', 'gitHead']) {
    if (typeof json[key] === 'string') pick[key] = json[key]
  }
  const author = json['author']
  if (typeof author === 'string') pick['author'] = author
  else if (plainObject(author) && typeof author['name'] === 'string') pick['author'] = author['name']
  // The npm account that published it, for its profile.
  const publisher = json['_npmUser']
  if (plainObject(publisher) && typeof publisher['name'] === 'string' && /^[\w.-]{1,214}$/u.test(publisher['name'])) pick['publisher'] = publisher['name']
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
    if (repo.github) {
      pick['github'] = { github: repo.github, ...(repo.directory === undefined ? {} : { directory: repo.directory }) }
      const home = typeof pick['homepage'] === 'string' ? getRepo({ homepage: pick['homepage'] }) : {}
      if (home.github?.toLowerCase() === repo.github.toLowerCase() && (home.directory ?? '') === (repo.directory ?? '')) delete pick['homepage']
    }
  } catch {}
  return pick
}

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null

// The version a spec names, a dist-tag resolved by the registry, with its
// dist. Null where the registry has none for this reader.
export function readNpmVersion(name: string, spec: string, privileged: boolean, signal: AbortSignal): Promise<NpmVersionDocument | null> {
  if (!isNpmPackageName(name) || !isNpmPackageSpec(spec)) return Promise.reject(new NpmPackageError(400, 'bad-package'))
  return withDocumentBudget(VERSION_DOCUMENT_BYTES, async () => {
    const found = await readDocument(name, registryUrl(name, spec), privileged, { accept: 'application/json', limit: VERSION_DOCUMENT_BYTES, signal })
    if (!found) return null
    const { json } = found
    const dist = json['dist']
    if (json['name'] !== name || typeof json['version'] !== 'string' || !isNpmPackageSpec(json['version']) || !plainObject(dist)
        || typeof dist['tarball'] !== 'string' || typeof dist['integrity'] !== 'string') throw new NpmPackageError(502, 'upstream-invalid')
    return {
      name, version: json['version'], private: found.private,
      dist: { tarball: dist['tarball'], integrity: dist['integrity'], unpackedSize: count(dist['unpackedSize']), fileCount: count(dist['fileCount']) },
      manifest: npmManifest(json),
    }
  })
}

// The package's dist-tags and versions, newest published first, from its
// abbreviated document. Null where the registry has none for this reader.
export function readNpmVersions(name: string, privileged: boolean, signal: AbortSignal) {
  if (!isNpmPackageName(name)) return Promise.reject(new NpmPackageError(400, 'bad-package'))
  return withDocumentBudget(PACKUMENT_BYTES, async () => {
    const found = await readDocument(name, registryUrl(name), privileged, { accept: 'application/vnd.npm.install-v1+json', limit: PACKUMENT_BYTES, signal })
    if (!found) return null
    const { json } = found
    if (json['name'] !== name || !plainObject(json['versions'])) throw new NpmPackageError(502, 'upstream-invalid')
    const versions = Object.keys(json['versions']).filter(isNpmPackageSpec).toReversed()
    const distTags = Object.fromEntries(Object.entries(stringRecord(json['dist-tags']) ?? {}).filter(([, version]) => versions.includes(version)))
    return { name, private: found.private, distTags, versions }
  })
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

// A pax header's path. Each record is `<length> <key>=<value>\n`, its length
// in bytes, so records are walked as bytes and only their values decoded.
function paxPath(data: Uint8Array): string | null {
  let path = null
  let at = 0
  while (at < data.length) {
    const space = data.indexOf(0x20, at)
    const length = Number.parseInt(Buffer.from(data.subarray(at, space)).toString('latin1'), 10)
    if (space === -1 || !Number.isSafeInteger(length) || length <= 0) break
    const record = Buffer.from(data.subarray(space + 1, at + length - 1)).toString('utf8')
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

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// A file's text, or null for bytes that are not UTF-8 text.
export function npmFileText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null
  try { return utf8.decode(bytes) } catch { return null }
}

// A string's length in JSON: quotes, backslashes and the control characters
// with a short escape take two characters, the other control characters six.
function jsonLength(text: string): number {
  let length = text.length + 2
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!
    if (code === 0x22 || code === 0x5c) length += 1
    else if (code < 0x20) length += code >= 0x08 && code <= 0x0d && code !== 0x0b ? 1 : 5
  }
  return length
}

// A row's brackets, size, null and digest, past its strings.
const ROW_LENGTH = 80

// The files as the viewer gets them: `[path, bytes, text]`, text null for a
// file that is not UTF-8, which instead carries its bytes' sha256, so a
// comparison of two versions tells a changed one from an unchanged one.
export function npmFileRows(files: NpmPackageFile[]): ([string, number, string] | [string, number, null, string])[] {
  let length = 0
  return files.map(({ path, bytes }) => {
    const text = npmFileText(bytes)
    length += ROW_LENGTH + jsonLength(path) + (text === null ? 0 : jsonLength(text))
    if (length > MAX_NPM_JSON_LENGTH) throw new NpmPackageError(413, 'package-too-large')
    return text === null ? [path, bytes.byteLength, null, `sha256-${createHash('sha256').update(bytes).digest('base64')}`] : [path, bytes.byteLength, text]
  })
}

// The tarball's filename as `npm pack` writes it.
export function npmTarballFilename(name: string, version: string): string {
  return `${name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`
}
