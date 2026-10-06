import { bundlePackageDirs } from './bundle-sources.js'
import { bundleImportsAsMap, bundleLayerRoots } from './bundle-graph-inputs.js'
import { bundleReasons } from '../../common/bundle-reasons.js'
import { stronglyConnected } from './graph/matrix-model.js'
import { countsTowardsCycles } from './graph/cycle-imports.js'
import { WHY_DIALOG_GUTTER, layoutWhyGroup, routeWhyEdges } from './why-layout.js'

function packageNode(id, info = {}) {
  const ecosystem = info.ecosystem ?? (/(?:^|\/)node_modules\//u.test(id) ? 'npm' : '')
  const name = info.name || (id === '.' ? 'App' : id)
  return { id, name, ecosystem, version: info.version ?? '', own: id === '.', root: false, target: false }
}

const packageKeyOf = node => node.ecosystem && node.ecosystem !== 'npm' ? `${node.ecosystem}:${node.name}` : node.name

// Overview buckets use paths (including aliases and vendored directories).
// Resolve their recorded identity before asking why that package is bundled.
export function bundleWhyPackageKey(details, dir) {
  const info = details?.bundle?.modules.get(dir)
  return dir && dir !== '.' && info ? packageKeyOf(packageNode(dir, info)) : null
}

// The full graph groups npm packages by name. Here the installation directory
// is the identity: merging copies would invent routes between their importers.
// Omitting version selects every installed version of the package.
export function bundleWhy(details, { packageKey, version, reason = '' }) {
  const importedBy = new Map(), imports = new Map(), nodes = new Map()
  const dirs = bundlePackageDirs(details) ?? new Map()
  const allPaths = new Map([...dirs.keys()].map(path => [path, path]))
  const selected = bundleReasons(details).get(reason)
  const paths = new Map([...allPaths].filter(([path]) => !selected || selected.has(path)))
  for (const dir of new Set([...paths.keys()].map(path => dirs.get(path)))) {
    nodes.set(dir, packageNode(dir, details.bundle.modules.get(dir)))
  }
  const link = (from, to) => {
    if (from === to) return
    if (!imports.has(from)) imports.set(from, new Set())
    if (!importedBy.has(to)) importedBy.set(to, new Set())
    imports.get(from).add(to)
    importedBy.get(to).add(from)
  }
  for (const [parent, targets] of bundleImportsAsMap(details)) {
    if (!paths.has(parent)) continue
    // Use the cycle exclusions for dependency chains too. Filter before
    // package aggregation and reverse reachability, not just layout.
    for (const target of targets) {
      if (!paths.has(target)) continue
      const from = dirs.get(parent), to = dirs.get(target)
      if (countsTowardsCycles(parent, target, to === '.', from === '.')) link(from, to)
      else if (from !== to) {
        // The removed importer may disappear from the final graph. Retain its
        // identity so a deliberately cut chain is not reported as missing data.
        const node = nodes.get(to)
        node.excludedImporters ??= new Set()
        node.excludedImporters.add(from)
      }
    }
  }
  const { roots, appImports } = bundleLayerRoots(details, paths, path => dirs.get(path), dirs, allPaths)
  if (appImports.length > 0 && !nodes.has('.')) nodes.set('.', packageNode('.'))
  for (const target of appImports) link('.', target)
  // Why chains stop at own source and Babel, and at React Native when own
  // source imports that installation. Keep outgoing App edges, but do not follow
  // other parents or restore their edges when another path retains them.
  for (const [id, node] of nodes) {
    const stop = node.own || node.ecosystem === 'npm'
      && (node.name === '@babel/core' || node.name === 'react-native' && imports.get('.')?.has(id))
    if (!stop) continue
    node.traceBoundary = true
    const parents = importedBy.get(id)
    for (const parent of parents ?? []) {
      if (parent === '.') continue
      parents.delete(parent)
      imports.get(parent).delete(id)
    }
  }
  for (const root of roots) {
    const node = nodes.get(root === '__own__' ? '.' : root)
    if (node) node.root = true
  }
  const targets = []
  for (const node of nodes.values()) {
    const key = packageKeyOf(node)
    const matches = node.ecosystem === 'github' ? key.toLowerCase() === packageKey.toLowerCase() : key === packageKey
    const normalizedVersion = node.ecosystem === 'github' && node.version === '.' ? '0.0.0' : node.version
    if (!node.own && matches && (version === undefined || normalizedVersion === version)) { node.target = true; targets.push(node.id) }
  }
  // Reverse reachability retains every remaining route without enumerating an
  // exponential number of paths through diamonds or traversing cycles forever.
  const keep = new Set(targets), queue = [...targets]
  for (let i = 0; i < queue.length; i++) {
    for (const parent of importedBy.get(queue[i]) ?? []) {
      if (!keep.has(parent)) { keep.add(parent); queue.push(parent) }
    }
  }
  const keptLinks = links => new Map([...keep].map(id => [id, new Set([...(links.get(id) ?? [])].filter(to => keep.has(to)))]))
  return { nodes: new Map([...nodes].filter(([id]) => keep.has(id))), imports: keptLinks(imports), importedBy: keptLinks(importedBy), targets }
}

// Collapse strongly connected packages before assigning rows. Cards stay at a
// readable size; larger graphs scroll instead of shrinking names into dots.
export function layoutWhy(graph, { maxWidth = 1280, expandedCycles = new Set() } = {}) {
  const ids = [...graph.nodes.keys()].toSorted()
  const { groups, componentOf } = stronglyConnected(ids, graph.imports)
  const links = groups.map(() => new Set())
  const packageEdges = []
  for (const [from, targets] of graph.imports) {
    const a = componentOf.get(from)
    for (const to of targets) {
      const b = componentOf.get(to)
      if (a === b) continue
      links[a].add(b)
      packageEdges.push({ from: a, to: b, fromPackage: from, toPackage: to })
    }
  }
  const depth = groups.map(() => 0), incoming = groups.map(() => 0)
  for (const targets of links) for (const to of targets) incoming[to]++
  const queue = groups.flatMap((_, i) => incoming[i] === 0 ? [i] : [])
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i]
    for (const to of links[from]) {
      depth[to] = Math.max(depth[to], depth[from] + 1)
      if (--incoming[to] === 0) queue.push(to)
    }
  }
  // Reserve the dialog padding, graph margins and shortcut lanes before
  // choosing cycle columns. A large SCC must not overflow its viewport.
  const hasBypasses = links.some((targets, from) => [...targets].some(to => depth[to] !== depth[from] + 1))
  const cycleWidth = maxWidth - WHY_DIALOG_GUTTER - 24 - (hasBypasses ? 56 : 0)
  const rows = Map.groupBy(groups.map((members, id) => {
    const collapsible = members.length > 10
    return { ...layoutWhyGroup(id, members, graph.imports, cycleWidth, collapsible && !expandedCycles.has(id)), collapsible }
  }), group => depth[group.id])
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
  const edges = routeWhyEdges(boxes, packageEdges.map(edge => {
    const bypassLane = depth[edge.to] === depth[edge.from] + 1 ? null : width + 8 + (bypasses++ % 4) * 10
    return { ...edge, bypassLane }
  }))
  return { boxes: [...boxes.values()], componentOf, edges, width: width + (bypasses ? 56 : 0), height: Math.max(0, y - 24) }
}

export function traceWhy(layout, active) {
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
