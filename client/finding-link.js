// Deep links to a single finding — pure logic side. Encodes the
// finding's id plus a "where does it live" hint into the URL hash
// (`#finding=<id>&report=<name>&ws=<workspaceId>`) and parses the same
// back on the receiving side, so "look at THIS issue" is a link you can
// paste into a chat instead of a screenshot plus directions.
//
// Sibling of `workspace-share-link.js`, and deliberately unlike it in
// one respect: NOTHING here is a secret. A share link carries the
// workspace's private key and is therefore encrypted; a finding link
// carries only an identifier that is meaningless without the report the
// recipient must already have. So the payload is plain, readable text —
// the link stays legible in a chat client, and a recipient can tell at a
// glance which report they need to open.
//
// The hint is a HINT, not an address: `report` names the OPFS filename
// the finding was ingested from and `ws` the workspace it was viewed in.
// The receiver tries the workspace first, then the report, then whatever
// is already loaded (see `ui/view/finding-link-nav.js`), so a link built in
// a workspace still lands for a recipient who only has the single
// report attached.
//
// Param names live in the same `&`-joined fragment namespace as
// `share=`, and the parser has the same shape as `extractShareEncoded`
// — a fragment can therefore only ever be one kind of link, and adding
// a third param later doesn't disturb either.

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
// id or a report filename; both sit far under this. The cap exists so a
// hostile fragment can't push a megabyte of text through
// `decodeURIComponent` + the "couldn't find it" alert.
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

// Build the fragment body (no leading '#') for a finding reference.
// `report` / `workspace` are optional location hints; empty / absent
// ones are simply omitted so a single-file link stays short.
//
// Every value is percent-encoded: ids are usually uuids (nothing to
// escape) but the codex importer's finding-URL ids and report filenames
// carry `/`, `:`, `?`, spaces and — decisively — `&` and `=`, which
// would otherwise split into phantom params on the way back.
export function encodeFindingRef({ id, report, workspace } = {}) {
  if (!isLinkableFindingId(id)) {
    throw new TypeError('encodeFindingRef: a persistent finding id is required')
  }
  const parts = [`finding=${encodeURIComponent(id)}`]
  if (isUsablePart(report)) parts.push(`report=${encodeURIComponent(report)}`)
  if (isUsablePart(workspace)) parts.push(`ws=${encodeURIComponent(workspace)}`)
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
// `location.hash` when called with no argument). Returns null when the
// fragment carries no usable `finding=` param — a share link, an
// in-page anchor, an empty hash, or a payload that fails validation.
//
// HASH ONLY, matching `extractShareEncoded`. Nothing here is secret, so
// the Referer-leak argument that motivates it there doesn't apply; the
// reason is uniformity — one place in the app reads deep links, and a
// caller that reached for `?finding=` would quietly bypass it.
//
// A malformed hint (over-long, control chars, un-decodable escape) drops
// just that hint rather than the whole ref: the id is what identifies
// the finding, and the fallbacks in the reveal path can still land it.
// An un-decodable ID, on the other hand, fails the whole parse — there
// is nothing left to look up.
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
    if (key !== 'finding' && key !== 'report' && key !== 'ws') continue
    // Cheap length bound BEFORE decoding: percent-encoding expands at
    // most 3:1, so nothing under this cap can decode to something over
    // MAX_PART_LEN, and a megabyte fragment never reaches
    // decodeURIComponent. The validators below re-check the decoded
    // length, so this is a guard, not the rule.
    const rawValue = part.slice(eq + 1)
    if (!rawValue || rawValue.length > MAX_PART_LEN * 3) continue
    let value
    // decodeURIComponent throws URIError on a truncated / invalid escape
    // (`%`, `%zz`) — common when a chat client mangles a pasted link.
    try { value = decodeURIComponent(rawValue) } catch { continue }
    if (key === 'finding') {
      if (isLinkableFindingId(value)) found.id = value
    } else if (isUsablePart(value)) {
      if (key === 'report') found.report = value
      else found.workspace = value
    }
  }
  if (!found.id) return null
  return found
}
