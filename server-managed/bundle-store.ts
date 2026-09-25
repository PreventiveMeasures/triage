// Sourcemaps are stored once as Brotli. The DB retains the uploaded filename,
// byte size and integrity so compression does not change report links/dedup.
import type { Buffer } from 'node:buffer'
import { type BlobStore, type OpenedBlob, createDiskBlobStore } from './blob-store.ts'
import { encodeBrotli } from './brotli.ts'

export interface BundleStore {
  put(id: string, bytes: Buffer, kind: string | null): Promise<void>
  get(id: string, kind: string | null): Promise<Buffer | null>
  open(id: string, kind: string | null): Promise<OpenedBlob | null>
  delete(id: string): Promise<void>
}

export function createBundleStore(archives: BlobStore, sourcemaps: BlobStore): BundleStore {
  const storage = (kind: string | null) => kind === 'sourcemap' ? sourcemaps : archives
  return {
    async put(id, bytes, kind) {
      await storage(kind).put(id, kind === 'sourcemap' ? await encodeBrotli(bytes) : bytes)
    },
    get: (id, kind) => storage(kind).get(id),
    open: (id, kind) => storage(kind).open(id),
    async delete(id) { await Promise.all([archives.delete(id), sourcemaps.delete(id)]) },
  }
}

export function createDiskBundleStore(dir: string): BundleStore {
  return createBundleStore(createDiskBlobStore(dir), createDiskBlobStore(dir, '.map.br'))
}
