// Logical stores share one encryption boundary. Compression, identifiers and
// public response bytes stay the same with either physical backend.
import { Buffer } from 'node:buffer'
import type { AvatarStore } from './avatar-store.ts'
import type { BlobStore } from './blob-store.ts'
import type { BundleCacheStorage } from './bundle-cache.ts'
import { createBundleStore } from './bundle-store.ts'
import { type CacheStorage, validateCacheKey } from './cache-storage.ts'
import type { ObjectStorage } from './object-storage.ts'

function id(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) throw new Error('Invalid managed blob id')
  return value
}

function blobStore(objects: ObjectStorage, name: string, suffix = ''): BlobStore {
  const path = (value: string) => `${name}/${id(value)}${suffix}`
  return {
    put: (value, bytes) => objects.put(path(value), bytes),
    get: value => objects.get(path(value)),
    open: value => objects.open(path(value)),
    delete: value => objects.delete(path(value)),
  }
}

function cacheStore(objects: ObjectStorage, name: string): CacheStorage {
  const path = (key: string) => `cache/${name}/${validateCacheKey(key)}`
  return {
    exists: key => objects.exists(path(key)),
    put: async (key, bytes) => { await objects.put(path(key), bytes) },
    async open(key) {
      const value = await objects.open(path(key))
      if (!value) throw new Error('Managed cache unavailable')
      return value
    },
    delete: prefix => objects.deletePrefix(`${path(prefix)}/`),
  }
}

function avatarStore(objects: ObjectStorage, sidecar: boolean): AvatarStore {
  return {
    async put(value, contentType, bytes) {
      const path = `avatars/${id(value)}`, type = contentType.split(';', 1)[0]!.trim()
      if (!/^image\/[a-z0-9.+-]+$/iu.test(type)) throw new Error('Invalid avatar type')
      if (sidecar) {
        await objects.put(path, bytes)
        await objects.put(`${path}.type`, Buffer.from(type))
      } else await objects.put(path, Buffer.concat([Buffer.from(`${type}\n`), bytes]))
    },
    async get(value) {
      const path = `avatars/${id(value)}`
      const bytes = await objects.get(path)
      if (!bytes) return null
      if (sidecar) {
        const type = await objects.get(`${path}.type`)
        return type ? { bytes, contentType: type.toString().trim() || 'application/octet-stream' } : null
      }
      const split = bytes.indexOf(10)
      if (split < 0 || split > 100) throw new Error('Invalid cached avatar')
      return { contentType: bytes.subarray(0, split).toString(), bytes: bytes.subarray(split + 1) }
    },
  }
}

export function createManagedStores(objects: ObjectStorage, avatarSidecar: boolean) {
  const bundles = cacheStore(objects, 'bundles')
  const cacheStorage: BundleCacheStorage = {
    exists: (value, file) => bundles.exists(`${id(value)}/${file}`),
    put: (value, file, bytes) => bundles.put(`${id(value)}/${file}`, bytes),
    open: (value, file) => bundles.open(`${id(value)}/${file}`),
    delete: value => bundles.delete(id(value)),
  }
  return {
    reportStore: blobStore(objects, 'reports'),
    bundleStore: createBundleStore(blobStore(objects, 'bundles'), blobStore(objects, 'bundles', '.map.br')),
    uploadStore: blobStore(objects, 'uploads'),
    avatarStore: avatarStore(objects, avatarSidecar),
    cacheStorage,
    reportSourcesStorage: cacheStore(objects, 'report-sources'),
  }
}
