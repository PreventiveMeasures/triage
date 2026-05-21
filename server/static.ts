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
//
// Preload extraction: at boot, HTML files have their
// `<link rel="preload">` / `<link rel="modulepreload">` tags lifted
// into a `Link` response header (RFC 8288) and dropped from the
// served body. The header arrives with the response headers — before
// HTML body parsing — so the browser can start the sub-resource
// fetches a round-trip earlier than the in-body tag would allow. The
// stripped body is what ETag + compression are computed against, so
// `out/index.html` on disk and the bytes we serve diverge by exactly
// the lifted tags.

import type { IncomingMessage as HttpRequest, ServerResponse } from 'node:http'
import { Buffer } from 'node:buffer'
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

// Defensive headers attached to every static response. `nosniff` is
// the load-bearing one: without it a browser may MIME-sniff the
// `application/octet-stream` fallback (buildEntry) or a directly-
// navigated `image/svg+xml` icon into something script-executable.
// `no-referrer` keeps URLs of this (potentially sensitive) viewer out
// of outbound Referer headers, and `same-origin` CORP stops other
// origins embedding these bytes. CSP is deliberately NOT here: the
// HTML documents carry their own per-page `<meta http-equiv>` policy
// (and the three pages differ), so a blanket header CSP would just AND
// against the meta one and risk breaking a page — non-document assets
// get their own flat CSP via `StaticEntry.csp` instead.
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
} as const

type StaticEntry = {
  type: string
  etag: string
  identity: Buffer
  gzip: Buffer | null
  br: Buffer | null
  link: string | null
  csp: string | null
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
      const headers: Record<string, string | number> = { ...SECURITY_HEADERS, 'etag': entry.etag, 'cache-control': 'no-cache', 'vary': 'accept-encoding' }
      if (encoding != null) headers['content-encoding'] = encoding
      if (entry.link != null) headers['link'] = entry.link
      if (entry.csp != null) headers['content-security-policy'] = entry.csp
      res.writeHead(304, headers)
      res.end()
      return true
    }
    const headers: Record<string, string | number> = {
      ...SECURITY_HEADERS,
      'content-type': entry.type,
      'content-length': body.byteLength,
      'etag': entry.etag,
      'cache-control': 'no-cache',
      'vary': 'accept-encoding',
    }
    if (encoding != null) headers['content-encoding'] = encoding
    if (entry.link != null) headers['link'] = entry.link
    if (entry.csp != null) headers['content-security-policy'] = entry.csp
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
  const raw = readFileSync(join(staticDir, name))
  const type = CONTENT_TYPE[ext] ?? 'application/octet-stream'
  // HTML: lift `<link rel="(module)preload" …>` into a Link header
  // and drop the tags from the served body so the bytes ship without
  // the now-redundant in-body hint. ETag + compression run against
  // the stripped body — the on-disk file and the served body diverge
  // by exactly the lifted tags.
  let identity = raw
  let link: string | null = null
  if (ext === '.html') {
    const extracted = extractPreloadLinks(raw.toString('utf8'))
    link = extracted.link
    if (link != null) identity = Buffer.from(extracted.html, 'utf8')
  }
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
  // HTML documents self-protect with a per-page `<meta http-equiv>`
  // CSP, so we don't set a header CSP for them (it'd AND against the
  // meta policy). Every other asset carries no in-body policy — a
  // directly-navigated SVG icon or the octet-stream fallback would run
  // with none — so pin them to `default-src 'none'`: it neutralises
  // inline script and external fetches if such a resource is ever
  // loaded as a top-level document, and is inert when the asset is
  // fetched as a sub-resource (CSP only governs the document context).
  const csp = ext === '.html' ? null : "default-src 'none'"
  return { type, etag, identity, gzip, br, link, csp }
}

// Walk every `<link …>` in `html` that isn't inside an HTML comment
// or inside `<script>` / `<noscript>` raw-text content. For
// `rel="preload"` / `rel="modulepreload"`, accumulate an RFC 8288
// Link-header form and strip the tag (plus its trailing whitespace)
// from the body. Every other rel value, and every `<link>` inside a
// skipped region, is preserved verbatim. Returns the (possibly
// modified) HTML and the comma-joined Link header value, or
// `link: null` if no preload tags were found.
function extractPreloadLinks(html: string): { html: string, link: string | null } {
  const links: string[] = []
  // Skip ranges = char offsets inside comments / script bodies /
  // noscript bodies. The build's `<noscript>` fallback (and any
  // commented-out preload hint, or a `<link>` mentioned as a JS
  // string inside `<script>`) MUST NOT get lifted into the response
  // headers — it'd start fetches the page author explicitly didn't
  // want, and on a malformed build could leak attacker-influenced
  // bytes into the header. Heuristic, not a real HTML parser: the
  // build emits clean, predictable tags; this just keeps the lift
  // from over-reaching on the kinds of surrounding content the
  // codebase actually produces.
  const skip = findSkipRanges(html)
  // `[^>]*` is greedy but stops at `>`, so it spans multi-line tag
  // attribute soup, including newlines inside the attr list. Trailing
  // `\s*` is part of `match` in both branches — when we strip a
  // preload tag the line break goes with it (body collapses cleanly);
  // when we keep a non-preload tag the whitespace is restored via
  // `return match` (HTML layout preserved).
  const tagRe = /<link\b[^>]*>\s*/giu
  const stripped = html.replace(tagRe, (match, offset: number) => {
    if (inAnyRange(offset, skip)) return match
    const attrs = parseLinkAttrs(match)
    const rel = (attrs['rel'] ?? '').toLowerCase()
    if (rel !== 'preload' && rel !== 'modulepreload') return match
    const href = attrs['href']
    if (!href) return match
    // Defence in depth against a future template emitting an attr
    // value that splits the header (`\r\n` injects new headers;
    // `,`/`;`/`"` confuse the Link parser; `<`/`>` terminate the
    // URI-Reference early). The build emits clean values today, so
    // this only fires under a malformed source — and bailing out
    // (return match) is the safe choice: the tag stays in the body
    // as an in-HTML preload hint, just no header lift.
    if (isUnsafeAttr(href) || isUnsafeAttr(attrs['as'] ?? '') || isUnsafeAttr(attrs['type'] ?? '') || isUnsafeAttr(attrs['crossorigin'] ?? '')) return match
    // Quote every param value uniformly. `rel`/`as`/`crossorigin`
    // values happen to be valid RFC 7230 tokens today (preload,
    // style, anonymous, …) and would parse unquoted, but the
    // asymmetry with `type="…"` reads as accidental and a future
    // value containing whitespace would silently split the header.
    let value = `<${normalizeHref(href)}>; rel="${rel}"`
    if (rel === 'preload' && attrs['as']) value += `; as="${attrs['as']}"`
    if (attrs['type']) value += `; type="${attrs['type']}"`
    // `'crossorigin' in attrs` distinguishes "attribute present" from
    // "attribute missing"; the boolean form (no `=`) and the valued
    // form (`crossorigin="anonymous"`) emit differently per RFC 8288.
    if ('crossorigin' in attrs) value += attrs['crossorigin'] ? `; crossorigin="${attrs['crossorigin']}"` : '; crossorigin'
    links.push(value)
    return ''
  })
  return { html: stripped, link: links.length === 0 ? null : links.join(', ') }
}

function isUnsafeAttr(s: string): boolean {
  return /[\r\n",;<>]/u.test(s)
}

// Find character ranges in `html` whose contents are NOT real HTML
// content: comment bodies and script / noscript raw-text bodies. A
// `<link>` whose match offset falls inside any range is preserved
// verbatim (no header lift). Heuristic: a real HTML parser is
// overkill here — the build emits clean, well-formed markup; this is
// defence against the build (or a hand edit) accidentally mentioning
// `<link rel="preload">` somewhere it isn't meant to fire.
function findSkipRanges(html: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const patterns = [
    /<!--[\s\S]*?-->/gu,
    /<script\b[^>]*>[\s\S]*?<\/script\s*>/giu,
    /<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/giu,
  ]
  for (const re of patterns) {
    for (const m of html.matchAll(re)) ranges.push([m.index!, m.index! + m[0].length])
  }
  return ranges
}

function inAnyRange(offset: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (offset >= start && offset < end) return true
  }
  return false
}

// Minimal HTML attribute parser scoped to a single `<link …>` tag.
// Handles double-quoted, single-quoted, and bare attribute values,
// plus boolean attributes (e.g. `crossorigin`). Lowercases names so
// downstream comparisons can use canonical keys. Not a general HTML
// parser — the build emits well-formed tags and that's the only
// surface we run on.
function parseLinkAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const inner = tag.replace(/^<link\b/iu, '').replace(/\/?>\s*$/u, '')
  const re = /([a-z_][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/giu
  for (const m of inner.matchAll(re)) {
    attrs[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
  }
  return attrs
}

// Normalise `href` to a root-relative URL. The build emits
// `./foo.css`-style same-dir hrefs; Link header URIs resolve against
// the response URL so `./foo.css` would also work, but root-relative
// reads correctly regardless of which page the header rides on.
function normalizeHref(href: string): string {
  const stripped = href.startsWith('./') ? href.slice(2) : href
  return stripped.startsWith('/') ? stripped : `/${stripped}`
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
