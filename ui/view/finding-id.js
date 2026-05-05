// Deterministic finding-id derivation. Mirrors the file-id helper in
// the analyzer so a finding with no exporter-provided `id` still ends
// up with a stable UUID derived from its own content — meaning
// triage (markers / deletions) persists across reloads of the same
// markdown source, and content-equivalent findings dedupe across
// multiple drops the same way exporter-id'd findings already do.
//
// Algorithm:
//   1. JSON-stringify a fingerprint object whose key order matches the
//      Node implementation: { severity, description, <discriminator> }.
//   2. SHA-256, take the first 16 bytes.
//   3. Patch UUIDv4 version + variant bits.
//   4. Format as the canonical 8-4-4-4-12 UUID string.
//
// Discriminator selection (in order):
//   - fileHash  — preferred when present (matches the Node helper)
//   - location  — used by markdown imports (the URL from the
//                 `## Location` link), also a stable identifier
//   - file/line — last-resort defensive fallback for JSON findings
//                 that have neither (rare; not what the spec
//                 prescribes, but better than collapsing two
//                 unrelated findings into one id).
export async function deriveFindingId(f) {
  // Web crypto requires a secure context (https / localhost / OPFS-
  // capable origins). When unavailable (e.g. some `file://` setups),
  // bail out — caller falls back to the session-local _id so the UI
  // still functions, just without persistent triage on these findings.
  if (typeof crypto?.subtle?.digest !== 'function') return null
  let fingerprint
  if (f.fileHash != null) {
    fingerprint = { severity: f.severity, description: f.description, fileHash: f.fileHash }
  } else if (f.location != null) {
    fingerprint = { severity: f.severity, description: f.description, location: f.location }
  } else {
    fingerprint = { severity: f.severity, description: f.description, file: f.file, line: f.line }
  }
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(fingerprint))
    const digestBuffer = await crypto.subtle.digest('SHA-256', bytes)
    const u = new Uint8Array(digestBuffer, 0, 16)
    // UUIDv4 markers — same byte positions and masks as the Node helper.
    u[6] = (u[6] & 0x0f) | 0x40
    u[8] = (u[8] & 0x3f) | 0x80
    const hex = Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  } catch {
    return null
  }
}
