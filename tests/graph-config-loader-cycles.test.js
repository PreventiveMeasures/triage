import assert from 'node:assert/strict'
import { test } from 'node:test'
import '../ui/view/frontend-install.js'
import { Bundle } from '@exodus/stasis-core/bundle'
import { countsTowardsCycles } from '../ui/view/graph/cycle-imports.js'
import { buildGraph } from '../ui/view/graph/data.js'
import { buildDependencyMatrix } from '../ui/view/graph/matrix-model.js'
import { renderMatrixPanel } from '../ui/view/graph/matrix-panel.js'
import { dependencyNetwork } from '../ui/view/graph/package-network.js'
import { layoutPackageDependencies } from '../ui/view/graph/dependency-layout.js'
import { bundlePkgOf } from '../ui/view/bundle-pkg-of.js'
import { bundleDependencyChains, layoutDependencyChains } from '../ui/view/bundle-dependency-chains.js'
import { createBundleMetadata, parseBundleMetadata } from '../common/bundle-metadata.js'
import { configureDepsDir, depsDirName, isModule } from '../ui/view/format.js'
import { reportOwnSourceFiles } from '../ui/view/graph/utils.js'

const loaders = [
  ['cosmiconfig', 'dist/loaders.js'],
  ['import-fresh', 'index.js'],
]

function text(value) {
  if (Array.isArray(value)) return value.map(text).join('')
  if (value?.strings) return value.strings.map((part, i) => part + text(value.values[i])).join('')
  return typeof value === 'string' ? value : ''
}

test('Cosmiconfig excludes every config target while import-fresh remains limited to own source', () => {
  for (const source of [...loaders.map(([name, file]) => `node_modules/${name}/${file}`), 'node_modules/import-fresh/dist/index.js']) {
    const cosmiconfig = source === 'node_modules/cosmiconfig/dist/loaders.js'
    for (const prefix of ['', '/project/', 'node_modules/outer/', 'node_modules/.pnpm/import-fresh@1.0.0/']) {
      for (const target of ['metro.config.js', 'config/metro.config.js', '/project/tools/lint.config.js', 'vendor/dep/tool.config.js']) {
        assert.equal(countsTowardsCycles(prefix + source, target), false, `${prefix + source} -> ${target}`)
        assert.equal(countsTowardsCycles(prefix + source, target, false), !cosmiconfig, 'only import-fresh requires own-source ownership')
      }
      for (const target of ['node_modules/react-native/react-native.config.js', 'node_modules/dep/metro.config.js',
        'node_modules/@org/dep/metro.config.js', 'dependencies/dep/metro.config.js']) {
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

test('config discovery ownership agrees across the grid, inspector, dependency graph and cached advisory graph', async () => {
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
        const graph = bundleDependencyChains(input, { packageKey: name, version: '1.0.0' })
        assert.equal(graph.imports.get(sourceDir).has(targetDir), !excluded)
        const result = layoutDependencyChains(graph)
        assert.equal(result.boxes.filter(box => box.members.length > 1).length, expectedCycles)
        assert.equal(result.boxes.length, expectedCycles ? 1 : 2)
      }
    }
  }
})

test('import-fresh ownership is per file when own-source and dependency package keys collide', () => {
  const own = 'tools/local.config.js', target = 'node_modules/tools/metro.config.js'
  const name = 'import-fresh', source = 'node_modules/import-fresh/index.js'
  const edges = new Map([[source, [own, target]], [own, [source]], [target, [source]]])
  for (const shortened of [false, true]) {
    const original = new Map([...edges.keys()].map(path => [shortened ? path.replace('node_modules/', '') : path, path]))
    const display = new Map([...original].map(([path, orig]) => [orig, path]))
    const tree = Object.fromEntries([...edges].map(([path, targets]) => [display.get(path), { imports: targets.map(to => display.get(to)) }]))
    const graph = buildGraph(tree, Object.keys(tree), new Map(), null, null, null, null, { pkgOf: path => bundlePkgOf(original.get(path)) })
    for (const node of graph.nodes) node.origFile = original.get(node.file)
    assert.equal(graph.nodeByFile.get(display.get(own)).pkg, 'tools')
    assert.equal(graph.nodeByFile.get(display.get(target)).pkg, 'tools')
    graph.ownSourcePackages = new Set(['tools'])
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
