// Deterministic workspace id derivation from the workspace's 32-byte
// private key. Used by:
//   - `createWorkspace` (workspaces.js): stamps id = derive(key) so a
//     future share link can omit the id from the wire and the
//     recipient re-derives it.
//   - `encodeShareLink` / `decodeShareLink` (workspace-share-link.js):
//     encoder omits the id when it matches derivation; decoder re-
//     derives when the wire is silent.
//
// Format: UUIDv8 (8-4-4-4-12 hex) with the version nibble stamped to
// '8' and the RFC 4122 variant bits (high two of the 17th hex char)
// set to 10 — same surface as `crypto.randomUUID()`, so UUID-shape
// pattern-matchers need no special case. Workspaces created before
// this derivation kept their `crypto.randomUUID()` id; for those the
// share-link path detects the mismatch and ships the id explicitly.
//
// Own module so a) workspaces / share-link share one definition of
// the derivation convention (changing the domain separator in two
// places would silently split-brain), and b) `workspaces.js` stays
// under the per-file `max-lines` lint cap of 300 non-blank/non-comment
// lines (`.oxlintrc.json`; raw count is higher due to dense audit-
// trail comments).

import { encodeUtf8 } from '../common/utf8.js'

const DOMAIN = 'deepview/workspace-id/v1\n'

export async function deriveWorkspaceIdFromPrivateKey(privateKeyBase64) {
  const secret = Uint8Array.fromBase64(privateKeyBase64)
  // `encodeUtf8` rejects lone surrogates and non-string input — the
  // domain separator is a literal so it always passes, but funneling
  // every utf8 conversion through the checked helper keeps the
  // project's "no raw TextEncoder" convention.
  const domain = encodeUtf8(DOMAIN)
  const buf = new Uint8Array(domain.length + secret.length)
  buf.set(domain, 0)
  buf.set(secret, domain.length)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf))
  const hex = Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')
  const chars = hex.split('')
  chars[12] = '8'
  const variantNibble = (parseInt(chars[16], 16) & 0x3) | 0x8
  chars[16] = variantNibble.toString(16)
  const s = chars.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
}
