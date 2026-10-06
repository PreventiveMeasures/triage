import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/view/frontend-install.js'
import { Bundle } from '@exodus/stasis-core/bundle'
import { countsTowardsCycles } from '../ui/view/graph/cycle-imports.js'
import { buildGraph } from '../ui/view/graph/data.js'
import { buildDependencyMatrix } from '../ui/view/graph/matrix-model.js'
import { dependencyNetwork } from '../ui/view/graph/package-network.js'
import { layoutPackageDependencies } from '../ui/view/graph/dependency-layout.js'
import { bundlePkgOf } from '../ui/view/bundle-pkg-of.js'
import { bundleDependencyChains, layoutDependencyChains } from '../ui/view/bundle-dependency-chains.js'
import { createBundleMetadata, parseBundleMetadata } from '../common/bundle-metadata.js'

const loader = 'node_modules/@babel/core/lib/config/files/module-types.js'
const native = 'node_modules/react-native/index.js', plugin = 'node_modules/plugin/index.js'
const config = 'babel.config.js'

function imports(ordinaryImport) {
  return new Map([
    ['index.js', [plugin, native]], [config, [plugin]], [plugin, [native]], [native, [loader]],
    [loader, [config, ...(ordinaryImport ? ['index.js'] : [])]],
  ])
}

test('only Babel config loaders reading babel.config.js are excluded from cycles', () => {
  for (const prefix of ['', '/project/', 'node_modules/outer/', 'node_modules/.pnpm/@babel+core@7.0.0/']) {
    for (const source of [loader, 'node_modules/@babel/core/lib/config/index.js']) {
      for (const target of [config, '/project/babel.config.js', 'node_modules/plugin/babel.config.js']) {
        assert.equal(countsTowardsCycles(prefix + source, target), false, `${prefix + source} -> ${target}`)
      }
    }
  }
  for (const target of ['index.js', 'not-babel.config.js', 'babel.config.js.bak', 'babel.config.js/index.js', 'babel.config.cjs']) {
    assert.equal(countsTowardsCycles(loader, target), true, target)
  }
  for (const source of [
    'lib/config/files/module-types.js', 'node_modules/@babel/core/lib/index.js',
    loader.replace('/config/', '/config-other/'), loader.replace('/core/', '/core-other/'),
    loader.replace('node_modules/', 'my_node_modules/'),
  ]) assert.equal(countsTowardsCycles(source, config), true, source)
})

test('Babel config reads do not close indirect package cycles through own source, plugins and React Native', () => {
  for (const ordinaryImport of [false, true]) {
    for (const shortened of [false, true]) {
      const original = new Map([...imports(ordinaryImport).keys()].map(file => [shortened ? file.replace('node_modules/', '') : file, file]))
      const display = new Map([...original].map(([file, orig]) => [orig, file]))
      const tree = Object.fromEntries([...imports(ordinaryImport)].map(([file, targets]) => [display.get(file), { imports: targets.map(target => display.get(target)) }]))
      const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf: file => bundlePkgOf(original.get(file)) })
      for (const node of graph.nodes) node.origFile = original.get(node.file)
      for (const expanded of [new Set(), new Set(graph.packages)]) {
        const full = buildDependencyMatrix(graph, { expanded })
        assert.equal(full.cycleCount, ordinaryImport ? 1 : 0)
        const filtered = buildDependencyMatrix(graph, { expanded, cyclesOnly: true })
        assert.equal(filtered.cycleCount, ordinaryImport ? 1 : 0)
        assert.ok(filtered.visibleCells.every(cell => cell.examples.every(([from, to]) => from !== display.get(loader) || to !== config)))
        assert.ok(full.visibleCells.some(cell => cell.examples.some(([from, to]) => from === display.get(loader) && to === config)), 'retain the config read in the full graph')
      }
      for (const packagesView of [false, true]) {
        const network = dependencyNetwork(graph, packagesView)
        const result = layoutPackageDependencies(network.nodes.map(node => node.file), network.importsOf, [], { cycleImportsOf: network.cycleImportsOf })
        assert.equal(result.cycles.length, ordinaryImport ? 1 : 0)
      }
    }
  }
})

test('advisory popup cycles exclude Babel config reads in full bundles and cached metadata', async () => {
  for (const ordinaryImport of [false, true]) {
    const details = { kind: 'stasis', integrity: 'babel-config', size: 1, bundle: new Bundle({
      modules: new Map([
        ['.', { name: 'app', files: { 'index.js': 'app', [config]: 'config' } }],
        ['node_modules/plugin', { name: 'plugin', version: '1.0.0', files: { 'index.js': 'plugin' } }],
        ['node_modules/react-native', { name: 'react-native', version: '1.0.0', files: { 'index.js': 'native' } }],
        ['node_modules/@babel/core', { name: '@babel/core', version: '1.0.0', files: { 'lib/config/files/module-types.js': 'loader' } }],
      ]),
      imports: new Map([['node,import', new Map([...imports(ordinaryImport)].map(([file, targets]) => [file, new Map(targets.map(target => [target, target]))]))]]),
    }) }
    const metadata = parseBundleMetadata(await createBundleMetadata(details), details.integrity)
    for (const input of [details, metadata]) {
      const graph = bundleDependencyChains(input, { packageKey: 'plugin', version: '1.0.0' })
      assert.ok(graph.imports.get('node_modules/@babel/core').has('.'))
      const result = layoutDependencyChains(graph)
      assert.equal(result.boxes.filter(box => box.members.length > 1).length, ordinaryImport ? 1 : 0)
      assert.equal(result.boxes.length, ordinaryImport ? 1 : 4)
    }
  }
})
