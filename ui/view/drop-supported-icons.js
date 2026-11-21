// Hydrate the drop zone's supported-formats list: index.html's empty
// `<span class="drop-supported-icon" data-icon="…">` placeholders get the
// glyphs the sidebar rows draw (the report stickers and links glyph of
// file-display.js, the bundle / workspace glyphs of icons.js), once at boot.
// Stasis has its own logo in index.html.
import { render } from 'lit'
import { FILE_ICONS } from './file-display.js'
import { BUNDLE_ICON_SVG, GITHUB_ICON_SVG, WORKSPACE_ICON_SVG } from './icons.js'
import { sourceFileIcon, sourcePackageIcon } from './source-file-icon.js'
import { trustedHTML } from './trusted-types.js'

// `data-icon` → raw SVG. Sourcemaps keep the generic bundle glyph.
const ICONS = {
  ...FILE_ICONS,
  'bundle': BUNDLE_ICON_SVG,
  'workspace': WORKSPACE_ICON_SVG,
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
