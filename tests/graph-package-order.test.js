import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import '../ui/view/frontend-install.js'
import { buildGraph } from '../ui/view/graph/data.js'
import { optimizePackageRings } from '../ui/view/graph/package-order.js'
import { makeLargeGraph } from '../examples/large-graph-sample.js'

// Capture the real outer seed before refinement, so the integration test checks
// its ring/size/spacing contract without duplicating the layout formulas.
let captured
mock.module('../ui/view/graph/package-order.js', { exports: {
  optimizePackageRings(info, links, rings) {
    captured = { after: info, before: structuredClone(info), neighbors: links, rings }
    optimizePackageRings(info, links, rings)
  },
} })
const { layoutSpiral } = await import('../ui/view/graph/layout.js')

function neighbors(pairs) {
  const result = new Map()
  for (const [a, b, weight = 1] of pairs) {
    if (!result.has(a)) result.set(a, new Map())
    if (!result.has(b)) result.set(b, new Map())
    result.get(a).set(b, weight); result.get(b).set(a, weight)
  }
  return result
}

function length(info, edges) {
  let total = 0
  for (const [a, adjacent] of edges) {
    for (const b of adjacent.keys()) {
      if (a < b) total += Math.hypot(info.get(a).x - info.get(b).x, info.get(a).y - info.get(b).y)
    }
  }
  return total
}

function preservesDisks(before, after, rings) {
  const points = (info, ring) => ring.map(pkg => [info.get(pkg).x, info.get(pkg).y]).toSorted(([ax, ay], [bx, by]) => ax - bx || ay - by)
  const movable = new Set(rings.flat())
  for (const ring of rings) assert.deepEqual(points(after, ring), points(before, ring), 'each ring retains exactly its original slots')
  for (const [pkg, disk] of before) {
    assert.equal(after.get(pkg).groupR, disk.groupR)
    assert.equal(after.get(pkg).size, disk.size)
    if (!movable.has(pkg)) assert.deepEqual(after.get(pkg), disk, 'the center stays pinned')
  }
  const atSlot = new Map([...after.values()].map(disk => [`${disk.x}:${disk.y}`, disk]))
  const disks = [...before.values()]
  for (let i = 0; i < disks.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = disks[i], b = disks[j], nextA = atSlot.get(`${a.x}:${a.y}`), nextB = atSlot.get(`${b.x}:${b.y}`)
      const distance = Math.hypot(a.x - b.x, a.y - b.y)
      const previousOverlap = Math.max(0, a.groupR + b.groupR - distance)
      assert.ok(Math.max(0, nextA.groupR + nextB.groupR - distance) <= previousOverlap + 1e-7,
        'no pair of occupied slots has increased overlap')
    }
  }
}

for (const [nearX, smallRadius, swaps] of [[115, 5, false], [140, 5, true], [115, 30, true]]) {
  test(`a larger disk needs space at the new slot (${nearX}, radius ${smallRadius})`, () => {
    const info = new Map([
      ['a', { x: 0, y: 0, groupR: 30, size: 100 }], ['b', { x: 100, y: 0, groupR: smallRadius, size: 2 }],
      ['near', { x: nearX, y: 0, groupR: 5, size: 1 }], ['anchor', { x: 200, y: 0, groupR: 5, size: 1 }],
    ])
    const before = structuredClone(info), edges = neighbors([['a', 'anchor']]), rings = [['a', 'b']]
    optimizePackageRings(info, edges, rings)
    assert.equal(info.get('a').x, swaps ? 100 : 0)
    assert.equal(info.get('b').x, swaps ? 0 : 100)
    preservesDisks(before, info, rings)
    assert.ok(length(info, edges) <= length(before, edges))
  })
}

test('each package pair counts once, regardless of how many file imports it has', () => {
  const initial = new Map([
    ['a', { x: 100, y: 0, groupR: 1 }], ['b', { x: 0, y: 0, groupR: 1 }],
    ['left', { x: -100, y: 0, groupR: 1 }], ['right', { x: 200, y: 0, groupR: 1 }],
  ])
  for (const weight of [1, 1000]) {
    const edges = neighbors([['a', 'left'], ['a', 'right', weight], ['b', 'right']]), info = structuredClone(initial)
    optimizePackageRings(info, edges, [['a', 'b']])
    assert.equal(info.get('a').x, 0, 'the shorter unique-edge assignment wins even when the weighted sum would increase')
    assert.equal(length(info, edges), 400)
    preservesDisks(initial, info, [['a', 'b']])
  }
})

test('nested layout refines the real size-aware rings while keeping the center and disk grid', () => {
  const input = makeLargeGraph({ fileCount: 3000, packageCount: 150, edgeCount: 8000 })
  const tree = Object.fromEntries([...input.importsOf].map(([file, imports]) => [file, { imports }]))
  const graph = buildGraph(tree, [...input.nodeByFile.keys()], new Map(), null, null, null, null, { pkgOf: file => input.nodeByFile.get(file).pkg })
  layoutSpiral(graph, 1000, 800)
  const { after, before, neighbors: edges, rings } = captured
  preservesDisks(before, after, rings)
  assert.deepEqual([after.get('__own__').x, after.get('__own__').y], [500, 400])
  assert.ok(new Set([...before.values()].map(disk => disk.groupR)).size > 10, 'exercise differing package sizes')
  assert.ok(length(after, edges) < length(before, edges) * 0.95, 'shorten the unique links between the real package disks')
  for (const node of graph.nodes) {
    const disk = after.get(node.pkg)
    assert.ok(Math.hypot(node.x - disk.x, node.y - disk.y) <= disk.groupR + 1e-7, 'files stay in their package disk')
  }
  const repeat = structuredClone(before)
  optimizePackageRings(repeat, edges, rings)
  assert.deepEqual(repeat, after, 'the assignment is deterministic')
})

test('1000 packages retain their rings and never increase overlap or unique-edge length', () => {
  const info = new Map(), pairs = [], rings = Array.from({ length: 10 }, () => [])
  for (let i = 0; i < 1000; i++) {
    const file = String(i), ring = Math.floor(i / 100)
    const angle = i * 137.508 * Math.PI / 180, radius = 50 + Math.sqrt(i) * 10
    info.set(file, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, groupR: 2 + i % 8, size: 1 + i % 50 })
    rings[ring].push(file)
    pairs.push([file, String((i + 1) % 1000)], [file, String((i + 31) % 1000)])
  }
  const before = structuredClone(info), edges = neighbors(pairs)
  optimizePackageRings(info, edges, rings)
  preservesDisks(before, info, rings)
  assert.ok(length(info, edges) < length(before, edges) * 0.6)
})

test('empty rings, singleton rings, no links, and zero-size disks are stable', () => {
  for (const count of [0, 1, 10]) {
    const info = new Map(Array.from({ length: count }, (_, i) => [String(i), { x: 0, y: 0, groupR: 0 }]))
    const before = structuredClone(info)
    optimizePackageRings(info, new Map(), [[], ...[...info.keys()].map(pkg => [pkg])])
    assert.deepEqual(info, before)
    optimizePackageRings(info, count > 1 ? neighbors([['0', '1']]) : new Map(), [[...info.keys()]])
    assert.deepEqual(info, before)
  }
})
