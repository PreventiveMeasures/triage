// Spiral layout for the v2 graph. Each package becomes a disk
// in a Vogel sunflower (golden-angle steps + sqrt-radius
// growth, sorted by cross-package degree desc so the most
// coupled packages land at the center), with the entry-point
// package pinned at center and its files jittered around it.
// Writes directly into n.x / n.y on the passed nodes (no
// allocation). Canvas ResizeObserver passes the actual canvas
// dimensions, so the layout matches the viewport instead of
// an arbitrary unit square.
//
// Earlier versions also shipped Fruchterman-Reingold "force",
// a "classic" variant pinned to graph v1's canvas, "radial"
// (single ring), and "grid" (package cells). All four got
// removed — Force/Classic were an order of magnitude slower
// on big trees and produced a more cluttered result; Radial
// looked clean only at small N and crowded badly at large;
// Grid mis-read because user nodes themselves often align
// to a grid (file-system layout) so the cells reinforced
// the wrong axis.

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
//
// Hub-pull-to-center is gated on hub count: when a package has
// more than 10 hubs (common in Cross-imported mode on a large
// public-API package), pulling them all to the inner 30% piles
// them into a tight blob and the cluster loses readability. In
// that case, hubs use the same outer band as members and just
// rely on their bigger radius + halo + ring for the visual
// "this is a hub" cue.
const HUB_PULL_LIMIT = 10
function placeFilesInDisk(graph, pkgInfo) {
  // Count hubs per package once so the inner loop can branch
  // without walking byPkg every iteration.
  const hubsByPkg = new Map()
  for (const n of graph.nodes) {
    if (n.isHub) hubsByPkg.set(n.pkg, (hubsByPkg.get(n.pkg) ?? 0) + 1)
  }

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
    const pullToCenter = n.isHub && (hubsByPkg.get(n.pkg) ?? 0) <= HUB_PULL_LIMIT
    const localR = pullToCenter
      ? localBand * groupR * 0.3
      : (0.4 + localBand * 0.6) * groupR
    n.x = info.x + Math.cos(localA) * localR
    n.y = info.y + Math.sin(localA) * localR
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
    // Vogel spiral — golden angle for the angular step,
    // sqrt(i/(N-1)) for the radial step. This is the classic
    // sunflower-seed packing: it gives uniform density per
    // unit area (the area at radius r grows like 2πr, and
    // sqrt-radius produces dN/dArea = N/π = constant), so
    // packages spread evenly across the canvas instead of
    // crowding the inner ring the way a linear ramp did.
    //
    // Cross-deg sort still feeds the loop: i=0 (most cross-
    // connected) at band=0 (innermost), i=N-1 (least) at
    // band=1 (rim). Mapping is monotonic, so a "very coupled"
    // package always reads as inner and a leaf reads as outer.
    //
    // No hash jitter — golden-angle steps already give
    // adjacent indices wildly different angles, and the
    // sqrt-radius spreads adjacent ranks far enough apart on
    // the inner rings that the spiral reads as textured
    // without any added noise.
    const angle = ((i * 137.508) % 360) * Math.PI / 180
    const band = Nothers <= 1 ? 0 : Math.sqrt(i / (Nothers - 1))
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

// File-level Vogel sunflower — used by the package-focus mode
// when the package is too large for graph v1's force-directed
// solver to finish in interactive time (>50 files). Treats each
// file as its own seed in a sunflower spiral: golden-angle
// steps + sqrt-radius growth, sorted by intra-package degree
// desc so hubs land near the center and leaves drift to the
// rim. Same per-area uniform density argument as layoutSpiral,
// just operating on individual files instead of packages.
export function layoutFilesVogel(graph, w, h) {
  const cx = w / 2, cy = h / 2
  const unitToPx = Math.min(w, h) / 2
  const N = graph.nodes.length
  if (N === 0) return
  const sorted = [...graph.nodes].sort((a, b) => b.deg - a.deg)
  for (let i = 0; i < N; i++) {
    const n = sorted[i]
    const angle = ((i * 137.508) % 360) * Math.PI / 180
    const band = N <= 1 ? 0 : Math.sqrt(i / (N - 1))
    n.x = cx + Math.cos(angle) * band * 0.85 * unitToPx
    n.y = cy + Math.sin(angle) * band * 0.85 * unitToPx
  }
}
