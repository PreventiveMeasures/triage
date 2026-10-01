import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress } from 'node:zlib'
import { STORAGE_MAGIC } from '../server-common/storage-crypto.ts'
import { type RawObject, isBlobId } from './object-storage.ts'
import type { StorageRow, StorageRowKind } from './storage-db.ts'

// A damaged/missing payload needs repair; retrying the whole cleanup job does
// not fix it. Keep this distinct from database, storage and cancellation errors.
export class StoragePayloadError extends Error {}

export function storageRowPath(type: StorageRowKind, row: Pick<StorageRow, 'id' | 'kind'>): string {
  return `${type === 'report' ? 'reports' : 'bundles'}/${row.id}${type === 'bundle' && row.kind === 'sourcemap' ? '.map.br' : ''}`
}
export function storageOwner(identity: string): { type: StorageRowKind; id: string; cache: boolean } | null {
  const match = /^(reports|bundles)\/([^/]+)$/u.exec(identity)
  if (match) {
    const id = match[1] === 'bundles' ? match[2]!.replace(/\.map\.br$/u, '') : match[2]!
    if (isBlobId(id)) return { type: match[1] === 'reports' ? 'report' : 'bundle', id, cache: false }
  }
  const cache = /^cache\/(?:bundles|report-sources)\/([a-f\d-]{36})\//u.exec(identity)
  return cache && isBlobId(cache[1]!) ? { type: 'bundle', id: cache[1]!, cache: true } : null
}

// Peek without buffering the object or consuming bytes from its next reader.
export async function inspectStorageObject(stored: RawObject): Promise<RawObject & { encrypted: boolean }> {
  const original = stored.stream
  const iterator = original[Symbol.asyncIterator]()
  const first: Buffer[] = [], prefix = Buffer.alloc(STORAGE_MAGIC.length)
  let length = 0
  try {
    while (length < prefix.length) {
      const next = await iterator.next()
      if (next.done) break
      const bytes = Buffer.from(next.value)
      first.push(bytes)
      length += bytes.copy(prefix, length, 0, prefix.length - length)
    }
  } catch (err) { original.destroy(); throw err }
  async function* joined() {
    try {
      yield* first
      for (;;) { const next = await iterator.next(); if (next.done) return; yield next.value }
    } finally { await iterator.return?.(); original.destroy() }
  }
  const stream = Readable.from(joined(), { objectMode: false })
  stream.once('close', () => original.destroy())
  return { ...stored, stream, encrypted: length === prefix.length && prefix.equals(STORAGE_MAGIC) }
}

// Sourcemap integrity describes the original upload, before Brotli storage.
// Hash incrementally, including decompression, so migration stays streaming.
export async function verifyStoragePayload(type: StorageRowKind, row: StorageRow, source: Readable, signal?: AbortSignal): Promise<void> {
  const hash = createHash(type === 'report' ? 'sha256' : 'sha512')
  const sink = new Writable({ write(chunk, _encoding, next) { hash.update(chunk); next() } })
  const options = signal ? { signal } : {}
  try {
    if (type === 'bundle' && row.kind === 'sourcemap') {
      await pipeline(source, createBrotliDecompress(), sink, options)
    } else await pipeline(source, sink, options)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? ''
    if (['Z_DATA_ERROR', 'Z_BUF_ERROR'].includes(code) || code.startsWith('ERR__ERROR_FORMAT_')) {
      throw new StoragePayloadError('Stored sourcemap cannot be decompressed', { cause: err })
    }
    throw err
  }
  const actual = type === 'report' ? hash.digest('base64url') : `sha512-${hash.digest('base64')}`
  if (actual !== row.hash) throw new StoragePayloadError('Stored payload does not match its upload hash')
}
