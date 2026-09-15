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

// Claude mark shared by report stickers and the Claude Code action.
// Coordinates match the existing sticker; standalone icons crop to the mark.
export const CLAUDE_MARK_PATH = 'm5.875 10.154 1.376-.772.023-.067-.023-.037h-.067l-.23-.015-.787-.02-.681-.03-.661-.035-.166-.035-.156-.205.016-.103.14-.094.2.018.442.03.665.046.481.028.714.075h.113l.016-.047-.039-.028-.03-.028-.687-.466-.744-.492-.39-.284-.21-.143-.106-.135-.046-.294.19-.21.258.017.065.018.26.2.557.43.726.535.106.089.042-.03.006-.022-.048-.08-.395-.713-.422-.726-.187-.301-.05-.18a1 1 0 0 1-.03-.213l.218-.296.12-.039.29.039.123.106.18.413.293.65.453.884.133.262.07.242.027.075h.046v-.043l.038-.497.069-.611.067-.787.023-.221.11-.266.218-.143.17.081.14.2-.02.13-.083.54-.163.846-.106.567h.062l.07-.07.287-.382.482-.602.213-.239.248-.264.159-.125h.301l.221.329-.099.34-.31.393-.256.333-.369.496-.23.397.021.032.055-.006.832-.177.45-.081.537-.092.243.113.026.115-.096.236-.573.141-.673.135-1.003.237-.012.01.014.017.452.042.193.01h.473l.88.066.23.153.138.186-.023.141-.354.181-.478-.113-1.116-.266-.383-.096h-.053v.032l.32.312.584.528.731.68.037.168-.094.133-.099-.014-.643-.484-.248-.218-.561-.472H9.08v.05l.129.189.684 1.027.035.315-.05.103-.177.062-.194-.036-.4-.561-.413-.632-.333-.567-.041.023-.197 2.116-.092.108-.212.082-.177-.135-.094-.218.094-.43.113-.561.092-.447.083-.554.05-.184-.004-.013-.04.006-.418.574-.636.858-.503.539-.12.048-.21-.108.02-.193.117-.172.696-.886.42-.549.27-.317-.001-.046h-.016l-1.85 1.201-.328.042-.142-.132.018-.218.067-.071.556-.383Z'

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

// Links-file glyph — two interlocking chain links, the picture of the
// one thing the file does: hold two findings together. Same stroke
// treatment as the bundle / workspace glyphs above, which is also the
// point — a links file is a different KIND of artifact from a report,
// and the branded report "stickers" in `view/file-display.js` are
// filled sheets, so the two never read as the same thing in the
// sidebar's single column.
//
// Distinct from the workspace row's own chain button
// (`WORKSPACE_SHARE_ICON` in sidebar.js), which is a small
// hover-revealed action at 11px: this is a 14px row identity.
export const LINKS_ICON_SVG = '<svg class="file-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.67 8.67a3.33 3.33 0 0 0 5.03.36l2-2a3.33 3.33 0 0 0-4.71-4.71l-1.15 1.14"/><path d="M9.33 7.33a3.33 3.33 0 0 0-5.03-.36l-2 2a3.33 3.33 0 0 0 4.71 4.71l1.14-1.14"/></svg>'
