import { depsDirName, isModule } from '../format.js'
import { graphTheme } from './colors.js'

// Group key for clustering and coloring graph nodes: files inside the active
// deps dir (`node_modules/<pkg>/` by default, see `configureDepsDir` in
// format.js) group by package name, own source under `__own__`.
export function packageOf(file) {
  if (!file) return null
  const m = file.match(new RegExp(`^(?:.*/)?${depsDirName()}/(@[^/]+/[^/]+|[^/]+)`, 'u'))
  return m ? m[1] : '__own__'
}

// Snapshot the report's active dependency-directory classifier before handing
// data to the lazy graph bundle. Bundle graphs provide their own file ownership.
export function reportOwnSourceFiles(files) {
  return new Set(files.filter(file => !isModule(file)))
}

// Tableau 20, adjusted for legibility and ordered for maximum hue distance
// between adjacent indices, so even 3-4 packages get distinct colors. The two
// palettes share their hue order, so a package keeps its color across themes;
// the light one is darker and more saturated to read on a light canvas.
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
  '#5cd1e5', // cyan
  '#f1ce63', // gold
  '#d37295', // rose
  '#a0cbe8', // light blue
  '#86bcb6', // sage
  '#8cd17d', // light green
  '#b6992d', // dark gold
  '#499894', // dark teal
  '#e15759', // crimson (repeats red, far from it in the order)
  '#e879c7', // magenta
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
  '#0891b2', // cyan
  '#a07a14', // gold
  '#c14e8e', // rose
  '#1f7ad0', // light blue → deeper
  '#549b94', // sage
  '#3fb95f', // light green
  '#a07a14', // dark gold (matches gold)
  '#2a8278', // dark teal
  '#cb2c40', // crimson
  '#c026d3', // magenta
  '#965f93', // lavender
]
const palette = () => graphTheme() === 'dark' ? PKG_PALETTE_DARK : PKG_PALETTE_LIGHT
// Keyed by palette too: a theme switch looks up under the other one.
const _pkgColorCache = new Map()
// The palette's colors in their order, for groups told apart by rank: the
// first few are as far apart as it has.
export function paletteColor(index) {
  const colors = palette()
  return colors[index % colors.length]
}

// A fill for what spans several of them.
export const mixedColor = () => graphTheme() === 'dark' ? '#6e7681' : '#8c959f'

export function pkgColor(pkg) {
  const colors = palette()
  const key = pkg ?? '__own__'
  const cacheKey = `${colors === PKG_PALETTE_LIGHT ? 'l' : 'd'}:${key}`
  if (_pkgColorCache.has(cacheKey)) return _pkgColorCache.get(cacheKey)
  let h = 0
  for (const c of key) h = (h * 37 + c.codePointAt(0)) | 0
  // Interleave the hash's index so sequential packages get distant hues.
  const color = colors[((((h % colors.length) + colors.length) % colors.length) * 7 + 3) % colors.length]
  _pkgColorCache.set(cacheKey, color)
  return color
}
