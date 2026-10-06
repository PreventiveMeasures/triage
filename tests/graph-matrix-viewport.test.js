import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/view/frontend-install.js'
import '../ui/view/graph/dependency-matrix.js'
import { buildGraph } from '../ui/view/graph/data.js'
import { graph2 } from '../ui/view/graph/state.js'

function fixture(count = 60) {
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
  updateGraph(matrix, fixture())
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
    const graph = fixture(), previousModel = matrix.model
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
  const graph = fixture()
  graph.importsOf.get('pkg-20/index.js').push('pkg-40/index.js')
  matrix.order = 'imports'
  updateGraph(matrix, graph)
  assert.notDeepEqual(matrix.model.rows.map(row => row.id), before)
  assert.equal(matrix.needsFit, true, 'a different row order needs a new overview')
  matrix.fit()
  updateGraph(matrix, fixture(61))
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
  updateGraph(matrix, fixture())
  updateGraph(matrix, fixture())
  assert.equal(matrix.needsFit, true)
})
