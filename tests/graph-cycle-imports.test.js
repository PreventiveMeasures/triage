import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { countsTowardsCycles } from '../ui/view/graph/cycle-imports.js'
import { buildGraph } from '../ui/view/graph/data.js'
import { buildDependencyMatrix } from '../ui/view/graph/matrix-model.js'
import { renderMatrixPanel } from '../ui/view/graph/matrix-panel.js'
import { dependencyNetwork } from '../ui/view/graph/package-network.js'
import { layoutPackageDependencies } from '../ui/view/graph/dependency-layout.js'
import { bundlePkgOf } from '../ui/view/bundle-pkg-of.js'
import { bundleWhy, layoutWhy } from '../ui/view/bundle-why.js'
import { createBundleMetadata, parseBundleMetadata } from '../common/bundle-metadata.js'
import { configureDepsDir, depsDirName, isModule } from '../ui/view/format.js'
import { reportOwnSourceFiles } from '../ui/view/graph/utils.js'

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

// A rendered panel's text, its string values in place.
function text(value) {
  if (Array.isArray(value)) return value.map(text).join('')
  if (value?.strings) return value.strings.map((part, i) => part + text(value.values[i])).join('')
  return typeof value === 'string' ? value : ''
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
  test(`why chains exclude codegen ${filename} reads from traversal and rendering`, async () => {
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
        const graph = bundleWhy(input, { packageKey: 'dep', version: '1.0.0' })
        assert.equal(graph.imports.get('node_modules/react-native')?.has('node_modules/dep') ?? false, ordinaryImport)
        const result = layoutWhy(graph)
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

describe('Babel config loads', () => {
  const loader = 'node_modules/@babel/core/lib/config/files/module-types.js'
  const native = 'node_modules/react-native/index.js', plugin = 'node_modules/plugin/index.js'
  const babelConfig = 'babel.config.js'
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
      ['index.js', [plugin, native]], [babelConfig, [plugin]], [plugin, [native]], [native, [loader]],
      [loader, [babelConfig, ...(ordinaryImport ? ['index.js'] : [])]],
    ])
  }

  test('only Babel config loaders reading babel.config.js are excluded from cycles', () => {
    for (const prefix of ['', '/project/', 'node_modules/outer/', 'node_modules/.pnpm/@babel+core@7.0.0/']) {
      for (const source of [loader, 'node_modules/@babel/core/lib/config/index.js']) {
        for (const target of [babelConfig, '/project/babel.config.js', 'node_modules/plugin/babel.config.js']) {
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
    ]) assert.equal(countsTowardsCycles(source, babelConfig), true, source)
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
          assert.ok(filtered.visibleCells.every(cell => cell.examples.every(([from, to]) => from !== display.get(loader) || to !== babelConfig)))
          assert.ok(full.visibleCells.some(cell => cell.examples.some(([from, to]) => from === display.get(loader) && to === babelConfig)), 'retain the config read in the full graph')
        }
        for (const packagesView of [false, true]) {
          const network = dependencyNetwork(graph, packagesView)
          const result = layoutPackageDependencies(network.nodes.map(node => node.file), network.importsOf, [], { cycleImportsOf: network.cycleImportsOf })
          assert.equal(result.cycles.length, ordinaryImport ? 1 : 0)
        }
      }
    }
  })

  test('why popup cycles exclude Babel config reads in full bundles and cached metadata', async () => {
    for (const ordinaryImport of [false, true]) {
      const details = { kind: 'stasis', integrity: 'babel-config', size: 1, bundle: new Bundle({
        modules: new Map([
          ['.', { name: 'app', files: { 'index.js': 'app', [babelConfig]: 'config' } }],
          ['node_modules/plugin', { name: 'plugin', version: '1.0.0', files: { 'index.js': 'plugin' } }],
          ['node_modules/react-native', { name: 'react-native', version: '1.0.0', files: { 'index.js': 'native' } }],
          ['node_modules/@babel/core', { name: '@babel/core', version: '1.0.0', files: { 'lib/config/files/module-types.js': 'loader' } }],
        ]),
        imports: new Map([['node,import', new Map([...imports(ordinaryImport)].map(([file, targets]) => [file, new Map(targets.map(target => [target, target]))]))]]),
      }) }
      const metadata = parseBundleMetadata(await createBundleMetadata(details), details.integrity)
      for (const input of [details, metadata]) {
        const graph = bundleWhy(input, { packageKey: 'plugin', version: '1.0.0' })
        assert.equal(graph.imports.get('node_modules/@babel/core')?.has('.') ?? false, false, 'why traversal stops at own source even for ordinary imports')
        const result = layoutWhy(graph)
        assert.equal(result.boxes.filter(box => box.members.length > 1).length, 0)
        assert.equal(result.boxes.length, 2, 'the why graph stops at App instead of following its importers')
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

  test('grid, dependency and why cycles exclude config loads and retain imports from outside their matching loaders', async () => {
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
          const graph = bundleWhy(input, { packageKey: name, version: '1.0.0' })
          assert.equal(graph.imports.get('node_modules/@babel/core')?.has(`node_modules/${name}`) ?? false, expectedCycles === 1)
          const result = layoutWhy(graph)
          assert.equal(result.boxes.filter(box => box.members.length > 1).length, 0, 'why tracing always stops at Babel')
          assert.equal(result.boxes.length, expectedCycles ? 3 : 2)
        }
      }
    }
  })
})

describe('config discovery loads', () => {
  const loaders = [
    ['cosmiconfig', 'dist/loaders.js'],
    ['import-fresh', 'index.js'],
  ]

  test('Cosmiconfig excludes every config target while import-fresh remains limited to own source', () => {
    for (const source of [...loaders.map(([name, file]) => `node_modules/${name}/${file}`), 'node_modules/import-fresh/dist/index.js']) {
      const cosmiconfig = source === 'node_modules/cosmiconfig/dist/loaders.js'
      for (const prefix of ['', '/project/', 'node_modules/outer/', 'node_modules/.pnpm/import-fresh@1.0.0/']) {
        for (const target of ['metro.config.js', 'config/metro.config.js', '/project/tools/lint.config.js', 'vendor/dep/tool.config.js', 'dependencies/dep/metro.config.js']) {
          assert.equal(countsTowardsCycles(prefix + source, target), false, `${prefix + source} -> ${target}`)
          assert.equal(countsTowardsCycles(prefix + source, target, false), !cosmiconfig, 'only import-fresh requires own-source ownership')
        }
        for (const target of ['node_modules/react-native/react-native.config.js', 'node_modules/dep/metro.config.js',
          'node_modules/@org/dep/metro.config.js']) {
          assert.equal(countsTowardsCycles(prefix + source, target), !cosmiconfig, `${prefix + source} -> ${target}`)
          assert.equal(countsTowardsCycles(source, prefix + target, false), !cosmiconfig, `${source} -> ${prefix + target}`)
        }
      }
      for (const target of ['index.js', 'config.js', 'metro.config.cjs', 'metro.config.js.bak', 'metro.config.js/index.js']) {
        assert.equal(countsTowardsCycles(source, target), true, `${source} -> ${target}`)
      }
    }
    for (const source of ['cosmiconfig/dist/loaders.js', 'import-fresh/index.js', 'my_node_modules/import-fresh/index.js',
      'node_modules/cosmiconfig/dist/loaders.js.bak', 'node_modules/cosmiconfig/dist/index.js', 'node_modules/import-fresh-other/index.js',
      'node_modules/import-fresh/node_modules/other/index.js', 'node_modules/cosmiconfig/node_modules/other/dist/loaders.js']) {
      for (const target of ['metro.config.js', 'node_modules/react-native/react-native.config.js']) {
        assert.equal(countsTowardsCycles(source, target), true, `${source} -> ${target}`)
      }
    }
  })

  test('config discovery ownership agrees across the grid, inspector, dependency graph and cached why graph', async () => {
    for (const [name, file] of loaders) {
      const source = `node_modules/${name}/${file}`, sourceDir = `node_modules/${name}`
      for (const [target, targetDir] of [
        ['metro.config.js', '.'], ['tools/metro.config.js', '.'],
        ['node_modules/dep/metro.config.js', 'node_modules/dep'], ['packages/tool/metro.config.js', 'packages/tool'],
        ['dependencies/dep/metro.config.js', 'dependencies/dep'],
        ['node_modules/react-native/react-native.config.js', 'node_modules/react-native'],
        ['vendor/dep/tool.config.js', 'vendor/dep'],
      ]) {
        const own = targetDir === '.'
        const excluded = name === 'cosmiconfig' || own, expectedCycles = excluded ? 0 : 1
        const edges = new Map([[source, [target]], [target, [source]]])
        for (const shortened of [false, true]) {
          const original = new Map([...edges.keys()].map(path => [shortened ? path.replace('node_modules/', '') : path, path]))
          const display = new Map([...original].map(([path, orig]) => [orig, path]))
          const pkgOf = path => bundlePkgOf(original.get(path), { packageDir: original.get(path) === source ? sourceDir : targetDir })
          const tree = Object.fromEntries([...edges].map(([path, targets]) => [display.get(path), { imports: targets.map(to => display.get(to)) }]))
          const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf })
          for (const node of graph.nodes) node.origFile = original.get(node.file)
          graph.ownSourcePackages = new Set(own ? [pkgOf(display.get(target))] : [])
          graph.ownSourceFiles = new Set(own ? [display.get(target)] : [])
          for (const expanded of [new Set(), new Set(graph.packages)]) {
            const full = buildDependencyMatrix(graph, { expanded })
            assert.equal(full.cycleCount, expectedCycles, `${source} -> ${target}`)
            assert.equal(full.importCount, 2)
            const filtered = buildDependencyMatrix(graph, { expanded, cyclesOnly: true })
            assert.equal(filtered.importCount, expectedCycles ? 2 : 0)
            const from = expanded.size > 0 ? `f:${display.get(source)}` : `p:${pkgOf(display.get(source))}`
            const to = expanded.size > 0 ? `f:${display.get(target)}` : `p:${pkgOf(display.get(target))}`
            const panel = text(renderMatrixPanel(full, graph, { from, to }, { expanded }))
            assert.equal(panel.includes('Excluded from cycles'), excluded)
            assert.equal(panel.includes('Import participates in a cycle'), !excluded)
          }
          for (const packagesView of [false, true]) {
            const network = dependencyNetwork(graph, packagesView)
            const result = layoutPackageDependencies(network.nodes.map(node => node.file), network.importsOf, [], { cycleImportsOf: network.cycleImportsOf })
            assert.equal(result.cycles.length, expectedCycles)
            assert.equal(result.edges.length, 2)
          }
        }
        const details = { kind: 'stasis', integrity: 'config-loader', size: 1, bundle: new Bundle({
          modules: new Map([
            [sourceDir, { name, version: '1.0.0', files: { [file]: 'loader' } }],
            [targetDir, { name: own ? 'app' : 'dep', version: '1.0.0', files: { [own ? target : target.slice(targetDir.length + 1)]: 'config' } }],
          ]),
          imports: new Map([['node,import', new Map([...edges].map(([path, targets]) => [path, new Map(targets.map(to => [to, to]))]))]]),
        }) }
        const metadata = parseBundleMetadata(await createBundleMetadata(details), details.integrity)
        for (const input of [details, metadata]) {
          const graph = bundleWhy(input, { packageKey: name, version: '1.0.0' })
          assert.equal(graph.imports.get(sourceDir).has(targetDir), !excluded)
          const result = layoutWhy(graph)
          assert.equal(result.boxes.filter(box => box.members.length > 1).length, expectedCycles)
          assert.equal(result.boxes.length, expectedCycles ? 1 : 2)
        }
      }
    }
  })

  test('import-fresh distinguishes own source from a dependency with the same directory name', () => {
    const own = 'tools/local.config.js', target = 'node_modules/tools/metro.config.js'
    const name = 'import-fresh', source = 'node_modules/import-fresh/index.js'
    const edges = new Map([[source, [own, target]], [own, [source]], [target, [source]]])
    for (const shortened of [false, true]) {
      const original = new Map([...edges.keys()].map(path => [shortened ? path.replace('node_modules/', '') : path, path]))
      const display = new Map([...original].map(([path, orig]) => [orig, path]))
      const tree = Object.fromEntries([...edges].map(([path, targets]) => [display.get(path), { imports: targets.map(to => display.get(to)) }]))
      const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf: path => bundlePkgOf(original.get(path)) })
      for (const node of graph.nodes) node.origFile = original.get(node.file)
      assert.equal(graph.nodeByFile.get(display.get(own)).pkg, '__own__')
      assert.equal(graph.nodeByFile.get(display.get(target)).pkg, 'tools')
      graph.ownSourcePackages = new Set(['__own__'])
      graph.ownSourceFiles = new Set([display.get(own)])
      const from = `f:${display.get(source)}`, to = `f:${display.get(target)}`
      for (const expanded of [new Set(), new Set(graph.packages)]) {
        const full = buildDependencyMatrix(graph, { expanded })
        assert.equal(full.cycleCount, 1, 'the dependency config must still close a real cycle')
        if (expanded.size > 0) {
          assert.equal(full.cells.get(from).get(to).cyclic, true)
          assert.equal(full.cells.get(from).get(`f:${display.get(own)}`).cyclic, false)
          const filtered = buildDependencyMatrix(graph, { expanded, cyclesOnly: true })
          assert.deepEqual(new Set(filtered.rows.map(row => row.file)), new Set([display.get(source), display.get(target)]))
          assert.doesNotMatch(text(renderMatrixPanel(full, graph, { from, to }, { expanded })), /Excluded from cycles/u)
          assert.match(text(renderMatrixPanel(full, graph, { from, to: `f:${display.get(own)}` }, { expanded })), /Excluded from cycles/u)
        } else {
          const filtered = buildDependencyMatrix(graph, { cyclesOnly: true })
          assert.deepEqual(filtered.cells.get(`p:${name}`).get('p:tools').examples, [[display.get(source), display.get(target)]])
        }
      }
      for (const packagesView of [false, true]) {
        const network = dependencyNetwork(graph, packagesView)
        const result = layoutPackageDependencies(network.nodes.map(node => node.file), network.importsOf, [], { cycleImportsOf: network.cycleImportsOf })
        assert.equal(result.cycles.length, 1)
        assert.deepEqual(new Set(result.cycles[0]), new Set(packagesView ? [name, 'tools'] : [display.get(source), display.get(target)]))
      }
    }
  })

  test('report import-fresh exclusions follow the active dependency directory and retain ownership across context changes', (t) => {
    const previous = depsDirName()
    t.after(() => configureDepsDir([{ tree: { [`${previous}/restore/index.js`]: {} } }]))
    const source = 'node_modules/import-fresh/index.js'
    for (const target of ['dependencies/foo.config.js', 'vendor/foo.config.js', 'node_modules/dep/foo.config.js']) {
      const own = !target.startsWith('node_modules/')
      const tree = { [source]: { imports: [target] }, [target]: { imports: [source] } }
      configureDepsDir([{ tree }])
      assert.equal(depsDirName(), 'node_modules')
      assert.equal(isModule(target), !own)
      const files = Object.keys(tree)
      const graph = buildGraph(tree, files, new Map())
      graph.ownSourceFiles = reportOwnSourceFiles(files)
      // The report owning this graph must not change when a different report
      // (or workspace load state) selects a different dependency directory.
      configureDepsDir([])
      assert.equal(depsDirName(), 'dependencies')
      for (const expanded of [new Set(), new Set(graph.packages)]) {
        const model = buildDependencyMatrix(graph, { expanded })
        assert.equal(model.cycleCount, own ? 0 : 1, `${source} -> ${target}`)
        assert.equal(buildDependencyMatrix(graph, { expanded, cyclesOnly: true }).importCount, own ? 0 : 2)
        const from = expanded.size > 0 ? `f:${source}` : `p:${graph.nodeByFile.get(source).pkg}`
        const to = expanded.size > 0 ? `f:${target}` : `p:${graph.nodeByFile.get(target).pkg}`
        assert.equal(text(renderMatrixPanel(model, graph, { from, to }, { expanded })).includes('Excluded from cycles'), own)
      }
      for (const packagesView of [false, true]) {
        const network = dependencyNetwork(graph, packagesView)
        const result = layoutPackageDependencies(network.nodes.map(node => node.file), network.importsOf, [], { cycleImportsOf: network.cycleImportsOf })
        assert.equal(result.cycles.length, own ? 0 : 1)
        assert.equal(result.edges.length, 2)
      }
      assert.equal(reportOwnSourceFiles([target]).has(target), !target.startsWith('dependencies/'))
    }
  })
})

describe('React Native platform config loads', () => {
  const source = 'node_modules/react-native/react-native.config.js'
  const entry = 'node_modules/react-native/index.js'
  const platforms = ['android', 'ios']

  test('only React Native’s own config loading the Android or iOS CLI entry point is excluded', () => {
    const prefixes = ['', '/project/', 'node_modules/outer/', 'node_modules/.pnpm/react-native@1.0.0/']
    for (const platform of platforms) {
      const target = `node_modules/@react-native-community/cli-platform-${platform}/build/index.js`
      for (const from of prefixes) {
        for (const to of prefixes) assert.equal(countsTowardsCycles(from + source, to + target), false, `${from + source} -> ${to + target}`)
      }
      for (const from of [entry, 'react-native.config.js', 'react-native/react-native.config.js', `${source}.bak`, `${source}/index.js`,
        source.replace('/react-native/', '/other/'), source.replace('node_modules/', 'my_node_modules/'),
        'node_modules/@other/react-native/react-native.config.js', 'node_modules/react-native/subdir/react-native.config.js']) {
        assert.equal(countsTowardsCycles(from, target), true, from)
      }
      for (const to of [`${target}.bak`, `${target}/other.js`, target.replace('build/index.js', 'package.json'),
        target.replace('index.js', 'helper.js'), target.replace('node_modules/', 'my_node_modules/'),
        target.replace('/@react-native-community/', '/@other/'), target.replace(`cli-platform-${platform}`, 'cli-platform-apple')]) {
        assert.equal(countsTowardsCycles(source, to), true, to)
      }
      assert.equal(countsTowardsCycles(target, source), true, 'the reverse import remains eligible')
    }
  })

  test('platform config loads remain visible without closing grid, dependency, or full/cached why cycles', async () => {
    for (const platform of platforms) {
      const pkg = `@react-native-community/cli-platform-${platform}`, target = `node_modules/${pkg}/build/index.js`
      for (const ordinary of [false, true]) {
        const edges = new Map([[source, [target]], [target, [source, ...(ordinary ? [entry] : [])]], ...(ordinary ? [[entry, [target]]] : [])])
        for (const shortened of [false, true]) {
          const display = path => shortened ? path.slice('node_modules/'.length) : path
          const original = new Map([...edges.keys()].map(path => [display(path), path]))
          const tree = Object.fromEntries([...edges].map(([path, targets]) => [display(path), { imports: targets.map(display) }]))
          const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf: path => bundlePkgOf(original.get(path)) })
          for (const node of graph.nodes) node.origFile = original.get(node.file)
          for (const expanded of [new Set(), new Set(graph.packages)]) {
            const full = buildDependencyMatrix(graph, { expanded })
            assert.equal(full.cycleCount, ordinary ? 1 : 0)
            assert.equal(full.importCount, ordinary ? 4 : 2)
            const filtered = buildDependencyMatrix(graph, { expanded, cyclesOnly: true })
            assert.equal(filtered.rows.length, ordinary ? 2 : 0)
            assert.ok(filtered.visibleCells.every(cell => cell.examples.every(([from, to]) => from !== display(source) || to !== display(target))))
            const from = expanded.size > 0 ? `f:${display(source)}` : 'p:react-native', to = expanded.size > 0 ? `f:${display(target)}` : `p:${pkg}`
            assert.match(text(renderMatrixPanel(full, graph, { from, to }, { expanded })), /Excluded from cycles/u)
            assert.equal(full.cells.get(from).get(to).cyclic, expanded.size === 0 && ordinary)
          }
          for (const packagesView of [false, true]) {
            const network = dependencyNetwork(graph, packagesView)
            const result = layoutPackageDependencies(network.nodes.map(node => node.file), network.importsOf, [], { cycleImportsOf: network.cycleImportsOf })
            assert.equal(result.cycles.length, ordinary ? 1 : 0)
            assert.equal(result.edges.length, packagesView ? 2 : ordinary ? 4 : 2)
          }
        }
        const details = { kind: 'stasis', integrity: 'platform-config', size: 1, bundle: new Bundle({
          modules: new Map([
            ['node_modules/react-native', { name: 'react-native', version: '1.0.0', files: { 'react-native.config.js': 'config', 'index.js': 'native' } }],
            [`node_modules/${pkg}`, { name: pkg, version: '1.0.0', files: { 'build/index.js': 'platform' } }],
          ]),
          imports: new Map([['node,import', new Map([...edges].map(([path, targets]) => [path, new Map(targets.map(to => [to, to]))]))]]),
        }) }
        const metadata = parseBundleMetadata(await createBundleMetadata(details), details.integrity)
        for (const input of [details, metadata]) {
          const graph = bundleWhy(input, { packageKey: pkg, version: '1.0.0' })
          assert.equal(graph.imports.get('node_modules/react-native')?.has(`node_modules/${pkg}`) ?? false, ordinary)
          const result = layoutWhy(graph)
          assert.equal(result.boxes.filter(box => box.members.length > 1).length, ordinary ? 1 : 0)
          assert.equal(result.boxes.length, 1)
        }
      }
    }
  })
})

describe('React Native CLI release checks', () => {
  const cli = '@react-native-community/cli-tools'
  const source = `node_modules/${cli}/build/releaseChecker/index.js`
  const target = 'node_modules/react-native/package.json'
  const entry = 'node_modules/react-native/index.js'

  function imports(ordinary) {
    return new Map([[source, [target, ...(ordinary ? [entry] : [])]], [target, [source]], ...(ordinary ? [[entry, [source]]] : [])])
  }

  test('only the installed CLI release checker reading the React Native manifest is excluded', () => {
    const prefixes = ['', '/project/', 'node_modules/outer/', 'node_modules/.pnpm/react-native@1.0.0/']
    for (const from of prefixes) {
      for (const to of prefixes) assert.equal(countsTowardsCycles(from + source, to + target), false, `${from + source} -> ${to + target}`)
    }
    for (const from of [source + '.bak', source.replace('/releaseChecker/', '/other/'), source.replace('/cli-tools/', '/cli-tools-other/'),
      source.replace('/@react-native-community/', '/@other/'), source.replace('node_modules/', 'my_node_modules/'), source.slice('node_modules/'.length)]) {
      assert.equal(countsTowardsCycles(from, target), true, from)
    }
    for (const to of [entry, 'package.json', 'react-native/package.json', 'node_modules/other/package.json', target + '.bak', target + '/index.js',
      target.replace('/react-native/', '/react-native-other/'), target.replace('node_modules/', 'my_node_modules/'),
      'node_modules/@other/react-native/package.json', 'node_modules/react-native/subdir/package.json']) {
      assert.equal(countsTowardsCycles(source, to), true, to)
    }
    assert.equal(countsTowardsCycles(target, source), true, 'the reverse import remains eligible')
  })

  test('release-checker reads stay visible but cannot close grid or dependency cycles, including shortened paths', () => {
    for (const ordinary of [false, true]) {
      for (const shortened of [false, true]) {
        const edges = imports(ordinary)
        const display = path => shortened ? path.slice('node_modules/'.length) : path
        const original = new Map([...edges.keys()].map(path => [display(path), path]))
        const tree = Object.fromEntries([...edges].map(([path, targets]) => [display(path), { imports: targets.map(display) }]))
        const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf: path => bundlePkgOf(original.get(path)) })
        for (const node of graph.nodes) node.origFile = original.get(node.file)
        for (const expanded of [new Set(), new Set(graph.packages)]) {
          const full = buildDependencyMatrix(graph, { expanded })
          assert.equal(full.cycleCount, ordinary ? 1 : 0)
          assert.equal(full.importCount, ordinary ? 4 : 2)
          const filtered = buildDependencyMatrix(graph, { expanded, cyclesOnly: true })
          assert.equal(filtered.rows.length, ordinary ? 2 : 0)
          assert.ok(filtered.visibleCells.every(cell => cell.examples.every(([from, to]) => from !== display(source) || to !== display(target))))
          const from = expanded.size > 0 ? `f:${display(source)}` : `p:${cli}`, to = expanded.size > 0 ? `f:${display(target)}` : 'p:react-native'
          assert.match(text(renderMatrixPanel(full, graph, { from, to }, { expanded })), /Excluded from cycles/u)
          if (expanded.size > 0) assert.equal(full.cells.get(from).get(to).cyclic, false)
        }
        for (const packagesView of [false, true]) {
          const network = dependencyNetwork(graph, packagesView)
          const result = layoutPackageDependencies(network.nodes.map(node => node.file), network.importsOf, [], { cycleImportsOf: network.cycleImportsOf })
          assert.equal(result.cycles.length, ordinary ? 1 : 0)
          assert.equal(result.edges.length, packagesView ? 2 : ordinary ? 4 : 2)
        }
      }
    }
  })

  test('full and cached why graphs exclude release checks but preserve ordinary imports between the same packages', async () => {
    for (const ordinary of [false, true]) {
      const details = { kind: 'stasis', integrity: 'release-checker', size: 1, bundle: new Bundle({
        modules: new Map([
          [`node_modules/${cli}`, { name: cli, version: '1.0.0', files: { 'build/releaseChecker/index.js': 'checker' } }],
          ['node_modules/react-native', { name: 'react-native', version: '1.0.0', files: { 'package.json': '{}', 'index.js': 'native' } }],
        ]),
        imports: new Map([['node,import', new Map([...imports(ordinary)].map(([path, targets]) => [path, new Map(targets.map(to => [to, to]))]))]]),
      }) }
      const metadata = parseBundleMetadata(await createBundleMetadata(details), details.integrity)
      for (const input of [details, metadata]) {
        const graph = bundleWhy(input, { packageKey: 'react-native', version: '1.0.0' })
        assert.equal(graph.imports.get(`node_modules/${cli}`)?.has('node_modules/react-native') ?? false, ordinary)
        const result = layoutWhy(graph)
        assert.equal(result.boxes.filter(box => box.members.length > 1).length, ordinary ? 1 : 0)
        assert.equal(result.boxes.length, 1)
      }
    }
  })
})
