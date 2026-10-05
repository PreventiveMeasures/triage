import { bundlePackageDirs } from './bundle-sources.js'
import { bundleImportsAsMap, bundleLayerRoots } from './bundle-graph-inputs.js'
import { bundleReasons } from '../../common/bundle-reasons.js'
import { stronglyConnected } from './graph/matrix-model.js'
import { countsTowardsCycles } from './graph/cycle-imports.js'
import { layoutDependencyGroup } from './dependency-chain-layout.js'

function packageNode(id, info = {}) {
  const ecosystem = info.ecosystem ?? (/(?:^|\/)node_modules\//u.test(id) ? 'npm' : '')
  const name = info.name || (id === '.' ? 'App' : id)
  return { id, name, ecosystem, version: info.version ?? '', own: id === '.', root: false, target: false }
}

// The full graph groups npm packages by name. Here the installation directory
// is the identity: merging copies would invent routes between their importers.
export function bundleDependencyChains(details, { packageKey, version, reason = '' }) {
  const cycleImports = new Map(), importedBy = new Map(), imports = new Map(), nodes = new Map()
  const dirs = bundlePackageDirs(details) ?? new Map()
  const allPaths = new Map([...dirs.keys()].map(path => [path, path]))
  const selected = bundleReasons(details).get(reason)
  const paths = new Map([...allPaths].filter(([path]) => !selected || selected.has(path)))
  for (const dir of new Set([...paths.keys()].map(path => dirs.get(path)))) {
    nodes.set(dir, packageNode(dir, details.bundle.modules.get(dir)))
  }
  const link = (from, to, cycle = true) => {
    if (from === to) return
    if (!imports.has(from)) imports.set(from, new Set())
    if (!importedBy.has(to)) importedBy.set(to, new Set())
    imports.get(from).add(to)
    importedBy.get(to).add(from)
    if (cycle) {
      if (!cycleImports.has(from)) cycleImports.set(from, new Set())
      cycleImports.get(from).add(to)
    }
  }
  for (const [parent, targets] of bundleImportsAsMap(details)) {
    if (!paths.has(parent)) continue
    for (const target of targets) if (paths.has(target)) link(dirs.get(parent), dirs.get(target), countsTowardsCycles(parent, target))
  }
  const { roots, appImports } = bundleLayerRoots(details, paths, path => dirs.get(path), dirs, allPaths)
  if (appImports.length > 0 && !nodes.has('.')) nodes.set('.', packageNode('.'))
  for (const target of appImports) link('.', target)
  for (const root of roots) {
    const node = nodes.get(root === '__own__' ? '.' : root)
    if (node) node.root = true
  }
  const targets = []
  for (const node of nodes.values()) {
    const key = node.ecosystem === 'npm' ? node.name : `${node.ecosystem}:${node.name}`
    const matches = node.ecosystem === 'github' ? key.toLowerCase() === packageKey.toLowerCase() : key === packageKey
    const auditedVersion = node.ecosystem === 'github' && node.version === '.' ? '0.0.0' : node.version
    if (!node.own && matches && auditedVersion === version) { node.target = true; targets.push(node.id) }
  }
  // Reverse reachability retains every recorded route without enumerating an
  // exponential number of paths through diamonds or traversing cycles forever.
  const keep = new Set(targets), queue = [...targets]
  for (let i = 0; i < queue.length; i++) {
    for (const parent of importedBy.get(queue[i]) ?? []) {
      if (!keep.has(parent)) { keep.add(parent); queue.push(parent) }
    }
  }
  const keptLinks = links => new Map([...keep].map(id => [id, new Set([...(links.get(id) ?? [])].filter(to => keep.has(to)))]))
  return { nodes: new Map([...nodes].filter(([id]) => keep.has(id))), imports: keptLinks(imports), cycleImports: keptLinks(cycleImports), importedBy: keptLinks(importedBy), targets }
}

// Collapse strongly connected packages before assigning rows. Cards stay at a
// readable size; larger graphs scroll instead of shrinking names into dots.
export function layoutDependencyChains(graph) {
  const ids = [...graph.nodes.keys()].toSorted()
  const cycleImports = graph.cycleImports ?? graph.imports
  const { groups, componentOf } = stronglyConnected(ids, cycleImports)
  const depth = groups.map(() => 0), incoming = groups.map(() => 0), links = groups.map(() => new Set())
  const cycleLinks = groups.map(() => new Set())
  for (const [from, targets] of graph.imports) {
    const a = componentOf.get(from)
    for (const to of targets) {
      const b = componentOf.get(to)
      if (a === b) continue
      links[a].add(b)
      if (cycleImports.get(from)?.has(to) && !cycleLinks[a].has(b)) { cycleLinks[a].add(b); incoming[b]++ }
    }
  }
  const queue = groups.flatMap((_, i) => incoming[i] === 0 ? [i] : [])
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i]
    for (const to of cycleLinks[from]) {
      depth[to] = Math.max(depth[to], depth[from] + 1)
      if (--incoming[to] === 0) queue.push(to)
    }
  }
  const rows = Map.groupBy(groups.map((members, id) => layoutDependencyGroup(id, members, graph.imports)), group => depth[group.id])
  const rowWidth = row => row.reduce((w, group) => w + group.width, 0) + Math.max(0, row.length - 1) * 20
  const width = [...rows.values()].reduce((w, row) => Math.max(w, rowWidth(row) + 24), 240)
  const boxes = new Map()
  let y = 12
  for (const [, row] of [...rows].toSorted(([a], [b]) => a - b)) {
    const height = row.reduce((h, group) => Math.max(h, group.height), 0)
    let x = (width - rowWidth(row)) / 2
    for (const group of row) { boxes.set(group.id, { ...group, x, y, rowBottom: y + height }); x += group.width + 20 }
    y += height + 36
  }
  let bypasses = 0
  const edges = links.flatMap((targets, from) => [...targets].map(to => {
    const a = boxes.get(from), b = boxes.get(to), x1 = a.x + a.width / 2, x2 = b.x + b.width / 2, y1 = a.y + a.height, y2 = b.y
    // Leave a mixed-height row vertically before turning, so a short card's
    // connections cannot cut through a taller cycle group beside it.
    const turn = a.rowBottom + 12
    if (depth[to] !== depth[from] + 1) {
      // A direct import that skips a row must go around intervening cards.
      // Manifest reads excluded from cycles can also point to an earlier row.
      const lane = width + 8 + (bypasses++ % 4) * 10
      return { from, to, path: `M${x1},${y1} L${x1},${turn} C${x1},${turn + 6} ${lane},${turn} ${lane},${turn + 6} L${lane},${y2 - 18} C${lane},${y2} ${x2},${y2 - 18} ${x2},${y2 - 5}` }
    }
    return { from, to, path: `M${x1},${y1} L${x1},${turn} C${x1},${turn + 6} ${x2},${y2 - 18} ${x2},${y2 - 5}` }
  }))
  return { boxes: [...boxes.values()], edges, width: width + (bypasses ? 56 : 0), height: Math.max(0, y - 24) }
}

export function traceDependencyChains(layout, active) {
  if (active === null) return null
  const edges = new Set(), groups = new Set([active])
  // Ancestors and descendants are separate walks. A sibling's imports and a
  // shortcut bypassing the focused package are not part of its chains.
  for (const reverse of [false, true]) {
    const links = new Map(), queue = [active], seen = new Set([active])
    for (const edge of layout.edges) {
      const from = reverse ? edge.to : edge.from, to = reverse ? edge.from : edge.to
      if (!links.has(from)) links.set(from, [])
      links.get(from).push(to)
    }
    for (let i = 0; i < queue.length; i++) {
      for (const to of links.get(queue[i]) ?? []) {
        if (!seen.has(to)) { seen.add(to); groups.add(to); queue.push(to) }
      }
    }
    for (const edge of layout.edges) if (seen.has(edge.from) && seen.has(edge.to)) edges.add(edge)
  }
  return { groups, edges }
}
