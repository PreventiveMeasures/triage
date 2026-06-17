// Bundle helpers for the managed server: the content-addressed identity used to
// dedupe stored bundles and to auto-link reports to them.
//
// A report's top-level `bundleHashes` lists the `sha512-<base64>` integrities
// the analyzer ran against (see ui/view/ingest.js); a stored bundle's identity
// is that same integrity computed from its bytes. Matching the two is how a
// report auto-links to its bundle.
import { createHash } from 'node:crypto'
import type { Buffer } from 'node:buffer'

// `sha512-<base64>` identity for a bundle's bytes. MUST stay byte-identical to
// the client's common/integrity.js (SHA-512 → standard base64 WITH padding) so
// a report's `bundleHashes` entries match a stored bundle's computed integrity.
// (The client uses `Uint8Array.toBase64()`, whose default is standard base64 +
// padding — the same bytes node:crypto's base64 digest emits.)
export function bundleIntegrity(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

// Classify an uploaded bundle by filename — mirrors ui/view/ingest.js
// `bundleKind`: sourcemap (.map) or stasis (stasis.code.br / .stasis.code.br).
// null for anything else (stored anyway; the kind is informational).
export function bundleKind(filename: string): 'sourcemap' | 'stasis' | null {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.map')) return 'sourcemap'
  if (lower === 'stasis.code.br' || lower.endsWith('.stasis.code.br')) return 'stasis'
  return null
}

// Extract the bundle integrities a report declares (its top-level
// `bundleHashes`). Non-JSON reports (markdown / CSV) or a missing field → [].
export function reportBundleHashes(bytes: Buffer): string[] {
  let data: unknown
  try { data = JSON.parse(bytes.toString('utf8')) } catch { return [] }
  if (data == null || typeof data !== 'object') return []
  const hashes = (data as { bundleHashes?: unknown }).bundleHashes
  if (!Array.isArray(hashes)) return []
  return hashes.filter((x): x is string => typeof x === 'string' && x !== '')
}
