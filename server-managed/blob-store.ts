// Disk byte-store for the managed server's stored blobs (uploaded reports and
// bundles). Unlike the e2e relay (which only ever holds opaque client-encrypted
// blobs), a managed server is TRUSTED and stores the bytes in the clear so it
// can operate on them — the metadata + attribution live in the DB, the bytes
// live here, keyed by the blob's opaque `id`.
//
// On-disk for now (a dir beside the SQLite store, e.g. data/reports/<uuid> or
// data/bundles/<uuid>); the BlobStore interface is backend-agnostic so an S3 /
// Vercel Blob backend slots in later without touching callers. Bytes only — the
// content-type / filename / integrity ride the DB row, so there's no sidecar.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Buffer } from 'node:buffer'

export interface BlobStore {
  put(id: string, bytes: Buffer): Promise<void>
  get(id: string): Promise<Buffer | null>
  delete(id: string): Promise<void>
}

// The blob id is a v4 uuid (crypto.randomUUID) — lowercase hex + dashes, no
// path separators. Validated anyway so a crafted id can't escape the store dir.
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

export function createDiskBlobStore(dir: string): BlobStore {
  function pathFor(id: string): string {
    if (!ID_RE.test(id)) throw new Error('invalid blob id')
    return join(dir, id)
  }
  return {
    async put(id, bytes) {
      const p = pathFor(id)
      await mkdir(dirname(p), { recursive: true })
      await writeFile(p, bytes)
    },
    async get(id) {
      try {
        return await readFile(pathFor(id))
      } catch {
        return null
      }
    },
    async delete(id) {
      // `force` so a missing file (already gone) is a no-op, not a throw — the
      // metadata row is the source of truth for whether a blob "exists".
      await rm(pathFor(id), { force: true })
    },
  }
}
