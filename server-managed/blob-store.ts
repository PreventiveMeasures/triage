// Logical upload-store interfaces shared by disk and Vercel storage.
import type { Buffer } from 'node:buffer'
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
