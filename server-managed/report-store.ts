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

export function createReportStore(legacy: BlobStore, compressed: BlobStore,
  replaceLegacy: (id: string, bytes: Buffer) => Promise<unknown>): BlobStore {
  async function open(id: string): Promise<OpenedBlob | null> {
    // Keep the original available until conversion succeeds. Concurrent reads
    // can finish using an already-open stream while another reader converts it.
    const original = await legacy.open(id)
    if (original) {
      const bytes = await readBytes(original)
      await replaceLegacy(id, await encodeBrotli(bytes, 9))
      return { size: bytes.length, stream: Readable.from([bytes]) }
    }
    const stored = await compressed.open(id)
    if (!stored) return null
    const stream = createBrotliDecompress()
    // pipeline carries storage/authentication errors into the decoded stream
    // and closes the stored source when a reader leaves before EOF.
    void pipeline(stored.stream, stream).catch(() => {})
    return { size: null, stream }
  }
  return {
    put: async (id, bytes) => compressed.put(id, await encodeBrotli(bytes, 9)),
    open,
    async get(id) {
      const stored = await open(id)
      if (!stored) return null
      return readBytes(stored)
    },
    async delete(id) { await Promise.all([compressed.delete(id), legacy.delete(id)]) },
  }
}
