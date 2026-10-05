import { brotliCompress, constants } from 'node:zlib'
import { promisify } from 'node:util'
import type { Buffer } from 'node:buffer'

const compress = promisify(brotliCompress)

// Bundles and cold caches use quality 4; stored reports use quality 9.
export function encodeBrotli(bytes: Uint8Array, quality = 4): Promise<Buffer> {
  return compress(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: quality } })
}
