// Pretty-printed copies of minified files for the viewer's Code tab: a
// bundle's (GET /api/bundles/:id/pretty) or a published npm version's (GET
// /api/npm/pretty), asked for by path and the hash of the content the viewer
// holds (common/pretty-print.js). Each is formatted with oxfmt once and kept
// Brotli-encoded, so later requests are answered with the kept bytes as they
// are. Access is the caller's to check, before and after.
//
// A bundle's copies are kept in its cache directory, by content hash: one is
// made only from a file of that bundle with that hash, so any reader of the
// bundle may have it. They are encrypted with the bundle's data key where
// storage is, and removed with the bundle. A public npm version's copies are
// kept by content hash under `cache/npm/`, unencrypted, as what they are made
// from is public; a private version's are made for each request and never
// kept, as nothing else derived from a private package is.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { format } from 'oxfmt'
import { bundleSourcesAsMap } from '../common/bundle-sources.js'
import { MAX_PRETTY_BYTES, PRETTY_FILE_HASH, prettyExtension } from '../common/pretty-print.js'
import type { OpenedBlob } from './blob-store.ts'
import { type BundleCacheStorage, readBundleDetails } from './bundle-cache.ts'
import type { BundleStore } from './bundle-store.ts'
import { encodeBrotli } from './brotli.ts'
import { CacheMissError, type CacheStorage } from './cache-storage.ts'
import type { ManagedBundle, ManagedDb } from './db.ts'
import { loadNpmFiles } from './npm-loads.ts'
import { type NpmVersionDocument, npmFileText } from './npm-packages.ts'

// Part of every kept copy's name; bumped when what the formatter writes for
// the same file changes, so copies written before are no longer read.
const PRETTY_VERSION = 1
// Formats running at once per process, each holding its file's syntax tree.
const MAX_ACTIVE_FORMATS = 2

export class PrettyError extends Error {
  status: number
  constructor(status: number, code: string) { super(code); this.status = status }
}

// Whether a request names a file that can be formatted, by a hash as files
// are hashed.
export const isPrettyRequest = (path: string | null, hash: string | null): path is string =>
  path !== null && prettyExtension(path) !== null && hash !== null && PRETTY_FILE_HASH.test(hash)

const fileHash = (content: string | Uint8Array) => `sha512-${createHash('sha512').update(content).digest('base64')}`

// A copy's name: its file's hash in hex, with the extension it was parsed by.
const prettyFile = (hash: string, extension: string) =>
  `pretty-v${PRETTY_VERSION}/${Buffer.from(hash.slice('sha512-'.length), 'base64').toString('hex')}.${extension}.br`

// How files are formatted: changing what is written no more than layout
// needs, so a copy reads as the file does (sameCode). Keys keep their
// quotes, no trailing commas or arrow parameters' parentheses are added, and
// template literals' contents are left as they are, as formatting what they
// hold would change their strings.
export const PRETTY_OPTIONS = {
  quoteProps: 'preserve', trailingComma: 'none', arrowParens: 'avoid', embeddedLanguageFormatting: 'off',
} as const

// A number literal, outside an identifier.
const NUMBER = /(?<![\p{L}\p{N}_$])(?:0[box][\d_a-f]+n?|\d[\d_]*(?:\.[\d_]*)?(?:e[+-]?\d+)?n?)|(?<![\p{N}.])\.\d[\d_]*(?:e[+-]?\d+)?/giu

// A number literal spelled as the formatter spells it: in lowercase, with a
// leading zero, and no `+`, leading zeros or zero exponent, nor trailing zeros
// or dot in its fraction.
function numberSpelling(literal: string): string {
  const number = literal.toLowerCase()
  const parts = /^0[box]|n$/u.test(number) ? null : /^([^e]*)(?:e([+-]?)0*(\d+))?$/u.exec(number)
  if (!parts) return number
  const [, mantissa = '', sign = '', exponent = ''] = parts
  const fraction = (mantissa.startsWith('.') ? `0${mantissa}` : mantissa).replace(/(\.\d*?)0+$/u, '$1').replace(/\.$/u, '')
  return exponent === '' || /^0+$/u.test(exponent) ? fraction : `${fraction}e${sign === '-' ? '-' : ''}${exponent}`
}

// The text in one form, which formatting leaves as it is: numbers spelled
// alike, strings in double quotes with no quote escaped, regular expressions'
// flags in order, and without whitespace, parentheses or semicolons, all of
// which formatting may add or drop. CSS goes without quotes, which formatting
// adds to attribute selectors' values, and in lowercase, as it may lowercase
// keywords.
function codeForm(text: string, css: boolean): string {
  const form = text.replaceAll(NUMBER, numberSpelling).replaceAll(/\\(?=["'])|[\s();]/gu, '').replaceAll("'", '"')
    .replaceAll(/(?<=\/)[dgimsuvy]{2,}(?![\p{L}\p{N}_$])/gu, flags => [...flags].toSorted().join(''))
  return css ? form.replaceAll('"', '').toLowerCase() : form
}

// Whether `formatted` is `text` but for its layout: a quick check, apart from
// the formatter, that it lost or changed nothing else.
export function sameCode(text: string, formatted: string, css = false): boolean {
  return codeForm(text, css) === codeForm(formatted, css)
}

let activeFormats = 0

// The text formatted and Brotli-encoded, where formatting changed only its
// layout (sameCode).
export async function prettyBody(text: string, extension: string): Promise<Buffer> {
  if (Buffer.byteLength(text) > MAX_PRETTY_BYTES) throw new PrettyError(413, 'file-too-large')
  if (activeFormats >= MAX_ACTIVE_FORMATS) throw new PrettyError(429, 'pretty-busy')
  activeFormats++
  let code: string
  try {
    const result = await format(`pretty.${extension}`, text, PRETTY_OPTIONS)
    if (result.errors.length > 0) throw new PrettyError(422, 'unformattable')
    code = result.code
  } catch (err) {
    throw err instanceof PrettyError ? err : new PrettyError(422, 'unformattable')
  } finally { activeFormats-- }
  if (!sameCode(text, code, extension === 'css')) {
    console.warn(`managed: pretty-printing a .${extension} file changed more than its layout; not served`)
    throw new PrettyError(422, 'pretty-mismatch')
  }
  return encodeBrotli(Buffer.from(code))
}

const opened = (body: Buffer): OpenedBlob => ({ size: body.byteLength, stream: Readable.from([body]) })

export function createPrettyCache(bundles: BundleCacheStorage, npm: CacheStorage, db: Pick<ManagedDb, 'getBundle'>, store: BundleStore) {
  // Copies being made; readers asking for one meanwhile share it.
  const pending = new Map<string, Promise<Buffer>>()
  function shared(key: string, make: () => Promise<Buffer>): Promise<Buffer> {
    let job = pending.get(key)
    if (!job) {
      const made = make()
      const settle = () => { if (pending.get(key) === made) pending.delete(key) }
      made.then(settle, settle)
      pending.set(key, made)
      job = made
    }
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
  return {
    async bundle(record: ManagedBundle, path: string, hash: string): Promise<OpenedBlob> {
      const extension = prettyExtension(path)
      if (extension === null || !PRETTY_FILE_HASH.test(hash)) throw new PrettyError(400, 'bad-file')
      const file = prettyFile(hash, extension)
      try { return await bundles.open(record.id, file) }
      catch (err) { if (!(err instanceof CacheMissError)) throw err }
      return opened(await shared(`bundle ${record.id} ${file}`, async () => {
        const text = await enqueue(async () => {
          const details = await readBundleDetails(record, store)
          if (!details) throw new PrettyError(422, 'bundle-unavailable')
          return bundleSourcesAsMap(details).get(path)
        })
        if (text === undefined) throw new PrettyError(404, 'no-file')
        if (fileHash(text) !== hash) throw new PrettyError(409, 'hash-mismatch')
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
    async npm(doc: NpmVersionDocument, path: string, hash: string): Promise<OpenedBlob> {
      const extension = prettyExtension(path)
      if (extension === null || !PRETTY_FILE_HASH.test(hash)) throw new PrettyError(400, 'bad-file')
      const file = prettyFile(hash, extension)
      if (!doc.private) {
        try { return await npm.open(file) }
        catch (err) { if (!(err instanceof CacheMissError)) throw err }
      }
      return opened(await shared(doc.private ? `npm ${doc.dist.integrity} ${file}` : `npm ${file}`, async () => {
        const load = loadNpmFiles(doc)
        let text: string | null
        try {
          const bytes = (await load.result).find(entry => entry.path === path)?.bytes
          if (!bytes) throw new PrettyError(404, 'no-file')
          if (fileHash(bytes) !== hash) throw new PrettyError(409, 'hash-mismatch')
          text = npmFileText(bytes)
        } finally { load.release() }
        if (text === null) throw new PrettyError(422, 'unformattable')
        const body = await prettyBody(text, extension)
        if (!doc.private) await keep(() => npm.put(file, body))
        return body
      }))
    },
  }
}
export type PrettyCache = ReturnType<typeof createPrettyCache>
