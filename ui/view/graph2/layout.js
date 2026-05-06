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
// more than 5 hubs (common on a large public-API package),
// pulling them all to the inner 30% piles them into a tight
// blob and the cluster loses readability. In that case, hubs
// use the same outer band as members and just rely on their
// bigger radius + halo + ring for the visual "this is a hub"
// cue.
const HUB_PULL_LIMIT = 5
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

// "Spiral" — Vogel sunflower positions (the same (i × 137.5°,
// sqrt(i/(N-1))) seed pattern as before) with greedy assignment
// of packages to those positions. The slot geometry is fixed; the
// degree of freedom is which priority-ranked package occupies which
// slot.
//
// Two phases:
//
//   1. Priority bucketing. Packages sort by cross-package degree
//      desc (ties: file count desc) and quantize the resulting
//      rank order into discrete rings. Ring k spans rank range
//      [(k/M)² · N, ((k+1)/M)² · N) — sqrt-density bucketing, so
//      outer rings carry proportionally more packages just like
//      the Vogel index ordering did. Most-coupled packages land
//      on the innermost ring, leaves on the rim.
//
//   2. Within-ring assignment. For each ring inner→outer, walk
//      packages in priority order; each picks the unused Vogel
//      slot in this ring closest to the weighted barycenter of
//      its already-placed neighbours (weight = cross-package edge
//      count). Packages without placed neighbours take the next-
//      available slot in Vogel index order, which preserves the
//      original spiral's golden-angle spread for unconstrained
//      placements.
//
// The entry-point package (largest with no incoming cross-package
// edges — typically the project's own source root) is pinned at
// center. Files inside each package fan out in their disk via the
// shared placeFilesInDisk helper.
//
// Greedy, single-pass: O(N × (avgNeighbours + ringSlots))
// ≈ O(N²/numRings). Sub-millisecond on 500+ packages.
export function layoutSpiral(graph, w, h) {
  const cx = w / 2, cy = h / 2
  // Work in the design's unit space (where 1.0 = half-canvas)
  // so the magic numbers below port over directly. Scaling to
  // pixels happens once per coordinate at write time.
  const unitToPx = Math.min(w, h) / 2
  const N = graph.packages.length
  if (N === 0) return
  const entryPkg = findEntryPkg(graph)
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
  // Adapt the OUTER radius to N. Tight ring at low N, widening
  // through medium N, full spiral at high N.
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
  // With entry: push out so the closest other-package's disk rim
  // doesn't clip into the entry's. Without entry: start from the
  // design's tight ring so inner packages get breathing room.
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
    if (Nothers <= 1) minRUnit = 0
    else if (Nothers <= 6) minRUnit = 0.40
    else if (Nothers <= 20) minRUnit = 0.32
    else minRUnit = 0.30
  }
  if (Nothers === 0) {
    placeFilesInDisk(graph, pkgInfo)
    return
  }

  // Pairwise package edge counts: pkgEdgesOf.get(p) → Map(other →
  // count). Symmetric (each cross-package edge updates both
  // endpoints) so the greedy optimizer below can look up `pkg →
  // its placed neighbours` directly without a per-package
  // adjacency rebuild.
  const pkgEdgesOf = new Map()
  for (const e of graph.edges) {
    if (!e.cross) continue
    const aPkg = graph.nodeByFile.get(e.a)?.pkg
    const bPkg = graph.nodeByFile.get(e.b)?.pkg
    if (!aPkg || !bPkg || aPkg === bPkg) continue
    if (!pkgEdgesOf.has(aPkg)) pkgEdgesOf.set(aPkg, new Map())
    if (!pkgEdgesOf.has(bPkg)) pkgEdgesOf.set(bPkg, new Map())
    const aMap = pkgEdgesOf.get(aPkg)
    const bMap = pkgEdgesOf.get(bPkg)
    aMap.set(bPkg, (aMap.get(bPkg) ?? 0) + 1)
    bMap.set(aPkg, (bMap.get(aPkg) ?? 0) + 1)
  }

  // Pre-compute the Vogel sunflower positions for every index
  // 0..Nothers-1. Same (i × 137.508°, sqrt(i/(N-1))) seed pattern
  // the old layout used; what changes is which package occupies
  // which index. Adjacent indices have very different angles
  // (golden-step) and very close radii, so within a ring all slots
  // share approximately the same radius and span the angular
  // circle in golden-angle stride.
  const vogelX = new Array(Nothers)
  const vogelY = new Array(Nothers)
  for (let i = 0; i < Nothers; i++) {
    const angle = ((i * 137.508) % 360) * Math.PI / 180
    const band = Nothers <= 1 ? 0 : Math.sqrt(i / (Nothers - 1))
    const rUnit = Nothers === 1 ? (entryPkg ? minRUnit : 0) : minRUnit + band * (maxRUnit - minRUnit)
    vogelX[i] = cx + Math.cos(angle) * rUnit * unitToPx
    vogelY[i] = cy + Math.sin(angle) * rUnit * unitToPx
  }

  // Ring count grows as ~sqrt(N). Capped at 10 — past that the
  // ring-to-ring radial spacing gets too tight and within-ring
  // permutation has too few slots to meaningfully optimize over.
  const numRings = Math.max(1, Math.min(10, Math.round(Math.sqrt(Nothers) / 1.2)))
  const ringStart = new Array(numRings + 1)
  for (let k = 0; k <= numRings; k++) {
    ringStart[k] = Math.floor(k * k / (numRings * numRings) * Nothers)
  }
  ringStart[numRings] = Nothers

  // Greedy assignment: for each ring inner→outer, walk packages in
  // priority order; each picks the unused Vogel slot in this ring
  // closest to the weighted barycenter of its already-placed
  // neighbours. Packages with no placed neighbours (or whose
  // barycenter sits at center — only entry-coupled) take the next-
  // available slot in Vogel index order, which inherits the original
  // spiral's golden-angle spread.
  for (let k = 0; k < numRings; k++) {
    const startIdx = ringStart[k]
    const endIdx = ringStart[k + 1]
    const M = endIdx - startIdx
    if (M === 0) continue
    const used = new Array(M).fill(false)

    for (let i = startIdx; i < endIdx; i++) {
      const pkg = others[i]
      // Weighted barycenter of already-placed neighbours.
      const neighbours = pkgEdgesOf.get(pkg)
      let bx = 0, by = 0, totalW = 0
      if (neighbours) {
        for (const [q, weight] of neighbours) {
          const pos = pkgInfo.get(q)
          if (!pos) continue
          bx += pos.x * weight
          by += pos.y * weight
          totalW += weight
        }
      }
      let useBary = false
      if (totalW > 0) {
        bx /= totalW; by /= totalW
        const dx = bx - cx, dy = by - cy
        // Skip the barycenter path when it sits essentially at
        // center (only entry-coupled): all slots in this ring
        // would be equidistant and slot 0 would always win,
        // collapsing the entry-only packages onto the same arc.
        if (dx * dx + dy * dy > 1) useBary = true
      }
      let bestSlot = -1
      if (useBary) {
        // Pick the unused slot in this ring with smallest
        // Euclidean distance to the barycenter. Within a ring all
        // slots share approximately the same radius, so this is
        // effectively angular matching with a small radial bias
        // when the barycenter sits inside / outside the ring.
        let bestDist2 = Infinity
        for (let j = 0; j < M; j++) {
          if (used[j]) continue
          const slotIdx = startIdx + j
          const ddx = vogelX[slotIdx] - bx
          const ddy = vogelY[slotIdx] - by
          const d2 = ddx * ddx + ddy * ddy
          if (d2 < bestDist2) { bestDist2 = d2; bestSlot = j }
        }
      } else {
        // Unconstrained — take the lowest unused index, which
        // delivers the next golden-angle slot in Vogel order.
        for (let j = 0; j < M; j++) {
          if (!used[j]) { bestSlot = j; break }
        }
      }
      used[bestSlot] = true
      const slotIdx = startIdx + bestSlot
      const size = graph.pkgCount.get(pkg) ?? 0
      const gRUnit = Math.min(othersCap, (0.012 + Math.sqrt(size) * 0.004) * sparsityFactor)
      pkgInfo.set(pkg, {
        x: vogelX[slotIdx],
        y: vogelY[slotIdx],
        size,
        groupR: gRUnit * unitToPx,
      })
    }
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
