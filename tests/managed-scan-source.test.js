import assert from 'node:assert/strict'
import { test } from 'node:test'
import './_polyfills.js'
import '../ui/client-managed.js'
import { ManagedAppState } from '../ui/managed/state.js'
import { managedScanSource } from '../ui/managed/scan-source.js'

const Scans = customElements.get('managed-admin-scans')
const Bundles = customElements.get('managed-admin-bundles')
const ScanPage = customElements.get('deepview-scan-page')
const catalogue = {
  repos: [{ repoId: 7, fullName: 'owner/app' }, { repoId: 8, fullName: 'owner/empty' }],
  bundles: [
    { id: 'app', filename: 'app.stasis', repoId: 7, repoFullName: 'owner/app', byteSize: 2048, kind: 'stasis' },
    { id: 'loose', filename: 'loose.map', repoId: null, repoFullName: null, byteSize: 1024, kind: 'sourcemaps' },
    { id: 'inactive', filename: 'inactive.stasis', repoId: 9, repoFullName: 'owner/inactive', byteSize: 4096 },
  ],
}

function createPage(Page, appState) {
  const page = new Page()
  page.appState = appState
  return page
}

test('scan choices use managed identities, assignments, sizes, and empty repositories', () => {
  const source = managedScanSource(catalogue)
  assert.deepEqual(source.repositories, [
    { id: 7, label: 'owner/app' }, { id: 8, label: 'owner/empty' },
    { id: 'unattached', label: 'Unattached' }, { id: 9, label: 'owner/inactive' },
  ])
  assert.deepEqual(source.bundles.map(bundle => [bundle.id, bundle.repoId, bundle.repo, bundle.size, bundle.files, bundle.reasons]), [
    ['app', 7, 'owner/app', '2.0 KiB', null, []],
    ['loose', 'unattached', 'Unattached', '1.0 KiB', null, []],
    ['inactive', 9, 'owner/inactive', '4.0 KiB', null, []],
  ])
  assert.equal(source.bundles[1].kind, 'sourcemaps')
  assert.deepEqual(source.scans, [])
  assert.equal(catalogue.bundles[1].repoId, null, 'adapting choices does not mutate shared data')
  assert.deepEqual(managedScanSource({ bundles: [], repos: [] }), { repositories: [], bundles: [], scans: [] })
})

test('Scans immediately reuses the Bundles cache and shares its background refresh', async (t) => {
  const appState = new ManagedAppState()
  const library = createPage(Bundles, appState)
  let response = () => Promise.resolve(Response.json(catalogue))
  const network = t.mock.method(globalThis, 'fetch', (url) => {
    assert.equal(url, '/api/admin/bundles', 'managers do not need the admin-only repository endpoint')
    return response()
  })
  await library._load()
  let complete
  response = () => new Promise(resolve => { complete = resolve })
  const scan = createPage(Scans, appState)
  const loads = [scan._load(), library._load()]
  assert.deepEqual(scan._source, managedScanSource(catalogue), 'cached choices are available before the refresh finishes')
  assert.equal(network.mock.callCount(), 2, 'both pages share one refresh after the original catalogue load')
  const updated = { repos: catalogue.repos, bundles: [catalogue.bundles[1]] }
  complete(Response.json(updated))
  await Promise.all(loads)
  assert.deepEqual(scan._source, managedScanSource(updated))
  assert.deepEqual(library._data, updated)
})

test('failed refresh keeps scan choices, while an initial failure can be retried', async (t) => {
  const notices = []
  const appState = new ManagedAppState(message => notices.push(message))
  const scan = createPage(Scans, appState)
  let response = new Response('', { status: 503 })
  t.mock.method(globalThis, 'fetch', () => Promise.resolve(response))
  await scan._load()
  assert.equal(scan._source, null)
  assert.match(scan._error, /503/u)
  response = Response.json(catalogue)
  await scan._load()
  assert.equal(scan._error, null)
  response = new Response('', { status: 503 })
  await scan._load()
  assert.deepEqual(scan._source, managedScanSource(catalogue))
  assert.equal(scan._error, null)
  assert.equal(notices.length, 2)
})

test('bundle reassignment refreshes the shared scan catalogue without retaining old assignments', async (t) => {
  const appState = new ManagedAppState()
  await appState.load('bundles', 'bundles', () => catalogue)
  const moved = { repos: catalogue.repos, bundles: [{ ...catalogue.bundles[0], repoId: 8, repoFullName: 'owner/empty' }] }
  t.mock.method(globalThis, 'fetch', (_url, options) => Promise.resolve(Response.json(options.method === 'POST' ? {} : moved)))
  await createPage(Bundles, appState)._setRepo(catalogue.bundles[0], 8)
  const scan = createPage(Scans, appState)
  const loading = scan._load()
  assert.deepEqual(scan._source, managedScanSource(moved))
  await loading
})

test('a scan page that navigates away cannot apply a late catalogue response', async (t) => {
  const appState = new ManagedAppState()
  const scan = createPage(Scans, appState)
  let complete
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { complete = resolve }))
  const loading = scan._load()
  scan.disconnectedCallback()
  complete(Response.json(catalogue))
  await loading
  assert.equal(scan._source, null)
  assert.deepEqual(appState.read('bundles'), catalogue, 'the shared result is still ready for the next visit')
})

test('catalogue refresh preserves empty repository selection and follows bundle reassignment', () => {
  const page = new ScanPage()
  page.source = managedScanSource(catalogue)
  page.willUpdate(new Map([['source', null]]))
  assert.equal(page._selectedBundleId, 'app')
  page._selectRepoById(8)
  const old = page.source
  page.source = managedScanSource(catalogue)
  page.willUpdate(new Map([['source', old]]))
  assert.equal(page._selectedRepoId, 8)
  assert.equal(page._selectedBundleId, null)
  page._selectRepoById(7)
  page.source = managedScanSource({ repos: catalogue.repos, bundles: [{ ...catalogue.bundles[0], repoId: 8 }] })
  page.willUpdate(new Map([['source', old]]))
  assert.equal(page._selectedRepoId, 8)
  assert.equal(page._selectedBundleId, 'app')
})
