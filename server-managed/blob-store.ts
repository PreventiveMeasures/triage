// Logical upload-store interfaces shared by disk and Vercel storage.
import { Buffer } from 'node:buffer'
import type { Readable } from 'node:stream'

export interface OpenedBlob {
  // Remote streams may omit their size; callers then omit Content-Length.
  size: number | null
  stream: Readable
}

export interface BlobStore {
  // Encrypted upload stores return the wrapped data key for the SQL insert.
  put(id: string, bytes: Buffer): Promise<string | null>
  get(id: string): Promise<Buffer | null>
  open(id: string): Promise<OpenedBlob | null>
  delete(id: string): Promise<void>
}

// A blob's bytes whole, its stream closed however the read ends.
export async function readBytes(stored: OpenedBlob): Promise<Buffer> {
  const parts: Buffer[] = []
  try {
    for await (const part of stored.stream) parts.push(Buffer.from(part))
    return Buffer.concat(parts)
  } finally { stored.stream.destroy() }
}
