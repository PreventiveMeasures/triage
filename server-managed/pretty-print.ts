// Minified files pretty-printed for the Code tab (GET /api/bundles/:id/pretty
// one file at a time, GET /api/npm/pretty all a version's at once), named by
// path and content hash, formatted with oxfmt once and kept Brotli-encoded by
// that hash: a bundle's in its cache directory (so only made from, and read
// by readers of, that bundle), a public npm version's under `cache/npm/`; a
// private version's are never kept. Access is the caller's to check.
import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { brotliDecompress } from 'node:zlib'
import { format } from '@preventive/compare/pretty.js'
import { computeFileHash } from '@preventive/report'
import { FILE_HASH } from '../common/bundle-metadata.js'
import { bundleSourcesAsMap } from '../common/bundle-sources.js'
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
const PRETTY_VERSION = 3
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

export function createPrettyCache(bundles: BundleCacheStorage, npm: CacheStorage, db: Pick<ManagedDb, 'getBundle'>, store: BundleStore) {
  // Copies being made; readers asking for one meanwhile share it.
  const pending = new Map<string, Promise<Buffer>>()
  function shared(key: string, make: () => Promise<Buffer>): Promise<Buffer> {
    let job = pending.get(key)
    if (!job) pending.set(key, job = make().finally(() => pending.delete(key)))
    return job
  }
  // Bundles are read one at a time: reading one decodes all of it.
  let queue = Promise.resolve()
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const job = queue.then(work)
    queue = job.then(() => undefined, () => undefined)
    return job
  }
  async function keep(put: () => Promise<void>) {
    try { await put() } catch (err) { console.warn('managed: pretty-print cache write failed:', err) }
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
      const { path, hash, extension } = request, file = prettyFile(request)
      try { return await bundles.open(record.id, file) }
      catch (err) { if (!(err instanceof CacheMissError)) throw err }
      return opened(await shared(`bundle ${record.id} ${file}`, async () => {
        const text = await enqueue(async () => {
          const details = await readBundleDetails(record, store)
          if (!details) throw new PrettyError(422, 'bundle-unavailable')
          return bundleSourcesAsMap(details).get(path)
        })
        if (text === undefined) throw new PrettyError(404, 'no-file')
        if (await computeFileHash(text) !== hash) throw new PrettyError(409, 'hash-mismatch')
        const body = await prettyBody(text, extension)
        // As for its metadata (bundle-cache.ts): a bundle deleted meanwhile
        // keeps no copy, nor does one deleted while it was written.
        if (!await db.getBundle(record.id)) throw new PrettyError(404, 'no-bundle')
        await keep(() => bundles.put(record.id, file, body))
        if (!await db.getBundle(record.id)) {
          await bundles.delete(record.id)
          throw new PrettyError(404, 'no-bundle')
        }
        return body
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
  }
}
export type PrettyCache = ReturnType<typeof createPrettyCache>
