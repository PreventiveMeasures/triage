import assert from 'node:assert/strict'
import { describe, it, test } from 'node:test'
import '../ui/view/graph/dependency-matrix.js'
import { buildGraph } from '../ui/view/graph/data.js'
import { buildDependencyMatrix, stronglyConnected } from '../ui/view/graph/matrix-model.js'
import { MATRIX_LEFT, MATRIX_TOP, matrixFitCell, matrixHit, matrixZoomCell } from '../ui/view/graph/matrix-paint.js'
import { layoutDependencyLayers } from '../ui/view/graph/layered-layout.js'
import { makeLargeGraph } from '../examples/large-graph-sample.js'
import { renderMatrixPanel } from '../ui/view/graph/matrix-panel.js'
import { bundlePkgOf } from '../ui/view/bundle-pkg-of.js'
import { graph2 } from '../ui/view/graph/state.js'

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
    const metric = order === 'imports' ? 'dependencies' : 'importers'
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

it('keeps own source before dependency modules within its cycle', () => {
  const graph = cycleFixture([
    ['__own__', 'dep-cycle', 10], ['dep-cycle', '__own__', 10], ['__own__', 'dep-leaf'],
    ['dep-other', 'dep-last'], ['dep-last', 'dep-other'],
  ])
  const ownPackages = new Set(['__own__'])
  // A dependency can also be a recorded entry without being own source.
  graph.layerRoots = { roots: ['__own__', 'dep-cycle'] }
  graph.ownSourcePackages = ownPackages
  const cases = ['structure', 'name', 'importers', 'imports'].flatMap(order =>
    [new Set(), ownPackages].flatMap(expanded => [false, true].map(cyclesOnly => ({ order, expanded, cyclesOnly }))))
  for (const { order, expanded, cyclesOnly } of cases) {
    const model = buildDependencyMatrix(graph, { order, expanded, cyclesOnly })
    assert.equal(model.rows[0].pkg, '__own__')
    if (order === 'structure') {
      const components = Map.groupBy(model.rows, row => row.component)
      for (const members of components.values()) {
        const start = model.index.get(members[0].id)
        assert.deepEqual(model.rows.slice(start, start + members.length), members)
      }
      assert.equal(model.rows[0].component, model.byId.get('p:dep-cycle').component)
    }
    assert.equal(model.cycleCount, 2)
    assert.equal(model.cells.get(expanded.size > 0 ? 'f:__own__/0.js' : 'p:__own__').get('p:dep-cycle').cyclic, true)
  }
})

it('puts modules missing imports or importers last in Structure and Name, ignoring package-internal imports', () => {
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
  for (const order of ['structure', 'name']) {
    const model = buildDependencyMatrix(graph, { order })
    assert.deepEqual(model.rows.slice(0, 2).map((row) => row.pkg), ['__own__', 'middle'], order)
    assert.deepEqual(new Set(model.rows.slice(2).map((row) => row.pkg)), new Set(['aaa-source', 'bbb-sink', 'ccc-isolated']))
  }
})

it('ranks Most imported and Most imports by the other rows on each side, leaves included', () => {
  // `runtime` imports nothing but is imported by every package; `entry`
  // imports every package and has no importers. `big` has the most file
  // imports, all of them internal.
  const big = Array.from({ length: 5 }, (_, i) => `big/${i}.js`)
  const graph = {
    nodes: [
      { file: 'app.js', pkg: '__own__' },
      { file: 'runtime.js', pkg: 'runtime' },
      { file: 'entry.js', pkg: 'entry' },
      { file: 'middle.js', pkg: 'middle' },
      ...big.map((file) => ({ file, pkg: 'big' })),
    ],
    importsOf: new Map([
      ['app.js', ['runtime.js', 'middle.js']],
      ['entry.js', ['runtime.js', 'middle.js', 'big/0.js']],
      ['middle.js', ['runtime.js']],
      ...big.map((file) => [file, ['runtime.js', ...big.filter((other) => other !== file)]]),
    ]),
  }
  const importers = buildDependencyMatrix(graph, { order: 'importers' })
  assert.deepEqual(importers.rows.map((row) => row.pkg), ['__own__', 'runtime', 'middle', 'big', 'entry'])
  assert.deepEqual(importers.rows.map((row) => row.importers), [0, 4, 2, 1, 0])
  const imports = buildDependencyMatrix(graph, { order: 'imports' })
  assert.deepEqual(imports.rows.map((row) => row.pkg), ['__own__', 'entry', 'big', 'middle', 'runtime'])
  assert.deepEqual(imports.rows.map((row) => row.dependencies), [2, 3, 1, 1, 0])
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
  assert.equal(matrixZoomCell(100, 4, 900, 700), 27, 'maximum is 150% of the 18px base size')
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

it('labels a vendored package by name, but keeps it apart from an npm package of that name', () => {
  const model = buildDependencyMatrix({
    nodes: [
      { file: 'node_modules/log/index.js', pkg: 'log', size: 1 },
      { file: 'vendor/log/src/lib.rs', pkg: 'vendor/log', size: 2 },
      { file: 'vendor/console_log/src/lib.rs', pkg: 'vendor/console_log', size: 3 },
    ],
    importsOf: new Map([['vendor/console_log/src/lib.rs', ['vendor/log/src/lib.rs']]]),
  })
  const byPkg = new Map(model.rows.map((r) => [r.pkg, r]))
  assert.equal(byPkg.get('vendor/console_log').label, 'console_log')
  assert.equal(byPkg.get('vendor/log').label, 'log')
  assert.equal(byPkg.get('log').label, 'log')
  assert.equal(byPkg.get('vendor/log').size, 2, 'the two `log`s are separate rows')
  assert.equal(byPkg.get('log').size, 1)
})

describe('matrix Cycles filter', () => {
  const executor = 'node_modules/react-native/scripts/codegen/generate-artifacts-executor.js'
  const manifest = 'node_modules/react-native-shimmer/package.json'
  const native = 'node_modules/react-native/index.js'
  const shimmer = 'node_modules/react-native-shimmer/index.js'
  const from = 'p:react-native', to = 'p:react-native-shimmer'
  const controls = { select() {}, expand() {}, expanded: new Set(), focus() {}, clear() {} }

  function cyclesFilterFixture({ mixed = true, shortened = false, target = manifest } = {}) {
    const paths = new Map([executor, target, native, shimmer].map(path => [path, shortened ? path.slice('node_modules/'.length) : path]))
    const tree = Object.fromEntries([
      [executor, [target]], [target, []], [native, mixed ? [shimmer] : [executor]], [shimmer, [native, target]],
    ].map(([file, imports]) => [paths.get(file), { imports: imports.map(imported => paths.get(imported)) }]))
    if (!mixed) {
      tree[paths.get(executor)].imports.push(paths.get(native))
      tree[paths.get(target)].imports.push(paths.get(shimmer))
    }
    const original = new Map([...paths].map(([orig, path]) => [path, orig]))
    const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf: path => bundlePkgOf(original.get(path)) })
    for (const node of graph.nodes) node.origFile = original.get(node.file)
    return graph
  }

  function text(value) {
    if (Array.isArray(value)) return value.map(text).join('')
    if (value?.strings) return value.strings.map((part, i) => part + text(value.values[i])).join('')
    return ['string', 'number'].includes(typeof value) ? String(value) : ''
  }

  test('Cycles filters the actual grid imports, counts, and inspector examples within an aggregated cyclic cell', () => {
    for (const shortened of [false, true]) {
      const graph = cyclesFilterFixture({ shortened })
      const full = buildDependencyMatrix(graph)
      const filtered = buildDependencyMatrix(graph, { cyclesOnly: true })
      assert.equal(full.cells.get(from).get(to).count, 2)
      assert.equal(full.cells.get(from).get(to).cyclic, true)
      assert.equal(filtered.cells.get(from).get(to).count, 1)
      assert.deepEqual(filtered.cells.get(from).get(to).examples, [[
        shortened ? native.slice('node_modules/'.length) : native,
        shortened ? shimmer.slice('node_modules/'.length) : shimmer,
      ]])
      assert.equal(filtered.importCount, 2)
      assert.equal(filtered.byId.get(from).outgoing, 1)
      assert.equal(filtered.byId.get(to).incoming, 1)
      assert.ok(filtered.visibleCells.every(cell => cell.cyclic))
      const panel = text(renderMatrixPanel(filtered, graph, { from, to }, controls))
      assert.ok(panel.includes(native))
      assert.ok(panel.includes(shimmer))
      assert.ok(!panel.includes('generate-artifacts-executor.js'))
      assert.ok(!panel.includes('package.json'))
    }
  })

  test('Cycles hides manifest reads and other noncyclic edges between two separate cyclic groups', () => {
    const graph = cyclesFilterFixture({ mixed: false })
    const full = buildDependencyMatrix(graph, { expanded: new Set(graph.packages) })
    assert.equal(full.cycleCount, 2)
    assert.equal(full.cells.get(`f:${executor}`).get(`f:${manifest}`).cyclic, false)
    const filtered = buildDependencyMatrix(graph, { expanded: new Set(graph.packages), cyclesOnly: true })
    assert.equal(filtered.rows.length, 4)
    assert.equal(filtered.visibleCells.length, 4)
    assert.equal(filtered.cells.get(`f:${executor}`).has(`f:${manifest}`), false)
    assert.equal(filtered.cells.get(`f:${shimmer}`).has(`f:${native}`), false)
    assert.deepEqual(new Set(buildDependencyMatrix(graph, {
      expanded: new Set(graph.packages), cyclesOnly: true, neighborhood: `f:${executor}`,
    }).rows.map(row => row.file)), new Set([native, executor]))
    const panel = text(renderMatrixPanel(filtered, graph, { from: `f:${executor}`, to: `f:${manifest}` }, controls))
    assert.match(panel, /No direct imports in this direction/u)
    assert.doesNotMatch(panel, /Imported by/u)
  })

  test('the unfiltered inspector distinguishes excluded manifest reads from genuine cycle imports', () => {
    for (const shortened of [false, true]) {
      const graph = cyclesFilterFixture({ shortened })
      const panel = text(renderMatrixPanel(buildDependencyMatrix(graph), graph, { from, to }, controls))
      assert.ok(panel.includes(executor))
      assert.ok(panel.includes(manifest))
      assert.match(panel, /1 of 2 file imports participate in a cycle/u)
      assert.match(panel, /Excluded from cycles/u)
    }
  })

  test('config reads are marked excluded in the inspector and hidden by Cycles even within a cyclic package pair', () => {
    const target = 'node_modules/react-native-shimmer/react-native.config.js'
    for (const shortened of [false, true]) {
      const graph = cyclesFilterFixture({ shortened, target })
      const full = buildDependencyMatrix(graph)
      const panel = text(renderMatrixPanel(full, graph, { from, to }, controls))
      assert.ok(panel.includes(target))
      assert.match(panel, /1 of 2 file imports participate in a cycle/u)
      assert.match(panel, /Excluded from cycles/u)
      const filtered = buildDependencyMatrix(graph, { cyclesOnly: true })
      assert.equal(filtered.cells.get(from).get(to).count, 1)
      assert.equal(filtered.importCount, 2)
      assert.doesNotMatch(text(renderMatrixPanel(filtered, graph, { from, to }, controls)), /react-native\.config\.js|generate-artifacts-executor\.js/u)
    }
  })

  test('excluded imports cannot fill the example limit and hide the imports that actually form the cycle', () => {
    const manifests = Array.from({ length: 81 }, (_, i) => `node_modules/react-native-shimmer/fixtures/${i}/package.json`)
    const tree = Object.fromEntries([
      [executor, { imports: manifests }], ...manifests.map(file => [file, {}]),
      [native, { imports: [shimmer] }], [shimmer, { imports: [native] }],
    ])
    const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf: bundlePkgOf })
    const model = buildDependencyMatrix(graph, { cyclesOnly: true })
    assert.equal(model.cells.get(from).get(to).count, 1)
    assert.deepEqual(model.cells.get(from).get(to).examples, [[native, shimmer]])
    const panel = text(renderMatrixPanel(model, graph, { from, to }, controls))
    assert.ok(panel.includes(shimmer))
    assert.ok(!panel.includes('package.json'))
    assert.doesNotMatch(panel, /Showing .* imports/u)
  })

  test('enabling Cycles clears a selected manifest-only cell and removes its hover import count', () => {
    const graph = cyclesFilterFixture({ mixed: false })
    const Matrix = customElements.get('dependency-matrix'), matrix = new Matrix()
    matrix.graph = graph
    matrix.willUpdate(new Map([['graph', undefined]]))
    matrix.selection = { from, to }
    matrix.cyclesOnly = true
    matrix.dirty = true
    matrix.willUpdate(new Map())
    assert.equal(matrix.selection, null)

    matrix.expanded = new Set(graph.packages)
    matrix.dirty = true
    matrix.willUpdate(new Map())
    matrix.hover = { row: matrix.model.index.get(`f:${executor}`), col: matrix.model.index.get(`f:${manifest}`) }
    assert.doesNotMatch(text(matrix.render()), /class="matrix-hover"/u)
  })
})

describe('matrix viewport', () => {
  function viewportFixture(count = 60) {
    const files = Array.from({ length: count }, (_, i) => `pkg-${String(i).padStart(2, '0')}/index.js`)
    const tree = Object.fromEntries(files.map((file, i) => [file, { size: 10, imports: [files[(i + 1) % count]] }]))
    return buildGraph(tree, files, new Map(), null, null, null, null, { pkgOf: file => file.split('/')[0] })
  }

  function updateGraph(matrix, graph) {
    const previous = matrix.graph
    matrix.graph = graph
    matrix.willUpdate(new Map([['graph', previous]]))
  }

  function zoomedMatrix(t) {
    const previousQuery = graph2.pathFilter
    graph2.pathFilter = ''
    t.after(() => { graph2.pathFilter = previousQuery })
    const Matrix = customElements.get('dependency-matrix'), matrix = new Matrix()
    matrix.width = 900; matrix.height = 650
    updateGraph(matrix, viewportFixture())
    assert.equal(matrix.needsFit, true, 'the first model must fit when the canvas is measured')
    matrix.fit()
    matrix.zoom(2)
    matrix.view.x = 140; matrix.view.y = 180
    matrix.clamp()
    return matrix
  }

  test('fresh graph objects from popup renders preserve grid pan, zoom, and selection while refreshing data', t => {
    const matrix = zoomedMatrix(t)
    matrix.expanded.add('pkg-20')
    matrix.order = 'name'
    matrix.cyclesOnly = true
    matrix.dirty = true
    matrix.willUpdate(new Map())
    matrix.fit(); matrix.zoom(2)
    matrix.view.x = 140; matrix.view.y = 180; matrix.clamp()
    matrix.select('f:pkg-20/index.js', 'p:pkg-21', false)
    const selection = { ...matrix.selection }, view = { ...matrix.view }

    // Opening source, loading its body, syntax highlighting, and closing the
    // popup each render the page and hand the retained grid a fresh graph.
    for (let i = 1; i <= 4; i++) {
      const graph = viewportFixture(), previousModel = matrix.model
      graph.nodeByFile.get('pkg-20/index.js').size = i * 100
      graph.nodeByFile.get('pkg-20/index.js').totalIssues = i
      updateGraph(matrix, graph)
      assert.equal(matrix.needsFit, false, 'a data refresh must not schedule a viewport reset')
      assert.deepEqual(matrix.view, view)
      assert.deepEqual(matrix.selection, selection)
      assert.notEqual(matrix.model, previousModel, 'fresh graph data still reaches the grid and inspector')
      assert.equal(matrix.model.byId.get(selection.from).size, i * 100)
      assert.equal(matrix.model.byId.get(selection.from).issues, i)
      assert.equal(matrix.expanded.has('pkg-20'), true)
      assert.equal(matrix.order, 'name')
      assert.equal(matrix.cyclesOnly, true)
    }

    matrix.fit()
    assert.deepEqual(matrix.view, { cell: (650 - 118 - 12) / 60, x: 0, y: 0 }, 'the explicit Fit control still resets the viewport')
  })

  test('changing grid rows or their order still schedules a fit', t => {
    const matrix = zoomedMatrix(t)
    const before = matrix.model.rows.map(row => row.id)
    const graph = viewportFixture()
    graph.importsOf.get('pkg-20/index.js').push('pkg-40/index.js')
    matrix.order = 'imports'
    updateGraph(matrix, graph)
    assert.notDeepEqual(matrix.model.rows.map(row => row.id), before)
    assert.equal(matrix.needsFit, true, 'a different row order needs a new overview')
    matrix.fit()
    updateGraph(matrix, viewportFixture(61))
    assert.equal(matrix.needsFit, true, 'added rows need a new overview')
    matrix.fit()
    matrix.expand('pkg-20')
    matrix.willUpdate(new Map())
    assert.equal(matrix.needsFit, true, 'expansion changes row identities even at the same row count')
    matrix.fit()
    graph2.pathFilter = 'pkg-20'
    matrix.willUpdate(new Map())
    assert.equal(matrix.needsFit, true, 'search changes the visible rows')
  })

  test('equivalent refreshes do not cancel an initial fit that is waiting for canvas dimensions', () => {
    const Matrix = customElements.get('dependency-matrix'), matrix = new Matrix()
    updateGraph(matrix, viewportFixture())
    updateGraph(matrix, viewportFixture())
    assert.equal(matrix.needsFit, true)
  })
})
