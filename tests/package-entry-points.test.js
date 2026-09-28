import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_PACKAGE_BYTES, packageEntryPoints, readPackageEntryPoints } from '../server-managed/package-entry-points.ts'

test('package declarations support main, nested conditional exports, arrays, and binary maps', () => {
  assert.deepEqual(packageEntryPoints({
    main: 'index.js',
    exports: { '.': { types: './index.d.ts', import: './index.js', require: './index.cjs' }, './extra': [null, { browser: './browser.js', default: './extra.js' }], './package.json': './package.json' },
    bin: { cli: './cli.js', alias: 'cli.js', tool: './tools/run' },
  }, 'packages/app'), ['packages/app/index.js', 'packages/app/index.cjs', 'packages/app/browser.js', 'packages/app/extra.js', 'packages/app/cli.js', 'packages/app/tools/run'])
  assert.deepEqual(packageEntryPoints({ exports: './src/index.ts', bin: 'cli.js' }, ''), ['src/index.ts', 'cli.js'])
  assert.deepEqual(packageEntryPoints({ main: './src/./entry.js', bin: './src/entry.js' }, ''), ['src/entry.js'])
})

test('suggestions omit unsafe, blocked, type-only, wildcard, and invalid declarations', () => {
  for (const path of ['../outside.js', './src/../../outside.js', '/absolute.js', 'https://example.com/x.js', './src/*.js', 'C:\\file.js', './x\ny.js', '.', './dir/', 'file.js ', 'x'.repeat(501)]) {
    assert.deepEqual(packageEntryPoints({ main: path, exports: path, bin: path }, 'packages/app'), [], path)
  }
  for (const manifest of [null, [], 'text', 123, {}, { main: {}, exports: { types: './x.d.ts', 'types@>=5': './new.d.ts', './blocked': null }, bin: ['bad.js'] }]) {
    assert.deepEqual(packageEntryPoints(manifest, ''), [])
  }
  assert.deepEqual(packageEntryPoints({ exports: { './x': 'some-dependency' }, scripts: { start: 'node server.js' } }, ''), [])
  const bin = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`cmd${i}`, `bin/${i}.js`]))
  assert.equal(packageEntryPoints({ bin }, '').length, 100)
})

test('manifest reads use the listed immutable blob and ignore malformed or oversized data', async () => {
  const sha = 'b'.repeat(40)
  const bytes = Buffer.from(JSON.stringify({ main: './index.js' }))
  const blob = { encoding: 'base64', size: bytes.length, content: bytes.toString('base64') }
  const read = suffix => { assert.equal(suffix, `/git/blobs/${sha}`); return Promise.resolve(blob) }
  assert.deepEqual(await readPackageEntryPoints(sha, 'pkg', read), ['pkg/index.js'])
  for (const invalid of [null, {}, { ...blob, encoding: 'utf-8' }, { ...blob, size: MAX_PACKAGE_BYTES + 1 }, { ...blob, size: 1 }, { encoding: 'base64', size: 1, content: 'ew==' }]) {
    assert.deepEqual(await readPackageEntryPoints(sha, '', () => Promise.resolve(invalid)), [])
  }
  assert.deepEqual(await readPackageEntryPoints(sha, '', () => Promise.reject(new Error('unavailable'))), [])
})
