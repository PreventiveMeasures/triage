// Managed uploads cross TLS-terminating proxies (Cloudflare, corporate
// gateways) that would otherwise read report and bundle bytes in plaintext.
// The server sends each session an X25519 public key; the browser seals every
// upload to it with a fresh ephemeral key (X25519 → HKDF-SHA-256 →
// AES-256-GCM), so the content key itself never crosses the proxy. Text is
// gzipped before sealing; binary content is sealed as is.
//
// Sealed body: version(1) | flags(1) | ephemeral public key(32), then the
// payload in 1 MiB segments, each sealed under nonce = big-endian segment
// index with the last byte marking the final segment. The header is the HKDF
// salt, so altering it changes the key. Segments bound browser memory for
// large bundles, and their nonces reject reordered, truncated or extended
// bodies. Every upload derives its own key, so counter nonces never repeat.

import { gunzipBytes } from '../gzip.js'
import { encodeUtf8 } from '../utf8.js'

// Set (to the format version) on a request whose body is sealed.
export const UPLOAD_SEAL_HEADER = 'x-upload-encryption'
const VERSION = 1
const FLAG_GZIP = 1
const CURVE = { name: 'X25519' }
const HEADER_BYTES = 2 + 32
const TAG_BYTES = 16
const SEGMENT_BYTES = 1024 * 1024
const SNIFF_BYTES = 64 * 1024
const KEY_INFO = 'deepview-managed-upload.v1.content-key'

// The largest sealed body for `maxBytes` of content. Deflate can grow
// incompressible text slightly (its worst case is about 0.03%).
export function maxSealedBytes(maxBytes: number): number {
  const payload = maxBytes + Math.ceil(maxBytes / 1024) + 64
  return HEADER_BYTES + payload + TAG_BYTES * (Math.floor(payload / SEGMENT_BYTES) + 1)
}

function nonce(index: number, final: boolean): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(12)
  new DataView(iv.buffer).setUint32(7, index)
  iv[11] = final ? 1 : 0
  return iv
}

async function contentKey(secret: ArrayBuffer, header: Uint8Array<ArrayBuffer>, usage: KeyUsage): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey'])
  return await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: header, info: encodeUtf8(KEY_INFO) },
    ikm, { name: 'AES-GCM', length: 256 }, false, [usage])
}

// Archives and other binary content would only grow under gzip. A NUL byte or
// invalid UTF-8 in the first 64 KiB marks content as binary.
async function isText(blob: Blob): Promise<boolean> {
  const head = new Uint8Array(await blob.slice(0, SNIFF_BYTES).arrayBuffer())
  if (head.includes(0)) return false
  try { new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true }); return true }
  catch { return false }
}

// Seal `blob` to the server's raw public key. Reads the input as a stream;
// sealed segments are kept as Blobs, which browsers may page to disk. An abort
// stops reading at the next chunk.
export async function sealUpload(blob: Blob, publicKey: Uint8Array<ArrayBuffer>, signal?: AbortSignal): Promise<Blob> {
  const gzip = await isText(blob)
  const [server, ephemeral] = await Promise.all([
    crypto.subtle.importKey('raw', publicKey, CURVE, false, []),
    crypto.subtle.generateKey(CURVE, false, ['deriveBits']) as Promise<CryptoKeyPair>,
  ])
  const header = new Uint8Array(HEADER_BYTES)
  header[0] = VERSION
  header[1] = gzip ? FLAG_GZIP : 0
  header.set(new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey)), 2)
  const key = await contentKey(await crypto.subtle.deriveBits({ name: 'X25519', public: server }, ephemeral.privateKey, 256), header, 'encrypt')
  const parts = [new Blob([header])], segment = new Uint8Array(SEGMENT_BYTES)
  let filled = 0, index = 0
  const seal = async (final: boolean) => {
    parts.push(new Blob([await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce(index++, final) }, key, segment.subarray(0, filled))]))
    filled = 0
  }
  const stream: ReadableStream<Uint8Array> = gzip ? blob.stream().pipeThrough(new CompressionStream('gzip')) : blob.stream()
  const reader = stream.getReader()
  try {
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      signal?.throwIfAborted()
      for (let offset = 0; offset < read.value.length;) {
        // A full segment is final only if the input ends with it.
        if (filled === SEGMENT_BYTES) await seal(false)
        const length = Math.min(SEGMENT_BYTES - filled, read.value.length - offset)
        segment.set(read.value.subarray(offset, offset + length), filled)
        filled += length
        offset += length
      }
    }
  } catch (err) {
    await reader.cancel(err).catch(() => {})
    throw err
  }
  await seal(true)
  return new Blob(parts)
}

// Open a sealed body with the session's private JWK. Throws 'too-large' when
// the content exceeds `maxBytes`, else 'bad-upload' for any invalid body.
export async function openUpload(sealed: Uint8Array<ArrayBuffer>, privateKey: JsonWebKey, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  // Every segment but the last is full, so the layout follows from the length.
  const rest = sealed.length - HEADER_BYTES
  const count = Math.ceil(rest / (SEGMENT_BYTES + TAG_BYTES))
  const last = rest - (count - 1) * (SEGMENT_BYTES + TAG_BYTES)
  if (rest < TAG_BYTES || last < TAG_BYTES || sealed[0] !== VERSION || (sealed[1]! & ~FLAG_GZIP) !== 0) throw new Error('bad-upload')
  const gzip = sealed[1] === FLAG_GZIP, plain = new Uint8Array(rest - count * TAG_BYTES)
  if (!gzip && plain.length > maxBytes) throw new Error('too-large')
  try {
    const header = sealed.slice(0, HEADER_BYTES)
    const [key, peer] = await Promise.all([
      crypto.subtle.importKey('jwk', privateKey, CURVE, false, ['deriveBits']),
      crypto.subtle.importKey('raw', header.slice(2), CURVE, false, []),
    ])
    const content = await contentKey(await crypto.subtle.deriveBits({ name: 'X25519', public: peer }, key, 256), header, 'decrypt')
    for (let index = 0; index < count; index++) {
      const start = HEADER_BYTES + index * (SEGMENT_BYTES + TAG_BYTES)
      const segment = sealed.subarray(start, Math.min(start + SEGMENT_BYTES + TAG_BYTES, sealed.length))
      plain.set(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce(index, index === count - 1) }, content, segment)), index * SEGMENT_BYTES)
    }
  } catch (err) { throw new Error('bad-upload', { cause: err }) }
  if (!gzip) return plain
  try { return await gunzipBytes(plain, { maxBytes }) }
  catch (err) { throw new Error(err instanceof RangeError ? 'too-large' : 'bad-upload', { cause: err }) }
}
