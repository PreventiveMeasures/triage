import { forceLayout } from '../graph/utils.js'
import { tree } from '../graph/state.js'

// Layout passes for the v2 graph. The "Force" mode is the same
// Fruchterman-Reingold solver graph v1 uses (re-exported through
// ../graph/utils.js) so the two tabs paint the same node geometry
// when both are visible — no surprise on tab switch. "Radial" and
// "Grid" are package-aware variants the v2 design exposes through
// the topbar segmented control, but operating on real package
// labels instead of synthetic hue clusters: each package becomes a
// disk in the radial dial / a cell in the grid, with its files
// jittered inside.
//
// All three write directly into n.x / n.y on the passed nodes (no
// allocation), so a layout switch is cheap. The canvas's ResizeObserver
// passes the actual canvas dimensions, ensuring the layout matches
// the viewport instead of an arbitrary unit square.

export function layoutForce(graph, w, h) {
  const nodes = forceLayout(graph.files, graph.importsOf, w, h)
  const idx = new Map(nodes.map((n) => [n.file, n]))
  for (const n of graph.nodes) {
    const sol = idx.get(n.file)
    if (sol) { n.x = sol.x; n.y = sol.y }
  }
}

// Stable per-string hash — used as a seed for jitter so a given
// graph always paints the same way across reloads (otherwise small
// graphs visibly reshuffle on each render and the user can't build
// muscle memory for "where's that file?").
function hash(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0
  return h
}

export function layoutRadial(graph, w, h) {
  const cx = w / 2, cy = h / 2
  const radius = Math.min(w, h) * 0.38
  // Each package gets an angular slice on a ring; files within a
  // package jitter inside a small disk centered on that slice. Slice
  // ordering is by package size descending (graph.packages already
  // ordered) so the visual emphasis tracks the data emphasis.
  const N = graph.packages.length
  const pkgIdx = new Map(graph.packages.map((p, i) => [p, i]))
  const pad = 32
  const innerW = w - pad * 2, innerH = h - pad * 2
  const r = Math.min(innerW, innerH) * 0.42
  const groupR = Math.max(40, r * 0.18 / Math.sqrt(Math.max(1, N)))
  for (const n of graph.nodes) {
    const i = pkgIdx.get(n.pkg) ?? 0
    const angle = (i / Math.max(1, N)) * Math.PI * 2
    const gx = cx + Math.cos(angle) * r
    const gy = cy + Math.sin(angle) * r
    const h1 = hash(n.file)
    const ja = (h1 % 1000) / 1000 * Math.PI * 2
    const jr = ((h1 >> 10) % 1000) / 1000 * groupR
    n.x = gx + Math.cos(ja) * jr
    n.y = gy + Math.sin(ja) * jr
  }
}

export function layoutGrid(graph, w, h) {
  const N = graph.packages.length || 1
  const cols = Math.max(1, Math.ceil(Math.sqrt(N * w / Math.max(1, h))))
  const rows = Math.max(1, Math.ceil(N / cols))
  const cellW = w / cols
  const cellH = h / rows
  const pkgIdx = new Map(graph.packages.map((p, i) => [p, i]))
  const groupR = Math.min(cellW, cellH) * 0.36
  for (const n of graph.nodes) {
    const i = pkgIdx.get(n.pkg) ?? 0
    const cx = (i % cols) * cellW + cellW / 2
    const cy = Math.floor(i / cols) * cellH + cellH / 2
    const h1 = hash(n.file)
    const ja = (h1 % 1000) / 1000 * Math.PI * 2
    const jr = ((h1 >> 10) % 1000) / 1000 * groupR
    n.x = cx + Math.cos(ja) * jr
    n.y = cy + Math.sin(ja) * jr
  }
}

// "Classic" — borrow graph v1's positions verbatim when available
// so switching from the Graph tab to Graph v2 shows the same
// arrangement of nodes the user just got used to. When v1 hasn't
// run yet (no cache, or its cache is for a different file set),
// fall back to running forceLayout with v1's default canvas
// dimensions so the proportions still match what v1 would draw.
//
// v1's positions live in tree.layoutCache.nodes (an array of
// { file, x, y, dx, dy } objects from forceLayout()), keyed
// alongside the source treeData and the showAll flag the cache
// was built under. Both tabs now share tree.showAll, and the
// dataset is one tree per loaded report, so when the cache is
// present its positions correspond to the same files v2 is
// rendering. v2's own fitToView will rescale them into v2's
// (smaller) viewport so the visual lands the same regardless
// of which canvas's pixels the positions were originally in.
export function layoutClassic(graph) {
  const cache = tree.layoutCache
  if (cache?.nodes && cache.tree) {
    const idx = new Map(cache.nodes.map((n) => [n.file, n]))
    let copied = 0
    for (const n of graph.nodes) {
      const src = idx.get(n.file)
      if (src) { n.x = src.x; n.y = src.y; copied++ }
    }
    // 80% threshold — accept the cached positions if a strong
    // majority of v2's nodes have a v1 anchor. The tail (<20%)
    // gets seeded around the centroid of the matched ones so a
    // missing anchor doesn't dump its node at (0,0). Falls back
    // to a fresh layout when too few matched (e.g. the showAll
    // flag flipped between v1's last run and now and v1's cache
    // happens to be from the other file set).
    if (copied >= graph.nodes.length * 0.8) {
      if (copied < graph.nodes.length) seedUnmatched(graph)
      return
    }
  }
  // Fallback — same algorithm v1 uses, sized to v1's canvas
  // defaults (1100×760, the values forceLayout() falls back to
  // when called with 0,0). v2's fitToView will rescale.
  layoutForce(graph, 1100, 760)
}

// Small helper: when a few nodes lacked a v1 anchor (rare —
// the cache and v2's file set should match by construction),
// scatter the orphans in a small disk around the centroid of
// the matched ones rather than leaving them at (0,0) where
// they'd pile up off-screen.
function seedUnmatched(graph) {
  let cx = 0, cy = 0, n = 0
  for (const node of graph.nodes) {
    if (node.x !== 0 || node.y !== 0) { cx += node.x; cy += node.y; n++ }
  }
  if (n === 0) return
  cx /= n; cy /= n
  for (const node of graph.nodes) {
    if (node.x === 0 && node.y === 0) {
      const h = hash(node.file)
      const a = (h % 1000) / 1000 * Math.PI * 2
      const r = 30 + ((h >> 10) % 40)
      node.x = cx + Math.cos(a) * r
      node.y = cy + Math.sin(a) * r
    }
  }
}

export function applyLayout(mode, graph, w, h) {
  if (mode === 'classic') layoutClassic(graph)
  else if (mode === 'radial') layoutRadial(graph, w, h)
  else if (mode === 'grid') layoutGrid(graph, w, h)
  else layoutForce(graph, w, h)
}
