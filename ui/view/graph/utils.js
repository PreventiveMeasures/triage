import { depsDirName } from '../format.js'

// Graph-flavored utilities. `treeAnchor` /
// `computeFindingCountsByFile` / `computeTransitiveCounts` /
// `fileHasFindings` / `totalFindings` moved to
// `view/file-counts.js` (they're consumed by the Files tab and
// graph data prep, not by graph-internal rendering — so they
// don't belong under `graph/`). `forceLayout` lives in
// `./force-layout.js` next to canvas.js for the same reason.

// Group key for clustering + coloring nodes in the graph. Files
// inside the active deps dir (`node_modules/<pkg>/` by default;
// `dependencies/<pkg>/` when the project doesn't ship a node_modules
// — see `configureDepsDir` in format.js) group by package name. Own
// source (anything outside that dir) groups by top-level directory —
// so `src/...` files all share a color, `playground/...` files share
// another. Files at the repo root cluster under '/' (rare).
export function packageOf(file) {
  if (!file) return null
  const re = depsDirName() === 'node_modules'
    ? /^(?:.*\/)?node_modules\/(@[^/]+\/[^/]+|[^/]+)/u
    : /^(?:.*\/)?dependencies\/(@[^/]+\/[^/]+|[^/]+)/u
  const m = file.match(re)
  if (m) return m[1]
  const slash = file.indexOf('/')
  return slash > 0 ? file.slice(0, slash) : '/'
}

// ── Vivid per-package color palette ─────────────────────────────────────────
// Each package gets a vivid, high-saturation hue so clusters read distinctly.
// Curated flat palette — 20 perceptually distinct colors. Drawn from
// Tableau 20 + adjusted for UI legibility. Ordered so adjacent indices
// have maximum hue distance (not sequential), meaning even small
// graphs with 3-4 packages get very distinct colors.
//
// Two parallel palettes — same hue order, different lightness, so a
// package keeps its identity (a "blue package" stays blue) when the
// user toggles between dark and light themes; only the saturation /
// lightness shifts. The dark palette stays bright and pastel so it
// reads on the near-black canvas backdrop; the light palette pulls
// every color toward GitHub-primary saturated tones so it doesn't
// wash out against #f6f8fa. Several of the dark variants (the pinks,
// pale blues, light grays, sage greens) drop ~25-30 lightness in the
// light variant — they were the worst offenders for "I can barely
// see the node" on a light bg.
const PKG_PALETTE_DARK = [
  '#4e9af1', // blue
  '#f28e2b', // orange
  '#59a14f', // green
  '#e15759', // red
  '#76b7b2', // teal
  '#edc948', // yellow
  '#b07aa1', // purple
  '#ff9da7', // pink
  '#9c755f', // brown
  '#5cd1e5', // cyan (was '#bab0ac' gray — read as a "missing" color)
  '#f1ce63', // gold
  '#d37295', // rose
  '#a0cbe8', // light blue
  '#86bcb6', // sage
  '#8cd17d', // light green
  '#b6992d', // dark gold
  '#499894', // dark teal
  '#e15759', // crimson (intentional near-repeat — far enough in ordering)
  '#e879c7', // magenta (was '#79706e' warm gray)
  '#d4a6c8', // lavender
]
const PKG_PALETTE_LIGHT = [
  '#2f8aef', // blue
  '#d2691e', // orange
  '#2ea043', // green
  '#e63946', // red
  '#2e9a92', // teal
  '#b88817', // yellow
  '#9560e8', // purple
  '#d24a9c', // pink → magenta
  '#8a5d40', // brown
  '#0891b2', // cyan (was '#6e7781' gray)
  '#a07a14', // gold
  '#c14e8e', // rose
  '#1f7ad0', // light blue → deeper
  '#549b94', // sage
  '#3fb95f', // light green
  '#a07a14', // dark gold (matches gold)
  '#2a8278', // dark teal
  '#cb2c40', // crimson
  '#c026d3', // magenta (was '#52504e' warm gray)
  '#965f93', // lavender
]
function isLightTheme() {
  // "Light" for the canvas's purposes means the light G2_THEMES
  // palette (light backdrop, dark text). theme-light and theme-pink
  // both qualify; theme-green and the default dark theme use the
  // dark palette. Mirrors the predicate in view/graph/canvas.js.
  if (typeof document === 'undefined') return false
  const c = document.body?.classList
  return !!c && (c.contains('theme-light') || c.contains('theme-pink'))
}
// Cache is keyed by `${theme}:${pkg}` so the dark + light variants
// don't collide. Toggling the theme doesn't invalidate the cache — we
// just look up under the new prefix on the next call. Old entries
// stay around but they're tiny and the package-name set is bounded.
const _pkgColorCache = new Map()
export function pkgColor(pkg) {
  const palette = isLightTheme() ? PKG_PALETTE_LIGHT : PKG_PALETTE_DARK
  const themeKey = palette === PKG_PALETTE_LIGHT ? 'l' : 'd'
  const cacheKey = `${themeKey}:${pkg ?? '__own__'}`
  if (_pkgColorCache.has(cacheKey)) return _pkgColorCache.get(cacheKey)
  const key = pkg ?? '__own__'
  let h = 0
  for (const c of key) h = (h * 37 + c.codePointAt(0)) | 0
  // Spread indices: interleave halves so sequential packages get distant hues
  const raw = ((h % palette.length) + palette.length) % palette.length
  const idx = (raw * 7 + 3) % palette.length
  const col = palette[idx]
  _pkgColorCache.set(cacheKey, col)
  return col
}
