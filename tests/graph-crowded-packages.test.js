import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/view/frontend-install.js'
import { buildGraph, buildPackageGraph } from '../ui/view/graph/data.js'
import { crowdedGraphPackages, crowdedPackages } from '../ui/view/graph/crowded-packages.js'
import { buildSizeFlow, layoutSizeFlow } from '../ui/view/graph/size-flow-model.js'
import '../ui/view/graph/size-flow.js'

const helper = 'node_modules/@babel/runtime/helpers/interopRequireDefault.js'
const nested = 'node_modules/@babel/runtime/helpers/extends.js'
const pkgOf = file => file.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/u)?.[1] ?? '__own__'

// `importers` packages with `filesEach` files apiece, every file importing the
// helper and one ordinary dependency. The helper imports a sibling helper.
function graphOf(importers, filesEach = 1) {
  const files = Array.from({ length: importers * filesEach }, (_, i) => `node_modules/dep-${Math.floor(i / filesEach)}/f${i}.js`)
  const tree = {
    'entry.js': { size: 1, imports: files },
    [helper]: { size: 100, imports: [nested] }, [nested]: { size: 50, imports: [] },
    'node_modules/other/index.js': { size: 10, imports: [] },
    ...Object.fromEntries(files.map(file => [file, { size: 10, imports: [helper, 'node_modules/other/index.js'] }])),
  }
  const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf })
  graph.flowEntries = [{ file: 'entry.js' }]
  return graph
}

test('only edges from other packages count, and only for the listed package', () => {
  const edges = [...Array.from({ length: 101 }, () => ['a', '@babel/runtime']), ...Array.from({ length: 200 }, () => ['@babel/runtime', '@babel/runtime']),
    ...Array.from({ length: 200 }, () => ['a', 'lodash'])]
  assert.deepEqual([...crowdedPackages(edges, 100)], ['@babel/runtime'])
  assert.deepEqual([...crowdedPackages(edges, 101)], [], 'internal imports never count')
})

for (const name of ['minimalistic-assert', 'react', 'reselect']) {
  test(`${name} is hidden past the same limits`, () => {
    const target = `node_modules/${name}/index.js`
    const crowdedGraph = importers => {
      const files = Array.from({ length: importers }, (_, i) => `node_modules/dep-${i}/f${i}.js`)
      const tree = { [target]: { size: 1, imports: [] }, ...Object.fromEntries(files.map(file => [file, { size: 10, imports: [target] }])) }
      return buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf })
    }
    assert.deepEqual([...crowdedGraphPackages(crowdedGraph(300), 300)], [])
    assert.deepEqual([...crowdedGraphPackages(crowdedGraph(301), 300)], [name])
    assert.deepEqual([...crowdedGraphPackages(buildPackageGraph(crowdedGraph(100)), 100)], [])
    assert.deepEqual([...crowdedGraphPackages(buildPackageGraph(crowdedGraph(101)), 100)], [name])
  })
}

test('the Graph view hides @babel/runtime past 300 file edges or 100 importing packages', () => {
  assert.deepEqual([...crowdedGraphPackages(graphOf(300), 300)], [])
  assert.deepEqual([...crowdedGraphPackages(graphOf(301), 300)], ['@babel/runtime'])
  assert.deepEqual([...crowdedGraphPackages(buildPackageGraph(graphOf(100, 2)), 100)], [], '100 packages share 200 file edges')
  assert.deepEqual([...crowdedGraphPackages(buildPackageGraph(graphOf(101)), 100)], ['@babel/runtime'])
})

test('Size flow leaves out @babel/runtime bars and every ribbon touching them past the same limits', () => {
  const flow = (graph, packages = false) => layoutSizeFlow(buildSizeFlow(graph, { packages }))
  const babel = layout => layout.nodes.filter(n => n.pkg === '@babel/runtime').length
  const touching = layout => layout.edges.filter(e => [e.from, e.to].some(id => layout.byId.get(id)?.pkg === '@babel/runtime' || !layout.byId.has(id))).length

  assert.equal(babel(flow(graphOf(300))), 2, 'both helper files show at 300 file edges')
  const files = flow(graphOf(301))
  assert.equal(babel(files), 0)
  assert.equal(touching(files), 0)
  assert.deepEqual([...files.hiddenPackages], ['@babel/runtime'])
  assert.ok(files.byId.has('f:node_modules/other/index.js'), 'other dependencies stay')

  assert.equal(babel(flow(graphOf(100, 6), true)), 1, '100 importing packages keep the package bar')
  const packages = flow(graphOf(101), true)
  assert.equal(babel(packages), 0)
  assert.equal(touching(packages), 0)

  const Flow = customElements.get('size-flow'), host = new Flow()
  host.graph = graphOf(301); host.willUpdate(new Map([['graph', null]]))
  assert.equal(host.matchesNode(host.model.byId.get(`f:${helper}`)), false, 'search skips hidden files')
  assert.equal(host.layout.byId.get('f:entry.js').size, 1 + 301 * 10 + 10 + 150, 'reachable sizes still include both hidden helper files')
})
