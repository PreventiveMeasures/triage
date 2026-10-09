import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { bundleFileSizes, bundleSourcesAsMap } from '../common/bundle-sources.js'
import { managedRoutePath } from '../common/managed/routes.js'
import { createManagedHistory } from '../ui/view/managed-history.js'
import { beginViewNavigation } from '../ui/view/view-navigation.js'
import { browserAt } from './_managed-browser.js'

const state = {}
const requests = []
let answer = null
mock.module('../client/index.js', { exports: {
  state, isManagedUiMode: () => true, ensureBundleFindingsIndexed() {}, hasBundleFileHashes() {},
  readBundle() {}, readBundleIndex() {}, recordBundleFileHashes() {}, saveBundleIndex() {},
} })
mock.module('../ui/view/render.js', { exports: { render() {} } })
mock.module('../ui/view/graph/state.js', { exports: { cleanupGraph2() {}, graph2: {} } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchNpmPackage(name, version) { requests.push([name, version]); return answer(name, version) },
  fetchNpmVersions() { return Promise.resolve({ versions: [] }) },
  fetchBundleContents() {}, fetchBundleMetadata() {},
} })
const { npmPackageDetails, npmPackageEntries, npmPackageEntry, npmPackageRoute, openNpmRoute, parseNpmPackageInput } = await import('../ui/view/npm-package.js')

const data = {
  name: '@scope/pkg', version: '1.2.3', private: true, integrity: 'sha512-pkg', tarballSize: 99,
  manifest: { main: './lib/index', description: 'A package' },
  files: [['README.md', 6, '# pkg\n'], ['lib/index.js', 10, 'module.x=1'], ['logo.png', 4, null], ['package.json', 2, '{}']],
}

beforeEach(() => {
  beginViewNavigation()
  requests.length = 0
  answer = () => Promise.resolve(data)
  Object.assign(state, { currentView: 'findings', bundles: [], bundleDetails: null, selectedBundle: null, bundleDetailsTab: 'overview',
    bundleSourceFile: null, bundleCodeFileRequest: null, npmLookup: { input: '', pending: false, error: null }, reports: [], currentManagedTeam: 'team' })
  globalThis.document = { body: { classList: { remove() {} } }, querySelector: () => null }
})

test('package input takes a name, a version or tag, or an npmjs.com link', () => {
  assert.deepEqual(parseNpmPackageInput(' lodash '), { name: 'lodash', spec: null })
  assert.deepEqual(parseNpmPackageInput('lodash@4.17.21'), { name: 'lodash', spec: '4.17.21' })
  assert.deepEqual(parseNpmPackageInput('@babel/core@next'), { name: '@babel/core', spec: 'next' })
  assert.deepEqual(parseNpmPackageInput('@babel/core'), { name: '@babel/core', spec: null })
  assert.deepEqual(parseNpmPackageInput('https://www.npmjs.com/package/@babel/core/v/7.24.0'), { name: '@babel/core', spec: '7.24.0' })
  assert.deepEqual(parseNpmPackageInput('https://npmjs.com/package/lodash?activeTab=code'), { name: 'lodash', spec: null })
  for (const bad of ['', '@babel', 'lodash@^4', 'a b', '../x', 'https://example.com/package/lodash', null]) assert.equal(parseNpmPackageInput(bad), null, String(bad))
})

test('Code opens on what main names, resolved as require would', () => {
  const paths = ['index.js', 'lib/index.js', 'lib/util.cjs', 'esm/index.mjs']
  assert.deepEqual(npmPackageEntries({ main: './lib/index' }, paths), ['lib/index.js', 'index.js'])
  assert.deepEqual(npmPackageEntries({ main: 'lib/util', module: 'esm/index.mjs' }, paths), ['lib/util.cjs', 'esm/index.mjs', 'index.js'])
  assert.deepEqual(npmPackageEntries({ main: 'lib/' }, paths), ['lib/index.js', 'index.js'])
  assert.deepEqual(npmPackageEntries({}, ['a.js']), [])
})

test('a version shows as a bundle of its files, sized by their bytes, text alone as source', () => {
  const entry = npmPackageEntry(data)
  assert.deepEqual(entry, { integrity: 'sha512-pkg', kind: 'sourcemap', name: '@scope/pkg@1.2.3', size: 99,
    npm: { name: '@scope/pkg', version: '1.2.3', private: true, manifest: data.manifest } })
  assert.equal(entry.managedId, undefined, 'never read through the bundle routes')
  const details = npmPackageDetails(entry, data)
  assert.deepEqual([...bundleSourcesAsMap(details).keys()], ['README.md', 'lib/index.js', 'package.json'])
  assert.deepEqual([...bundleFileSizes(details)], [['README.md', 6], ['lib/index.js', 10], ['logo.png', 4], ['package.json', 2]])
  assert.deepEqual(details.npmEntries, ['lib/index.js'])
  assert.deepEqual(npmPackageRoute(entry, 'code', { file: 2, line: 3 }),
    { view: 'npm', packageName: '@scope/pkg', packageSpec: '1.2.3', bundleTab: 'code', file: 2, line: 3 })
  assert.equal(npmPackageRoute({ integrity: 'x' }), null)
})

test('opening a version shows it in the bundle view, and its route names the exact version', async () => {
  const rendered = []
  const route = await openNpmRoute({ view: 'npm', packageName: '@scope/pkg', packageSpec: null, bundleTab: 'code', file: 2, line: 4 }, () => true, () => rendered.push(state.currentView))
  assert.deepEqual(requests, [['@scope/pkg', 'latest']])
  assert.equal(state.currentView, 'bundles')
  assert.equal(state.selectedBundle, 'sha512-pkg')
  assert.equal(state.bundleDetailsTab, 'code')
  assert.deepEqual(state.bundleCodeFileRequest, { bundle: 'sha512-pkg', file: 2, line: 4 })
  assert.equal(state.currentManagedTeam, null)
  assert.equal(state.bundles[0].npm.version, '1.2.3')
  assert.equal(managedRoutePath(route), '/npm/@scope/pkg@1.2.3/code/2#L4')
  assert.deepEqual(rendered, ['npm', 'bundles'], 'the lookup page says what opens meanwhile')
  // Another tab of the version shown keeps it, without asking again.
  const details = state.bundleDetails
  const overview = await openNpmRoute({ view: 'npm', packageName: '@scope/pkg', packageSpec: '1.2.3', bundleTab: 'overview' }, () => true, () => {})
  assert.equal(requests.length, 1)
  assert.equal(state.bundleDetails, details)
  assert.equal(managedRoutePath(overview), '/npm/@scope/pkg@1.2.3')
})

test('a version that fails to open leaves the lookup page saying why', async () => {
  answer = () => Promise.reject(Object.assign(new Error('No such package version, or it is not available to you.'), { status: 404 }))
  const route = await openNpmRoute({ view: 'npm', packageName: 'missing', packageSpec: '1.0.0', bundleTab: 'overview' }, () => true, () => {})
  assert.deepEqual(route, { view: 'npm' })
  assert.equal(state.currentView, 'npm')
  assert.deepEqual(state.npmLookup, { input: 'missing@1.0.0', pending: false, error: 'No such package version, or it is not available to you.' })
  // A navigation that moved on meanwhile takes nothing over.
  state.currentView = 'findings'
  assert.equal(await openNpmRoute({ view: 'npm', packageName: 'missing', bundleTab: 'overview' }, () => false, () => {}), false)
  assert.equal(state.currentView, 'npm', 'only the lookup page it showed while loading')
  answer = () => Promise.reject(new DOMException('Managed session changed', 'AbortError'))
  assert.equal(await openNpmRoute({ view: 'npm', packageName: 'missing', bundleTab: 'overview' }, () => true, () => {}), false)
})

test('the lookup page keeps what it was last asked for', async () => {
  state.npmLookup = { input: 'lodash', pending: false, error: 'old' }
  assert.deepEqual(await openNpmRoute({ view: 'npm' }, () => true, () => {}), { view: 'npm' })
  assert.equal(state.currentView, 'npm')
  assert.deepEqual(state.npmLookup, { input: 'lodash', pending: false, error: null })
})

test('history commits a dist-tag link at the version it opened', async () => {
  const { browser, entries } = browserAt('/npm/@scope/pkg/code')
  const nav = createManagedHistory(browser)
  await nav.start((route, isCurrent) => route.view === 'npm' ? openNpmRoute(route, isCurrent, () => {}) : true)
  assert.equal(browser.location.pathname, '/npm/@scope/pkg@1.2.3/code')
  await nav.navigate({ view: 'npm' })
  assert.equal(browser.location.pathname, '/npm')
  await browser.move(-1)
  assert.equal(browser.location.pathname, '/npm/@scope/pkg@1.2.3/code')
  assert.equal(requests.length, 2, 'a page left for the lookup opens its version again')
  assert.equal(entries.length, 2)
})
