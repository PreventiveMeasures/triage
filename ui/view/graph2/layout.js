import { forceLayout } from '../graph/utils.js'

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

// "Classic" — run the same Fruchterman-Reingold solver graph v1
// uses, sized to v1's default canvas dimensions (1100×760, the
// values forceLayout() falls back to when called with 0,0). v2's
// fitToView rescales the result into the smaller v2 viewport,
// so the visual proportions match what v1 would draw without
// reaching into v1's state — Classic computes its own positions
// independently and won't drift when v1 re-layouts. The
// difference vs "force" is the canvas dimensions the solver runs
// in: "force" uses v2's actual viewport (so a wider stage means
// more horizontal spread), "classic" pins to v1's canonical
// 1100×760 for stable proportions regardless of where v2 is
// being rendered.
export function layoutClassic(graph) {
  layoutForce(graph, 1100, 760)
}

export function applyLayout(mode, graph, w, h) {
  if (mode === 'classic') layoutClassic(graph)
  else if (mode === 'radial') layoutRadial(graph, w, h)
  else if (mode === 'grid') layoutGrid(graph, w, h)
  else layoutForce(graph, w, h)
}
