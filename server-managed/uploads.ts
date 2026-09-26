// Staging is shared storage, never process memory. Each part is bound to the
// authenticated session, destination and random upload ID. No bearer URL is
// exposed; all reads/writes still pass the managed role/origin/CSRF gates.
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { BlobStore } from './blob-store.ts'

export const UPLOAD_CHUNK_BYTES = 3 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
export type UploadKind = 'reports' | 'bundles'

function partId(session: string, kind: UploadKind, id: string, index: number): string {
  const hash = createHash('sha256').update(JSON.stringify([session, kind, id, index])).digest('hex').slice(0, 32)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`
}

export function validUploadPart(id: string, index: number, maxBytes: number): boolean {
  return UUID.test(id) && Number.isSafeInteger(index) && index >= 0 && index < Math.ceil(maxBytes / UPLOAD_CHUNK_BYTES)
}

export function putUploadPart(store: BlobStore, session: string, kind: UploadKind, id: string, index: number, bytes: Buffer): Promise<void> {
  return store.put(partId(session, kind, id, index), bytes)
}

export async function readUpload(store: BlobStore, req: IncomingMessage, session: string, kind: UploadKind, maxBytes: number): Promise<Buffer> {
  const id = req.headers['x-upload-id']
  const count = Number(req.headers['x-upload-parts']), size = Number(req.headers['x-upload-size'])
  if (typeof id !== 'string' || !UUID.test(id) || !Number.isSafeInteger(size) || size <= 0
    || !Number.isSafeInteger(count) || count !== Math.ceil(size / UPLOAD_CHUNK_BYTES)) throw new Error('bad-upload')
  if (size > maxBytes) throw new Error('too-large')
  const ids = Array.from({ length: count }, (_, index) => partId(session, kind, id, index))
  const parts: Buffer[] = []
  try {
    for (const [index, key] of ids.entries()) {
      const bytes = await store.get(key)
      const expected = Math.min(UPLOAD_CHUNK_BYTES, size - index * UPLOAD_CHUNK_BYTES)
      if (!bytes || bytes.length !== expected) throw new Error('bad-upload')
      parts.push(bytes)
    }
    return Buffer.concat(parts, size)
  } finally {
    // These bytes can no longer be finalized. Failed/abandoned chunk uploads
    // are also covered by the daily staging sweep.
    for (const key of ids) await store.delete(key).catch(err => console.warn('managed: upload cleanup failed:', err))
  }
}
