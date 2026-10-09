import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/view/frontend-install.js'
import { buildGraph } from '../ui/view/graph/data.js'
import { buildSizeFlow, flowRibbon, layoutSizeFlow, sizeFlowLargeThreshold } from '../ui/view/graph/size-flow-model.js'
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

test('ribbons use the available bar width without crossing when their endpoints fit', () => {
  const layout = layoutSizeFlow(buildSizeFlow(fixture({
    'entry.js': { size: 500, imports: ['small.js', 'large.js', 'medium.js'] },
    'small.js': { size: 100 }, 'large.js': { size: 300 }, 'medium.js': { size: 200 },
  })))
  const root = layout.byId.get('f:entry.js')
  const outgoing = layout.edges.toSorted((a, b) => layout.byId.get(a.to).x - layout.byId.get(b.to).x)
  assert.equal(outgoing[0].x1, root.x)
  assert.ok(Math.abs(outgoing.at(-1).x1 + outgoing.at(-1).width1 - root.x - root.width) < 1e-8)
  for (let i = 1; i < outgoing.length; i++) assert.ok(outgoing[i].x1 >= outgoing[i - 1].x1 + outgoing[i - 1].width1)

  const packages = layoutSizeFlow(buildSizeFlow(fixture({
    'a/index.js': { size: 200, imports: ['lib/a.js'] },
    'b/index.js': { size: 400, imports: ['lib/b.js'] },
    'lib/entry.js': { size: 500 }, 'lib/a.js': { size: 100 }, 'lib/b.js': { size: 200 },
  }, ['a/index.js', 'b/index.js', 'lib/entry.js']), { packages: true }))
  const lib = packages.byId.get('p:lib')
  const incoming = packages.edges.toSorted((a, b) => packages.byId.get(a.from).x - packages.byId.get(b.from).x)
  assert.equal(incoming[0].x2, lib.x)
  assert.ok(incoming[0].x2 + incoming[0].width2 <= incoming[1].x2)
  assert.ok(Math.abs(incoming.at(-1).x2 + incoming.at(-1).width2 - lib.x - lib.width) < 1e-8)
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
    assert.equal(row[1].width, 1.5, 'small nodes use a quarter of the former 6px floor')
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

test('Follow imports disables Large below 200 unfiltered nodes, counting the current file/package mode', () => {
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
    assert.equal(flow.largeOnly, count >= 200, 'the automatic switch-off boundary is strictly below 200')
    assert.equal(flow.focus, root)
    assert.equal(flow.layout.nodes.length, count < 200 ? count : 61)
    assert.equal(flow.needsFit, true)
    if (count < 200) {
      flow.toggleLarge(); flow.willUpdate(new Map()); flow.willUpdate(new Map())
      assert.equal(flow.largeOnly, true, 'manual re-enabling survives later renders in Follow imports')
      assert.equal(flow.layout.nodes.length, 61)
    } else {
      flow.follow(packages ? 'p:pkg0' : 'f:pkg0/index.js'); flow.willUpdate(new Map())
      assert.equal(flow.layout.nodes.length, 1)
      assert.equal(flow.largeOnly, true, 'a small focused view does not replace the full-model count')
    }
    flow.follow(null); flow.willUpdate(new Map())
    assert.equal(flow.largeOnly, true, 'leaving Follow imports does not change the switch')
    flow.toggleLarge(); flow.follow(root); flow.willUpdate(new Map())
    assert.equal(flow.largeOnly, false, 'navigation never turns an explicit off setting on')
  } }
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
  assert.equal(flow.matches(flow.model.byId.get('f:via.js')), true, 'keep one connector to the significant dependency')
  assert.equal(flow.matches(flow.model.byId.get('f:other.js')), false, 'reachable size alone does not qualify a redundant wrapper')
  assert.equal(flow.matches(flow.model.byId.get('f:below.js')), false)
  const model = flow.model
  flow.toggleLarge(); flow.willUpdate(new Map())
  assert.equal(flow.model, model, 'filtering never recomputes reachability on a pruned graph')
  assert.equal(flow.layout.nodes.length, 173)
  assert.equal(flow.matches(flow.model.byId.get('f:below.js')), true)
  flow.follow('f:other.js'); flow.toggleLarge(); flow.willUpdate(new Map())
  assert.equal(flow.focus, null, 'clear a focused node when both its own size and removal impact fall below the cutoff')
  assert.equal(flow.selection, null, 'hide the selection when it no longer passes the filter')
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
