// Immutable derivatives of uploaded bundles. Requests stream the already-gzipped
// files; parsing, source hashing and transcoding happen only on a cache miss.
import { Buffer } from 'node:buffer'
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { brotliDecompress, gzip } from 'node:zlib'
import { promisify } from 'node:util'
import { BUNDLE_METADATA_VERSION, createBundleMetadata, parseBundleContents } from '../common/bundle-metadata.js'
import type { BlobStore } from './blob-store.ts'
import type { ManagedBundle, ManagedDb } from './db.ts'

const decompress = promisify(brotliDecompress)
const compress = promisify(gzip)
const MAX_DECODED_BYTES = 512 * 1024 * 1024
export type BundleCachePart = 'metadata' | 'contents'

export function createDiskBundleCache(dir: string, db: ManagedDb, store: BlobStore) {
  const pending = new Map<string, Promise<void>>()
  // Bound peak memory across simultaneous uploads and cold-cache requests.
  let queue = Promise.resolve()
  function directory(id: string) {
    if (!/^[a-f\d-]{36}$/iu.test(id)) throw new Error('Invalid bundle id')
    return join(dir, id)
  }
  function filename(id: string, part: BundleCachePart) {
    return join(directory(id), `v${BUNDLE_METADATA_VERSION}-${part}.json.gz`)
  }
  async function build(record: ManagedBundle) {
    const bytes = await store.get(record.id)
    if (!bytes) throw new Error('Bundle bytes unavailable')
    const decoded = record.kind === 'stasis' ? await decompress(bytes, { maxOutputLength: MAX_DECODED_BYTES }) : bytes
    if (decoded.length > MAX_DECODED_BYTES) throw new Error('Decoded bundle too large')
    const details = parseBundleContents(decoded.toString('utf8'), { integrity: record.integrity, kind: record.kind, size: record.byteSize })
    const metadata = { ...await createBundleMetadata(details), id: record.id, filename: record.filename }
    const metadataGzip = await compress(Buffer.from(JSON.stringify(metadata)))
    const contentsGzip = await compress(decoded)
    if (!(await db.getBundle(record.id))) throw new Error('Bundle deleted')
    await mkdir(directory(record.id), { recursive: true })
    for (const [part, body] of [['contents', contentsGzip], ['metadata', metadataGzip]] as const) {
      const target = filename(record.id, part)
      const temp = `${target}.${randomUUID()}.tmp`
      try { await writeFile(temp, body); await rename(temp, target) }
      finally { await rm(temp, { force: true }) }
    }
  }
  async function ensure(record: ManagedBundle): Promise<void> {
    const existing = pending.get(record.id)
    if (existing) return existing
    const job = (async () => {
      try {
        await Promise.all(['metadata', 'contents'].map(part => stat(filename(record.id, part as BundleCachePart))))
        return
      } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err }
      const work = queue.then(() => build(record))
      queue = work.catch(() => {})
      await work
    })()
    pending.set(record.id, job)
    try { await job } finally { if (pending.get(record.id) === job) pending.delete(record.id) }
  }
  return {
    prebuild: ensure,
    async open(record: ManagedBundle, part: BundleCachePart) {
      await ensure(record)
      const file = await open(filename(record.id, part), 'r')
      try {
        const info = await file.stat()
        return { size: info.size, stream: file.createReadStream() }
      } catch (err) { await file.close(); throw err }
    },
    async delete(id: string) {
      // Call after deleting the row. Waiting prevents an in-flight builder
      // from recreating its files after deletion has completed.
      await pending.get(id)?.catch(() => {})
      await rm(directory(id), { recursive: true, force: true })
    },
  }
}
export type BundleCache = ReturnType<typeof createDiskBundleCache>
