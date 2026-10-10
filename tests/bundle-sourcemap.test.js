import assert from 'node:assert/strict'
import { it } from 'node:test'
import { bundleEdges } from '@preventive/sourcemap/edges.js'
import { createBundleMetadata, parseBundleContents, parseBundleMetadata } from '../ui/view/bundle-metadata.js'
import { bundleFileSizes, bundleSourcesAsMap } from '../ui/view/bundle-sources.js'
import { bundleImportsAsMap } from '../ui/view/bundle-graph-inputs.js'
import { bundleSourceLinkResolver } from '../ui/view/bundle-source-links.js'
import { sourcemapEdges } from '../common/bundle-sourcemap.js'

const identity = { integrity: 'sha512-map', kind: 'sourcemap', size: 100 }

// Metro lists its prelude first, and each file's source names its imports.
const metro = JSON.stringify({ version: 3, sources: ['__prelude__', 'src/index.js', 'src/b.js', 'node_modules/dep/index.js'], names: [], mappings: '',
  sourcesContent: ['var __DEV__=true;', "import { b } from './b'\nimport dep from 'dep'\nconsole.log(b, dep)\n", 'export const b = 1\n', 'module.exports = 1\n'] })
// esbuild's: no prelude, so the client reads no edges of it.
const esbuild = JSON.stringify({ version: 3, sourceRoot: 'app/', sources: ['src/index.ts', 'src/b.ts', 'src/c.ts'], names: ['b'], mappings: '',
  sourcesContent: ["import { b } from './b'\nimport './c'\nconsole.log(b)\n", 'export const b: number = 1\n', null] })

it('reads an index map\'s files across its sections, each once, keyed with sourceRoot in front', async () => {
  const text = JSON.stringify({ version: 3, file: 'out.js', sections: [
    { offset: { line: 0, column: 0 }, map: { version: 3, sourceRoot: 'lib', sources: ['a.js', 'shared.js'], sourcesContent: ['a', null], names: ['x'], mappings: '' } },
    { offset: { line: 9, column: 0 }, map: { version: 3, sources: ['lib/shared.js', 'b.js'], sourcesContent: ['shared', 'bb'], names: ['y', 'z'], mappings: '' } },
  ] })
  const details = parseBundleContents(`)]}'\n${text}`, identity)
  assert.deepEqual(bundleSourcesAsMap(details), new Map([['lib/a.js', 'a'], ['lib/shared.js', 'shared'], ['b.js', 'bb']]))
  assert.deepEqual(bundleFileSizes(details), new Map([['lib/a.js', 1], ['lib/shared.js', 6], ['b.js', 2]]))
  assert.deepEqual(details.json, { version: 3, file: 'out.js', sourceRoot: undefined })
  const cached = parseBundleMetadata(JSON.parse(JSON.stringify(await createBundleMetadata(details))), identity.integrity)
  assert.deepEqual(cached.json.sources, ['lib/a.js', 'lib/shared.js', 'b.js'])
  assert.deepEqual(cached.sourceSizes, [1, 6, 2])
  assert.equal(cached.namesCount, 3)
})

it('refuses a map the reader cannot read', () => {
  assert.throws(() => parseBundleContents('{"version":2,"sources":[],"mappings":""}', identity), { name: 'SourceMapError' })
  assert.throws(() => parseBundleContents('{"version":3,"sources":["a.js"],"mappings":"ACAA"}', identity), { name: 'SourceMapError' })
  assert.throws(() => parseBundleContents('not json', identity), { name: 'SyntaxError' })
})

it('the client reads the edges of a Metro map without a parser, and of no other, for the graph and Code links', () => {
  const details = parseBundleContents(metro, identity)
  assert.deepEqual(bundleImportsAsMap(details), new Map([['src/index.js', new Set(['src/b.js', 'node_modules/dep/index.js'])]]))
  const link = bundleSourceLinkResolver(details, 'src/index.js')
  assert.equal(link('./b'), 'src/b.js')
  assert.equal(link('dep'), 'node_modules/dep/index.js')
  assert.equal(link('./missing'), null)
  const other = parseBundleContents(esbuild, identity)
  assert.deepEqual(bundleImportsAsMap(other), new Map())
  assert.equal(bundleSourceLinkResolver(other, 'app/src/index.ts')('./b'), null)
  // A Metro map with no sourcesContent has no source to read edges from.
  const bare = JSON.parse(metro)
  assert.deepEqual(bundleImportsAsMap(parseBundleContents(JSON.stringify({ ...bare, sourcesContent: undefined }), identity)), new Map())
})

it('metadata carries the edges the server read with the parser, between files of the map alone', async () => {
  const details = parseBundleContents(esbuild, identity)
  details.edges = sourcemapEdges(details.map, bundleEdges)
  assert.deepEqual(details.edges, [['app/src/index.ts', 'app/src/b.ts', './b'], ['app/src/index.ts', 'app/src/c.ts', './c']])
  const data = await createBundleMetadata(details)
  assert.equal(data.version, 6)
  assert.deepEqual(data.edges.map(([from, to, specifier]) => [data.files[from][0], data.files[to][0], specifier]), details.edges)
  const cached = parseBundleMetadata(JSON.parse(JSON.stringify(data)), identity.integrity)
  assert.deepEqual(cached.edges, details.edges)
  assert.deepEqual(bundleImportsAsMap(cached), new Map([['app/src/index.ts', new Set(['app/src/b.ts', 'app/src/c.ts'])]]))
  // The sources the metadata opened keep the server's edges, and Code links
  // follow them: to a file with a body, which c.ts has not.
  const full = parseBundleContents(esbuild, identity)
  full.edges = cached.edges
  assert.deepEqual(bundleImportsAsMap(full), bundleImportsAsMap(cached))
  const link = bundleSourceLinkResolver(full, 'app/src/index.ts')
  assert.equal(link('./b'), 'app/src/b.ts')
  assert.equal(link('./c'), null)
  // An edge from a file to itself is none: metadata refuses one.
  const [self] = details.map.files
  assert.deepEqual(sourcemapEdges(details.map, () => ({ edges: [{ from: self, to: self, kind: 'import', specifier: './index' }] })), [])
  // An index written before edges were kept has none to give.
  const { edges: _edges, ...stale } = data
  assert.equal(parseBundleMetadata({ ...stale, version: 5 }, identity.integrity).edges, undefined)
  assert.deepEqual(bundleImportsAsMap(parseBundleMetadata({ ...stale, version: 5 }, identity.integrity)), new Map())
  for (const edges of [{}, [[0]], [[0, 0]], [[0, 3]], [[-1, 1]], [[0, '1']], [[0, 1, 2]], [[0, 1, './b', 'x']]]) {
    assert.throws(() => parseBundleMetadata({ ...data, edges }, identity.integrity), /Invalid sourcemap edges/u)
  }
})
