// Sparse dependency matrix: O(files + imports) storage, never an N × N array.
// Rows import columns. Expanded packages retain their external connections.
import { orderCyclicGroup } from './matrix-order.js'

export function stronglyConnected(ids, links) {
  const known = new Set(ids), reverse = new Map(ids.map((id) => [id, []]))
  for (const [from, targets] of links) {
    for (const to of targets) if (known.has(from) && known.has(to)) reverse.get(to).push(from)
  }
  const finish = [], seen = new Set()
  for (const start of ids) {
    if (seen.has(start)) continue
    seen.add(start)
    const stack = [[start, (links.get(start) ?? [])[Symbol.iterator]()]]
    while (stack.length > 0) {
      const [id, iter] = stack.at(-1), next = iter.next()
      if (next.done) { finish.push(id); stack.pop(); continue }
      if (known.has(next.value) && !seen.has(next.value)) {
        seen.add(next.value)
        stack.push([next.value, (links.get(next.value) ?? [])[Symbol.iterator]()])
      }
    }
  }
  const componentOf = new Map(), groups = []
  for (const start of finish.toReversed()) {
    if (componentOf.has(start)) continue
    const group = [], index = groups.length, stack = [start]
    componentOf.set(start, index)
    while (stack.length > 0) {
      const id = stack.pop()
      group.push(id)
      for (const next of reverse.get(id)) {
        if (!componentOf.has(next)) { componentOf.set(next, index); stack.push(next) }
      }
    }
    groups.push(group.toSorted())
  }
  return { groups, componentOf }
}

export function buildDependencyMatrix(graph, { expanded = new Set(), order = 'structure', query = '', neighborhood = null, cyclesOnly = false } = {}) {
  const byId = new Map(), fileRow = new Map()
  for (const file of graph.nodes) {
    const isFile = expanded.has(file.pkg)
    const id = `${isFile ? 'f' : 'p'}:${isFile ? file.file : file.pkg}`
    if (!byId.has(id)) {
      byId.set(id, { id, pkg: file.pkg, file: isFile ? file.file : null,
        label: isFile ? file.file : file.pkg === '__own__' ? 'own source' : file.pkg,
        files: [], size: 0, issues: 0, incoming: 0, outgoing: 0 })
    }
    const row = byId.get(id)
    row.files.push(file.file)
    row.size += file.size ?? 0
    row.issues += file.totalIssues ?? 0
    fileRow.set(file.file, id)
  }
  const cells = new Map(), incoming = new Set(), links = new Map([...byId.keys()].map((id) => [id, new Set()])), outgoing = new Set()
  let importCount = 0
  for (const [file, imports] of graph.importsOf) {
    const from = fileRow.get(file)
    if (!from) continue
    for (const target of new Set(imports)) {
      const to = fileRow.get(target)
      if (!to) continue
      if (!cells.has(from)) cells.set(from, new Map())
      if (!cells.get(from).has(to)) cells.get(from).set(to, { from, to, count: 0, examples: [] })
      const cell = cells.get(from).get(to)
      cell.count++
      if (cell.examples.length < 80) cell.examples.push([file, target])
      importCount++
      byId.get(from).outgoing++; byId.get(to).incoming++
      if (from !== to) { outgoing.add(from); incoming.add(to) }
      // A collapsed package's internal imports do not imply a cycle.
      if (from !== to || byId.get(from).file) links.get(from).add(to)
    }
  }
  const ids = [...byId.keys()].toSorted()
  const { groups, componentOf } = stronglyConnected(ids, links)
  const cyclic = new Set(groups.flatMap((group) => group.length > 1 || links.get(group[0]).has(group[0]) ? group : []))
  for (const row of byId.values()) { row.cyclic = cyclic.has(row.id); row.component = componentOf.get(row.id) }
  const appPackages = new Set(graph.layerRoots?.roots ?? [])
  const appRank = (row) => row.pkg === '__own__' ? 0 : appPackages.has(row.pkg) ? 1 : 2
  const boundaryRank = (row) => incoming.has(row.id) && outgoing.has(row.id) ? 0 : 1
  const componentAppRank = new Map(groups.map((members, component) =>
    [component, members.reduce((rank, id) => Math.min(rank, appRank(byId.get(id))), 2)]))
  const alphabetical = (a, b) => a.pkg.localeCompare(b.pkg) || a.label.localeCompare(b.label)
  const cycleOrder = new Map()
  if (order === 'structure') {
    for (const members of groups) {
      if (members.length < 2) continue
      // App remains first. Within each priority, minimize backward imports
      // without moving any member outside its strongly connected group.
      for (const peers of Map.groupBy(members, (id) => appRank(byId.get(id))).values()) {
        const baseline = peers.toSorted((a, b) => alphabetical(byId.get(a), byId.get(b)))
        orderCyclicGroup(baseline, cells).forEach((id, i) => cycleOrder.set(id, i))
      }
    }
  }
  for (const [from, targets] of cells) {
    for (const cell of targets.values()) {
      cell.cyclic = cyclic.has(from) && componentOf.get(from) === componentOf.get(cell.to)
        && (from !== cell.to || byId.get(from).file !== null)
    }
  }
  const q = query.trim().toLowerCase()
  const matches = new Set(ids.filter((id) => !q || byId.get(id).files.some((f) => f.toLowerCase().includes(q)) || byId.get(id).label.toLowerCase().includes(q)))
  const keep = new Set(neighborhood ? [neighborhood] : matches)
  // A search result retains immediate neighbors, so its dependencies stay legible.
  if (q || neighborhood) {
    for (const [from, targets] of links) {
      for (const to of targets) {
        if (neighborhood ? from === neighborhood : matches.has(from)) keep.add(to)
        if (neighborhood ? to === neighborhood : matches.has(to)) keep.add(from)
      }
    }
  }
  const compare = (a, b) => {
    // All own-source directories/files precede dependencies, even when a
    // dependency shares a cycle with one directory but not the others.
    const appDiff = appRank(a) - appRank(b)
    if (appDiff) return appDiff
    if (order === 'structure') {
      // Keep cycle members together within the own-source/dependency sections.
      const componentDiff = componentAppRank.get(a.component) - componentAppRank.get(b.component)
      if (componentDiff) return componentDiff
      const boundaryDiff = boundaryRank(a) - boundaryRank(b)
      if (boundaryDiff) return boundaryDiff
      const diff = a.component - b.component // Kosaraju returns condensation DAG order.
      if (diff) return diff
    }
    const boundaryDiff = boundaryRank(a) - boundaryRank(b)
    if (boundaryDiff) return boundaryDiff
    if (order === 'structure' && a.component === b.component) {
      const diff = (cycleOrder.get(a.id) ?? 0) - (cycleOrder.get(b.id) ?? 0)
      if (diff) return diff
    }
    if (order === 'importers' && a.incoming !== b.incoming) return b.incoming - a.incoming
    if (order === 'imports' && a.outgoing !== b.outgoing) return b.outgoing - a.outgoing
    return alphabetical(a, b)
  }
  const rows = [...byId.values()].filter((n) => keep.has(n.id) && (!cyclesOnly || n.cyclic)).toSorted(compare)
  const index = new Map(rows.map((row, i) => [row.id, i]))
  const visibleCells = []
  for (const [from, targets] of cells) {
    if (!index.has(from)) continue
    for (const cell of targets.values()) {
      if (index.has(cell.to)) {
        visibleCells.push({ ...cell, row: index.get(from), col: index.get(cell.to) })
      }
    }
  }
  return { rows, byId, cells, visibleCells, index, matches, importCount, totalRows: byId.size,
    cycleCount: groups.filter((g) => cyclic.has(g[0])).length }
}
