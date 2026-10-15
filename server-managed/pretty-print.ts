// Minified files pretty-printed for the Code tab (GET /api/bundles/:id/pretty
// one file at a time, GET /api/npm/pretty all a version's at once), and the
// files that changed between two bundles or versions for Compare (the same
// with `other`, or `otherVersion`), named by path and content hash, formatted
// with oxfmt once and kept Brotli-encoded by that hash: a bundle's in its
// cache directory (so only made from, and read by readers of, that bundle), a
// public npm version's under `cache/npm/`; a private version's are never
// kept. Access is the caller's to check.
import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { brotliDecompress } from 'node:zlib'
import { format } from '@preventive/compare/pretty.js'
import { computeFileHash } from '@preventive/report'
import { FILE_HASH } from '../common/bundle-metadata.js'
import { bundleCompareFiles } from '../common/bundle-compare-inputs.js'
import { bundlePackageDirs, bundleSourcesAsMap } from '../common/bundle-sources.js'
import { MAX_PRETTY_BYTES, needsPrettyPrint, prettyExtension } from '../common/pretty-print.js'
import type { OpenedBlob } from './blob-store.ts'
import { type BundleCacheStorage, readBundleDetails } from './bundle-cache.ts'
import type { BundleStore } from './bundle-store.ts'
import { encodeBrotli } from './brotli.ts'
import { CacheMissError, type CacheStorage } from './cache-storage.ts'
import type { ManagedBundle, ManagedDb } from './db.ts'
import { loadNpmFiles } from './npm-loads.ts'
import { type NpmVersionDocument, npmFileText } from './npm-packages.ts'

// Part of every kept copy's name; bumped when what the formatter writes for
// the same file changes, or what its check lets through, so copies written
// before are no longer read.
const PRETTY_VERSION = 4
// Formats running at once per process, each holding its file's syntax tree,
// and those waiting their turn past them (a version's files are formatted one
// after another, beside other readers'), any more refused.
const MAX_ACTIVE_FORMATS = 2
const MAX_WAITING_FORMATS = 16

export class PrettyError extends Error {
  status: number
  constructor(status: number, code: string) { super(code); this.status = status }
}

export interface PrettyRequest { path: string; hash: string; extension: string }

// One of a version's files pretty-printed (npmAll), named by `source`, the
// hash of the file it was formatted from: its copy's text, or why it has
// none, as a PrettyError tells it.
export type PrettyLine = { path: string; source: string; text: string } | { path: string; source: string; error: string; status: number }

// Which of a comparison's two its files are of: the bundle or version asked
// about, or the `other`.
type Side = 'base' | 'other'

// One of a comparison's changed files pretty-printed (compared), as a
// version's is, with the side it is of.
export type ComparedLine = PrettyLine & { side: Side }

// A side of a comparison: its files that can be formatted, with their texts,
// and every one of its files' hashes, by path; its packages' directories by
// path, as a bundle records them (bundlePackageDirs), or null where it
// records none; the copy kept for one, or null; and one made, kept where the
// side keeps copies.
export interface ComparedSide {
  side: Side
  files: Array<PrettyRequest & { text: string }>
  hashes: Map<string, string>
  packageDirs: Map<string, string> | null
  kept(request: PrettyRequest): Promise<OpenedBlob | null>
  made(request: PrettyRequest, text: string): Promise<OpenedBlob>
}

// The file a request's `path` and `hash` name, or null for one that can't be
// formatted.
export function prettyRequest(params: URLSearchParams): PrettyRequest | null {
  const path = params.get('path') ?? ''
  const extension = prettyExtension(path), hash = params.get('hash') ?? ''
  return extension !== null && FILE_HASH.test(hash) ? { path, hash, extension } : null
}

// A copy's name: its file's hash in hex, with the extension it was parsed by.
const prettyFile = ({ hash, extension }: PrettyRequest) =>
  `pretty-v${PRETTY_VERSION}/${Buffer.from(hash.slice('sha512-'.length), 'base64').toString('hex')}.${extension}.br`

let activeFormats = 0
const waitingFormats: Array<() => void> = []

// The text formatted and Brotli-encoded, where @preventive/compare's checks
// find formatting changed only its layout: refused as `unsupported` where it
// has no check for the kind of file, `unformattable` or `pretty-mismatch`.
export async function prettyBody(text: string, extension: string): Promise<Buffer> {
  if (Buffer.byteLength(text) > MAX_PRETTY_BYTES) throw new PrettyError(413, 'file-too-large')
  if (activeFormats < MAX_ACTIVE_FORMATS) activeFormats++
  else if (waitingFormats.length >= MAX_WAITING_FORMATS) throw new PrettyError(429, 'pretty-busy')
  else await new Promise<void>(resolve => { waitingFormats.push(resolve) })
  let result
  try { result = await format(text, extension) }
  finally {
    const next = waitingFormats.shift()
    if (next) next()
    else activeFormats--
  }
  if ('error' in result) {
    if (result.error === 'pretty-mismatch') console.warn(`managed: pretty-printing a .${extension} file changed more than its layout; not served`)
    throw new PrettyError(422, result.error)
  }
  return encodeBrotli(Buffer.from(result.code))
}

const opened = (body: Buffer): OpenedBlob => ({ size: body.byteLength, stream: Readable.from([body]) })

const decompress = promisify(brotliDecompress)

// A pretty-printed copy's text, from its Brotli-encoded bytes.
export async function prettyText(copy: OpenedBlob): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of copy.stream) chunks.push(chunk as Buffer)
  return (await decompress(Buffer.concat(chunks))).toString()
}

// Every file of a version that needs pretty-printing (needsPrettyPrint), read
// in one load of its files, in path order.
async function npmPrintable(doc: NpmVersionDocument): Promise<Array<PrettyRequest & { text: string }>> {
  const load = loadNpmFiles(doc)
  const files: Array<PrettyRequest & { text: string }> = []
  try {
    for (const { path, bytes } of await load.result) {
      const extension = prettyExtension(path)
      if (extension === null || bytes.byteLength > MAX_PRETTY_BYTES) continue
      const text = npmFileText(bytes)
      if (text !== null && needsPrettyPrint(path, text)) files.push({ path, hash: await computeFileHash(bytes), extension, text })
    }
  } finally { load.release() }
  return files.toSorted((a, b) => (a.path < b.path ? -1 : 1))
}

// A file's line (PrettyLine): the text of its copy, as `copy` has it, or why
// it has none.
async function prettyLine({ path, hash }: PrettyRequest, copy: () => Promise<OpenedBlob>): Promise<PrettyLine> {
  try { return { path, source: hash, text: await prettyText(await copy()) } }
  catch (err) {
    if (!(err instanceof PrettyError)) throw err
    return { path, source: hash, error: err.message, status: err.status }
  }
}

// The files that changed between two sides, pretty-printed: each side's
// formattable files the other has another text at the path of, or, where it
// has none there, none of their text at a path of its own (a file renamed, or
// moved with its tree, unchanged, has it there; a copy at a path both have is
// not one), by the paths each side has them at. Those are both of the pairs
// the viewer diffs but where it pairs files otherwise (among copies of one
// text, across packages), whose copies it asks for alone. As they are
// iterated, in path order, the base's first where both have one: those kept,
// at once; then the rest, formatted one after another, the minified before
// the others (needsPrettyPrint), as the viewer prints those unasked.
export function compared(sides: readonly [ComparedSide, ComparedSide]): AsyncGenerator<ComparedLine> {
  // Each side's texts at the paths the other hasn't: where a file moved has its own.
  const moved = sides.map((own, i) => new Set([...own.hashes].filter(([path]) => !sides[1 - i]!.hashes.has(path)).map(([, hash]) => hash)))
  const changed = sides.flatMap((own, i) => {
    const other = sides[1 - i]!.hashes
    return own.files.filter(({ path, hash }) => (other.has(path) ? other.get(path) !== hash : !moved[1 - i]!.has(hash))).map(file => ({ own, file }))
  }).toSorted((a, b) => (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0))
  return (async function* () {
    const unkept: typeof changed = []
    for (const { own, file } of changed) {
      const copy = await own.kept(file)
      if (copy) yield { side: own.side, ...await prettyLine(file, () => Promise.resolve(copy)) }
      else unkept.push({ own, file })
    }
    const minified = new Map(unkept.map(({ file }) => [file, needsPrettyPrint(file.path, file.text)]))
    for (const { own, file } of unkept.toSorted((a, b) => Number(minified.get(b.file)) - Number(minified.get(a.file)))) {
      yield { side: own.side, ...await prettyLine(file, () => own.made(file, file.text)) }
    }
  })()
}

// Jobs by key, readers asking for one while it runs sharing it.
function sharing<T>(): (key: string, make: () => Promise<T>) => Promise<T> {
  const pending = new Map<string, Promise<T>>()
  return (key, make) => {
    let job = pending.get(key)
    if (!job) pending.set(key, job = make().finally(() => pending.delete(key)))
    return job
  }
}

// Work done one job at a time, in the order asked.
function serial(): <T>(work: () => Promise<T>) => Promise<T> {
  let queue = Promise.resolve()
  return work => {
    const job = queue.then(work)
    queue = job.then(() => undefined, () => undefined)
    return job
  }
}

async function keep(put: () => Promise<void>) {
  try { await put() } catch (err) { console.warn('managed: pretty-print cache write failed:', err) }
}

// A copy kept, or null where none is.
async function kept(open: () => Promise<OpenedBlob>): Promise<OpenedBlob | null> {
  try { return await open() }
  catch (err) { if (err instanceof CacheMissError) return null; throw err }
}

// A side's files that can be formatted, with their texts, and every one of
// its files' hashes by path, from their paths and contents: texts, or bytes,
// read as text where they are.
async function sideFiles(entries: Iterable<[string, string | Uint8Array]>): Promise<Pick<ComparedSide, 'files' | 'hashes'>> {
  const files: ComparedSide['files'] = [], hashes = new Map<string, string>()
  for (const [path, content] of entries) {
    const hash = await computeFileHash(content)
    hashes.set(path, hash)
    const extension = prettyExtension(path)
    if (extension === null || (typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength) > MAX_PRETTY_BYTES) continue
    const text = typeof content === 'string' ? content : npmFileText(content)
    if (text !== null) files.push({ path, hash, extension, text })
  }
  return { files, hashes }
}

// A bundle's side, from its details: its files, as sideFiles reads them,
// within a reason `scope` as Compare reads them there (bundleCompareFiles),
// and its packages' directories.
async function bundleSide(details: Parameters<typeof bundlePackageDirs>[0], scope: string): Promise<Pick<ComparedSide, 'files' | 'hashes' | 'packageDirs'>> {
  const scoped = scope ? new Set(bundleCompareFiles(details, scope).keys()) : null, sources = bundleSourcesAsMap(details)
  return { ...await sideFiles(scoped ? [...sources].filter(([path]) => scoped.has(path)) : sources), packageDirs: bundlePackageDirs(details) }
}

// A version's files by path, from one load of them.
async function npmFiles(doc: NpmVersionDocument): Promise<Array<[string, Uint8Array]>> {
  const load = loadNpmFiles(doc)
  try { return (await load.result).map(({ path, bytes }) => [path, bytes]) }
  finally { load.release() }
}

// Removes the public npm copies of every version before PRETTY_VERSION, which
// nothing reads any more, for maintenance: once a process, again where
// removing them failed. A bundle's earlier copies go with the bundle.
export function stalePrettyRemover(npm: CacheStorage): (signal?: AbortSignal) => Promise<void> {
  let removed = false
  return async signal => {
    if (removed) return
    for (let version = 1; version < PRETTY_VERSION; version++) {
      if (signal?.aborted) return
      await npm.delete(`pretty-v${version}`)
    }
    removed = true
  }
}

// A bundle's details, from its bytes in `store`: bundles are read one at a
// time, as reading one decodes all of it.
function detailsReader(store: BundleStore) {
  const enqueue = serial()
  return (record: ManagedBundle) => enqueue(async () => {
    const details = await readBundleDetails(record, store)
    if (!details) throw new PrettyError(422, 'bundle-unavailable')
    return details
  })
}

export function createPrettyCache(bundles: BundleCacheStorage, npm: CacheStorage, db: Pick<ManagedDb, 'getBundle'>, store: BundleStore) {
  // Copies being made; readers asking for one meanwhile share it.
  const shared = sharing<Buffer>()
  const bundleDetails = detailsReader(store)
  // A bundle's file pretty-printed from the text `read` reads, and kept in
  // its cache.
  function bundleCopy(record: ManagedBundle, request: PrettyRequest, read: () => Promise<string>): Promise<Buffer> {
    const file = prettyFile(request)
    return shared(`bundle ${record.id} ${file}`, async () => {
      const body = await prettyBody(await read(), request.extension)
      // As for its metadata (bundle-cache.ts): a bundle deleted meanwhile
      // keeps no copy, nor does one deleted while it was written.
      if (!await db.getBundle(record.id)) throw new PrettyError(404, 'no-bundle')
      await keep(() => bundles.put(record.id, file, body))
      if (!await db.getBundle(record.id)) {
        await bundles.delete(record.id)
        throw new PrettyError(404, 'no-bundle')
      }
      return body
    })
  }
  // A version's file pretty-printed, `read` reading its text (and checking
  // it is the file named): from the copy kept for a public version, else
  // made, and kept for a public one.
  async function npmCopy(doc: NpmVersionDocument, request: PrettyRequest, read: () => Promise<string>): Promise<OpenedBlob> {
    const file = prettyFile(request)
    if (!doc.private) {
      try { return await npm.open(file) }
      catch (err) { if (!(err instanceof CacheMissError)) throw err }
    }
    return opened(await shared(doc.private ? `npm ${doc.dist.integrity} ${file}` : `npm ${file}`, async () => {
      const body = await prettyBody(await read(), request.extension)
      if (!doc.private) await keep(() => npm.put(file, body))
      return body
    }))
  }
  return {
    async bundle(record: ManagedBundle, request: PrettyRequest): Promise<OpenedBlob> {
      const copy = await kept(() => bundles.open(record.id, prettyFile(request)))
      if (copy) return copy
      return opened(await bundleCopy(record, request, async () => {
        const text = bundleSourcesAsMap(await bundleDetails(record)).get(request.path)
        if (text === undefined) throw new PrettyError(404, 'no-file')
        if (await computeFileHash(text) !== request.hash) throw new PrettyError(409, 'hash-mismatch')
        return text
      }))
    },
    // The version's file, from its files loaded as the viewer's are (and
    // held to the same few loads at once).
    npm(doc: NpmVersionDocument, request: PrettyRequest): Promise<OpenedBlob> {
      return npmCopy(doc, request, async () => {
        const load = loadNpmFiles(doc)
        let text: string | null
        try {
          const bytes = (await load.result).find(entry => entry.path === request.path)?.bytes
          if (!bytes) throw new PrettyError(404, 'no-file')
          if (await computeFileHash(bytes) !== request.hash) throw new PrettyError(409, 'hash-mismatch')
          text = npmFileText(bytes)
        } finally { load.release() }
        if (text === null) throw new PrettyError(422, 'unformattable')
        return text
      })
    },
    // Every file of the version that needs pretty-printing (npmPrintable),
    // read before this resolves; then, as they are iterated, each
    // pretty-printed as `npm` has it, one after another.
    async npmAll(doc: NpmVersionDocument): Promise<AsyncGenerator<PrettyLine>> {
      const files = await npmPrintable(doc)
      return (async function* () {
        for (const { text, ...request } of files) yield await prettyLine(request, () => npmCopy(doc, request, () => Promise.resolve(text)))
      })()
    },
    // Two bundles' sides, or two versions', as a comparison reads them, read
    // before this resolves: for the files that changed between them
    // pretty-printed (compared), and their diffs with renamed names hidden
    // (rename-diff.ts renamedPairs); a bundle's within a reason `scope`
    // where one is asked for, as Compare reads it then.
    async bundleSides(base: ManagedBundle, other: ManagedBundle, scope = ''): Promise<[ComparedSide, ComparedSide]> {
      const sideOf = async (record: ManagedBundle, side: Side): Promise<ComparedSide> => ({ side, ...await bundleSide(await bundleDetails(record), scope),
        kept: request => kept(() => bundles.open(record.id, prettyFile(request))),
        made: async (request, text) => opened(await bundleCopy(record, request, () => Promise.resolve(text))) })
      return [await sideOf(base, 'base'), await sideOf(other, 'other')]
    },
    // A bundle's details, read in its turn, as Compare pairs them (comparison.ts).
    bundleDetails,
    async npmSides(base: NpmVersionDocument, other: NpmVersionDocument): Promise<[ComparedSide, ComparedSide]> {
      const sideOf = async (doc: NpmVersionDocument, side: Side): Promise<ComparedSide> => ({ side, ...await sideFiles(await npmFiles(doc)), packageDirs: null,
        kept: request => (doc.private ? Promise.resolve(null) : kept(() => npm.open(prettyFile(request)))),
        made: (request, text) => npmCopy(doc, request, () => Promise.resolve(text)) })
      return [await sideOf(base, 'base'), await sideOf(other, 'other')]
    },
  }
}
export type PrettyCache = ReturnType<typeof createPrettyCache>
