import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/view/frontend-install.js'
import { buildGraph } from '../ui/view/graph/data.js'
import { buildSizeFlow, flowRibbon, layoutSizeFlow } from '../ui/view/graph/size-flow-model.js'
import '../ui/view/graph/size-flow.js'

function fixture(tree, entries = ['entry.js']) {
  const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf: f => f.includes('/') ? f.split('/')[0] : '__own__' })
  graph.flowEntries = entries.map(file => ({ file }))
  return graph
}

const diamond = {
  'entry.js': { size: 10, imports: ['a/index.js', 'b/index.js'] },
  'a/index.js': { size: 20, imports: ['large/index.js'] },
  'b/index.js': { size: 30, imports: ['large/index.js'] },
  'large/index.js': { size: 1000, imports: [] },
  'unreachable.js': { size: 5000, imports: [] },
}

test('shared dependencies contribute fully to every loading edge but only once per node total', () => {
  const model = buildSizeFlow(fixture(diamond))
  assert.equal(model.byId.get('f:entry.js').size, 1060)
  assert.equal(model.byId.get('f:a/index.js').size, 1020)
  assert.equal(model.byId.get('f:b/index.js').size, 1030)
  assert.deepEqual(model.edges.filter(e => e.to === 'f:large/index.js').map(e => e.size), [1000, 1000])
  assert.deepEqual(model.total, { size: 1060, missing: 0 })
  assert.equal(model.omittedFiles, 1)
  assert.deepEqual(model.roots, ['f:entry.js'])
})

test('overlapping entry points stay at the top and share one unique bundle total', () => {
  const model = buildSizeFlow(fixture(diamond, ['entry.js', 'a/index.js']))
  const layout = layoutSizeFlow(model)
  assert.deepEqual(layout.nodes.filter(n => n.level === 0).map(n => n.id), ['f:entry.js', 'f:a/index.js'])
  assert.equal(model.total.size, 1060)
  assert.equal(layout.edges.find(e => e.to === 'f:a/index.js').returning, true)
})

test('cycles and self imports terminate with exact unique totals and explicit return ribbons', () => {
  const graph = fixture({
    'entry.js': { size: 10, imports: ['a.js'] },
    'a.js': { size: 20, imports: ['b.js'] },
    'b.js': { size: 30, imports: ['a.js', 'b.js', 'large.js'] },
    'large.js': { size: 1000, imports: [] },
  })
  const model = buildSizeFlow(graph)
  const layout = layoutSizeFlow(model)
  assert.equal(model.byId.get('f:entry.js').size, 1060)
  assert.equal(model.byId.get('f:a.js').size, 1050)
  assert.equal(model.byId.get('f:b.js').size, 1050)
  assert.equal(layout.edges.filter(e => e.returning).length, 3)
  assert.equal(layout.nodes.filter(n => n.level === 0).length, 1)
})

test('direct and indirect imports of a shared dependency flow downward without false returns', () => {
  const model = buildSizeFlow(fixture({
    ...diamond,
    'entry.js': { size: 10, imports: ['a/index.js', 'b/index.js', 'large/index.js'] },
  }))
  const layout = layoutSizeFlow(model)
  assert.ok(layout.edges.every(e => !e.returning))
  assert.equal(layout.byId.get('f:large/index.js').level, 2)
  assert.equal(model.total.size, 1060)
})

test('package flows use actual target files and preserve internal file reachability', () => {
  const model = buildSizeFlow(fixture({
    'entry.js': { size: 10, imports: ['a/index.js', 'b/index.js', 'lib/other.js'] },
    'a/index.js': { size: 20, imports: ['lib/index.js', 'lib/helper.js'] },
    'b/index.js': { size: 30, imports: ['lib/index.js'] },
    'lib/index.js': { size: 100, imports: ['lib/helper.js'] },
    'lib/helper.js': { size: 40, imports: [] },
    'lib/other.js': { size: 9000, imports: ['b/other.js'] },
    'b/other.js': { size: 700, imports: [] },
  }), { packages: true })
  const edge = model.edges.find(e => e.from === 'p:a' && e.to === 'p:lib')
  assert.equal(edge.size, 140, 'internal helpers count once; unrelated lib entry is excluded')
  assert.equal(edge.count, 2)
  assert.equal(model.byId.get('p:a').size, 160, 'aggregation must not invent lib/other → b → lib paths')
  assert.equal(model.byId.get('p:lib').size, 9840)
  assert.equal(model.byId.get('p:lib').own, 9140)
  assert.ok(model.edges.every(e => e.from !== e.to), 'internal imports are represented by package totals')
})

test('weak config loads are excluded before reachability, using original paths', () => {
  const graph = fixture({
    'entry.js': { size: 1, imports: ['loader.js'] },
    'loader.js': { size: 10, imports: ['babel.config.js'] },
    'babel.config.js': { size: 100, imports: ['entry.js'] },
  })
  graph.nodeByFile.get('loader.js').origFile = 'node_modules/cosmiconfig/dist/loaders.js'
  graph.ownSourceFiles = new Set(['entry.js', 'babel.config.js'])
  const model = buildSizeFlow(graph)
  assert.equal(model.total.size, 11)
  assert.equal(model.weakEdges, 1)
  assert.equal(model.byId.has('f:babel.config.js'), false)
})

test('virtual entry sources retain imports and unknown source sizes are reported', () => {
  const graph = fixture({ 'lib/index.js': { size: null, imports: ['lib/known.js'] }, 'lib/known.js': { size: 100, imports: [] } }, [])
  graph.flowEntries = [
    { file: 'app.js', pkg: '__own__', virtual: true, imports: ['helper.js'] },
    { file: 'helper.js', pkg: '__own__', virtual: true, entry: false, imports: ['lib/index.js'] },
  ]
  const model = buildSizeFlow(graph)
  assert.deepEqual(model.roots, ['f:app.js'])
  assert.deepEqual(model.total, { size: 100, missing: 1 })
  assert.equal(model.byId.get('f:app.js').virtual, true)
})

test('missing entry metadata infers source components, including an all-cyclic graph', () => {
  const model = buildSizeFlow(fixture({ 'a.js': { size: 3, imports: ['b.js'] }, 'b.js': { size: 4, imports: ['a.js'] } }, []))
  assert.equal(model.inferred, true)
  assert.deepEqual(model.roots, ['f:a.js'])
  assert.equal(model.total.size, 7)
  assert.deepEqual(buildSizeFlow(fixture({}, [])).total, { size: 0, missing: 0 })
})

test('full dependency paths are visible and following a dependency retains all its descendants', () => {
  const model = buildSizeFlow(fixture(diamond))
  const layout = layoutSizeFlow(model)
  assert.equal(layout.nodes.length, 4)
  assert.equal(layout.edges.length, 4)
  assert.equal(layout.nodes[0].size, 1060)
  assert.equal(layoutSizeFlow(model, { focus: 'f:a/index.js' }).nodes.length, 2)
  const all = layout
  const shared = all.edges.filter(e => e.to === 'f:large/index.js')
  assert.equal(shared[0].width, shared[1].width, 'shared target keeps equal ribbon widths on both paths')
  for (const e of all.edges) {
    assert.ok(e.x1 + e.width <= all.byId.get(e.from).x + all.byId.get(e.from).width + .001)
    assert.ok(e.x2 + e.width <= all.byId.get(e.to).x + all.byId.get(e.to).width + .001)
    assert.ok(!/NaN|Infinity/u.test(flowRibbon(e)))
  }
})

test('deep chains avoid recursion and zero-byte graphs keep finite geometry', () => {
  const tree = Object.fromEntries(Array.from({ length: 12000 }, (_, i) => [`${i}.js`, { size: 1, imports: i < 11999 ? [`${i + 1}.js`] : [] }]))
  const model = buildSizeFlow(fixture(tree, ['0.js']))
  assert.equal(model.total.size, 12000)
  assert.equal(model.byId.get('f:5000.js').size, 7000)
  const all = layoutSizeFlow(model)
  assert.equal(all.nodes.length, 12000)
  assert.equal(all.edges.length, 11999)
  assert.equal(all.byId.get('f:11999.js').level, 11999)
  const zero = layoutSizeFlow(buildSizeFlow(fixture({ 'entry.js': { size: 0, imports: ['zero.js'] }, 'zero.js': { size: 0 } })))
  assert.ok(zero.edges[0].width > 0)
  assert.ok(!/NaN|Infinity/u.test(flowRibbon(zero.edges[0])))
})

test('all entry points remain visible beyond the former 800-node cap', () => {
  const tree = Object.fromEntries(Array.from({ length: 900 }, (_, i) => [`${i}.js`, { size: 1, imports: [] }]))
  const model = buildSizeFlow(fixture(tree, Object.keys(tree)))
  const layout = layoutSizeFlow(model)
  assert.equal(layout.nodes.length, 900)
  assert.equal(model.roots.length, 900)
  assert.equal(model.total.size, 900)
})

test('every ribbon remains visible beyond the former 2500-edge cap', () => {
  const sources = Array.from({ length: 60 }, (_, i) => `from-${i}.js`)
  const targets = Array.from({ length: 60 }, (_, i) => `to-${i}.js`)
  const tree = Object.fromEntries([
    ['entry.js', { size: 1, imports: sources }],
    ...sources.map(file => [file, { size: 1, imports: targets }]),
    ...targets.map(file => [file, { size: 10, imports: [] }]),
  ])
  const model = buildSizeFlow(fixture(tree))
  const layout = layoutSizeFlow(model)
  assert.equal(layout.nodes.length, 121)
  assert.equal(layout.edges.length, 3660)
  assert.deepEqual(new Set(layout.edges.map(e => e.id)), new Set(model.edges.map(e => e.id)))
  assert.equal(model.total.size, 661)
})

test('popup refreshes keep flow focus, selection and zoom while updating totals', () => {
  const Flow = customElements.get('size-flow'), flow = new Flow()
  flow.graph = fixture(diamond); flow.willUpdate(new Map([['graph', null]]))
  flow.focus = 'f:a/index.js'; flow.select('f:large/index.js'); flow.zoom = 3
  flow.graph = fixture({ ...diamond, 'large/index.js': { size: 2000, imports: [] } })
  flow.willUpdate(new Map([['graph', null]]))
  assert.equal(flow.focus, 'f:a/index.js')
  assert.equal(flow.selection.node, 'f:large/index.js')
  assert.equal(flow.zoom, 3)
  assert.equal(flow.model.byId.get('f:large/index.js').size, 2000)
  const previous = flow.layout
  flow.hover = flow.model.edges[0].id; flow.willUpdate(new Map())
  assert.equal(flow.layout, previous, 'hover does not rerun layout')
  flow.packages = true; flow.willUpdate(new Map([['packages', false]]))
  assert.equal(flow.focus, null)
  assert.equal(flow.selection, null)
})
