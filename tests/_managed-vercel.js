// In-memory private Blob SDK with the same asynchronous API boundary.
/* eslint-disable require-await */
export function sdkFixture() {
  const calls = [], objects = new Map()
  const missing = () => Object.assign(new Error('missing'), { name: 'BlobNotFoundError' })
  const sdk = {
    async put(path, bytes, options) {
      calls.push({ op: 'put', path, options })
      objects.set(path, { bytes, uploadedAt: new Date() })
      return { pathname: path, url: `https://private.invalid/${path}` }
    },
    async get(path, options) {
      calls.push({ op: 'get', path, options })
      const object = objects.get(path)
      if (!object) return null
      return { statusCode: 200, blob: { size: object.bytes.length }, stream: new ReadableStream({ start(controller) { controller.enqueue(object.bytes); controller.close() } }) }
    },
    async head(path) { if (!objects.has(path)) throw missing(); return { size: objects.get(path).bytes.length } },
    async del(path) { objects.delete(path) },
    async list({ prefix }) { return { blobs: [...objects].filter(([path]) => path.startsWith(prefix)).map(([pathname, { uploadedAt }]) => ({ pathname, uploadedAt })), hasMore: false } },
  }
  return { sdk, objects, calls }
}

