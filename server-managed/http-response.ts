import type { ServerResponse } from 'node:http'
import { Buffer } from 'node:buffer'
import { UPLOAD_CHUNK_BYTES } from './uploads.ts'

// Writing body chunks enables the function's streamed-response path. Data is
// already materialized by the authorization/filtering layer before we get here.
export function writeResponse(res: ServerResponse, body: string | Buffer): void {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body
  if (bytes.length <= UPLOAD_CHUNK_BYTES) { res.end(body); return }
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024) res.write(bytes.subarray(offset, offset + 64 * 1024))
  res.end()
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  writeResponse(res, JSON.stringify(body))
}

