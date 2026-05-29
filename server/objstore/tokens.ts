// Single-use bearer tokens for the v1.objstore REST plane.
//
// Issued from the WS plane (after the `objstore-put-begin` /
// `objstore-fetch` Ed25519 signature verifies) and presented in the
// `Authorization: Bearer …` header of the corresponding HTTP PUT /
// GET. The token IS the auth on the REST path — the workspace seed
// never reaches the HTTP request, only the (HMAC-bound) capability
// the WS handshake just minted.
//
// Format: `${b64url(payloadJson)}.${b64url(hmac)}`
//   payload:
//     PUT  → { op: 'put', tag, res, sid, len, exp }
//     GET  → { op: 'get', tag, res, ver, inc, exp }
// HMAC: HMAC-SHA-256 over the base64url-encoded payload, with a
// 32-byte secret minted at server start. Restart invalidates every
// outstanding token (fine — TTL is short, clients re-handshake).
//
// PUT single-use is implicit: the staging row referenced by `sid` is
// dropped on `commitPut`, so a replayed PUT fails the row lookup.
// GET is multi-use within the TTL — the bytes are AEAD'd ciphertext
// the relay can't read, so the leak window for a captured token +
// captured ciphertext is bounded by `exp` and gives no plaintext.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'

export const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000

export type PutTokenPayload = {
  op: 'put'
  tag: string
  res: string
  sid: string
  len: number
  exp: number
}

export type GetTokenPayload = {
  op: 'get'
  tag: string
  res: string
  ver: number
  // Incarnation the live row carried when the token was minted. The
  // REST GET re-checks it so a token issued for one incarnation can't
  // serve a recreated incarnation that happens to share the version
  // number.
  inc: string
  exp: number
}

export type TokenPayload = PutTokenPayload | GetTokenPayload

export type TokenSecret = Uint8Array<ArrayBuffer>

export function newTokenSecret(): TokenSecret {
  // 32 bytes for HMAC-SHA-256 — matches the block / output size and
  // keeps brute-force forgery ~2^256 work.
  return randomBytes(32) as Uint8Array<ArrayBuffer>
}

function b64u(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function fromB64u(str: string): Buffer {
  return Buffer.from(str, 'base64url')
}

function hmac(secret: TokenSecret, data: string): Buffer {
  // `Uint8Array` IS `BinaryLike` per node:crypto's types — no cast
  // needed. `createHmac` accepts the secret directly.
  return createHmac('sha256', secret).update(data).digest()
}

export function signToken(secret: TokenSecret, payload: TokenPayload): string {
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'))
  const sig = b64u(hmac(secret, body))
  return `${body}.${sig}`
}

// Returns the parsed payload on success, or null on any failure
// (malformed shape, bad HMAC, expired). Single error-reason channel
// keeps the REST handler from leaking distinguishing info to the
// client — every reject is an opaque 401.
export function verifyToken(secret: TokenSecret, token: unknown, now: number = Date.now()): TokenPayload | null {
  if (typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  let expected: Buffer
  try { expected = hmac(secret, body) } catch { return null }
  let provided: Buffer
  try { provided = fromB64u(sig) } catch { return null }
  // The HMAC output is always 32 bytes; reject any other-length
  // signature outright (timingSafeEqual itself throws on
  // length-mismatch). The early return on length is fine
  // operationally — an attacker controls the sig length they
  // submit, so leaking that bit isn't a side channel they don't
  // already know.
  if (provided.byteLength !== expected.byteLength) return null
  if (!timingSafeEqual(provided, expected)) return null
  let parsed: unknown
  try { parsed = JSON.parse(fromB64u(body).toString('utf8')) } catch { return null }
  if (!isValidPayload(parsed)) return null
  if (parsed.exp < now) return null
  return parsed
}

function isValidPayload(v: unknown): v is TokenPayload {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o['tag'] !== 'string' || typeof o['res'] !== 'string') return false
  // `Number.isSafeInteger` over `Number.isInteger`: `exp` is compared
  // to `Date.now()` (a safe int), `len` against the Content-Length the
  // REST layer parsed (itself `isSafeInteger`-gated), and `ver` against
  // SQLite's INTEGER (capacity 2^63). An unsafe-but-integer value in the
  // token round-trips through IEEE-754 and could spoof equality with a
  // different actual value, or — for `exp` — claim a
  // `Number.MAX_SAFE_INTEGER + 1` expiry that compares ambiguously near
  // the IEEE-754 boundary. Matches the codebase's other safe-int gates
  // (server/objstore/sign.ts, rest.ts, handlers.ts).
  if (!Number.isSafeInteger(o['exp']) || (o['exp'] as number) < 0) return false
  if (o['op'] === 'put') {
    return typeof o['sid'] === 'string'
      && typeof o['len'] === 'number'
      && Number.isSafeInteger(o['len'])
      && o['len'] >= 0
  }
  if (o['op'] === 'get') {
    return typeof o['ver'] === 'number'
      && Number.isSafeInteger(o['ver'])
      && o['ver'] >= 0
      && typeof o['inc'] === 'string'
  }
  return false
}

// Constructors so the WS handler doesn't assemble the payload inline.
export function mintPutToken(
  secret: TokenSecret,
  tag: string, res: string, sid: string, len: number,
  ttlMs: number = DEFAULT_TOKEN_TTL_MS,
): { token: string; exp: number } {
  const exp = Date.now() + ttlMs
  return { token: signToken(secret, { op: 'put', tag, res, sid, len, exp }), exp }
}

export function mintGetToken(
  secret: TokenSecret,
  tag: string, res: string, ver: number, inc: string,
  ttlMs: number = DEFAULT_TOKEN_TTL_MS,
): { token: string; exp: number } {
  const exp = Date.now() + ttlMs
  return { token: signToken(secret, { op: 'get', tag, res, ver, inc, exp }), exp }
}

// `Authorization: Bearer <token>` extractor. Returns the token
// string on match, null otherwise — case-insensitive on the scheme
// but strict on whitespace shape.
export function extractBearer(header: unknown): string | null {
  if (typeof header !== 'string') return null
  const m = /^Bearer\s+(\S+)\s*$/iu.exec(header)
  return m ? m[1]! : null
}
