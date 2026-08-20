// Shared async open-bundle pipeline, consolidated so error handling
// etc. live in one place. Three callers need the same readBundle →
// branch by extension → JSON.parse / brotliDecompress → set
// bundleDetails + render → kick the SHA-512 file-hash index → kick
// the findings index flow: the sidebar bundle row click
// (`.file-item[data-bundle-integrity]` in sidebar.js), the
// finding-card "Code →" shortcut (`data-finding-code-bundle` in
// events.js), and the bundle-only drop branch in `ingest.js`.
import { Bundle } from '@exodus/stasis-core/bundle'
import { ensureBundleFindingsIndexed, hasBundleFileHashes, readBundle, recordBundleFileHashes, state } from '#client/index.js'
import { decodeUtf8 } from '../../common/utf8.js'
import { brotliDecompress } from './brotli-decompress.js'
import { render } from './render.js'
import { computeBundleFileHashes } from './render-bundle.js'

// Read OPFS bytes, classify by entry name (`.map` → sourcemap, else
// → stasis), and parse into the `details` object the render path
// consumes. Errors (read fail, JSON parse fail, brotli fail) come
// back as a fallback shape rather than thrown — the caller assigns
// `state.bundleDetails` unconditionally; the render path shows a
// "failed to parse" placeholder when `details.error` is set.
//
// Sourcemap → `details.json` is the raw `.map` JSON. Stasis →
// `details.bundle` is an `@exodus/stasis-core` `Bundle` (handles v0 +
// v1 uniformly; .sources / .imports / .modules are Map-shaped).
//
// Exported so non-state-mutating callers (focus view's inline code
// panel, prefetchBundleHashes below) can parse without touching
// `state.bundleDetails`.
export async function buildBundleDetails(integrity, entry) {
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
      // brotliDecompress dispatches native-or-fallback (see
      // view/brotli-decompress.js). Bundle.parse validates the
      // wrapper (version, scope, asserts on tampered shapes) and
      // normalizes both v0 and v1 layouts.
      const decoded = decodeUtf8(await brotliDecompress(bytes))
      const bundle = Bundle.parse(decoded)
      return { integrity, kind, size: bytes.byteLength, bundle }
    } catch (err) {
      return { integrity, kind, size: bytes.byteLength, error: err.message }
    }
  } catch (err) {
    return { integrity, error: err.message, size: 0 }
  }
}

// Background SHA-512 hashing of every source file so the bundle
// graph + Issues tab can join findings by fileHash. No-op when
// neither parse slot landed (load failed). Caller has already set
// `state.bundleDetails` and rendered; this attaches `fileHashes`
// once it lands and re-renders. Stale resolves (user clicked another
// row mid-hash) drop silently.
function kickFileHashes(details) {
  if (!details?.json && !details?.bundle) return
  ;(async () => {
    try {
      const fileHashes = await computeBundleFileHashes(details)
      // Cross-bundle hash index always gets the result, even after
      // navigating away — the report-card's "Code →" lookup needs it
      // regardless of the bundle panel's visibility.
      recordBundleFileHashes(details.integrity, fileHashes)
      if (state.selectedBundle !== details.integrity) return
      details.fileHashes = fileHashes
      render()
    } catch {}
  })()
}

// State-free variant of the open path — parses and records per-file
// hashes without touching `state.bundleDetails` / `selectedBundle`.
// Seeds the index for a freshly-loaded report's findings so "Code →"
// surfaces without the user opening every bundle. Idempotent + cheap:
// skipped if hashes for this integrity already exist.
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

// Full open-bundle pipeline. Caller owns the pre-load state setup
// (selectedBundle, bundleDetails=null, view slots like
// bundleDetailsTab / shownTriage / graph2.showAll) and the
// loading-state render(); this owns the parse + post-parse fan-out
// (set details + render, kick file hashes, kick the cross-report
// findings indexer). Bails silently when the entry is gone (bundle
// deleted in another tab between click and now).
//
// Stale resolves are dropped via `state.selectedBundle !== integrity`
// after each await, so a fast click into another bundle doesn't let
// the previous load clobber the new one's panel.
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
