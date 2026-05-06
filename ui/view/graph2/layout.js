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

// "Spiral" — the hue-spiral projection from the original
// graph_v2.html design. Each package sits at a unique angle on
// the canvas (golden-angle distribution, so even N=2..3 packages
// land on far-apart angles and the layout reads as a clean fan
// rather than a clump), at a pseudo-random radius from the
// center. The radius scatter is what gives the layout its
// "spiral" feel — without it, all packages would sit on a single
// ring (which is the "Radial" mode). Files within a package
// cluster in a small disk around the package center; hubs sit
// closer to the center than members so the fan reads as
// "package = pile of files, anchored by a hub".
//
// In the synthetic-data design, groups carried a real hue
// attribute and the angle = hue. Real packages here don't have
// an inherent hue (pkgColor() picks from a hashed palette), so
// we use the index-times-golden-angle trick: same visual
// effect (maximally distinct angles), no need to back-compute a
// hue from the assigned color. The 31-multiplier on the band
// breaks any visual correlation between angle and radius so the
// layout doesn't degenerate into a tight ring at certain N.
export function layoutSpiral(graph, w, h) {
  const cx = w / 2, cy = h / 2
  // Work in the design's unit space (where 1.0 = half-canvas)
  // so the magic numbers below port over directly. Scaling to
  // pixels happens once per coordinate at write time.
  const unitToPx = Math.min(w, h) / 2
  const N = graph.packages.length
  const pkgInfo = new Map()
  for (let i = 0; i < N; i++) {
    const pkg = graph.packages[i]
    // Golden-angle distribution of package centers around the
    // canvas; matches the design's `g.hue * π/180` step (since
    // each group's hue was itself i * 137.508° mod 360°).
    const angle = ((i * 137.508) % 360) * Math.PI / 180
    // Pseudo-random radius band in [0.30, 0.95] half-canvas
    // units — same magic constants the design uses. The
    // 31-multiplier is coprime with 100 so the band cycles
    // through 100 distinct values, breaking any correlation
    // between angle and radius that would collapse the
    // layout into a ring.
    const band = ((i * 31) % 100) / 100
    const rUnit = N === 1 ? 0 : 0.30 + band * 0.65
    pkgInfo.set(pkg, {
      x: cx + Math.cos(angle) * rUnit * unitToPx,
      y: cy + Math.sin(angle) * rUnit * unitToPx,
      size: graph.pkgCount.get(pkg) ?? 0,
    })
  }
  for (const n of graph.nodes) {
    const info = pkgInfo.get(n.pkg)
    if (!info) continue
    // Per-group disk radius in unit space, ported from the
    // design: a tiny constant + sqrt-scaled bonus for size.
    // Keeping this small (typical 0.014–0.025 unit ≈ 4-8px on
    // a 600px-wide canvas) is what makes the spiral structure
    // legible — bigger disks would overlap with neighbors and
    // collapse the visualization into a blob, which is what
    // happened with the previous 0.04 base.
    const groupR = (0.012 + Math.sqrt(info.size) * 0.004) * unitToPx
    const h1 = hash(n.file)
    // Different bit ranges for angle vs radius — without this
    // the two correlate and the cluster looks like a comma
    // instead of a disk.
    const localA = (h1 % 10000) / 10000 * Math.PI * 2
    const localBand = ((h1 >>> 16) % 10000) / 10000
    const localR = n.isHub
      ? localBand * groupR * 0.3
      : (0.4 + localBand * 0.6) * groupR
    n.x = info.x + Math.cos(localA) * localR
    n.y = info.y + Math.sin(localA) * localR
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
  else if (mode === 'force') layoutForce(graph, w, h)
  else layoutSpiral(graph, w, h)
}
