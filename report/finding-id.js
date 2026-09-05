// Shared finding-id helpers — used by the analyzer (Node) when stamping
// ids onto its JSON output, and by the viewer (browser) when filling in
// ids for findings that arrived without one. Web Crypto is the common
// surface: globalThis.crypto.subtle is available in modern Node and in
// secure browser contexts, so a single implementation runs in both.
//
// Two reports produced from the same source yield the same id for the
// same finding; edits to description or source invalidate it.

import { encodeUtf8 } from './utf8.js'

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function toBase64(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCodePoint(bytes[i])
  return btoa(s)
}

// Canonical file-content hash used throughout the JSON output format.
// sha512 because the per-finding id (below) takes sha256 of a string
// that already includes this hash — so collisions here would propagate
// directly into id collisions. Base64 (padded) matches the shape JSON
// consumers already parse; `sha512-` prefix is the SRI-style algorithm
// tag so downstream tools can tell hash algorithms apart at a glance.
export async function computeFileHash(source) {
  const bytes = typeof source === 'string' ? encodeUtf8(source) : source
  const digest = await crypto.subtle.digest('SHA-512', bytes)
  return `sha512-${toBase64(new Uint8Array(digest))}`
}

// Hash a fingerprint object into a v4-shaped UUID. Not a real random
// UUID (it's derived, not generated) but the shape lets downstream tools
// treat it as an opaque id without caring.
async function fingerprintToId(fingerprint) {
  const bytes = encodeUtf8(JSON.stringify(fingerprint))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const u = new Uint8Array(digest, 0, 16)
  // version 4: 0100xxxx
  u[6] = (u[6] & 0x0f) | 0x40
  // variant 1: 10xxxxxx
  u[8] = (u[8] & 0x3f) | 0x80
  const hex = toHex(u)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

// Stable per-finding id from the (severity, description, fileHash) triple
// the analyzer emits. fileHash being undefined is fine — JSON.stringify
// drops undefined keys, matching the legacy behavior so re-runs over the
// same source yield the same ids.
export function findingId(severity, description, fileHash) {
  return fingerprintToId({ severity, description, fileHash })
}

// Derive an id from a finding object — picks a discriminator from the
// finding's available fields. Returns null when crypto.subtle isn't
// available (e.g. some `file://` setups), so the caller can fall back
// to a session-local id and the UI still functions, just without
// persistent triage on these findings.
//
// Discriminator selection (in order):
//   - _idBasis  — a FROZEN fingerprint the parser stamped (markdown
//                 imports; see report/parse-md-id.js). Used verbatim:
//                 it exists precisely so later changes to the rendered
//                 description can't re-key stored triage.
//   - fileHash  — preferred when present (matches `findingId` above)
//   - location  — used by markdown imports (the URL of the first
//                 `## Evidence` row, or of `## Location` in older
//                 reports), also a stable identifier
//   - file/line — last-resort defensive fallback for JSON findings
//                 that have neither (rare; not what the spec
//                 prescribes, but better than collapsing two
//                 unrelated findings into one id).
export async function deriveFindingId(f) {
  if (typeof crypto?.subtle?.digest !== 'function') return null
  let fingerprint
  if (f._idBasis) {
    fingerprint = f._idBasis
  } else if (f.fileHash) {
    fingerprint = { severity: f.severity, description: f.description, fileHash: f.fileHash }
  } else if (f.location) {
    fingerprint = { severity: f.severity, description: f.description, location: f.location }
  } else {
    fingerprint = { severity: f.severity, description: f.description, file: f.file, line: f.line }
  }
  try {
    return await fingerprintToId(fingerprint)
  } catch {
    return null
  }
}
