// Deep links to a single finding — pure logic side. Encodes the
// finding's id plus a "where does it live" hint into the URL hash
// (`#finding=<id>&v=<hints>`) and parses the same back on the receiving
// side, so "look at THIS issue" is a link you can paste into a chat
// instead of a screenshot plus directions.
//
// Sibling of `workspace-share-link.js`, and deliberately unlike it in
// one respect: the id here is NOT a secret. A share link carries the
// workspace's private key and is therefore encrypted; a finding id is
// meaningless without the report the recipient must already have, so it
// rides in the clear and the link stays legible in a chat client.
//
// The two LOCATION hints are a different matter. A report filename
// ("acme-corp-pentest-2024.json") and a workspace id are the sender's
// own metadata, and a URL is the most-forwarded, most-logged, most-
// screenshotted string there is — so they ship as 3-byte digests
// (4 base64url chars) rather than plaintext. That is a fingerprint, not
// a sealed box: 24 bits only narrows the field, and anyone holding a
// candidate name can confirm it by hashing. What it does buy is that
// the name itself never appears in the URL, and a recipient who does
// NOT hold the report learns nothing from the link but its length.
//
// Cheap on the receiving side too: matching a hint means hashing the
// names already on disk, not reading a single file (see
// `finding-locate.js`).
//
// The hint is a HINT, not an address. The receiver tries the workspace,
// then the report, then a scan of everything stored locally (see
// `ui/view/finding-link-nav.js`) — so a link built in a workspace still
// lands for a recipient who only has the single report, and a stale
// hint costs a scan rather than the finding.
//
// Param names live in the same `&`-joined fragment namespace as
// `share=`, and the parser has the same shape as `extractShareEncoded`
// — a fragment can therefore only ever be one kind of link, and adding
// a fourth param later doesn't disturb either.

import { encodeUtf8 } from '../common/utf8.js'

// Session-local finding ids (see `client/triage.js`'s SESSION_ID_RE:
// purely numeric `_id` fallbacks, handed out by an in-memory counter
// for findings whose id couldn't be derived) are re-assigned on every
// load, so a link built on one would point at an arbitrary other
// finding after a reload — including in the SENDER's own tab. Those are
// refused up front rather than silently mis-resolving. Everything else
// the app treats as persistent — the analyzer's uuids, the deterministic
// uuids `report/finding-id.js` derives, and the codex importer's
// finding-URL ids — is linkable, which is why this is a
// "not session-local" test rather than a uuid-shape test.
const SESSION_ID_RE = /^\d+$/u

// Control characters can't appear in a uuid, a URL, or an OPFS filename
// the app will hand out, so their presence means a mangled / hand-crafted
// fragment. Rejecting them keeps a stray `\n` out of an `alert()` and out
// of the `[data-gid]` selector the reveal path builds. A scan rather than
// a character-class regex: matching control characters in a literal is a
// lint error (`no-control-regex`), and spelling the range out in code is
// clearer than the escaped equivalent anyway.
function hasControlChar(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.codePointAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

// Per-component cap. The longest legitimate value is a codex finding-URL
// id; report names and workspace ids no longer travel in the fragment at
// all. The cap exists so a hostile fragment can't push a megabyte of
// text through `decodeURIComponent` + the "couldn't find it" alert.
const MAX_PART_LEN = 512

function isUsablePart(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PART_LEN
    && !hasControlChar(value)
}

// Whether a finding id survives a reload, i.e. whether a link built on
// it means anything tomorrow. Callers use this to decide whether to
// OFFER a link at all (the per-finding Link button hides itself for a
// session-local id) rather than handing out one that silently rots.
export function isLinkableFindingId(id) {
  return isUsablePart(id) && !SESSION_ID_RE.test(id)
}

// ── location hints ───────────────────────────────────────────────────

// 3 bytes → exactly 4 base64url characters, no padding. Sized to keep
// the fragment short while still being selective enough that a hint
// usually names one report out of a user's collection: with 16.7M
// values, a library of 100 reports has a ~0.03% chance of any collision
// at all, and a collision costs only a wrong first guess (the receiver
// re-checks that the finding is actually there, then scans).
const HINT_BYTES = 3
const HINT_CHARS = 4
const HINT_RE = /^[\w-]{4}$/u

// Both hints travel as ONE `v=` parameter: 6 bytes, 8 base64url
// characters, report half first. Purely a length decision — two named
// params spend 20 characters (`&report=aB3-&ws=x_9Z`) to carry 8
// characters of payload, and a link is something people paste into
// chat, tickets and commit messages.
//
// Concatenating the two 4-character tokens IS the base64 of the 6-byte
// buffer: 3 bytes is exactly one base64 group, so nothing carries
// across the halves and either framing produces identical text. That's
// what lets the packing be a string join and the unpacking a slice,
// with no encode / decode round trip.
//
// `AAAA` (3 zero bytes) marks a half that isn't known — a single-file
// view has no workspace, and a report whose hint hasn't been hashed yet
// omits its own. A genuine digest of `AAAA` therefore reads as absent,
// once per 16.7M values per half; the cost is that the receiver skips
// straight to the scan, which is where an unmatched hint lands anyway.
const COMBINED_RE = /^[\w-]{8}$/u
const NO_HINT = 'AAAA'

// Domain-separated per kind so the same string can't produce a hint
// that matches in the other namespace — a workspace whose id happened
// to equal a report's filename would otherwise cross-resolve. Same
// convention as `workspace-id.js`'s derivation domain.
const HINT_DOMAINS = {
  report: 'deepview/finding-link/report/v1\n',
  workspace: 'deepview/finding-link/workspace/v1\n',
}

// `${kind}\0${value}` → token. Memoised because the LINK BUILDER must
// be synchronous: the Link button writes to the clipboard inside the
// click handler, and Safari drops the clipboard grant if the write
// happens after an await. Ingest primes this cache for every report it
// loads (and `switchToWorkspace` for the workspace), so by the time a
// card is on screen its hint is already here. A cold entry is not a
// failure — the link is simply built without that hint, and the
// receiver falls back to the scan.
const hintCache = new Map()

function hintKey(kind, value) { return `${kind}\0${value}` }

// Whether a value is a well-formed hint token, i.e. something
// `computeLinkHint` could have produced.
export function isLinkHint(value) {
  return typeof value === 'string' && HINT_RE.test(value)
}

// Derive (and memoise) the hint token for a report filename or a
// workspace id. Resolves to null — never throws — when the kind is
// unknown, the value is empty, or `crypto.subtle` is unavailable (some
// `file://` setups): a missing hint degrades the link, it doesn't break
// it, so the caller shouldn't have to guard.
export async function computeLinkHint(kind, value) {
  const domain = HINT_DOMAINS[kind]
  if (!domain || typeof value !== 'string' || !value) return null
  const key = hintKey(kind, value)
  const cached = hintCache.get(key)
  if (cached !== undefined) return cached
  let token
  try {
    const digest = await crypto.subtle.digest('SHA-256', encodeUtf8(domain + value))
    token = new Uint8Array(digest).slice(0, HINT_BYTES)
      .toBase64({ alphabet: 'base64url', omitPadding: true })
  } catch {
    // Not cached: an environment without crypto.subtle stays broken,
    // but a one-off failure (a lone surrogate in a filename tripping
    // encodeUtf8) shouldn't poison the entry forever.
    return null
  }
  hintCache.set(key, token)
  return token
}

// Synchronous companion — the memoised token, or null if it hasn't been
// computed yet. The link builder uses this; see `hintCache` above for
// why it can't just await.
export function knownLinkHint(kind, value) {
  if (typeof value !== 'string' || !value) return null
  return hintCache.get(hintKey(kind, value)) ?? null
}

// Pack both hints into the `v=` value, or null when neither is known
// (in which case the param is omitted entirely rather than shipping
// eight characters of "nothing"). Throws on a non-empty value that
// isn't a token, so a caller passing a raw filename finds out
// immediately instead of shipping a hint-less link.
function packLinkHints(report, workspace) {
  const halves = []
  for (const [what, hint] of [['report', report], ['workspace', workspace]]) {
    if (hint === null || hint === undefined || hint === '') { halves.push(NO_HINT); continue }
    if (!isLinkHint(hint)) {
      throw new TypeError(`encodeFindingRef: ${what} must be a link hint token, not a name`)
    }
    halves.push(hint)
  }
  if (halves.every((h) => h === NO_HINT)) return null
  return halves.join('')
}

// Split a validated `v=` value back into its two halves, mapping the
// `AAAA` filler to null.
function unpackLinkHints(value) {
  const halves = [value.slice(0, HINT_CHARS), value.slice(HINT_CHARS)]
    .map((h) => (h === NO_HINT ? null : h))
  return { report: halves[0], workspace: halves[1] }
}

// ── fragment codec ───────────────────────────────────────────────────

// Build the fragment body (no leading '#') for a finding reference.
// `report` / `workspace` are hint TOKENS (from `computeLinkHint` /
// `knownLinkHint`), not names; they leave as the single packed `v=`
// param, which is omitted when neither is known.
//
// The id is percent-encoded: usually a uuid with nothing to escape, but
// the codex importer's finding-URL ids carry `/`, `:`, `?` and —
// decisively — `&` and `=`, which would otherwise split into phantom
// params on the way back. The packed hints need no encoding (base64url
// is already fragment-safe) and are emitted verbatim.
export function encodeFindingRef({ id, report, workspace } = {}) {
  if (!isLinkableFindingId(id)) {
    throw new TypeError('encodeFindingRef: a persistent finding id is required')
  }
  const parts = [`finding=${encodeURIComponent(id)}`]
  const packed = packLinkHints(report, workspace)
  if (packed) parts.push(`v=${packed}`)
  return parts.join('&')
}

// Full shareable URL for the current page origin + pathname, mirroring
// `buildShareUrl`. `location.search` is dropped for the same reason it
// is there: the target page takes no query params, so dragging the
// sender's current `?foo=bar` into the recipient's URL would be a
// surprising leak.
export function buildFindingUrl(ref) {
  const encoded = encodeFindingRef(ref)
  if (typeof location === 'undefined') return `#${encoded}`
  return `${location.origin}${location.pathname}#${encoded}`
}

// Extract `{ id, report, workspace }` from a hash string (or
// `location.hash` when called with no argument), unpacking `v=` back
// into the two hint tokens. Returns null when the fragment carries no
// usable `finding=` param — a share link, an in-page anchor, an empty
// hash, or a payload that fails validation.
//
// HASH ONLY, matching `extractShareEncoded`. The id isn't secret, so the
// Referer-leak argument that motivates it there doesn't apply; the
// reason is uniformity — one place in the app reads deep links, and a
// caller that reached for `?finding=` would quietly bypass it.
//
// A malformed `v=` drops both hints rather than the whole ref: the id is
// what identifies the finding, and the receiver's scan can still land
// it. That also covers a link from an older build, whose separate
// `report=` / `ws=` params simply go unread. An un-decodable ID, on the
// other hand, fails the whole parse — there is nothing left to look up.
export function extractFindingRef(hash) {
  const raw = typeof hash === 'string' ? hash : (typeof location === 'undefined' ? '' : location.hash)
  if (!raw) return null
  const stripped = raw.replace(/^#/u, '')
  if (!stripped) return null
  const found = { id: null, report: null, workspace: null }
  for (const part of stripped.split('&')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq)
    const rawValue = part.slice(eq + 1)
    if (!rawValue) continue
    // The packed hints are a fixed-width token pair — validated
    // verbatim rather than decoded, since base64url has nothing
    // `encodeURIComponent` would have touched. Anything else is a link
    // from another era or a mangled paste; drop it and let the scan
    // take over.
    if (key === 'v') {
      if (!COMBINED_RE.test(rawValue)) continue
      Object.assign(found, unpackLinkHints(rawValue))
      continue
    }
    if (key !== 'finding') continue
    // Cheap length bound BEFORE decoding: percent-encoding expands at
    // most 3:1, so nothing under this cap can decode to something over
    // MAX_PART_LEN, and a megabyte fragment never reaches
    // decodeURIComponent. `isLinkableFindingId` re-checks the decoded
    // length, so this is a guard, not the rule.
    if (rawValue.length > MAX_PART_LEN * 3) continue
    let value
    // decodeURIComponent throws URIError on a truncated / invalid escape
    // (`%`, `%zz`) — common when a chat client mangles a pasted link.
    try { value = decodeURIComponent(rawValue) } catch { continue }
    if (isLinkableFindingId(value)) found.id = value
  }
  if (!found.id) return null
  return found
}

// Recognise a finding deep link pasted into free text — the reverse of
// `buildFindingUrl`, used to linkify comments (see `parseCommentRefs` in
// `ui/view/format.js`). Returns `{ id, fragment }` with the fragment
// re-emitted canonically, or null for anything that isn't one of OUR
// links.
//
// "Ours" means the CURRENT host, scheme included. A finding id resolves
// only against the reader's own local reports, so a link to some other
// deployment couldn't be followed usefully even if it were offered — and
// a same-name look-alike on another host is exactly what a linkifier
// must not present as the real thing. Credentials are refused for the
// same reason (`https://user@triage.space/…` reads as ours but isn't
// something the app ever emits).
//
// The PATH is deliberately not constrained: the caller renders a
// fragment-only href, so where the click lands doesn't depend on it, and
// leaving it free keeps `/` and `/index.html` and a subpath deployment
// all working.
//
// The anti-mutation guard is the one from `githubRefToken`: `new URL`
// silently rewrites its input (resolving `..`, lower-casing, punycoding
// IDN homographs, dropping a default port), any of which can let a
// look-alike round up into a passing link. A candidate that isn't
// already canonical is refused rather than linkified. Every link this
// app emits round-trips unchanged, since `buildFindingUrl` builds from
// `location` itself.
export function parseFindingUrl(candidate) {
  if (typeof location === 'undefined') return null
  let u
  try { u = new URL(candidate) } catch { return null }
  if (u.href !== candidate) return null
  if (u.protocol !== location.protocol) return null
  if (u.host !== location.host) return null
  if (u.username || u.password) return null
  const ref = extractFindingRef(u.hash)
  if (!ref) return null
  // Re-emitted rather than passed through, so an unrecognised extra
  // param or a mangled hint can't ride into the href we hand the
  // renderer.
  return { id: ref.id, fragment: encodeFindingRef(ref) }
}
