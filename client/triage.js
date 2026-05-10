import { state } from './state.ts'
import { triageSync } from './triage-sync.ts'
import { decodeUtf8, encodeUtf8 } from '../common/utf8.js'

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

// Web Lock + per-tab "latest snapshot wins" generation counter
// that together close the audit round-12 H10b race (two
// concurrent saveTriages racing on TRIAGE_KEY +
// TRIAGE_PENDING_KEY) without holding the lock across the
// compress await:
//
//   1. M3 round-5: the synchronous TRIAGE_PENDING_KEY write
//      happens BEFORE any await, so a tab crash mid-compress
//      still recovers the uncompressed snapshot. Any code path
//      that blocks for I/O sits AFTER the sync write.
//
//   2. Compress runs OUTSIDE the lock. A stuck `CompressionStream`
//      (browser bug, hostile peer content, test stub) can't pin
//      the lock indefinitely and starve every subsequent
//      saveTriage call.
//
//   3. The lock-protected commit checks `gen === saveGen` — only
//      the LATEST saveTriage in this tab actually writes. Slower
//      compresses (out-of-order completion) skip cleanly. This
//      replaces the FIFO-compress assumption the PR-#172 shape
//      depended on.
const TRIAGE_LOCK = 'deepview.triage.save'
let saveGen = 0

export function saveTriage() {
  const gen = ++saveGen
  // Build entries synchronously so the M3 round-5 pending-key
  // write reflects the user's mutation BEFORE any await (a crash
  // during the compress await still recovers).
  const entries = {}
  for (const [k, color] of state.markers) {
    if (SESSION_ID_RE.test(k)) continue
    entries[k] = { ...entries[k], color }
  }
  for (const [k, triage] of state.triageState) {
    if (SESSION_ID_RE.test(k)) continue
    entries[k] = { ...entries[k], triage }
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
    entries[id] = { ...entries[id], ignoredReports: ignoredIn }
  }
  for (const [k, comment] of state.comments) {
    if (SESSION_ID_RE.test(k)) continue
    if (comment) entries[k] = { ...entries[k], comment }
  }
  for (const [k, fix] of state.fixes) {
    if (SESSION_ID_RE.test(k)) continue
    if (fix) entries[k] = { ...entries[k], fix }
  }
  const isEmpty = Object.keys(entries).length === 0
  const json = isEmpty ? null : JSON.stringify(entries)
  // Synchronous M3 round-5 belt-and-suspenders: pending key holds
  // the uncompressed JSON in case a tab crash during the compress
  // await would otherwise lose this edit (in-memory state.* gone,
  // compressed key still stale). readTriageBlob prefers pending
  // on next load. Wrapped in its own try so a localStorage quota
  // failure doesn't abort the compress + main write below.
  if (json != null) {
    try { localStorage.setItem(TRIAGE_PENDING_KEY, json) } catch {}
  }
  return (async () => {
    let b64 = null
    if (json != null) {
      try {
        const bytes = encodeUtf8(json)
        const compressed = await compressBrotli(bytes)
        b64 = compressed.toBase64()
      } catch (err) {
        console.warn('Failed to save triage:', err)
        triageSync.notify()
        return
      }
    }
    // Lock-protected commit. `gen !== saveGen` means a NEWER
    // saveTriage call started in this tab while we were
    // compressing — its snapshot supersedes ours, so we skip
    // both the TRIAGE_KEY write AND the pending-key clear (the
    // newer call's pending is already in localStorage and
    // mustn't be clobbered by our older commit).
    await navigator.locks.request(TRIAGE_LOCK, () => {
      try {
        if (gen !== saveGen) return
        if (isEmpty) {
          localStorage.removeItem(TRIAGE_KEY)
          localStorage.removeItem(TRIAGE_PENDING_KEY)
        } else {
          localStorage.setItem(TRIAGE_KEY, b64)
          try { localStorage.removeItem(TRIAGE_PENDING_KEY) } catch {}
        }
      } catch (err) {
        console.warn('Failed to save triage:', err)
      }
    })
    // Notify the WS sync client (no-op when disabled / not yet
    // configured). Outside the lock + outside the inner catch so
    // a sync send error doesn't suppress the localStorage warning,
    // and a localStorage failure doesn't suppress the network
    // notification. Reached from BOTH the empty-entries and
    // non-empty branches now — the previous early `return` in the
    // empty-entries branch (audit round-12 H10a) skipped this and
    // stranded the chain on stale state.
    triageSync.notify()
  })()
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
  return JSON.parse(decodeUtf8(decompressed))
}

// Apply `entries` (a `{ id: { color, triage, comment, fix } }` map)
// to the in-memory state. When `replace = true` (the cross-tab
// reload path), persisted-id entries that the new blob doesn't
// carry are removed from state.* — that's how a sibling tab's
// "cleared a marker" propagates here. Session-only ids (numeric,
// pre-uuid) are never in the blob and are left alone in either
// mode so the active tab's session-scoped triage doesn't get
// nuked by a sibling's persistence write.
function applyTriageEntries(entries, { replace = false } = {}) {
  if (replace) {
    // Round-9 M3: when this tab is mid-saveTriage (its own pending
    // key is set with newer-than-blob local edits), the cross-tab
    // replace MUST NOT wipe ids the local edits have changed.
    // Without this guard, the sequence
    //   T1: local state.markers.set(X, 'red'); saveTriage starts;
    //       TRIAGE_PENDING_KEY written synchronously; compress
    //       awaits.
    //   T2: sibling's storage event fires; reload runs; sibling's
    //       blob doesn't contain X; replace mode deletes X from
    //       state.markers.
    //   T3: local saveTriage's compress completes; writes
    //       TRIAGE_KEY (still containing X via the pre-compress
    //       snapshot); clears pending.
    // ends with TRIAGE_KEY persistently containing X but state.*
    // not — the next render shows X missing until the next reload.
    // Read the pending key once and treat its ids as protected
    // local edits the sibling hasn't seen.
    let pendingEntries = null
    const pendingRaw = localStorage.getItem(TRIAGE_PENDING_KEY)
    if (pendingRaw) {
      try { pendingEntries = JSON.parse(pendingRaw) } catch {}
    }
    const pendingHas = (k) => pendingEntries != null && k in pendingEntries
    for (const k of [...state.markers.keys()]) {
      if (SESSION_ID_RE.test(k)) continue
      if (pendingHas(k) && pendingEntries[k]?.color) continue
      if (!entries || !(k in entries) || !entries[k]?.color) state.markers.delete(k)
    }
    for (const k of [...state.triageState.keys()]) {
      if (SESSION_ID_RE.test(k)) continue
      if (pendingHas(k) && (pendingEntries[k]?.triage || pendingEntries[k]?.deleted)) continue
      const v = entries?.[k]
      const next = (v?.triage === 'fixed' || v?.triage === 'invalid' || v?.triage === 'deleted')
        ? v.triage
        : (v?.deleted ? 'deleted' : null)
      if (!next) state.triageState.delete(k)
    }
    for (const k of [...state.comments.keys()]) {
      if (SESSION_ID_RE.test(k)) continue
      if (pendingHas(k) && pendingEntries[k]?.comment) continue
      if (!entries || !(k in entries) || typeof entries[k]?.comment !== 'string' || !entries[k].comment) state.comments.delete(k)
    }
    for (const k of [...state.fixes.keys()]) {
      if (SESSION_ID_RE.test(k)) continue
      if (pendingHas(k) && pendingEntries[k]?.fix) continue
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
      // Local pending-write protection (round-9 M3) — see above.
      if (pendingHas(id) && Array.isArray(pendingEntries[id]?.ignoredReports)
        && pendingEntries[id].ignoredReports.includes(reportName)) continue
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
    // Listen for both keys: a sibling's normal saveTriage commits
    // the compressed `TRIAGE_KEY`; a sibling crash mid-compress
    // leaves only the uncompressed `TRIAGE_PENDING_KEY` written.
    // `readTriageBlob` prefers pending → compressed, so triggering
    // a reload on either event lets this tab pick up newer data
    // without waiting for a page reload. Audit round-8 M3.
    if (e.key !== TRIAGE_KEY && e.key !== TRIAGE_PENDING_KEY) return
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
