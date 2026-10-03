// Bundle helpers for the managed server: the content-addressed identity used to
// dedupe stored bundles and to auto-link reports to them.
//
// A report's top-level `bundleHashes` lists the `sha512-<base64>` integrities
// the analyzer ran against (see ui/view/ingest.js); a stored bundle's identity
// is that same integrity computed from its bytes. Matching the two is how a
// report auto-links to its bundle.
import { createHash } from 'node:crypto'
import type { Buffer } from 'node:buffer'
import { StringDecoder } from 'node:string_decoder'
import { createBrotliDecompress } from 'node:zlib'

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
  // Browsers insert a duplicate-download counter before the final extension.
  const lower = filename.toLowerCase().replace(/ \(\d+\)(?=\.[^.]*$)/u, '')
  if (lower.endsWith('.map')) return 'sourcemap'
  if (lower === 'stasis.code.br' || lower.endsWith('.stasis.code.br')) return 'stasis'
  return null
}

interface BundleRepo { github?: unknown; directory?: unknown }
const HEADER_KEYS = new Set(['version', 'config', 'repo', 'package'])
const MAX_HEADER_BYTES = 64 * 1024

// Stasis writes origin metadata before entries, formats and source bodies.
// undefined means another chunk is needed; null means the header has no repo.
function headerRepo(text: string): BundleRepo | null | undefined {
  let depth = 0, escaped = false, expectKey = false, quoted = false
  let key = '', start = 0, valueStart = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (escaped) { escaped = false; continue }
      if (c === '\\') { escaped = true; continue }
      if (c !== '"') continue
      quoted = false
      if (depth === 1 && expectKey) {
        key = JSON.parse(text.slice(start, i + 1)) as string
        if (!HEADER_KEYS.has(key)) return null
        expectKey = false
      }
      continue
    }
    if (c === '"') { quoted = true; start = i; continue }
    if (c === '{' || c === '[') {
      if (depth === 0 && c !== '{') return null
      depth++
      if (depth === 1) expectKey = true
    } else if (depth === 1 && (c === ',' || c === '}')) {
      if (key === 'repo') {
        const repo: unknown = JSON.parse(text.slice(valueStart, i))
        return repo != null && typeof repo === 'object' && !Array.isArray(repo) ? repo as BundleRepo : null
      }
      if (c === '}') return null
      expectKey = true
    } else if (c === '}' || c === ']') depth--
    else if (depth === 1 && c === ':') valueStart = i + 1
    else if (depth === 0 && c?.trim()) return null
  }
  return undefined
}

// Decode only a bounded prefix, stopping as soon as repo is read or the
// header ends. Unknown/malformed archives remain uploadable as opaque bytes.
export async function bundleRepo(bytes: Buffer): Promise<BundleRepo | null> {
  const stream = createBrotliDecompress({ chunkSize: 4096 })
  const decoder = new StringDecoder('utf8')
  let size = 0, text = ''
  stream.end(bytes)
  try {
    for await (const chunk of stream) {
      size += chunk.length
      if (size > MAX_HEADER_BYTES) return null
      text += decoder.write(chunk)
      const repo = headerRepo(text)
      if (repo !== undefined) return repo
    }
    return null
  } catch { return null }
  finally { stream.destroy() }
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
