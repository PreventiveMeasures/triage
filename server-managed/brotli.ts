import { brotliCompress, constants } from 'node:zlib'
import { promisify } from 'node:util'
import type { Buffer } from 'node:buffer'

const compress = promisify(brotliCompress)

// Quality 4 avoids Brotli's expensive default (11) for uploads and cold caches.
export function encodeBrotli(bytes: Uint8Array): Promise<Buffer> {
  return compress(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
}
