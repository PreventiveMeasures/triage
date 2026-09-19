import assert from 'node:assert/strict'
import { it } from 'node:test'
import { buildDependencyMatrix, stronglyConnected } from '../ui/view/graph/matrix-model.js'
import { MATRIX_LEFT, MATRIX_TOP, matrixFitCell, matrixHit, matrixZoomCell } from '../ui/view/graph/matrix-paint.js'
import { layoutDependencyLayers } from '../ui/view/graph/layered-layout.js'
import { makeLargeGraph } from '../examples/large-graph-sample.js'

function fixture() {
  return {
    nodes: [
      { file: 'app/a.js', pkg: 'app', size: 10 },
      { file: 'app/b.js', pkg: 'app', size: 20 },
      { file: 'dep/x.js', pkg: 'dep', size: 30 },
      { file: 'dep/y.js', pkg: 'dep', size: 40 },
      { file: 'leaf.js', pkg: 'leaf', size: 50 },
      { file: 'isolated.js', pkg: 'isolated', size: 60 },
    ],
    importsOf: new Map([
      ['app/a.js', ['app/b.js', 'dep/x.js', 'dep/x.js', 'absent.js']],
      ['app/b.js', ['dep/y.js']],
      ['dep/x.js', ['app/a.js', 'leaf.js']],
      ['dep/y.js', ['leaf.js']],
    ]),
  }
}

function cycleFixture(edges) {
  const packages = new Set(edges.flatMap(([from, to]) => [from, to]))
  const nodes = [...packages].flatMap((pkg) => Array.from({ length: Math.max(1, ...edges.filter(([from]) => from === pkg).map(([, , count = 1]) => count)) },
    (_, i) => ({ file: `${pkg}/${i}.js`, pkg, size: 1 })))
  const importsOf = new Map(nodes.map((node) => [node.file, []]))
  for (const [from, to, count = 1] of edges) {
    for (let i = 0; i < count; i++) importsOf.get(`${from}/${i}.js`).push(`${to}/0.js`)
  }
  return { nodes, importsOf }
}

it('aggregates directed imports without inventing reverse edges, duplicates, or absent nodes', () => {
  const model = buildDependencyMatrix(fixture())
  assert.equal(model.rows.length, 4)
  assert.equal(model.importCount, 6)
  assert.equal(model.byId.get('p:app').size, 30)
  assert.equal(model.cells.get('p:app').get('p:dep').count, 2)
  assert.equal(model.cells.get('p:dep').get('p:app').count, 1)
  assert.equal(model.cells.get('p:leaf'), undefined)
  assert.deepEqual(model.cells.get('p:app').get('p:dep').examples, [['app/a.js', 'dep/x.js'], ['app/b.js', 'dep/y.js']])
})

it('expands files in context while retaining every external import and byte', () => {
  const graph = fixture()
  const before = structuredClone(graph)
  const model = buildDependencyMatrix(graph, { expanded: new Set(['app']) })
  assert.equal(model.rows.length, 5)
  assert.equal(model.importCount, 6)
  assert.equal(model.cells.get('f:app/a.js').get('p:dep').count, 1)
  assert.equal(model.cells.get('p:dep').get('f:app/a.js').count, 1)
  assert.equal(model.cells.get('f:app/a.js').get('f:app/b.js').count, 1)
  assert.equal(model.rows.reduce((sum, row) => sum + row.size, 0), 210)
  assert.deepEqual(graph, before)
})

it('groups cycles and orders inter-component dependencies from source to target', () => {
  const model = buildDependencyMatrix(fixture())
  assert.equal(model.cycleCount, 1)
  assert.equal(model.byId.get('p:app').component, model.byId.get('p:dep').component)
  assert.equal(model.cells.get('p:app').get('p:dep').cyclic, true)
  assert.equal(model.cells.get('p:dep').get('p:leaf').cyclic, false, 'leaving a cycle does not make an import cyclic')
  assert.equal(model.cells.get('p:app').get('p:app').cyclic, false, 'internal imports do not prove a package has an internal cycle')
  assert.ok(model.index.get('p:dep') < model.index.get('p:leaf'))
  assert.deepEqual(new Set(buildDependencyMatrix(fixture(), { cyclesOnly: true }).rows.map((r) => r.id)), new Set(['p:app', 'p:dep']))
  const graph = fixture()
  graph.importsOf = new Map([['app/a.js', ['app/b.js']]])
  assert.equal(buildDependencyMatrix(graph).cycleCount, 0)
})

it('orders cyclic groups mostly above the diagonal instead of alphabetically', () => {
  const graph = cycleFixture([['z', 'y', 5], ['y', 'x', 5], ['x', 'w', 5], ['w', 'z'], ['z', 'x', 3], ['y', 'w', 3]])
  const model = buildDependencyMatrix(graph)
  assert.equal(model.cycleCount, 1)
  assert.deepEqual(model.rows.map((r) => r.pkg), ['z', 'y', 'x', 'w'])
  assert.equal(model.visibleCells.filter((c) => c.row < c.col).reduce((n, c) => n + c.count, 0), 21)
  assert.equal(model.visibleCells.filter((c) => c.row > c.col).reduce((n, c) => n + c.count, 0), 1)
  // Explicit sort modes still honor their selected metric/name.
  assert.deepEqual(buildDependencyMatrix(graph, { order: 'name' }).rows.map((r) => r.pkg), ['w', 'x', 'y', 'z'])
  for (const order of ['imports', 'importers']) {
    const rows = buildDependencyMatrix(graph, { order }).rows
    const metric = order === 'imports' ? 'outgoing' : 'incoming'
    assert.ok(rows.every((row, i) => i === 0 || rows[i - 1][metric] >= row[metric]))
  }
  // Input enumeration order must not reshuffle a cycle on each rebuild.
  const reversed = { nodes: graph.nodes.toReversed(), importsOf: new Map([...graph.importsOf].toReversed().map(([from, targets]) => [from, targets.toReversed()])) }
  assert.deepEqual(buildDependencyMatrix(reversed).rows.map((r) => r.id), model.rows.map((r) => r.id))
})

it('uses import counts inside a cycle and ignores external and diagonal imports when balancing it', () => {
  const edges = [['a', 'b'], ['b', 'z'], ['z', 'a', 10]]
  const baseline = buildDependencyMatrix(cycleFixture(edges))
  assert.deepEqual(baseline.rows.map((r) => r.pkg), ['z', 'a', 'b'])
  const graph = cycleFixture([...edges, ['a', 'sink', 50], ['source', 'z', 50], ['b', 'b', 50]])
  const model = buildDependencyMatrix(graph)
  assert.deepEqual(model.rows.filter((r) => r.cyclic).map((r) => r.pkg), ['z', 'a', 'b'])
  assert.equal(model.importCount, 162, 'ordering preserves all imports')
})

it('balances the rest of an App cycle while keeping App first and the block contiguous', () => {
  const graph = cycleFixture([['__own__', 'z'], ['z', 'y', 5], ['y', 'x', 5], ['x', '__own__', 20], ['x', 'sink'], ['other-a', 'other-b'], ['other-b', 'other-a']])
  const model = buildDependencyMatrix(graph)
  assert.deepEqual(model.rows.slice(0, 4).map((r) => r.pkg), ['__own__', 'z', 'y', 'x'])
  assert.ok(model.rows.slice(0, 4).every((r) => r.component === model.rows[0].component))
  // The same ordering also applies to a cycle of individual files.
  const files = cycleFixture([['z', 'y'], ['y', 'x'], ['x', 'w'], ['w', 'z'], ['z', 'x'], ['y', 'w']])
  for (const node of files.nodes) node.pkg = '__own__'
  const expanded = buildDependencyMatrix(files, { expanded: new Set(['__own__']) })
  assert.equal(expanded.visibleCells.filter((c) => c.row > c.col).length, 1)
  assert.equal(expanded.rows.length, 4)
})

it('keeps App first in every order and keeps its cyclic group together in Structure', () => {
  const graph = fixture()
  for (const node of graph.nodes) if (node.pkg === 'app') node.pkg = '__own__'
  graph.importsOf.get('dep/x.js').push('isolated.js')
  graph.importsOf.get('dep/y.js').push('isolated.js')
  for (const order of ['structure', 'name', 'importers', 'imports']) {
    const model = buildDependencyMatrix(graph, { order })
    assert.equal(model.rows[0].id, 'p:__own__', order)
    if (order === 'structure') assert.equal(model.rows[1].id, 'p:dep')
    const expanded = buildDependencyMatrix(graph, { order, expanded: new Set(['__own__']) })
    assert.deepEqual(expanded.rows.slice(0, 2).map((row) => row.pkg), ['__own__', '__own__'], order)
    if (order === 'structure') assert.equal(expanded.rows[2].id, 'p:dep')
  }
})

it('keeps named app roots first without treating an arbitrary package named app as own source', () => {
  const graph = fixture()
  graph.layerRoots = { roots: ['app'] }
  for (const order of ['structure', 'name', 'importers', 'imports']) {
    assert.equal(buildDependencyMatrix(graph, { order }).rows[0].id, 'p:app')
  }
  // An unrelated search result must not gain an App row just because it is pinned.
  assert.deepEqual(buildDependencyMatrix(graph, { query: 'isolated' }).rows.map((row) => row.id), ['p:isolated'])
})

it('keeps all split own-source directories ahead of dependencies, including dependencies in source cycles', () => {
  for (const hasRootFiles of [false, true]) {
    const edges = [['src', 'dep-cycle'], ['dep-cycle', 'src'], ['src', 'lib', 2], ['lib', 'dep-leaf']]
    if (hasRootFiles) edges.push(['__own__', 'src'], ['dep-cycle', '__own__'])
    const graph = cycleFixture(edges)
    graph.nodes.push({ file: 'tools/unused.js', pkg: 'tools' })
    const ownPackages = new Set(['src', 'lib', 'tools', ...(hasRootFiles ? ['__own__'] : [])])
    graph.layerRoots = { roots: [...ownPackages] }
    for (const order of ['structure', 'name', 'importers', 'imports']) {
      for (const expanded of [new Set(), ownPackages]) {
        const model = buildDependencyMatrix(graph, { order, expanded })
        const ownRows = model.rows.filter((row) => ownPackages.has(row.pkg))
        assert.deepEqual(model.rows.slice(0, ownRows.length), ownRows, `${order}, expanded=${expanded.size}, root files=${hasRootFiles}`)
        if (hasRootFiles) assert.equal(model.rows[0].pkg, '__own__')
        assert.ok(model.rows.slice(ownRows.length).every((row) => !ownPackages.has(row.pkg)))
        assert.equal(model.cycleCount, 1, 'prioritizing own directories must preserve cycle membership')
        assert.equal(model.cells.get(expanded.size > 0 ? 'f:src/0.js' : 'p:src').get('p:dep-cycle').cyclic, true)
      }
    }
  }
})

it('puts modules missing imports or importers last, ignoring package-internal imports', () => {
  const graph = {
    nodes: [
      { file: 'app.js', pkg: '__own__' },
      { file: 'middle.js', pkg: 'middle' },
      { file: 'source.js', pkg: 'aaa-source' },
      { file: 'sink.js', pkg: 'bbb-sink' },
      { file: 'isolated-a.js', pkg: 'ccc-isolated' },
      { file: 'isolated-b.js', pkg: 'ccc-isolated' },
    ],
    importsOf: new Map([
      ['app.js', ['middle.js', 'sink.js']],
      ['middle.js', ['sink.js']],
      ['source.js', ['middle.js', 'sink.js']],
      ['isolated-a.js', ['isolated-b.js']],
      ['isolated-b.js', ['isolated-a.js']],
    ]),
  }
  for (const order of ['structure', 'name', 'importers', 'imports']) {
    const model = buildDependencyMatrix(graph, { order })
    assert.deepEqual(model.rows.slice(0, 2).map((row) => row.pkg), ['__own__', 'middle'], order)
    assert.deepEqual(new Set(model.rows.slice(2).map((row) => row.pkg)), new Set(['aaa-source', 'bbb-sink', 'ccc-isolated']))
  }
})

it('searches retain only the match and its direct neighbors', () => {
  const model = buildDependencyMatrix(fixture(), { query: 'leaf' })
  assert.deepEqual(new Set(model.rows.map((r) => r.id)), new Set(['p:leaf', 'p:dep']))
  const empty = buildDependencyMatrix(fixture(), { query: 'no match' })
  assert.equal(empty.rows.length, 0)
  assert.equal(empty.visibleCells.length, 0)
  const focused = buildDependencyMatrix(fixture(), { neighborhood: 'p:app' })
  assert.deepEqual(new Set(focused.rows.map((r) => r.id)), new Set(['p:app', 'p:dep']))
})

it('hit testing follows the fixed axes and panned matrix', () => {
  const model = buildDependencyMatrix(fixture())
  const view = { cell: 20, x: 20, y: 40 }
  assert.deepEqual(matrixHit(MATRIX_LEFT + 2, MATRIX_TOP + 2, model, view), { row: 2, col: 1 })
  assert.deepEqual(matrixHit(10, MATRIX_TOP + 2, model, view), { row: 2, col: null })
  assert.deepEqual(matrixHit(MATRIX_LEFT + 2, 10, model, view), { row: 1, col: null })
  assert.equal(matrixHit(10, 10, model, view), null)
})

it('limits zoom-out to the smaller of 100% and fit, including a fully expanded graph', () => {
  assert.equal(matrixFitCell(4, 900, 700), 24)
  assert.equal(matrixZoomCell(1, 4, 900, 700), 18)
  assert.equal(matrixZoomCell(20, 4, 900, 700), 20)
  assert.equal(matrixZoomCell(100, 4, 900, 700), 48)
  for (const rows of [1016, 26423]) {
    const fit = matrixFitCell(rows, 900, 700)
    assert.ok(fit < 18)
    assert.equal(matrixZoomCell(fit / 2, rows, 900, 700), fit)
    assert.equal(matrixZoomCell(fit * 2, rows, 900, 700), fit * 2)
    assert.ok(matrixZoomCell(fit, rows, 1200, 900) > fit, 'a larger viewport raises the minimum zoom')
  }
})

it('handles the 26k-file sample sparsely, including full file expansion', () => {
  const graph = makeLargeGraph()
  const start = performance.now()
  const collapsed = buildDependencyMatrix(graph)
  assert.equal(collapsed.rows.length, 1016)
  assert.equal(collapsed.rows.reduce((sum, row) => sum + row.files.length, 0), 26423)
  const links = new Map([...collapsed.cells].map(([id, targets]) => [id, [...targets.keys()]]))
  const layers = layoutDependencyLayers(collapsed.rows, links, ['p:__own__'])
  assert.equal(layers.depth.size, 1016, 'every package must be reachable from App')
  assert.deepEqual(layers.levels.map((l) => l.level), [0, 1, 2, 3, 4, 5, 6, 7])
  assert.ok(Math.max(...layers.levels.map((l) => l.ids.length)) >= 200, 'use broad levels, not a narrow chain')
  const crossCells = collapsed.visibleCells.filter((c) => c.from !== c.to)
  assert.equal(collapsed.importCount, 66321)
  assert.equal(crossCells.reduce((sum, cell) => sum + cell.count, 0), 31111)
  assert.ok(crossCells.length > 20000, 'imports should spread across many package pairs')
  const cycleGroups = Map.groupBy(collapsed.rows.filter((r) => r.cyclic), (r) => r.component)
  assert.equal(cycleGroups.size, 7)
  assert.ok([...cycleGroups.values()].every((rows) => rows.length === 3), 'test cycles should not absorb the intervening alphabetical range')
  const expanded = buildDependencyMatrix(graph, { expanded: new Set(graph.packages) })
  assert.equal(expanded.rows.length, 26423)
  assert.equal(expanded.importCount, collapsed.importCount)
  assert.equal(expanded.visibleCells.length, expanded.importCount)
  assert.ok(expanded.visibleCells.length < 67000)
  console.log(`Matrix model: package overview + full file expansion ${Math.round(performance.now() - start)} ms`)
})

it('keeps medium samples reachable within five to ten shortest-path package levels', () => {
  for (const options of [
    { fileCount: 5345, packageCount: 518, edgeCount: 11432, layerCount: 5 },
    { fileCount: 8102, packageCount: 441, edgeCount: 23685, layerCount: 10 },
  ]) {
    const graph = makeLargeGraph(options), model = buildDependencyMatrix(graph)
    const links = new Map([...model.cells].map(([id, targets]) => [id, [...targets.keys()]]))
    const layers = layoutDependencyLayers(model.rows, links, ['p:__own__'])
    assert.equal(layers.depth.size, options.packageCount)
    assert.equal(layers.levels.length, options.layerCount)
    assert.equal(model.importCount, options.edgeCount)
    const reached = new Set([graph.nodes[0].file])
    const queue = [...reached]
    for (let i = 0; i < queue.length; i++) {
      for (const target of graph.importsOf.get(queue[i]) ?? []) {
        if (!reached.has(target)) { reached.add(target); queue.push(target) }
      }
    }
    assert.equal(reached.size, options.fileCount, 'all files must also be reachable from the entry point')
  }
})

it('finds cycles in a long chain without recursive call-stack overflow', () => {
  const ids = Array.from({ length: 30000 }, (_, i) => String(i))
  const links = new Map(ids.map((id, i) => [id, [ids[(i + 1) % ids.length]]]))
  const result = stronglyConnected(ids, links)
  assert.equal(result.groups.length, 1)
  assert.equal(result.groups[0].length, ids.length)
})

it('balances a large file cycle without a dense matrix or quadratic ordering', () => {
  const count = 26423
  const nodes = Array.from({ length: count }, (_, i) => ({ file: `app/${String(count - i).padStart(5, '0')}.js`, pkg: '__own__' }))
  const graph = { nodes, importsOf: new Map(nodes.map((node, i) => [node.file, [1, 2, 7].map((step) => nodes[(i + step) % count].file)])) }
  const start = performance.now()
  const model = buildDependencyMatrix(graph, { expanded: new Set(['__own__']) })
  assert.equal(model.cycleCount, 1)
  assert.equal(model.rows.length, count)
  assert.equal(model.visibleCells.length, count * 3)
  assert.ok(model.visibleCells.filter((cell) => cell.row < cell.col).length > count * 2.99, 'nearly all forward-flow imports should be above the diagonal')
  console.log(`Matrix ordering: 26k-file cyclic group ${Math.round(performance.now() - start)} ms`)
})
