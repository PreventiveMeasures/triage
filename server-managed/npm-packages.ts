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
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { isExactVersion } from '@preventive/upstream/semver.js'
import { isNpmPackageName, isNpmPackageSpec, npmPackageScope } from '../common/managed/npm-packages.js'
import type { Role } from '../common/managed/roles.ts'
import { npmManifest, npmVersionFields, plainObject, stringRecord } from './npm-manifest.ts'
import { keepJson, readKeptJson, upstreamCachePath } from './upstream-cache.ts'

export { npmManifest, plainObject }

export const NPM_REGISTRY = 'https://registry.npmjs.org'
const VERSION_DOCUMENT_BYTES = 8 * 1024 * 1024
// Abbreviated packuments of packages with thousands of versions run to tens of MiB.
const PACKUMENT_BYTES = 64 * 1024 * 1024
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

// What an upstream (npm's registry and APIs, Socket, GitHub) answers, read
// whole: null where it says it has none (`absent`, 404 unless said). Asked
// without redirects, and given up on after `ms`, 30 seconds unless said, or
// once `signal` aborts, its abort rethrown as it is; a 502 where it can't be
// asked, answers otherwise or stops, and `upstream-too-large` past `limit`
// bytes (readLimited). `answered` sees the response first, its status and
// headers.
export async function askUpstream(url: string, { limit, ms = 30_000, signal, absent = [404], answered, ...init }: Omit<RequestInit, 'signal'>
  & { limit: number; ms?: number; signal?: AbortSignal; absent?: number[]; answered?: (res: Response) => void }): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(ms), ...signal ? [signal] : []]) })
    answered?.(res)
    if (absent.includes(res.status)) { await res.body?.cancel(); return null }
    if (!res.ok) { await res.body?.cancel(); throw new NpmPackageError(502, 'upstream-unavailable') }
    return await readLimited(res, limit)
  } catch (err) {
    if (signal?.aborted || err instanceof NpmPackageError) throw err
    throw new NpmPackageError(502, 'upstream-unavailable')
  }
}

// The same, read as JSON (by `parse`, as one line of ndjson): a 502
// `upstream-invalid` where it isn't.
export async function askUpstreamJson(url: string, options: Parameters<typeof askUpstream>[1], parse = (text: string): unknown => JSON.parse(text)): Promise<unknown> {
  const body = await askUpstream(url, options)
  if (body === null) return null
  try { return parse(body.toString('utf8')) } catch { throw new NpmPackageError(502, 'upstream-invalid') }
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
// Credentials go only with `token`; nothing is cached on either side, but for
// public whole documents (publicWholeDocument).
async function registryDocument(url: string, { token, accept, limit, signal }: { token: string | null; accept: string; limit: number; signal: AbortSignal }): Promise<Record<string, unknown> | null> {
  const json = await askUpstreamJson(url, { headers: { accept, ...(token ? { authorization: `Bearer ${token}` } : {}) }, limit, signal, absent: [401, 403, 404] })
  if (json === null || plainObject(json)) return json
  throw new NpmPackageError(502, 'upstream-invalid')
}

// Where public packages' whole documents are kept, off Vercel: the upstream
// cache dir, set at startup (index.ts); null keeps none.
let documentCache: string | null = null
export const setNpmDocumentCache = (dir: string | null) => { documentCache = dir === null ? null : resolve(dir) }

// A package's whole document as npm answers anyone (`url` its own), kept on
// disk where the server keeps them (setNpmDocumentCache) with npm's ETag, and
// asked for again each time with it: npm answers 304, and nothing more, while
// it is unchanged. Null where npm has none for anyone, nothing then kept.
async function publicWholeDocument(name: string, url: string, { limit, signal }: { limit: number; signal: AbortSignal }): Promise<Record<string, unknown> | null> {
  const path = documentCache === null ? null : upstreamCachePath(documentCache, 'npm/packuments', `${name}.json.gz`)
  const kept = path === null ? null : await readKeptJson(path, limit)
  let etag: string | null = null, status = 0
  const body = await askUpstream(url, { headers: { accept: 'application/json', ...kept && { 'if-none-match': kept.etag } }, limit, signal, absent: [304, 401, 403, 404],
    answered: res => { status = res.status; etag = res.headers.get('etag') } })
  if (status === 304 && kept) return kept.json
  if (body === null) {
    if (path !== null && kept) await rm(path, { force: true }).catch(() => {})
    return null
  }
  let json: unknown
  try { json = JSON.parse(body.toString('utf8')) } catch { throw new NpmPackageError(502, 'upstream-invalid') }
  if (!plainObject(json)) throw new NpmPackageError(502, 'upstream-invalid')
  if (path !== null && etag !== null) await keepJson(path, etag, body)
  return json
}

// Asked anonymously first: a reader without private access stops there. One
// with it asks again with the token, where there is one and the package is
// scoped (npm's private packages always are), and the answer is private. A
// whole document (`whole`) anyone may read is kept (publicWholeDocument).
async function readDocument(name: string, url: string, privileged: boolean, { whole = false, ...options }: { accept: string; limit: number; signal: AbortSignal; whole?: boolean }) {
  const open = whole ? await publicWholeDocument(name, url, options) : await registryDocument(url, { ...options, token: null })
  if (open) return { json: open, private: false }
  const token = npmToken()
  if (!privileged || !token || npmPackageScope(name) === null) return null
  const json = await registryDocument(url, { ...options, token })
  return json ? { json, private: true } : null
}

let documentBytes = 0

// A `spare` read, one no reader waits on, is made only where it leaves room
// for two of the largest documents more: readers' own reads come first.
async function withDocumentBudget<T>(limit: number, read: () => Promise<T>, spare = false): Promise<T> {
  if (documentBytes + limit + (spare ? 2 * PACKUMENT_BYTES : 0) > MAX_DOCUMENT_BYTES) throw new NpmPackageError(429, 'npm-busy')
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

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null

// The version `json`, a document of package `name`, tells of.
function versionDocument(name: string, json: Record<string, unknown>, isPrivate: boolean): NpmVersionDocument {
  const dist = json['dist']
  if (json['name'] !== name || typeof json['version'] !== 'string' || !isNpmPackageSpec(json['version']) || !plainObject(dist)
      || typeof dist['tarball'] !== 'string' || typeof dist['integrity'] !== 'string') throw new NpmPackageError(502, 'upstream-invalid')
  return {
    name, version: json['version'], private: isPrivate,
    dist: { tarball: dist['tarball'], integrity: dist['integrity'], unpackedSize: count(dist['unpackedSize']), fileCount: count(dist['fileCount']) },
    manifest: npmManifest(json),
  }
}

// Where public versions' documents are kept, of the fields read of them
// (npm-manifest.ts npmVersionFields), as the database keeps them (npm-kept.ts).
export interface NpmVersionStore {
  read(name: string, version: string): Promise<{ at: number; json: Record<string, unknown> } | null>
  write(name: string, version: string, json: Record<string, unknown>): Promise<void>
}

// The version a spec names, a dist-tag resolved by the registry, with its
// dist. Null where the registry has none for this reader. With `store`, an
// exact version kept there for less than a day (VERSION_KEPT_MS) is read from
// it, not asked of npm, and a public one npm answers is kept. npm never
// changes a version's files, but its document can change: a deprecation, the
// package made private (a scoped one can be), the version removed (which whoever
// reads it from a store learns elsewhere too: risk does). A day bounds each.
export const VERSION_KEPT_MS = 24 * 60 * 60_000
export function readNpmVersion(name: string, spec: string, privileged: boolean, signal: AbortSignal, store?: NpmVersionStore): Promise<NpmVersionDocument | null> {
  if (!isNpmPackageName(name) || !isNpmPackageSpec(spec)) return Promise.reject(new NpmPackageError(400, 'bad-package'))
  // A kept one is read within the same budget as npm's answer.
  return withDocumentBudget(VERSION_DOCUMENT_BYTES, async () => {
    const kept = store && isExactVersion(spec) ? await store.read(name, spec) : null
    if (kept && Date.now() - kept.at < VERSION_KEPT_MS) try { return versionDocument(name, kept.json, false) } catch {}
    const found = await readDocument(name, registryUrl(name, spec), privileged, { accept: 'application/json', limit: VERSION_DOCUMENT_BYTES, signal })
    if (!found) return null
    const doc = versionDocument(name, found.json, found.private)
    if (store && !found.private) await store.write(name, doc.version, npmVersionFields(found.json))
    return doc
  })
}

// The package's dist-tags and versions, newest published first, from its
// abbreviated document; with `times`, from its whole one, which alone has
// when each was published, `times` by version (ISO dates), and `created`,
// when its first version was, one since unpublished among them: the earliest
// time it lists, which npm's own `created` can postdate, as a placeholder's
// does for a package npm took down. With `spare`, as a read no reader waits
// on (withDocumentBudget). Null where the registry has none for this reader.
export function readNpmVersions(name: string, privileged: boolean, signal: AbortSignal, { times = false, spare = false } = {}) {
  if (!isNpmPackageName(name)) return Promise.reject(new NpmPackageError(400, 'bad-package'))
  return withDocumentBudget(PACKUMENT_BYTES, async () => {
    const accept = times ? 'application/json' : 'application/vnd.npm.install-v1+json'
    const found = await readDocument(name, registryUrl(name), privileged, { accept, limit: PACKUMENT_BYTES, signal, whole: times })
    if (!found) return null
    const { json } = found
    if (json['name'] !== name || !plainObject(json['versions'])) throw new NpmPackageError(502, 'upstream-invalid')
    const versions = Object.keys(json['versions']).filter(isNpmPackageSpec).toReversed()
    const distTags = Object.fromEntries(Object.entries(stringRecord(json['dist-tags']) ?? {}).filter(([, version]) => versions.includes(version)))
    const listed = { name, private: found.private, distTags, versions }
    if (!times) return listed
    const time = stringRecord(json['time']) ?? {}
    const published = Object.fromEntries(versions.filter(version => isPublishTime(time[version])).map(version => [version, time[version]!]))
    for (const [version, at] of Object.entries(published)) publishTimes.set(`${name}@${version}`, at)
    while (publishTimes.size > PUBLISH_TIMES) publishTimes.delete(publishTimes.keys().next().value!)
    const listedAt = Object.entries(time).filter(([key, at]) => key !== 'modified' && isPublishTime(at)).map(([, at]) => at)
    const created = listedAt.reduce<string | null>((first, at) => first === null || Date.parse(at) < Date.parse(first) ? at : first, null)
    return { ...listed, times: published, created }
  }, spare)
}

// A package's whole document as npm has it for this reader, for risk
// (npm-risk.ts), within the bounds and budget every document read here is
// held to; null where npm has none for this reader, or the name is none npm
// takes.
export function readNpmPackument(name: string, privileged: boolean, signal: AbortSignal): Promise<Record<string, unknown> | null> {
  if (!isNpmPackageName(name)) return Promise.resolve(null)
  return withDocumentBudget(PACKUMENT_BYTES, async () => (await readDocument(name, registryUrl(name), privileged, { accept: 'application/json', limit: PACKUMENT_BYTES, signal, whole: true }))?.json ?? null)
}

const isPublishTime = (value: string | undefined) => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value))

// When each version was published, by `name@version`, as whole documents read
// with `times` have said: a version keeps its time once published, so it is
// kept for as long as the server runs, the first noted going first past a
// bound, and answered only with the version, once its reader's access is.
const PUBLISH_TIMES = 100_000
const publishTimes = new Map<string, string>()

export const npmPublishTime = (name: string, version: string): string | null => publishTimes.get(`${name}@${version}`) ?? null

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
