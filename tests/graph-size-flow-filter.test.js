import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/view/frontend-install.js'
import { buildSizeFlow, layoutSizeFlow, sizeFlowLargeThreshold } from '../ui/view/graph/size-flow-model.js'
import { filterSizes } from '../ui/view/graph/size-flow-filter.js'

function fixture(tree, entries = ['entry']) {
  return {
    nodes: Object.entries(tree).map(([file, n]) => ({ file, pkg: file.split('/')[0], ...n })),
    importsOf: new Map(Object.entries(tree).map(([file, n]) => [file, n.imports ?? []])),
    flowEntries: entries.map(file => ({ file })),
  }
}

function assertConnected(layout) {
  const outgoing = new Map(layout.nodes.map(n => [n.id, []]))
  for (const edge of layout.edges) outgoing.get(edge.from).push(edge.to)
  const seen = new Set(layout.roots)
  const queue = [...seen]
  for (const id of queue) for (const to of outgoing.get(id)) if (!seen.has(to)) { seen.add(to); queue.push(to) }
  assert.equal(seen.size, layout.nodes.length, 'every retained node has a path from a retained entry point')
}

function assertConnectedFiles(tree, entries, layout) {
  const files = new Set(layout.nodes.flatMap(n => n.files))
  const seen = new Set(entries.filter(file => files.has(file)))
  const queue = [...seen]
  for (const file of queue) { for (const to of tree[file].imports) {
    if (files.has(to) && !seen.has(to)) { seen.add(to); queue.push(to) }
  } }
  assert.deepEqual(seen, files, 'package grouping cannot invent a path to an otherwise orphaned member')
}

test('Large removes redundant small wrappers but preserves the last path to a large dependency', () => {
  const tree = {
    entry: { size: 1, imports: ['first/index', 'second/index', 'leaf/index'] },
    'first/index': { size: 13 * 1024, imports: ['shared/index'] },
    'second/index': { size: 13 * 1024, imports: ['shared/index'] },
    'leaf/index': { size: 13 * 1024 },
    'shared/index': { size: 200 * 1024 },
  }
  for (const packages of [false, true]) {
    const model = buildSizeFlow(fixture(tree), { packages })
    const prefix = packages ? 'p:' : 'f:'
    const first = `${prefix}${packages ? 'first' : 'first/index'}`
    const second = `${prefix}${packages ? 'second' : 'second/index'}`
    const before = [...model.byId.values()].map(n => [n.removable, n.own, n.size])
    const layout = layoutSizeFlow(model, { minSize: 100 * 1024 })
    assert.equal(layout.byId.has(first), true)
    assert.equal(layout.byId.has(second), false)
    assert.equal(layout.nodes.length, 3)
    assert.equal(model.byId.get(first).removable, 13 * 1024, 'the connector keeps its original bundle removal metric')
    assertConnected(layout)
    assert.deepEqual([...model.byId.values()].map(n => [n.removable, n.own, n.size]), before)
    assert.equal(layoutSizeFlow(model).nodes.length, 5, 'turning the filter off restores all nodes')
  }
  tree.entry.imports.reverse()
  const reversed = layoutSizeFlow(buildSizeFlow(fixture(tree)), { minSize: 100 * 1024 })
  assert.equal(reversed.byId.has('f:second/index'), true, 'bundle traversal order breaks equal-path ties deterministically')
  assert.equal(reversed.byId.has('f:first/index'), false)
  assertConnected(reversed)
})

test('Large prefers direct entry paths and does not preserve redundant cyclic wrappers', () => {
  const tree = {
    entry: { size: 1, imports: ['a', 'shared'] },
    a: { size: 1, imports: ['b', 'shared'] },
    b: { size: 1, imports: ['a', 'shared'] },
    shared: { size: 5000 },
  }
  const layout = layoutSizeFlow(buildSizeFlow(fixture(tree)), { minSize: 4096 })
  assert.deepEqual(layout.nodes.map(n => n.id), ['f:entry', 'f:shared'])
  assertConnected(layout)
  const multiple = layoutSizeFlow(buildSizeFlow(fixture(tree, ['entry', 'shared'])), { minSize: 4096 })
  assert.deepEqual(multiple.nodes.map(n => n.id), ['f:shared'], 'an independent entry needs no wrapper path')
  assertConnected(multiple)
})

test('package connectors preserve real file paths even when grouping creates parent cycles', () => {
  const tree = {
    entry: { size: 1, imports: ['a/first', 'b/first', 'alternative/index'] },
    'a/first': { size: 1, imports: ['b/second'] },
    'b/first': { size: 1, imports: ['a/second'] },
    'a/second': { size: 1 },
    'b/second': { size: 1, imports: ['large/index'] },
    'alternative/index': { size: 1, imports: ['hop/index'] },
    'hop/index': { size: 1, imports: ['large/index'] },
    'large/index': { size: 5000 },
  }
  const layout = layoutSizeFlow(buildSizeFlow(fixture(tree), { packages: true }), { minSize: 4096 })
  assert.deepEqual(new Set(layout.nodes.map(n => n.id)), new Set(['p:entry', 'p:a', 'p:b', 'p:large']))
  assertConnected(layout)
})

test('automatic Large cutoff counts required connectors as well as significant nodes', () => {
  const tree = { entry: { size: 1, imports: [] } }
  for (let i = 0; i < 60; i++) {
    tree.entry.imports.push(`wrapper-${i}`, `alternative-${i}`)
    tree[`wrapper-${i}`] = { size: 1, imports: [`large-${i}`] }
    tree[`alternative-${i}`] = { size: 1, imports: [`large-${i}`] }
    tree[`large-${i}`] = { size: 5000 }
  }
  const model = buildSizeFlow(fixture(tree))
  assert.equal(sizeFlowLargeThreshold(model), 4096, '1 KiB still leaves 121 nodes once their paths are counted')
  const layout = layoutSizeFlow(model, { minSize: 4096 })
  assert.equal(layout.nodes.length, 121, 'the next step would lose the important dependencies')
  assertConnected(layout)
})

test('following imports does not expose an orphan through a filtered-out intermediary', () => {
  const tree = {
    entry: { size: 1, imports: ['a', 'shared'] },
    a: { size: 5000, imports: ['small'] },
    small: { size: 1, imports: ['shared'] },
    shared: { size: 5000 },
  }
  const model = buildSizeFlow(fixture(tree))
  const layout = layoutSizeFlow(model, { minSize: 4096, focus: 'f:a' })
  assert.deepEqual(layout.nodes.map(n => n.id), ['f:a'])
  assertConnected(layout)
})

test('each size metric can retain a node and its small connectors independently', () => {
  const rows = new Map([
    ['root', { own: 0, removable: 0 }],
    ['own', { own: 4096, removable: 0 }],
    ['removal', { own: 0, removable: 10240 }],
    ['below', { own: 4095, removable: 4095 }],
  ])
  filterSizes(rows, new Map([['own', 'root'], ['removal', 'root'], ['below', 'root']]), id => id)
  assert.equal(rows.get('own').filterSize, 4096)
  assert.equal(rows.get('removal').filterSize, 10240)
  assert.equal(rows.get('below').filterSize, 4095)
  assert.equal(rows.get('root').filterSize, 10240)
})

test('filtered random file and package graphs retain significant nodes without orphaned files', () => {
  let seed = 71
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max }
  for (let iteration = 0; iteration < 16; iteration++) {
    const names = Array.from({ length: 70 }, (_, i) => `p${i % 30}/${i}`)
    const tree = Object.fromEntries(names.map(file => [file, {
      size: random(10000), imports: Array.from({ length: random(5) }, () => names[random(names.length)]),
    }]))
    const entries = names.slice(0, 3)
    for (const packages of [false, true]) {
      const model = buildSizeFlow(fixture(tree, entries), { packages })
      for (const minSize of [1024, 4096, 10240, 102400]) {
        const layout = layoutSizeFlow(model, { minSize })
        for (const node of model.byId.values()) assert.ok(Math.max(node.own, node.removable) < minSize || layout.byId.has(node.id))
        assertConnected(layout)
        assertConnectedFiles(tree, entries, layout)
      }
    }
  }
})
