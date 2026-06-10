// Fruchterman-Reingold force-directed layout for the graph canvas.
// Only the lazy-loaded canvas.js calls this — no main-bundle code
// path needs it — so the ~100-line solver lives in a sibling file
// rather than `view/graph/utils.js` (which is in the main bundle's
// static chain for tree-view / render-bundle helpers).
//
// Width / height are passed in from the actual canvas size at
// layout time so the initial seeding + spring constants match the
// real viewport.

import { packageOf } from './utils.js'

// `opts.groupOf(id)`: classifier behind the centroid-pull clusters
// below. Defaults to packageOf — right when ids are file paths (the
// package-focus mode). The packages view passes identity: its ids
// are package NAMES, which packageOf would mis-bucket (every
// unscoped name → '/', scoped names by scope), pulling unrelated
// packages toward a common centroid. Identity makes every group a
// singleton, which the pull loop skips — spring + repulsion forces
// alone shape that layout.
export function forceLayout(files, importsOf, layoutW, layoutH, { groupOf = packageOf } = {}) {
  const N = files.length
  const height = layoutH || 760
  const width = layoutW || 1100
  // k is the "ideal edge length" — larger canvas → more spread
  const k = Math.sqrt((width * height) / Math.max(N, 1)) * 1.1

  const seed = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.codePointAt(0)) | 0; return h }

  // Seed nodes on a grid + jitter rather than a circle — grid seeds
  // produce fewer initial edge crossings than a ring and converge faster.
  const cols = Math.ceil(Math.sqrt(N * width / height))
  const rows = Math.ceil(N / cols)
  const cellH = height / (rows + 1)
  const cellW = width / (cols + 1)
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

  // Group for centroid pull (per-package when ids are file paths).
  const byPkg = new Map()
  for (let i = 0; i < N; i++) {
    const p = groupOf(nodes[i].file) ?? '__own__'
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
