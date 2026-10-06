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

const cli = '@react-native-community/cli-tools'
const source = `node_modules/${cli}/build/releaseChecker/index.js`
const target = 'node_modules/react-native/package.json'
const entry = 'node_modules/react-native/index.js'

function imports(ordinary) {
  return new Map([[source, [target, ...(ordinary ? [entry] : [])]], [target, [source]], ...(ordinary ? [[entry, [source]]] : [])])
}

function text(value) {
  if (Array.isArray(value)) return value.map(text).join('')
  if (value?.strings) return value.strings.map((part, i) => part + text(value.values[i])).join('')
  return typeof value === 'string' ? value : ''
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

test('full and cached advisory graphs exclude release checks but preserve ordinary imports between the same packages', async () => {
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
      const graph = bundleDependencyChains(input, { packageKey: 'react-native', version: '1.0.0' })
      assert.equal(graph.imports.get(`node_modules/${cli}`)?.has('node_modules/react-native') ?? false, ordinary)
      const result = layoutDependencyChains(graph)
      assert.equal(result.boxes.filter(box => box.members.length > 1).length, ordinary ? 1 : 0)
      assert.equal(result.boxes.length, 1)
    }
  }
})
