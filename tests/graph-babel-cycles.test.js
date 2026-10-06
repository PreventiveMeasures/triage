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
const pluginLoaders = [loader, 'node_modules/@babel/core/lib/config/files/plugins.js']
const dynamicPlugins = [
  ['@react-native/babel-preset', 'index.js'],
  ['@react-native/babel-preset', 'src/index.js'],
  ['react-native-reanimated', 'plugin/index.js'],
  ['@org/react-native-reanimated', 'plugin/index.js'],
  ...['template-literals', 'shorthand-properties', 'nullish-coalescing-operator', 'export-namespace-from', 'typescript']
    .map(name => [`@babel/plugin-transform-${name}`, 'lib/index.js']),
]

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
      assert.equal(graph.imports.get('node_modules/@babel/core')?.has('.') ?? false, false, 'advisory traversal stops at own source even for ordinary imports')
      const result = layoutDependencyChains(graph)
      assert.equal(result.boxes.filter(box => box.members.length > 1).length, 0)
      assert.equal(result.boxes.length, 2, 'the advisory graph stops at App instead of following its importers')
    }
  }
})

test('Babel dynamic plugin exclusions match exact loader and entry-point paths', () => {
  const targets = dynamicPlugins.map(([name, file]) => `node_modules/${name}/${file}`)
  targets.push('node_modules/@another-org/react-native-reanimated/plugin/index.js')
  for (const source of pluginLoaders) {
    for (const prefix of ['', '/project/', 'node_modules/outer/', 'node_modules/.pnpm/@babel+core@7.0.0/']) {
      for (const target of targets) {
        assert.equal(countsTowardsCycles(prefix + source, target), false, `${prefix + source} -> ${target}`)
        assert.equal(countsTowardsCycles(source, prefix + target), false, `${source} -> ${prefix + target}`)
      }
    }
    for (const target of [
      ...targets.flatMap(path => [`${path}.bak`, `${path}/other.js`, path.replace('node_modules/', 'my_node_modules/')]),
      'node_modules/@babel/preset-env/lib/index.js', 'node_modules/@babel/plugin-syntax-typescript/lib/index.js',
      'node_modules/@other/plugin-transform-template-literals/lib/index.js', 'node_modules/@babel/plugin-transform-/lib/index.js',
      'node_modules/@babel/plugin-transform-template-literals/lib/helpers.js',
      'node_modules/react-native-reanimated/index.js', 'node_modules/react-native-reanimated/plugin/helper.js',
      'node_modules/@react-native/babel-preset/src/helpers.js', 'node_modules/@other/babel-preset/index.js',
    ]) assert.equal(countsTowardsCycles(source, target), true, `${source} -> ${target}`)
  }
  for (const source of [
    ...pluginLoaders.flatMap(path => [`${path}.bak`, path.replace('node_modules/', 'my_node_modules/'), path.replace('/core/', '/core-other/')]),
    'lib/config/files/module-types.js', 'node_modules/@babel/core/lib/config/files/index.js',
    'node_modules/@babel/core/lib/config/plugins.js', 'node_modules/@babel/core/lib/index.js',
  ]) {
    for (const target of targets) assert.equal(countsTowardsCycles(source, target), true, `${source} -> ${target}`)
  }
})

test('TypeScript preset config loads match the whole config subtree and exact installed package', () => {
  const target = 'node_modules/@babel/preset-typescript/lib/index.js'
  for (const source of [...pluginLoaders, 'node_modules/@babel/core/lib/config/index.js', 'node_modules/@babel/core/lib/config/helpers/deep.js']) {
    for (const prefix of ['', '/project/', 'node_modules/outer/', 'node_modules/.pnpm/@babel+core@7.0.0/']) {
      for (const file of ['lib/index.js', 'index.js', 'lib/helpers.js', 'package.json']) {
        const path = `node_modules/@babel/preset-typescript/${file}`
        assert.equal(countsTowardsCycles(prefix + source, path), false, `${prefix + source} -> ${path}`)
        assert.equal(countsTowardsCycles(source, prefix + path), false, `${source} -> ${prefix + path}`)
      }
    }
  }
  for (const source of ['node_modules/@babel/core/lib/index.js', 'node_modules/@babel/core/lib/config.js',
    loader.replace('/config/', '/config-other/'), loader.replace('/core/', '/core-other/'),
    loader.replace('node_modules/', 'my_node_modules/'), loader.slice('node_modules/'.length),
    'node_modules/@babel/core/lib/config/node_modules/other/index.js']) {
    assert.equal(countsTowardsCycles(source, target), true, source)
  }
  for (const path of [target.replace('/preset-typescript/', '/preset-typescript-other/'), target.replace('/@babel/', '/@other/'),
    target.replace('node_modules/', 'my_node_modules/'), target.slice('node_modules/'.length),
    'node_modules/@babel/preset-typescript/node_modules/other/index.js', 'node_modules/@babel/preset-env/lib/index.js']) {
    assert.equal(countsTowardsCycles(loader, path), true, path)
  }
  assert.equal(countsTowardsCycles(target, loader), true, 'reverse imports still count')
})

test('grid, dependency and advisory cycles exclude config loads and retain imports from outside their matching loaders', async () => {
  for (const source of [...pluginLoaders, 'node_modules/@babel/core/lib/config/files/index.js',
    'node_modules/@babel/core/lib/config/index.js', 'node_modules/@babel/core/lib/index.js']) {
    for (const [name, file] of [...dynamicPlugins, ['@babel/preset-typescript', 'lib/index.js'], ['@babel/preset-typescript', 'lib/helpers.js'], ['@babel/preset-env', 'lib/index.js']]) {
      const excluded = name === '@babel/preset-typescript' ? source !== 'node_modules/@babel/core/lib/index.js'
        : name !== '@babel/preset-env' && pluginLoaders.includes(source)
      const expectedCycles = excluded ? 0 : 1, target = `node_modules/${name}/${file}`
      const edges = new Map([['index.js', [target]], [source, [target]], [target, [source]]])
      for (const shortened of [false, true]) {
        const original = new Map([...edges.keys()].map(path => [shortened ? path.replace('node_modules/', '') : path, path]))
        const display = new Map([...original].map(([path, orig]) => [orig, path]))
        const tree = Object.fromEntries([...edges].map(([path, targets]) => [display.get(path), { imports: targets.map(to => display.get(to)) }]))
        const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf: path => bundlePkgOf(original.get(path)) })
        for (const node of graph.nodes) node.origFile = original.get(node.file)
        for (const expanded of [new Set(), new Set(graph.packages)]) {
          const full = buildDependencyMatrix(graph, { expanded })
          assert.equal(full.cycleCount, expectedCycles, `${source} -> ${target}`)
          assert.equal(full.importCount, 3)
          const filtered = buildDependencyMatrix(graph, { expanded, cyclesOnly: true })
          assert.equal(filtered.importCount, expectedCycles ? 2 : 0)
          assert.equal(filtered.rows.length, expectedCycles ? 2 : 0)
        }
        for (const packagesView of [false, true]) {
          const network = dependencyNetwork(graph, packagesView)
          const result = layoutPackageDependencies(network.nodes.map(node => node.file), network.importsOf, [], { cycleImportsOf: network.cycleImportsOf })
          assert.equal(result.cycles.length, expectedCycles)
          assert.equal(result.edges.length, 3)
        }
      }
      const details = { kind: 'stasis', integrity: 'babel-plugin', size: 1, bundle: new Bundle({
        modules: new Map([
          ['.', { name: 'app', files: { 'index.js': 'app' } }],
          ['node_modules/@babel/core', { name: '@babel/core', version: '1.0.0', files: { [source.slice('node_modules/@babel/core/'.length)]: 'loader' } }],
          [`node_modules/${name}`, { name, version: '1.0.0', files: { [file]: 'plugin' } }],
        ]),
        imports: new Map([['node,import', new Map([...edges].map(([path, targets]) => [path, new Map(targets.map(to => [to, to]))]))]]),
      }) }
      const metadata = parseBundleMetadata(await createBundleMetadata(details), details.integrity)
      for (const input of [details, metadata]) {
        const graph = bundleDependencyChains(input, { packageKey: name, version: '1.0.0' })
        assert.equal(graph.imports.get('node_modules/@babel/core')?.has(`node_modules/${name}`) ?? false, expectedCycles === 1)
        const result = layoutDependencyChains(graph)
        assert.equal(result.boxes.filter(box => box.members.length > 1).length, 0, 'advisory tracing always stops at Babel')
        assert.equal(result.boxes.length, expectedCycles ? 3 : 2)
      }
    }
  }
})
