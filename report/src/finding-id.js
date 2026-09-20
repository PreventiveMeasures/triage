// Finding ids, stamped by the analyzer onto its JSON output and filled
// in by the viewer for findings that arrive without one. Web Crypto is
// the common surface — `crypto.subtle` exists in modern Node and in
// secure browser contexts — so one implementation runs in both.
//
// Two reports from the same source give a finding the same id; an edit
// to its description or its source invalidates it.

import { encodeUtf8 } from './utf8.js'

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// The file-content hash the JSON output format uses. sha512 because the
// id below hashes a string that already includes it, so a collision here
// would propagate into an id collision. Padded base64 with the SRI-style
// tag. `btoa` rather than `Uint8Array#toBase64`, still flagged in Node.
export async function computeFileHash(source) {
  const bytes = typeof source === 'string' ? encodeUtf8(source) : source
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', bytes))
  return `sha512-${btoa(String.fromCodePoint(...digest))}`
}

// A fingerprint hashed into a v4-shaped UUID: derived, not random, but
// the shape lets a downstream tool treat it as an opaque id.
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
// drops undefined keys, so a finding with no hash keys off the pair and
// re-runs over the same source yield the same ids.
export function findingId(severity, description, fileHash) {
  return fingerprintToId({ severity, description, fileHash })
}

// An id derived from a finding, on the first discriminator it carries.
// null when `crypto.subtle` is unavailable (some `file://` setups), so
// the caller can fall back to a session-local id — the UI still works,
// without persistent triage on those findings.
//
// In order:
//   - _idBasis  — a FROZEN fingerprint a parser stamped, used verbatim;
//                 it exists so a change to the rendered description
//                 can't re-key stored triage (parse-md-id.js).
//   - fileHash  — as `findingId` above.
//   - location  — a markdown import's url, also stable.
//   - file/line — last resort for a JSON finding with neither: not what
//                 the spec prescribes, but better than collapsing two
//                 unrelated findings onto one id.
export async function deriveFindingId(f) {
  if (typeof crypto?.subtle?.digest !== 'function') return null
  const fingerprint = fingerprintOf(f)
  try {
    return await fingerprintToId(fingerprint)
  } catch {
    return null
  }
}

// The choice above as the object that gets hashed. Key order is part of
// the id — JSON.stringify keeps insertion order — so every shape lists
// severity and description first.
function fingerprintOf(f) {
  if (f._idBasis) return f._idBasis
  const { severity, description } = f
  if (f.fileHash) return { severity, description, fileHash: f.fileHash }
  if (f.location) return { severity, description, location: f.location }
  return { severity, description, file: f.file, line: f.line }
}
