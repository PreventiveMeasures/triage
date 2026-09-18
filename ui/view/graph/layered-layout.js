// DOM- and package-independent: callers supply ids, byte sizes, directed
// imports and roots. The same layout can later be fed files within a package.
export function layoutDependencyLayers(nodes, importsOf, roots, { width = 900, rowHeight = 52, gap = 42 } = {}) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const depth = new Map()
  const queue = []
  for (const id of roots) {
    if (byId.has(id) && !depth.has(id)) { depth.set(id, 0); queue.push(id) }
  }
  // Breadth-first traversal gives shortest import distance, including when
  // a dependency is shared, points back to the app, or participates in a cycle.
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    for (const target of importsOf.get(id) ?? []) {
      if (!byId.has(target) || depth.has(target)) continue
      depth.set(target, depth.get(id) + 1)
      queue.push(target)
    }
  }
  const groups = new Map()
  for (const node of nodes) {
    const level = depth.get(node.id) ?? null
    if (!groups.has(level)) groups.set(level, [])
    groups.get(level).push(node)
  }
  const parents = new Map(nodes.map((n) => [n.id, []]))
  for (const [id, targets] of importsOf) {
    if (!byId.has(id)) continue
    for (const target of new Set(targets)) parents.get(target)?.push(id)
  }
  const levels = []
  const rects = new Map()
  const ordered = [...groups.keys()].toSorted((a, b) => (a ?? Infinity) - (b ?? Infinity))
  const bytes = (node) => Number.isFinite(node.size) && node.size > 0 ? node.size : 0
  for (const level of ordered) {
    const members = groups.get(level).slice()
    // Keep children near their preceding-level parents to reduce crossings.
    const centers = new Map(members.map((n) => {
      const ps = parents.get(n.id).map((id) => rects.get(id)).filter((p) => p && level !== null && p.level === level - 1)
      return [n.id, ps.length > 0 ? ps.reduce((sum, p) => sum + p.x + p.width / 2, 0) / ps.length : width / 2]
    }))
    members.sort((a, b) => centers.get(a.id) - centers.get(b.id) || String(a.id).localeCompare(String(b.id)))
    // Anchor each row with its single largest dependency. Preserve the
    // connection-based order of the rest, including when sizes are tied.
    let largest = 0
    for (let i = 1; i < members.length; i++) {
      if (bytes(members[i]) > bytes(members[largest])) largest = i
    }
    if (largest > 0) members.unshift(members.splice(largest, 1)[0])
    const size = members.reduce((sum, n) => sum + bytes(n), 0)
    const y = levels.length * (rowHeight + gap)
    let x = 0
    for (const node of members) {
      // No minimum width: it would exaggerate small dependencies. Empty
      // files have zero area; an entirely size-less level falls back to equal
      // widths, explicitly reported by proportional=false on the level.
      const w = width * (size > 0 ? bytes(node) / size : 1 / members.length)
      rects.set(node.id, { id: node.id, level, x, y, width: w, height: rowHeight })
      x += w
    }
    levels.push({ level, y, size, proportional: size > 0, ids: members.map((n) => n.id) })
  }
  const edges = []
  for (const [from, targets] of importsOf) {
    if (!rects.has(from)) continue
    for (const to of new Set(targets)) {
      if (from !== to && rects.has(to)) edges.push({ from, to })
    }
  }
  edges.sort((a, b) => String(a.from).localeCompare(String(b.from)) || String(a.to).localeCompare(String(b.to)))
  const incoming = new Map(), outgoing = new Map()
  for (const edge of edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, [])
    if (!incoming.has(edge.to)) incoming.set(edge.to, [])
    outgoing.get(edge.from).push(edge)
    incoming.get(edge.to).push(edge)
  }
  for (const list of outgoing.values()) list.sort((a, b) => rects.get(a.to).x - rects.get(b.to).x)
  for (const list of incoming.values()) list.sort((a, b) => rects.get(a.from).x - rects.get(b.from).x)
  for (const list of outgoing.values()) list.forEach((e, i) => { e.sourcePort = (i + 1) / (list.length + 1) })
  for (const list of incoming.values()) list.forEach((e, i) => { e.targetPort = (i + 1) / (list.length + 1) })
  const totalSize = levels.reduce((sum, row) => sum + row.size, 0)
  for (const row of levels) row.share = totalSize > 0 ? row.size / totalSize : null
  return { levels, rects, edges, depth, totalSize, width, height: levels.length > 0 ? levels.length * (rowHeight + gap) - gap : 0, gap }
}
