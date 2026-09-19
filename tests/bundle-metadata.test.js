import assert from 'node:assert/strict'
import { it } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { bundleNeedsSources, computeBundleFileHashes, createBundleMetadata, parseBundleMetadata } from '../ui/view/bundle-metadata.js'
import { bundlePackageDirs, bundleSourceSizes, bundleSourcesAsMap } from '../ui/view/bundle-sources.js'
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
  assert.deepEqual(bundleSourceSizes(cached), bundleSourceSizes(full))
  assert.equal(cached.fileSizes.get('src/main.js'), Buffer.byteLength('private source €😀'))
  assert.equal(cached.fileSizes.get('src/empty.js'), 0)
  assert.equal(cached.fileSizes.get('icon.png'), null)
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
    { ...data, integrity: 'other' }, { ...data, version: 2 },
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
