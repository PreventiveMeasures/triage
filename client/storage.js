import { decodeUtf8, encodeUtf8 } from '../common/utf8.js'
import { gunzipBytes, gzipBytes } from '../common/gzip.js'
import { computeSha512Integrity } from '../common/integrity.js'
import {
  VAULT_LOCK,
  getEnvelopeAadForBundle,
  getEnvelopeAadForOpfs,
  getSessionKey,
  hasEnvelopeMagic,
  isEncryptionEnabled,
  onVaultStateChange,
  openForBundle,
  openForOpfs,
  sealForBundle,
  sealForOpfs,
} from './passkey-vault.js'

const BUNDLE_META_SLOT = '__meta__'

// Persistent file storage backs the sidebar. OPFS — Origin Private
// File System — is the preferred layer (real files, larger quota); on
// origins where OPFS is unavailable (file://, older browsers) we
// transparently fall back to localStorage with each report stored
// gzipped + base64 under a fixed prefix. Both layers key by basename;
// filename collisions overwrite.
const OPFS_DIR = 'deepview-reports'
const OPFS_BUNDLES_DIR = 'deepview-bundles'
const LS_REPORT_PREFIX = 'deepview.report:'

let opfsWarned = false
// Open an OPFS directory handle, or null when OPFS is unavailable.
// `warnOnce` surfaces a one-time console breadcrumb (used by the reports
// dir — the layer users notice when quota differs; the bundles dir stays
// quiet). `create: false` probes for the directory without materialising
// it.
async function openOpfsDir(name, { create, warnOnce = false } = {}) {
  try {
    const root = await navigator.storage.getDirectory()
    return await root.getDirectoryHandle(name, { create })
  } catch (err) {
    if (warnOnce && !opfsWarned) {
      opfsWarned = true
      // file:// and older browsers reject OPFS. We fall back to gzipped
      // localStorage automatically; surface this once so a user wondering
      // about quota / size limits sees what's happening.
      console.warn('OPFS unavailable, falling back to gzipped localStorage (limited quota).', err)
    }
    return null
  }
}

// Write `bytes` to an OPFS file handle, aborting the writable on any
// mid-flight failure so it releases the handle immediately rather than
// waiting for GC (closes the window where a concurrent createWritable
// for the same name races the collection).
async function writeOpfsFile(fh, bytes) {
  const writable = await fh.createWritable()
  try {
    await writable.write(bytes)
    await writable.close()
  } catch (err) {
    try { await writable.abort(err) } catch {}
    throw err
  }
}

// Peel a passkey envelope off report `bytes` when present (decrypt via
// openForOpfs), throwing on a locked vault rather than returning garbled
// bytes. Returns `bytes` unchanged when there's no envelope.
async function peelOpfsEnvelope(bytes, name) {
  if (!hasEnvelopeMagic(bytes)) return bytes
  if (!getSessionKey()) {
    throw new Error(`storage: vault locked, cannot decrypt "${name}"`)
  }
  return await openForOpfs(bytes, name)
}

// Seal `bytes` for at-rest storage under the vault session key, with a
// mid-save consistency guard. Throws (after `onAbort`) when the vault is
// enabled-but-locked — nothing plaintext lands while encryption is on —
// and throws (after `onAbort`) when the session key changed between the
// pre-seal snapshot and the post-seal: the half-applied bytes are
// inconsistent with the live vault state, so the caller must retry under
// the new key. `label` names the entry in the error message; `onAbort`
// lets the reports path bump writeGen (invalidating any in-flight read)
// before the throw — the bundle path, which has no read cache, passes
// none. Returns the bytes to write: sealed when the vault is unlocked,
// unchanged when encryption is off.
async function sealForStorage(bytes, sealFn, slot, label, onAbort = () => {}) {
  if (isEncryptionEnabled() && !getSessionKey()) {
    onAbort()
    throw new Error(`storage: vault locked, cannot save ${label}`)
  }
  const sealedWithKey = getSessionKey()
  const out = sealedWithKey ? await sealFn(bytes, slot) : bytes
  if (getSessionKey() !== sealedWithKey) {
    onAbort()
    throw new Error(`storage: vault state changed mid-save for ${label}; retry`)
  }
  return out
}

function getOpfsDir() {
  return openOpfsDir(OPFS_DIR, { create: true, warnOnce: true })
}

// `gunzipBytes` is re-exported (the UI + sync-host consume it). The
// bundles layer gzips .map sourcemaps (text JSON, highly compressible)
// so they cost less in OPFS; readBundle auto-detects via the gzip
// magic bytes (1f 8b) so the flag doesn't need to live in metadata.
export { gunzipBytes }

// Storage layer: try OPFS first (real files, large quota), fall back to
// gzipped localStorage when OPFS is unavailable. Each function probes
// OPFS once per call — caching is unnecessary because getDirectoryHandle
// is cheap. localStorage paths read/write a key prefixed with
// LS_REPORT_PREFIX; the file list is enumerated by scanning that prefix.
// In-memory cache for report contents. Populated lazily on
// `readFile`, kept in sync by `saveFile` (overwrite) and `deleteFile`
// (evict). `inFlight` deduplicates concurrent reads of the same name
// — `switchToWorkspace` fires every read in parallel, so multiple
// callers asking for the same file (e.g. workspace + main view race)
// share a single round-trip rather than each hitting OPFS.
//
// Cache is per-page-load. No size cap: the user has already chosen
// to keep these reports around (they're persisted in OPFS), and the
// JS-string overhead of the active set is small relative to the
// rendered DOM. A failed read is NOT cached (the inFlight entry
// clears in the finally block) so callers can retry.
const cache = new Map()
const inFlight = new Map()
// Per-name write-generation token. Bumped synchronously by every
// `saveFile` and `deleteFile` call BOTH before AND after its async
// I/O. `readFile` captures the token at the start of its read; if
// the token changed by the time the read resolves (a saveFile /
// deleteFile landed in the meantime), the read result is stale
// relative to the current view and we skip the
// `cache.set(name, content)` step. Without this guard, an in-flight
// read that started before a saveFile could resolve AFTER
// saveFile's `cache.set(name, NEW)` ran and overwrite the cache
// with the OLD bytes — subsequent reads serve stale content with
// no invalidation path until the next saveFile.
//
// The two-bump design closes BOTH directions of the race:
//   1. read started BEFORE the write — captured the pre-bump gen,
//      sees gen advanced after the await, skips cache.set. (Pre-
//      bump audit round-9 H1.)
//   2. read started AFTER the start-bump but read the pre-commit
//      File snapshot (OPFS createWritable doesn't commit until
//      close) — captured the start-bumped gen, sees gen advanced
//      again after writable.close + cache.set, skips cache.set.
//      (Audit round-12 H8.)
//
// The Map grows monotonically with every distinct filename touched
// over the page's lifetime; we deliberately do NOT prune entries
// on `deleteFile` because the race-protection invariant — "if
// writeGen advanced since you started reading, skip the cache
// update" — would weaken under prune-then-reinsert. Concretely: an
// in-flight `readFile` that captured `gen = 5` then saw the entry
// pruned (gen would default to 0 on a re-`saveFile`) could resume
// with the gen check `0 !== 5` → skip cache.set; safe. But a NEW
// read post-prune captures `gen = 0`, sees the next saveFile bump
// to `1`, and SKIPS POPULATING ITS OWN FRESH BYTES INTO THE CACHE
// — the bytes are still returned to the caller (the gen-check
// only gates `cache.set`, not `return content`), but the next
// readFile pays the OPFS round-trip again. Net effect is a
// redundant re-read, not a correctness break — but redundant
// re-reads in a fast-path that's read on every render are easy
// to leak ~8 bytes per ever-touched name to avoid. Audit-flagged
// as "benign in practice"; documented here so the trade-off
// isn't re-litigated.
const writeGen = new Map()
function bumpWriteGen(name) {
  writeGen.set(name, (writeGen.get(name) ?? 0) + 1)
}
function currentWriteGen(name) {
  return writeGen.get(name) ?? 0
}

// File-mutation listener registry. Consumers (e.g. the bundle-finding
// index, which caches per-name parsed findings) subscribe so a
// `saveFile` overwrite or a `deleteFile` invalidation can prune
// dependent state without polling. Fired AFTER the storage write
// commits — failures don't notify (subscribers wouldn't observe a
// reverted state otherwise). One bad subscriber doesn't break the
// chain. Audit round-8 H1.
const fileChangeListeners = new Set()
export function onFileMutated(cb) {
  fileChangeListeners.add(cb)
  return () => fileChangeListeners.delete(cb)
}
function notifyFileMutated(name, kind) {
  for (const cb of fileChangeListeners) {
    try { cb(name, kind) } catch (err) { console.warn('storage file-change listener:', err) }
  }
}

export async function listFiles() {
  const dir = await getOpfsDir()
  if (dir) {
    const names = []
    for await (const [name] of dir.entries()) names.push(name)
    return names.toSorted()
  }
  const names = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && key.startsWith(LS_REPORT_PREFIX)) names.push(key.slice(LS_REPORT_PREFIX.length))
  }
  return names.toSorted()
}

// preserves async signature so a sync-throwing NUL-name validation
// surfaces as a rejected promise via `assert.rejects` test
// expectations.
// eslint-disable-next-line require-await
export async function saveFile(name, content) {
  // Reject names containing NUL. `\0` is the separator inside
  // `state.ignoredIds` keys (`${reportName}\0${id}`) and inside
  // the persisted triage entries' `ignoredReports` round-trip; a
  // report name carrying its own NUL would split keys at the
  // wrong byte and either GC the wrong ignore entry or pin
  // (reportName, id) pairs that never resolve. The OPFS spec
  // doesn't enforce this on its side, so guard at the storage
  // boundary — drop names with NUL before they land on disk.
  // Audit round-2 review #5.
  if (typeof name !== 'string' || name.includes('\0')) {
    throw new Error(`Invalid report name: contains NUL byte or is not a string`)
  }
  // Bump synchronously BEFORE the async I/O so a concurrent readFile
  // that already started can detect that its result is stale and
  // skip overwriting the cache. Audit round-9 H1.
  bumpWriteGen(name)
  // Hold a SHARED VAULT_LOCK so vault enable/disable (which acquires
  // it exclusively) waits for our in-flight write to land. Without
  // this, a vault transition that snapshots `listFiles` between this
  // saveFile's gzip + seal and its OPFS commit can miss the new
  // file, leaving a stale-state envelope (or plaintext) at rest
  // that won't match the post-transition vault. Shared mode allows
  // concurrent saves to proceed in parallel.
  return navigator.locks.request(VAULT_LOCK, { mode: 'shared' }, async () => {
    const dir = await getOpfsDir()
    if (dir) {
    // OPFS reports are gzipped at rest — JSON dumps compress well
    // and OPFS quota is shared with bundles + workspaces. readFile
    // sniffs the gzip magic on read so legacy uncompressed entries
    // keep working until they're rewritten through here.
    //
    // No prior removeEntry — createWritable() opens the file with
    // `keepExistingData: false` by default, which truncates on
    // close, so an overwrite naturally shrinks. Removing first
    // raced with the fire-and-forget migration in readFile: a
    // concurrent listFiles() (e.g. from renderSidebar after a
    // click) could land in the window where the entry was gone,
    // which made the just-clicked file vanish from the sidebar
    // until reload.
    let bytes = await gzipBytes(encodeUtf8(content))
    // Envelope when the passkey vault is unlocked. AAD binds the
    // ciphertext to the filename so a report swap on disk fails
    // AEAD verification on the next read. Storage at rest layout:
    //   [4-byte DVE1 magic][12-byte nonce][AES-GCM ciphertext+tag]
    // …of the GZIPPED report bytes — readFile peels the envelope
    // FIRST, then falls into the existing gzip magic-sniff to
    // decompress.
    //
    // Vault-state consistency: capture the session key BEFORE the
    // async seal, then double-check it didn't flip during the seal.
    // A sibling-tab disable that fires during seal would otherwise
    // produce envelope bytes on disk under a key the next page load
    // doesn't have. Mirrors the same check in saveTriage. On
    // mismatch, abort cleanly — the saveFile caller already saw a
    // resolved promise from the bump, and the next save will land
    // under the new state.
    //
    // LOAD-BEARING under shared VAULT_LOCK: the shared lock serialises
    // this saveFile against enable/disable, BUT the storage-event
    // handler in passkey-vault.js synchronously nulls `sessionKey`
    // on a sibling-tab disable WITHOUT acquiring VAULT_LOCK (storage
    // events fire on the task queue, not through the lock
    // scheduler). The check catches exactly that path.
    //
    // Refuse writes when the vault is enabled-but-locked. A user
    // who dismissed the boot unlock dialog still ends up here on
    // drag-drop / paste; without this guard, the file lands as
    // plaintext on disk under an enabled vault — breaking the
    // "everything written while encryption is on is encrypted"
    // invariant. Caller surfaces via the same "vault locked"
    // path that switchToFile already handles (unlock + retry).
    bytes = await sealForStorage(bytes, sealForOpfs, name, `"${name}"`, () => bumpWriteGen(name))
    const fh = await dir.getFileHandle(name, { create: true })
    const writable = await fh.createWritable()
    try {
      await writable.write(bytes)
      await writable.close()
    } catch (err) {
      // OPFS write failed mid-flight (closed handle, quota, etc.).
      // The previous content was already truncated by createWritable's
      // default `keepExistingData: false`, so leaving the in-memory
      // cache alone would surface stale text on the next readFile.
      // Drop the cache entry so the next read goes back to OPFS (and
      // either succeeds with the partial / new content or surfaces
      // the failure) instead of silently serving the OLD content.
      // Audit M2 round-8.
      cache.delete(name)
      // Bump again so a concurrent in-flight readFile that observed
      // the pre-bump gen treats its result as stale. Audit round-12 H8.
      bumpWriteGen(name)
      // Explicit abort so the underlying writable releases its file
      // handle immediately rather than waiting for GC. OPFS spec
      // auto-cleans on collection, but eager release closes the
      // window where a concurrent createWritable for the same name
      // could race the GC. Memory-lifecycle audit
      // `client/storage.js:175`.
      try { await writable.abort(err) } catch {}
      throw err
    }
    cache.set(name, content)
    // Post-commit bump so any readFile in flight that captured the
    // start-bumped gen but read the pre-commit File snapshot (OPFS
    // createWritable doesn't commit until close) sees the gen
    // advance and skips cache.set with its now-stale bytes. Audit
    // round-12 H8.
    bumpWriteGen(name)
    notifyFileMutated(name, 'save')
    return
  }
  // LS-fallback path mirrors the OPFS branch's envelope step + the
  // same vault-state consistency check.
  let lsBytes = encodeUtf8(content)
  lsBytes = await gzipBytes(lsBytes)
  // Same locked-vault rejection as the OPFS branch above.
  lsBytes = await sealForStorage(lsBytes, sealForOpfs, name, `"${name}"`, () => bumpWriteGen(name))
  const stored = lsBytes.toBase64()
  try {
    localStorage.setItem(LS_REPORT_PREFIX + name, stored)
    cache.set(name, content)
    bumpWriteGen(name)
    notifyFileMutated(name, 'save')
  } catch (err) {
    // Most likely QuotaExceededError. Re-throw so the drop handler can
    // surface a useful message to the user instead of silently dropping.
    bumpWriteGen(name)
    throw new Error(`localStorage write failed for ${name}: ${err.message}`, { cause: err })
  }
  })
}

export async function readFile(name) {
  if (cache.has(name)) return cache.get(name)
  if (inFlight.has(name)) return inFlight.get(name)
  // Capture the write generation BEFORE starting the async read.
  // If `saveFile` / `deleteFile` lands while this read is in flight,
  // the gen will have advanced by the time we resolve and we skip
  // the `cache.set` step below — the in-flight bytes reflect a
  // stale view of the file. Audit round-9 H1.
  const startedAtGen = currentWriteGen(name)
  const promise = (async () => {
    const dir = await getOpfsDir()
    if (dir) {
      const fh = await dir.getFileHandle(name)
      const file = await fh.getFile()
      let bytes = new Uint8Array(await file.arrayBuffer())
      // Envelope-aware: a passkey-encrypted file starts with the
      // 4-byte magic "DVE1". Peel the envelope FIRST (yields the
      // gzipped bytes), then fall through to the existing gzip
      // magic check. A locked-but-enveloped file surfaces a clean
      // error here rather than a confusing "gunzip failed" or
      // garbled JSON later.
      bytes = await peelOpfsEnvelope(bytes, name)
      // Gzipped payload (saveFile compresses since v…) — decompress
      // and return the JSON text. Stale uncompressed entries from
      // before the on-disk-gzip flip fall through to the legacy
      // branch below; once read, they get rewritten compressed by
      // the saveFile call so subsequent loads hit the fast path.
      if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const out = await gunzipBytes(bytes)
        return decodeUtf8(out)
      }
      const text = decodeUtf8(bytes)
      // Migrate the legacy uncompressed entry by writing it back
      // through saveFile (which gzips). Fire-and-forget — the read
      // result is already decided, and a write failure is harmless
      // (next read will retry the migration). Skipping the await
      // also keeps the read path fast on the migration pass.
      //
      // Surface the failure via `console.warn` rather than silent
      // swallow — a persistent QuotaExceeded here means EVERY read
      // re-tries the migration forever; an operator inspecting
      // OPFS / quota mysteries needs the breadcrumb. API ergonomics
      // audit `client/storage.js:248`.
      saveFile(name, text).catch((err) => {
        console.warn(`storage: legacy-uncompressed migration of "${name}" failed:`, err)
      })
      return text
    }
    const stored = localStorage.getItem(LS_REPORT_PREFIX + name)
    if (stored === null) throw new Error(`File not found: ${name}`)
    let lsBytes = Uint8Array.fromBase64(stored)
    lsBytes = await peelOpfsEnvelope(lsBytes, name)
    const plain = await gunzipBytes(lsBytes)
    return decodeUtf8(plain)
  })()
  inFlight.set(name, promise)
  try {
    const content = await promise
    if (currentWriteGen(name) === startedAtGen) cache.set(name, content)
    return content
  } finally {
    inFlight.delete(name)
  }
}

// Read the on-disk bytes for a report, unchanged at the LOGICAL
// layer — the passkey envelope (when present) is peeled here so
// callers always see the same gzipped representation regardless of
// whether the on-disk file was wrapped or not. The objstore upload
// path consumes the gzipped representation directly: shipping
// encrypted-at-rest bytes through the workspace's wire-encryption
// layer would just double-wrap, and a peer who downloaded the
// resulting blob wouldn't have this device's passkey to peel the
// inner envelope. So peel here, encrypt over the wire there, and
// `saveFileBytes` re-wraps with this device's passkey on disk.
export async function readFileBytes(name) {
  const dir = await getOpfsDir()
  let bytes
  if (dir) {
    const fh = await dir.getFileHandle(name)
    const file = await fh.getFile()
    bytes = new Uint8Array(await file.arrayBuffer())
  } else {
    const stored = localStorage.getItem(LS_REPORT_PREFIX + name)
    if (stored === null) throw new Error(`File not found: ${name}`)
    bytes = Uint8Array.fromBase64(stored)
  }
  bytes = await peelOpfsEnvelope(bytes, name)
  return bytes
}

// Write raw bytes to OPFS under `name` without re-compressing — the
// inverse of `readFileBytes`. Bypasses the in-memory text cache
// since the caller hands us bytes, not the parsed content. The
// next `readFile(name)` will hit OPFS, decompress, and populate
// the cache (matches the legacy-uncompressed migration path).
//
// Used by the objstore download path so a peer-uploaded gzipped
// blob lands on disk byte-identical, preserving any non-UTF-8
// safe content without going through a TextDecoder round-trip
// that could corrupt it.
// see saveFile note above.
// eslint-disable-next-line require-await
export async function saveFileBytes(name, bytes) {
  if (typeof name !== 'string' || name.includes('\0')) {
    throw new Error(`Invalid report name: contains NUL byte or is not a string`)
  }
  bumpWriteGen(name)
  cache.delete(name)
  // Shared VAULT_LOCK so concurrent vault transitions wait — same
  // rationale as saveFile.
  return navigator.locks.request(VAULT_LOCK, { mode: 'shared' }, async () => {
    // Wrap with the passkey envelope when the vault is unlocked — same
    // policy as `saveFile`. Bytes received here are the LOGICAL
    // on-disk form (gzipped report); the envelope sits on top so the
    // file on disk is the AEAD ciphertext. AAD = filename, so a
    // file-rename swap fails AEAD verification on the next read.
    // Refuse the write when the vault is enabled-but-locked (same
    // invariant as saveFile — no plaintext bytes land while
    // encryption is supposed to be on).
    const onDisk = await sealForStorage(bytes, sealForOpfs, name, `"${name}"`, () => bumpWriteGen(name))
    const dir = await getOpfsDir()
    if (dir) {
      const fh = await dir.getFileHandle(name, { create: true })
      const writable = await fh.createWritable()
      try {
        await writable.write(onDisk)
        await writable.close()
      } catch (err) {
        bumpWriteGen(name)
        // Eager-release the writable rather than wait for GC. Symmetric
        // with `saveFile` above; memory-lifecycle audit
        // `client/storage.js:175`.
        try { await writable.abort(err) } catch {}
        throw err
      }
      bumpWriteGen(name)
      notifyFileMutated(name, 'save')
      return
    }
    try {
      localStorage.setItem(LS_REPORT_PREFIX + name, onDisk.toBase64())
      bumpWriteGen(name)
      notifyFileMutated(name, 'save')
    } catch (err) {
      bumpWriteGen(name)
      throw new Error(`localStorage write failed for ${name}: ${err.message}`, { cause: err })
    }
  })
}

// eslint-disable-next-line require-await
export async function deleteFile(name) {
  // Bump synchronously BEFORE the async I/O — see saveFile for the
  // race this guards (a concurrent readFile resolving with stale
  // bytes after we cleared the cache here). Audit round-9 H1.
  bumpWriteGen(name)
  cache.delete(name)
  inFlight.delete(name)
  // Hold shared VAULT_LOCK so vault enable/disable (which acquires
  // it exclusively) waits for our removeEntry to land — mirrors the
  // shared-mode hold in saveFile / saveFileBytes / saveBundle /
  // deleteBundle. Without this, the migration's `rawReadAndWrite`
  // can interleave between its read-handle and write-handle
  // acquisitions around this delete: the write-back uses
  // `getFileHandle(name, { create: true })` and RESURRECTS the
  // just-deleted entry with the migration's transform applied.
  // Particularly bad on disable — a user who deleted a sensitive
  // file specifically to prevent it being decrypted to plaintext
  // would see it reappear on disk as plaintext.
  return navigator.locks.request(VAULT_LOCK, { mode: 'shared' }, async () => {
    const dir = await getOpfsDir()
    if (dir) {
      // Only swallow the "already gone" case (NotFoundError). Other
      // failures — EACCES via NoModificationAllowedError, OPFS
      // truncate failures wrapped as InvalidModificationError — must
      // propagate; without this gate, `writeGen` is still bumped and
      // `'delete'` listeners fire AS IF the removeEntry succeeded,
      // so subscribers (bundle-finding-index, presence module) think
      // the file is gone while OPFS still holds it. API ergonomics
      // audit `client/storage.js:339`.
      try { await dir.removeEntry(name) }
      catch (err) {
        if (!(err instanceof DOMException) || err.name !== 'NotFoundError') {
          bumpWriteGen(name)
          throw err
        }
      }
      // Post-commit bump — a readFile that started AFTER our pre-bump
      // but captured the File snapshot before `removeEntry` resolved
      // would otherwise observe a matching gen and re-cache the
      // doomed bytes. Audit round-12 H8.
      bumpWriteGen(name)
      notifyFileMutated(name, 'delete')
      return
    }
    localStorage.removeItem(LS_REPORT_PREFIX + name)
    bumpWriteGen(name)
    notifyFileMutated(name, 'delete')
  })
}

// Bundles — sourcemap (.map) and stasis (.stasis.code.br)
// source-of-truth blobs for the analyzer pipeline. Stored in a
// separate OPFS dir, keyed by `sha512-${base64}` integrity rather
// than the dropped filename: two drops with the same name but
// different content would otherwise collide, and identical content
// dropped twice would write twice. The original name is kept on
// the side in `_meta.json` (an array of `{integrity, name}`)
// purely for display. Binary content is supported (stasis is
// brotli). Localstorage fallback isn't supported here: bundles can
// be large; gzip-base64ing them through localStorage's ~5MB cap
// rarely makes sense, and this is a non-essential side feature.
const BUNDLE_META_FILE = '_meta.json'

function getOpfsBundlesDir() {
  return openOpfsDir(OPFS_BUNDLES_DIR, { create: true })
}

// SRI uses standard base64 (with `/` and `+`); OPFS rejects `/` in
// filenames, so the on-disk key swaps `/` for `_`. The displayed
// integrity keeps the canonical form so users can paste it into
// SRI-aware tools verbatim.
function integrityToOpfsKey(integrity) {
  return integrity.replaceAll('/', '_')
}

// `_meta.json` carries the bundle names + integrities (user-visible
// project names, sample identifiers — sensitive metadata). Sealed
// under the bundle AAD with the `__meta__` slot when the vault is
// unlocked; reads peel the envelope before JSON.parse.
//
// Failure modes are deliberately distinguished:
//   - File doesn't exist → return [] (the fresh-vault / freshly-
//     wiped state).
//   - Vault is locked + envelope on disk → return [] but log a
//     warning. The boot flow defers any meta-reading work until
//     after unlock, so this path is defensive; surfacing an empty
//     list lets `listBundles` callers operate without throwing.
//   - Envelope present, vault unlocked, decrypt FAILED (AEAD
//     verification, tampering, identity-tag mismatch from a backup
//     restore) → log a warning and return []. Without the log,
//     a corrupted index becomes indistinguishable from "no
//     bundles" and the user loses access to bundle bytes that
//     are still on disk.
//   - JSON.parse failed → log and return [].
async function readBundleMeta(dir) {
  let raw
  try {
    const fh = await dir.getFileHandle(BUNDLE_META_FILE)
    const file = await fh.getFile()
    raw = new Uint8Array(await file.arrayBuffer())
  } catch (err) {
    if (err instanceof DOMException && err.name === 'NotFoundError') return []
    console.warn('readBundleMeta: failed to read _meta.json:', err)
    return []
  }
  let plain = raw
  if (hasEnvelopeMagic(raw)) {
    const sessionKey = getSessionKey()
    if (!sessionKey) {
      console.warn('readBundleMeta: vault locked, returning empty bundle list')
      return []
    }
    try {
      plain = await openForBundle(raw, BUNDLE_META_SLOT)
    } catch (err) {
      console.warn('readBundleMeta: decrypt failed (tampering, key mismatch, or vault identity drift):', err)
      return []
    }
  }
  try {
    const data = JSON.parse(decodeUtf8(plain))
    if (Array.isArray(data)) return data
    return []
  } catch (err) {
    console.warn('readBundleMeta: JSON.parse failed:', err)
    return []
  }
}

async function writeBundleMeta(dir, meta) {
  let bytes = encodeUtf8(JSON.stringify(meta))
  bytes = await sealForStorage(bytes, sealForBundle, BUNDLE_META_SLOT, 'bundle metadata')
  try { await dir.removeEntry(BUNDLE_META_FILE) } catch {}
  const fh = await dir.getFileHandle(BUNDLE_META_FILE, { create: true })
  await writeOpfsFile(fh, bytes)
}

// `_meta.json` is read-modify-written by `saveBundle` and
// `deleteBundle`. The pair is non-atomic — two concurrent calls
// can each readBundleMeta the same prior array, mutate locally,
// and the second writeBundleMeta clobbers the first. Worst case:
// one bundle's bytes land in OPFS under their integrity key but
// the metadata entry is lost (listBundles can't surface it), or
// a delete-based-on-stale-meta resurrects unrelated entries.
// Serialize the entire RMW behind a Web Lock so the second caller
// sees the first caller's persisted result. Audit round-12 H7.
const BUNDLE_META_LOCK = `${OPFS_BUNDLES_DIR}/${BUNDLE_META_FILE}`
function lockBundleMeta(work) {
  return navigator.locks.request(BUNDLE_META_LOCK, work)
}

export async function listBundles() {
  const dir = await getOpfsBundlesDir()
  if (!dir) return []
  const meta = await readBundleMeta(dir)
  return [...meta].toSorted((a, b) => a.name.localeCompare(b.name))
}

// Existence-only probe — for callers that need to know whether
// there are ANY bundles without reading `_meta.json` (which is
// encrypted and unreadable under a locked vault). The origin-
// migration check runs BEFORE the boot unlock gate; using
// `listBundles().length > 0` there would silently report "no
// bundles" when the user has encrypted bundles they'd lose on a
// redirect to the new origin.
//
// Includes `_meta.json` itself in the count when present — its
// existence already implies bundle activity even if all bundle
// bytes were independently removed.
export async function hasAnyBundles() {
  // Probe with `create: false` — the existence check runs
  // pre-redirect from the legacy-origin migration dialog, and a
  // user who has no bundles shouldn't have a `deepview-bundles/`
  // OPFS directory materialised by the act of asking. Using the
  // shared `getOpfsBundlesDir` would create one silently.
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return false
  const dir = await openOpfsDir(OPFS_BUNDLES_DIR, { create: false })
  if (!dir) return false
  try {
    for await (const _ of dir.entries()) return true
  } catch {}
  return false
}

// Persists a dropped bundle. Computes SHA-512 of the ORIGINAL
// content and stores the bytes under the SRI-style key; updates
// the metadata with the dropped filename so the bundles list can
// show "name (sha512-…)". Identical content dropped twice updates
// the name without rewriting the content; different content with
// the same name sits as a separate entry.
//
// `.map` sourcemaps are gzipped before being written to OPFS — they
// are JSON text and compress well. Integrity stays computed on the
// original (uncompressed) bytes, matching SRI semantics. readBundle
// auto-decompresses via the gzip magic bytes, so callers always see
// the uncompressed content. Stasis bundles are already brotli-
// compressed at the source so we store them as-is.
export async function saveBundle(name, content) {
  const dir = await getOpfsBundlesDir()
  if (!dir) throw new Error(`Cannot save bundle ${name}: OPFS unavailable`)
  const bytes = content instanceof Uint8Array
    ? content
    : encodeUtf8(content)
  const integrity = await computeSha512Integrity(bytes)
  const opfsKey = integrityToOpfsKey(integrity)
  let storeBytes = name.toLowerCase().endsWith('.map')
    ? await gzipBytes(bytes)
    : bytes
  // Hold shared VAULT_LOCK so a concurrent enable / disable / wipe
  // (which acquires exclusive) waits for our seal-and-commit to
  // finish — mirrors saveFile. Without this, a vault-state flip
  // mid-save would leave bytes on disk under a state the next
  // read can't reverse.
  return navigator.locks.request(VAULT_LOCK, { mode: 'shared' }, async () => {
    // Refuse writes when the vault is enabled-but-locked. Same
    // invariant as saveFile / saveTriage: nothing lands plaintext
    // on disk under an enabled vault.
    storeBytes = await sealForStorage(storeBytes, sealForBundle, integrity, `bundle "${name}"`)
    try { await dir.removeEntry(opfsKey) } catch {}
    const fh = await dir.getFileHandle(opfsKey, { create: true })
    await writeOpfsFile(fh, storeBytes)
    // RMW the metadata under the same-origin Web Lock so a concurrent
    // saveBundle / deleteBundle can't clobber the entry we just
    // persisted. Audit round-12 H7.
    //
    // On meta-write failure, clean up the just-written bundle bytes
    // — without this, a transient `_meta.json` write error leaves
    // sealed bytes on disk with no index entry. `listBundles` would
    // never surface them (UI blind), but `migrateOpfsBundlesEncrypt`
    // / `Decrypt` would still walk them on the next vault transition.
    try {
      await lockBundleMeta(async () => {
        const meta = await readBundleMeta(dir)
        const idx = meta.findIndex((e) => e.integrity === integrity)
        if (idx >= 0) meta[idx] = { integrity, name }
        else meta.push({ integrity, name })
        await writeBundleMeta(dir, meta)
      })
    } catch (err) {
      try { await dir.removeEntry(opfsKey) } catch {}
      throw err
    }
    return { integrity, name }
  })
}

export async function deleteBundle(integrity) {
  const dir = await getOpfsBundlesDir()
  if (!dir) return
  // Hold shared VAULT_LOCK so vault enable/disable (which acquires
  // it exclusively) waits for our `_meta.json` RMW to finish.
  // Without this, an enable/disable migration's `_meta.json`
  // re-seal/re-decrypt can interleave with `readBundleMeta` →
  // `writeBundleMeta` here and produce mixed-state on disk
  // (e.g. meta written plaintext under a vault that's already
  // back to enabled, or sealed under a key the next read can't
  // reverse).
  return navigator.locks.request(VAULT_LOCK, { mode: 'shared' }, async () => {
    // Only swallow the "already gone" case. A real OPFS failure
    // (NoModificationAllowedError, InvalidModificationError) must
    // propagate BEFORE the `_meta.json` RMW below drops the index
    // entry — otherwise the bytes survive on disk with no meta entry to
    // surface (listBundles blind) or re-target. Mirrors deleteFile.
    try { await dir.removeEntry(integrityToOpfsKey(integrity)) }
    catch (err) {
      if (!(err instanceof DOMException) || err.name !== 'NotFoundError') throw err
    }
    // Per-`_meta.json` RMW lock — independent of VAULT_LOCK, serialises
    // saveBundle vs deleteBundle within the same vault state. Audit
    // round-12 H7.
    await lockBundleMeta(async () => {
      const meta = await readBundleMeta(dir)
      const filtered = meta.filter((e) => e.integrity !== integrity)
      // No-op short-circuit: deleting a non-existent integrity (or
      // deleting from an already-empty meta) would otherwise CREATE
      // `_meta.json` on disk where none existed. That stale file
      // makes `hasAnyBundles()` return true for an effectively-empty
      // bundles dir, suppressing the legacy-origin silent redirect
      // path. Skip the write when nothing actually changed.
      if (filtered.length === meta.length) return
      await writeBundleMeta(dir, filtered)
    })
  })
}

export async function readBundle(integrity) {
  const dir = await getOpfsBundlesDir()
  if (!dir) throw new Error('OPFS unavailable')
  const fh = await dir.getFileHandle(integrityToOpfsKey(integrity))
  const file = await fh.getFile()
  let bytes = new Uint8Array(await file.arrayBuffer())
  // Peel the envelope FIRST when present — saveBundle gzips THEN
  // seals, so the bytes-on-disk shape is envelope-of-gzip(bytes).
  // The gzip magic-sniff below operates on the post-decrypt
  // plaintext.
  if (hasEnvelopeMagic(bytes)) {
    if (!getSessionKey()) {
      throw new Error(`storage: vault locked, cannot read bundle "${integrity}"`)
    }
    bytes = await openForBundle(bytes, integrity)
  }
  // Auto-decompress when the on-disk bytes start with the gzip magic
  // (1f 8b) — saveBundle gzips .map sourcemaps to save OPFS space,
  // but the caller wants the original content. Stasis bundles use
  // brotli (different magic) so they fall through unchanged.
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return await gunzipBytes(bytes)
  }
  return bytes
}

// Migration helpers — driven by passkey-vault.js's enable/disable
// flow. Iterate every report in the active backend (OPFS or LS
// fallback), read the on-disk bytes WITHOUT routing through the
// envelope-aware reader (which would either over- or under-process
// the file), seal/open through the caller-supplied helper, write
// the result back. Caches are cleared at the start so any concurrent
// reader picks up the new shape on its next attempt.
//
// Failure mode: a single file's seal/open failure aborts the run.
// The vault keeps the partially-migrated state — some files
// enveloped, others not — which is fine: the envelope-aware reader
// sniffs each file independently. The vault's enable/disable
// transition rolls back its metadata on a thrown migration so the
// user can retry without ending up in a "encryption enabled but
// half the data isn't encrypted" lockout.
async function rawReadAndWrite(name, transform) {
  const dir = await getOpfsDir()
  if (dir) {
    const fh = await dir.getFileHandle(name)
    const file = await fh.getFile()
    const bytes = new Uint8Array(await file.arrayBuffer())
    const next = await transform(bytes)
    if (next === null) return
    cache.delete(name)
    inFlight.delete(name)
    bumpWriteGen(name)
    const writeFh = await dir.getFileHandle(name, { create: true })
    await writeOpfsFile(writeFh, next)
    bumpWriteGen(name)
    return
  }
  const stored = localStorage.getItem(LS_REPORT_PREFIX + name)
  if (stored === null) return
  const bytes = Uint8Array.fromBase64(stored)
  const next = await transform(bytes)
  if (next === null) return
  cache.delete(name)
  inFlight.delete(name)
  bumpWriteGen(name)
  localStorage.setItem(LS_REPORT_PREFIX + name, next.toBase64())
  bumpWriteGen(name)
}

// Build the per-entry reseal transform for an encryption migration:
// on encrypt (`seal` given) a plaintext entry is sealed under `aad`
// and an already-enveloped one is skipped; on decrypt (`open` given),
// the inverse. Returning null means "already in the target state — no
// write". Shared by the reports and bundles sweeps below.
function migrationTransform(crypto, aad) {
  return crypto.seal
    ? (bytes) => (hasEnvelopeMagic(bytes) ? null : crypto.seal(bytes, aad))
    : (bytes) => (hasEnvelopeMagic(bytes) ? crypto.open(bytes, aad) : null)
}

// CONTRACT: must be called from inside an EXCLUSIVE VAULT_LOCK
// acquisition (i.e. from the migration callback passed to
// `enableEncryption` / `disableEncryption`). The helper itself
// doesn't acquire the lock — it relies on the caller's exclusive
// hold to block concurrent `saveFile` / `saveFileBytes` (which
// acquire VAULT_LOCK in shared mode) from interleaving writes into
// files the migration's `listFiles` snapshot has already taken.
// Calling this outside that lock leaves a TOCTOU window where a
// concurrent save can land bytes that the migration misses.
//
// AAD comes from the vault's `getEnvelopeAadForOpfs` so a future
// rename of the AAD format doesn't drift between save / migrate.
// Per-file: a `getFileHandle` NotFoundError (the file vanished
// between `listFiles` and the read) is swallowed so a concurrent
// delete doesn't abort the whole sweep; every other error
// propagates and aborts.
async function migrateOpfsFiles(crypto) {
  const names = await listFiles()
  for (const name of names) {
    try {
      await rawReadAndWrite(name, migrationTransform(crypto, getEnvelopeAadForOpfs(name)))
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') continue
      throw err
    }
  }
}
export const migrateOpfsFilesEncrypt = ({ seal }) => migrateOpfsFiles({ seal })
export const migrateOpfsFilesDecrypt = ({ open }) => migrateOpfsFiles({ open })

// Migration for the bundles directory — parallel to the reports
// migration above. The bundle bytes are sealed under
// `getEnvelopeAadForBundle(integrity)`; the `_meta.json` is sealed
// under the `__meta__` slot. Same VAULT_LOCK exclusive-hold
// contract: the caller blocks concurrent saveBundle / deleteBundle
// (which acquire shared) from interleaving writes mid-sweep.
//
// `_meta.json` lives in the same directory as bundle bytes, so the
// `listBundleStorageKeys` enumeration includes it; the meta slot
// dispatches to the meta AAD, every other key uses its integrity
// (= the on-disk filename, post-`/`→`_`-replacement maps back
// trivially since we only used `/` → `_`).
async function listBundleStorageKeys() {
  const dir = await getOpfsBundlesDir()
  if (!dir) return { dir: null, keys: [] }
  const keys = []
  for await (const [k] of dir.entries()) keys.push(k)
  return { dir, keys }
}

// Map an OPFS-key in the bundles directory back to the AAD slot
// it was sealed under. Bundle bytes are stored at
// `integrityToOpfsKey(integrity)` (= integrity with `/` → `_`),
// which is the only transform applied at save time; reverse it
// here so the AAD slot at migrate / open time matches the slot
// used at seal time.
//
// SHA-512 base64 SRI is always shaped `sha512-` + 88-char base64
// (`A-Za-z0-9+/=`); canonical base64 never produces `_`, so the
// unconditional `_` → `/` reverse is unambiguous for the current
// integrity format. Guard against unexpected filenames (and any
// future integrity format that legitimately contains `_`) by
// requiring the canonical `sha512-` prefix — anything else
// returns null and the caller skips it. This prevents a stray
// file dropped into `deepview-bundles/` from being silently
// re-encrypted under a wrong-slot AAD.
//
// `BUNDLE_META_SLOT === '__meta__'` is reserved and never
// collides with a real integrity (88-char base64 can't equal an
// 8-char literal). The migration test pins this invariant.
function bundleAadSlotForOpfsKey(opfsKey) {
  if (opfsKey === BUNDLE_META_FILE) return BUNDLE_META_SLOT
  if (!opfsKey.startsWith('sha512-')) return null
  return opfsKey.replaceAll('_', '/')
}

async function rawReadAndWriteBundle(dir, opfsKey, transform) {
  const fh = await dir.getFileHandle(opfsKey)
  const file = await fh.getFile()
  const bytes = new Uint8Array(await file.arrayBuffer())
  const next = await transform(bytes)
  if (next === null) return
  const writeFh = await dir.getFileHandle(opfsKey, { create: true })
  await writeOpfsFile(writeFh, next)
}

// Bundles sweep — parallel to migrateOpfsFiles, but keyed by the
// on-disk OPFS key reversed to its AAD slot via bundleAadSlotForOpfsKey.
// A key outside the expected `sha512-...` / `_meta.json` shape returns
// a null slot and is skipped rather than resealed under a misderived
// AAD (a stray file dropped here shouldn't be silently re-encrypted
// under a slot we can't reverse on read). Same EXCLUSIVE VAULT_LOCK
// contract as migrateOpfsFiles.
async function migrateOpfsBundles(crypto) {
  const { dir, keys } = await listBundleStorageKeys()
  if (!dir) return
  for (const k of keys) {
    const slot = bundleAadSlotForOpfsKey(k)
    if (slot === null) continue
    try {
      await rawReadAndWriteBundle(dir, k, migrationTransform(crypto, getEnvelopeAadForBundle(slot)))
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') continue
      throw err
    }
  }
}
export const migrateOpfsBundlesEncrypt = ({ seal }) => migrateOpfsBundles({ seal })
export const migrateOpfsBundlesDecrypt = ({ open }) => migrateOpfsBundles({ open })

// Vault state change handler — wipe the per-name read cache so the
// next read of an encrypted file goes back to OPFS / LS and the
// just-set (or just-cleared) session key is used to peel the
// envelope. Without this, a cached plaintext read from BEFORE the
// vault state changed would keep serving stale data.
onVaultStateChange(() => {
  cache.clear()
  inFlight.clear()
})

// Surface isEncryptionEnabled for the UI without forcing every
// caller to import the vault module separately.
export { isEncryptionEnabled }
