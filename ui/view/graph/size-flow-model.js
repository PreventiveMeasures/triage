import { pkgLabel } from '../bundle-pkg-of.js'
import { countsTowardsCycles } from './cycle-imports.js'
import { stronglyConnected } from './matrix-model.js'
import { removalSizes } from './size-flow-removal.js'
import { filterSizes } from './size-flow-filter.js'
import { MAX_FILE_EDGES, MAX_PACKAGE_EDGES, crowdedPackages } from './crowded-packages.js'
import { batchedReachability } from './size-flow-reachability.js'

const bytes = n => Number.isFinite(n) && n >= 0 ? n : 0

export const sizeFlowFilterSize = node => node.filterSize
export const sizeFlowConnector = (node, minSize) => Math.max(node.removable, node.own) < minSize && node.filterSize >= minSize

// Aim for at most 100 nodes, but don't take a step that would leave fewer
// than 50. Count both size-qualified nodes and their required entry-point
// paths. Filtering does not change the displayed bundle removal totals.
export function sizeFlowLargeThreshold(model) {
  if (model.byId.size <= 100) return 0
  const steps = [0, 1, 4, 10, 20, 50, 100, 200].map(n => n * 1024)
  const counts = steps.map(() => 0)
  for (const node of model.byId.values()) { for (let i = 0; i < steps.length; i++) {
    if (sizeFlowFilterSize(node) < steps[i]) break
    counts[i]++
  } }
  let step = 0
  while (step < steps.length - 1 && counts[step] > 100 && counts[step + 1] >= 50) step++
  return steps[step]
}

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
  // Cheap closures (trees and chains) are faster as walks/additions. Switch
  // to word-sized unions once repeated visits dominate graph preparation.
  const walkBudget = 8 * (groups.length + next.reduce((count, targets) => count + targets.size, 0))
  let stamp = 0, work = 0
  const sum = (starts, limited = false) => {
    if (++stamp === 0xffff_ffff) { marks.fill(0); stamp = 1 }
    let missing = 0, size = 0
    const stack = [...starts]
    while (stack.length > 0) {
      const id = stack.pop()
      if (marks[id] === stamp) continue
      if (limited && (work += 1 + next[id].size) > walkBudget) return null
      marks[id] = stamp; size += weights[id]; missing += unknown[id]
      for (const to of next[id]) if (marks[to] !== stamp) stack.push(to)
    }
    return { size, missing }
  }
  // Linear chains (including very deep ones) only need one addition per node.
  const reverse = order.toReversed()
  for (let i = 0; i < reverse.length; i++) {
    const id = reverse[i]
    const child = next[id].size === 1 ? totals.get([...next[id]][0]) : null
    const total = child ? { size: weights[id] + child.size, missing: unknown[id] + child.missing } : sum([id], true)
    if (total) totals.set(id, total)
    else {
      for (const [node, value] of batchedReachability(next, order, weights, unknown, reverse.slice(i))) totals.set(node, value)
      break
    }
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

function packageInstances(ids, files) {
  const installs = new Map()
  for (const id of ids) {
    const file = files.get(id), info = file.packageInfo
    if (!info) continue
    if (!installs.has(info.directory)) installs.set(info.directory, { ...info, size: 0, missing: 0 })
    const install = installs.get(info.directory)
    install.size += bytes(file.size)
    if (!file.virtual && file.size == null) install.missing++
  }
  return [...installs.values()].toSorted((a, b) => b.size - a.size || a.directory.localeCompare(b.directory))
}

export function buildSizeFlow(graph, { packages = false } = {}) {
  const { files, links, entries, weakEdges } = fileGraph(graph)
  const reach = reachability(files, links)
  const roots = entries.length > 0 ? [...new Set(entries)] : reach.inferred
  const active = new Set(roots), parents = new Map(), pending = [...roots]
  for (const id of pending) { for (const to of links.get(id)) { if (!active.has(to)) {
    active.add(to); pending.push(to); parents.set(to, id)
  } } }
  const byId = new Map(), idOf = file => `${packages ? 'p' : 'f'}:${packages ? files.get(file).pkg : file}`
  for (const file of active) {
    const id = idOf(file), n = files.get(file)
    if (!byId.has(id)) {byId.set(id, { id, pkg: n.pkg, label: packages ? pkgLabel(n.pkg) : file,
      version: packages ? undefined : n.packageInfo?.version, files: [], own: 0, virtual: true, incoming: [], outgoing: [] })}
    const row = byId.get(id)
    row.files.push(file); row.own += bytes(n.size); row.virtual &&= !!n.virtual
  }
  for (const row of byId.values()) {
    Object.assign(row, reach.sum(row.files))
    if (packages) row.instances = packageInstances(row.files, files)
  }
  removalSizes(files, links, roots, byId)
  filterSizes(byId, parents, idOf)
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
// Rows follow only the bars that are drawn: hidden and filtered nodes neither
// push their imports deeper nor keep otherwise unreachable bars in the flow.
function flowLevels(model, roots, shown) {
  const active = new Set(roots), pending = [...roots], rootSet = new Set(roots)
  for (const id of pending) { for (const e of model.byId.get(id).outgoing) {
    if (!active.has(e.to) && shown(e.to)) { active.add(e.to); pending.push(e.to) }
  } }
  const links = new Map(pending.map(id => [id, new Set(model.byId.get(id).outgoing.map(e => e.to).filter(to => active.has(to) && !rootSet.has(to)))]))
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

// Lay each set of ports along its bar, ordered by the opposite endpoints.
// Ribbons that fit sit side by side from the bar's left edge; otherwise spread
// overlapping intervals across the bar while keeping their centers ordered and
// their endpoints inside it.
function spreadFlowPorts(nodes, edges, byId) {
  const ports = new Map(nodes.map(n => [n.id, { from: [], to: [] }]))
  for (const edge of edges) { ports.get(edge.from).from.push(edge); ports.get(edge.to).to.push(edge) }
  for (const node of nodes) { for (const side of ['from', 'to']) {
    const incoming = side === 'to', position = incoming ? 'x2' : 'x1', width = incoming ? 'width2' : 'width1'
    const oppositeCenter = edge => { const other = byId.get(incoming ? edge.from : edge.to); return other.x + other.width / 2 }
    const list = ports.get(node.id)[side].toSorted((a, b) => oppositeCenter(a) - oppositeCenter(b) || a.id.localeCompare(b.id))
    if (list.length === 0) continue
    const total = list.reduce((sum, edge) => sum + edge[width], 0)
    let offset = 0
    if (total <= node.width) {
      for (const edge of list) { edge[position] = node.x + offset; offset += edge[width] }
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

// Ribbon pairs that cross with `left` before `right`, and with them swapped,
// given the sorted centers of each bar's importers.
function crossings(left, right) {
  let kept = 0, swapped = 0
  for (let i = 0, j = 0; i < left.length; i++) { while (j < right.length && right[j] < left[i]) j++; kept += j }
  for (let i = 0, j = 0; j < right.length; j++) { while (i < left.length && left[i] < right[j]) i++; swapped += i }
  return [kept, swapped]
}

// Bars start in size order. Neighbors swap only when that removes crossings
// with ribbons from the rows above, so a smaller bar moves left exactly when
// it untangles the flow. Rows settle top-down: the entry row keeps its size
// order and each row follows the rows already placed above it. A work budget
// bounds the cost on very large, tangled graphs.
function untangleBands(bands, edges, byId) {
  const upstream = new Map()
  for (const edge of edges) {
    const from = byId.get(edge.from), to = byId.get(edge.to)
    if (from.level === to.level) continue
    const [above, below] = from.level < to.level ? [from, to] : [to, from]
    if (!upstream.has(below)) upstream.set(below, [])
    upstream.get(below).push(above)
  }
  let budget = 1_000_000
  for (const band of bands.values()) {
    const ends = new Map(band.map(n => [n, (upstream.get(n) ?? []).map(above => above.x + above.width / 2).toSorted((a, b) => a - b)]))
    for (let pass = 0; pass < band.length && budget > 0; pass++) {
      let swapped = false
      for (let i = 0; i + 1 < band.length; i++) {
        const left = ends.get(band[i]), right = ends.get(band[i + 1])
        budget -= 1 + left.length + right.length
        const [kept, flipped] = crossings(left, right)
        if (flipped < kept) { [band[i], band[i + 1]] = [band[i + 1], band[i]]; swapped = true }
      }
      if (!swapped) break
    }
    let x = 0
    for (const n of band) { n.x = x; x += n.width }
  }
}

// Packages left out of the drawn flow, counted over the whole model so Large
// and focus never change whether they show (see crowded-packages.js).
export function sizeFlowHiddenPackages(model) {
  const pkg = id => model.byId.get(id).pkg
  return crowdedPackages(model.edges.map(e => [pkg(e.from), pkg(e.to)]), model.packages ? MAX_PACKAGE_EDGES : MAX_FILE_EDGES)
}

export function layoutSizeFlow(model, { focus = null, minSize = 0, width = 1100 } = {}) {
  const hiddenPackages = sizeFlowHiddenPackages(model)
  const shown = id => sizeFlowFilterSize(model.byId.get(id)) >= minSize && !hiddenPackages.has(model.byId.get(id).pkg)
  const roots = (focus && model.byId.has(focus) ? [focus] : model.roots).filter(shown)
  const levels = flowLevels(model, roots, shown)
  const candidates = [...levels.keys()]
    .filter(shown)
    .toSorted((a, b) => levels.get(a) - levels.get(b) || model.byId.get(b).removable - model.byId.get(a).removable || a.localeCompare(b))
  const visible = new Set(candidates)
  const edges = model.edges.filter(e => visible.has(e.from) && visible.has(e.to))
    .toSorted((a, b) => b.size - a.size || a.id.localeCompare(b.id)).map(e => ({ ...e }))
  const sized = [...visible].map(id => ({ ...model.byId.get(id), level: levels.get(id) }))
  const bands = Map.groupBy(sized, n => n.level), byId = new Map(sized.map(n => [n.id, n]))
  const maxSize = sized.reduce((max, n) => Math.max(max, n.removable), 1)
  // Bars share one byte scale and measure deletion impact from all entry
  // points, even while focusing. Overlapping ribbons never inflate a bar.
  const weight = n => Math.max(n, maxSize / 4000)
  const widest = [...bands.values()].reduce((max, band) => Math.max(max, band.reduce((s, n) => s + n.removable, 0)), 1)
  const rowStep = 88, scale = Math.max(1, width) / widest
  let actualWidth = 0, height = 0
  for (const n of sized) { n.y = 12 + n.level * rowStep; n.width = Math.max(.1, n.removable * scale); height = Math.max(height, n.y + 26) }
  untangleBands(bands, edges, byId)
  for (const band of bands.values()) {
    actualWidth = Math.max(actualWidth, band.reduce((x, n) => x + n.width, 0))
    // Row ends have no neighbor to share a border with (see paintNode).
    band.forEach((n, i) => { n.rowStart = i === 0; n.rowEnd = i === band.length - 1 })
  }
  // Keyboard navigation and paint order read each row left to right.
  const nodes = [...bands.values()].flat()
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
  return { nodes, byId, edges, roots, hiddenPackages, width: Math.max(1, actualWidth), height: height + 12 }
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
