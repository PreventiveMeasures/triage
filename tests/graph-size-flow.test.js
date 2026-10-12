import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildGraph } from '../ui/view/graph/data.js'
import { batchedReachability } from '../ui/view/graph/size-flow-reachability.js'
import { buildSizeFlow, flowRibbon, layoutSizeFlow, sizeFlowLargeThreshold } from '../ui/view/graph/size-flow-model.js'
import '../ui/view/graph/size-flow.js'
import { graph2 } from '../ui/view/graph/state.js'
import { flowNodeTooltip } from '../ui/view/graph/size-flow-chart.js'
import { filterSizes } from '../ui/view/graph/size-flow-filter.js'

function fixture(tree, entries = ['entry.js']) {
  const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf: f => f.includes('/') ? f.split('/')[0] : '__own__' })
  graph.flowEntries = entries.map(file => ({ file }))
  return graph
}

// The graph shape buildSizeFlow reads, without buildGraph: each file's
// package is its first path segment.
function rawGraph(tree, entries = ['entry']) {
  return {
    nodes: Object.entries(tree).map(([file, node]) => ({ file, pkg: file.split('/')[0], ...node })),
    importsOf: new Map(Object.entries(tree).map(([file, node]) => [file, node.imports ?? []])),
    flowEntries: entries.map(file => ({ file })),
  }
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

test('Size flow preserves native selector matching used by delegated app clicks', () => {
  const Flow = customElements.get('size-flow'), flow = new Flow()
  // The report's composed-path delegate calls Element.matches(selector).
  // A graph filter with the same name made every click a finding-preview click.
  assert.equal(flow.matches, Object.getPrototypeOf(Flow.prototype).matches)
})

test('package sidebar lists every reachable install with its own bytes, including repeated versions', () => {
  const installs = new Map([
    ['one', { directory: 'node_modules/dep', version: '1.0.0' }],
    ['two', { directory: 'node_modules/parent/node_modules/dep', version: '1.0.0' }],
    ['three', { directory: 'node_modules/.pnpm/dep@2.0.0/node_modules/dep', version: '2.0.0' }],
    ['unknown', { directory: 'node_modules/other/node_modules/dep', version: undefined }],
    ['unused', { directory: 'node_modules/unused/node_modules/dep', version: '9.0.0' }],
  ])
  const tree = {
    'entry.js': { size: 1, imports: ['one/index.js', 'two/index.js', 'three/index.js', 'unknown/index.js'] },
    'one/index.js': { size: 1024, imports: ['one/helper.js', 'other/index.js'] },
    'one/helper.js': { size: 1024, imports: [] },
    'two/index.js': { size: 3072, imports: ['one/helper.js'] },
    'three/index.js': { size: 4096, imports: [] },
    'unknown/index.js': { size: null, imports: [] },
    'unused/index.js': { size: 9999, imports: [] },
    'other/index.js': { size: 10000, imports: [] },
  }
  const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, {
    pkgOf: file => installs.has(file.split('/')[0]) ? 'dep' : 'app',
    packageInfoOf: file => installs.get(file.split('/')[0]),
  })
  graph.flowEntries = [{ file: 'entry.js' }]
  const Flow = customElements.get('size-flow'), flow = new Flow()
  flow.graph = graph; flow.packages = true; flow.willUpdate(new Map([['graph', null]]))
  flow.select('p:dep')
  const node = flow.model.byId.get('p:dep')
  assert.deepEqual(node.instances, [
    { ...installs.get('three'), size: 4096, missing: 0 },
    { ...installs.get('two'), size: 3072, missing: 0 },
    { ...installs.get('one'), size: 2048, missing: 0 },
    { ...installs.get('unknown'), size: 0, missing: 1 },
  ])
  assert.equal(node.instances.reduce((sum, instance) => sum + instance.size, 0), node.own)
  const text = value => Array.isArray(value) ? value.map(text).join('') : value?.strings
    ? value.strings.map((part, i) => part + text(value.values[i])).join('') : value?.values ? text(value.values.at(-1)) : typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  assert.match(text(flow.renderPanel()), /<details class="flow-versions-details"><summary>Versions: 4<\/summary>/u, 'multiple installs start collapsed, including repeated versions')
  const list = text(flow.renderPanel()).match(/<ul class="flow-versions">(.*?)<\/ul>/su)[1]
  assert.equal([...list.matchAll(/<li>/gu)].length, 4)
  assert.equal([...list.matchAll(/<span>1\.0\.0<\/span>/gu)].length, 2)
  for (const label of ['4.0 KiB', '3.0 KiB', '2.0 KiB', 'Unknown version', '0 B+']) assert.ok(list.includes(label), label)
  assert.doesNotMatch(list, /9\.0\.0/u)
  const single = text(flow.renderVersions({ ...node, instances: [node.instances[0]] }))
  assert.ok(single.includes('2.0.0'))
  assert.ok(single.includes(installs.get('three').directory))
  assert.doesNotMatch(single, /KiB|<details/u, 'a single install shows only its version and path')
  flow.packages = false; flow.willUpdate(new Map([['packages', true]])); flow.select('f:one/index.js')
  assert.doesNotMatch(text(flow.renderPanel()), /flow-versions/u, 'the breakdown belongs to package selection')
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
  assert.equal(shared[0].width2, shared[1].width2, 'shared target keeps equal ribbon endpoints on both paths')
  for (const e of all.edges) {
    assert.ok(e.x1 + e.width1 <= all.byId.get(e.from).x + all.byId.get(e.from).width + .001)
    assert.ok(e.x2 + e.width2 <= all.byId.get(e.to).x + all.byId.get(e.to).width + .001)
    assert.ok(!/NaN|Infinity/u.test(flowRibbon(e)))
  }
})

test('a smaller bar moves left of larger ones only when that removes ribbon crossings', () => {
  const row = (layout, level) => layout.nodes.filter(n => n.level === level).map(n => n.id)
  const uncrossed = layout => {
    const edges = layout.edges.toSorted((a, b) => a.x1 - b.x1)
    for (let i = 1; i < edges.length; i++) assert.ok(edges[i - 1].x2 < edges[i].x2, `${edges[i - 1].id} crosses ${edges[i].id}`)
  }
  const pair = layoutSizeFlow(buildSizeFlow(fixture({
    'x.js': { size: 1000, imports: ['x-dep.js'] }, 'x-dep.js': { size: 50 },
    'y.js': { size: 500, imports: ['y-dep.js'] }, 'y-dep.js': { size: 100 },
  }, ['x.js', 'y.js'])))
  assert.deepEqual(row(pair, 0), ['f:x.js', 'f:y.js'])
  assert.deepEqual(row(pair, 1), ['f:x-dep.js', 'f:y-dep.js'], 'the smaller import moves under its importer')
  assert.equal(pair.byId.get('f:x-dep.js').x, 0)
  uncrossed(pair)

  // A tiny bar travels past several larger ones to sit under its importer.
  const far = layoutSizeFlow(buildSizeFlow(fixture({
    'big.js': { size: 1000, imports: ['big-dep.js'] }, 'big-dep.js': { size: 900 },
    'g.js': { size: 400, imports: ['g-dep.js'] }, 'g-dep.js': { size: 5 },
    'c.js': { size: 300, imports: ['c-dep.js'] }, 'c-dep.js': { size: 50 },
    'p.js': { size: 200, imports: ['p-dep.js'] }, 'p-dep.js': { size: 100 },
  }, ['big.js', 'g.js', 'c.js', 'p.js'])))
  assert.deepEqual(row(far, 0), ['f:big.js', 'f:g.js', 'f:c.js', 'f:p.js'])
  assert.deepEqual(row(far, 1), ['f:big-dep.js', 'f:g-dep.js', 'f:c-dep.js', 'f:p-dep.js'])
  uncrossed(far)
  assert.deepEqual(far.nodes.map(n => n.id), [...row(far, 0), ...row(far, 1)], 'nodes list each row left to right')

  const shared = layoutSizeFlow(buildSizeFlow(fixture({
    'entry.js': { size: 10, imports: ['small.js', 'large.js'] }, 'small.js': { size: 50 }, 'large.js': { size: 100 },
  })))
  assert.deepEqual(row(shared, 1), ['f:large.js', 'f:small.js'], 'with no crossing to remove, larger bars stay left')
})

test('ribbons that fit sit side by side from the left edge of the bar', () => {
  const layout = layoutSizeFlow(buildSizeFlow(fixture({
    'entry.js': { size: 500, imports: ['small.js', 'large.js', 'medium.js'] },
    'small.js': { size: 100 }, 'large.js': { size: 300 }, 'medium.js': { size: 200 },
  })))
  const root = layout.byId.get('f:entry.js')
  const outgoing = layout.edges.toSorted((a, b) => layout.byId.get(a.to).x - layout.byId.get(b.to).x)
  assert.equal(outgoing[0].x1, root.x)
  for (let i = 1; i < outgoing.length; i++) assert.ok(Math.abs(outgoing[i].x1 - outgoing[i - 1].x1 - outgoing[i - 1].width1) < 1e-8, 'no gap between ribbons')
  assert.ok(outgoing.at(-1).x1 + outgoing.at(-1).width1 < root.x + root.width - 1, 'the rest of the bar stays free')

  const packages = layoutSizeFlow(buildSizeFlow(fixture({
    'a/index.js': { size: 200, imports: ['lib/a.js'] },
    'b/index.js': { size: 400, imports: ['lib/b.js'] },
    'lib/entry.js': { size: 500 }, 'lib/a.js': { size: 100 }, 'lib/b.js': { size: 200 },
  }, ['a/index.js', 'b/index.js', 'lib/entry.js']), { packages: true }))
  const lib = packages.byId.get('p:lib')
  const incoming = packages.edges.toSorted((a, b) => packages.byId.get(a.from).x - packages.byId.get(b.from).x)
  assert.equal(incoming[0].x2, lib.x)
  assert.ok(Math.abs(incoming[1].x2 - incoming[0].x2 - incoming[0].width2) < 1e-8)
  assert.ok(incoming.at(-1).x2 + incoming.at(-1).width2 < lib.x + lib.width - 1)
  const a = packages.byId.get('p:a'), only = packages.edges.find(e => e.from === a.id)
  assert.ok(only.width1 < a.width - 1)
  assert.equal(only.x1, a.x, 'a single ribbon starts at the left edge, not the center')
})

test('oversubscribed ribbons spread across the bar while retaining their overlapping widths', () => {
  const layout = layoutSizeFlow(buildSizeFlow(fixture({
    ...diamond,
    'entry.js': { size: 10, imports: ['a/index.js', 'b/index.js', 'small.js'] },
    'small.js': { size: 10 },
  })))
  const root = layout.byId.get('f:entry.js'), shared = layout.byId.get('f:large/index.js')
  const outgoing = layout.edges.filter(e => e.from === root.id)
    .toSorted((a, b) => layout.byId.get(a.to).x - layout.byId.get(b.to).x)
  assert.ok(Math.abs(root.width - 1100) < 1e-8, 'overlap must not inflate removal-impact bars')
  assert.equal(outgoing[0].x1, root.x)
  assert.ok(Math.abs(outgoing.at(-1).x1 + outgoing.at(-1).width1 - root.x - root.width) < 1e-8)
  assert.ok(outgoing.reduce((sum, e) => sum + e.width1, 0) > root.width)
  assert.ok(outgoing[0].x1 + outgoing[0].width1 > outgoing[1].x1, 'shared reachability is allowed to overlap')
  for (let i = 0; i < outgoing.length; i++) {
    const edge = outgoing[i]
    assert.ok(Math.abs(edge.width1 / root.width - edge.size / root.removable) < 1e-8)
    assert.ok(edge.x1 >= root.x && edge.x1 + edge.width1 <= root.x + root.width + 1e-8)
    if (i > 0) assert.ok(edge.x1 + edge.width1 / 2 >= outgoing[i - 1].x1 + outgoing[i - 1].width1 / 2)
  }
  for (const edge of layout.edges.filter(e => e.to === shared.id)) {
    assert.equal(edge.width2, shared.width)
    assert.equal(edge.x2, shared.x, 'full-width incoming flows may completely overlap')
  }
})

test('deep chains avoid recursion and zero-byte graphs keep finite geometry', () => {
  const tree = Object.fromEntries(Array.from({ length: 12000 }, (_, i) => [`${i}.js`, { size: 1, imports: i < 11999 ? [`${i + 1}.js`] : [] }]))
  const model = buildSizeFlow(fixture(tree, ['0.js']))
  assert.equal(model.total.size, 12000)
  assert.equal(model.byId.get('f:5000.js').size, 7000)
  assert.equal(model.byId.get('f:5000.js').removable, 7000)
  const all = layoutSizeFlow(model)
  assert.equal(all.nodes.length, 12000)
  assert.equal(all.edges.length, 11999)
  assert.equal(all.byId.get('f:11999.js').level, 11999)
  const zero = layoutSizeFlow(buildSizeFlow(fixture({ 'entry.js': { size: 0, imports: ['zero.js'] }, 'zero.js': { size: 0 } })))
  assert.ok(zero.edges[0].width1 > 0 && zero.edges[0].width2 > 0)
  assert.ok(!/NaN|Infinity/u.test(flowRibbon(zero.edges[0])))
})

test('wide rows pack small dependencies without gaps or obscuring the large flow', () => {
  const small = Array.from({ length: 200 }, (_, i) => `small-${i}/index.js`)
  const graph = fixture({
    'entry.js': { size: 0, imports: ['large/index.js', ...small] },
    'large/index.js': { size: 1e6, imports: [] },
    ...Object.fromEntries(small.map(file => [file, { size: 1, imports: [] }])),
  })
  for (const packages of [false, true]) {
    const layout = layoutSizeFlow(buildSizeFlow(graph, { packages }))
    const row = layout.nodes.filter(n => n.level === 1).toSorted((a, b) => a.x - b.x)
    assert.equal(row.length, 201)
    for (let i = 1; i < row.length; i++) assert.equal(row[i].x, row[i - 1].x + row[i - 1].width)
    assert.ok(row[0].width > .75 * row.reduce((sum, n) => sum + n.width, 0), 'the large dependency dominates despite hundreds of small neighbors')
    assert.equal(row[1].width, .1, 'small nodes keep a sixtieth of the former 6px floor, so sizes stay comparable')
    const largeEdge = layout.edges.find(e => e.size === 1e6), smallEdge = layout.edges.find(e => e.size === 1)
    assert.ok(smallEdge.width1 < largeEdge.width1 / 3900, 'minimum ribbon weight is also reduced fourfold')
    for (const edge of layout.edges) {
      const from = layout.byId.get(edge.from), to = layout.byId.get(edge.to)
      assert.ok(edge.x1 + edge.width1 <= from.x + from.width + .001)
      assert.ok(edge.x2 + edge.width2 <= to.x + to.width + .001)
    }
  }
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

test('Large chooses a cutoff using the current and next step counts', () => {
  const threshold = (...groups) => sizeFlowLargeThreshold({ byId: new Map(groups.flatMap(([count, removable, own = removable]) =>
    Array.from({ length: count }, () => ({ filterSize: Math.max(removable, own) }))).map((node, i) => [i, node])) })
  assert.equal(threshold([100, 200 * 1024]), 0, '100 nodes need no filtering')
  assert.equal(threshold([200, 1023], [49, 200 * 1024]), 0, 'do not enable a filter that would keep fewer than 50 nodes')
  for (const kib of [1, 4, 10, 20, 50, 100, 200]) {
    assert.equal(threshold([101, kib * 1024 - 1], [50, kib * 1024]), kib * 1024, `include the exact ${kib} KiB boundary`)
  }
  assert.equal(threshold([200, 500], [100, 4096]), 1024, 'stop once the current step retains 100 nodes')
  assert.equal(threshold([60, 1024], [49, 4096]), 1024, 'keep more than 100 when the next step would be too sparse')
  assert.equal(threshold([1000, 200 * 1024]), 200 * 1024, '200 KiB is the final step even if many nodes remain')
  assert.equal(threshold([101, 4095, 0], [50, 0, 4096]), 4096, 'own code can meet the threshold independently')
  assert.equal(threshold([101, 0, 4095], [50, 4096, 0]), 4096, 'removal impact can meet the threshold independently')
})

test('Follow imports temporarily hides Large below 200 unfiltered descendants in the current file/package mode', () => {
  const Flow = customElements.get('size-flow')
  for (const packages of [false, true]) { for (const count of [199, 200, 201]) {
    const tree = Object.fromEntries(Array.from({ length: count - 1 }, (_, i) =>
      [`pkg${i}/index.js`, { size: i < 60 ? 8192 : 512, imports: [] }]))
    if (packages) { for (let i = 0; i < count - 1; i++) tree[`pkg${i}/helper.js`] = { size: 512, imports: [] } }
    tree['entry.js'] = { size: 1, imports: Object.keys(tree) }
    tree['unreachable.js'] = { size: 9999, imports: [] }
    const flow = new Flow()
    flow.graph = fixture(tree); flow.packages = packages; flow.willUpdate(new Map([['graph', null]]))
    assert.equal(flow.model.byId.size, count)
    assert.ok(flow.minSize > 0)
    assert.equal(flow.layout.nodes.length, 61, 'Large initially hides small nodes')
    const root = flow.model.roots[0]
    flow.follow(root); flow.willUpdate(new Map())
    assert.equal(flow.largeOnly, true, 'following does not change the saved setting')
    assert.equal(flow.renderControls() === null, count < 200, 'hide the switch strictly below 200')
    assert.equal(flow.minSize, count < 200 ? 0 : flow.largeThreshold)
    assert.equal(flow.focus, root)
    assert.equal(flow.layout.nodes.length, count < 200 ? count : 61)
    assert.equal(flow.needsFit, true)
    flow.follow(null); flow.willUpdate(new Map())
    assert.equal(flow.largeOnly, true, 'leaving Follow imports does not change the switch')
    assert.notEqual(flow.renderControls(), null)
    assert.equal(flow.layout.nodes.length, 61, 'restore Large filtering on exit')
    flow.toggleLarge(); flow.follow(root); flow.willUpdate(new Map())
    assert.equal(flow.largeOnly, false, 'navigation never turns an explicit off setting on')
    flow.follow(null); flow.willUpdate(new Map())
    assert.equal(flow.minSize, 0, 'an explicit off setting remains off after exit')
  } }
})

test('following a small subtree in a large bundle reveals every node and deselecting exits it', () => {
  for (const packages of [false, true]) {
    const tree = Object.fromEntries(Array.from({ length: 250 }, (_, i) =>
      [`unrelated${i}/index.js`, { size: i < 60 ? 8192 : 512, imports: [] }]))
    for (let i = 0; i < 10; i++) tree[`dep${i}/index.js`] = { size: i === 0 ? 8192 : 512, imports: [] }
    tree['dep1/index.js'].imports = ['dep2/index.js']
    tree['dep2/index.js'].imports = ['dep1/index.js']
    tree['follow/index.js'] = { size: 8192, imports: Array.from({ length: 10 }, (_, i) => `dep${i}/index.js`) }
    tree['entry.js'] = { size: 1, imports: [...Object.keys(tree).filter(id => id.startsWith('unrelated')), 'follow/index.js'] }
    const Flow = customElements.get('size-flow'), flow = new Flow()
    flow.graph = fixture(tree); flow.packages = packages; flow.willUpdate(new Map([['graph', null]]))
    assert.ok(flow.model.byId.size > 200)
    assert.ok(flow.minSize > 0)
    const root = packages ? 'p:follow' : 'f:follow/index.js'
    assert.equal(layoutSizeFlow(flow.model, { focus: root, minSize: flow.minSize }).nodes.length, 2)
    for (const enabled of [true, false]) {
      if (flow.largeOnly !== enabled) flow.toggleLarge()
      flow.willUpdate(new Map())
      const count = flow.layout.nodes.length
      flow.follow(root); flow.willUpdate(new Map())
      assert.equal(flow.largeOnly, enabled)
      assert.equal(flow.minSize, 0)
      assert.equal(flow.renderControls(), null, 'hide Large while its filtering is temporarily bypassed')
      assert.equal(flow.layout.nodes.length, 11, 'count shared descendants once and terminate cycles')
      flow.willUpdate(new Map())
      assert.equal(flow.renderControls(), null, 'suppression survives ordinary rerenders')
      flow.needsFit = false
      flow.select(null); flow.willUpdate(new Map())
      assert.equal(flow.selection, null)
      assert.equal(flow.focus, null, 'empty-space clicks and the panel close action both exit Follow imports')
      assert.equal(flow.largeOnly, enabled)
      assert.notEqual(flow.renderControls(), null)
      assert.equal(flow.layout.nodes.length, count, 'restore the original Large setting and visible nodes')
      assert.equal(flow.needsFit, true)
    }
  }
})

test('Large uses removal impact and own code, adapts to files/packages and preserves manual off', () => {
  const small = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`small-${i}.js`, { size: 1, imports: [] }]))
  const medium = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`medium-${i}.js`, { size: 1024, imports: [] }]))
  const large = Object.fromEntries(Array.from({ length: 47 }, (_, i) => [`large-${i}.js`, { size: 5000, imports: [] }]))
  const tree = {
    ...small, ...medium, ...large,
    'entry.js': { size: 1, imports: [...Object.keys(small), ...Object.keys(medium), ...Object.keys(large), 'via.js', 'other.js', 'boundary.js', 'below.js'] },
    'via.js': { size: 1, imports: ['shared.js'] },
    'other.js': { size: 1, imports: ['shared.js'] },
    'shared.js': { size: 5000, imports: [] },
    'boundary.js': { size: 4096, imports: [] },
    'below.js': { size: 4095, imports: [] },
  }
  const Flow = customElements.get('size-flow'), flow = new Flow()
  flow.graph = fixture(tree); flow.willUpdate(new Map([['graph', null]]))
  assert.equal(flow.graph.nodes.length, 173)
  assert.equal(flow.minSize, 4096)
  assert.notEqual(flow.renderControls(), null)
  assert.deepEqual(new Set(flow.layout.nodes.map(n => n.id)), new Set([...Object.keys(large).map(file => `f:${file}`), 'f:entry.js', 'f:via.js', 'f:shared.js', 'f:boundary.js']))
  assert.equal(flow.model.byId.get('f:via.js').removable, 1)
  assert.equal(flow.model.byId.get('f:via.js').size, 5001)
  assert.equal(flow.matchesNode(flow.model.byId.get('f:via.js')), true, 'keep one connector to the significant dependency')
  assert.equal(flow.matchesNode(flow.model.byId.get('f:other.js')), false, 'reachable size alone does not qualify a redundant wrapper')
  assert.equal(flow.matchesNode(flow.model.byId.get('f:below.js')), false)
  const model = flow.model
  flow.toggleLarge(); flow.willUpdate(new Map())
  assert.equal(flow.model, model, 'filtering never recomputes reachability on a pruned graph')
  assert.equal(flow.layout.nodes.length, 173)
  assert.equal(flow.matchesNode(flow.model.byId.get('f:below.js')), true)
  flow.follow('f:other.js'); flow.willUpdate(new Map())
  assert.equal(flow.focus, 'f:other.js')
  assert.equal(flow.minSize, 0)
  flow.select(null); flow.toggleLarge(); flow.willUpdate(new Map())
  assert.equal(flow.selection, null)
  flow.packages = true; flow.willUpdate(new Map([['packages', false]]))
  assert.equal(flow.layout.nodes.length, 1)
  assert.equal(flow.minSize, 0, 'recount packages rather than using the underlying number of files')
  assert.equal(flow.renderControls(), null)
  flow.packages = false; flow.willUpdate(new Map([['packages', true]]))
  assert.equal(flow.minSize, 4096)
  flow.toggleLarge(); flow.willUpdate(new Map())
  flow.packages = true; flow.willUpdate(new Map([['packages', false]]))
  flow.packages = false; flow.willUpdate(new Map([['packages', true]]))
  assert.equal(flow.largeThreshold, 4096)
  assert.equal(flow.minSize, 0, 'an explicit off setting survives content switches')
  flow.toggleLarge(); flow.willUpdate(new Map())
  const hundred = Object.fromEntries(Object.entries(tree).slice(0, 99))
  hundred['entry.js'] = { size: 1, imports: Object.keys(hundred) }
  hundred['unreachable.js'] = { size: 10000 }
  flow.graph = fixture(hundred); flow.willUpdate(new Map([['graph', null]]))
  assert.equal(flow.minSize, 0)
  assert.equal(flow.renderControls(), null, 'only reachable nodes count toward the heuristic')
  assert.equal(flow.layout.nodes.length, 100)
})

describe('Size flow chart', () => {
  function mounted(t) {
    const previousQuery = graph2.pathFilter
    graph2.pathFilter = ''
    t.after(() => { graph2.pathFilter = previousQuery })
    const tree = {
      'entry.js': { size: 10, imports: ['a.js', 'b.js'] },
      'a.js': { size: 20, imports: ['shared.js'] },
      'b.js': { size: 30, imports: ['shared.js'] },
      'shared.js': { size: 1000, imports: [] },
    }
    const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf: () => 'app' })
    graph.flowEntries = [{ file: 'entry.js' }]
    const Flow = customElements.get('size-flow'), host = new Flow()
    host.graph = graph; host.willUpdate(new Map([['graph', null]]))
    return { host, chart: host.chart }
  }

  test('tooltips show a single version or group installed copies by version with their own sizes', () => {
    const node = { label: 'dep', removable: 5120, size: 8192, own: 5120, filterSize: 5120 }
    assert.match(flowNodeTooltip({ ...node, version: '1.2.3' }, 0), /\nVersion: 1\.2\.3$/u, 'file nodes retain their recorded package version')
    const instances = [{ version: '1.2.3', size: 1024, missing: 0 }, { version: '1.2.3', size: 2048, missing: 0 },
      { version: '2.0.0', size: 2048, missing: 0 }, { version: undefined, size: 0, missing: 1 }]
    assert.match(flowNodeTooltip({ ...node, instances: instances.slice(0, 1) }, 0), /\nVersion: 1\.2\.3$/u)
    const tooltip = flowNodeTooltip({ ...node, instances }, 0)
    assert.match(tooltip, /Versions · own source size\n1\.2\.3 · 3\.0 KiB · 2 copies\n2\.0\.0 · 2\.0 KiB · 1 copy\nUnknown version · 0 B\+ · 1 copy/u)
    assert.equal(tooltip.split('1.2.3').length - 1, 1, 'repeated versions are grouped only in the tooltip')
  })

  test('filter changes refresh dimming and cached search results', t => {
    const { host, chart } = mounted(t)
    const matching = t.mock.method(host, 'matchesNode')
    graph2.pathFilter = 'shared'
    const results = chart.searchMatches()
    assert.deepEqual(results.map(n => n.id), ['f:shared.js'])
    assert.equal(chart.searchMatches(), results)
    assert.equal(matching.mock.callCount(), host.model.byId.size, 'evaluate each node once, not once per incident ribbon')
    for (const e of host.model.edges) assert.equal(chart.edgeAlpha(e), e.to === 'f:shared.js' ? .22 : .04)
    graph2.pathFilter = ''
    assert.equal(chart.searchMatches().length, 4)
    for (const e of host.model.edges) assert.equal(chart.edgeAlpha(e), .22)
  })
  test('hiding Issues ignores saved severity and mark filters while keeping path and Large filters', t => {
    const { chart, host } = mounted(t)
    const colors = graph2.selectedColors, severities = graph2.selectedSeverities
    t.after(() => { graph2.selectedColors = colors; graph2.selectedSeverities = severities })
    graph2.selectedColors = new Set(['red'])
    graph2.selectedSeverities = new Set(['high'])
    Object.assign(host.model.files.get('a.js'), { severitySet: new Set(['high']), colorSet: new Set(['red']) })
    assert.deepEqual(chart.searchMatches().map(n => n.id), ['f:a.js'])
    host.graph.issuesHidden = true
    assert.equal(chart.searchMatches().length, 4)
    graph2.pathFilter = 'shared'
    assert.deepEqual(chart.searchMatches().map(n => n.id), ['f:shared.js'], 'path filtering remains active with Issues off')
    graph2.pathFilter = ''
    host.largeThreshold = 2000
    assert.equal(chart.searchMatches().length, 0, 'Large filtering remains active with Issues off')
    host.largeThreshold = 0
    host.graph.issuesHidden = false
    assert.deepEqual(chart.searchMatches().map(n => n.id), ['f:a.js'], 'turning Issues on restores the saved filters')
    assert.equal(chart.matchingNodes().has('f:shared.js'), false)
  })
  test('node descriptions and search order use removal impact rather than reachable size', t => {
    const { chart, host } = mounted(t)
    assert.deepEqual(chart.searchMatches().map(n => n.id), ['f:entry.js', 'f:shared.js', 'f:b.js', 'f:a.js'])
    assert.ok(flowNodeTooltip(host.layout.byId.get('f:a.js'), host.minSize).startsWith('a.js\n20 B unique · 1020 B reachable · 20 B own'))
  })

  test('small retained connectors explain why they remain under Large', t => {
    const { host } = mounted(t)
    const tooltip = id => flowNodeTooltip(host.layout.byId.get(id), host.minSize)
    host.largeThreshold = 500; host.willUpdate(new Map())
    assert.match(tooltip('f:a.js'), /Kept by Large to preserve an entry-point path/u)
    assert.doesNotMatch(tooltip('f:shared.js'), /Kept by Large/u)
    host.toggleLarge(); host.willUpdate(new Map())
    assert.doesNotMatch(tooltip('f:a.js'), /Kept by Large/u)
  })
})

describe('Size flow Large filter', () => {
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
      const model = buildSizeFlow(rawGraph(tree), { packages })
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
    const reversed = layoutSizeFlow(buildSizeFlow(rawGraph(tree)), { minSize: 100 * 1024 })
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
    const layout = layoutSizeFlow(buildSizeFlow(rawGraph(tree)), { minSize: 4096 })
    assert.deepEqual(layout.nodes.map(n => n.id), ['f:entry', 'f:shared'])
    assertConnected(layout)
    const multiple = layoutSizeFlow(buildSizeFlow(rawGraph(tree, ['entry', 'shared'])), { minSize: 4096 })
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
    const layout = layoutSizeFlow(buildSizeFlow(rawGraph(tree), { packages: true }), { minSize: 4096 })
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
    const model = buildSizeFlow(rawGraph(tree))
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
    const model = buildSizeFlow(rawGraph(tree))
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
        const model = buildSizeFlow(rawGraph(tree, entries), { packages })
        for (const minSize of [1024, 4096, 10240, 102400]) {
          const layout = layoutSizeFlow(model, { minSize })
          for (const node of model.byId.values()) assert.ok(Math.max(node.own, node.removable) < minSize || layout.byId.has(node.id))
          assertConnected(layout)
          assertConnectedFiles(tree, entries, layout)
        }
      }
    }
  })
})

describe('Size flow reachability', () => {
  function reachable(next, starts, weights, unknown) {
    const seen = new Set(), stack = [...starts]
    let missing = 0, size = 0
    while (stack.length > 0) {
      const id = stack.pop()
      if (seen.has(id)) continue
      seen.add(id); size += weights[id]; missing += unknown[id]
      stack.push(...next[id])
    }
    return { size, missing }
  }

  test('batched reachability matches independent traversal across word boundaries and arbitrary component order', () => {
    let seed = 123
    const random = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max }
    for (const count of [0, 1, 31, 32, 33, 63, 64, 65, 127, 257]) {
      const order = Array.from({ length: count }, (_, i) => i)
      for (let i = count - 1; i > 0; i--) { const j = random(i + 1); [order[i], order[j]] = [order[j], order[i]] }
      const next = order.map(() => new Set())
      for (let i = 0; i < count - 1; i++) {
        next[order[i]].add(order[i + 1])
        for (let j = 0; j < 4; j++) next[order[i]].add(order[i + 1 + random(count - i - 1)])
      }
      const weights = order.map(() => random(10000))
      const unknown = order.map(() => random(3))
      for (const remaining of [order, order.filter((_, i) => i % 3 === 0)]) {
        for (const [id, total] of batchedReachability(next, order, weights, unknown, remaining)) {
          assert.deepEqual(total, reachable(next, [id], weights, unknown), `${count} components, node ${id}`)
        }
      }
    }
  })

  test('large overlapping closures retain exact file, package, edge and bundle totals', () => {
    const count = 800
    const next = Array.from({ length: count }, (_, i) => [i + 1, i + 2, i + 53].filter(id => id < count))
    // Condensed cycles and an unreachable component must also be counted once.
    next[45].push(39)
    const weights = next.map((_, i) => i % 13 ? i + 1 : 0)
    const unknown = next.map((_, i) => Number(i % 13 === 0))
    const names = next.map((_, i) => `pkg${Math.floor(i / 20)}/${i}`)
    const graph = {
      nodes: names.map((file, i) => ({ file, pkg: file.split('/')[0], size: unknown[i] ? null : weights[i] })),
      importsOf: new Map(names.map((file, i) => [file, next[i].map(id => names[id])])),
      flowEntries: [{ file: names[0] }, { file: names[10] }],
    }
    graph.nodes.push({ file: 'unreachable', pkg: 'unreachable', size: 1e9 })
    graph.importsOf.set('unreachable', [])
    const index = new Map(names.map((file, i) => [file, i]))
    for (const packages of [false, true]) {
      const model = buildSizeFlow(graph, { packages })
      for (const node of model.byId.values()) {
        assert.deepEqual({ size: node.size, missing: node.missing }, reachable(next, node.files.map(file => index.get(file)), weights, unknown))
      }
      for (const edge of model.edges) {
        assert.deepEqual({ size: edge.size, missing: edge.missing }, reachable(next, [...edge.targets].map(file => index.get(file)), weights, unknown))
      }
      assert.deepEqual(model.total, reachable(next, [0, 10], weights, unknown))
    }
  })
})

describe('Size flow removal impact', () => {
  const rawDiamond = {
    entry: { size: 10, imports: ['a/index', 'b/index'] },
    'a/index': { size: 20, imports: ['shared/index'] },
    'b/index': { size: 30, imports: ['shared/index'] },
    'shared/index': { size: 1000 },
    unreachable: { size: 9000 },
  }

  test('bar widths and labels measure deletion impact, without summing incident flows', () => {
    const model = buildSizeFlow(rawGraph(rawDiamond))
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
    const model = buildSizeFlow(rawGraph(rawDiamond, ['entry', 'a/index']))
    assert.equal(model.byId.get('f:entry').removable, 40)
    assert.equal(model.byId.get('f:a/index').removable, 20)
    assert.equal(model.byId.get('f:shared/index').removable, 1000)
  })

  test('deletion can break a cycle without deleting every member of the original component', () => {
    const model = buildSizeFlow(rawGraph({
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
    const files = buildSizeFlow(rawGraph(tree)), packages = buildSizeFlow(rawGraph(tree), { packages: true })
    assert.equal(files.byId.get('f:pkg/a').removable, 20)
    assert.equal(files.byId.get('f:pkg/b').removable, 30)
    assert.equal(packages.byId.get('p:pkg').removable, 1050, 'package impact is more than the sum of individual file impacts')
    tree.entry.imports.push('other/index')
    tree['other/index'] = { size: 5, imports: ['shared/index'] }
    assert.equal(buildSizeFlow(rawGraph(tree), { packages: true }).byId.get('p:pkg').removable, 50)
  })

  test('package aggregation does not invent paths through unrelated files in a package', () => {
    const model = buildSizeFlow(rawGraph({
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
    const graph = rawGraph({
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
        const model = buildSizeFlow(rawGraph(tree, entries), { packages })
        for (const row of model.byId.values()) {
          const survivors = remaining(new Set(row.files))
          const removed = [...baseline].filter(file => !survivors.has(file))
          assert.equal(row.removable, removed.reduce((sum, file) => sum + (tree[file].size ?? 0), 0), `${iteration}: ${row.id}`)
          assert.equal(row.removableMissing, removed.filter(file => tree[file].size == null).length)
        }
      }
    }
  })
})
