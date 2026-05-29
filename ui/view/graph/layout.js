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
// Spiral is the only layout: Force/Classic (Fruchterman-
// Reingold) were ~10× slower on big trees and more cluttered;
// Radial (single ring) crowded badly at large N; Grid mis-read
// because user nodes often already align to a grid (file-system
// layout), so the cells reinforced the wrong axis.

// Outgoing + incoming cross-package edges per package. Per
// directed "f imports imp" across packages: +1 to f's pkg
// (outgoing) and +1 to imp's pkg (incoming); a bidi pair thus
// contributes +2 to each side.
//
// Drives Spiral's "well-connected toward the center" sort: a
// package with lots of code pointing at it AND out of it reads
// as "core". Counting undirected edges would tally each cross-
// pair once, losing the asymmetric hub-library case (many
// incoming, few outgoing).
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
// at. Qualifies when no file has an importer in a DIFFERENT
// package (same-package importers are fine, intra-package
// coupling is expected); among qualifiers, pick the largest by
// file count.
//
// Typically lands on the user's own source: nothing in
// node_modules imports app code, the reverse is constant. With
// multiple candidates (e.g. sibling `src/` and `lib/`, neither
// with npm inbound) the largest usually carries the main intent.
//
// Returns null when every package has cross-package inbound
// (full cycle / no clear root); callers then fall back to a
// no-pinned-center layout.
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

// Distribute files inside their per-package disks. Two-phase,
// same approach as the package-level Spiral above at file scope:
//
//   1. Vogel slot positions. File index within the package's
//      sorted list maps to a fixed (angle, radius) via the same
//      i × 137.508° / sqrt(i/(N-1)) seed. Hubs occupy the inner
//      band [0, 0.3·groupR], members the outer [0.4·groupR,
//      1.0·groupR]; the Vogel sort already puts hubs at low
//      indices (small radii) and members at the rim.
//
//   2. Greedy assignment. Walk packages in pkgInfo order (Spiral's
//      priority: entry first, then cross-degree desc), files in
//      priority order (hubs first, then degree desc). Each file
//      picks the unused slot in its band closest to the barycenter
//      of its already-placed neighbours (intra- AND cross-package);
//      files with no placed neighbours take the lowest unused index
//      in their band, inheriting the golden-angle spread.
//
// Net effect: files with cross-package edges drift to the disk rim
// facing the connected packages, so those edges run as short radial
// chords instead of long diagonals.
//
// Hub-pull-to-center is gated on hub count: past 5 hubs (common on a
// large public-API package), pulling them all into the inner 30%
// piles them into an unreadable blob. Above the limit, hubs share
// the outer band with members and rely on their bigger radius +
// halo + ring as the "this is a hub" cue.
const HUB_PULL_LIMIT = 5
function placeFilesInDisk(graph, pkgInfo) {
  // Files-per-package buckets, in priority order (hubs first by
  // degree, then members by degree). Computed once so the placement
  // loop needn't re-filter graph.nodes per package.
  const filesByPkg = new Map()
  for (const n of graph.nodes) {
    if (!pkgInfo.has(n.pkg)) continue
    if (!filesByPkg.has(n.pkg)) filesByPkg.set(n.pkg, [])
    filesByPkg.get(n.pkg).push(n)
  }
  for (const list of filesByPkg.values()) {
    list.sort((a, b) => {
      if (a.isHub !== b.isHub) return a.isHub ? -1 : 1
      return b.deg - a.deg
    })
  }

  // Which files have positions written, so the barycenter
  // accumulator below can ignore not-yet-placed neighbours.
  const placedX = new Map()
  const placedY = new Map()

  // Walk packages in pkgInfo insertion order (entry first when
  // present, then priority order). Inner packages place first; their
  // outer neighbours, placed later, optimize toward the inner files'
  // positions. Reversing would place outer files first and let inner
  // files optimize outward — but inner positions sit near the canvas
  // centroid, so they have less room to move and benefit less.
  for (const [pkg, info] of pkgInfo) {
    const files = filesByPkg.get(pkg)
    if (!files || files.length === 0) continue
    const N = files.length
    // Hub count = leading prefix of the sorted list (hubs sorted
    // first). pullToCenter matches the gate at the top of the file.
    let totalHubs = 0
    for (const n of files) { if (n.isHub) totalHubs++; else break }
    const pullToCenter = totalHubs > 0 && totalHubs <= HUB_PULL_LIMIT
    const innerN = pullToCenter ? totalHubs : 0
    const outerN = N - innerN
    const groupR = info.groupR

    // Vogel slot positions. Indices [0, innerN) → inner band
    // [0, 0.3·groupR]; [innerN, N) → outer band [0.4·groupR,
    // groupR]. Angle is the same i × 137.508° step across both.
    const slotX = Array.from({ length: N })
    const slotY = Array.from({ length: N })
    for (let i = 0; i < N; i++) {
      const angle = (i * 137.508) * Math.PI / 180
      let radius
      if (i < innerN) {
        radius = innerN <= 1 ? 0 : Math.sqrt(i / (innerN - 1)) * 0.3 * groupR
      } else {
        const m = i - innerN
        radius = outerN <= 1
          ? 0.4 * groupR
          : (0.4 + Math.sqrt(m / (outerN - 1)) * 0.6) * groupR
      }
      slotX[i] = info.x + Math.cos(angle) * radius
      slotY[i] = info.y + Math.sin(angle) * radius
    }

    const used = Array.from({ length: N }, () => false)

    for (let fi = 0; fi < N; fi++) {
      const f = files[fi]
      // Slot range for this file:
      //   pullToCenter && hub → inner band [0, innerN)
      //   pullToCenter && member → outer band [innerN, N)
      //   !pullToCenter → entire disk [0, N) (hubs sort earlier so
      //   still take the inner indices)
      let bandEnd
      let bandStart
      if (pullToCenter && f.isHub) { bandStart = 0; bandEnd = innerN }
      else if (pullToCenter) { bandStart = innerN; bandEnd = N }
      else { bandStart = 0; bandEnd = N }

      // Weighted barycenter of placed neighbours (intra- and cross-
      // package). Each import / imported-by counts once, so a bidi
      // pair contributes twice (importsOf + importedBy) — the
      // intended stronger pull for bidirectional coupling.
      let bx = 0, by = 0, count = 0
      const imps = graph.importsOf.get(f.file)
      if (imps) {
        for (const nei of imps) {
          const px = placedX.get(nei)
          if (px === undefined) continue
          bx += px; by += placedY.get(nei); count++
        }
      }
      const ibs = graph.importedBy.get(f.file)
      if (ibs) {
        for (const nei of ibs) {
          const px = placedX.get(nei)
          if (px === undefined) continue
          bx += px; by += placedY.get(nei); count++
        }
      }
      let useBary = false
      if (count > 0) {
        bx /= count; by /= count
        const dx = bx - info.x, dy = by - info.y
        // Skip the barycenter path when it sits ~at the disk center:
        // all band slots would be roughly equidistant and slot
        // bandStart would always win, collapsing files onto one arc.
        if (dx * dx + dy * dy > 1) useBary = true
      }

      let bestSlot = -1
      if (useBary) {
        let bestDist2 = Infinity
        for (let j = bandStart; j < bandEnd; j++) {
          if (used[j]) continue
          const ddx = slotX[j] - bx, ddy = slotY[j] - by
          const d2 = ddx * ddx + ddy * ddy
          if (d2 < bestDist2) { bestDist2 = d2; bestSlot = j }
        }
      } else {
        for (let j = bandStart; j < bandEnd; j++) {
          if (!used[j]) { bestSlot = j; break }
        }
      }
      used[bestSlot] = true
      f.x = slotX[bestSlot]
      f.y = slotY[bestSlot]
      placedX.set(f.file, f.x)
      placedY.set(f.file, f.y)
    }
  }
}

// "Spiral" — Vogel sunflower positions ((i × 137.5°,
// sqrt(i/(N-1))) seed) with greedy assignment of packages to
// them. Slot geometry is fixed; the only freedom is which
// priority-ranked package occupies which slot.
//
// Two phases:
//
//   1. Priority bucketing. Packages sort by cross-package degree
//      desc (ties: file count desc); the rank order quantizes into
//      rings. Ring k spans rank [(k/M)² · N, ((k+1)/M)² · N) —
//      sqrt-density, so outer rings carry proportionally more
//      packages (as the Vogel index ordering does). Most-coupled
//      on the innermost ring, leaves on the rim.
//
//   2. Within-ring assignment. For each ring inner→outer, walk
//      packages in priority order; each picks the unused Vogel slot
//      in this ring closest to the weighted barycenter of its
//      already-placed neighbours (weight = cross-package edge
//      count). Packages with no placed neighbours take the next
//      available slot in Vogel index order (golden-angle spread).
//
// The entry-point package (largest with no incoming cross-package
// edges — typically the project's own source root) is pinned at
// center. Files inside each package fan out via placeFilesInDisk.
//
// Greedy, single-pass: O(N × (avgNeighbours + ringSlots))
// ≈ O(N²/numRings). Sub-millisecond on 500+ packages.
export function layoutSpiral(graph, w, h) {
  const cx = w / 2, cy = h / 2
  // Work in unit space (1.0 = half-canvas) so the magic numbers
  // below port over directly; scale to pixels per coordinate at
  // write time.
  const unitToPx = Math.min(w, h) / 2
  const N = graph.packages.length
  if (N === 0) return
  const entryPkg = findEntryPkg(graph)
  const crossDeg = crossDegByPkg(graph)
  const others = (entryPkg
    ? graph.packages.filter((p) => p !== entryPkg)
    : [...graph.packages])
    .toSorted((a, b) => {
      const cd = (crossDeg.get(b) ?? 0) - (crossDeg.get(a) ?? 0)
      if (cd !== 0) return cd
      return (graph.pkgCount.get(b) ?? 0) - (graph.pkgCount.get(a) ?? 0)
    })
  const Nothers = others.length
  // Outer radius adapts to N: tight ring at low N, full spiral
  // at high N.
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
  } else if (Nothers <= 1) {
    minRUnit = 0
  } else if (Nothers <= 6) {
    minRUnit = 0.40
  } else if (Nothers <= 20) {
    minRUnit = 0.32
  } else {
    minRUnit = 0.30
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

  // Ring count grows as ~sqrt(N). Capped at 10 — past that the
  // ring-to-ring radial spacing gets too tight and within-ring
  // permutation has too few slots to meaningfully optimize over.
  const numRings = Math.max(1, Math.min(10, Math.round(Math.sqrt(Nothers) / 1.2)))
  const ringStart = Array.from({ length: numRings + 1 })
  for (let k = 0; k <= numRings; k++) {
    ringStart[k] = Math.floor(k * k / (numRings * numRings) * Nothers)
  }
  ringStart[numRings] = Nothers

  // Per-ring radial push-out. Each ring's centre band radius is
  // computed recursively:
  //
  //   r1(0) = r0(0)
  //   r1(k) = r1(k-1) + (r0(k) - r0(k-1)) · scale(avg(k-1))
  //
  //   avg(k) = ringNodeCount(k) / ringGroupCount(k)   (files/group)
  //   scale(x) = 1 + GAP_SCALE_K · sqrt(max(0, x - 1))
  //
  // r0(k) is the ring's natural Vogel band radius (sqrt of the
  // midpoint t of the ring's rank range). scale() is anchored at
  // scale(1) = 1 so a ring of single-file packages keeps its
  // original gap unchanged; for higher averages the gap grows
  // sub-linearly (sqrt of (x-1) damped by GAP_SCALE_K = 0.2):
  //
  //   avg files/pkg  scale    (gap multiplier)
  //   1              1.00
  //   4              1.35
  //   16             1.77
  //   50             2.40
  const GAP_SCALE_K = 0.2
  //
  // Then each package's band shifts by (r1 - r0) of its own ring,
  // preserving the within-ring Vogel spread (packages keep their
  // relative radii inside the ring; only the ring centre moves).
  // Outer rings may extend past the original maxRUnit; computeFit
  // reads actual node positions and auto-zooms.
  const ringGroupCount = Array.from({ length: numRings })
  const ringNodeCount = Array.from({ length: numRings })
  for (let k = 0; k < numRings; k++) {
    const startIdx = ringStart[k]
    const endIdx = ringStart[k + 1]
    ringGroupCount[k] = endIdx - startIdx
    let nodes = 0
    for (let i = startIdx; i < endIdx; i++) {
      nodes += graph.pkgCount.get(others[i]) ?? 0
    }
    ringNodeCount[k] = nodes
  }
  const ringR0 = Array.from({ length: numRings })
  for (let k = 0; k < numRings; k++) {
    const midT = (ringStart[k] + ringStart[k + 1] - 1) / 2 / Math.max(1, Nothers - 1)
    ringR0[k] = Math.sqrt(Math.max(0, midT))
  }
  const ringR1 = Array.from({ length: numRings })
  ringR1[0] = ringR0[0]
  for (let k = 1; k < numRings; k++) {
    const grp = ringGroupCount[k - 1]
    const nds = ringNodeCount[k - 1]
    const avg = grp > 0 ? nds / grp : 1
    const factor = 1 + GAP_SCALE_K * Math.sqrt(Math.max(0, avg - 1))
    ringR1[k] = ringR1[k - 1] + (ringR0[k] - ringR0[k - 1]) * factor
  }
  const ringDelta = Array.from({ length: numRings })
  for (let k = 0; k < numRings; k++) ringDelta[k] = ringR1[k] - ringR0[k]

  // Pre-compute the Vogel sunflower positions for every index
  // 0..Nothers-1. Same (i × 137.508°, sqrt(i/(N-1))) seed, with each
  // package's band shifted by the per-ring delta above (preserves
  // within-ring spread, just translates the ring centre).
  const vogelX = Array.from({ length: Nothers })
  const vogelY = Array.from({ length: Nothers })
  let curRing = 0
  for (let i = 0; i < Nothers; i++) {
    while (curRing < numRings - 1 && i >= ringStart[curRing + 1]) curRing++
    const angle = ((i * 137.508) % 360) * Math.PI / 180
    const baseBand = Nothers <= 1 ? 0 : Math.sqrt(i / (Nothers - 1))
    const band = baseBand + ringDelta[curRing]
    const rUnit = Nothers === 1 ? (entryPkg ? minRUnit : 0) : minRUnit + band * (maxRUnit - minRUnit)
    vogelX[i] = cx + Math.cos(angle) * rUnit * unitToPx
    vogelY[i] = cy + Math.sin(angle) * rUnit * unitToPx
  }

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
    const used = Array.from({ length: M }, () => false)

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
  const sorted = [...graph.nodes].toSorted((a, b) => b.deg - a.deg)
  for (let i = 0; i < N; i++) {
    const n = sorted[i]
    const angle = ((i * 137.508) % 360) * Math.PI / 180
    const band = N <= 1 ? 0 : Math.sqrt(i / (N - 1))
    n.x = cx + Math.cos(angle) * band * 0.85 * unitToPx
    n.y = cy + Math.sin(angle) * band * 0.85 * unitToPx
  }
}
