import assert from 'node:assert/strict'
import { test } from 'node:test'
import { layoutFilesVogel, layoutSpiral } from '../ui/view/graph/layout.js'
import { optimizeSunflowerOrder } from '../ui/view/graph/sunflower-order.js'

function graphFromPairs(count, pairs, packageOf = () => 'app') {
  const nodes = Array.from({ length: count }, (_, i) => ({ file: String(i), pkg: packageOf(i), deg: 0, isHub: i === 0, x: i, y: 0 }))
  const nodeByFile = new Map(nodes.map(node => [node.file, node]))
  const importedBy = new Map(nodes.map(node => [node.file, []])), importsOf = new Map(nodes.map(node => [node.file, []]))
  const edges = pairs.map(([a, b]) => {
    nodes[a].deg++; nodes[b].deg++
    importsOf.get(String(a)).push(String(b)); importedBy.get(String(b)).push(String(a))
    return { a: String(a), b: String(b), cross: nodes[a].pkg !== nodes[b].pkg }
  })
  const byPkg = new Map()
  for (const node of nodes) {
    if (!byPkg.has(node.pkg)) byPkg.set(node.pkg, [])
    byPkg.get(node.pkg).push(node)
  }
  const packages = [...byPkg.keys()].toSorted((a, b) => byPkg.get(b).length - byPkg.get(a).length)
  return { nodes, nodeByFile, edges, importsOf, importedBy, byPkg, packages, pkgCount: new Map([...byPkg].map(([pkg, members]) => [pkg, members.length])) }
}

function edgeLength(graph) {
  return graph.edges.reduce((sum, edge) => {
    const a = graph.nodeByFile.get(edge.a), b = graph.nodeByFile.get(edge.b)
    return sum + Math.hypot(a.x - b.x, a.y - b.y)
  }, 0)
}

const positions = nodes => nodes.map(node => [node.x, node.y])
const slots = nodes => positions(nodes).toSorted(([ax, ay], [bx, by]) => ax - bx || ay - by)

// The pre-optimization assignment, also specifying the unchanged flat grid.
function degreeLayout(graph, w = 1000, h = 800) {
  const ownRank = node => node.pkg === '__own__' || graph.ownSourcePackages?.has(node.pkg)
    ? graph.entryPackages?.has(node.pkg) ? 0 : 1 : 2
  const sorted = graph.nodes.toSorted((a, b) => ownRank(a) - ownRank(b) || b.deg - a.deg)
  const unitToPx = Math.min(w, h) / 2
  sorted.forEach((node, i) => {
    const angle = (i * 137.508 % 360) * Math.PI / 180
    const band = Math.sqrt(i / Math.max(1, sorted.length - 1))
    node.x = w / 2 + Math.cos(angle) * band * 0.85 * unitToPx
    node.y = h / 2 + Math.sin(angle) * band * 0.85 * unitToPx
  })
}

for (const count of [1, 3, 1000]) {
  test(`${count} own-code packages retain the central slots while edges shorten`, () => {
    const graph = fixture('clusters', 1000)
    for (const [i, node] of graph.nodes.entries()) node.pkg = `pkg${i}`
    graph.ownSourcePackages = new Set(graph.nodes.slice(-count).map(node => node.pkg))
    const dependencies = graph.nodes.slice(0, -count), own = graph.nodes.slice(-count)
    degreeLayout(graph)
    const before = edgeLength(graph), dependencySlots = slots(dependencies), ownSlots = slots(own)
    layoutFilesVogel(graph, 1000, 800)
    assert.deepEqual(slots(own), ownSlots, 'own packages can only exchange the central slots')
    assert.deepEqual(slots(dependencies), dependencySlots, 'dependencies retain all the outer slots')
    assert.ok(edgeLength(graph) < before * 0.4, 'edge optimization still improves the constrained assignment')
    if (count === 1) assert.deepEqual(positions(own), [[500, 400]])
    const first = positions(graph.nodes)
    layoutFilesVogel(graph, 1000, 800)
    assert.deepEqual(positions(graph.nodes), first)
  })
}

test('an isolated own-source package stays at the center despite higher-degree dependencies', () => {
  const graph = graphFromPairs(100, Array.from({ length: 98 }, (_, i) => [i, 98]), i => i === 99 ? '__own__' : `dep${i}`)
  layoutFilesVogel(graph, 1000, 800)
  assert.deepEqual(positions(graph.nodes.slice(-1)), [[500, 400]])
})

for (const count of [1, 2]) {
  test(`${count} own entry packages precede other own packages and dependencies on the unchanged grid`, () => {
    const graph = fixture('clusters', 1000)
    for (const [i, node] of graph.nodes.entries()) node.pkg = `pkg${i}`
    graph.ownSourcePackages = new Set(graph.nodes.slice(-10).map(node => node.pkg))
    graph.entryPackages = new Set([...graph.nodes.slice(-count), graph.nodes[0]].map(node => node.pkg))
    const groups = [graph.nodes.slice(-count), graph.nodes.slice(-10, -count), graph.nodes.slice(0, -10)]
    degreeLayout(graph)
    const before = edgeLength(graph), grids = groups.map(slots)
    layoutFilesVogel(graph, 1000, 800)
    assert.deepEqual(groups.map(slots), grids, 'entry, own-source and dependency groups retain their exact slots')
    assert.ok(edgeLength(graph) < before * 0.4)
    if (count === 1) assert.deepEqual(positions(groups[0]), [[500, 400]])
  })
}

function random(seed = 12345) {
  return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
}

function fixture(kind, count) {
  const next = random(), pairs = new Map()
  const add = (a, b) => {
    if (a !== b) pairs.set(`${Math.min(a, b)}:${Math.max(a, b)}`, [a, b])
  }
  for (let i = 0; i < count; i++) {
    if (kind === 'chain') add(i, (i + 1) % count)
    else if (kind === 'star') add(0, i)
    else if (kind === 'tree') { if (i) add(i, Math.floor((i - 1) / 3)) }
    else if (kind === 'clusters') {
      for (let j = 0; j < 5; j++) add(i, Math.floor(i / 50) * 50 + next() % 50)
      if (i && i % 50 === 0) add(i, i - 50)
    } else {
      for (let j = 0; j < (kind === 'dense' ? 100 : 4); j++) add(i, next() % count)
    }
  }
  return graphFromPairs(count, [...pairs.values()])
}

for (const [kind, ratio] of [['chain', 0.3], ['tree', 0.4], ['clusters', 0.4], ['random', 0.85], ['star', 1.000000001], ['dense', 1]]) {
  test(`1000-node ${kind}: shorter edges on the exact same grid`, () => {
    const graph = fixture(kind, 1000)
    degreeLayout(graph)
    const before = edgeLength(graph), grid = slots(graph.nodes), nodes = graph.nodes.slice()
    layoutFilesVogel(graph, 1000, 800)
    assert.deepEqual(slots(graph.nodes), grid)
    assert.ok(graph.nodes.every((node, i) => node === nodes[i]), 'node identity and array order stay intact')
    assert.ok(edgeLength(graph) <= before * ratio, `${kind}: ${edgeLength(graph)} vs ${before}`)
    const first = positions(graph.nodes)
    layoutFilesVogel(graph, 1000, 800)
    assert.deepEqual(positions(graph.nodes), first, 'repeated layouts make the same assignments')
  })
}

test('nested sunflower preserves the hub/member slot geometry and allows swaps between those bands', () => {
  const graph = fixture('chain', 100)
  // One entry package: the original disk is centered at (500, 400), radius
  // 0.22 * 400 = 88, with one hub at its center and members in the outer band.
  const expected = [[500, 400]]
  for (let i = 1; i < 100; i++) {
    const angle = i * 137.508 * Math.PI / 180
    const radius = (0.4 + Math.sqrt((i - 1) / 98) * 0.6) * 88
    expected.push([500 + Math.cos(angle) * radius, 400 + Math.sin(angle) * radius])
  }
  layoutSpiral(graph, 1000, 800)
  assert.deepEqual(slots(graph.nodes), expected.toSorted(([ax, ay], [bx, by]) => ax - bx || ay - by))
  assert.notDeepEqual([graph.nodes[0].x, graph.nodes[0].y], [500, 400], 'a low-degree hub is not pinned to the center')
})

test('within-disk swaps account for external edges, including fixed singleton disks', () => {
  const graph = graphFromPairs(3, [[0, 1], [0, 2]], i => i < 2 ? 'inner' : 'anchor')
  graph.nodes[0].x = 0; graph.nodes[1].x = 10; graph.nodes[2].x = 100
  const before = edgeLength(graph)
  optimizeSunflowerOrder(graph, [...graph.byPkg.values()])
  assert.deepEqual(positions(graph.nodes), [[10, 0], [0, 0], [100, 0]])
  assert.ok(edgeLength(graph) < before)
})

test('every disk retains its own slots and total edge length never increases', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const next = random(seed), pairs = Array.from({ length: 100 }, () => [next() % 30, next() % 30])
    const graph = graphFromPairs(30, pairs, i => String(i % 3))
    for (const node of graph.nodes) { node.x = next() % 300; node.y = next() % 200 }
    const before = edgeLength(graph), groups = [...graph.byPkg.values()]
    const grids = groups.map(slots)
    optimizeSunflowerOrder(graph, groups)
    assert.deepEqual(groups.map(slots), grids)
    assert.ok(edgeLength(graph) <= before + 1e-8)
  }
})

test('no-edge, singleton, mutual-edge and self-loop graphs need no swaps', () => {
  for (const [count, pairs] of [[0, []], [1, [[0, 0]]], [2, [[0, 1], [1, 0], [0, 0]]], [30, []]]) {
    const graph = graphFromPairs(count, pairs)
    const before = positions(graph.nodes)
    optimizeSunflowerOrder(graph, [graph.nodes])
    assert.deepEqual(positions(graph.nodes), before)
    layoutFilesVogel(graph, 0, 0)
    assert.ok(graph.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)))
  }
})
