import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/view/frontend-install.js'
import { Bundle } from '@exodus/stasis-core/bundle'
import { buildGraph } from '../ui/view/graph/data.js'
import { buildDependencyMatrix } from '../ui/view/graph/matrix-model.js'
import { dependencyNetwork } from '../ui/view/graph/package-network.js'
import { layoutPackageDependencies } from '../ui/view/graph/dependency-layout.js'
import { bundleDependencyChains, layoutDependencyChains } from '../ui/view/bundle-dependency-chains.js'
import { createBundleMetadata, parseBundleMetadata } from '../common/bundle-metadata.js'

const executor = 'node_modules/react-native/scripts/codegen/generate-artifacts-executor.js'
const manifest = 'node_modules/dep/package.json'
const config = 'node_modules/dep/react-native.config.js'

function graphFrom(imports, originals = new Map()) {
  const tree = Object.fromEntries([...imports].map(([file, targets]) => [file, { imports: targets }]))
  const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, {
    pkgOf: file => (originals.get(file) ?? file).includes('react-native/') ? 'react-native' : 'dep',
  })
  for (const node of graph.nodes) node.origFile = originals.get(node.file)
  return graph
}

function layout(graph, packagesView) {
  const network = dependencyNetwork(graph, packagesView)
  return layoutPackageDependencies(network.nodes.map(node => node.file), network.importsOf, [], {
    cycleImportsOf: network.cycleImportsOf,
  })
}

test('codegen manifest and config reads remain visible without producing file or package cycles', () => {
  for (const prefix of ['', 'project/', 'node_modules/.pnpm/react-native@1.0.0/', 'node_modules/outer/']) {
    for (const target of [manifest, 'package.json', '/project/package.json', config, 'react-native.config.js', '/project/react-native.config.js']) {
      const source = prefix + executor
      const graph = graphFrom(new Map([[source, [target]], [target, [source]]]))
      const before = structuredClone(graph)
      for (const expanded of [new Set(), new Set(['react-native']), new Set(['react-native', 'dep'])]) {
        const model = buildDependencyMatrix(graph, { expanded })
        assert.equal(model.cycleCount, 0, `${source} -> ${target}`)
        assert.equal(model.importCount, 2)
        assert.equal(model.visibleCells.length, 2)
        assert.ok(model.visibleCells.every(cell => !cell.cyclic))
        assert.equal(buildDependencyMatrix(graph, { expanded, cyclesOnly: true }).rows.length, 0)
        assert.equal(buildDependencyMatrix(graph, { expanded, query: 'generate-artifacts' }).rows.length, 2,
          'search retains codegen neighbors')
        for (const row of model.rows) {
          assert.equal(buildDependencyMatrix(graph, { expanded, neighborhood: row.id }).rows.length, 2,
            'selection retains imports and importers')
        }
      }
      for (const packagesView of [false, true]) {
        const result = layout(graph, packagesView)
        assert.deepEqual(result.cycles, [])
        assert.equal(result.edges.length, 2)
        assert.ok(result.edges.every(edge => !edge.cycle))
        const sourceId = packagesView ? 'react-native' : source, targetId = packagesView ? 'dep' : target
        assert.ok(result.depth.get(sourceId) > result.depth.get(targetId), 'order follows the ordinary import')
      }
      assert.deepEqual(graph, before)
    }
  }
})

test('cycle exclusions use original paths when bundle display paths are shortened', () => {
  for (const filename of ['package.json', 'react-native.config.js']) {
    const source = 'scripts/codegen/generate-artifacts-executor.js', target = filename
    const originals = new Map([[source, executor], [target, `node_modules/dep/${filename}`]])
    const graph = graphFrom(new Map([[source, [target]], [target, [source]]]), originals)
    assert.equal(buildDependencyMatrix(graph).cycleCount, 0)
    for (const packagesView of [false, true]) assert.deepEqual(layout(graph, packagesView).cycles, [])
    const ownScript = graphFrom(graph.importsOf)
    assert.equal(buildDependencyMatrix(ownScript, { expanded: new Set(['dep']) }).cycleCount, 1,
      'a similarly named own-source script is not the installed React Native executor')
  }
})

test('ordinary imports from the executor and other scripts still count towards cycles', () => {
  for (const [source, target] of [
    [executor, 'node_modules/dep/index.js'],
    [executor, 'node_modules/dep/config.json'],
    [executor, 'node_modules/dep/not-package.json'],
    [executor, `${manifest}.bak`],
    [executor, `${manifest}/index.js`],
    [executor, 'node_modules/dep/not-react-native.config.js'],
    [executor, `${config}.bak`],
    [executor, `${config}/index.js`],
    [executor.replace('react-native/', 'react-native-other/'), manifest],
    [executor.replace('node_modules/', 'my_node_modules/'), manifest],
    [executor.replace('generate-artifacts-executor.js', 'other.js'), manifest],
    [`${executor}.bak`, manifest],
    [executor.replace('generate-artifacts-executor.js', 'other.js'), config],
  ]) {
    const graph = graphFrom(new Map([[source, [target]], [target, [source]]]))
    assert.equal(buildDependencyMatrix(graph, { expanded: new Set(['react-native', 'dep']) }).cycleCount, 1, `${source} -> ${target}`)
    assert.equal(layout(graph, false).cycles.length, 1)
  }
})

test('ordinary imports between the same packages still form cycles, while manifest-only cells stay unmarked', () => {
  const entry = 'node_modules/dep/index.js'
  // All three files belong to a real cycle through the ordinary entry-point
  // import. The additional executor -> manifest edge must still be unmarked.
  const graph = graphFrom(new Map([[executor, [manifest, entry]], [entry, [manifest]], [manifest, [executor]]]))
  const collapsed = buildDependencyMatrix(graph)
  assert.equal(collapsed.cycleCount, 1)
  assert.equal(collapsed.cells.get('p:react-native').get('p:dep').count, 2)
  assert.equal(collapsed.cells.get('p:react-native').get('p:dep').cyclic, true)
  const expanded = buildDependencyMatrix(graph, { expanded: new Set(['react-native', 'dep']) })
  assert.equal(expanded.cycleCount, 1)
  assert.equal(expanded.cells.get(`f:${executor}`).get(`f:${manifest}`).cyclic, false)
  assert.equal(expanded.cells.get(`f:${executor}`).get(`f:${entry}`).cyclic, true)
  assert.equal(layout(graph, true).cycles.length, 1)
  const files = layout(graph, false)
  assert.equal(files.cycles.length, 1)
  assert.equal(files.edges.find(edge => edge.from === executor && edge.to === manifest).cycle, false)
  assert.equal(files.edges.find(edge => edge.from === executor && edge.to === entry).cycle, true)
})

for (const filename of ['package.json', 'react-native.config.js']) {
  test(`advisory chains exclude codegen ${filename} reads from traversal and rendering`, async () => {
    for (const ordinaryImport of [false, true]) {
      const details = { kind: 'stasis', integrity: 'codegen', size: 1, bundle: new Bundle({
        modules: new Map([
          ['.', { name: 'app', files: { 'index.js': 'app' } }],
          ['node_modules/react-native', { name: 'react-native', version: '1.0.0', files: { 'scripts/codegen/generate-artifacts-executor.js': 'codegen' } }],
          ['node_modules/dep', { name: 'dep', version: '1.0.0', files: { 'index.js': 'dep', [filename]: '{}' } }],
        ]),
        imports: new Map([['node,import', new Map([
          ['index.js', new Map([['dep', 'node_modules/dep/index.js']])],
          ['node_modules/dep/index.js', new Map([['codegen', executor]])],
          [executor, new Map([[`dep/${filename}`, `node_modules/dep/${filename}`], ...(ordinaryImport ? [['dep', 'node_modules/dep/index.js']] : [])])],
        ])]]),
      }) }
      const metadata = parseBundleMetadata(await createBundleMetadata(details), details.integrity)
      for (const input of [details, metadata]) {
        const graph = bundleDependencyChains(input, { packageKey: 'dep', version: '1.0.0' })
        assert.equal(graph.imports.get('node_modules/react-native')?.has('node_modules/dep') ?? false, ordinaryImport)
        const result = layoutDependencyChains(graph)
        assert.equal(result.boxes.filter(box => box.members.length > 1).length, ordinaryImport ? 1 : 0)
        if (!ordinaryImport) {
          assert.equal(result.boxes.length, 2)
          assert.equal(result.edges.length, 1, 'only the app import remains')
          assert.equal(graph.nodes.has('node_modules/react-native'), false, 'do not follow codegen-only importers')
        }
      }
    }
  })
}
