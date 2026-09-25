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

// Layout glyphs; graph is also used by the findings view selector.
export const GRAPH_ICON_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="m4.5 4.5 7 2-5 5z"/><circle cx="4.5" cy="4.5" r="2" fill="currentColor"/><circle cx="11.5" cy="6.5" r="2" fill="currentColor"/><circle cx="6.5" cy="11.5" r="2" fill="currentColor"/></svg>'
export const LAYERS_ICON_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="1" y="1.5" width="14" height="3" rx=".5"/><rect x="1" y="6.5" width="8" height="3" rx=".5"/><rect x="11" y="6.5" width="4" height="3" rx=".5"/><rect x="1" y="11.5" width="4" height="3" rx=".5"/><rect x="7" y="11.5" width="8" height="3" rx=".5"/></svg>'
export const MATRIX_ICON_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M1 1h4v4H1zm5 5h4v4H6zm5 5h4v4h-4z"/><path d="M6 1h4v4H6zm5 0h4v4h-4zM1 6h4v4H1zm10 0h4v4h-4zM1 11h4v4H1zm5 0h4v4H6z" opacity=".35"/></svg>'
export const DEPENDENCIES_ICON_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="2.5" r="1.5" fill="currentColor"/><circle cx="3" cy="13" r="1.5" fill="currentColor"/><circle cx="8" cy="13" r="1.5" fill="currentColor"/><circle cx="13" cy="13" r="1.5" fill="currentColor"/><path d="M8 4v3M8 7H3m5 0h5M3 7v4M8 7v4M13 7v4"/></svg>'

// Manage glyph shared by the sidebar action and the managed landing button.
export const MANAGE_ICON_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>'

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

// Scan and report glyphs shared by setup, management, and landing actions.
export const SCAN_ICON_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 1.5H2.5a1 1 0 0 0-1 1V5m9.5-3.5h2.5a1 1 0 0 1 1 1V5M1.5 11v2.5a1 1 0 0 0 1 1H5m6 0h2.5a1 1 0 0 0 1-1V11"/><circle cx="7.25" cy="7.25" r="2.75"/><path d="m9.25 9.25 2.25 2.25"/></svg>'
export const REPORT_ICON_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5L9 1.5ZM9 1.5v4h4M5.5 8h5m-5 3h3.5"/></svg>'
export const CODE_ICON_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4.5 4.5-3 3.5 3 3.5m7-7 3 3.5-3 3.5M9.5 2l-3 12"/></svg>'
export const AGENTIC_ICON_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6.5 3.5 1.6 3.9L12 9l-3.9 1.6-1.6 3.9-1.6-3.9L1 9l3.9-1.6 1.6-3.9ZM12 1.5v4m-2-2h4"/></svg>'
