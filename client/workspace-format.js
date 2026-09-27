// Workspace file decoding only: no local storage, reactive state, or import side effects.
import { gunzipToText } from '../common/gzip.js'
import { decryptBundle, isEncryptedBundle } from './workspace-bundle-crypto.js'

const EXPORT_VERSION = 1

// Caps on the membership arrays. The import runs a serial detach pass
// per identifier (each takes the Web Lock + a writeRaw) — without a
// cap, a crafted export with 50k `bundles` (or 50k empty `reports`)
// would freeze the tab and strip legitimate memberships from victim
// workspaces BEFORE the final upsert hits QuotaExceededError (audit
// S-Import-1). 1024 is well above any plausible legit workspace (the
// user would drag 1024 items by hand) yet keeps the K × lock-RMW pass
// interactive. Reports DO carry content (gzipped), but K empty
// `{findings:[]}` objects gzip small while still triggering K detach
// calls — so the cap applies symmetrically. Bundle per-entry length
// is gated separately so a single 100MB integrity string can't
// smuggle in under the count cap.
const MAX_BUNDLES_PER_EXPORT = 1024
export const MAX_REPORTS_PER_EXPORT = 1024
const MAX_BUNDLE_INTEGRITY_LEN = 200
// Per-blob raw-byte ceiling for `bundleBlobs.data`. Bytes are base64
// on the wire (~4/3 expansion), so the encoded cap sits a bit above
// the raw target. 100 MiB raw covers every plausible .map /
// .stasis.code.br from the analyzer and bounds the import's memory —
// a crafted 4 GB blob would otherwise allocate its decoded buffer at
// decode time.
const MAX_BUNDLE_BLOB_BYTES = 100 * 1024 * 1024
const MAX_BUNDLE_BLOB_DATA_LEN = Math.ceil(MAX_BUNDLE_BLOB_BYTES * 4 / 3) + 16
// Display-name cap on `bundleBlobs.name`. Far longer than any
// realistic .map / .stasis filename, shorter than the workspace-name
// cap, so a crafted export can't bloat OPFS bundle metadata.
const MAX_BUNDLE_BLOB_NAME_LEN = 512
// Distinct (tighter) count cap for `bundleBlobs` — bytes-heavy, so
// the 1024-pointer `bundles` cap would otherwise let a payload sit at
// ~136 GiB of gunzipped JSON in memory before validation runs. 64
// covers any realistic workspace (the integrity-pointer side keeps
// the 1024 ceiling for the orphan-pointer carrier shape) while
// bounding worst-case decode-time memory at ~6.4 GiB raw.
const MAX_BUNDLE_BLOBS_PER_EXPORT = 64

// Single source of truth for export-shape validation. Returns `null`
// when acceptable, else a specific error string. `isWorkspaceExport`
// wraps it for a boolean; `parseWorkspaceJson` surfaces the reason so
// a cap violation doesn't read as a generic "not a deepview workspace
// export" format error on a file that IS valid, just oversized.
function validateExportShape(data) {
  if (!data || typeof data !== 'object') return 'payload is not an object'
  if (data.version !== EXPORT_VERSION) return `unsupported export version: ${data.version}`
  if (!data.workspace || typeof data.workspace !== 'object') return 'workspace metadata missing'
  if (typeof data.workspace.id !== 'string') return 'workspace.id must be a string'
  if (typeof data.workspace.name !== 'string') return 'workspace.name must be a string'
  if (typeof data.workspace.privateKey !== 'string') return 'workspace.privateKey must be a string'
  // `createdAt` rides through `applyWorkspaceImport` into
  // `upsertWorkspace` and the persisted blob. A crafted bundle could
  // otherwise embed any value (function-shape string, nested object,
  // NaN, Infinity, null); `Number.isFinite` rejects all of those.
  // `undefined` stays accepted — `upsertWorkspace` falls back to
  // `Date.now()` for missing fields. Audit round-14 WI-2.
  if (data.workspace.createdAt !== undefined && !Number.isFinite(data.workspace.createdAt)) {
    return 'workspace.createdAt must be a finite number or omitted'
  }
  if (!Array.isArray(data.reports)) return 'reports field must be an array'
  if (data.reports.length > MAX_REPORTS_PER_EXPORT) {
    return `reports count (${data.reports.length}) exceeds cap (${MAX_REPORTS_PER_EXPORT})`
  }
  if (data.bundles !== undefined) {
    if (!Array.isArray(data.bundles)) return 'bundles field must be an array when present'
    if (data.bundles.length > MAX_BUNDLES_PER_EXPORT) {
      return `bundles count (${data.bundles.length}) exceeds cap (${MAX_BUNDLES_PER_EXPORT})`
    }
    // Require `typeof === 'string'` AND length cap — a non-string
    // entry under the count cap would otherwise pass here and be
    // silently filtered by applyWorkspaceImport later, leaving the
    // validator more permissive than its contract (audit S-Import-3).
    for (const b of data.bundles) {
      if (typeof b !== 'string') return 'bundles entries must be strings'
      if (b.length > MAX_BUNDLE_INTEGRITY_LEN) {
        return `bundle integrity exceeds per-entry length cap (${MAX_BUNDLE_INTEGRITY_LEN})`
      }
    }
  }
  // `bundleBlobs` carries the bundle bytes (base64) when the sender
  // opts in. Validated symmetrically with `bundles` but with a
  // tighter count cap (bytes are heavy — see
  // MAX_BUNDLE_BLOBS_PER_EXPORT), plus per-entry shape and per-blob
  // size limits so a 4 GB blob can't blow up the import before decode.
  if (data.bundleBlobs !== undefined) {
    if (!Array.isArray(data.bundleBlobs)) return 'bundleBlobs field must be an array when present'
    if (data.bundleBlobs.length > MAX_BUNDLE_BLOBS_PER_EXPORT) {
      return `bundleBlobs count (${data.bundleBlobs.length}) exceeds cap (${MAX_BUNDLE_BLOBS_PER_EXPORT})`
    }
    for (const b of data.bundleBlobs) {
      if (!b || typeof b !== 'object' || Array.isArray(b)) return 'bundleBlobs entries must be objects'
      if (typeof b.integrity !== 'string' || b.integrity.length === 0) {
        return 'bundleBlobs.integrity must be a non-empty string'
      }
      if (b.integrity.length > MAX_BUNDLE_INTEGRITY_LEN) {
        return `bundleBlobs.integrity exceeds per-entry length cap (${MAX_BUNDLE_INTEGRITY_LEN})`
      }
      if (typeof b.name !== 'string' || b.name.length === 0) {
        return 'bundleBlobs.name must be a non-empty string'
      }
      if (b.name.length > MAX_BUNDLE_BLOB_NAME_LEN) {
        return `bundleBlobs.name exceeds per-entry length cap (${MAX_BUNDLE_BLOB_NAME_LEN})`
      }
      // Defence-in-depth: NULs in display names break sidebar lookups
      // and audit-log scraping, and `_meta.json` embeds the name
      // verbatim. The integrity (NOT the name) is the OPFS storage key
      // in saveBundle, so this is downstream-display hygiene, not a
      // storage-boundary check.
      if (b.name.includes('\0')) return 'bundleBlobs.name cannot contain NUL'
      if (typeof b.data !== 'string') return 'bundleBlobs.data must be a base64 string'
      if (b.data.length > MAX_BUNDLE_BLOB_DATA_LEN) {
        return `bundleBlobs.data exceeds per-blob size cap (${MAX_BUNDLE_BLOB_BYTES} bytes raw)`
      }
    }
  }
  return null
}

export function isWorkspaceExport(data) {
  return validateExportShape(data) === null
}

// UI import reads once up front so the magic-byte sniff and the parse
// share one buffer (re-reading would re-stream disk on every unlock-
// dialog retry).
export async function readBundleBytes(file) {
  return new Uint8Array(await file.arrayBuffer())
}

// Dispatches encrypted vs plaintext-gzip by magic byte. Encrypted
// bundles require a non-empty `password`; the unlock dialog owns the
// wrong-password retry loop. Post-decrypt failures (gunzip, JSON
// shape) collapse into the same `wrong password or corrupt bundle`
// error as a genuine auth failure — distinct texts would form an
// oracle confirming "password decrypted successfully" to an attacker
// probing crafted ciphertexts.
export async function parseWorkspaceBundleBytes(bytes, password) {
  if (isEncryptedBundle(bytes)) {
    if (typeof password !== 'string' || !password) {
      throw new TypeError('parseWorkspaceBundleBytes: password required for encrypted bundle')
    }
    const plaintext = await decryptBundle(bytes, password)
    try {
      return parseWorkspaceJson(await gunzipToText(plaintext))
    } catch (err) {
      // Keep `cause` for debugging while the surfaced message stays
      // generic — the oracle defense is at the message layer, not the
      // cause chain.
      throw new Error('wrong password or corrupt bundle', { cause: err })
    }
  }
  let text
  try {
    text = await gunzipToText(bytes)
  } catch (err) {
    throw new Error(`gzip decompression failed: ${err.message}`, { cause: err })
  }
  return parseWorkspaceJson(text)
}

export function parseWorkspaceJson(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new Error(`payload is not JSON: ${err.message}`, { cause: err })
  }
  const reason = validateExportShape(data)
  if (reason === null) return data
  // A cap-violation reason ("bundles count exceeds cap (1025)") is
  // more useful than a generic "not a deepview workspace export" — the
  // file IS valid, just oversized. Wrap with the legacy prefix only
  // for structural failures so existing callers' error-message
  // expectations keep working for the shape-error case.
  const isCapFailure = reason.includes('exceeds cap')
  throw new Error(isCapFailure ? reason : `not a deepview workspace export: ${reason}`)
}
