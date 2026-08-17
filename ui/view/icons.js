// Single source of truth for inline SVG glyphs reused across more
// than one surface. Stored as raw SVG strings so callers can pick
// the binding that fits:
//   - Sidebar rows (shadow DOM, Lit templates) wrap with
//     `unsafeHTML(...)` to land the markup inside the row template.
//   - Drop-zone supported-formats list (light DOM, static HTML)
//     has the boot path inject these strings via `.innerHTML` into
//     `<span data-icon="…">` placeholders so the same source
//     paints both surfaces without duplicating the path data.
//
// Report-bucket stickers (default / claude-security / codex-security
// / deepsec / piolium) live in `view/file-display.js` alongside the
// bucket-detection helpers that consume them; they're imported by
// name from the same drop-zone boot path.

// Generic bundle glyph — a 3D box / package outline. Stroke-based
// (uses `currentColor`) rather than the filled `.file-icon.brand-*`
// stickers that mark report buckets, so bundles read as a distinct
// kind of artifact in the same column. Authored at 14px to match
// the sidebar's row icons; the drop-zone supported list scales it
// up to 20px in CSS.
export const BUNDLE_ICON_SVG = '<svg class="file-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2 2 5v6l6 3 6-3V5L8 2Z"/><path d="M2 5l6 3 6-3"/><path d="M8 8v6"/></svg>'

// Workspace glyph — a labelled folder / tray. Same stroke treatment
// as `BUNDLE_ICON_SVG` so workspace rows in the sidebar read as a
// peer to bundle rows.
export const WORKSPACE_ICON_SVG = '<svg class="file-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="4" width="11" height="9" rx="1.2"/><path d="M6 4V3h4v1"/></svg>'
