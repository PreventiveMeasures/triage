// Shared async open-bundle pipeline. The bundles list row click
// (`data-select-bundle`), the Code → shortcut
// (`data-bundle-row-code`), and the bundle-only drop branch in
// `ingest.js` all need the same readBundle → branch by extension
// → JSON.parse / brotliDecompress → set bundleDetails + render
// → kick the SHA-512 file-hash index → kick the findings index
// flow. Three near-identical copies used to live across
// `events.js` + `ingest.js`; consolidating here means the next
// fix to e.g. error handling lands in one place.
import { Bundle } from '@exodus/stasis/bundle'
import { ensureBundleFindingsIndexed } from '../../client/bundle-finding-index.js'
import { hasBundleFileHashes, recordBundleFileHashes } from '../../client/bundle-hash-index.js'
import { readBundle } from '../../client/storage.js'
import { state } from '../../client/state.ts'
import { decodeUtf8 } from '../../common/utf8.js'
import { brotliDecompress } from './brotli-decompress.js'
import { render } from './render.js'
import { computeBundleFileHashes } from './render-bundle.js'

// Read OPFS bytes for the given bundle, classify by the entry's
// name (`.map` → sourcemap, anything else → stasis), and parse
// into the `details` object the bundle render path consumes.
// Errors (read fail, JSON parse fail, brotli fail) are reflected
// as a fallback shape rather than thrown — the caller assigns
// `state.bundleDetails` unconditionally; the render path shows a
// "failed to parse" placeholder when `details.error` is set.
//
// Sourcemap → `details.json` carries the raw `.map` JSON. Stasis
// → `details.bundle` carries an `@exodus/stasis` `Bundle` instance
// (handles v0 + v1 layouts uniformly; .sources / .imports / .modules
// are Map-shaped APIs the render path consumes).
async function buildBundleDetails(integrity, entry) {
  try {
    const bytes = await readBundle(integrity)
    const isMap = entry.name.toLowerCase().endsWith('.map')
    const kind = isMap ? 'sourcemap' : 'stasis'
    try {
      if (isMap) {
        const json = JSON.parse(decodeUtf8(bytes))
        return { integrity, kind, size: bytes.byteLength, json }
      }
      // Stasis bundles are brotli-compressed JSON snapshots;
      // brotliDecompress dispatches to native DecompressionStream
      // when available and falls through to the SW echo trick when
      // it's not (see view/brotli-decompress.js). Bundle.parseCode
      // validates the wrapper (version, scope, asserts on tampered
      // shapes) and normalizes both v0 and v1 layouts.
      const decoded = decodeUtf8(await brotliDecompress(bytes))
      const bundle = Bundle.parseCode(decoded)
      return { integrity, kind, size: bytes.byteLength, bundle }
    } catch (err) {
      return { integrity, kind, size: bytes.byteLength, error: err.message }
    }
  } catch (err) {
    return { integrity, error: err.message, size: 0 }
  }
}

// Background SHA-512 hashing of every source file in the parsed
// bundle so the bundle graph + Issues tab can join findings by
// fileHash. No-op when neither parse slot landed (load failed).
// Caller has already set `state.bundleDetails = details` and
// rendered; this attaches `fileHashes` once it lands and triggers
// a re-render. Stale resolves (user clicked another row mid-hash)
// drop silently.
function kickFileHashes(details) {
  if (!details?.json && !details?.bundle) return
  ;(async () => {
    try {
      const fileHashes = await computeBundleFileHashes(details)
      // Cross-bundle hash index always gets the result, even
      // when the user has navigated away — the data is useful
      // to the report-card's "Code →" lookup regardless of
      // the bundle panel's visibility.
      recordBundleFileHashes(details.integrity, fileHashes)
      if (state.selectedBundle !== details.integrity) return
      details.fileHashes = fileHashes
      render()
    } catch {}
  })()
}

// State-free variant of the open path — parses the bundle and
// computes its per-file hashes, recording them in the hash
// index, without touching `state.bundleDetails` /
// `state.selectedBundle`. Used to seed the index for findings
// in a freshly-loaded report so the "Code →" shortcut surfaces
// without the user having to manually open every bundle.
// Idempotent + cheap: skipped if we already have hashes for
// this integrity; otherwise the same buildBundleDetails +
// computeBundleFileHashes pipeline.
export async function prefetchBundleHashes(integrity) {
  if (hasBundleFileHashes(integrity)) return
  const entry = (state.bundles ?? []).find((b) => b.integrity === integrity)
  if (!entry) return
  const details = await buildBundleDetails(integrity, entry)
  if (!details?.json && !details?.bundle) return
  try {
    const fileHashes = await computeBundleFileHashes(details)
    recordBundleFileHashes(integrity, fileHashes)
  } catch {}
}

// Full open-bundle pipeline. Caller is responsible for the
// pre-load state setup (selectedBundle, bundleDetails=null, the
// view's other slots like bundleDetailsTab / shownTriage /
// graph2.showAll) and for the loading-state render(); this
// function owns the parse + post-parse fan-out (set details +
// render, kick file hashes, kick the cross-report findings
// indexer). Looks up the entry from `state.bundles`; bails
// silently when it's gone (user deleted the bundle in another
// tab between the click and now).
//
// Stale resolves are dropped via `state.selectedBundle !==
// integrity` after each await — that's how a fast click into
// another bundle keeps the previous load from clobbering the
// new one's panel.
export async function openBundle(integrity) {
  const entry = (state.bundles ?? []).find((b) => b.integrity === integrity)
  if (!entry) return
  const details = await buildBundleDetails(integrity, entry)
  if (state.selectedBundle !== integrity) return
  state.bundleDetails = details
  render()
  kickFileHashes(details)
  ensureBundleFindingsIndexed().catch(() => {})
}
