import { state } from './state.ts'
import { decodeUtf8, encodeUtf8 } from '../common/utf8.js'
import { bucketOf, normalizeEntry, patchEntry, setReportIgnored } from './triage-entry.ts'
import {
  VAULT_LOCK,
  getEnvelopeAadForTriage,
  getSessionKey,
  hasEnvelopeMagic,
  isEncryptionEnabled,
  onVaultStateChange,
  openForTriage,
  sealForTriage,
} from './passkey-vault.js'

// Tail-of-save notifier. The sync layer registers itself via
// `setTriageChangeNotifier(triageSync.notify)` once loaded; before
// then (or when sync is opted out), the slot is a no-op and
// `saveTriage` persists locally without fanning out to peers. The
// dependency inversion mirrors the `SyncHost` injection — sync
// depends on triage's blob, triage on sync's fan-out trigger; the
// slot breaks the runtime cycle so `client/sync/*` stays code-split
// out of `view.js`'s main bundle.
let triageChangeNotifier = () => {}
export function setTriageChangeNotifier(fn) {
  triageChangeNotifier = typeof fn === 'function' ? fn : () => {}
}

// UI redraw hook for cross-tab reloads. A sibling tab's saveTriage
// fires a `storage` event here; `reloadTriageFromStorage` then writes
// the sibling's blob straight into the reactive `state.triage`. The
// reactive StateElements (finding-card / finding-row) re-render on
// their own, but the parts painted by the imperative render() in
// `ui/view/render.js` — the kanban board, the toolbar counts, the
// triage-bucket filtering / grouping — never observe the mutation, so
// they'd show stale until the next user click forces a render. The UI
// wires render() here (see ui/view.js) so a reload repaints them too.
// Separate slot from `triageChangeNotifier`: that one fans local edits
// OUT to peers, which a cross-tab reload must NOT do (the sibling is
// already on the same wire — see the storage handler below).
let triageReloadNotifier = () => {}
export function setTriageReloadNotifier(fn) {
  triageReloadNotifier = typeof fn === 'function' ? fn : () => {}
}

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
// Synchronous "ahead-of-compress" snapshot — written by saveTriage
// before the compressDeflate await, cleared after the compressed
// write lands. A tab crash mid-compress would otherwise drop the
// edit: the in-memory state.* mutation dies with the process, the
// compressed key wasn't updated, and triageSync notify (runs at the
// END of saveTriage) hasn't fired. readTriageBlob prefers this key
// when present — strictly newer than the compressed one. Audit M3
// round-5.
const TRIAGE_PENDING_KEY = 'deepview.triage.pending'
// Shared with `./triage-gc.js` so GC uses the same "session-only
// id" predicate as the save/load/apply paths. Divergent filtering
// would let GC either wipe live in-memory session ids (numeric
// fallbacks for findings without a uuid) or leave orphans behind on
// a report that did carry uuids.
export const SESSION_ID_RE = /^\d+$/u

async function compressDeflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function decompressDeflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// Web Lock + per-tab "latest snapshot wins" generation counter that
// together close the audit round-12 H10b race (two concurrent
// saveTriages racing on TRIAGE_KEY + TRIAGE_PENDING_KEY) without
// holding the lock across the compress await:
//
//   1. M3 round-5: the synchronous TRIAGE_PENDING_KEY write happens
//      BEFORE any await, so a crash mid-compress still recovers the
//      uncompressed snapshot. Anything that blocks for I/O sits
//      AFTER the sync write.
//
//   2. Compress runs OUTSIDE the lock, so a stuck `CompressionStream`
//      (browser bug, hostile peer content, test stub) can't pin the
//      lock and starve every subsequent saveTriage.
//
//   3. The lock-protected commit checks `gen === saveGen` — only the
//      LATEST saveTriage in this tab writes; slower (out-of-order)
//      compresses skip cleanly (no FIFO-compress assumption).
const TRIAGE_LOCK = 'deepview.triage.save'
let saveGen = 0

// Project the in-memory triage map into the persisted id-keyed entry
// map, dropping session-scoped numeric ids. `normalizeEntry` migrates
// the legacy `deleted` form, prunes empty fields, and returns a fresh
// entry (its own `ignoredReports` array), so the persisted blob never
// aliases live state. Shared by `saveTriage` (at-rest blob) and
// `buildTriageExportPayload` (backup export) so the two can't drift.
// Per-report ignore persists as `ignoredReports: ['nameA', ...]` on
// the entry.
export function buildPersistedTriageEntries() {
  const entries = {}
  for (const [id, entry] of state.triage) {
    if (SESSION_ID_RE.test(id)) continue
    const persisted = normalizeEntry(entry)
    if (persisted) entries[id] = persisted
  }
  return entries
}

export function saveTriage() {
  const gen = ++saveGen
  // Build entries synchronously so the M3 round-5 pending-key write
  // reflects the user's mutation BEFORE any await.
  const entries = buildPersistedTriageEntries()
  const isEmpty = Object.keys(entries).length === 0
  const json = isEmpty ? null : JSON.stringify(entries)
  // M3 round-5 pending key holds the uncompressed JSON for crash
  // recovery (readTriageBlob prefers it on next load). Own try so a
  // localStorage quota failure doesn't abort the compress + main
  // write below.
  //
  // Intentionally NOT encrypted: the same tab must be able to read
  // it on a subsequent load before the vault is unlocked. We trade
  // encryption-at-rest of this window for the recovery guarantee —
  // an encrypted pending key would need the session key, so a locked
  // vault would lose the pending edit. The blob is short-lived
  // (cleared at the tail of saveTriage) and lives only on-device.
  if (json != null) {
    try { localStorage.setItem(TRIAGE_PENDING_KEY, json) } catch {}
  }
  // Hold a SHARED VAULT_LOCK across compress + seal + commit so a
  // vault enable/disable (which takes the lock exclusively) waits
  // for us. Without it, an enable whose `listFiles` snapshot ran
  // BEFORE saveTriage's write could miss the just-enveloped blob; a
  // disable that ran AFTER saveTriage's seal-with-key-K could leave
  // the envelope unrecoverable. Shared mode lets concurrent saves
  // run in parallel; only the rare transition pauses them.
  return navigator.locks.request(VAULT_LOCK, { mode: 'shared' }, async () => {
    let b64 = null
    let sealedWithKey = null
    if (json != null) {
      try {
        const bytes = encodeUtf8(json)
        const compressed = await compressDeflate(bytes)
        // Envelope when the vault is unlocked. Enabled-but-locked (no
        // session key) skips the seal and saves plaintext — the next
        // post-unlock saveTriage re-writes enveloped, overwriting the
        // blob before any read could surface stale plaintext.
        //
        // Capture `sealedWithKey` so the commit below can detect a
        // same-tab user-driven flip during compress. The sibling-tab
        // race is covered by the shared VAULT_LOCK; this guards the
        // in-tab edge where a listener fires during the await window.
        sealedWithKey = getSessionKey()
        const finalBytes = sealedWithKey ? await sealForTriage(compressed) : compressed
        b64 = finalBytes.toBase64()
      } catch (err) {
        console.warn('Failed to save triage:', err)
        triageChangeNotifier()
        return
      }
    }
    // Lock-protected commit. `gen !== saveGen` means a NEWER
    // saveTriage started in this tab during compress — its snapshot
    // supersedes ours, so skip both the TRIAGE_KEY write AND the
    // pending-key clear (the newer call's pending is already in
    // localStorage and mustn't be clobbered by our older commit).
    //
    // Vault-state consistency: if the session key changed (sibling
    // disabled / enabled / re-keyed mid-compress), the bytes we
    // sealed (or didn't) are inconsistent with the current state.
    // Skip the write and queue a fresh saveTriage so the next
    // snapshot lands under the correct state. Without this, a
    // "compress finishes after sibling disabled the vault" race
    // would persist an envelope into a disabled vault, bricking it.
    //
    // LOAD-BEARING under shared VAULT_LOCK: the lock serialises
    // saveTriage vs enable/disable in- and cross-tab, BUT
    // passkey-vault.js's storage-event handler synchronously nulls
    // `sessionKey` on a sibling-tab disable WITHOUT acquiring
    // VAULT_LOCK — storage events fire on the JS task queue, not
    // through the lock scheduler. This check catches that path.
    await navigator.locks.request(TRIAGE_LOCK, () => {
      try {
        if (gen !== saveGen) return
        // Consistency check ONLY applies to the seal path (json !=
        // null): the empty branch removes TRIAGE_KEY entirely (no
        // enveloped-vs-plaintext ambiguity), and `sealedWithKey` was
        // never captured for it. Without this gate an unlocked-vault
        // empty save would loop forever — sealedWithKey stays null,
        // getSessionKey() is non-null, mismatch → microtask retry →
        // identical state → repeat.
        if (json != null && getSessionKey() !== sealedWithKey) {
          queueMicrotask(() => { saveTriage() })
          return
        }
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
    // configured). Outside the lock + outside the inner catch so a
    // sync send error doesn't suppress the localStorage warning, and
    // vice versa. MUST run for BOTH the empty and non-empty branches
    // — an early return in the empty branch strands the sync chain on
    // stale state (audit round-12 H10a).
    triageChangeNotifier()
  })
}

// Decode the persisted blob into `{ id: entry }` form. Returns
// null when nothing's stored; throws errors are swallowed at the
// caller so a corrupt blob doesn't take down ingestReport / the
// cross-tab listener.
//
// Envelope-aware: when the decoded base64 starts with the passkey
// envelope magic (`DVE1`), peel the envelope before decompressing.
// A locked vault throws here (encryption is enabled but no session
// key available) — the caller (loadTriage / reloadTriageFromStorage)
// swallows it via the same `console.warn` path that handles every
// other read failure, and the UI surfaces the unlock prompt via the
// vault-state-change listener registered at boot.
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
  let bytes = Uint8Array.fromBase64(raw)
  if (hasEnvelopeMagic(bytes)) {
    // Envelope present — must have a session key to unwrap. A
    // missing session key (vault locked / disabled while envelopes
    // are at rest) surfaces as a clear error rather than a
    // misleading "decompression failed" or "JSON parse" downstream.
    if (!getSessionKey()) {
      throw new Error('triage: vault locked, cannot decrypt envelope')
    }
    bytes = await openForTriage(bytes)
  }
  const decompressed = await decompressDeflate(bytes)
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
  const map = state.triage
  if (replace) {
    // Round-9 M3: when this tab is mid-saveTriage (its own pending
    // key is set with newer-than-blob local edits), the cross-tab
    // replace MUST NOT wipe ids the local edits have changed.
    // Without this guard, the sequence
    //   T1: local triage edit on X; saveTriage starts;
    //       TRIAGE_PENDING_KEY written synchronously; compress
    //       awaits.
    //   T2: sibling's storage event fires; reload runs; sibling's
    //       blob doesn't contain X; replace mode deletes X from
    //       state.triage.
    //   T3: local saveTriage's compress completes; writes
    //       TRIAGE_KEY (still containing X via the pre-compress
    //       snapshot); clears pending.
    // ends with TRIAGE_KEY persistently containing X but state.triage
    // not — the next render shows X missing until the next reload.
    // Read the pending key once and treat its ids as protected
    // local edits the sibling hasn't seen.
    let pendingEntries = null
    const pendingRaw = localStorage.getItem(TRIAGE_PENDING_KEY)
    if (pendingRaw) {
      try { pendingEntries = JSON.parse(pendingRaw) } catch {}
    }
    const pendingHas = (k) => pendingEntries != null && k in pendingEntries
    // Clear each per-finding field the new blob no longer carries,
    // unless this tab's pending snapshot still holds it. Session-only
    // numeric ids are never in the blob and are left untouched.
    for (const id of [...map.keys()]) {
      if (SESSION_ID_RE.test(id)) continue
      const v = entries?.[id]
      const noBlob = !entries || !(id in entries)
      if (!(pendingHas(id) && pendingEntries[id]?.color) && (noBlob || !v?.color)) {
        patchEntry(map, id, { color: undefined })
      }
      if (!(pendingHas(id) && (pendingEntries[id]?.triage || pendingEntries[id]?.deleted)) && !bucketOf(v)) {
        patchEntry(map, id, { triage: undefined })
      }
      if (!(pendingHas(id) && pendingEntries[id]?.comment) && (noBlob || typeof v?.comment !== 'string' || !v.comment)) {
        patchEntry(map, id, { comment: undefined })
      }
      if (!(pendingHas(id) && pendingEntries[id]?.fix) && (noBlob || typeof v?.fix !== 'string' || !v.fix)) {
        patchEntry(map, id, { fix: undefined })
      }
      // Tri-state flag: clear local only when neither the blob nor this
      // tab's pending snapshot carries a flagged value (true OR false).
      // A blob `false` is adopted by the apply loop above; a blob with no
      // flagged key means the sibling never set one, so mirror that.
      if (!(pendingHas(id) && pendingEntries[id]?.flagged !== undefined) && (noBlob || v?.flagged === undefined)) {
        patchEntry(map, id, { flagged: undefined })
      }
    }
    // Per-report ignore. Drop a report from an id's `ignoredReports`
    // when the new blob no longer lists it. Session-only ids are left
    // alone, same as the fields above. If the blob's entry carries a
    // triage state, drop every ignored report for that id — mutex with
    // triage means the apply path skips re-adding ignoredReports, so
    // the local state must mirror that resolution.
    for (const id of [...map.keys()]) {
      if (SESSION_ID_RE.test(id)) continue
      const reports = map.get(id)?.ignoredReports
      if (!reports || reports.length === 0) continue
      const v = entries?.[id]
      const triageWasSet = !!bucketOf(v)
      for (const reportName of [...reports]) {
        // Local pending-write protection (round-9 M3) — see above.
        if (pendingHas(id) && Array.isArray(pendingEntries[id]?.ignoredReports)
          && pendingEntries[id].ignoredReports.includes(reportName)) continue
        if (triageWasSet) { setReportIgnored(map, id, reportName, false); continue }
        const blobReports = v?.ignoredReports
        if (!Array.isArray(blobReports) || !blobReports.includes(reportName)) {
          setReportIgnored(map, id, reportName, false)
        }
      }
    }
  }
  if (!entries) return
  for (const [id, v] of Object.entries(entries)) {
    // Triage bucket — preferred form `triage: 'inprogress'|'fixed'|'invalid'|'deleted'`;
    // legacy `deleted: true` migrates to 'deleted' via bucketOf.
    const bucket = bucketOf(v)
    const patch = {}
    if (v && v.color) patch.color = v.color
    if (bucket) patch.triage = bucket
    if (v && typeof v.comment === 'string' && v.comment) patch.comment = v.comment
    if (v && typeof v.fix === 'string' && v.fix) patch.fix = v.fix
    // Tri-state flag — adopt both `true` and `false` (false is the
    // explicit "unflagged" tombstone, not "unset").
    if (v && typeof v.flagged === 'boolean') patch.flagged = v.flagged
    if (Object.keys(patch).length > 0) patchEntry(map, id, patch)
    // Mutual exclusion with triage: triage and per-report ignore
    // can't coexist on a tab. Skip importing `ignoredReports` when
    // the same entry carries a triage state — mirrors the
    // applyToReactiveState rule in triage-state-projection.ts so a
    // corrupt blob (legitimately impossible from the action handlers,
    // but possible from a sibling tab running an older version, or
    // pre-mutex-fix data) can't land this tab in the forbidden state.
    // Additive: unions with whatever ignoredReports already survived.
    if (!bucket && v && Array.isArray(v.ignoredReports)) {
      const set = new Set(map.get(id)?.ignoredReports ?? [])
      let added = false
      for (const r of v.ignoredReports) {
        if (typeof r === 'string' && !set.has(r)) { set.add(r); added = true }
      }
      if (added) patchEntry(map, id, { ignoredReports: [...set] })
    }
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
    // Repaint the imperatively-rendered surfaces (kanban board, toolbar
    // counts, bucket filtering) that don't observe `state.triage` on
    // their own — without this they stay frozen on a sibling tab's edit
    // until the next click. No-op until the UI wires render() in.
    triageReloadNotifier()
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

// Re-trigger a load whenever the vault state changes (unlock, lock,
// remote enable). On unlock the freshly-derived session key lets us
// finally peel an envelope that was previously unreadable; on lock
// we drop in-memory state that came from an envelope (the user
// asked to seal it away). The reload is fire-and-forget — failures
// surface through readTriageBlob's caller.
onVaultStateChange(() => { reloadTriageFromStorage() })

// Pending-key plaintext cleanup. `TRIAGE_PENDING_KEY` is the
// synchronous "ahead-of-compress" snapshot (M3 round-5), kept
// plaintext so crash-recovery can read it without the session key.
// A successful commit clears it, but a saveTriage that fails AFTER
// writing pending and BEFORE the commit (compress throw, browser
// kill) leaves the plaintext on disk indefinitely. Audit-flagged
// case: enable encryption, make one edit, crash, never edit again —
// pending stays plaintext beside the sealed TRIAGE_KEY, defeating
// encryption-at-rest for that last edit.
//
// Fix: trigger a fresh saveTriage when the vault transitions to
// unlocked AND a plaintext pending blob exists. It reads the
// in-memory state (populated from pending on boot), compresses,
// seals, and clears pending — closing the window.
onVaultStateChange(() => {
  if (getSessionKey() && localStorage.getItem(TRIAGE_PENDING_KEY)) {
    saveTriage()
  }
})

// Migration helpers — used by passkey-vault.js's
// enable/disableEncryption flow. CONTRACT: must be called from
// inside an EXCLUSIVE VAULT_LOCK acquisition. The shared-mode
// VAULT_LOCK saveTriage acquires waits for that exclusive hold to
// release; calling these outside it opens a TOCTOU window where a
// concurrent saveTriage can land bytes inconsistent with the
// just-flipped vault state.
//
// Encrypt: read the plaintext blob, seal under the just-derived
// session key, write the envelope back. Then drop any stale
// `TRIAGE_PENDING_KEY` plaintext — the main key is now the
// authoritative sealed copy, and pending is either already merged
// into it or older crash-recovery bytes we don't want sitting
// plaintext under an enabled vault. No-op when no triage data is
// stored (the pending clear still fires defensively).
//
// Decrypt: read the envelope, unwrap, write plaintext back.
// Tolerant of an already-plaintext blob (legacy / half-migrated).
// Pending is ALSO cleared: stale relative to the just-decrypted
// main key, and on next load it would be `readTriageBlob`-preferred,
// overriding the freshly-decrypted entries the user chose to expose.
//
// AAD comes from the vault's `getEnvelopeAadForTriage` so a future
// rename of the AAD format doesn't drift between save / migrate.
export async function migrateTriageToEncrypted({ seal }) {
  try { localStorage.removeItem(TRIAGE_PENDING_KEY) } catch {}
  const raw = localStorage.getItem(TRIAGE_KEY)
  if (!raw) return
  const bytes = Uint8Array.fromBase64(raw)
  if (hasEnvelopeMagic(bytes)) return  // already enveloped
  const sealed = await seal(bytes, getEnvelopeAadForTriage())
  localStorage.setItem(TRIAGE_KEY, sealed.toBase64())
}

export async function migrateTriageToPlaintext({ open }) {
  try { localStorage.removeItem(TRIAGE_PENDING_KEY) } catch {}
  const raw = localStorage.getItem(TRIAGE_KEY)
  if (!raw) return
  const bytes = Uint8Array.fromBase64(raw)
  if (!hasEnvelopeMagic(bytes)) return  // already plaintext
  const plain = await open(bytes, getEnvelopeAadForTriage())
  localStorage.setItem(TRIAGE_KEY, plain.toBase64())
}

// Surface the vault state to the boot-time UI without exposing the
// passkey-vault import path to every caller (events.js / sidebar
// already import from triage.js for other reasons; this saves them
// a second import).
export { isEncryptionEnabled }

