// A quiet overview with direct connections emphasized on hover/selection.
// Everything stays on canvas: 1,000 packages do not create 1,000 DOM nodes.
export function dependencyNodeRadius(scale) { return Math.max(2.5, Math.min(6, 4.5 * Math.sqrt(scale))) }

export function drawPackageDependencies(ctx, layout, pg, { theme, viewport, width, height, colorOf, dimmed, selected, hovered, query }) {
  const { k, tx, ty } = viewport
  const r = dependencyNodeRadius(k)
  const focus = hovered ?? selected
  const neighbors = new Set([focus, ...(layout.links.get(focus) ?? []), ...(layout.incoming.get(focus) ?? [])])
  const points = new Map()
  for (const [id, p] of layout.nodes) {
    const n = pg.nodeByFile.get(id)
    points.set(id, { x: p.x * k + tx, y: p.y * k + ty, color: colorOf(n.pkg), n, p,
      dim: id === focus || id === selected ? 1 : dimmed(n) ? .12 : focus && !neighbors.has(id) ? .16 : 1 })
  }
  ctx.save()
  // Draw context first, emphasized edges last so dependencies stay traceable.
  const edge = (e, emphasis) => {
    const a = points.get(e.from), b = points.get(e.to)
    if (Math.max(a.x, b.x) < -40 || Math.min(a.x, b.x) > width + 40
      || Math.max(a.y, b.y) < -80 || Math.min(a.y, b.y) > height + 80) return
    ctx.globalAlpha = emphasis ? .85 : Math.min(a.dim, b.dim) * (focus ? .12 : .22)
    ctx.strokeStyle = emphasis ? a.color : theme.labelDefault
    ctx.lineWidth = emphasis ? 1.4 : .7
    ctx.setLineDash(e.cycle ? [3, 3] : [])
    const dx = b.x - a.x, dy = b.y - a.y
    const distance = Math.hypot(dx, dy) || 1
    const ux = dx / distance, uy = dy / distance
    const sx = a.x + ux * (r + 1), sy = a.y + uy * (r + 1)
    const ex = b.x - ux * (r + 3), ey = b.y - uy * (r + 3)
    // Reciprocal/cycle edges bow to opposite sides; other arrows take a direct
    // path so the small private dependency clusters remain easy to read.
    const bend = e.cycle ? Math.min(18, distance * .15) : 0
    const cx = (sx + ex) / 2 - uy * bend, cy = (sy + ey) / 2 + ux * bend
    ctx.beginPath(); ctx.moveTo(sx, sy)
    ctx.quadraticCurveTo(cx, cy, ex, ey)
    ctx.stroke()
    if (emphasis || k >= .85 || pg.nodes.length <= 50) {
      const angle = Math.atan2(ey - cy, ex - cx), arrow = emphasis ? 5 : 3.5
      ctx.setLineDash([])
      ctx.fillStyle = ctx.strokeStyle
      ctx.beginPath(); ctx.moveTo(ex, ey)
      ctx.lineTo(ex - Math.cos(angle - .5) * arrow, ey - Math.sin(angle - .5) * arrow)
      ctx.lineTo(ex - Math.cos(angle + .5) * arrow, ey - Math.sin(angle + .5) * arrow)
      ctx.closePath(); ctx.fill()
    }
  }
  for (const e of layout.edges) if (e.from !== focus && e.to !== focus) edge(e, false)
  for (const e of layout.edges) if (e.from === focus || e.to === focus) edge(e, true)
  ctx.setLineDash([])

  // Spatial occupancy for labels, including node dots, avoids O(N²) collision
  // tests. Labels appear progressively, with selected/searched packages first.
  const cells = new Map()
  const keys = (b) => {
    const result = []
    for (let x = Math.floor(b.x / 64); x <= Math.floor((b.x + b.w) / 64); x++) {
      for (let y = Math.floor(b.y / 24); y <= Math.floor((b.y + b.h) / 24); y++) result.push(`${x},${y}`)
    }
    return result
  }
  const occupy = (b) => { for (const key of keys(b)) { if (!cells.has(key)) cells.set(key, []); cells.get(key).push(b) } }
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  const visible = [...points.values()].filter((p) => p.x >= -10 && p.x <= width + 10 && p.y >= -10 && p.y <= height + 10)
  for (const p of visible) {
    ctx.globalAlpha = p.dim
    ctx.fillStyle = p.color
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill()
    if (p.p.cycle || p.n.totalIssues > 0) {
      ctx.strokeStyle = p.p.cycle ? '#c47ad7' : p.color
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 2.5, 0, Math.PI * 2); ctx.stroke()
    }
    if (p.n.file === selected || p.n.file === hovered) {
      ctx.strokeStyle = theme.selectRing; ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2); ctx.stroke()
    }
    occupy({ x: p.x - r - 2, y: p.y - r - 2, w: r * 2 + 4, h: r * 2 + 4 })
  }
  ctx.font = '11px SFMono-Regular, Consolas, "Liberation Mono", monospace'
  ctx.textBaseline = 'top'
  ctx.textAlign = 'center'
  visible.sort((a, b) => {
    const rank = (p) => p.n.file === focus ? 1e9 : p.n.file === selected ? 1e8 : query && p.dim === 1 ? 1e7 : focus && neighbors.has(p.n.file) ? 1e6 : layout.roots.has(p.n.file) ? 1e5 : p.n.deg
    return rank(b) - rank(a)
  })
  let ordinary = 0
  for (const p of visible) {
    const important = p.n.file === focus || p.n.file === selected
    if (!important && p.dim < .5) continue
    if (!important && !query && !focus && k < 1 && ordinary >= 24) continue
    const label = p.n.label.length > 38 ? `${p.n.label.slice(0, 36)}…` : p.n.label
    const w = ctx.measureText(label).width + 8
    const b = { x: p.x - w / 2, y: p.y + r + 5, w, h: 16 }
    if (b.x < 4 || b.x + b.w > width - 4 || b.y + b.h > height - 24) continue
    if (!important && keys(b).some((key) => cells.get(key)?.some((other) => overlaps(b, other)))) continue
    occupy(b); ordinary++
    ctx.globalAlpha = .94; ctx.fillStyle = theme.bg; ctx.fillRect(b.x, b.y - 1, b.w, b.h)
    ctx.globalAlpha = 1; ctx.fillStyle = important ? theme.labelSelected : theme.labelDefault
    ctx.fillText(label, p.x, b.y)
  }
  ctx.restore()
}
