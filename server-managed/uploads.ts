// Staging is shared storage, never process memory. Each part is bound to the
// authenticated session, destination and random upload ID. No bearer URL is
// exposed; all reads/writes still pass the managed role/origin/CSRF gates.
import { Buffer } from 'node:buffer'
import { createHash, generateKeyPairSync } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { BlobStore } from './blob-store.ts'
import { maxSealedBytes, openUpload } from '../common/managed/upload-seal.ts'

export const UPLOAD_CHUNK_BYTES = 3 * 1024 * 1024
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024
// Staged parts may carry a sealed body, slightly larger than its content.
const MAX_STAGED_BYTES = maxSealedBytes(MAX_UPLOAD_BYTES)
const MAX_UPLOAD_PARTS = Math.ceil(MAX_STAGED_BYTES / UPLOAD_CHUNK_BYTES)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
export type UploadKind = 'reports' | 'bundles'

function partId(session: string, kind: UploadKind, id: string, index: number): string {
  const hash = createHash('sha256').update(JSON.stringify([session, kind, id, index])).digest('hex').slice(0, 32)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`
}

export function validUploadPart(id: string, index: number, maxBytes: number): boolean {
  return UUID.test(id) && Number.isSafeInteger(index) && index >= 0 && index < Math.ceil(Math.min(maxSealedBytes(maxBytes), MAX_STAGED_BYTES) / UPLOAD_CHUNK_BYTES)
}

export function validUpload(id: string, count: number): boolean {
  return UUID.test(id) && Number.isSafeInteger(count) && count > 0
}

// Limit cleanup to indices that any configured server could have accepted,
// even if the request advertises an enormous count or the limit was lowered.
export async function deleteUpload(store: BlobStore, session: string, kind: UploadKind, id: string, count: number): Promise<void> {
  if (!validUpload(id, count)) throw new Error('bad-upload')
  const end = Math.min(count, MAX_UPLOAD_PARTS), errors = []
  for (let start = 0; start < end; start += 8) {
    const results = await Promise.allSettled(Array.from({ length: Math.min(8, end - start) },
      (_, index) => store.delete(partId(session, kind, id, start + index))))
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Upload cleanup failed')
}

export async function putUploadPart(store: BlobStore, session: string, kind: UploadKind, id: string, index: number, bytes: Buffer): Promise<void> {
  await store.put(partId(session, kind, id, index), bytes)
}

export async function readUpload(store: BlobStore, req: IncomingMessage, session: string, kind: UploadKind, maxBytes: number): Promise<Buffer> {
  const id = req.headers['x-upload-id']
  const count = Number(req.headers['x-upload-parts']), size = Number(req.headers['x-upload-size'])
  if (typeof id !== 'string' || !validUpload(id, count)) throw new Error('bad-upload')
  try {
    if (!Number.isSafeInteger(size) || size <= 0 || count !== Math.ceil(size / UPLOAD_CHUNK_BYTES)) throw new Error('bad-upload')
    if (size > maxBytes || size > MAX_STAGED_BYTES) throw new Error('too-large')
    const parts: Buffer[] = []
    for (let index = 0; index < count; index++) {
      const bytes = await store.get(partId(session, kind, id, index))
      const expected = Math.min(UPLOAD_CHUNK_BYTES, size - index * UPLOAD_CHUNK_BYTES)
      if (!bytes || bytes.length !== expected) throw new Error('bad-upload')
      parts.push(bytes)
    }
    return Buffer.concat(parts, size)
  } finally {
    // These bytes can no longer be finalized. Failed/abandoned chunk uploads
    // are also covered by automatic staging maintenance.
    await deleteUpload(store, session, kind, id, count).catch(err => console.warn('managed: upload cleanup failed:', err))
  }
}

// A session's upload key pair, stored as its private JWK.
export function newUploadKey(): string {
  const { privateKey } = generateKeyPairSync('x25519')
  const { kty, crv, x, d } = privateKey.export({ format: 'jwk' })
  return JSON.stringify({ kty, crv, x, d })
}

// The raw public key (base64url) browsers seal this session's uploads to.
export function uploadPublicKey(key: string): string {
  return (JSON.parse(key) as { x: string }).x
}

export async function openSessionUpload(key: string | null | undefined, sealed: Buffer, maxBytes: number): Promise<Buffer> {
  if (!key) throw new Error('bad-upload')
  const bytes = await openUpload(new Uint8Array(sealed.buffer as ArrayBuffer, sealed.byteOffset, sealed.byteLength), JSON.parse(key) as JsonWebKey, maxBytes)
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}
