// Sourcemaps are stored once as Brotli. The DB retains the uploaded filename,
// byte size and integrity so compression does not change report links/dedup.
import type { Buffer } from 'node:buffer'
import { type BlobStore, createDiskBlobStore } from './blob-store.ts'
import { encodeBrotli } from './brotli.ts'

export interface BundleStore {
  put(id: string, bytes: Buffer, kind: string | null): Promise<void>
  get(id: string, kind: string | null): Promise<Buffer | null>
  delete(id: string): Promise<void>
}

export function createBundleStore(originals: BlobStore, sourcemaps: BlobStore): BundleStore {
  const pending = new Map<string, Promise<unknown>>()
  function run<T>(id: string, action: () => Promise<T>): Promise<T> {
    const job = (pending.get(id) ?? Promise.resolve()).catch(() => {}).then(action)
    pending.set(id, job)
    return job.finally(() => { if (pending.get(id) === job) pending.delete(id) })
  }
  return {
    put(id, bytes, kind) {
      return run(id, async () => {
        if (kind !== 'sourcemap') { await originals.put(id, bytes); return }
        await sourcemaps.put(id, await encodeBrotli(bytes))
        await originals.delete(id)
      })
    },
    get(id, kind) {
      return run(id, async () => {
        if (kind !== 'sourcemap') return originals.get(id)
        const encoded = await sourcemaps.get(id)
        if (encoded) {
          // Complete cleanup if a prior migration stopped after publication.
          await originals.delete(id)
          return encoded
        }
        const bytes = await originals.get(id)
        if (!bytes) return null
        const migrated = await encodeBrotli(bytes)
        // Publish atomically before removing the legacy uncompressed copy.
        await sourcemaps.put(id, migrated)
        await originals.delete(id)
        return migrated
      })
    },
    delete(id) {
      // Serialize with conversion so deletion cannot leave recreated bytes.
      return run(id, async () => { await originals.delete(id); await sourcemaps.delete(id) })
    },
  }
}

export function createDiskBundleStore(dir: string): BundleStore {
  return createBundleStore(createDiskBlobStore(dir), createDiskBlobStore(dir, '.map.br'))
}
