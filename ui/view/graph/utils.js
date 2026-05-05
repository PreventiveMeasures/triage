// Severity palette. Mirrors the CSS --critical / --high / --medium /
// --low / --info vars used by the badges + count chips, so the canvas
// node indicators visually match the per-finding badges. `informational`
// gets the same blue tone as the CSS --info dark default. Update both
// at once when tuning a tier's color.
export const SEV_COLORS = {
  critical: '#f85149',
  high: '#f0883e',
  medium: '#d29922',
  low: '#8b949e',
  informational: '#218bff',
}
// Highest-to-lowest iteration order — see SEVERITIES in ../format.js
// for the same list (kept duplicated here to avoid a circular import
// from a graph-only utility back up into format.js).
const SEVERITIES_ORDERED = ['critical', 'high', 'medium', 'low', 'informational']
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

// Short, distinguishing label for a node. Last two path segments —
// `lib/foo.js` from `src/lib/foo.js`, `queue/index.mjs` from
// `node_modules/@chalker/queue/index.mjs`. Full path is always
// available via the node's `<title>` tooltip and the linked card.
export function svgNodeLabel(file, maxLen = 22) {
  const parts = file.split('/')
  const tail = parts.slice(-2).join('/')
  return tail.length <= maxLen ? tail : '…' + tail.slice(-(maxLen - 1))
}

// Sanitize file path → SVG-safe id. Used to cross-reference nodes and
// edges from the post-render hover-highlight wiring.
export function svgNodeId(file) { return 'tn-' + file.replace(/[^\w-]+/gu, '_') }

// Numeric sort with a stable tiebreak — used by the barycenter passes
// in svg.js, where ties on the computed mean would otherwise depend on
// unstable browser sort behavior.
export function byBary(bary) {
  return (a, b) => (bary.get(a) - bary.get(b)) || a.localeCompare(b)
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

// Wrap a long basename across at most two lines. Splits at the last
// hyphen / underscore that keeps both halves under `maxLine`. If no
// suitable split exists, truncates with a trailing ellipsis. Returns
// an array of 1-2 strings ready to render as <text>/<tspan>.
export function multiLineLabel(file, maxLine = 18) {
  const base = file.split('/').pop() ?? file
  if (base.length <= maxLine) return [base]
  const seps = []
  for (let i = 0; i < base.length; i++) if (base[i] === '-' || base[i] === '_') seps.push(i)
  if (seps.length === 0) return [base.slice(0, maxLine - 1) + '…']
  // Pick the split point closest to the middle that keeps both halves
  // within maxLine. Falls back to the most-balanced of any choice if
  // none fits cleanly (still better than mid-token truncation).
  const mid = base.length / 2
  let best = null
  for (const s of seps) {
    const a = s + 1, b = base.length - s - 1
    if (a > maxLine || b > maxLine) continue
    const score = Math.abs(s - mid)
    if (!best || score < best.score) best = { s, score }
  }
  if (!best) {
    // No clean split — pick the split with smallest max(a, b) and let
    // the longer side wrap visually rather than truncate the basename.
    for (const s of seps) {
      const max = Math.max(s + 1, base.length - s - 1)
      if (!best || max < best.max) best = { s, max }
    }
  }
  return [base.slice(0, best.s + 1), base.slice(best.s + 1)]
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
// findings. Used to filter out clean files when `tree.showAll` is off.
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
export function indicatorFor(counts) {
  if (!counts) return null
  for (const sev of SEVERITIES_ORDERED) {
    if (counts[sev] > 0) return SEV_COLORS[sev]
  }
  return null
}

// ── Vivid per-package color palette ─────────────────────────────────────────
// Each package gets a vivid, high-saturation hue so clusters read distinctly.
// Curated flat palette — 20 perceptually distinct colors optimized for
// dark backgrounds. Drawn from Tableau 20 + adjusted for dark-UI legibility.
// Ordered so adjacent indices have maximum hue distance (not sequential),
// meaning even small graphs with 3-4 packages get very distinct colors.
const PKG_PALETTE = [
  '#4e9af1', // blue
  '#f28e2b', // orange
  '#59a14f', // green
  '#e15759', // red
  '#76b7b2', // teal
  '#edc948', // yellow
  '#b07aa1', // purple
  '#ff9da7', // pink
  '#9c755f', // brown
  '#bab0ac', // gray
  '#f1ce63', // gold
  '#d37295', // rose
  '#a0cbe8', // light blue
  '#86bcb6', // sage
  '#8cd17d', // light green
  '#b6992d', // dark gold
  '#499894', // dark teal
  '#e15759', // crimson (intentional near-repeat — far enough in ordering)
  '#79706e', // warm gray
  '#d4a6c8', // lavender
]
const _pkgColorCache = new Map()
export function pkgColor(pkg) {
  if (_pkgColorCache.has(pkg)) return _pkgColorCache.get(pkg)
  const key = pkg ?? '__own__'
  let h = 0
  for (const c of key) h = (h * 37 + c.charCodeAt(0)) | 0
  // Spread indices: interleave halves so sequential packages get distant hues
  const raw = ((h % PKG_PALETTE.length) + PKG_PALETTE.length) % PKG_PALETTE.length
  const idx = (raw * 7 + 3) % PKG_PALETTE.length
  const col = PKG_PALETTE[idx]
  _pkgColorCache.set(pkg, col)
  return col
}
export function pkgColorAlpha(pkg, a) {
  const col = pkgColor(pkg)
  const r = parseInt(col.slice(1, 3), 16)
  const g = parseInt(col.slice(3, 5), 16)
  const b = parseInt(col.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${a})`
}

// Radius formula: much wider range so hubs really stand out.
export function radiusOfNode(file, importsOf, importedBy, ownCounts, transitiveCounts) {
  const conn = (importsOf.get(file)?.length ?? 0) + (importedBy.get(file)?.length ?? 0)
  const findings = totalFindings(ownCounts.get(file)) + totalFindings(transitiveCounts.get(file)) * 0.2
  return Math.max(4, 4 + Math.pow(conn, 0.62) * 3.2 + Math.sqrt(findings) * 1.4)
}
