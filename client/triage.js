import { state } from './state.js'
import { triageSync } from './triage-sync.js'
import { encodeUtf8 } from '../common/utf8.js'

// Markers + deletions + comments + fix-links survive page reload
// via `localStorage['deepview.triage']`. Payload shape:
// `{ <id>: { color?, deleted?, comment?, fix? } }` — one entry per
// triaged finding, every field optional (omitted when absent so a
// clean finding leaves no trace). JSON-encoded, deflate-compressed,
// base64-encoded.
//
// Persisted keys are anything that ISN'T a session-local numeric `_id`
// (those drift across reloads of the same report). That covers the
// uuid-shaped ids the analyzer's exporter emits, the deterministic
// uuids derive-id.js computes for findings without one, AND the
// finding-url ids the codex CSV importer attaches. Any non-numeric
// id is treated as stable enough to round-trip.
const TRIAGE_KEY = 'deepview.triage'
const SESSION_ID_RE = /^\d+$/u

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
      if (SESSION_ID_RE.test(k)) continue
      entries[k] = { ...(entries[k] || {}), color }
    }
    for (const k of state.deletedIds) {
      if (SESSION_ID_RE.test(k)) continue
      entries[k] = { ...(entries[k] || {}), deleted: true }
    }
    for (const [k, comment] of state.comments) {
      if (SESSION_ID_RE.test(k)) continue
      if (comment) entries[k] = { ...(entries[k] || {}), comment }
    }
    for (const [k, fix] of state.fixes) {
      if (SESSION_ID_RE.test(k)) continue
      if (fix) entries[k] = { ...(entries[k] || {}), fix }
    }
    if (Object.keys(entries).length === 0) {
      localStorage.removeItem(TRIAGE_KEY)
      return
    }
    const bytes = encodeUtf8(JSON.stringify(entries))
    const compressed = await compressBrotli(bytes)
    localStorage.setItem(TRIAGE_KEY, compressed.toBase64())
  } catch (err) {
    console.warn('Failed to save triage:', err)
  }
  // Notify the WS sync client (no-op when disabled / not yet
  // configured). Outside the try/catch above so a sync send error
  // doesn't suppress the localStorage warning, and a localStorage
  // failure doesn't suppress the network notification.
  triageSync.notify()
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
      if (v && typeof v.comment === 'string' && v.comment) state.comments.set(k, v.comment)
      if (v && typeof v.fix === 'string' && v.fix) state.fixes.set(k, v.fix)
    }
  } catch (err) {
    console.warn('Failed to load triage:', err)
  }
}

// Triage loads asynchronously at module init. `ingestReport` awaits
// this before rendering so the first drop already shows stored marks
// and deletions for matching findings.
export const loadPromise = loadTriage()
