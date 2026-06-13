// Same-origin proxy for the npm registry's bulk advisories endpoint
// (`POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk`).
// The UI's Advisories tab on stasis bundles fans out the bundle's
// (package → versions) map through this endpoint to enrich the view
// with upstream vulnerability data; calling the registry directly
// from the browser would cross-origin (the npm registry doesn't
// emit CORS headers for arbitrary callers), so the relay forwards
// the request body and answers with the upstream's JSON.
//
// The route is mounted at `/api/npm-advisories`. The same-origin
// gate runs inside `dispatchNpmAdvisories` below (e2e-server/http.ts
// calls the dispatcher directly without a pre-check), so any
// browser request from a foreign origin is rejected with 403 before
// we ever issue a fetch — non-browser callers that omit Origin are
// allowed (their trust boundary is the network, same posture as
// every other /api/* route).
//
// Request body is capped at `REQUEST_BODY_LIMIT` (the registry caps
// a single bulk lookup well under that); upstream response is
// buffered up to `RESPONSE_BODY_LIMIT` and then `JSON.parse`-asserted
// before we writeHead, so the client's `await res.json()` never
// chokes on a Cloudflare HTML 503 page or a captive-portal banner.
// A non-parseable upstream collapses to a 502 with a documented
// `{ error, upstreamStatus, upstreamContentType }` envelope.
//
// Outbound fetch carries an `AbortController` so a hung upstream
// (slow-loris response, TLS stall) tears down after
// `UPSTREAM_TIMEOUT_MS`, and a client that closes its connection
// mid-fetch propagates an abort through the same controller — so a
// stranded in-flight call doesn't block SIGTERM drain.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Buffer } from 'node:buffer'
import { errStack } from './util.ts'

type HasHeaders = { headers: IncomingMessage['headers'] }

export const NPM_ADVISORIES_PATH = '/api/npm-advisories'
const UPSTREAM_URL = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk'

// 1 MiB is generous: the bulk endpoint accepts `{ packageName:
// [versions] }` maps, and even a bundle with thousands of pinned
// versions serialises to well under this. Anything bigger is almost
// certainly malformed input or a probe.
const REQUEST_BODY_LIMIT = 1 * 1024 * 1024
// 4 MiB caps the upstream response. The advisories endpoint
// returns at most a few CVEs per package, so even a bundle with
// hundreds of affected packages comes in well under this — a
// runaway / hostile upstream gets cut off before we burn arbitrary
// memory buffering it.
const RESPONSE_BODY_LIMIT = 4 * 1024 * 1024
// Hard deadline on the upstream call. The bulk endpoint typically
// answers in well under a second; 30 s leaves plenty of headroom
// for a slow path but caps a hung TLS / slow-loris connection so
// a stranded fetch can't pin the inflight slot through SIGTERM
// drain. Triggered via AbortController.
const UPSTREAM_TIMEOUT_MS = 30_000

export type NpmProxyDeps = {
  debug: boolean
}

export function matchNpmAdvisoriesRoute(url: string | undefined): boolean {
  if (typeof url !== 'string') return false
  return url.split('?', 1)[0] === NPM_ADVISORIES_PATH
}

export type DispatchDeps = {
  isOriginAllowed: (req: HasHeaders) => boolean
  isShuttingDown: () => boolean
  debug: boolean
}

// Combined route-match + shutdown-gate + same-origin-gate + handler
// dispatch. Returns the in-flight Promise when the request matched
// (caller `track`s it so SIGTERM awaits drainage), or null when the
// route wasn't ours (caller falls through to the next branch).
export function dispatchNpmAdvisories(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DispatchDeps,
): Promise<void> | null {
  if (!matchNpmAdvisoriesRoute(req.url)) return null
  if (deps.isShuttingDown()) {
    res.writeHead(503, { 'content-type': 'application/json', 'connection': 'close' })
    res.end(JSON.stringify({ error: 'shutting-down' }))
    return Promise.resolve()
  }
  if (!deps.isOriginAllowed(req)) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'origin-denied' }))
    return Promise.resolve()
  }
  return handleNpmAdvisories({ debug: deps.debug }, req, res).catch((err) => {
    console.warn('npm-advisories handler error:', errStack(err))
    if (res.headersSent) { try { res.destroy() } catch {} }
    else {
      try {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal' }))
      } catch {}
    }
  })
}

// True iff the response is still in a writable state. `writableEnded`
// flips only after `res.end()` resolves; a client-disconnect tears
// the socket down asynchronously, leaving a brief window where
// `writableEnded` is still false but `destroyed` is true and any
// write throws ERR_STREAM_DESTROYED. Checking both keeps the
// after-disconnect log path quiet.
function canWrite(res: ServerResponse): boolean {
  return !res.writableEnded && !res.destroyed
}

// Write a JSON error envelope, swallowing throws if the socket
// already closed mid-write. The outer try/catch is the belt to
// `canWrite`'s suspenders — a `destroyed` flip between the gate
// check and `res.end()` is rare but possible on a busy connection,
// and there's nothing useful to do besides drop the write.
function deny(res: ServerResponse, status: number, reason: string): void {
  if (!canWrite(res)) return
  try {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: reason }))
  } catch {}
}

// Same shape as `deny` but for the richer multi-field envelopes
// (upstream-not-json / upstream-too-large) — these can't reuse
// `deny` because the body carries more than `{ error }`.
function writeJsonEnvelope(res: ServerResponse, status: number, body: object): void {
  if (!canWrite(res)) return
  try {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  } catch {}
}

// Drain the incoming request body into a single Buffer, rejecting
// once REQUEST_BODY_LIMIT is exceeded. We don't try to parse here —
// we forward the bytes verbatim so the registry sees exactly what
// the client sent (preserving key order / whitespace doesn't matter
// to the upstream, but parse-then-restringify is wasted work).
async function readRequestBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    received += buf.byteLength
    if (received > REQUEST_BODY_LIMIT) return null
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

export async function handleNpmAdvisories(
  deps: NpmProxyDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') { deny(res, 405, 'method-not-allowed'); return }
  // Single controller drives both the upstream deadline timer AND
  // the client-disconnect propagation: a fetch hung past
  // UPSTREAM_TIMEOUT_MS and a browser tab closed mid-fetch both end
  // up aborting the same signal, which undici threads through into
  // the body reader. Without this the inflight slot pinned by
  // `track()` could outlive both a dead client and a wedged
  // upstream, holding SIGTERM drain open.
  //
  // Install the listener + timer BEFORE the body read so a client
  // disconnect during the upload window also flips the controller
  // (and so a tail-end disconnect doesn't race the listener
  // registration). The timer is overall budget — running across the
  // body read + upstream call together is fine; the body read is
  // bounded by REQUEST_BODY_LIMIT and finishes in ms.
  //
  // `res.on('close')` (NOT `req.on('close')`) is the right
  // disconnect signal here: IncomingMessage's `close` fires when
  // the REQUEST is fully drained — even on a clean POST that's
  // followed by a healthy response — and would always trigger an
  // abort the instant we finished reading the body. The
  // ServerResponse's `close` event only fires when the underlying
  // socket gets destroyed before `res.end()` completes, which is
  // exactly the "browser tab closed mid-fetch" case we want to
  // propagate. (Gate on `writableEnded` so a post-success close
  // doesn't fire a no-op abort — itself a no-op on a settled
  // controller, but skipping the log noise.)
  const controller = new AbortController()
  const timer = setTimeout(() => { try { controller.abort() } catch {} }, UPSTREAM_TIMEOUT_MS)
  const onResClose = (): void => {
    if (!res.writableEnded) controller.abort()
  }
  res.on('close', onResClose)
  try {
    let body: Buffer | null
    try {
      body = await readRequestBody(req)
    } catch (err: unknown) {
      // `for await (chunk of req)` throws on mid-upload connection
      // drops (ECONNRESET / aborted). The client is already gone,
      // so there's no useful response to write — and bubbling up
      // to the dispatcher's catch would just emit a misleading
      // "handler error" log. Same posture other handlers take for
      // mid-body aborts: swallow + return.
      if (deps.debug) console.warn('npm-advisories request body error:', errStack(err))
      return
    }
    if (body === null) {
      // Respond BEFORE destroying so the client sees the 413
      // envelope (writeHead on a destroyed socket would silently
      // drop). Then destroy: a bare `return` leaves the unread
      // tail of the request body in the kernel buffer, which on
      // an HTTP/1.1 keep-alive connection becomes the
      // start-of-line for the NEXT request and corrupts request
      // framing. Matches the sse-server.ts pattern
      // (`{ error: 'too-large' }` then `req.destroy()`).
      deny(res, 413, 'payload-too-large')
      try { req.destroy() } catch {}
      return
    }
    await handleNpmAdvisoriesInner(deps, body, res, controller.signal)
  } finally {
    clearTimeout(timer)
    res.off('close', onResClose)
  }
}

async function handleNpmAdvisoriesInner(
  deps: NpmProxyDeps,
  body: Buffer,
  res: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
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
    if (deps.debug) console.warn('npm-advisories upstream error:', errStack(err))
    // Client already gone — `canWrite` (inside `deny`) gates the
    // write so a destroyed / writableEnded socket doesn't trip
    // ERR_STREAM_DESTROYED on the way out.
    deny(res, 502, 'upstream-unreachable')
    return
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
    if (deps.debug) console.warn('npm-advisories upstream body error:', errStack(err))
    deny(res, 502, 'upstream-unreachable')
    return
  }
  if (buffered === null) {
    if (deps.debug) console.warn(`npm-advisories upstream too large: status=${upstream.status}`)
    writeJsonEnvelope(res, 502, { error: 'upstream-too-large', upstreamStatus: upstream.status })
    return
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
    if (deps.debug) console.warn(`npm-advisories upstream non-JSON: status=${upstream.status} ct=${upstreamContentType || '<none>'} bytes=${buffered.byteLength}`)
    writeJsonEnvelope(res, 502, {
      error: 'upstream-not-json',
      upstreamStatus: upstream.status,
      upstreamContentType: upstreamContentType || null,
    })
    return
  }
  if (!canWrite(res)) return
  // Re-stringify rather than echoing `text` so the wire shape we
  // emit is canonical (no upstream whitespace / BOM / trailing
  // junk after the parsed value rides along), and so the client
  // can rely on a single JSON document per response.
  const out = JSON.stringify(parsed)
  try {
    res.writeHead(upstream.status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(out),
    })
    res.end(out)
  } catch {}
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
