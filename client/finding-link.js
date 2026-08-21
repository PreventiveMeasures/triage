// Deep links to a single finding — pure logic side. Encodes the
// finding's id plus a "where does it live" hint into the URL hash
// (`#finding=<id>&report=<hint>&ws=<hint>`) and parses the same back on
// the receiving side, so "look at THIS issue" is a link you can paste
// into a chat instead of a screenshot plus directions.
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
// uuids `common/finding-id.js` derives, and the codex importer's
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
const HINT_RE = /^[\w-]{4}$/u

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

// ── fragment codec ───────────────────────────────────────────────────

// Build the fragment body (no leading '#') for a finding reference.
// `report` / `workspace` are hint TOKENS (from `computeLinkHint` /
// `knownLinkHint`), not names — null / undefined omits them, and
// anything else throws rather than being silently dropped, so a caller
// that passes a raw filename finds out immediately instead of shipping
// a hint-less link.
//
// The id is percent-encoded: usually a uuid with nothing to escape, but
// the codex importer's finding-URL ids carry `/`, `:`, `?` and —
// decisively — `&` and `=`, which would otherwise split into phantom
// params on the way back. Tokens need no encoding (base64url is already
// fragment-safe) and are emitted verbatim.
export function encodeFindingRef({ id, report, workspace } = {}) {
  if (!isLinkableFindingId(id)) {
    throw new TypeError('encodeFindingRef: a persistent finding id is required')
  }
  const parts = [`finding=${encodeURIComponent(id)}`]
  for (const [param, hint] of [['report', report], ['ws', workspace]]) {
    if (hint === null || hint === undefined || hint === '') continue
    if (!isLinkHint(hint)) {
      throw new TypeError(`encodeFindingRef: ${param} must be a link hint token, not a name`)
    }
    parts.push(`${param}=${hint}`)
  }
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
// `location.hash` when called with no argument), where `report` and
// `workspace` are hint tokens. Returns null when the fragment carries no
// usable `finding=` param — a share link, an in-page anchor, an empty
// hash, or a payload that fails validation.
//
// HASH ONLY, matching `extractShareEncoded`. The id isn't secret, so the
// Referer-leak argument that motivates it there doesn't apply; the
// reason is uniformity — one place in the app reads deep links, and a
// caller that reached for `?finding=` would quietly bypass it.
//
// A malformed hint drops just that hint rather than the whole ref: the
// id is what identifies the finding, and the receiver's scan can still
// land it. An un-decodable ID, on the other hand, fails the whole parse
// — there is nothing left to look up.
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
    // Hints are fixed-width tokens — validated verbatim rather than
    // decoded, since base64url has nothing `encodeURIComponent` would
    // have touched. Anything else is a link from another era or a
    // mangled paste; drop it and let the scan take over.
    if (key === 'report' || key === 'ws') {
      if (!isLinkHint(rawValue)) continue
      if (key === 'report') found.report = rawValue
      else found.workspace = rawValue
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
