import { optimizeSunflowerOrder } from './sunflower-order.js'
import { optimizePackageRings } from './package-order.js'

// The overview's spiral layout. Each package becomes a disk in a Vogel
// sunflower (golden-angle steps, sqrt-radius growth), the most coupled
// packages nearest the center, where the entry-point package is pinned; its
// files fill the disk. Positions are written onto the nodes, in the canvas's
// own pixel space. (Force-directed, radial and grid layouts were slower or
// misleading on large trees.)

// Cross-package imports per package, counted on both sides (a bidirectional
// pair adds two to each), so a library many packages import reads as core
// even when it imports little itself.
function crossDegByPkg(graph) {
  const map = new Map()
  const add = (pkg) => map.set(pkg, (map.get(pkg) ?? 0) + 1)
  for (const [f, imps] of graph.importsOf) {
    const from = graph.nodeByFile.get(f)?.pkg
    if (!from) continue
    for (const imp of imps) {
      const to = graph.nodeByFile.get(imp)?.pkg
      if (to && to !== from) { add(from); add(to) }
    }
  }
  return map
}

// The package pinned at the center: the largest own package holding an entry
// point, else the largest own package (packages are sorted by file count).
// Only bundles without own source fall back to the largest package no other
// package imports: that test alone would pick the native packages Metro
// captures add without imports. Null when every package is imported.
function findEntryPkg(graph) {
  const own = (pkg) => pkg === '__own__' || graph.ownSourcePackages?.has(pkg)
  const ownEntry = graph.packages.find((pkg) => own(pkg) && graph.entryPackages?.has(pkg)) ?? graph.packages.find(own)
  if (ownEntry) return ownEntry
  const hasInbound = new Set()
  for (const [target, importers] of graph.importedBy) {
    const pkg = graph.nodeByFile.get(target)?.pkg
    if (pkg && importers.some((importer) => graph.nodeByFile.get(importer) && graph.nodeByFile.get(importer).pkg !== pkg)) hasInbound.add(pkg)
  }
  return graph.packages.find((pkg) => !hasInbound.has(pkg)) ?? null
}

// Up to 5 hubs share the inner 30% of a disk; with more, every slot is in the
// outer band. Hubs always take the innermost slots, and optimization reorders
// hubs among hubs and members among members, never across.
const HUB_PULL_LIMIT = 5

// Package disks placed so far, bucketed by cell. `cellSize` is at least twice
// the largest radius, so every disk a new one could overlap is in the 3 × 3
// cells around its center.
function diskGrid(cellSize) {
  const cells = new Map()
  const cell = (x, y) => [Math.floor(x / cellSize), Math.floor(y / cellSize)]
  return {
    add(x, y, r) {
      const key = cell(x, y).join(':')
      if (!cells.has(key)) cells.set(key, [])
      cells.get(key).push({ x, y, r })
    },
    fits(x, y, r) {
      const [cx, cy] = cell(x, y)
      for (let i = cx - 1; i <= cx + 1; i++) {
        for (let j = cy - 1; j <= cy + 1; j++) {
          for (const disk of cells.get(`${i}:${j}`) ?? []) {
            if ((disk.x - x) ** 2 + (disk.y - y) ** 2 < (disk.r + r) ** 2 - 1e-7) return false
          }
        }
      }
      return true
    },
  }
}

function hubGroups(nodes) {
  return [nodes.filter(node => node.isHub), nodes.filter(node => !node.isHub)]
}

// The weighted mean of placed neighbors' positions ([x, y, weight]), or null
// without any, or when it sits at about (cx, cy): every slot would be about
// as close, the first would always win, and they'd collapse onto one arc.
function barycenter(points, cx, cy) {
  let total = 0, x = 0, y = 0
  for (const [px, py, weight] of points) { x += px * weight; y += py * weight; total += weight }
  if (total === 0) return null
  x /= total; y /= total
  const dx = x - cx, dy = y - cy
  return dx * dx + dy * dy > 1 ? { x, y } : null
}

// The free slot in [start, end) nearest `bary`, or without one the first free
// slot, which inherits the golden-angle spread; -1 when none is free.
function pickSlot(xs, ys, start, end, free, bary) {
  let best = -1, bestD2 = Infinity
  for (let j = start; j < end; j++) {
    if (!free(j)) continue
    if (!bary) return j
    const dx = xs[j] - bary.x, dy = ys[j] - bary.y
    const d2 = dx * dx + dy * dy
    if (d2 < bestD2) { bestD2 = d2; best = j }
  }
  return best
}

// Seed each package's files on fixed Vogel slots in its disk — hubs in the
// inner band [0, 0.3·groupR], members in [0.4·groupR, groupR] — then shorten
// edges by reassigning them, never moving a slot or crossing disks. Packages
// go in pkgInfo order (the center first, then by priority), so outer files
// lean toward the inner files placed before them; files go hubs first, by
// degree, each to the free slot of its band nearest its placed neighbors
// (inside and outside the package). Files linked across packages thus sit on
// the rim facing them, their edges short radial chords.
function placeFilesInDisk(graph, pkgInfo) {
  const filesByPkg = Map.groupBy(graph.nodes.filter((n) => pkgInfo.has(n.pkg)), (n) => n.pkg)
  for (const list of filesByPkg.values()) {
    list.sort((a, b) => a.isHub === b.isHub ? b.deg - a.deg : (a.isHub ? -1 : 1))
  }
  const at = new Map()
  for (const [pkg, info] of pkgInfo) {
    const files = filesByPkg.get(pkg)
    if (!files) continue
    const N = files.length
    let totalHubs = files.findIndex((n) => !n.isHub)
    if (totalHubs < 0) totalHubs = N
    const innerN = totalHubs > 0 && totalHubs <= HUB_PULL_LIMIT ? totalHubs : 0
    const outerN = N - innerN
    const groupR = info.groupR
    const slotX = [], slotY = []
    for (let i = 0; i < N; i++) {
      const angle = (i * 137.508) * Math.PI / 180
      const radius = i < innerN
        ? (innerN <= 1 ? 0 : Math.sqrt(i / (innerN - 1)) * 0.3 * groupR)
        : (outerN <= 1 ? 0.4 * groupR : (0.4 + Math.sqrt((i - innerN) / (outerN - 1)) * 0.6) * groupR)
      slotX.push(info.x + Math.cos(angle) * radius)
      slotY.push(info.y + Math.sin(angle) * radius)
    }
    const used = new Uint8Array(N)
    for (const f of files) {
      // A bidirectional pair counts on both lists: a deliberately stronger pull.
      const neighbors = [...(graph.importsOf.get(f.file) ?? []), ...(graph.importedBy.get(f.file) ?? [])].map((nei) => at.get(nei)).filter(Boolean)
      const slot = pickSlot(slotX, slotY, f.isHub ? 0 : totalHubs, f.isHub ? totalHubs : N, (j) => !used[j], barycenter(neighbors, info.x, info.y))
      used[slot] = 1
      f.x = slotX[slot]
      f.y = slotY[slot]
      at.set(f.file, [f.x, f.y, 1])
    }
  }
  optimizeSunflowerOrder(graph, [...filesByPkg.values()].flatMap(hubGroups))
}

// Packages take Vogel sunflower slots ((i × 137.508°, sqrt(i/(N-1)))), whose
// geometry is fixed; the layout only picks which package takes which slot:
//
//   1. Packages rank by cross-package degree (ties: file count), and ranks
//      quantize into rings, ring k holding ranks [(k/M)² N, ((k+1)/M)² N):
//      sqrt-density, so outer rings hold more, as the Vogel order does.
//   2. Ring by ring outward, each package in rank order takes the free slot
//      of its ring nearest its placed neighbors' barycenter, weighted by
//      cross-package edges, else the next slot in Vogel order.
//   3. Swaps within each ring shorten the unique cross-package links while
//      keeping disks clear (package-order.js); file-import counts only seed.
//
// The entry package sits at the center; files fan out in each disk
// (placeFilesInDisk). The seed costs O(N × (neighbors + ring slots)).
export function layoutSpiral(graph, w, h) {
  const cx = w / 2, cy = h / 2
  // Unit space (1.0 = half the smaller side), scaled to pixels on write.
  const unitToPx = Math.min(w, h) / 2
  if (graph.packages.length === 0) return
  const entryPkg = findEntryPkg(graph)
  const crossDeg = crossDegByPkg(graph)
  const others = graph.packages.filter((p) => p !== entryPkg)
    .toSorted((a, b) => (crossDeg.get(b) ?? 0) - (crossDeg.get(a) ?? 0) || (graph.pkgCount.get(b) ?? 0) - (graph.pkgCount.get(a) ?? 0))
  const Nothers = others.length
  // A tight ring for a few packages, the full spiral for many.
  const maxRUnit = Nothers <= 0 ? 0 : Nothers <= 6 ? 0.65 : Nothers <= 20 ? 0.82 : 0.95
  // Few packages get bigger disks, so their clusters fill the canvas.
  const sparsityFactor = Math.max(1, Math.sqrt(50 / Math.max(1, Nothers)))
  const entryCap = 0.22, othersCap = 0.12, padding = 0.04
  const groupRUnit = (size, cap) => Math.min(cap, (0.012 + Math.sqrt(size) * 0.004) * sparsityFactor)
  const pkgInfo = new Map()
  // With an entry pinned, the rings start past its rim; without, at a
  // tight radius that leaves inner packages room.
  let minRUnit = Nothers <= 1 ? 0 : Nothers <= 6 ? 0.40 : Nothers <= 20 ? 0.32 : 0.30
  if (entryPkg) {
    const entrySize = graph.pkgCount.get(entryPkg) ?? 0
    const entryGroupRUnit = groupRUnit(entrySize, entryCap)
    minRUnit = Math.max(Nothers <= 6 ? 0.40 : (Nothers <= 20 ? 0.36 : 0.34), entryGroupRUnit + othersCap + padding)
    pkgInfo.set(entryPkg, { x: cx, y: cy, size: entrySize, groupR: entryGroupRUnit * unitToPx })
  }
  if (Nothers === 0) {
    placeFilesInDisk(graph, pkgInfo)
    return
  }

  // Cross-package edge counts between each pair of packages, both ways.
  const pkgEdgesOf = new Map()
  const link = (a, b) => {
    if (!pkgEdgesOf.has(a)) pkgEdgesOf.set(a, new Map())
    pkgEdgesOf.get(a).set(b, (pkgEdgesOf.get(a).get(b) ?? 0) + 1)
  }
  for (const e of graph.edges) {
    if (!e.cross) continue
    const aPkg = graph.nodeByFile.get(e.a)?.pkg
    const bPkg = graph.nodeByFile.get(e.b)?.pkg
    if (!aPkg || !bPkg || aPkg === bPkg) continue
    link(aPkg, bPkg)
    link(bPkg, aPkg)
  }

  // About √N rings, at most 10: past that they get too close together and
  // too small to optimize within.
  const numRings = Math.max(1, Math.min(10, Math.round(Math.sqrt(Nothers) / 1.2)))
  const ringStart = Array.from({ length: numRings + 1 }, (_, k) => k === numRings ? Nothers : Math.floor(k * k / (numRings * numRings) * Nothers))

  // Each ring moves out by the previous ring's gap, scaled by that ring's
  // average files per package: r1(k) = r1(k-1) + (r0(k) - r0(k-1)) ·
  // (1 + 0.2 √(avg - 1)), r0 the Vogel radius at the ring's middle rank. A
  // ring of single-file packages keeps its gap; averages of 4, 16 and 50
  // widen it 1.35, 1.77 and 2.40 times. Packages keep their spread within
  // the ring, which only shifts; outer rings may pass maxRUnit (computeFit
  // reads the actual positions).
  const ringDelta = []
  let r0Prev = 0, r1 = 0
  for (let k = 0; k < numRings; k++) {
    const r0 = Math.sqrt(Math.max(0, (ringStart[k] + ringStart[k + 1] - 1) / 2 / Math.max(1, Nothers - 1)))
    if (k === 0) r1 = r0
    else {
      const groups = ringStart[k] - ringStart[k - 1]
      let files = 0
      for (let i = ringStart[k - 1]; i < ringStart[k]; i++) files += graph.pkgCount.get(others[i]) ?? 0
      const avg = groups > 0 ? files / groups : 1
      r1 += (r0 - r0Prev) * (1 + 0.2 * Math.sqrt(Math.max(0, avg - 1)))
    }
    ringDelta.push(r1 - r0)
    r0Prev = r0
  }

  const vogelX = [], vogelY = []
  let ring = 0
  for (let i = 0; i < Nothers; i++) {
    while (ring < numRings - 1 && i >= ringStart[ring + 1]) ring++
    const angle = ((i * 137.508) % 360) * Math.PI / 180
    const band = (Nothers <= 1 ? 0 : Math.sqrt(i / (Nothers - 1))) + ringDelta[ring]
    const rUnit = Nothers === 1 ? (entryPkg ? minRUnit : 0) : minRUnit + band * (maxRUnit - minRUnit)
    vogelX.push(cx + Math.cos(angle) * rUnit * unitToPx)
    vogelY.push(cy + Math.sin(angle) * rUnit * unitToPx)
  }

  // Slots ignore disk sizes, so when a package's usual slot overlaps a disk
  // placed so far, a slot where it clears them all wins. Others start past
  // the entry's rim, so only they need checking.
  const placed = diskGrid(2 * othersCap * unitToPx)
  const used = new Uint8Array(Nothers)
  for (let k = 0; k < numRings; k++) {
    const end = ringStart[k + 1], start = ringStart[k]
    for (let i = start; i < end; i++) {
      const pkg = others[i]
      const size = graph.pkgCount.get(pkg) ?? 0
      const groupR = groupRUnit(size, othersCap) * unitToPx
      const neighbors = [...(pkgEdgesOf.get(pkg) ?? [])].filter(([q]) => pkgInfo.has(q)).map(([q, weight]) => [pkgInfo.get(q).x, pkgInfo.get(q).y, weight])
      const bary = barycenter(neighbors, cx, cy)
      const fits = (j) => placed.fits(vogelX[j], vogelY[j], groupR)
      let slot = pickSlot(vogelX, vogelY, start, end, (j) => !used[j], bary)
      if (!fits(slot)) {
        const fitting = pickSlot(vogelX, vogelY, start, end, (j) => !used[j] && fits(j), bary)
        if (fitting >= 0) slot = fitting
      }
      used[slot] = 1
      pkgInfo.set(pkg, { x: vogelX[slot], y: vogelY[slot], size, groupR })
      placed.add(vogelX[slot], vogelY[slot], groupR)
    }
  }

  const rings = Array.from({ length: numRings }, (_, k) => others.slice(ringStart[k], ringStart[k + 1]))
  optimizePackageRings(pkgInfo, pkgEdgesOf, rings)
  separateDisks(pkgInfo, entryPkg)
  placeFilesInDisk(graph, pkgInfo)
}

// A ring can lack a slot where every large disk fits. Push overlapping disks
// apart, the smaller moving more and the center package staying put, until
// none overlap by more than half a pixel or the passes run out. A sweep over
// left edges finds the pairs.
function separateDisks(pkgInfo, pinned) {
  const disks = [...pkgInfo].map(([pkg, info]) => ({ info, pinned: pkg === pinned }))
  for (let pass = 0; pass < 100; pass++) {
    disks.sort((a, b) => (a.info.x - a.info.groupR) - (b.info.x - b.info.groupR))
    let moved = false
    for (let i = 0; i < disks.length; i++) {
      const a = disks[i].info
      for (let j = i + 1; j < disks.length; j++) {
        const b = disks[j].info
        if (b.x - b.groupR > a.x + a.groupR) break
        const dx = b.x - a.x, dy = b.y - a.y
        const distance = Math.hypot(dx, dy), need = a.groupR + b.groupR
        if (distance >= need - 0.5) continue
        // Each side moves in proportion to the other's area.
        const shareA = disks[i].pinned ? 0 : b.groupR ** 2, shareB = disks[j].pinned ? 0 : a.groupR ** 2
        if (shareA + shareB === 0) continue
        const push = (need - distance) / (shareA + shareB)
        const ux = distance > 1e-9 ? dx / distance : 1, uy = distance > 1e-9 ? dy / distance : 0
        a.x -= ux * push * shareA; a.y -= uy * push * shareA
        b.x += ux * push * shareB; b.y += uy * push * shareB
        moved = true
      }
    }
    if (!moved) return
  }
}

// A file-level Vogel sunflower for graphs too large for the force-directed
// solver (a focused package past 50 files, the package graph past 50
// packages): one seed per node, the innermost slots for own-source entry
// packages, then other own packages, then dependencies, hubs first within
// each tier, by degree. Swaps then shorten edges within each tier's hub and
// member groups, never moving a slot.
export function layoutFilesVogel(graph, w, h) {
  const cx = w / 2, cy = h / 2
  const unitToPx = Math.min(w, h) / 2
  const N = graph.nodes.length
  if (N === 0) return
  const dependencies = [], entries = [], own = []
  for (const node of graph.nodes) {
    const isOwn = node.pkg === '__own__' || graph.ownSourcePackages?.has(node.pkg)
    if (!isOwn) dependencies.push(node)
    else if (graph.entryPackages?.has(node.pkg)) entries.push(node)
    else own.push(node)
  }
  const byDegree = (a, b) => b.deg - a.deg
  const groups = [entries, own, dependencies].flatMap(hubGroups)
  const sorted = groups.flatMap(group => group.toSorted(byDegree))
  for (let i = 0; i < N; i++) {
    const n = sorted[i]
    const angle = ((i * 137.508) % 360) * Math.PI / 180
    const band = N <= 1 ? 0 : Math.sqrt(i / (N - 1))
    n.x = cx + Math.cos(angle) * band * 0.85 * unitToPx
    n.y = cy + Math.sin(angle) * band * 0.85 * unitToPx
  }
  optimizeSunflowerOrder(graph, groups)
}
