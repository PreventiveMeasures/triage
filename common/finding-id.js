// Session-local finding ids (see `client/triage.js`'s SESSION_ID_RE:
// purely numeric `_id` fallbacks, handed out by an in-memory counter
// for findings whose id couldn't be derived) are re-assigned on every
// load, so a link built on one would point at an arbitrary other
// finding after a reload — including in the SENDER's own tab. Those are
// refused up front rather than silently mis-resolving. Everything else
// the app treats as persistent — the analyzer's uuids, the deterministic
// uuids `report/src/finding-id.js` derives, and the codex importer's
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
export const MAX_FINDING_ID_LENGTH = 512

function isUsablePart(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_FINDING_ID_LENGTH
    && !hasControlChar(value)
}

// Whether a finding id survives a reload, i.e. whether a link built on
// it means anything tomorrow. Callers use this to decide whether to
// OFFER a link at all (the per-finding Link button hides itself for a
// session-local id) rather than handing out one that silently rots.
export function isLinkableFindingId(id) {
  return isUsablePart(id) && !SESSION_ID_RE.test(id)
}
