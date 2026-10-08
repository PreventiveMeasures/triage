import { pkgLabel } from '../bundle-pkg-of.js'
import { countsTowardsCycles } from './cycle-imports.js'
import { stronglyConnected } from './matrix-model.js'
import { removalSizes } from './size-flow-removal.js'

const bytes = n => Number.isFinite(n) && n >= 0 ? n : 0

// Condense cycles before counting reachability. Each source byte contributes
// once to a node's total, even through diamonds, multiple entries, or cycles.
// Cache scalar totals, not a quadratic collection of per-file reachable sets.
function reachability(files, links) {
  const { groups, componentOf } = stronglyConnected([...files.keys()], links)
  const weights = groups.map(group => group.reduce((sum, id) => sum + bytes(files.get(id).size), 0))
  const unknown = groups.map(group => group.filter(id => !files.get(id).virtual && files.get(id).size == null).length)
  const incoming = groups.map(() => 0), next = groups.map(() => new Set())
  for (const [from, targets] of links) {for (const to of targets) {
    const a = componentOf.get(from), b = componentOf.get(to)
    if (a !== b && !next[a].has(b)) { next[a].add(b); incoming[b]++ }
  }}
  const indegree = [...incoming], order = []
  indegree.forEach((n, i) => { if (!n) order.push(i) })
  for (const id of order) for (const to of next[id]) if (--indegree[to] === 0) order.push(to)
  const marks = new Uint32Array(groups.length), totals = new Map()
  let stamp = 0
  const sum = (starts) => {
    if (++stamp === 0xffff_ffff) { marks.fill(0); stamp = 1 }
    let missing = 0, size = 0
    const stack = [...starts]
    while (stack.length > 0) {
      const id = stack.pop()
      if (marks[id] === stamp) continue
      marks[id] = stamp; size += weights[id]; missing += unknown[id]
      for (const to of next[id]) if (marks[to] !== stamp) stack.push(to)
    }
    return { size, missing }
  }
  // Linear chains (including very deep ones) only need one addition per node.
  for (const id of order.toReversed()) {
    const child = next[id].size === 1 ? totals.get([...next[id]][0]) : null
    totals.set(id, child ? { size: weights[id] + child.size, missing: unknown[id] + child.missing } : sum([id]))
  }
  return {
    inferred: groups.filter((_, i) => incoming[i] === 0).map(group => group[0]),
    sum(seeds) {
      const starts = new Set(seeds.map(id => componentOf.get(id)))
      return starts.size === 1 ? totals.get([...starts][0]) : sum(starts)
    },
  }
}

function fileGraph(graph) {
  const files = new Map(graph.nodes.map(n => [n.file, n]))
  const entries = graph.flowEntries ?? []
  for (const entry of entries) if (entry.virtual && !files.has(entry.file)) files.set(entry.file, { ...entry, size: 0 })
  const links = new Map([...files.keys()].map(id => [id, new Set()]))
  let weakEdges = 0
  for (const [id, node] of files) {for (const to of node.virtual ? node.imports : graph.importsOf.get(id) ?? []) {
    const target = files.get(to)
    if (!target || links.get(id).has(to)) continue
    const own = n => n.virtual ? n.pkg === '__own__' : graph.ownSourceFiles?.has(n.file)
    if (!countsTowardsCycles(node.origFile ?? id, target.origFile ?? to, own(target), own(node))) { weakEdges++; continue }
    links.get(id).add(to)
  }}
  return { files, links, entries: entries.filter(n => n.entry !== false).map(n => n.file).filter(id => files.has(id)), weakEdges }
}

export function buildSizeFlow(graph, { packages = false } = {}) {
  const { files, links, entries, weakEdges } = fileGraph(graph)
  const reach = reachability(files, links)
  const roots = entries.length > 0 ? [...new Set(entries)] : reach.inferred
  const active = new Set(roots), pending = [...roots]
  for (const id of pending) for (const to of links.get(id)) if (!active.has(to)) { active.add(to); pending.push(to) }
  const byId = new Map(), idOf = file => `${packages ? 'p' : 'f'}:${packages ? files.get(file).pkg : file}`
  for (const file of active) {
    const id = idOf(file), n = files.get(file)
    if (!byId.has(id)) {byId.set(id, { id, pkg: n.pkg, label: packages ? pkgLabel(n.pkg) : file,
      files: [], own: 0, virtual: true, incoming: [], outgoing: [] })}
    const row = byId.get(id)
    row.files.push(file); row.own += bytes(n.size); row.virtual &&= !!n.virtual
  }
  for (const row of byId.values()) Object.assign(row, reach.sum(row.files))
  removalSizes(files, links, roots, byId)
  const pairs = new Map()
  for (const from of active) {for (const to of links.get(from)) {
    const a = idOf(from), b = idOf(to)
    if (packages && a === b) continue
    const id = JSON.stringify([a, b])
    if (!pairs.has(id)) pairs.set(id, { id, from: a, to: b, targets: new Set(), count: 0 })
    const edge = pairs.get(id)
    edge.targets.add(to); edge.count++
  }}
  const edges = [...pairs.values()]
  for (const edge of edges) {
    // Package edges carry the union of the actual imported files' closures,
    // not every file in the destination package or a package-level closure.
    Object.assign(edge, reach.sum([...edge.targets]))
    byId.get(edge.from).outgoing.push(edge); byId.get(edge.to).incoming.push(edge)
  }
  const rootIds = [...new Set(roots.map(idOf))]
  return { byId, edges, edgeById: pairs, roots: rootIds, files, packages, weakEdges, inferred: entries.length === 0,
    total: reach.sum(roots), omittedFiles: files.size - active.size }
}

// Longest-path ranks keep ordinary imports flowing down, including diamonds
// and direct + indirect imports of the same module. Only entries are pinned;
// cycles share a rank and retain explicit return ribbons.
function flowLevels(model, roots) {
  const active = new Set(roots), pending = [...roots], rootSet = new Set(roots)
  for (const id of pending) for (const e of model.byId.get(id).outgoing) if (!active.has(e.to)) { active.add(e.to); pending.push(e.to) }
  const links = new Map(pending.map(id => [id, new Set(model.byId.get(id).outgoing.map(e => e.to).filter(to => !rootSet.has(to)))]))
  const { componentOf, groups } = stronglyConnected(pending, links)
  const incoming = groups.map(() => 0), next = groups.map(() => new Set()), ranks = groups.map(() => 0)
  for (const [from, targets] of links) { for (const to of targets) {
    const a = componentOf.get(from), b = componentOf.get(to)
    if (a !== b && !next[a].has(b)) { next[a].add(b); incoming[b]++ }
  } }
  const queue = []
  incoming.forEach((n, i) => { if (!n) queue.push(i) })
  for (const id of queue) { for (const to of next[id]) {
    ranks[to] = Math.max(ranks[to], ranks[id] + 1)
    if (--incoming[to] === 0) queue.push(to)
  } }
  return new Map(pending.map(id => [id, ranks[componentOf.get(id)]]))
}

// Use the whole bar for each set of ports, ordered by the opposite endpoints.
// Pack without overlap when possible; otherwise spread overlapping intervals
// while keeping their centers ordered and their endpoints inside the bar.
function spreadFlowPorts(nodes, edges, byId) {
  const ports = new Map(nodes.map(n => [n.id, { from: [], to: [] }]))
  for (const edge of edges) { ports.get(edge.from).from.push(edge); ports.get(edge.to).to.push(edge) }
  for (const node of nodes) { for (const side of ['from', 'to']) {
    const incoming = side === 'to', position = incoming ? 'x2' : 'x1', width = incoming ? 'width2' : 'width1'
    const oppositeCenter = edge => { const other = byId.get(incoming ? edge.from : edge.to); return other.x + other.width / 2 }
    const list = ports.get(node.id)[side].toSorted((a, b) => oppositeCenter(a) - oppositeCenter(b) || a.id.localeCompare(b.id))
    if (list.length === 0) continue
    if (list.length === 1) { list[0][position] = node.x + (node.width - list[0][width]) / 2; continue }
    const total = list.reduce((sum, edge) => sum + edge[width], 0)
    let offset = 0
    if (total <= node.width) {
      const gap = (node.width - total) / (list.length - 1)
      for (const edge of list) { edge[position] = node.x + offset; offset += edge[width] + gap }
      continue
    }
    const first = list[0][width] / 2, last = list.at(-1)[width] / 2
    const span = total - first - last, upper = new Float64Array(list.length)
    let limit = node.width, previous = 0
    for (let i = list.length - 1; i >= 0; i--) { limit = Math.min(limit, node.width - list[i][width] / 2); upper[i] = limit }
    for (let i = 0; i < list.length; i++) {
      const edge = list[i], half = edge[width] / 2
      const desired = first + (offset + half - first) / span * (node.width - first - last)
      const center = Math.min(upper[i], Math.max(previous, half, desired))
      edge[position] = node.x + center - half
      previous = center; offset += edge[width]
    }
  } }
}

export function layoutSizeFlow(model, { focus = null, minSize = 0, width = 1100 } = {}) {
  const roots = focus && model.byId.has(focus) ? [focus] : model.roots
  const levels = flowLevels(model, roots)
  const candidates = [...levels.keys()]
    .filter(id => model.byId.get(id).size >= minSize)
    .toSorted((a, b) => levels.get(a) - levels.get(b) || model.byId.get(b).removable - model.byId.get(a).removable || a.localeCompare(b))
  const visible = new Set(candidates)
  const edges = model.edges.filter(e => visible.has(e.from) && visible.has(e.to))
    .toSorted((a, b) => b.size - a.size || a.id.localeCompare(b.id)).map(e => ({ ...e }))
  const nodes = [...visible].map(id => ({ ...model.byId.get(id), level: levels.get(id) }))
  const bands = Map.groupBy(nodes, n => n.level), byId = new Map(nodes.map(n => [n.id, n]))
  const maxSize = nodes.reduce((max, n) => Math.max(max, n.removable), 1)
  // Bars share one byte scale and measure deletion impact from all entry
  // points, even while focusing. Overlapping ribbons never inflate a bar.
  const weight = n => Math.max(n, maxSize / 4000)
  const widest = [...bands.values()].reduce((max, band) => Math.max(max, band.reduce((s, n) => s + n.removable, 0)), 1)
  const rowStep = 88, scale = Math.max(1, width) / widest
  let actualWidth = 0, height = 0
  for (const band of bands.values()) {
    let x = 0
    for (const n of band) { n.x = x; n.y = 12 + n.level * rowStep; n.width = Math.max(1.5, n.removable * scale); x += n.width; height = Math.max(height, n.y + 26) }
    actualWidth = Math.max(actualWidth, x)
  }
  for (const edge of edges) {
    const from = byId.get(edge.from), to = byId.get(edge.to)
    const ribbonWidth = weight(edge.size) * scale
    edge.width1 = Math.min(ribbonWidth, from.width); edge.width2 = Math.min(ribbonWidth, to.width)
    edge.x1 = from.x + (from.width - edge.width1) / 2; edge.x2 = to.x + (to.width - edge.width2) / 2
    edge.y1 = from.y + 26; edge.y2 = to.y
    edge.returning = to.level <= from.level
    if (edge.returning) height = Math.max(height, Math.max(edge.y1, edge.y2) + 35)
  }
  spreadFlowPorts(nodes, edges, byId)
  return { nodes, byId, edges, roots, width: Math.max(1, actualWidth), height: height + 12 }
}

// Keep one byte scale across all rows, while filling the viewport horizontally
// even when fitting full depth requires a much smaller vertical zoom. Resize
// geometry, not the SVG's aspect ratio, so glyphs keep their normal proportions.
export function fitSizeFlowWidth(layout, width, height) {
  if (!(width > 0 && height > 0)) return layout
  const zoom = Math.min(width / 1100, height / layout.height, 9.99)
  const targetWidth = width / zoom
  if (Math.abs(targetWidth - layout.width) < 1e-7) return layout
  const factor = targetWidth / layout.width
  const nodes = layout.nodes.map(n => ({ ...n, x: n.x * factor, width: n.width * factor }))
  const edges = layout.edges.map(e => ({ ...e, x1: e.x1 * factor, x2: e.x2 * factor,
    width1: e.width1 * factor, width2: e.width2 * factor }))
  return { ...layout, nodes, edges, byId: new Map(nodes.map(n => [n.id, n])), width: targetWidth }
}

export function flowRibbon(edge) {
  const { x1, x2, y1, y2, width1, width2 } = edge
  const bend = edge.returning ? Math.max(y1, y2) + 35 : (y1 + y2) / 2
  return `M${x1},${y1} C${x1},${bend} ${x2},${bend} ${x2},${y2} L${x2 + width2},${y2} C${x2 + width2},${bend} ${x1 + width1},${bend} ${x1 + width1},${y1} Z`
}
