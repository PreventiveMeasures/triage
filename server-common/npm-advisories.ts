import { Buffer } from 'node:buffer'

const UPSTREAM_URL = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk'
const RESPONSE_BODY_LIMIT = 4 * 1024 * 1024
export const NPM_ADVISORIES_TIMEOUT_MS = 30_000

export async function fetchNpmAdvisories(body: Buffer, signal: AbortSignal, debug = false): Promise<{ status: number; body: unknown }> {
  let upstream: Response
  try {
    upstream = await fetch(UPSTREAM_URL, {
      method: 'POST',
      // Force JSON — the bulk endpoint requires it. Drop every
      // client-supplied header to keep an upstream fingerprint from
      // leaking through (cookies, auth, custom UA, ...). The
      // registry's bulk endpoint doesn't need any of them for a
      // public lookup.
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
      // Re-wrap as a plain Uint8Array — Buffer's underlying
      // ArrayBufferLike type doesn't satisfy fetch's BodyInit
      // narrowing (it can't statically rule out SharedArrayBuffer),
      // but a copy through Uint8Array is zero-cost in practice and
      // unambiguously typed.
      body: new Uint8Array(body),
      signal,
    })
  } catch (err: unknown) {
    if (debug) console.warn('npm-advisories upstream error:', err)
    return { status: 502, body: { error: 'upstream-unreachable' } }
  }
  // Assert JSON on the upstream body. The Content-Type header is
  // unreliable (Cloudflare in front of registry.npmjs.org strips it
  // from some responses; a captive portal / WAF can declare HTML on
  // a body that's actually JSON or vice-versa), so we don't lean on
  // it — instead we buffer the body and parse. A successful
  // JSON.parse is the strongest guarantee we can hand the UI's
  // `await res.json()`. Buffering is bounded by
  // `RESPONSE_BODY_LIMIT`; the advisories endpoint's payloads sit
  // well under that.
  const upstreamContentType = upstream.headers.get('content-type') ?? ''
  let buffered: Buffer | null
  try {
    buffered = await readUpstreamBody(upstream)
  } catch (err: unknown) {
    if (debug) console.warn('npm-advisories upstream body error:', err)
    return { status: 502, body: { error: 'upstream-unreachable' } }
  }
  if (buffered === null) {
    if (debug) console.warn(`npm-advisories upstream too large: status=${upstream.status}`)
    return { status: 502, body: { error: 'upstream-too-large', upstreamStatus: upstream.status } }
  }
  // Treat the body as UTF-8 — `JSON.parse` operates on a string and
  // the registry's responses are always UTF-8 in practice. A
  // non-UTF-8 byte sequence still decodes (with U+FFFD
  // substitution); the subsequent JSON.parse fails and routes
  // through the error branch.
  const text = buffered.toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    if (debug) console.warn(`npm-advisories upstream non-JSON: status=${upstream.status} ct=${upstreamContentType || '<none>'} bytes=${buffered.byteLength}`)
    return { status: 502, body: {
      error: 'upstream-not-json',
      upstreamStatus: upstream.status,
      upstreamContentType: upstreamContentType || null,
    } }
  }
  return { status: upstream.status, body: parsed }
}

// Buffer the upstream response body up to RESPONSE_BODY_LIMIT.
// Returns null if the cap is exceeded (caller maps to a 502
// `upstream-too-large`), or the cumulative Buffer otherwise. A
// transport error mid-read (e.g. AbortSignal fired by the deadline
// timer or by `req` close) throws — the caller catches it.
//
// `finally { reader.cancel() }` is load-bearing on the error and
// cap-exceeded paths: leaving the reader locked to the body holds
// the underlying undici TCP socket out of the connection pool until
// GC, and the cap-exceeded path explicitly needs to tear the
// transfer down so we don't keep buffering bytes we'll never use.
// On the clean-drain path (done:true), cancel() is a no-op.
async function readUpstreamBody(upstream: Response): Promise<Buffer | null> {
  if (!upstream.body) return Buffer.alloc(0)
  const reader = upstream.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      received += value.byteLength
      if (received > RESPONSE_BODY_LIMIT) return null
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  } finally {
    try { await reader.cancel() } catch {}
  }
}
