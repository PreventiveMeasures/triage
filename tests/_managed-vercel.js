// In-memory private Blob SDK with the same asynchronous API boundary.
/* eslint-disable require-await */
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
// The SDK's error subclasses inherit Error.name; callers must use instanceof.
export class BlobNotFoundError extends Error {
  constructor() { super('Vercel Blob: The requested blob does not exist') }
}
export class BlobStoreNotFoundError extends Error {
  constructor() { super('Vercel Blob: This store does not exist.') }
}
export class BlobPreconditionFailedError extends Error {}
const etag = bytes => createHash('sha256').update(bytes).digest('hex')
export function sdkFixture() {
  const calls = [], objects = new Map()
  const sdk = {
    BlobNotFoundError,
    BlobPreconditionFailedError,
    async put(path, bytes, options) {
      calls.push({ op: 'put', path, options })
      if (!Buffer.isBuffer(bytes)) {
        const parts = []
        for await (const part of bytes) parts.push(Buffer.from(part))
        bytes = Buffer.concat(parts)
      }
      if (options?.ifMatch && (!objects.has(path) || etag(objects.get(path).bytes) !== options.ifMatch)) throw new BlobPreconditionFailedError()
      objects.set(path, { bytes, uploadedAt: new Date() })
      return { pathname: path, url: `https://private.invalid/${path}` }
    },
    async get(path, options) {
      calls.push({ op: 'get', path, options })
      const object = objects.get(path)
      if (!object) return null
      return { statusCode: 200, blob: { size: object.bytes.length, etag: etag(object.bytes), uploadedAt: object.uploadedAt },
        stream: new ReadableStream({ start(controller) { controller.enqueue(object.bytes); controller.close() } }) }
    },
    async head(path) { if (!objects.has(path)) throw new BlobNotFoundError(); return { size: objects.get(path).bytes.length } },
    async del(path, options) {
      if (options?.ifMatch && objects.has(path) && etag(objects.get(path).bytes) !== options.ifMatch) throw new BlobPreconditionFailedError()
      objects.delete(path)
    },
    async list({ prefix, cursor, limit = 1000 }) {
      const found = [...objects].filter(([path]) => path.startsWith(prefix) && (!cursor || path > cursor)).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      const blobs = found.slice(0, limit).map(([pathname, { uploadedAt }]) => ({ pathname, uploadedAt }))
      return { blobs, hasMore: found.length > limit, ...(found.length > limit ? { cursor: blobs.at(-1).pathname } : {}) }
    },
  }
  return { sdk, objects, calls }
}
