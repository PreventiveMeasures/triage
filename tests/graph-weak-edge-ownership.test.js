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
import { bundleDependencyChains } from '../ui/view/bundle-dependency-chains.js'
import { createBundleMetadata, parseBundleMetadata } from '../common/bundle-metadata.js'

const codegen = 'node_modules/react-native/scripts/codegen/generate-artifacts-executor.js'
const manifest = 'node_modules/dep/package.json'
const babel = 'node_modules/@babel/core/lib/config/files/module-types.js'
const preset = 'node_modules/@babel/preset-typescript/lib/index.js'

function text(value) {
  if (Array.isArray(value)) return value.map(text).join('')
  if (value?.strings) return value.strings.map((part, i) => part + text(value.values[i])).join('')
  return typeof value === 'string' ? value : ''
}

test('the upstream adapter preserves ownership and resolves nested package owners', () => {
  assert.equal(countsTowardsCycles(babel, preset, false, false), false)
  assert.equal(countsTowardsCycles(babel, preset, true, false), true, 'an own-source target is not an installed preset')
  assert.equal(countsTowardsCycles(codegen, manifest, false, true), true, 'an own-source importer is not an installed loader')
  assert.equal(countsTowardsCycles(codegen, manifest, true, false), false, 'package-agnostic discovery still accepts own-source targets')
  assert.equal(countsTowardsCycles('node_modules/outer/' + babel, 'node_modules/.pnpm/preset@1.0.0/' + preset), false)
  assert.equal(countsTowardsCycles(babel, 'node_modules/@babel/preset-typescript/node_modules/other/lib/index.js'), true)
  assert.equal(countsTowardsCycles('node_modules/@babel/core/node_modules/other/lib/config/files/module-types.js', preset), true)
})

test('grid cycles, inspectors and dependency networks use ownership at both ends of original paths', () => {
  for (const [source, target, ownTarget] of [[codegen, manifest, false], [babel, preset, true]]) {
    for (const own of [false, true]) {
      for (const shortened of [false, true]) {
        const originals = new Map([source, target].map(path => [shortened ? path.replace('node_modules/', '') : path, path]))
        const [from, to] = originals.keys()
        const tree = { [from]: { imports: [to] }, [to]: { imports: [from] } }
        const graph = buildGraph(tree, [from, to], new Map(), null, null, null, null, { pkgOf: path => path === from ? 'loader' : 'target' })
        for (const node of graph.nodes) node.origFile = originals.get(node.file)
        graph.ownSourceFiles = new Set(own ? [ownTarget ? to : from] : [])
        for (const expanded of [new Set(), new Set(graph.packages)]) {
          const model = buildDependencyMatrix(graph, { expanded })
          assert.equal(model.cycleCount, own ? 1 : 0)
          assert.equal(buildDependencyMatrix(graph, { expanded, cyclesOnly: true }).importCount, own ? 2 : 0)
          const selection = { from: expanded.size > 0 ? `f:${from}` : 'p:loader', to: expanded.size > 0 ? `f:${to}` : 'p:target' }
          assert.equal(text(renderMatrixPanel(model, graph, selection, { expanded })).includes('Excluded from cycles'), !own)
        }
        for (const packagesView of [false, true]) {
          const network = dependencyNetwork(graph, packagesView)
          const layout = layoutPackageDependencies(network.nodes.map(node => node.file), network.importsOf, [], { cycleImportsOf: network.cycleImportsOf })
          assert.equal(layout.cycles.length, own ? 1 : 0)
          assert.equal(layout.edges.length, 2, 'raw loads remain available outside cycle filtering')
        }
      }
    }
  }
})

test('full and metadata-only advisory chains retain own-source imports that resemble installed loaders', async () => {
  for (const own of [false, true]) {
    const fromDir = own ? '.' : 'node_modules/react-native'
    const sourcePath = own ? codegen : codegen.slice(fromDir.length + 1)
    const details = { kind: 'stasis', integrity: `ownership-${own}`, size: 1, bundle: new Bundle({
      modules: new Map([
        [fromDir, { name: 'react-native', version: '1.0.0', files: { [sourcePath]: 'source' } }],
        ['node_modules/dep', { name: 'dep', version: '1.0.0', files: { 'package.json': '{}' } }],
      ]),
      imports: new Map([['node,import', new Map([[codegen, new Map([['dep/package.json', manifest]])]])]]),
    }) }
    const metadata = parseBundleMetadata(await createBundleMetadata(details), details.integrity)
    for (const input of [details, metadata]) {
      const graph = bundleDependencyChains(input, { packageKey: 'dep', version: '1.0.0' })
      assert.equal(graph.nodes.has(fromDir), own)
      assert.equal(graph.imports.get(fromDir)?.has('node_modules/dep') ?? false, own)
      assert.equal(graph.nodes.get('node_modules/dep').excludedImporters?.has(fromDir) ?? false, !own)
    }
  }
})
