import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSizeFlow, flowRibbon, layoutSizeFlow } from '../ui/view/graph/size-flow-model.js'

function fixture(tree, entries = ['entry']) {
  return {
    nodes: Object.entries(tree).map(([file, node]) => ({ file, pkg: file.split('/')[0], ...node })),
    importsOf: new Map(Object.entries(tree).map(([file, node]) => [file, node.imports ?? []])),
    flowEntries: entries.map(file => ({ file })),
  }
}

const diamond = {
  entry: { size: 10, imports: ['a/index', 'b/index'] },
  'a/index': { size: 20, imports: ['shared/index'] },
  'b/index': { size: 30, imports: ['shared/index'] },
  'shared/index': { size: 1000 },
  unreachable: { size: 9000 },
}

test('bar widths and labels measure deletion impact, without summing incident flows', () => {
  const model = buildSizeFlow(fixture(diamond))
  const layout = layoutSizeFlow(model)
  assert.deepEqual(Object.fromEntries([...model.byId].map(([id, n]) => [id, n.removable])), {
    'f:entry': 1060, 'f:a/index': 20, 'f:b/index': 30, 'f:shared/index': 1000,
  })
  const a = layout.byId.get('f:a/index'), shared = layout.byId.get('f:shared/index')
  assert.ok(Math.abs(shared.width / a.width - 50) < 1e-10)
  const ribbons = layout.edges.filter(e => e.to === shared.id)
  assert.equal(ribbons[0].x2, ribbons[1].x2, 'ribbons may overlap instead of inflating the shared bar')
  assert.equal(ribbons[0].width2, shared.width)
  const fromA = ribbons.find(e => e.from === a.id)
  assert.equal(fromA.width1, a.width, 'a ribbon tapers to fit the smaller removal-impact bar')
  assert.equal(fromA.size, 1000, 'inspection still reports the complete reachable size through this import')
  assert.ok(!/NaN|Infinity/u.test(flowRibbon(fromA)))
  const focused = layoutSizeFlow(model, { focus: a.id })
  assert.equal(focused.byId.get(a.id).removable, 20, 'focusing does not discard alternate paths in the bundle')
})

test('all surviving entry points keep their dependencies after deleting another entry', () => {
  const model = buildSizeFlow(fixture(diamond, ['entry', 'a/index']))
  assert.equal(model.byId.get('f:entry').removable, 40)
  assert.equal(model.byId.get('f:a/index').removable, 20)
  assert.equal(model.byId.get('f:shared/index').removable, 1000)
})

test('deletion can break a cycle without deleting every member of the original component', () => {
  const model = buildSizeFlow(fixture({
    entry: { size: 10, imports: ['a'] },
    a: { size: 20, imports: ['b'] },
    b: { size: 30, imports: ['a', 'b', 'large'] },
    large: { size: 1000 },
  }))
  assert.equal(model.byId.get('f:a').removable, 1050)
  assert.equal(model.byId.get('f:b').removable, 1030)
  assert.equal(model.byId.get('f:large').removable, 1000)
})

test('package deletion removes its files together and preserves alternate file-level paths', () => {
  const tree = {
    entry: { size: 10, imports: ['pkg/a', 'pkg/b'] },
    'pkg/a': { size: 20, imports: ['shared/index'] },
    'pkg/b': { size: 30, imports: ['shared/index'] },
    'shared/index': { size: 1000 },
  }
  const files = buildSizeFlow(fixture(tree)), packages = buildSizeFlow(fixture(tree), { packages: true })
  assert.equal(files.byId.get('f:pkg/a').removable, 20)
  assert.equal(files.byId.get('f:pkg/b').removable, 30)
  assert.equal(packages.byId.get('p:pkg').removable, 1050, 'package impact is more than the sum of individual file impacts')
  tree.entry.imports.push('other/index')
  tree['other/index'] = { size: 5, imports: ['shared/index'] }
  assert.equal(buildSizeFlow(fixture(tree), { packages: true }).byId.get('p:pkg').removable, 50)
})

test('package aggregation does not invent paths through unrelated files in a package', () => {
  const model = buildSizeFlow(fixture({
    entry: { size: 1, imports: ['pkg/a', 'other/b'] },
    'pkg/a': { size: 2, imports: ['other/a'] },
    'other/a': { size: 4, imports: ['pkg/b'] },
    'other/b': { size: 8 },
    'pkg/b': { size: 16, imports: ['large/index'] },
    'large/index': { size: 32 },
  }), { packages: true })
  assert.equal(model.byId.get('p:pkg').removable, 54, 'other/b cannot keep other/a and its imports alive')
  assert.equal(model.byId.get('p:other').removable, 60)
})

test('removal tracks missing source sizes and virtual roots separately', () => {
  const graph = fixture({
    missing: { size: null, imports: ['known'] },
    known: { size: 100 },
  }, [])
  graph.flowEntries = [{ file: 'entry', pkg: 'app', virtual: true, imports: ['missing'] }]
  const model = buildSizeFlow(graph)
  assert.equal(model.byId.get('f:entry').removable, 100)
  assert.equal(model.byId.get('f:entry').removableMissing, 1)
  assert.equal(model.byId.get('f:missing').removableMissing, 1)
  assert.equal(model.byId.get('f:known').removableMissing, 0)
})

test('batched deletion matches independent graph traversal across cycles, entries and package boundaries', () => {
  let seed = 7
  const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max }
  for (let iteration = 0; iteration < 16; iteration++) {
    const names = Array.from({ length: 75 }, (_, i) => `pkg${i % 35}/${i}`)
    const tree = Object.fromEntries(names.map(file => [file, {
      size: random(7) === 0 ? null : random(1000),
      imports: Array.from({ length: random(5) }, () => names[random(names.length)]),
    }]))
    const entries = iteration % 2 ? names : names.slice(0, 3)
    const remaining = blocked => {
      const pending = entries.filter(file => !blocked.has(file)), seen = new Set()
      for (const file of pending) {
        if (seen.has(file)) continue
        seen.add(file)
        for (const to of tree[file].imports) if (!blocked.has(to) && !seen.has(to)) pending.push(to)
      }
      return seen
    }
    const baseline = remaining(new Set())
    for (const packages of [false, true]) {
      const model = buildSizeFlow(fixture(tree, entries), { packages })
      for (const row of model.byId.values()) {
        const survivors = remaining(new Set(row.files))
        const removed = [...baseline].filter(file => !survivors.has(file))
        assert.equal(row.removable, removed.reduce((sum, file) => sum + (tree[file].size ?? 0), 0), `${iteration}: ${row.id}`)
        assert.equal(row.removableMissing, removed.filter(file => tree[file].size == null).length)
      }
    }
  }
})
