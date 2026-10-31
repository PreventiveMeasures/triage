// Hydrate the supported-formats list on the empty drop-zone with
// the same SVG markup the sidebar uses for its row icons. Stasis
// uses its own logo directly in index.html, only on the landing page.
// `index.html` ships empty
// `<span class="drop-supported-icon" data-icon="…">` placeholders
// keyed by bucket name; this module looks each one up and writes
// the SVG via innerHTML. Single source of truth: report-bucket
// stickers from `view/file-display.js`, bundle + workspace glyphs
// from `view/icons.js` (both also feed the sidebar rows). Purely
// informational, so no Lit component — a one-shot DOM populate at
// boot is enough.

import { render } from 'lit'
import { FILE_ICONS } from './file-display.js'
import { BUNDLE_ICON_SVG, GITHUB_ICON_SVG, LINKS_ICON_SVG, WORKSPACE_ICON_SVG } from './icons.js'
import { sourceFileIcon, sourcePackageIcon } from './source-file-icon.js'
import { trustedHTML } from './trusted-types.js'

// `data-icon` value → raw SVG string. Sourcemaps keep the generic
// bundle glyph shared with the sidebar.
const ICONS = {
  'default': FILE_ICONS.default,
  'claude-security': FILE_ICONS['claude-security'],
  'codex-security': FILE_ICONS['codex-security'],
  'deepsec': FILE_ICONS.deepsec,
  'piolium': FILE_ICONS.piolium,
  'markdown-generic': FILE_ICONS['markdown-generic'],
  'bundle': BUNDLE_ICON_SVG,
  'workspace': WORKSPACE_ICON_SVG,
  'links': LINKS_ICON_SVG,
  'github': GITHUB_ICON_SVG,
}

// Lockfiles, by ecosystem: the Code tab tree's icon of a package of it, or,
// where it has none, of a file of its language (source-file-icon.js).
const LOCKFILE_ICONS = {
  'lockfile-npm': sourcePackageIcon('npm'),
  'lockfile-ruby': sourceFileIcon('Gemfile.lock'),
  'lockfile-python': sourceFileIcon('pyproject.py'),
  'lockfile-cargo': sourcePackageIcon('cargo'),
  'lockfile-composer': sourcePackageIcon('composer'),
  'lockfile-soldeer': sourcePackageIcon('soldeer'),
}

for (const el of document.querySelectorAll('.drop-supported-icon[data-icon]')) {
  const svg = ICONS[el.dataset.icon]
  if (svg) el.innerHTML = trustedHTML(svg)
  else if (Object.hasOwn(LOCKFILE_ICONS, el.dataset.icon)) render(LOCKFILE_ICONS[el.dataset.icon], el)
}
