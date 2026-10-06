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
import { bundleWhy, layoutWhy } from '../ui/view/bundle-why.js'
import { createBundleMetadata, parseBundleMetadata } from '../common/bundle-metadata.js'

const source = 'node_modules/react-native/react-native.config.js'
const entry = 'node_modules/react-native/index.js'
const platforms = ['android', 'ios']

function text(value) {
  if (Array.isArray(value)) return value.map(text).join('')
  if (value?.strings) return value.strings.map((part, i) => part + text(value.values[i])).join('')
  return typeof value === 'string' ? value : ''
}

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
