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
// Synchronous "ahead-of-compress" snapshot — populated by saveTriage
// before the async compressBrotli await, cleared after the
// compressed write lands. A tab crash mid-compress would otherwise
// drop the user's edit (the in-memory state.* mutation is gone with
// the process, the compressed key wasn't updated, and triageSync
// notify hasn't fired yet because it runs at the END of saveTriage).
// readTriageBlob prefers this key when present — it's strictly newer
// than the compressed one. Audit M3 round-5.
const TRIAGE_PENDING_KEY = 'deepview.triage.pending'
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
    for (const [k, triage] of state.triageState) {
      if (SESSION_ID_RE.test(k)) continue
      entries[k] = { ...(entries[k] || {}), triage }
    }
    // Per-report ignore is persisted as `ignoredReports: ['nameA',
    // 'nameB', ...]` per id-keyed entry. Group the in-memory Set
    // (`${reportName}\0${id}`) back by id, drop session-scoped
    // numeric ids, and stamp the report list. Empty arrays are
    // omitted so a clean entry doesn't leave a trace.
    const ignoredByid = new Map()
    for (const key of state.ignoredIds) {
      const sep = key.indexOf('\0')
      if (sep < 0) continue
      const reportName = key.slice(0, sep)
      const id = key.slice(sep + 1)
      if (SESSION_ID_RE.test(id)) continue
      if (!ignoredByid.has(id)) ignoredByid.set(id, [])
      ignoredByid.get(id).push(reportName)
    }
    for (const [id, ignoredIn] of ignoredByid) {
      if (ignoredIn.length === 0) continue
      entries[id] = { ...(entries[id] || {}), ignoredReports: ignoredIn }
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
      localStorage.removeItem(TRIAGE_PENDING_KEY)
      return
    }
    const json = JSON.stringify(entries)
    // Synchronous belt-and-suspenders write: a tab crash during the
    // compressBrotli await would otherwise lose this edit (in-memory
    // state.* gone with the process, compressed key still stale,
    // triageSync.notify hasn't fired yet). The pending key holds
    // the uncompressed JSON; readTriageBlob prefers it on next load.
    // Wrapped in its own try so a localStorage quota failure here
    // doesn't abort the compress + main write below. Audit M3
    // round-5.
    try { localStorage.setItem(TRIAGE_PENDING_KEY, json) } catch {}
    const bytes = encodeUtf8(json)
    const compressed = await compressBrotli(bytes)
    localStorage.setItem(TRIAGE_KEY, compressed.toBase64())
    try { localStorage.removeItem(TRIAGE_PENDING_KEY) } catch {}
  } catch (err) {
    console.warn('Failed to save triage:', err)
  }
  // Notify the WS sync client (no-op when disabled / not yet
  // configured). Outside the try/catch above so a sync send error
  // doesn't suppress the localStorage warning, and a localStorage
  // failure doesn't suppress the network notification.
  triageSync.notify()
}

// Decode the persisted blob into `{ id: entry }` form. Returns
// null when nothing's stored; throws errors are swallowed at the
// caller so a corrupt blob doesn't take down ingestReport / the
// cross-tab listener.
async function readTriageBlob() {
  // Prefer the synchronous "ahead-of-compress" snapshot when
  // present — it's strictly newer than the compressed key (a
  // successful saveTriage clears it after the compressed write
  // lands). Audit M3 round-5.
  const pending = localStorage.getItem(TRIAGE_PENDING_KEY)
  if (pending) {
    try { return JSON.parse(pending) } catch {}
  }
  const raw = localStorage.getItem(TRIAGE_KEY)
  if (!raw) return null
  const compressed = Uint8Array.fromBase64(raw)
  const decompressed = await decompressBrotli(compressed)
  return JSON.parse(new TextDecoder().decode(decompressed))
}

// Apply `entries` (a `{ id: { color, triage, comment, fix } }` map)
// to the in-memory state. When `replace = true` (the cross-tab
// reload path), persisted-id entries that the new blob doesn't
// carry are removed from state.* — that's how a sibling tab's
// "cleared a marker" propagates here. Session-only ids (numeric,
// pre-uuid) are never in the blob and are left alone in either
// mode so the active tab's session-scoped triage doesn't get
// nuked by a sibling's persistence write.
function applyTriageEntries(entries, { replace } = { replace: false }) {
  if (replace) {
    for (const k of [...state.markers.keys()]) {
      if (SESSION_ID_RE.test(k)) continue
      if (!entries || !(k in entries) || !entries[k]?.color) state.markers.delete(k)
    }
    for (const k of [...state.triageState.keys()]) {
      if (SESSION_ID_RE.test(k)) continue
      const v = entries?.[k]
      const next = (v?.triage === 'fixed' || v?.triage === 'invalid' || v?.triage === 'deleted')
        ? v.triage
        : (v?.deleted ? 'deleted' : null)
      if (!next) state.triageState.delete(k)
    }
    for (const k of [...state.comments.keys()]) {
      if (SESSION_ID_RE.test(k)) continue
      if (!entries || !(k in entries) || typeof entries[k]?.comment !== 'string' || !entries[k].comment) state.comments.delete(k)
    }
    for (const k of [...state.fixes.keys()]) {
      if (SESSION_ID_RE.test(k)) continue
      if (!entries || !(k in entries) || typeof entries[k]?.fix !== 'string' || !entries[k].fix) state.fixes.delete(k)
    }
    // Per-report ignore: keys are `${reportName}\0${id}`. Drop
    // entries whose id is non-session AND whose (id, reportName)
    // pair isn't reflected in the new blob's `ignoredReports`
    // list. Session-only ids are left alone, same as the other
    // collections. If the blob's entry carries a triage state,
    // drop every local ignored entry for that id — mutex with
    // triage means the apply path skips re-adding ignoredReports,
    // so the local state must mirror that resolution.
    for (const key of [...state.ignoredIds]) {
      const sep = key.indexOf('\0')
      if (sep < 0) continue
      const reportName = key.slice(0, sep)
      const id = key.slice(sep + 1)
      if (SESSION_ID_RE.test(id)) continue
      const v = entries?.[id]
      const triageWasSet = v && (v.triage === 'fixed' || v.triage === 'invalid' || v.triage === 'deleted' || v.deleted)
      if (triageWasSet) {
        state.ignoredIds.delete(key)
        continue
      }
      const blobReports = v?.ignoredReports
      if (!Array.isArray(blobReports) || !blobReports.includes(reportName)) {
        state.ignoredIds.delete(key)
      }
    }
  }
  if (!entries) return
  for (const [k, v] of Object.entries(entries)) {
    if (v && v.color) state.markers.set(k, v.color)
    // Triage state — preferred form is `triage: 'fixed'|'invalid'|'deleted'`.
    // Legacy entries that only carry `deleted: true` migrate to 'deleted'.
    const triageWasSet = v && (v.triage === 'fixed' || v.triage === 'invalid' || v.triage === 'deleted' || v.deleted)
    if (v && (v.triage === 'fixed' || v.triage === 'invalid' || v.triage === 'deleted')) {
      state.triageState.set(k, v.triage)
    } else if (v && v.deleted) {
      state.triageState.set(k, 'deleted')
    }
    // Mutual exclusion with triage: triage and per-report ignore
    // can't coexist on a tab. Skip importing `ignoredReports` when
    // the same entry carries a triage state — mirrors the
    // applyToReactiveState rule in triage-sync.js so a corrupt
    // blob (legitimately impossible from the action handlers, but
    // possible from a sibling tab running an older version, or
    // pre-mutex-fix data) can't land this tab in the forbidden
    // state.
    if (!triageWasSet && v && Array.isArray(v.ignoredReports)) {
      for (const r of v.ignoredReports) {
        if (typeof r === 'string') state.ignoredIds.add(`${r}\0${k}`)
      }
    }
    if (v && typeof v.comment === 'string' && v.comment) state.comments.set(k, v.comment)
    if (v && typeof v.fix === 'string' && v.fix) state.fixes.set(k, v.fix)
  }
}

async function loadTriage() {
  try {
    const entries = await readTriageBlob()
    applyTriageEntries(entries)
  } catch (err) {
    console.warn('Failed to load triage:', err)
  }
}

// Cross-tab learning: a sibling tab's saveTriage fires a `storage`
// event in this tab. Re-read the blob and replace persisted-id
// entries so the user's edits in tab A show up in tab B without
// round-tripping through the sync server (and even when the server
// is offline). `replace: true` is what handles a sibling clearing
// a marker — without it, a delete in tab A wouldn't land here.
export async function reloadTriageFromStorage() {
  try {
    const entries = await readTriageBlob()
    applyTriageEntries(entries, { replace: true })
  } catch (err) {
    console.warn('Failed to reload triage:', err)
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== TRIAGE_KEY) return
    // Don't notify the sync layer — the data we just loaded came
    // from another tab that's already on the same wire under the
    // same workspaceTag, so an outbound save here would just push
    // a redundant changeset (or worse, race with the originating
    // tab's save). The sync chain takes care of server propagation.
    reloadTriageFromStorage()
  })
}

// Triage loads asynchronously at module init. `ingestReport` awaits
// this before rendering so the first drop already shows stored marks
// and deletions for matching findings.
export const loadPromise = loadTriage()
