// Hydrate the supported-formats list on the empty drop-zone with
// the SAME SVG markup the sidebar uses for its row icons. The
// list in `index.html` ships as a set of empty
// `<span class="drop-supported-icon" data-icon="…">` placeholders
// keyed by bucket name; on import this module looks each one up
// and writes the corresponding SVG string via innerHTML. Single
// source of truth: report-bucket stickers come from
// `view/file-display.js` (also used by the sidebar's file rows);
// bundle + workspace glyphs come from `view/icons.js` (also used
// by the sidebar's bundle / workspace rows). The supported list
// is purely informational, so it doesn't need to live in a Lit
// component — a one-shot DOM populate at boot is enough.

import { FILE_ICONS } from './file-display.js'
import { BUNDLE_ICON_SVG, WORKSPACE_ICON_SVG } from './icons.js'

// `data-icon` value → raw SVG string. Bundle keys
// (`stasis` / `sourcemap`) both map to the generic bundle glyph
// since the two formats share a row icon in the sidebar too.
const ICONS = {
  'default': FILE_ICONS.default,
  'claude-security': FILE_ICONS['claude-security'],
  'codex-security': FILE_ICONS['codex-security'],
  'deepsec': FILE_ICONS.deepsec,
  'bundle': BUNDLE_ICON_SVG,
  'workspace': WORKSPACE_ICON_SVG,
}

for (const el of document.querySelectorAll('.drop-supported-icon[data-icon]')) {
  const svg = ICONS[el.dataset.icon]
  if (svg) el.innerHTML = svg
}
