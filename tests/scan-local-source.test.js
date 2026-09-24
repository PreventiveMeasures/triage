import assert from 'node:assert/strict'
import { test } from 'node:test'
import { storedScanBundle, storedScanSource } from '../ui/scan/bundle-source.js'

test('local scan catalogue contains only saved bundle identities, without demo repositories', () => {
  assert.deepEqual(storedScanSource([]), { repositories: [], bundles: [], reports: [], scans: [] })
  const source = storedScanSource([{ integrity: 'sha512-first', name: 'first.map' }, { integrity: 'sha512-second', name: 'second.stasis' }])
  assert.deepEqual(source.repositories, [{ id: 'unattached', label: 'Unattached' }])
  assert.deepEqual(source.bundles.map(bundle => [bundle.id, bundle.filename, bundle.files]), [['sha512-first', 'first.map', null], ['sha512-second', 'second.stasis', null]])
})

test('stored sourcemap files use actual byte sizes and package names', () => {
  const entry = storedScanSource([{ integrity: 'test', name: 'test.map' }]).bundles[0]
  const result = storedScanBundle(entry, { kind: 'sourcemap', size: 500, json: { sources: ['src/main.js', 'node_modules/dep/index.js'], sourcesContent: ['€', 'export {}'] } })
  assert.deepEqual(result.files.map(file => [file.path, file.bytes, file.module]), [['src/main.js', 3, '__own__'], ['node_modules/dep/index.js', 9, 'dep']])
  assert.equal(result.size, '500 B')
  assert.deepEqual(result.files.map(file => file.lines), [1, 1])
  assert.throws(() => storedScanBundle(entry, { error: 'invalid bundle' }), /invalid bundle/u)
})

test('Stasis reasons keep exact file sets even when files share the same package', () => {
  const entry = storedScanSource([{ integrity: 'test', name: 'test.stasis' }]).bundles[0]
  const result = storedScanBundle(entry, {
    kind: 'stasis', size: 1024,
    fileSizes: new Map([['src/a.js', 10], ['src/b.js', 20]]),
    lineCounts: new Map([['src/a.js', 2], ['src/b.js', 4]]),
    bundle: { modules: new Map([['.', { files: { 'src/a.js': '', 'src/b.js': '' } }]]), reason: { app: ['src/a.js'], build: ['src/b.js'] } },
  })
  assert.deepEqual(result.reasons.map(reason => [reason.id, reason.filePaths]), [['all', null], ['reason:app', ['src/a.js']], ['reason:build', ['src/b.js']]])
  assert.deepEqual(result.files.map(file => file.lines), [2, 4])
  assert.equal(result.size, '1.0 KiB')
})

test('scan LoC matches source lines for parsed bundles and cached metadata, excluding resources', () => {
  const entry = storedScanSource([{ integrity: 'lines', name: 'lines.map' }]).bundles[0]
  const result = storedScanBundle(entry, { kind: 'sourcemap', size: 500, json: {
    sources: ['crlf.js', 'lf.js', 'empty.js', 'unavailable.js'],
    sourcesContent: ['one\r\ntwo\r\n', 'three\nfour', '', null],
  } })
  assert.deepEqual(result.files.map(file => [file.path, file.lines]), [['crlf.js', 2], ['lf.js', 2], ['empty.js', 0]])
  const cached = storedScanBundle(entry, {
    kind: 'sourcemap', size: 500, metadataOnly: true,
    fileSizes: new Map([['crlf.js', 10], ['lf.js', 10], ['empty.js', 0], ['image.png', 200]]),
    lineCounts: new Map([['crlf.js', 2], ['lf.js', 2], ['empty.js', 0]]),
    json: { sources: ['crlf.js', 'lf.js', 'empty.js', 'image.png'] },
  })
  assert.deepEqual(cached.files.map(file => file.lines), [2, 2, 0, 0])
})
