// Layout passes for the v2 graph. Three closed-form, package-aware
// algorithms operating on real package labels: each package becomes
// a disk in the spiral / a slice on the radial / a cell in the grid,
// with its files jittered inside. All three write directly into
// n.x / n.y on the passed nodes (no allocation), so a layout switch
// is cheap. The canvas's ResizeObserver passes the actual canvas
// dimensions, ensuring layouts match the viewport instead of an
// arbitrary unit square.
//
// An earlier version had a Fruchterman-Reingold "force" mode (and
// a "classic" variant pinned to graph v1's canvas size). Both got
// removed: the closed-form passes are an order of magnitude faster
// on large trees and produce a more legible result for this
// visualization's purpose (clusters by package, not minimum-cross
// edge layouts).

// Stable per-string hash — used as a seed for jitter so a given
// graph always paints the same way across reloads (otherwise small
// graphs visibly reshuffle on each render and the user can't build
// muscle memory for "where's that file?").
function hash(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0
  return h
}

// Cross-package degree per package — counts each cross-package
// edge once for each endpoint's package. Drives Spiral's
// "well-connected toward the center" radius bias: a package
// imported from many others reads as "core" and should sit
// where the eye lands first.
function crossDegByPkg(graph) {
  const map = new Map()
  for (const e of graph.edges) {
    if (!e.cross) continue
    const a = graph.nodeByFile.get(e.a)
    const b = graph.nodeByFile.get(e.b)
    if (a) map.set(a.pkg, (map.get(a.pkg) ?? 0) + 1)
    if (b) map.set(b.pkg, (map.get(b.pkg) ?? 0) + 1)
  }
  return map
}

// Distribute files inside a per-package disk, anchored on
// (info.x, info.y) at radius `groupR` (pixels). Hubs sit
// closer to the anchor than members so each cluster reads as
// "package = pile of files anchored by a hub". Pulled out of
// the per-layout loops since spiral / radial / grid all share
// the same intra-disk distribution; only the disk position
// differs across layouts.
function placeFilesInDisk(graph, pkgInfo) {
  for (const n of graph.nodes) {
    const info = pkgInfo.get(n.pkg)
    if (!info) continue
    const groupR = info.groupR
    const h1 = hash(n.file)
    // Different bit ranges for angle vs radius — without this
    // they correlate and the cluster looks like a comma instead
    // of a disk.
    const localA = (h1 % 10000) / 10000 * Math.PI * 2
    const localBand = ((h1 >>> 16) % 10000) / 10000
    const localR = n.isHub
      ? localBand * groupR * 0.3
      : (0.4 + localBand * 0.6) * groupR
    n.x = info.x + Math.cos(localA) * localR
    n.y = info.y + Math.sin(localA) * localR
  }
}

export function layoutRadial(graph, w, h) {
  const cx = w / 2, cy = h / 2
  const unitToPx = Math.min(w, h) / 2
  const N = graph.packages.length
  if (N === 0) return
  // Entry-point package — biggest by file count (graph.packages
  // is sorted size-desc in data.js). Pinned at center so the
  // user lands on the project's core. The rest of the packages
  // get the surrounding ring.
  const entryPkg = graph.packages[0]
  const others = graph.packages.slice(1)
  const Nothers = others.length
  // Group disk caps in unit space — entry gets a slightly more
  // generous cap so it reads as the anchor; others scale by
  // ring crowding so a hundred packages don't pile on top of
  // each other. Sparsity factor scales the BASE disk size up
  // for sparse layouts (handful of packages) so they don't
  // float as tiny dots.
  const sparsityFactor = Math.max(1, Math.sqrt(50 / Math.max(1, Nothers)))
  const entryCap = 0.22, othersCap = 0.12, padding = 0.04
  const entrySize = graph.pkgCount.get(entryPkg) ?? 0
  const entryGroupRUnit = Math.min(entryCap, (0.012 + Math.sqrt(entrySize) * 0.004) * sparsityFactor)
  // Ring radius — push out enough to clear the entry disk plus
  // a max-other-disk plus padding. Otherwise the largest other
  // packages would clip into the entry's cluster.
  const ringRUnit = Math.max(0.45, entryGroupRUnit + othersCap + padding)
  const pkgInfo = new Map()
  pkgInfo.set(entryPkg, { x: cx, y: cy, size: entrySize, groupR: entryGroupRUnit * unitToPx })
  for (let i = 0; i < Nothers; i++) {
    const pkg = others[i]
    // Evenly-spaced angles around the ring, ordered by package
    // size descending (graph.packages.slice(1) preserves the
    // size-desc ordering from data.js) so the visual emphasis
    // tracks the data emphasis.
    const angle = (i / Math.max(1, Nothers)) * Math.PI * 2
    const size = graph.pkgCount.get(pkg) ?? 0
    const gRUnit = Math.min(othersCap, (0.012 + Math.sqrt(size) * 0.004) * sparsityFactor)
    pkgInfo.set(pkg, {
      x: cx + Math.cos(angle) * ringRUnit * unitToPx,
      y: cy + Math.sin(angle) * ringRUnit * unitToPx,
      size, groupR: gRUnit * unitToPx,
    })
  }
  placeFilesInDisk(graph, pkgInfo)
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
  if (N === 0) return
  // Entry-point package — biggest by file count (graph.packages
  // is sorted size-desc in data.js). Pinned at center; the rest
  // of the packages spiral around it. The user almost always
  // wants to land on the project's core anchor when opening the
  // graph, and pinning it gives the eye a stable focal point
  // that the spiral arms radiate out from.
  const entryPkg = graph.packages[0]
  const others = graph.packages.slice(1)
  const Nothers = others.length
  // Cross-package degree per package — drives the radius
  // assignment for non-entry packages. Most-imported packages
  // sit near the inner ring (close to the entry), least-imported
  // drift to the rim. Reads as "the more central a package is
  // to the dependency graph, the more central it is on screen".
  const crossDeg = crossDegByPkg(graph)
  // Rank others by cross-degree desc; ties broken by package
  // size desc so equal-cross packages stack large-first toward
  // the center.
  const ranked = [...others].sort((a, b) => {
    const cd = (crossDeg.get(b) ?? 0) - (crossDeg.get(a) ?? 0)
    if (cd !== 0) return cd
    return (graph.pkgCount.get(b) ?? 0) - (graph.pkgCount.get(a) ?? 0)
  })
  const rankByPkg = new Map(ranked.map((p, i) => [p, i]))
  // Adapt the OUTER radius to N. Tight ring at low N (so a
  // handful of packages frame each other on a circle rather
  // than floating sparsely), widen through medium N, full
  // spiral at high N where the cross-degree spread is what
  // creates the visible arm structure.
  let maxRUnit
  if (Nothers <= 0) maxRUnit = 0
  else if (Nothers <= 6) maxRUnit = 0.65
  else if (Nothers <= 20) maxRUnit = 0.82
  else maxRUnit = 0.95
  // Sparsity factor scales the per-package disk size for low
  // package counts so a few clusters fill the canvas instead
  // of floating as tiny dots.
  const sparsityFactor = Math.max(1, Math.sqrt(50 / Math.max(1, Nothers)))
  const entryCap = 0.22, othersCap = 0.12, padding = 0.04
  const entrySize = graph.pkgCount.get(entryPkg) ?? 0
  const entryGroupRUnit = Math.min(entryCap, (0.012 + Math.sqrt(entrySize) * 0.004) * sparsityFactor)
  // Inner radius pushed out so the closest packages don't clip
  // into the entry disk. The 0.38 floor matches what the
  // entry+others+padding math demands at typical caps; at low
  // N the breakpoints above might want a tighter ring (0.40),
  // so take the larger.
  const minRUnit = Math.max(
    Nothers <= 6 ? 0.40 : (Nothers <= 20 ? 0.36 : 0.34),
    entryGroupRUnit + othersCap + padding,
  )
  const pkgInfo = new Map()
  pkgInfo.set(entryPkg, { x: cx, y: cy, size: entrySize, groupR: entryGroupRUnit * unitToPx })
  for (let i = 0; i < Nothers; i++) {
    const pkg = others[i]
    // Angle from the loop index, golden-angle stepped, so
    // angular distribution stays maximally distinct regardless
    // of how the rank-by-cross sort reorders things.
    const angle = ((i * 137.508) % 360) * Math.PI / 180
    // Radius from cross-rank — most cross-connected at minRUnit,
    // least cross-connected at maxRUnit. Hash-based jitter on
    // top so equal-rank packages don't form a perfect circle.
    const rank = rankByPkg.get(pkg) ?? i
    const fraction = Nothers <= 1 ? 0 : rank / (Nothers - 1)
    const seed = hash(pkg)
    const jitter = ((seed % 1000) / 1000 - 0.5) * 0.18
    const band = Math.max(0, Math.min(1, fraction + jitter))
    const rUnit = minRUnit + band * (maxRUnit - minRUnit)
    const size = graph.pkgCount.get(pkg) ?? 0
    const gRUnit = Math.min(othersCap, (0.012 + Math.sqrt(size) * 0.004) * sparsityFactor)
    pkgInfo.set(pkg, {
      x: cx + Math.cos(angle) * rUnit * unitToPx,
      y: cy + Math.sin(angle) * rUnit * unitToPx,
      size, groupR: gRUnit * unitToPx,
    })
  }
  placeFilesInDisk(graph, pkgInfo)
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

export function applyLayout(mode, graph, w, h) {
  if (mode === 'radial') layoutRadial(graph, w, h)
  else if (mode === 'grid') layoutGrid(graph, w, h)
  else layoutSpiral(graph, w, h)
}
