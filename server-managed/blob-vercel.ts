import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import { type VercelBlobSdk, isNotFound, loadVercelBlobSdk } from '../server-common/vercel-blob.ts'
import type { AvatarStore } from './avatar-store.ts'
import type { BlobStore } from './blob-store.ts'
import type { BundleCacheStorage } from './bundle-cache.ts'
import { createBundleStore } from './bundle-store.ts'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
function validate(id: string): string {
  if (!ID.test(id)) throw new Error('Invalid managed blob id')
  return id
}

async function deletePrefix(blobs: VercelBlobSdk, token: string, prefix: string, remove: (path: string) => Promise<void>): Promise<void> {
  const cursors = new Set<string>(), paths = new Set<string>()
  let cursor: string | undefined
  // Finish listing before deleting so pagination cannot skip objects as the
  // listed set shrinks. Callers supply a trailing slash to isolate a bundle.
  do {
    const page = await blobs.list({ token, prefix, ...(cursor ? { cursor } : {}) })
    for (const blob of page.blobs) if (blob.pathname.startsWith(prefix)) paths.add(blob.pathname)
    if (!page.hasMore) break
    if (!page.cursor || cursors.has(page.cursor)) throw new Error('Invalid blob pagination')
    cursor = page.cursor
    cursors.add(cursor)
  } while (cursor)
  for (const path of paths) await remove(path)
}

export async function openManagedVercelStorage(token: string, sdk?: VercelBlobSdk) {
  const blobs = sdk ?? await loadVercelBlobSdk()
  const options = { token, access: 'private' as const, useCache: false }
  async function put(path: string, bytes: Buffer) {
    await blobs.put(path, bytes, { token, access: 'private', addRandomSuffix: false,
      allowOverwrite: true, contentType: 'application/octet-stream', cacheControlMaxAge: 60 })
  }
  async function open(path: string) {
    try {
      const result = await blobs.get(path, options)
      if (!result) return null
      if (result.statusCode !== 200 || !result.stream) throw new Error('Unexpected blob response')
      // Private SDK GETs may report zero for a nonempty body. Stream without
      // Content-Length in that case so HTTP clients do not truncate the body.
      const size = result.blob.size === 0 ? null : result.blob.size
      return { size, stream: Readable.fromWeb(result.stream as Parameters<typeof Readable.fromWeb>[0]) }
    } catch (err) { if (isNotFound(err)) return null; throw err }
  }
  async function get(path: string) {
    const result = await open(path)
    if (!result) return null
    const parts: Buffer[] = []
    for await (const chunk of result.stream) parts.push(Buffer.from(chunk))
    return Buffer.concat(parts)
  }
  async function remove(path: string) {
    try { await blobs.del(path, { token }) } catch (err) { if (!isNotFound(err)) throw err }
  }
  function store(name: string, suffix = ''): BlobStore {
    const path = (id: string) => `.managed/${name}/${validate(id)}${suffix}`
    return {
      async put(id, bytes) { await put(path(id), bytes) },
      async get(id) { return await get(path(id)) },
      open: id => open(path(id)),
      async delete(id) { await remove(path(id)) },
    }
  }
  const avatarBlobs = store('avatars')
  const avatarStore: AvatarStore = {
    put(id, contentType, bytes) {
      const type = contentType.split(';', 1)[0]!.trim()
      if (!/^image\/[a-z0-9.+-]+$/iu.test(type)) throw new Error('Invalid avatar type')
      return avatarBlobs.put(id, Buffer.concat([Buffer.from(`${type}\n`), bytes]))
    },
    async get(id) {
      const bytes = await avatarBlobs.get(id)
      if (!bytes) return null
      const split = bytes.indexOf(10)
      if (split < 0 || split > 100) throw new Error('Invalid cached avatar')
      return { contentType: bytes.subarray(0, split).toString(), bytes: bytes.subarray(split + 1) }
    },
  }
  const cachePath = (id: string, file: string) => `.managed/cache/bundles/${validate(id)}/${file}`
  const cacheStorage: BundleCacheStorage = {
    async exists(id, file) {
      try { await blobs.head(cachePath(id, file), { token }); return true }
      catch (err) { if (isNotFound(err)) return false; throw err }
    },
    put: (id, file, bytes) => put(cachePath(id, file), bytes),
    async open(id, file) {
      const result = await open(cachePath(id, file))
      if (!result) throw new Error('Bundle cache unavailable')
      return result
    },
    delete: id => deletePrefix(blobs, token, cachePath(id, ''), remove),
  }
  // Staging uploads are never published. An interrupted browser leaves only
  // parts here; the authenticated cron removes them after a full day.
  async function reapUploads(now = Date.now()) {
    let cursor: string | undefined
    do {
      const page = await blobs.list({ token, prefix: '.managed/uploads/', ...(cursor ? { cursor } : {}) })
      for (const blob of page.blobs) {
        const created = new Date(blob.uploadedAt ?? now).getTime()
        if (created < now - 86_400_000) await remove(blob.pathname)
      }
      if (!page.hasMore) return
      if (!page.cursor || page.cursor === cursor) throw new Error('Invalid blob pagination')
      cursor = page.cursor
    } while (cursor)
  }
  const bundleStore = createBundleStore(store('bundles'), store('bundles', '.map.br'))
  return { reportStore: store('reports'), bundleStore, uploadStore: store('uploads'), avatarStore, cacheStorage, reapUploads }
}
