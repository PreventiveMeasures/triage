// Cross-bundle file-hash index — maps a file's SHA-512
// integrity to the bundles that contain a source with that
// hash. Powers the finding-card's "Code →" shortcut: a report
// finding carries the bundle integrities the analyzer saw
// (`_bundleHashes`, stamped at ingest); we match the finding's
// `fileHash` against the bundles' computed file hashes and
// surface a click target into the matching bundle's Code view
// at that file.
//
// Populated by `ui/view/bundle-load.js` whenever a bundle's
// per-file hashes are computed (either from the user opening
// the bundle in the UI or from a report-driven prefetch). The
// inverse `bundleHashesByIntegrity` lets us prune cleanly when
// a bundle is deleted.

const bundleFilesByHash = new Map()
const bundleHashesByIntegrity = new Map()

// Record a bundle's per-file hash map. Idempotent — calling
// twice with the same data is a no-op (the inner Map.set just
// overwrites with the same value). Returns true when this
// integrity is fresh (helps callers avoid redundant parses).
export function recordBundleFileHashes(integrity, fileHashes) {
  if (!integrity || !fileHashes) return false
  const fresh = !bundleHashesByIntegrity.has(integrity)
  bundleHashesByIntegrity.set(integrity, fileHashes)
  for (const [file, hash] of fileHashes) {
    if (!hash) continue
    let m = bundleFilesByHash.get(hash)
    if (!m) {
      m = new Map()
      bundleFilesByHash.set(hash, m)
    }
    m.set(integrity, file)
  }
  return fresh
}

// Drop everything we know about `integrity` — used when the
// bundle is deleted. Walks the saved file→hash map to remove
// the integrity from every per-hash bucket; empty buckets are
// pruned so memory doesn't drift over churn.
export function dropBundleFromHashIndex(integrity) {
  const fileHashes = bundleHashesByIntegrity.get(integrity)
  bundleHashesByIntegrity.delete(integrity)
  if (!fileHashes) return
  for (const hash of fileHashes.values()) {
    const m = bundleFilesByHash.get(hash)
    if (!m) continue
    m.delete(integrity)
    if (m.size === 0) bundleFilesByHash.delete(hash)
  }
}

// Lookup — returns the (integrity, file) pairs that contain a
// source with the given hash. Empty array when nothing matches.
// Caller filters further (e.g. a finding-card constrains to
// the report's `_bundleHashes` so only bundles the analyzer
// actually saw show up as click targets).
export function bundlesForFileHash(hash) {
  if (!hash) return []
  const m = bundleFilesByHash.get(hash)
  if (!m) return []
  const out = []
  for (const [integrity, file] of m) out.push({ integrity, file })
  return out
}

// True iff we already have the per-file hashes for this bundle
// — lets the prefetch path skip the parse + hash-compute when
// the user has already opened the bundle (which seeds the same
// cache via `recordBundleFileHashes`).
export function hasBundleFileHashes(integrity) {
  return bundleHashesByIntegrity.has(integrity)
}
