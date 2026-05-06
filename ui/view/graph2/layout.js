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

// Outgoing + incoming cross-package edges per package. Walks
// the directed imports relation: for each "f imports imp"
// where the two files live in different packages, +1 to f's
// package (outgoing) and +1 to imp's package (incoming). Bidi
// pairs (A↔B across packages) contribute +2 to each side.
//
// This is what drives Spiral's "well-connected toward the
// center" sort: a package with lots of code pointing at it
// AND lots of code pointing out from it both read as "core".
// Walking edges instead would only count each cross-pair
// once — losing the asymmetric case where a hub library has
// many incoming but few outgoing imports.
function crossDegByPkg(graph) {
  const map = new Map()
  for (const [f, imps] of graph.importsOf) {
    const fNode = graph.nodeByFile.get(f)
    if (!fNode) continue
    for (const imp of imps) {
      const impNode = graph.nodeByFile.get(imp)
      if (!impNode) continue
      if (fNode.pkg === impNode.pkg) continue
      map.set(fNode.pkg, (map.get(fNode.pkg) ?? 0) + 1)
      map.set(impNode.pkg, (map.get(impNode.pkg) ?? 0) + 1)
    }
  }
  return map
}

// Pick the entry-point package — the one nothing else points
// at. A package qualifies when none of its files has an
// importer in a DIFFERENT package; same-package importers are
// fine (intra-package coupling is expected). Among qualifying
// packages, pick the largest by file count.
//
// For a typical DeepView project this lands on the user's
// own source: nothing in node_modules imports app code, but
// the reverse is constant. Multiple candidates can exist
// (e.g. `src/` and `lib/` as sibling top-level dirs both with
// no inbound from npm), and the largest one usually carries
// the project's main intent.
//
// Returns null when every package has cross-package inbound
// (full cycle / no clear root). Callers fall back to a
// no-pinned-center layout in that case.
function findEntryPkg(graph) {
  if (graph.packages.length === 0) return null
  const hasInbound = new Set()
  for (const [target, importers] of graph.importedBy) {
    const targetNode = graph.nodeByFile.get(target)
    if (!targetNode) continue
    for (const importer of importers) {
      const importerNode = graph.nodeByFile.get(importer)
      if (importerNode && importerNode.pkg !== targetNode.pkg) {
        hasInbound.add(targetNode.pkg)
        break
      }
    }
  }
  // graph.packages is size-desc, so the first qualifying
  // package we hit walking it is the largest one.
  for (const pkg of graph.packages) {
    if (!hasInbound.has(pkg)) return pkg
  }
  return null
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
  // Entry-point package — the largest one with no incoming
  // cross-package edges. Pinned at center so the user lands on
  // the project's core; the rest of the packages get the
  // surrounding ring. Returns null on a fully-cyclic graph,
  // in which case nothing is pinned and ALL packages share
  // the ring (no carved-out center).
  const entryPkg = findEntryPkg(graph)
  const others = entryPkg ? graph.packages.filter((p) => p !== entryPkg) : graph.packages
  const Nothers = others.length
  // Group disk caps in unit space — entry gets a slightly more
  // generous cap so it reads as the anchor; others scale by
  // ring crowding so a hundred packages don't pile on top of
  // each other. Sparsity factor scales the BASE disk size up
  // for sparse layouts (handful of packages) so they don't
  // float as tiny dots.
  const sparsityFactor = Math.max(1, Math.sqrt(50 / Math.max(1, Nothers)))
  const entryCap = 0.22, othersCap = 0.12, padding = 0.04
  const pkgInfo = new Map()
  // Ring radius — historically 0.42 of (min(W,H) - 64px), which
  // works out to roughly 0.80 of half-canvas units. The earlier
  // `0.45` value was a unit-space typo that landed at half the
  // visual size of the historical ring; restore to 0.85 so the
  // ring fills the canvas the way it did before the entry
  // pinning logic was added.
  let ringRUnit = 0.85
  if (entryPkg) {
    const entrySize = graph.pkgCount.get(entryPkg) ?? 0
    const entryGroupRUnit = Math.min(entryCap, (0.012 + Math.sqrt(entrySize) * 0.004) * sparsityFactor)
    // Push out further if the entry's disk plus a max-other-disk
    // plus padding would otherwise clip; rare but cheap to guard.
    ringRUnit = Math.max(ringRUnit, entryGroupRUnit + othersCap + padding)
    pkgInfo.set(entryPkg, { x: cx, y: cy, size: entrySize, groupR: entryGroupRUnit * unitToPx })
  }
  for (let i = 0; i < Nothers; i++) {
    const pkg = others[i]
    // Evenly-spaced angles around the ring, ordered by package
    // size descending (`others` inherits graph.packages's
    // size-desc ordering minus the entry) so the visual
    // emphasis tracks the data emphasis.
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
  // Entry-point package — the largest one with no incoming
  // cross-package edges (typically the project's own source
  // root: nothing in node_modules imports app code). Pinned at
  // center; the rest of the packages spiral around it. Returns
  // null on a fully-cyclic graph, in which case nothing is
  // pinned and the spiral fills the full radius range.
  const entryPkg = findEntryPkg(graph)
  // Sort others by cross-degree desc (ties: file count desc).
  // The original spiral algorithm below uses i to drive BOTH
  // the angle (i * 137.508°) and the radius (band = i*31 % 100
  // / 100 — pseudo-random walk through 100 distinct values).
  // By feeding cross-deg-desc as the input order, the most-
  // connected non-entry package lands at i=0 → band=0 →
  // innermost radius; subsequent indices cycle through the
  // band sequence in cross-deg order, so the layout's
  // arm structure (which depends on the angle/radius
  // decoupling per step) is preserved verbatim.
  const crossDeg = crossDegByPkg(graph)
  const others = (entryPkg
    ? graph.packages.filter((p) => p !== entryPkg)
    : [...graph.packages])
    .sort((a, b) => {
      const cd = (crossDeg.get(b) ?? 0) - (crossDeg.get(a) ?? 0)
      if (cd !== 0) return cd
      return (graph.pkgCount.get(b) ?? 0) - (graph.pkgCount.get(a) ?? 0)
    })
  const Nothers = others.length
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
  const pkgInfo = new Map()
  // Inner radius depends on whether we have an entry pinned.
  // With an entry: push out so the closest other-package's
  // disk rim doesn't clip into the entry's. Without an entry:
  // use the original adaptive minRUnit so the spiral has the
  // same density it had pre-entry-pinning.
  let minRUnit
  if (entryPkg) {
    const entrySize = graph.pkgCount.get(entryPkg) ?? 0
    const entryGroupRUnit = Math.min(entryCap, (0.012 + Math.sqrt(entrySize) * 0.004) * sparsityFactor)
    minRUnit = Math.max(
      Nothers <= 6 ? 0.40 : (Nothers <= 20 ? 0.36 : 0.34),
      entryGroupRUnit + othersCap + padding,
    )
    pkgInfo.set(entryPkg, { x: cx, y: cy, size: entrySize, groupR: entryGroupRUnit * unitToPx })
  } else {
    // No entry — start from the design's tight ring so packages
    // near the inner edge get visible breathing room without
    // assuming a centered anchor.
    if (Nothers <= 1) minRUnit = 0
    else if (Nothers <= 6) minRUnit = 0.40
    else if (Nothers <= 20) minRUnit = 0.32
    else minRUnit = 0.30
  }
  for (let i = 0; i < Nothers; i++) {
    const pkg = others[i]
    // Original design formulas — i drives both the golden-
    // angle step and the pseudo-random radius band. Because
    // `others` is sorted by cross-degree desc, low i means
    // high cross-degree, and `band = (i * 31) % 100 / 100`
    // returns 0 at i=0 → the most cross-connected package
    // lands at the innermost radius. Subsequent indices cycle
    // through the band sequence in cross-deg order.
    const angle = ((i * 137.508) % 360) * Math.PI / 180
    const band = ((i * 31) % 100) / 100
    const rUnit = Nothers === 1 ? 0 : minRUnit + band * (maxRUnit - minRUnit)
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
