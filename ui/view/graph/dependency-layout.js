// Package topology, independent of file counts and source sizes. Start with a
// dependency ordering, then relax it into a compact graph: ranks guide direction
// but do not reserve slots or bands. A spatial grid bounds local repulsion work.
import { stronglyConnected } from './matrix-model.js'

export function layoutPackageDependencies(ids, importsOf, roots = [], { width = 1200, height = 800 } = {}) {
  ids = [...new Set(ids)].toSorted()
  const known = new Set(ids)
  const links = new Map(ids.map((id) => [id, [...new Set(importsOf.get(id) ?? [])].filter((to) => to !== id && known.has(to)).toSorted()]))
  const incoming = new Map(ids.map((id) => [id, []]))
  for (const [from, targets] of links) for (const to of targets) incoming.get(to).push(from)
  const { groups, componentOf } = stronglyConnected(ids, links)
  const cycles = groups.filter((g) => g.length > 1)
  const cycleIds = new Set(cycles.flat())
  const targets = groups.map(() => new Set())
  const indegree = groups.map(() => 0)
  for (const [from, deps] of links) {for (const to of deps) {
    const a = componentOf.get(from), b = componentOf.get(to)
    if (a !== b && !targets[a].has(b)) { targets[a].add(b); indegree[b]++ }
  }}
  // Longest path on the condensed DAG keeps dependencies below importers;
  // members of a cycle share a depth. No recursion, even for long chains.
  const rootComponents = new Set(roots.map((id) => componentOf.get(id)).filter((id) => id !== undefined))
  const ranks = groups.map(() => 0)
  const queue = []
  const queued = new Set()
  const enqueue = (id) => { if (!queued.has(id)) { queued.add(id); queue.push(id) } }
  rootComponents.forEach(enqueue)
  indegree.forEach((count, i) => { if (!count) enqueue(i) })
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i]
    for (const b of targets[a]) {
      if (!rootComponents.has(b)) ranks[b] = Math.max(ranks[b], ranks[a] + 1)
      if (--indegree[b] === 0) enqueue(b)
    }
  }
  const depth = new Map(ids.map((id) => [id, ranks[componentOf.get(id)]]))
  const bands = new Map()
  for (const id of ids) {
    const level = depth.get(id)
    if (!bands.has(level)) bands.set(level, [])
    bands.get(level).push(id)
  }
  const levels = [...bands.keys()].toSorted((a, b) => a - b)
  const positions = new Map()
  const indexBand = (members) => members.forEach((id, i) => positions.set(id, (i + .5) / members.length))
  for (const members of bands.values()) indexBand(members)
  for (let pass = 0; pass < 12; pass++) {
    for (const level of pass % 2 ? levels.toReversed() : levels) {
      const members = bands.get(level)
      const centers = new Map(members.map((id) => {
        const neighbors = (pass % 2 ? links : incoming).get(id)
        return [id, neighbors.length > 0 ? neighbors.reduce((sum, n) => sum + positions.get(n), 0) / neighbors.length : positions.get(id)]
      }))
      members.sort((a, b) => centers.get(a) - centers.get(b) || positions.get(a) - positions.get(b) || a.localeCompare(b))
      indexBand(members)
    }
  }
  const aspect = Math.max(.6, Math.min(2.4, width / Math.max(1, height)))
  const spanX = Math.max(160, Math.sqrt(ids.length * 1100 * aspect))
  const spanY = Math.max(120, spanX / aspect)
  const maxDepth = levels.at(-1) ?? 0
  const nodes = new Map()
  for (const [level, members] of bands) {members.forEach((id, i) => {
    const x = positions.get(id) * spanX
    const y = (level + .5) / (maxDepth + 1) * spanY
    nodes.set(id, { id, x, y: y + ((i % 5) - 2) * 9, anchorY: y, vx: 0, vy: 0, level,
      cycle: cycleIds.has(id), degree: links.get(id).length + incoming.get(id).length })
  })}
  const edges = []
  for (const [from, deps] of links) {for (const to of deps) {
    edges.push({ from, to, cycle: cycleIds.has(from) && componentOf.get(from) === componentOf.get(to) })
  }}
  const springs = edges.map((e) => {
    const a = nodes.get(e.from), b = nodes.get(e.to)
    // A lightly shared dependency stays near its caller(s); popular utilities
    // get enough space for their fan-in without dragging every caller together.
    const length = 26 + Math.sqrt(Math.max(a.degree, b.degree)) * 5
    return { a, b, length, strength: .065 / Math.sqrt(Math.min(a.degree, b.degree) || 1), cycle: e.cycle }
  })
  const list = [...nodes.values()]
  const cell = 80
  for (let step = 0; step < 240; step++) {
    const grid = new Map(), temperature = 7 * (1 - step / 240) + .15
    for (let i = 0; i < list.length; i++) {
      const p = list[i]
      p.fx = (spanX / 2 - p.x) * .002
      p.fy = (p.anchorY - p.y) * .018
      p.gx = Math.floor(p.x / cell); p.gy = Math.floor(p.y / cell)
      const key = `${p.gx},${p.gy}`
      if (!grid.has(key)) grid.set(key, [])
      grid.get(key).push(i)
    }
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      for (let gx = a.gx - 1; gx <= a.gx + 1; gx++) {for (let gy = a.gy - 1; gy <= a.gy + 1; gy++) {
        for (const j of grid.get(`${gx},${gy}`) ?? []) {
          if (j <= i) continue
          const b = list[j]
          let dx = a.x - b.x, dy = a.y - b.y
          const d2 = dx * dx + dy * dy
          if (d2 > cell * cell) continue
          if (d2 < .01) { dx = i % 2 ? .1 : -.1; dy = .1 }
          const d = Math.hypot(dx, dy)
          const force = Math.min(18, 100 / d - 100 / cell + Math.max(0, 22 - d) * .6)
          const fx = dx / d * force, fy = dy / d * force
          a.fx += fx; a.fy += fy; b.fx -= fx; b.fy -= fy
        }
      }}
    }
    for (const { a, b, length, strength, cycle } of springs) {
      const dx = b.x - a.x, dy = b.y - a.y
      const d = Math.hypot(dx, dy) || 1
      const force = (d - length) * strength
      const fx = dx / d * force, fy = dy / d * force
      a.fx += fx; a.fy += fy; b.fx -= fx; b.fy -= fy
      if (!cycle && dy < 22) {
        const flow = (22 - dy) * .018
        a.fy -= flow; b.fy += flow
      }
    }
    for (const p of list) {
      p.vx = (p.vx + p.fx) * .55; p.vy = (p.vy + p.fy) * .55
      const speed = Math.hypot(p.vx, p.vy) || 1
      const scale = Math.min(1, temperature / speed)
      p.x += p.vx * scale; p.y += p.vy * scale
    }
  }
  let maxX = -Infinity, maxY = -Infinity, minX = Infinity, minY = Infinity
  for (const p of list) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y) }
  for (const p of list) { p.x += 16 - minX; p.y += 16 - minY }
  return { nodes, edges, depth, incoming, links, cycles, roots: new Set(roots.filter((id) => known.has(id))),
    width: list.length > 0 ? maxX - minX + 32 : 32, height: list.length > 0 ? maxY - minY + 32 : 32 }
}
