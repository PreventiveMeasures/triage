import { encodeUtf8 } from '../../common/utf8.js'

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
  return new TextDecoder().decode(arr)
}

// Binary gzip — bytes in, bytes out. Used by the bundles layer so
// .map sourcemaps (text JSON, highly compressible) cost less in OPFS;
// readBundle auto-detects via the gzip magic bytes (1f 8b) so the
// flag doesn't need to live in metadata.
async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}
async function gunzipBytes(bytes) {
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
  const dir = await getOpfsDir()
  if (dir) {
    // OPFS reports are gzipped at rest — JSON dumps compress well
    // and OPFS quota is shared with bundles + workspaces. readFile
    // sniffs the gzip magic on read so legacy uncompressed entries
    // keep working until they're rewritten through here.
    const bytes = await gzipBytes(new TextEncoder().encode(content))
    try { await dir.removeEntry(name) } catch {}
    const fh = await dir.getFileHandle(name, { create: true })
    const writable = await fh.createWritable()
    await writable.write(bytes)
    await writable.close()
    cache.set(name, content)
    return
  }
  const compressed = await gzipString(content)
  try {
    localStorage.setItem(LS_REPORT_PREFIX + name, compressed)
    cache.set(name, content)
  } catch (err) {
    // Most likely QuotaExceededError. Re-throw so the drop handler can
    // surface a useful message to the user instead of silently dropping.
    throw new Error(`localStorage write failed for ${name}: ${err.message}`)
  }
}

export async function readFile(name) {
  if (cache.has(name)) return cache.get(name)
  if (inFlight.has(name)) return inFlight.get(name)
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
        return new TextDecoder().decode(out)
      }
      const text = new TextDecoder().decode(bytes)
      // Migrate the legacy uncompressed entry by writing it back
      // through saveFile (which gzips). Fire-and-forget — the read
      // result is already decided, and a write failure is harmless
      // (next read will retry the migration). Skipping the await
      // also keeps the read path fast on the migration pass.
      saveFile(name, text).catch(() => {})
      return text
    }
    const compressed = localStorage.getItem(LS_REPORT_PREFIX + name)
    if (compressed === null) throw new Error(`File not found: ${name}`)
    return await gunzipString(compressed)
  })()
  inFlight.set(name, promise)
  try {
    const content = await promise
    cache.set(name, content)
    return content
  } finally {
    inFlight.delete(name)
  }
}

export async function deleteFile(name) {
  cache.delete(name)
  inFlight.delete(name)
  const dir = await getOpfsDir()
  if (dir) {
    try { await dir.removeEntry(name) } catch {}
    return
  }
  localStorage.removeItem(LS_REPORT_PREFIX + name)
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
  const meta = await readBundleMeta(dir)
  const idx = meta.findIndex((e) => e.integrity === integrity)
  if (idx >= 0) meta[idx] = { integrity, name }
  else meta.push({ integrity, name })
  await writeBundleMeta(dir, meta)
  return { integrity, name }
}

export async function deleteBundle(integrity) {
  const dir = await getOpfsBundlesDir()
  if (!dir) return
  try { await dir.removeEntry(integrityToOpfsKey(integrity)) } catch {}
  const meta = await readBundleMeta(dir)
  const filtered = meta.filter((e) => e.integrity !== integrity)
  await writeBundleMeta(dir, filtered)
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
