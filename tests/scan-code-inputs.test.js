import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import './_polyfills.js'
import { storedScanBundle, storedScanSource } from '../ui/scan/bundle-source.js'
import { codeScanFiles, sourceMetrics } from '../ui/scan/metrics.js'
import { ScanPage } from '../ui/scan/page.js'
import { bundleOptions } from '../ui/view/bundle-selector.js'
import { createBundleMetadata, parseBundleMetadata } from '../ui/view/bundle-metadata.js'

function resourceBundle() {
  return { integrity: 'sha512-scan-resources', kind: 'stasis', size: 9000, bundle: Bundle.parse(new Bundle({
    modules: new Map([
      ['.', { name: 'app', version: '1', files: { 'src/main.js': 'export default 1\n', 'assets': '["icon.svg"]', 'assets/icon.svg': '<svg/>' } }],
      ['node_modules/binary', { name: 'binary', version: '1', files: { 'looks-like-code.js': 'aGVsbG8=' } }],
    ]),
    formats: new Map([['src/main.js', 'module'], ['assets', 'directory'], ['assets/icon.svg', 'resource'], ['node_modules/binary/looks-like-code.js', 'resource:base64']]),
    entries: new Set(['src/main.js']),
    reason: { run: ['src/main.js'], assets: ['assets', 'assets/icon.svg', 'node_modules/binary/looks-like-code.js'] },
  }).serialize()) }
}

test('fresh and cached Stasis inventories preserve formats and give identical Code inputs and estimates', async () => {
  const full = resourceBundle()
  const metadata = await createBundleMetadata(full)
  const cached = parseBundleMetadata(JSON.parse(JSON.stringify(metadata)), full.integrity)
  const entry = storedScanSource([{ name: 'resources.stasis', integrity: full.integrity }]).bundles[0]
  const inventories = [full, cached].map(details => storedScanBundle(entry, details))
  for (const bundle of inventories) {
    assert.equal(bundle.files.find(file => file.path.endsWith('looks-like-code.js')).format, 'resource:base64')
    const code = codeScanFiles(bundle.files)
    assert.deepEqual(code.map(file => file.path).toSorted(), ['assets/icon.svg', 'src/main.js'])
    assert.deepEqual(sourceMetrics(code), { bytes: 23, lines: 1 })
    assert.equal(new Set(code.map(file => file.module)).size, 1)
    assert.equal(bundleOptions([{ ...bundle, files: code }])[0].secondary, '8.8 KiB · 2 files · 1 LoC')
  }
  assert.deepEqual(inventories[0].files, inventories[1].files)
})

test('Code excludes binary resources and directories before scoping, selection, and run counts', () => {
  const files = [
    { path: 'main.js', format: 'module', bytes: 10, lines: 2, module: '__own__' },
    { path: 'assets', format: 'directory', bytes: 100, lines: 5, module: 'directory-only' },
    { path: 'looks-like-code.js', format: 'resource:base64', bytes: 10000, lines: 500, module: 'binary-only' },
    { path: 'text.svg', format: 'resource', bytes: 20, lines: 0, module: '__own__' },
  ]
  const page = new ScanPage()
  page.source = { bundles: [{ id: 'one', repoId: 'repo', filename: 'one.stasis', files,
    reasons: [{ id: 'all', filePaths: null }, { id: 'binary', filePaths: ['assets', 'looks-like-code.js'] }] }] }
  page.willUpdate(new Map([['source', null]]))
  assert.deepEqual(page._files.map(file => file.path), ['text.svg', 'main.js'])
  assert.deepEqual(sourceMetrics(page._files), { bytes: 30, lines: 2 })
  page._runScan()
  assert.equal(page._scans[0].files, 2)
  page._reason = 'binary'
  assert.deepEqual(page._files, [])
  page._runScan()
  assert.equal(page._scans.length, 1, 'a resource-only scope cannot start a Code scan')
  for (const timer of page._timers) clearTimeout(timer)
  assert.equal(page._bundle.files.length, 4, 'retain the bundle inventory for other modes')
})

test('Code filtering uses format metadata, never extensions or resource text', () => {
  const files = [{ path: 'image.png', format: 'module' }, { path: 'directory' }, { path: 'resource:base64.js' },
    { path: 'script.js', format: 'resource:base64' }, { path: 'LICENSE', format: 'resource' }, { path: 'folder', format: 'directory' }]
  assert.deepEqual(codeScanFiles(files).map(file => file.path), ['image.png', 'directory', 'resource:base64.js', 'LICENSE'])
})
