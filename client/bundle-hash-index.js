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
//
// Both of those paths are asynchronous and land AFTER the report
// that needs them has already rendered — the prefetch is
// fire-and-forget at ingest, and on a reload the index starts
// empty while the stored report paints immediately. Subscribers
// (see `subscribeToBundleHashIndex`) are how a view that asked
// too early gets told to ask again; without one, the focus view's
// Code panel and the finding-card's "Code →" button stay missing
// until some unrelated interaction happens to re-render.

const bundleFilesByHash = new Map()
const bundleHashesByIntegrity = new Map()
// integrity → (last path segment → the files ending in it). Built on
// demand by `bundleFilePath`, see there.
const bundleFilesByBasename = new Map()
const listeners = new Set()

// Fires whenever the hash → bundle mapping gains or loses an
// integrity. Same shape as `subscribeToBundleFindingIndex`:
// returns an unsubscribe function, and a throwing listener can't
// take down the caller mid-record.
export function subscribeToBundleHashIndex(callback) {
  listeners.add(callback)
  return () => listeners.delete(callback)
}

function notify() {
  for (const cb of listeners) {
    try { cb() } catch {}
  }
}

// Record a bundle's per-file hash map. Idempotent — re-recording
// the same data overwrites in place. Returns true when this
// integrity is fresh (helps callers avoid redundant parses).
export function recordBundleFileHashes(integrity, fileHashes) {
  if (!integrity || !fileHashes) return false
  const fresh = !bundleHashesByIntegrity.has(integrity)
  bundleHashesByIntegrity.set(integrity, fileHashes)
  // A re-record replaces the map this mirrors, so the derived index
  // has to go with it rather than answer for the previous contents.
  bundleFilesByBasename.delete(integrity)
  for (const [file, hash] of fileHashes) {
    if (!hash) continue
    let m = bundleFilesByHash.get(hash)
    if (!m) {
      m = new Map()
      bundleFilesByHash.set(hash, m)
    }
    m.set(integrity, file)
  }
  // Only a first sighting can change a lookup's answer: a re-record
  // is the same bundle's bytes hashing to the same map, so notifying
  // on it would just re-render for nothing.
  if (fresh) notify()
  return fresh
}

// Drop everything we know about `integrity` — used when the
// bundle is deleted. Walks the saved file→hash map to remove
// the integrity from every per-hash bucket; empty buckets are
// pruned so memory doesn't drift over churn.
export function dropBundleFromHashIndex(integrity) {
  const fileHashes = bundleHashesByIntegrity.get(integrity)
  bundleHashesByIntegrity.delete(integrity)
  bundleFilesByBasename.delete(integrity)
  if (!fileHashes) return
  for (const hash of fileHashes.values()) {
    const m = bundleFilesByHash.get(hash)
    if (!m) continue
    m.delete(integrity)
    if (m.size === 0) bundleFilesByHash.delete(hash)
  }
  // The removal direction matters as much as the arrival one: a view
  // still offering the deleted bundle's code has to drop the offer.
  notify()
}

// Does this bundle carry this path, and under what key? Answers
// SYNCHRONOUSLY, off the file→hash map recorded above, so a caller
// deciding whether to offer a source preview doesn't have to parse
// and decompress a bundle to find out (see focus-code.js).
//
// Exact match first. Failing that, a path the report wrote relative
// to a different root than the bundle's is accepted on a segment
// boundary — but only when exactly one file ends that way. An
// ambiguous suffix answers null rather than guessing which of two
// `index.js` the report meant.
export function bundleFilePath(integrity, path) {
  const files = bundleHashesByIntegrity.get(integrity)
  if (!files || typeof path !== 'string' || path === '') return null
  if (files.has(path)) return path
  // Only files with the SAME last segment can end with `/…/<that
  // segment>`, so the basename narrows the search to a handful before
  // any string is compared — see `basenamesFor` for why that matters.
  const candidates = basenamesFor(integrity, files).get(basename(path))
  if (!candidates) return null
  const suffix = path.startsWith('/') ? path : `/${path}`
  let hit = null
  for (const file of candidates) {
    if (!file.endsWith(suffix)) continue
    if (hit !== null) return null
    hit = file
  }
  return hit
}

function basename(path) {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? path : path.slice(slash + 1)
}

// The suffix search used to walk every file in the bundle, and a card
// asks once per code link — so a list of 2000 findings against a
// 3000-file bundle spent a quarter of a second in `endsWith` on every
// render, whether or not anything about the bundles had changed. The
// misses were the worst of it: a path the bundle doesn't carry only
// finds that out after reading all of them.
//
// Grouping the files by last segment costs one pass per bundle and
// turns each lookup into a Map hit plus a compare against the one or
// two files that could possibly match. Built lazily, because a bundle
// that is recorded and never asked about should cost nothing, and
// dropped wherever the file map it mirrors is replaced or removed.
function basenamesFor(integrity, files) {
  let index = bundleFilesByBasename.get(integrity)
  if (index) return index
  index = new Map()
  for (const file of files.keys()) {
    const base = basename(file)
    const seen = index.get(base)
    if (seen) seen.push(file)
    else index.set(base, [file])
  }
  bundleFilesByBasename.set(integrity, index)
  return index
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
