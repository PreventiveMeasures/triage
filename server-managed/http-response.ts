import type { ServerResponse } from 'node:http'
import { Buffer } from 'node:buffer'
import { pipeline } from 'node:stream/promises'
import { createBrotliCompress, constants as zlibConstants } from 'node:zlib'
import { UPLOAD_CHUNK_BYTES } from './uploads.ts'

// Keep the header ASCII while filename* carries the original UTF-8 name.
export function attachmentDisposition(filename: string): string {
  const fallback = filename.replaceAll(/[^\u0020-\u007E]|["\\%]/gu, '_')
  const encoded = encodeURIComponent(filename.toWellFormed()).replaceAll(/['()*]/gu, ch => `%${ch.codePointAt(0)!.toString(16).toUpperCase()}`)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

// Writing body chunks enables the function's streamed-response path. Data is
// already materialized by the authorization/filtering layer before we get here.
export function writeResponse(res: ServerResponse, body: string | Buffer): void {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body
  writeResponseParts(res, [bytes], bytes.length)
}

// A body of `length` bytes held in parts, written as writeResponse writes
// one without first copying them into one buffer.
export function writeResponseParts(res: ServerResponse, parts: Buffer[], length: number): void {
  if (length <= UPLOAD_CHUNK_BYTES) { res.end(parts.length === 1 ? parts[0] : Buffer.concat(parts, length)); return }
  for (const part of parts) {
    for (let offset = 0; offset < part.length; offset += 64 * 1024) res.write(part.subarray(offset, offset + 64 * 1024))
  }
  res.end()
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  writeResponse(res, JSON.stringify(body))
}

// Lines of JSON, Brotli-encoded and sent as each is written, so the reader
// has each while the next is made. A reader gone, or no longer `allowed`
// before a line, has the response cut short, as is one whose lines fail: a
// response that ends is one with every line.
export async function sendLines(res: ServerResponse, lines: AsyncIterable<unknown>, allowed: () => Promise<boolean>) {
  const out = openLines(res)
  try {
    for await (const line of lines) {
      if (res.destroyed || !await allowed()) { out.cut(); return }
      await out.write(line)
    }
  } catch (err) {
    console.warn('managed: a streamed response failed:', err)
    out.cut()
    return
  }
  await out.end()
}

// A response of lines of JSON as sendLines sends them, written as its caller
// has each: `write` sends one, flushed, false where the reader is gone; `end`
// ends it with every line; `cut` ends it short.
export function openLines(res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'content-encoding': 'br', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' })
  const encoder = createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
  const sent = pipeline(encoder, res).catch(() => {})
  const closed = new Promise(resolve => { res.once('close', resolve) })
  return {
    async write(line: unknown): Promise<boolean> {
      if (res.destroyed) return false
      encoder.write(`${JSON.stringify(line)}\n`)
      await Promise.race([new Promise<void>(resolve => { encoder.flush(() => { resolve() }) }), closed])
      return !res.destroyed
    },
    async end() {
      encoder.end()
      await sent
    },
    cut() { res.destroy() },
  }
}
