import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { beforeEach, mock, test } from 'node:test'
import { bundleFileSizes, bundleSourcesAsMap } from '../common/bundle-sources.js'
import { managedRoutePath } from '../common/managed/routes.js'
import { createManagedHistory } from '../ui/view/managed-history.js'
import { beginViewNavigation } from '../ui/view/view-navigation.js'
import { browserAt } from './_managed-browser.js'

const state = {}
const renders = [], requests = [], versionRequests = []
let answer = null, versionsAnswer = () => Promise.resolve({ versions: [] })
mock.module('../client/index.js', { exports: {
  state, isManagedUiMode: () => true, ensureBundleFindingsIndexed() {}, hasBundleFileHashes() {},
  readBundle() {}, readBundleIndex() {}, recordBundleFileHashes() {}, saveBundleIndex() {},
} })
mock.module('../ui/view/render.js', { exports: { render() { renders.push(Date.now()) } } })
mock.module('../ui/view/graph/state.js', { exports: { cleanupGraph2() {}, graph2: {} } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchNpmPackage(name, version) { requests.push([name, version]); return answer(name, version) },
  fetchNpmVersions(name) { versionRequests.push(name); return versionsAnswer(name) },
  fetchBundleContents() {}, fetchBundleMetadata() {},
} })
const { npmCompareSource, npmDependencies, npmDependencyChanges, npmPackageDetails, npmPackageEntries, npmPackageEntry, npmPackageRoute, npmVersionList, openNpmRoute, parseNpmPackageInput } = await import('../ui/view/npm-package.js')

const data = {
  name: '@scope/pkg', version: '1.2.3', private: false, integrity: 'sha512-pkg', tarballSize: 99,
  manifest: { main: './lib/index', description: 'A package' },
  files: [['README.md', 6, '# pkg\n'], ['lib/index.js', 10, 'module.x=1'], ['logo.png', 4, null], ['package.json', 2, '{}']],
}

let session = 0
beforeEach(() => {
  beginViewNavigation()
  requests.length = 0
  versionRequests.length = 0
  answer = () => Promise.resolve(data)
  versionsAnswer = () => Promise.resolve({ versions: [] })
  // A session of its own each, so nothing kept from another test answers.
  state.managedSession = { id: `session-${++session}`, role: 'view' }
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

test('Dependencies list every kind by name, and an alias opens the package it names', () => {
  assert.deepEqual(npmDependencies({
    dependencies: { zod: '^3.0.0', alias: 'npm:@scope/real@^1.0.0', bare: 'npm:other', local: 'file:../x' },
    peerDependencies: { react: '>=18', zod: '^3.0.0' },
    optionalDependencies: { fsevents: '^2.0.0' },
  }), [
    { name: 'alias', range: 'npm:@scope/real@^1.0.0', kind: null, opens: '@scope/real' },
    { name: 'bare', range: 'npm:other', kind: null, opens: 'other' },
    { name: 'fsevents', range: '^2.0.0', kind: 'optional', opens: 'fsevents' },
    { name: 'local', range: 'file:../x', kind: null, opens: 'local' },
    { name: 'react', range: '>=18', kind: 'peer', opens: 'react' },
    { name: 'zod', range: '^3.0.0', kind: null, opens: 'zod' },
    { name: 'zod', range: '^3.0.0', kind: 'peer', opens: 'zod' },
  ])
  assert.deepEqual(npmDependencies({}), [])
})

test('two versions differ in the dependencies they name and the ranges they ask for', () => {
  assert.deepEqual(npmDependencyChanges(
    { dependencies: { kept: '^1.0.0', moved: '^1.0.0', gone: '^1.0.0' }, peerDependencies: { react: '>=17' } },
    { dependencies: { kept: '^1.0.0', moved: '^2.0.0', fresh: '^1.0.0' }, peerDependencies: { react: '>=18' }, optionalDependencies: { gone: '^1.0.0' } },
  ), {
    removed: [{ key: '\0gone', name: 'gone', kind: null, range: '^1.0.0' }],
    added: [{ key: '\0fresh', name: 'fresh', kind: null, range: '^1.0.0' }, { key: 'optional\0gone', name: 'gone', kind: 'optional', range: '^1.0.0' }],
    changed: [{ key: '\0moved', name: 'moved', kind: null, from: '^1.0.0', to: '^2.0.0' }, { key: 'peer\0react', name: 'react', kind: 'peer', from: '>=17', to: '>=18' }],
  })
})

test('Compare offers the package\'s other versions, read once a session, and loads them as versions', async () => {
  let release
  versionsAnswer = () => new Promise(resolve => { release = () => resolve({ versions: ['1.2.3', '1.2.2', '1.0.0'], distTags: { latest: '1.2.3', old: '1.0.0', gone: '9.9.9' } }) })
  const entry = npmPackageEntry(data)
  const pending = npmCompareSource(entry)
  assert.equal(pending.pending, true)
  assert.deepEqual(pending.options, [])
  assert.deepEqual(pending.choices.map(choice => choice.id), ['1.2.3'], 'its own side offers the version shown meanwhile')
  npmCompareSource(entry)
  assert.deepEqual(versionRequests, ['@scope/pkg'], 'one listing while it loads')
  release()
  await setImmediate()
  const source = npmCompareSource(entry)
  assert.equal(source.pending, false)
  assert.deepEqual(source.options, [
    { id: '1.2.2', name: '@scope/pkg@1.2.2', format: 'npm', detail: '' },
    { id: '1.0.0', name: '@scope/pkg@1.0.0', format: 'npm', detail: 'old' },
  ], 'newest first, the version shown left out')
  assert.deepEqual(source.choices.map(choice => [choice.id, choice.detail]), [['1.2.3', 'latest'], ['1.2.2', ''], ['1.0.0', 'old']],
    'its own side offers every version, its own among them')
  assert.equal(source.name('sha512-pkg'), '@scope/pkg@1.2.3')
  assert.equal(source.name('1.0.0'), '@scope/pkg@1.0.0')
  answer = (name, version) => Promise.resolve({ ...data, version, integrity: `sha512-${version}` })
  const other = await source.load('1.0.0')
  assert.equal(other.integrity, 'sha512-1.0.0')
  assert.equal(await source.load('1.0.0').then(details => details === other), true, 'kept for the session')
  assert.deepEqual(requests, [['@scope/pkg', '1.0.0']])
  assert.deepEqual(source.dependencies(npmPackageDetails(entry, data), other), { removed: [], added: [], changed: [] })
  // A new session or role lists and loads afresh.
  state.managedSession = { ...state.managedSession, role: 'triage' }
  assert.equal(npmVersionList('@scope/pkg').status, 'loading')
  await source.load('1.0.0')
  assert.equal(requests.length, 2)
})

test('a version that fails to list says so, without a picker of nothing, and is asked again later, on a repaint due then', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 })
  versionsAnswer = () => Promise.reject(new Error('down'))
  npmVersionList('@scope/pkg')
  await setImmediate()
  const source = npmCompareSource(npmPackageEntry(data))
  assert.equal(source.error, "Couldn't list the versions of @scope/pkg.")
  assert.deepEqual(source.options, [])
  renders.length = 0
  t.mock.timers.tick(9_999)
  assert.equal(npmVersionList('@scope/pkg').status, 'error', 'not on every render')
  assert.equal(versionRequests.length, 1)
  assert.deepEqual(renders, [])
  t.mock.timers.tick(1)
  assert.deepEqual(renders, [1_010_000], 'a page left open repaints when the retry is due')
  assert.equal(npmVersionList('@scope/pkg').status, 'loading')
  await setImmediate()
  // Failing again, it waits twice as long.
  renders.length = 0
  t.mock.timers.tick(19_999)
  assert.deepEqual(renders, [])
  assert.equal(npmVersionList('@scope/pkg').status, 'error')
  versionsAnswer = () => Promise.resolve({ versions: ['1.2.3', '1.0.0'] })
  t.mock.timers.tick(1)
  assert.equal(renders.length, 1)
  assert.equal(npmVersionList('@scope/pkg').status, 'loading')
  await setImmediate()
  assert.deepEqual(npmCompareSource(npmPackageEntry(data)).options.map(option => option.id), ['1.0.0'])
  assert.equal(versionRequests.length, 3)
})

test('a Compare link opens the version with the one it compares with', async () => {
  const route = await openNpmRoute({ view: 'npm', packageName: '@scope/pkg', packageSpec: '1.2.3', bundleTab: 'compare', compareSpec: '1.0.0', compareMode: 'code' }, () => true, () => {})
  assert.deepEqual(state.bundleCompare, { bundle: 'sha512-pkg', target: '1.0.0', mode: 'code' })
  assert.equal(managedRoutePath(route), '/npm/@scope/pkg@1.2.3/compare/1.0.0/code')
  const treemap = await openNpmRoute({ view: 'npm', packageName: '@scope/pkg', packageSpec: '1.2.3', bundleTab: 'treemap' }, () => true, () => {})
  assert.equal(managedRoutePath(treemap), '/npm/@scope/pkg@1.2.3/treemap')
  assert.equal(state.bundleCompare, null)
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
    npm: { name: '@scope/pkg', version: '1.2.3', private: false, manifest: data.manifest } })
  assert.equal(entry.managedId, undefined, 'never read through the bundle routes')
  const details = npmPackageDetails(entry, data)
  assert.deepEqual([...bundleSourcesAsMap(details).keys()], ['README.md', 'lib/index.js', 'package.json'])
  assert.deepEqual([...bundleFileSizes(details)], [['README.md', 6], ['lib/index.js', 10], ['logo.png', 4], ['package.json', 2]])
  const withDigest = npmPackageDetails(entry, { ...data, files: [['logo.png', 4, null, 'sha256-x'], ['old.png', 2, null]] })
  assert.deepEqual([...withDigest.npmBinaries], [['logo.png', { size: 4, digest: 'sha256-x' }]], 'a binary with no digest has nothing to compare by')
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
  assert.equal(requests.length, 1, 'a version read in this session opens again without asking')
  assert.equal(entries.length, 2)
})

test('a private version is asked for each time it opens, as access may be lost meanwhile', async () => {
  answer = () => Promise.resolve({ ...data, private: true })
  const { browser } = browserAt('/npm/@scope/pkg@1.2.3')
  const nav = createManagedHistory(browser)
  await nav.start((route, isCurrent) => route.view === 'npm' ? openNpmRoute(route, isCurrent, () => {}) : true)
  assert.equal(state.bundles[0].npm.private, true)
  await nav.navigate({ view: 'npm' })
  // The team listing its scope dropped the reader since.
  answer = () => Promise.reject(Object.assign(new Error('No such package version, or it is not available to you.'), { status: 404 }))
  await browser.move(-1)
  assert.equal(requests.length, 2)
  assert.equal(state.currentView, 'npm')
  assert.equal(state.npmLookup.error, 'No such package version, or it is not available to you.')
})
