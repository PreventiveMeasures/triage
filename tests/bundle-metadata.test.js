import assert from 'node:assert/strict'
import { it } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { bundleNeedsSources, computeBundleFileHashes, createBundleMetadata, parseBundleMetadata } from '../ui/view/bundle-metadata.js'
import { bundleFileKinds, bundleFileSizes, bundlePackageDirs, bundleSourceSizes, bundleSourcesAsMap } from '../ui/view/bundle-sources.js'
import { bundleGraphReasons, bundleImportsAsMap } from '../ui/view/bundle-graph-inputs.js'
import { computeFileHash } from '../report/index.js'

function details() {
  return { integrity: 'sha512-test', kind: 'stasis', size: 2345, bundle: new Bundle({
    entries: new Set(['src/main.js']),
    modules: new Map([
      ['.', { name: 'app', version: '1', files: { 'src/main.js': 'private source €😀', 'src/empty.js': '', 'icon.png': { base64: 'private asset' } } }],
      ['node_modules/dep', { name: 'dep', version: '2', files: { 'a.js': 'private dependency' } }],
    ]),
    formats: new Map([['src/main.js', 'module']]),
    imports: new Map([['node,import', new Map([['src/main.js', new Map([['dep', new Map([['ios', 'node_modules/dep/a.js'], ['android', 'src/empty.js']])]])]])]]),
    reason: { run: ['src/main.js', 'node_modules/dep/a.js'] },
  }) }
}

it('round-trips hashes, UTF-8 byte sizes, package identity, imports, reasons, and entries without source bodies', async () => {
  const full = details()
  const data = await createBundleMetadata(full)
  const serialized = JSON.stringify(data)
  assert.ok(!serialized.includes('private'))
  const cached = parseBundleMetadata(JSON.parse(serialized), full.integrity)
  assert.equal(cached.metadataOnly, true)
  assert.deepEqual(bundleFileSizes(cached), bundleFileSizes(full))
  assert.deepEqual(bundleSourceSizes(cached), bundleSourceSizes(full))
  assert.equal(cached.stale, false)
  assert.equal(cached.fileSizes.get('src/main.js'), Buffer.byteLength('private source €😀'))
  assert.equal(cached.fileSizes.get('src/empty.js'), 0)
  assert.equal(cached.fileSizes.get('icon.png'), null)
  assert.equal(cached.lineCounts.get('src/main.js'), 1)
  assert.equal(cached.lineCounts.get('src/empty.js'), 0)
  assert.equal(cached.lineCounts.has('icon.png'), false)
  assert.deepEqual(cached.fileHashes, await computeBundleFileHashes(full))
  assert.deepEqual(bundlePackageDirs(cached), bundlePackageDirs(full))
  assert.deepEqual(bundleImportsAsMap(cached), bundleImportsAsMap(full))
  assert.deepEqual(cached.bundle.entries, full.bundle.entries)
  assert.deepEqual(bundleGraphReasons(cached, cached.fileHashes.keys()), bundleGraphReasons(full, full.fileHashes.keys()))
  assert.equal(bundleSourcesAsMap(cached).size, 0, 'metadata cannot masquerade as source bodies')
  for (const [file, content] of bundleSourcesAsMap(full)) assert.equal(cached.fileHashes.get(file), await computeFileHash(content))
})

it('supports legacy Stasis bundles and sourcemaps with absent source content', async () => {
  const legacy = { integrity: 'legacy', kind: 'stasis', size: 123, bundle: Bundle.parse(JSON.stringify({
    version: 0, config: { scope: 'node_modules' }, formats: {}, imports: {}, sources: { 'node_modules/dep/a.js': 'secret' },
  })) }
  const cachedLegacy = parseBundleMetadata(await createBundleMetadata(legacy), 'legacy')
  assert.equal(cachedLegacy.bundle.version, 0)
  assert.deepEqual(cachedLegacy.fileHashes, legacy.fileHashes)
  assert.deepEqual(bundlePackageDirs(cachedLegacy), bundlePackageDirs(legacy))
  const map = { integrity: 'map', kind: 'sourcemap', size: 200, json: { version: 3, file: 'app.js', sourceRoot: 'root', names: ['foo'], sources: ['a.js', 'b.js', 'c.js'], sourcesContent: ['秘密', null, ''] } }
  const cached = parseBundleMetadata(await createBundleMetadata(map), 'map')
  assert.deepEqual(cached.json.sources, map.json.sources)
  assert.deepEqual(cached.fileSizes, new Map([['a.js', 6], ['b.js', null], ['c.js', 0]]))
  assert.equal(cached.namesCount, 1)
  assert.equal(cached.json.sourcesContent, undefined)
  const duplicate = { integrity: map.integrity, kind: map.kind, size: map.size,
    json: { ...map.json, sources: ['same.js', 'same.js', 'same.js'], sourcesContent: ['a', 'longer', null] } }
  const cachedDuplicate = parseBundleMetadata(await createBundleMetadata(duplicate), 'map')
  assert.deepEqual(cachedDuplicate.json.sources, duplicate.json.sources)
  assert.deepEqual(cachedDuplicate.sourceSizes, [1, 6, null])
  assert.deepEqual(cachedDuplicate.fileHashes, await computeBundleFileHashes(duplicate))
})

it('rejects wrong integrities, versions, invalid sizes/hashes and mismatched inventories', async () => {
  const data = await createBundleMetadata(details())
  for (const corrupt of [
    { ...data, integrity: 'other' }, { ...data, version: 3 },
    { ...data, files: data.files.map((row) => row.slice(0, 3)) },
    { ...data, files: [['src/main.js', -1, 'bad']] },
    { ...data, files: [['src/main.js', 12, 'bad']] },
    { ...data, files: [...data.files, data.files[0]] }, { ...data, files: data.files.slice(1) },
  ]) assert.throws(() => parseBundleMetadata(corrupt, data.integrity))
})

it('shares in-flight hashing and reuses precomputed hashes for source-consuming views', async () => {
  const full = details()
  const a = computeBundleFileHashes(full), b = computeBundleFileHashes(full)
  assert.equal(a, b)
  const hashes = await a
  assert.equal(await computeBundleFileHashes(full), hashes)
  const cached = parseBundleMetadata(await createBundleMetadata(full), full.integrity)
  assert.equal(await computeBundleFileHashes(cached), cached.fileHashes)
  for (const tab of ['terminal', 'code', 'search', 'compare']) assert.equal(bundleNeedsSources(tab), true)
  for (const tab of ['overview', 'graph', 'treemap', 'issues', 'advisories']) {
    assert.equal(bundleNeedsSources(tab), false)
    assert.equal(bundleNeedsSources(tab, 'src/main.js'), true)
  }
})

// The bundle a stale index hid: a directory capture over the directory it
// lists, with a base64 image and a utf8 resource beside the source.
function withResources() {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe])
  return { integrity: 'sha512-resources', kind: 'stasis', size: 999, bundle: Bundle.parse(new Bundle({
    modules: new Map([['.', { name: 'app', version: '1', files: {
      'src/main.js': 'export default 1\n',
      'assets': JSON.stringify(['icon.svg', 'logo.png']),
      'assets/icon.svg': '<svg/>',
      'assets/logo.png': png.toString('base64'),
    } }]]),
    formats: new Map([['src/main.js', 'module'], ['assets', 'directory'], ['assets/icon.svg', 'resource'], ['assets/logo.png', 'resource:base64']]),
    entries: new Set(['src/main.js']),
  }).serialize()) }
}

it('keeps a resource\'s byte size, and no hash or line count, since it is no source', async () => {
  const full = withResources()
  const data = await createBundleMetadata(full)
  assert.equal(data.version, 2)
  const rows = new Map(data.files.map(([path, ...rest]) => [path, rest]))
  assert.deepEqual(rows.get('assets/logo.png'), [7, null, null])
  assert.deepEqual(rows.get('assets/icon.svg'), [6, null, null])
  assert.deepEqual(rows.get('assets'), [null, null, null])
  assert.equal(rows.get('src/main.js')[0], 17)
  const cached = parseBundleMetadata(JSON.parse(JSON.stringify(data)), full.integrity)
  assert.equal(cached.stale, false)
  assert.deepEqual(bundleFileSizes(cached), bundleFileSizes(full))
  assert.deepEqual(bundleFileKinds(cached), bundleFileKinds(full), 'a metadata-only open tells resources apart too')
  assert.deepEqual([...cached.fileHashes.keys()], ['src/main.js'])
})

it('records a base64 resource that does not decode without a size, and reads it back', async () => {
  const full = withResources()
  full.bundle = Bundle.parse(JSON.stringify({ ...JSON.parse(full.bundle.serialize()) }))
  full.bundle.modules.get('.').files['assets/logo.png'] = '!!!not base64!!!'
  const data = await createBundleMetadata(full)
  assert.deepEqual(data.files.find(([path]) => path === 'assets/logo.png'), ['assets/logo.png', null, null, null])
  const cached = parseBundleMetadata(JSON.parse(JSON.stringify(data)), full.integrity)
  assert.equal(cached.fileSizes.get('assets/logo.png'), null)
  assert.equal(bundleFileKinds(cached).get('assets/logo.png'), 'resource', 'still a file to list')
})

it('rejects a current index whose hashes disagree with what is source', async () => {
  const data = await createBundleMetadata(withResources())
  const hash = data.files.find(([path]) => path === 'src/main.js')[2]
  const edit = (path, change) => ({ ...data, files: data.files.map((row) => row[0] === path ? change(row) : row) })
  for (const corrupt of [
    edit('assets/logo.png', ([path, size, , lines]) => [path, size, hash, lines]),
    edit('src/main.js', ([path, size, , lines]) => [path, size, null, lines]),
    edit('assets', ([path, , , lines]) => [path, null, hash, lines]),
  ]) assert.throws(() => parseBundleMetadata(corrupt, data.integrity))
})

it('reads a version 1 index for its hashes, but marks it stale', async () => {
  // What the code before #313 wrote for this bundle: the directory
  // capture a file, the image its base64 text, each with a hash.
  const full = withResources()
  const hashOf = (content) => computeFileHash(content)
  const v1 = { version: 1, integrity: full.integrity, kind: 'stasis', size: full.size, bundle: (await createBundleMetadata(full)).bundle, files: [] }
  for (const [path, content] of full.bundle.sources) v1.files.push([path, Buffer.byteLength(content), await hashOf(content), 1])
  const cached = parseBundleMetadata(v1, full.integrity)
  assert.equal(cached.stale, true)
  assert.equal(cached.fileHashes.get('src/main.js'), await hashOf('export default 1\n'), 'hashes still serve report lookups')
  assert.notDeepEqual(cached.fileSizes, bundleFileSizes(full), 'its sizes are the ones that were wrong')
  // Three-column rows are version 1 only, and still read.
  assert.equal(parseBundleMetadata({ ...v1, files: v1.files.map((row) => row.slice(0, 3)) }, full.integrity).stale, true)
})
