// Static-file plane: serve the production UI bundle that `build.js
// build` writes to `out/`. The directory is enumerated once at boot,
// every regular file's bytes are slurped into the `files` map keyed
// by basename, and the handler answers GET/HEAD against that fixed
// whitelist. The only on-disk paths we ever open are
// `join(staticDir, dirent.name)` from `readdirSync` at boot — the
// request URL is only used as a Map key, never joined with the
// filesystem — so the handler has no path-traversal surface at all:
// `..`, percent-encoded slashes, nested subpaths and absolute-form
// URIs all just produce a key that isn't in the map and 404.
//
// Compression: every entry whose extension is in COMPRESSIBLE gets
// pre-computed brotli + gzip at boot. The handler picks brotli over
// gzip over identity based on the request's Accept-Encoding header;
// the response carries `Content-Encoding` and `Vary:
// Accept-Encoding` so intermediate caches bucket per encoding.
//
// Revalidation: every entry carries an ETag derived from a SHA-256
// of the identity bytes. Conditional GET (`If-None-Match`) returns
// 304 without the body. The ETag is shared across encodings — the
// `Vary` header tells caches to keep separate buckets per encoding,
// and a revalidation arrives under the same Accept-Encoding the
// cached entry was stored against, so the single ETag suffices.

import type { IncomingMessage as HttpRequest, ServerResponse } from 'node:http'
import type { Buffer } from 'node:buffer'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib'
import { extname, join } from 'node:path'

// MIME types for extensions the production UI bundle currently
// emits. Anything else falls through to `application/octet-stream`
// — a future image / font asset would still be served, just without
// a precise type. Extend if you add an extension; keep the set
// minimal so unknown extensions are visible at deploy time.
const CONTENT_TYPE: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
}
// Only types that actually shrink under brotli/gzip. The current
// build emits no binary assets — a future PNG / WOFF2 would gain
// nothing from re-compressing (they're already entropy-encoded) and
// would waste boot CPU + memory. Kept in lock-step with
// CONTENT_TYPE: every entry here MUST be a text-shaped MIME above.
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.svg', '.webmanifest'])

type StaticEntry = {
  type: string
  etag: string
  identity: Buffer
  gzip: Buffer | null
  br: Buffer | null
}

export type StaticHandler = (req: HttpRequest, res: ServerResponse) => boolean

// Build the static-file map and return a handler. The returned
// function answers true when it consumed the request (200 / 304),
// false when the request wasn't a static-file GET/HEAD — the
// caller falls through to its next route. Missing `staticDir`
// (pre-build case) logs a warning and returns a handler that always
// answers false; the API/WS planes are unaffected.
export function loadStatic(staticDir: string): StaticHandler {
  const files = readStaticFiles(staticDir)
  return function handleStatic(req: HttpRequest, res: ServerResponse): boolean {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    if (typeof req.url !== 'string') return false
    const path = req.url.split('?', 1)[0]!
    // `/` aliases to `index.html`. Every other path is the leading-
    // slash-stripped URL used as a literal Map key — no filesystem
    // join, no path normalisation. Absolute-form URIs (`http://…`)
    // don't start with `/` and fall through to null → 404.
    const name = path === '/' ? 'index.html' : path.startsWith('/') ? path.slice(1) : null
    const entry = name == null ? undefined : files.get(name)
    if (!entry) return false
    const ifNoneMatch = req.headers['if-none-match']
    const { body, encoding } = pickEncoding(req.headers['accept-encoding'], entry)
    if (typeof ifNoneMatch === 'string' && matchesETag(ifNoneMatch, entry.etag)) {
      // 304 echoes the variant headers that would have accompanied
      // the 200 for the same request (RFC 9111 §4.3.4): the cached
      // entity already has a `Content-Encoding` matching this
      // negotiation, so re-asserting it lets a strict shared cache
      // bind the freshening to the right variant under Vary.
      const headers: Record<string, string | number> = { 'etag': entry.etag, 'cache-control': 'no-cache', 'vary': 'accept-encoding' }
      if (encoding != null) headers['content-encoding'] = encoding
      res.writeHead(304, headers)
      res.end()
      return true
    }
    const headers: Record<string, string | number> = {
      'content-type': entry.type,
      'content-length': body.byteLength,
      'etag': entry.etag,
      'cache-control': 'no-cache',
      'vary': 'accept-encoding',
    }
    if (encoding != null) headers['content-encoding'] = encoding
    res.writeHead(200, headers)
    // HEAD shares the GET response headers but never carries a body.
    // Node won't drop it for us — caller must skip the write.
    if (req.method === 'HEAD') res.end()
    else res.end(body)
    return true
  }
}

function readStaticFiles(staticDir: string): ReadonlyMap<string, StaticEntry> {
  const files = new Map<string, StaticEntry>()
  let entries
  try { entries = readdirSync(staticDir, { withFileTypes: true }) } catch (err) {
    // Missing `out/` is the pre-build case — operator hasn't run
    // `node --run build` yet. Log once and skip; the API/WS planes
    // are still functional, just no UI is served.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      console.warn(`static: ${staticDir} missing — UI not served (run \`node --run build\`)`)
      return files
    }
    throw err
  }
  for (const entry of entries) {
    // `isFile()` filters subdirectories, symlinks, FIFOs etc. The
    // build emits a flat tree; dropping anything else keeps the
    // surface minimal even if a stray non-file sneaks in.
    if (!entry.isFile()) continue
    files.set(entry.name, buildEntry(staticDir, entry.name))
  }
  return files
}

function buildEntry(staticDir: string, name: string): StaticEntry {
  const ext = extname(name)
  const identity = readFileSync(join(staticDir, name))
  const type = CONTENT_TYPE[ext] ?? 'application/octet-stream'
  // 16 bytes of SHA-256 (32 hex chars) — plenty for revalidation
  // collision-resistance against the ~tens of files we load.
  const etag = `"${createHash('sha256').update(identity).digest('hex').slice(0, 32)}"`
  const isCompressible = COMPRESSIBLE.has(ext)
  // Brotli quality 11 is the maximum — slow at compress time but
  // we pay it once at boot and ship the smaller bytes on every
  // request thereafter. text mode tells the encoder we're working
  // on UTF-8 text (every COMPRESSIBLE entry is text-shaped).
  const br = isCompressible ? brotliCompressSync(identity, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_TEXT,
    },
  }) : null
  const gzip = isCompressible ? gzipSync(identity, { level: 9 }) : null
  return { type, etag, identity, gzip, br }
}

// Prefer brotli over gzip over identity. Both compressed variants
// are pre-computed; runtime cost is one Accept-Encoding parse +
// a Buffer reference pick. Node surfaces repeated `Accept-Encoding`
// headers as `string[]` (it's not on the list-fold whitelist) — join
// before parsing so the array case doesn't silently fall through to
// identity and miss compression.
function pickEncoding(accept: string | string[] | undefined, entry: StaticEntry): { body: Buffer, encoding: string | null } {
  const header = Array.isArray(accept) ? accept.join(',') : accept
  if (typeof header === 'string') {
    if (entry.br && acceptsEncoding(header, 'br')) return { body: entry.br, encoding: 'br' }
    if (entry.gzip && acceptsEncoding(header, 'gzip')) return { body: entry.gzip, encoding: 'gzip' }
  }
  return { body: entry.identity, encoding: null }
}

// `Accept-Encoding: <name>[;q=N], …`. Returns true if `encoding`
// (or `*`) is listed with a positive q-value. We don't sort by
// q-value — Accept-Encoding q-values are effectively never used in
// the wild to invert the brotli-then-gzip preference, and a wrong
// answer here just trades a few percent of bytes, never correctness.
function acceptsEncoding(header: string, encoding: string): boolean {
  for (const part of header.split(',')) {
    const tokens = part.trim().split(';').map((s) => s.trim())
    const name = tokens[0]!.toLowerCase()
    if (name !== encoding && name !== '*') continue
    let q = 1
    for (const t of tokens.slice(1)) {
      const m = /^q=(\d*\.?\d+)$/iu.exec(t)
      if (m) q = Number(m[1])
    }
    if (q > 0) return true
  }
  return false
}

// `If-None-Match: "…", "…", *`. Strong or weak (`W/`-prefixed)
// validators both match — for a static asset the distinction is
// academic (we never serve a semantically-equivalent variant), and
// matching both keeps the revalidation path working under proxies
// that downgrade the validator.
function matchesETag(header: string, etag: string): boolean {
  for (const part of header.split(',')) {
    const trimmed = part.trim()
    if (trimmed === '*' || trimmed === etag || trimmed === `W/${etag}`) return true
  }
  return false
}
