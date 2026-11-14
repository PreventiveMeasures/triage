import { Readable } from 'node:stream'
import { Buffer } from 'node:buffer'
import { type VercelBlobSdk, isNotFound, loadVercelBlobSdk } from '../server-common/vercel-blob.ts'
import { type RawObjectStorage, objectPath } from './object-storage.ts'

// The SDK's abort option, where there is a signal to give it; and when a blob
// was last written, now where the SDK does not say.
const abortable = (signal?: AbortSignal) => signal ? { abortSignal: signal } : {}
const modifiedAt = (uploadedAt?: Date | string | number) => new Date(uploadedAt ?? Date.now()).getTime()

export async function openVercelObjectStorage(token: string, sdk?: VercelBlobSdk): Promise<RawObjectStorage> {
  const blobs = sdk ?? await loadVercelBlobSdk()
  const path = (key: string) => `.managed/${objectPath(key)}`
  const storage: RawObjectStorage = {
    async head(key, signal) {
      try {
        const meta = await blobs.head(path(key), { token, ...abortable(signal) })
        if (!meta.etag) throw new Error('Missing object version')
        return { size: meta.size, version: meta.etag, modifiedAt: modifiedAt(meta.uploadedAt) }
      } catch (err) { if (isNotFound(err, blobs)) return null; throw err }
    },
    async open(key, signal) {
      try {
        // Read the stored representation: transport compression can weaken its
        // ETag, which cannot satisfy ifMatch, and changes the advertised size.
        const result = await blobs.get(path(key), { token, access: 'private', useCache: false,
          headers: { 'accept-encoding': 'identity' }, ...abortable(signal) })
        if (!result) return null
        if (result.statusCode !== 200 || !result.stream || !result.blob.etag) {
          await result.stream?.cancel()
          throw new Error('Unexpected blob response or missing object version')
        }
        return { size: result.blob.size === 0 ? null : result.blob.size, version: result.blob.etag,
          modifiedAt: modifiedAt(result.blob.uploadedAt),
          stream: Readable.fromWeb(result.stream as Parameters<typeof Readable.fromWeb>[0], signal ? { signal } : {}) }
      } catch (err) { if (isNotFound(err, blobs)) return null; throw err }
    },
    async put(key, bytes, signal, expected, sizeHint) {
      const multipart = (sizeHint ?? (Buffer.isBuffer(bytes) ? bytes.length : Infinity)) >= 5 * 1024 * 1024
      try { await blobs.put(path(key), bytes, { token, access: 'private', addRandomSuffix: false, allowOverwrite: expected !== null,
        ...(expected ? { ifMatch: expected } : {}), multipart, contentType: 'application/octet-stream', cacheControlMaxAge: 60, ...abortable(signal) })
        return true
      } catch (err) {
        if (blobs.BlobPreconditionFailedError && err instanceof blobs.BlobPreconditionFailedError) return false
        // The SDK uses a generic error for an occupied pathname. Reconcile a
        // create-only failure against storage; the caller verifies the winner.
        if (expected === null && await storage.head(key, signal)) return false
        throw err
      }
    },
    async delete(key, version, signal) {
      signal?.throwIfAborted()
      try { await blobs.del(path(key), { token, ...(version ? { ifMatch: version } : {}), ...abortable(signal) }); return true }
      catch (err) {
        if (isNotFound(err, blobs)) return true
        if (blobs.BlobPreconditionFailedError && err instanceof blobs.BlobPreconditionFailedError) return false
        throw err
      }
    },
    async list(prefix, cursor, limit, signal) {
      signal?.throwIfAborted()
      if (!prefix.endsWith('/') || !Number.isInteger(limit) || limit < 1) throw new Error('Invalid storage page')
      objectPath(`${prefix}validate`)
      const page = await blobs.list({ prefix: `.managed/${prefix}`, token, limit, ...(cursor ? { cursor } : {}), ...abortable(signal) })
      if (page.hasMore && (!page.cursor || page.cursor === cursor)) throw new Error('Invalid blob pagination')
      return { objects: page.blobs.filter(blob => blob.pathname.startsWith(`.managed/${prefix}`)).map(blob => ({ key: blob.pathname.slice('.managed/'.length),
        modifiedAt: modifiedAt(blob.uploadedAt) })),
      cursor: page.hasMore ? page.cursor! : null }
    },
  }
  return storage
}
