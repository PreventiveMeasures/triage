// Highest-to-lowest iteration order — see SEVERITIES in ../format.js
// for the same list (kept duplicated here to avoid a circular import
// from a graph-only utility back up into format.js).
const SEVERITIES_ORDERED = ['critical', 'high', 'medium', 'low', 'high_bug', 'bug', 'informational']
// Empty per-file counts seed used by both computeFindingCountsByFile
// and computeTransitiveCounts so tier additions only have to land in
// SEVERITIES_ORDERED above.
const emptyCounts = () => Object.fromEntries(SEVERITIES_ORDERED.map((s) => [s, 0]))

// File path → in-page anchor id. Replaces every non-word char with an
// underscore so paths with `/` `.` `@` (node_modules / scoped packages)
// produce valid id attributes.
export function treeAnchor(file) {
  return 'tree-' + file.replace(/[^\w-]+/gu, '_')
}

// file → { critical, high, medium, low } finding-count map. Used by
// both the tree cards and the force-directed visualization to surface
// findings density per file at a glance. Counts INDIVIDUAL findings
// (not groups) so the numbers match the per-file stats a user would
// otherwise scan in the findings view.
export function computeFindingCountsByFile(allGroups) {
  const counts = new Map()
  for (const g of allGroups) {
    for (const f of g) {
      if (!counts.has(f.file)) counts.set(f.file, emptyCounts())
      const c = counts.get(f.file)
      if (c[f.severity] !== undefined) c[f.severity]++
    }
  }
  return counts
}

// Group key for clustering + coloring nodes in the graph. npm packages
// stay grouped by package name. Own source (anything outside
// node_modules) groups by top-level directory — so `src/...` files all
// share a color, `playground/...` files share another. Files at the
// repo root cluster under '/' (rare).
export function packageOf(file) {
  if (!file) return null
  const npm = file.match(/^(?:.*\/)?node_modules\/(@[^/]+\/[^/]+|[^/]+)/u)
  if (npm) return npm[1]
  const slash = file.indexOf('/')
  return slash > 0 ? file.slice(0, slash) : '/'
}

// transitive subtree finding counts: for each file, sum of own counts
// across every file reachable through its `imports` (recursively),
// excluding the file itself. Cycles handled by a visited set.
export function computeTransitiveCounts(tree, ownCounts) {
  const transitive = new Map()
  for (const file of Object.keys(tree)) {
    const visited = new Set()
    const stack = [...((tree[file].imports ?? []).filter((i) => tree[i]))]
    while (stack.length > 0) {
      const dep = stack.pop()
      if (visited.has(dep)) continue
      visited.add(dep)
      for (const next of (tree[dep]?.imports ?? [])) if (tree[next]) stack.push(next)
    }
    const sum = emptyCounts()
    for (const f of visited) {
      const c = ownCounts.get(f)
      if (c) for (const k of SEVERITIES_ORDERED) sum[k] += c[k] ?? 0
    }
    transitive.set(file, sum)
  }
  return transitive
}

// Has-issues predicate: own findings OR something in its subtree has
// findings. Used to filter out clean files when graph2.showAll is off.
export function fileHasFindings(file, ownCounts, transitiveCounts) {
  const own = ownCounts.get(file)
  const tr = transitiveCounts.get(file)
  return totalFindings(own) > 0 || totalFindings(tr) > 0
}

// Fruchterman-Reingold force-directed layout.
// Width/height are passed in from the actual canvas size at layout time,
// so the initial seeding and spring constants match the real viewport.
export function forceLayout(files, importsOf, layoutW, layoutH) {
  const N = files.length
  const width = layoutW || 1100, height = layoutH || 760
  // k is the "ideal edge length" — larger canvas → more spread
  const k = Math.sqrt((width * height) / Math.max(N, 1)) * 1.1

  const seed = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h }

  // Seed nodes on a grid + jitter rather than a circle — grid seeds
  // produce fewer initial edge crossings than a ring and converge faster.
  const cols = Math.ceil(Math.sqrt(N * width / height))
  const rows = Math.ceil(N / cols)
  const cellW = width / (cols + 1), cellH = height / (rows + 1)
  const nodes = files.map((file, i) => {
    const col = i % cols, row = Math.floor(i / cols)
    const h = seed(file)
    return {
      file,
      x: (col + 1) * cellW + ((h % 100) - 50) * cellW * 0.4,
      y: (row + 1) * cellH + (((h >> 7) % 100) - 50) * cellH * 0.4,
      dx: 0, dy: 0,
    }
  })
  const idx = new Map(nodes.map((n, i) => [n.file, i]))

  const edges = []
  for (const f of files) {
    for (const imp of importsOf.get(f) ?? []) {
      if (idx.has(imp)) edges.push([idx.get(f), idx.get(imp)])
    }
  }

  // Group by package for centroid pull.
  const byPkg = new Map()
  for (let i = 0; i < N; i++) {
    const p = packageOf(nodes[i].file) ?? '__own__'
    if (!byPkg.has(p)) byPkg.set(p, [])
    byPkg.get(p).push(i)
  }

  // More iterations for larger graphs; fewer for tiny ones.
  const iterations = Math.min(500, Math.max(180, 100 + N * 3))
  const tempInit = Math.min(width, height) / 6
  const tempFinal = 0.3

  for (let iter = 0; iter < iterations; iter++) {
    const t = tempInit * Math.pow(tempFinal / tempInit, iter / iterations)
    for (const n of nodes) { n.dx = 0; n.dy = 0 }

    // Repulsion — every pair (Coulomb-like).
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const a = nodes[i], b = nodes[j]
        let dx = a.x - b.x, dy = a.y - b.y
        let dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < 0.01) {
          const h = seed(a.file + b.file)
          dx = ((h % 100) - 50) * 0.01 || 0.5
          dy = (((h >> 7) % 100) - 50) * 0.01 || 0.5
          dist = Math.sqrt(dx * dx + dy * dy)
        }
        const force = (k * k) / dist
        a.dx += (dx / dist) * force; a.dy += (dy / dist) * force
        b.dx -= (dx / dist) * force; b.dy -= (dy / dist) * force
      }
    }

    // Attraction along edges.
    for (const [i, j] of edges) {
      const a = nodes[i], b = nodes[j]
      const dx = a.x - b.x, dy = a.y - b.y
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01
      const force = (dist * dist) / k
      a.dx -= (dx / dist) * force; a.dy -= (dy / dist) * force
      b.dx += (dx / dist) * force; b.dy += (dy / dist) * force
    }

    // Package centroid pull — stronger early (helps cluster formation),
    // fades as temperature drops so structural forces dominate later.
    const clusterStrength = 0.055 * Math.min(1, t / (tempInit * 0.3))
    for (const [, indices] of byPkg) {
      if (indices.length < 2) continue
      let cx = 0, cy = 0
      for (const i of indices) { cx += nodes[i].x; cy += nodes[i].y }
      cx /= indices.length; cy /= indices.length
      for (const i of indices) {
        nodes[i].dx += (cx - nodes[i].x) * clusterStrength
        nodes[i].dy += (cy - nodes[i].y) * clusterStrength
      }
    }

    // Apply with cooling + margin clamp.
    const margin = 50
    for (const n of nodes) {
      const disp = Math.sqrt(n.dx * n.dx + n.dy * n.dy) || 0.01
      n.x += (n.dx / disp) * Math.min(disp, t)
      n.y += (n.dy / disp) * Math.min(disp, t)
      n.x = Math.max(margin, Math.min(width - margin, n.x))
      n.y = Math.max(margin, Math.min(height - margin, n.y))
    }
  }

  return nodes
}

export function totalFindings(counts) {
  if (!counts) return 0
  let total = 0
  for (const k of SEVERITIES_ORDERED) total += counts[k] ?? 0
  return total
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
  return typeof document !== 'undefined' && document.body?.classList.contains('theme-light')
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
  for (const c of key) h = (h * 37 + c.charCodeAt(0)) | 0
  // Spread indices: interleave halves so sequential packages get distant hues
  const raw = ((h % palette.length) + palette.length) % palette.length
  const idx = (raw * 7 + 3) % palette.length
  const col = palette[idx]
  _pkgColorCache.set(cacheKey, col)
  return col
}
