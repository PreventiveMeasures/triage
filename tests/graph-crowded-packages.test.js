import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildGraph, buildPackageGraph, withoutPackages } from '../ui/view/graph/data.js'
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

test('Dependencies leaves crowded packages out of its package and file networks', async () => {
  const { dependencyNetwork, packageNetwork } = await import('../ui/view/graph/package-network.js')
  const babel = node => node.pkg === '@babel/runtime'
  const packages = importers => packageNetwork(graphOf(importers))
  assert.ok(packages(100).nodes.some(babel), '100 importing packages keep the package')
  const crowded = packages(101)
  assert.equal(crowded.nodes.filter(babel).length, 0)
  assert.equal(crowded.byPkg.has('@babel/runtime'), false)
  assert.equal(crowded.nodeByFile.has('@babel/runtime'), false)
  assert.ok([...crowded.importsOf.values()].every(targets => !targets.includes('@babel/runtime')))
  assert.ok(crowded.directedEdges.every(e => e.to !== '@babel/runtime' && e.from !== '@babel/runtime'))
  assert.ok(crowded.importedBy.get('other').length > 0, 'other packages keep their importers')

  // At most 100 files show file by file: importers × 8 helpers file edges.
  const files = importers => {
    const helpers = Array.from({ length: 8 }, (_, i) => `node_modules/@babel/runtime/helpers/h${i}.js`)
    const sources = Array.from({ length: importers }, (_, i) => `src/f${i}.js`)
    const tree = { 'src/entry.js': { size: 1, imports: sources }, ...Object.fromEntries(helpers.map(file => [file, { size: 1, imports: [] }])),
      ...Object.fromEntries(sources.map(file => [file, { size: 1, imports: helpers }])) }
    return dependencyNetwork(buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf }), false)
  }
  assert.equal(files(37).nodes.filter(babel).length, 8, '296 file edges keep the helpers')
  const flooded = files(40)
  assert.equal(flooded.fileLevel, true)
  assert.equal(flooded.nodes.filter(babel).length, 0)
  assert.ok(flooded.directedEdges.every(e => !e.to.includes('@babel/runtime')))
  assert.equal(flooded.nodes.length, 41, 'own source stays')
})

test('the Graph view lays out a graph that already lacks crowded packages', () => {
  const graph = graphOf(301)
  assert.equal(withoutPackages(graph, new Set()), graph)
  const shown = withoutPackages(graph, crowdedGraphPackages(graph, 300))
  assert.equal(shown.nodes.filter(n => n.pkg === '@babel/runtime').length, 0)
  assert.ok(shown.nodes.every(n => graph.nodeByFile.get(n.file) === n), 'nodes are shared, so positions land on them')
  assert.ok(shown.edges.every(e => shown.nodeByFile.has(e.a) && shown.nodeByFile.has(e.b)))
  for (const [file, edges] of shown.adj) for (const i of edges) assert.ok([shown.edges[i].a, shown.edges[i].b].includes(file), 'edge indices follow the kept edges')
  assert.ok([...shown.importsOf.values(), ...shown.importedBy.values()].every(files => files.every(file => shown.nodeByFile.has(file))))
  assert.equal(shown.packages.includes('@babel/runtime'), false)
  assert.equal(shown.byPkg.has('@babel/runtime'), false)
  assert.equal(graph.nodes.filter(n => n.pkg === '@babel/runtime').length, 2, 'Matrix keeps the full graph')
})

test('Size flow rows ignore paths through hidden packages', () => {
  const deps = Array.from({ length: 301 }, (_, i) => `node_modules/dep-${i}/f.js`)
  const tree = {
    'entry.js': { size: 1, imports: ['src/a.js', ...deps] },
    'src/a.js': { size: 10, imports: ['src/x.js'] }, 'src/x.js': { size: 10, imports: [] }, 'src/only-via-helper.js': { size: 10, imports: [] },
    [helper]: { size: 100, imports: ['src/x.js', 'src/only-via-helper.js'] },
    ...Object.fromEntries(deps.map(file => [file, { size: 10, imports: [helper] }])),
  }
  const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf })
  graph.flowEntries = [{ file: 'entry.js' }]
  const layout = layoutSizeFlow(buildSizeFlow(graph))
  assert.equal(layout.byId.get('f:src/x.js').level, 2, 'the hidden helper at row 2 no longer pushes x.js to row 3')
  assert.equal(layout.byId.has('f:src/only-via-helper.js'), false, 'bars reached only through hidden files are not drawn')
})
