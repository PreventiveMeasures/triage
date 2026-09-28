import { Readable } from 'node:stream'
import { type VercelBlobSdk, isNotFound, loadVercelBlobSdk } from '../server-common/vercel-blob.ts'
import { type RawObjectStorage, objectPath } from './object-storage.ts'

export async function openVercelObjectStorage(token: string, sdk?: VercelBlobSdk): Promise<RawObjectStorage> {
  const blobs = sdk ?? await loadVercelBlobSdk()
  const path = (key: string) => `.managed/${objectPath(key)}`
  return {
    async open(key, signal) {
      try {
        const result = await blobs.get(path(key), { token, access: 'private', useCache: false, ...(signal ? { abortSignal: signal } : {}) })
        if (!result) return null
        if (result.statusCode !== 200 || !result.stream) throw new Error('Unexpected blob response')
        if (!result.blob.etag) throw new Error('Vercel Blob did not return an object version')
        return { size: result.blob.size === 0 ? null : result.blob.size, version: result.blob.etag,
          modifiedAt: new Date(result.blob.uploadedAt ?? Date.now()).getTime(),
          stream: Readable.fromWeb(result.stream as Parameters<typeof Readable.fromWeb>[0]) }
      } catch (err) { if (isNotFound(err, blobs)) return null; throw err }
    },
    async exists(key) {
      try { await blobs.head(path(key), { token }); return true }
      catch (err) { if (isNotFound(err, blobs)) return false; throw err }
    },
    async put(key, bytes, signal) {
      await blobs.put(path(key), bytes, { token, access: 'private', addRandomSuffix: false, allowOverwrite: true,
        multipart: true, contentType: 'application/octet-stream', cacheControlMaxAge: 60, ...(signal ? { abortSignal: signal } : {}) })
    },
    async delete(key, version) {
      try { await blobs.del(path(key), { token, ...(version ? { ifMatch: version } : {}) }); return true }
      catch (err) {
        if (isNotFound(err, blobs)) return true
        if (blobs.BlobPreconditionFailedError && err instanceof blobs.BlobPreconditionFailedError) return false
        throw err
      }
    },
    async list(prefix, cursor, limit) {
      if (!prefix.endsWith('/') || !Number.isInteger(limit) || limit < 1) throw new Error('Invalid storage page')
      objectPath(`${prefix}validate`)
      const page = await blobs.list({ prefix: `.managed/${prefix}`, token, limit, ...(cursor ? { cursor } : {}) })
      if (page.hasMore && (!page.cursor || page.cursor === cursor)) throw new Error('Invalid blob pagination')
      return { objects: page.blobs.filter(blob => blob.pathname.startsWith(`.managed/${prefix}`)).map(blob => ({ key: blob.pathname.slice('.managed/'.length),
        modifiedAt: new Date(blob.uploadedAt ?? Date.now()).getTime() })).filter(blob => blob.key.startsWith(prefix)),
      cursor: page.hasMore ? page.cursor! : null }
    },
  }
}
