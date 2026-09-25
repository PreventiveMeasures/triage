import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { brotliCompressSync } from 'node:zlib'
import { Bundle } from '@exodus/stasis-core/bundle'
import './_polyfills.js'
import '../ui/client-managed.js'
import { loadManagedScanBundle, managedScanSource } from '../ui/managed/scan-source.js'
import { createBundleMetadata } from '../common/bundle-metadata.js'
import { fetchBundleMetadata } from '../ui/managed/bundle-data.js'
import { managedAppState } from '../ui/managed/state.js'

const ScanPage = customElements.get('deepview-scan-page')
const ManagedScans = customElements.get('managed-admin-scans')
const entry = { id: 'bundle/id', integrity: 'sha512-managed', filename: 'APP.MAP', repoId: 7, repoFullName: 'owner/app' }
const map = { version: 3, sources: ['src/main.js', 'node_modules/dep/index.js', 'missing.js'], sourcesContent: ['export default 1\n', '€\nnext\n', null] }
const mapMetadata = await createBundleMetadata({ integrity: entry.integrity, kind: 'sourcemap', size: Buffer.byteLength(JSON.stringify(map)), json: map })

beforeEach(() => { managedAppState.reset() })

function createPage() {
  const host = new ManagedScans()
  const view = host.render()
  const loaderIndex = view.strings.findIndex(part => part.endsWith('.loadBundle='))
  assert.notEqual(loaderIndex, -1, 'the managed host must supply a bundle loader')
  const page = new ScanPage()
  page.loadBundle = view.values[loaderIndex]
  page.source = managedScanSource({ bundles: [entry] })
  page.willUpdate(new Map([['source', null]]))
  return page
}

test('managed sourcemap loading enables each bundle scan mode with real file metadata', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const network = t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(url, '/api/bundles/bundle%2Fid/metadata', 'scan setup never requests source contents')
    assert.equal(options.credentials, 'same-origin')
    assert.equal(options.cache, 'no-store')
    assert.ok(options.signal instanceof AbortSignal)
    return Promise.resolve(Response.json(mapMetadata))
  })
  const page = createPage()
  page._runScan()
  assert.equal(page._scans.length, 0, 'unloaded metadata cannot start a scan')
  await page._loadSelectedBundle()
  assert.equal(page._bundleError, null)
  assert.equal(page._loadingBundle, false)
  assert.deepEqual(page._bundle.files.map(file => [file.path, file.bytes, file.lines, file.module]), [
    ['src/main.js', 17, 1, '__own__'], ['node_modules/dep/index.js', 9, 2, 'dep'],
  ])
  assert.equal(page._bundle.repoId, 7)
  assert.equal(page._bundle.integrity, entry.integrity)
  assert.deepEqual(page._bundle.reasons, [{ id: 'all', label: 'All', filePaths: null }])
  for (const mode of ['code', 'dependencies', 'agentic']) {
    page._mode = mode
    page._runScan()
    assert.equal(page._scans[0].mode, mode)
    assert.equal(page._scans[0].files, 2)
    assert.equal(page._scans[0].bundleId, entry.id)
  }
  assert.equal(page._scans.length, 3)
  await page._loadSelectedBundle()
  assert.equal(network.mock.callCount(), 1, 'the selected page retains its loaded inventory')
})

test('managed Stasis v0 and v1 metadata retains file statistics, formats and scopes', async (t) => {
  const sources = { 'src/main.js': 'export default 1\n', 'src/build.js': 'export default 2\n' }
  const reason = { run: ['src/main.js'], build: ['src/build.js'] }
  const snapshots = [
    JSON.stringify({ version: 0, config: { scope: 'node_modules' }, formats: {}, imports: {}, sources, reason }),
    new Bundle({ modules: new Map([['.', { name: 'app', version: '1', files: { ...sources, 'assets': '["icon.png"]', 'assets/icon.png': 'aGVsbG8=' } }]]),
      formats: new Map([['src/main.js', 'module'], ['assets', 'directory'], ['assets/icon.png', 'resource:base64']]),
      entries: new Set(['src/main.js']), reason }).serialize(),
  ]
  let metadata
  t.mock.method(globalThis, 'fetch', url => {
    assert.equal(url, '/api/bundles/bundle%2Fid/metadata')
    return Promise.resolve(Response.json(metadata))
  })
  for (const snapshot of snapshots) {
    metadata = await createBundleMetadata({ integrity: entry.integrity, kind: 'stasis', size: brotliCompressSync(snapshot).byteLength, bundle: Bundle.parse(snapshot) })
    const result = await loadManagedScanBundle({ ...entry, filename: 'app.stasis.code.br' })
    assert.equal(result.files.find(file => file.path === 'src/main.js').bytes, 17)
    assert.equal(result.files.find(file => file.path === 'src/main.js').lines, 1)
    assert.deepEqual(result.reasons.map(scope => [scope.id, scope.filePaths]), [
      ['all', null], ['reason:build', ['src/build.js']], ['reason:run', ['src/main.js']],
    ])
    assert.equal(result.files.some(file => file.path === 'assets'), false, 'directory captures are not files')
    if (result.files.some(file => file.path === 'assets/icon.png')) {
      assert.equal(result.files.find(file => file.path === 'assets/icon.png').bytes, 5)
      assert.equal(result.files.find(file => file.path === 'assets/icon.png').format, 'resource:base64')
    }
  }
})

test('managed metadata request and validation failures stay retryable without enabling scans', async (t) => {
  let response
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(response))
  const page = createPage()
  for (const failure of [new Response('', { status: 503 }), new Response('invalid JSON'), Response.json(map), Response.json({ ...mapMetadata, integrity: 'other-bundle' })]) {
    response = failure
    await page._loadSelectedBundle()
    assert.ok(page._bundleError)
    assert.equal(page._loadingBundle, false)
    assert.equal(page._bundle.files, null)
    page._runScan()
    assert.equal(page._scans.length, 0)
  }
  response = Response.json(mapMetadata)
  await page._loadSelectedBundle()
  assert.equal(page._bundleError, null)
  assert.equal(page._bundle.files.length, 2)
})

test('scan cancellation rejects late metadata without cancelling another shared consumer', async (t) => {
  const body = Promise.withResolvers()
  const network = t.mock.method(globalThis, 'fetch', () => Promise.resolve({ ok: true, json: () => body.promise }))
  await assert.rejects(loadManagedScanBundle(entry, AbortSignal.abort()), { name: 'AbortError' })
  assert.equal(network.mock.callCount(), 0)
  const controller = new AbortController()
  const loading = loadManagedScanBundle(entry, controller.signal)
  const otherConsumer = fetchBundleMetadata(entry.id)
  controller.abort()
  body.resolve(mapMetadata)
  await assert.rejects(loading, { name: 'AbortError' })
  assert.deepEqual(await otherConsumer, mapMetadata)
  assert.equal(network.mock.callCount(), 1)
  assert.deepEqual(managedAppState.read(`bundle-metadata:${entry.id}`), mapMetadata)
})

test('a session change rejects pending scan metadata and clears its shared cache', async (t) => {
  const body = Promise.withResolvers()
  t.mock.method(globalThis, 'fetch', () => Promise.resolve({ ok: true, json: () => body.promise }))
  const loading = loadManagedScanBundle(entry)
  managedAppState.reset()
  body.resolve(mapMetadata)
  await assert.rejects(loading, { name: 'AbortError' })
  assert.equal(managedAppState.read(`bundle-metadata:${entry.id}`), undefined)
})
