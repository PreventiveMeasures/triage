import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/view/frontend-install.js'
import '../ui/view/graph/dependency-matrix.js'
import { buildGraph } from '../ui/view/graph/data.js'
import { buildDependencyMatrix } from '../ui/view/graph/matrix-model.js'
import { renderMatrixPanel } from '../ui/view/graph/matrix-panel.js'
import { bundlePkgOf } from '../ui/view/bundle-pkg-of.js'

const executor = 'node_modules/react-native/scripts/codegen/generate-artifacts-executor.js'
const manifest = 'node_modules/react-native-shimmer/package.json'
const native = 'node_modules/react-native/index.js'
const shimmer = 'node_modules/react-native-shimmer/index.js'
const from = 'p:react-native', to = 'p:react-native-shimmer'
const controls = { select() {}, expand() {}, expanded: new Set(), focus() {}, clear() {} }

function fixture({ mixed = true, shortened = false, target = manifest } = {}) {
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
    const graph = fixture({ shortened })
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
  const graph = fixture({ mixed: false })
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
    const graph = fixture({ shortened })
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
    const graph = fixture({ shortened, target })
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
  const graph = fixture({ mixed: false })
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
