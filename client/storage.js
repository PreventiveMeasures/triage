import { decodeUtf8, encodeUtf8 } from '../common/utf8.js'

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
async function getOpfsDir() {
  try {
    const root = await navigator.storage.getDirectory()
    return await root.getDirectoryHandle(OPFS_DIR, { create: true })
  } catch (err) {
    if (!opfsWarned) {
      opfsWarned = true
      // file:// and older browsers reject OPFS. We fall back to gzipped
      // localStorage automatically; surface this once so a user wondering
      // about quota / size limits sees what's happening.
      console.warn('OPFS unavailable, falling back to gzipped localStorage (limited quota).', err)
    }
    return null
  }
}

// Compress / decompress JSON text via gzip + base64 for the localStorage
// fallback. CompressionStream / DecompressionStream are well supported
// (same primitive used by loadTriage / saveTriage). Base64 is the
// transport because localStorage values are strings.
async function gzipString(text) {
  const bytes = encodeUtf8(text)
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
  const arr = new Uint8Array(await new Response(stream).arrayBuffer())
  return arr.toBase64()
}
async function gunzipString(b64) {
  const bytes = Uint8Array.fromBase64(b64)
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  const arr = new Uint8Array(await new Response(stream).arrayBuffer())
  return decodeUtf8(arr)
}

// Binary gzip — bytes in, bytes out. Used by the bundles layer so
// .map sourcemaps (text JSON, highly compressible) cost less in OPFS;
// readBundle auto-detects via the gzip magic bytes (1f 8b) so the
// flag doesn't need to live in metadata.
async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
export async function gunzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

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
    return names.sort()
  }
  const names = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && key.startsWith(LS_REPORT_PREFIX)) names.push(key.slice(LS_REPORT_PREFIX.length))
  }
  return names.sort()
}

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
    const bytes = await gzipBytes(encodeUtf8(content))
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
  const compressed = await gzipString(content)
  try {
    localStorage.setItem(LS_REPORT_PREFIX + name, compressed)
    cache.set(name, content)
    bumpWriteGen(name)
    notifyFileMutated(name, 'save')
  } catch (err) {
    // Most likely QuotaExceededError. Re-throw so the drop handler can
    // surface a useful message to the user instead of silently dropping.
    bumpWriteGen(name)
    throw new Error(`localStorage write failed for ${name}: ${err.message}`, { cause: err })
  }
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
      const bytes = new Uint8Array(await file.arrayBuffer())
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
    const compressed = localStorage.getItem(LS_REPORT_PREFIX + name)
    if (compressed === null) throw new Error(`File not found: ${name}`)
    return await gunzipString(compressed)
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

// Read the on-disk bytes for a report, unchanged. Where OPFS holds
// the report it returns the gzipped bytes (the same shape
// `saveFile` writes); on localStorage fallback it returns the
// gzipped bytes too (after base64-decoding the LS string). Caller
// is responsible for gunzipping if it wants the plaintext.
//
// Used by the objstore upload path so we can ship the existing
// on-disk gzipped representation through the wire encryption layer
// — no need to decompress and re-compress.
export async function readFileBytes(name) {
  const dir = await getOpfsDir()
  if (dir) {
    const fh = await dir.getFileHandle(name)
    const file = await fh.getFile()
    return new Uint8Array(await file.arrayBuffer())
  }
  const compressed = localStorage.getItem(LS_REPORT_PREFIX + name)
  if (compressed === null) throw new Error(`File not found: ${name}`)
  // Legacy localStorage path stored compressed strings (see
  // `gzipString` / `gunzipString` below); decode the base64 wrapper
  // back to bytes so this returns the on-disk gzip stream.
  return Uint8Array.fromBase64(compressed)
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
export async function saveFileBytes(name, bytes) {
  if (typeof name !== 'string' || name.includes('\0')) {
    throw new Error(`Invalid report name: contains NUL byte or is not a string`)
  }
  bumpWriteGen(name)
  cache.delete(name)
  const dir = await getOpfsDir()
  if (dir) {
    const fh = await dir.getFileHandle(name, { create: true })
    const writable = await fh.createWritable()
    try {
      await writable.write(bytes)
      await writable.close()
    } catch (err) {
      bumpWriteGen(name)
      throw err
    }
    bumpWriteGen(name)
    notifyFileMutated(name, 'save')
    return
  }
  try {
    localStorage.setItem(LS_REPORT_PREFIX + name, bytes.toBase64())
    bumpWriteGen(name)
    notifyFileMutated(name, 'save')
  } catch (err) {
    bumpWriteGen(name)
    throw new Error(`localStorage write failed for ${name}: ${err.message}`, { cause: err })
  }
}

export async function deleteFile(name) {
  // Bump synchronously BEFORE the async I/O — see saveFile for the
  // race this guards (a concurrent readFile resolving with stale
  // bytes after we cleared the cache here). Audit round-9 H1.
  bumpWriteGen(name)
  cache.delete(name)
  inFlight.delete(name)
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

async function getOpfsBundlesDir() {
  try {
    const root = await navigator.storage.getDirectory()
    return await root.getDirectoryHandle(OPFS_BUNDLES_DIR, { create: true })
  } catch { return null }
}

// SRI uses standard base64 (with `/` and `+`); OPFS rejects `/` in
// filenames, so the on-disk key swaps `/` for `_`. The displayed
// integrity keeps the canonical form so users can paste it into
// SRI-aware tools verbatim.
function integrityToOpfsKey(integrity) {
  return integrity.replaceAll('/', '_')
}

async function readBundleMeta(dir) {
  try {
    const fh = await dir.getFileHandle(BUNDLE_META_FILE)
    const file = await fh.getFile()
    const data = JSON.parse(await file.text())
    if (Array.isArray(data)) return data
    return []
  } catch { return [] }
}

async function writeBundleMeta(dir, meta) {
  try { await dir.removeEntry(BUNDLE_META_FILE) } catch {}
  const fh = await dir.getFileHandle(BUNDLE_META_FILE, { create: true })
  const w = await fh.createWritable()
  await w.write(JSON.stringify(meta))
  await w.close()
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
  return [...meta].sort((a, b) => a.name.localeCompare(b.name))
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
    : new TextEncoder().encode(content)
  const hashBuf = await crypto.subtle.digest('SHA-512', bytes)
  const integrity = `sha512-${new Uint8Array(hashBuf).toBase64()}`
  const opfsKey = integrityToOpfsKey(integrity)
  const storeBytes = name.toLowerCase().endsWith('.map')
    ? await gzipBytes(bytes)
    : bytes
  try { await dir.removeEntry(opfsKey) } catch {}
  const fh = await dir.getFileHandle(opfsKey, { create: true })
  const w = await fh.createWritable()
  await w.write(storeBytes)
  await w.close()
  // RMW the metadata under the same-origin Web Lock so a concurrent
  // saveBundle / deleteBundle can't clobber the entry we just
  // persisted. Audit round-12 H7.
  await lockBundleMeta(async () => {
    const meta = await readBundleMeta(dir)
    const idx = meta.findIndex((e) => e.integrity === integrity)
    if (idx >= 0) meta[idx] = { integrity, name }
    else meta.push({ integrity, name })
    await writeBundleMeta(dir, meta)
  })
  return { integrity, name }
}

export async function deleteBundle(integrity) {
  const dir = await getOpfsBundlesDir()
  if (!dir) return
  try { await dir.removeEntry(integrityToOpfsKey(integrity)) } catch {}
  // Same RMW lock as saveBundle — without it, a deleteBundle whose
  // readBundleMeta predates a concurrent saveBundle would
  // writeBundleMeta a meta array missing the freshly-saved entry,
  // silently undoing the save's metadata insertion. Audit round-12 H7.
  await lockBundleMeta(async () => {
    const meta = await readBundleMeta(dir)
    const filtered = meta.filter((e) => e.integrity !== integrity)
    await writeBundleMeta(dir, filtered)
  })
}

export async function readBundle(integrity) {
  const dir = await getOpfsBundlesDir()
  if (!dir) throw new Error('OPFS unavailable')
  const fh = await dir.getFileHandle(integrityToOpfsKey(integrity))
  const file = await fh.getFile()
  const bytes = new Uint8Array(await file.arrayBuffer())
  // Auto-decompress when the on-disk bytes start with the gzip magic
  // (1f 8b) — saveBundle gzips .map sourcemaps to save OPFS space,
  // but the caller wants the original content. Stasis bundles use
  // brotli (different magic) so they fall through unchanged.
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return await gunzipBytes(bytes)
  }
  return bytes
}
