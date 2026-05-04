import { state } from './state.js'

// Markers + deletions survive page reload via `localStorage['deepview.triage']`.
// Payload shape: `{ <uuid>: { color?, deleted? } }` — one entry per
// triaged finding, color/deleted both optional (omitted when absent so
// a clean finding leaves no trace). JSON-encoded, brotli-compressed,
// base64-encoded. Only keys matching UUID_RE are stored — session-only
// numeric keys are filtered out so a fresh drop of the same report
// re-applies triage under stable ids.
const TRIAGE_KEY = 'deepview.triage'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

async function compressBrotli(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function decompressBrotli(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function saveTriage() {
  try {
    const entries = {}
    for (const [k, color] of state.markers) {
      if (!UUID_RE.test(k)) continue
      entries[k] = { ...(entries[k] || {}), color }
    }
    for (const k of state.deletedIds) {
      if (!UUID_RE.test(k)) continue
      entries[k] = { ...(entries[k] || {}), deleted: true }
    }
    if (Object.keys(entries).length === 0) {
      localStorage.removeItem(TRIAGE_KEY)
      return
    }
    const bytes = new TextEncoder().encode(JSON.stringify(entries))
    const compressed = await compressBrotli(bytes)
    localStorage.setItem(TRIAGE_KEY, compressed.toBase64())
  } catch (err) {
    console.warn('Failed to save triage:', err)
  }
}

async function loadTriage() {
  try {
    const raw = localStorage.getItem(TRIAGE_KEY)
    if (!raw) return
    const compressed = Uint8Array.fromBase64(raw)
    const decompressed = await decompressBrotli(compressed)
    const entries = JSON.parse(new TextDecoder().decode(decompressed))
    for (const [k, v] of Object.entries(entries)) {
      if (v && v.color) state.markers.set(k, v.color)
      if (v && v.deleted) state.deletedIds.add(k)
    }
  } catch (err) {
    console.warn('Failed to load triage:', err)
  }
}

// Triage loads asynchronously at module init. `ingestReport` awaits
// this before rendering so the first drop already shows stored marks
// and deletions for matching findings.
export const loadPromise = loadTriage()
