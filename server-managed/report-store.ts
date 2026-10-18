// Compress before the object-storage encryption boundary. Separate paths let
// legacy arbitrary report bytes remain readable without format sniffing.
import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createBrotliDecompress } from 'node:zlib'
import type { BlobStore, OpenedBlob } from './blob-store.ts'
import { encodeBrotli } from './brotli.ts'

async function readBytes(stored: OpenedBlob): Promise<Buffer> {
  const parts: Buffer[] = []
  try {
    for await (const part of stored.stream) parts.push(Buffer.from(part))
    return Buffer.concat(parts)
  } finally { stored.stream.destroy() }
}

// Ids whose original copy is known gone, at most this many.
const COMPRESSED_ONLY_MAX = 16_384

export function createReportStore(legacy: BlobStore, compressed: BlobStore,
  replaceLegacy: (id: string, bytes: Buffer) => Promise<unknown>): BlobStore {
  // Reports this store wrote, converted, or found with only the compressed
  // copy. Uploads write only that copy and nothing writes an original again,
  // so their reads stop asking storage for one, each a miss (and, encrypted,
  // a row read too). A compressed copy missing there asks for the original
  // after all. An original left by a conversion that failed is never in it:
  // the next read finds that original and resumes the conversion.
  const compressedOnly = new Set<string>()
  function remember(id: string): void {
    compressedOnly.delete(id)
    if (compressedOnly.size >= COMPRESSED_ONLY_MAX) compressedOnly.delete(compressedOnly.values().next().value!)
    compressedOnly.add(id)
  }
  async function openCompressed(id: string): Promise<OpenedBlob | null> {
    const stored = await compressed.open(id)
    if (!stored) return null
    const stream = createBrotliDecompress()
    // pipeline carries storage/authentication errors into the decoded stream
    // and closes the stored source when a reader leaves before EOF.
    void pipeline(stored.stream, stream).catch(() => {})
    return { size: null, stream }
  }
  async function open(id: string): Promise<OpenedBlob | null> {
    if (compressedOnly.has(id)) {
      const stored = await openCompressed(id)
      if (stored) return stored
      compressedOnly.delete(id)
    }
    // Keep the original available until conversion succeeds. Concurrent reads
    // can finish using an already-open stream while another reader converts it.
    const original = await legacy.open(id)
    if (original) {
      const bytes = await readBytes(original)
      await replaceLegacy(id, await encodeBrotli(bytes, 9))
      remember(id)
      return { size: bytes.length, stream: Readable.from([bytes]) }
    }
    const stored = await openCompressed(id)
    if (stored) remember(id)
    return stored
  }
  return {
    async put(id, bytes) {
      const wrapped = await compressed.put(id, await encodeBrotli(bytes, 9))
      remember(id)
      return wrapped
    },
    open,
    async get(id) {
      const stored = await open(id)
      if (!stored) return null
      return readBytes(stored)
    },
    async delete(id) {
      compressedOnly.delete(id)
      await Promise.all([compressed.delete(id), legacy.delete(id)])
    },
  }
}
