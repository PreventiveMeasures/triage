// Shared async open-bundle pipeline. The bundles list row click
// (`data-select-bundle`), the Code → shortcut
// (`data-bundle-row-code`), and the bundle-only drop branch in
// `ingest.js` all need the same readBundle → branch by extension
// → JSON.parse / brotliDecompress → set bundleDetails + render
// → kick the SHA-512 file-hash index → kick the findings index
// flow. Three near-identical copies used to live across
// `events.js` + `ingest.js`; consolidating here means the next
// fix to e.g. error handling lands in one place.
import { ensureBundleFindingsIndexed } from '../../client/bundle-finding-index.js'
import { readBundle } from '../../client/storage.js'
import { state } from '../../client/state.js'
import { brotliDecompress } from './brotli-decompress.js'
import { computeBundleFileHashes, render } from './render.js'

// Read OPFS bytes for the given bundle, classify by the entry's
// name (`.map` → sourcemap, anything else → stasis), and parse
// into the `details` object the bundle render path consumes.
// Errors (read fail, JSON parse fail, brotli fail) are reflected
// as a fallback shape rather than thrown — the caller assigns
// `state.bundleDetails` unconditionally; the render path shows a
// "failed to parse" placeholder when `details.error` is set.
async function buildBundleDetails(integrity, entry) {
  try {
    const bytes = await readBundle(integrity)
    const isMap = entry.name.toLowerCase().endsWith('.map')
    const kind = isMap ? 'sourcemap' : 'stasis'
    try {
      // Stasis bundles are brotli-compressed JSON snapshots (see
      // src/loaders/stasis.js); brotliDecompress dispatches to
      // native DecompressionStream when available and falls
      // through to the SW echo trick when it's not (see
      // view/brotli-decompress.js).
      const decoded = isMap
        ? new TextDecoder().decode(bytes)
        : new TextDecoder().decode(await brotliDecompress(bytes))
      const json = JSON.parse(decoded)
      return { integrity, kind, size: bytes.byteLength, json }
    } catch (err) {
      return { integrity, kind, size: bytes.byteLength, error: err.message }
    }
  } catch (err) {
    return { integrity, error: err.message, size: 0 }
  }
}

// Background SHA-512 hashing of every source file in
// `details.json` so the bundle graph + Issues tab can join
// findings by fileHash. No-op when there's no parsed json (load
// failed). Caller has already set `state.bundleDetails = details`
// and rendered; this attaches `fileHashes` once it lands and
// triggers a re-render. Stale resolves (user clicked another
// row mid-hash) drop silently.
function kickFileHashes(details) {
  if (!details?.json) return
  ;(async () => {
    try {
      const fileHashes = await computeBundleFileHashes(details)
      if (state.selectedBundle !== details.integrity) return
      details.fileHashes = fileHashes
      render()
    } catch {}
  })()
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
