import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import { Bundle } from '@exodus/stasis-core/bundle'
import { bundleSourcesAsMap } from '../common/bundle-sources.js'

// Exercise the Code view's initial selection and later indexing updates.
const findingsByHash = new Map()
const findingIndex = await import('../client/bundle-finding-index.js')
mock.module('../client/bundle-finding-index.js', { exports: {
  ...findingIndex,
  findingsForFileHash: hash => findingsByHash.get(hash) ?? [],
} })
mock.module('../ui/view/render.js', { exports: { render() {} } })
mock.module('../ui/view/dom.js', { exports: { report: null } })
mock.module('../ui/view/scan-navigation.js', { exports: { canScanBundle: () => false, openScan() {} } })
mock.module('../ui/view/ingest.js', { exports: { bundleKind: () => null } })
mock.module('../ui/view/tooltip.js', { exports: { hideTooltip() {}, installShadowTooltipListener() {}, showTooltip() {} } })
// Dialogs have separate tests; keep their browser-only dependencies out of source selection.
mock.module('../ui/view/lazy-dialogs.js', { exports: { ...await import('../ui/view/lazy-dialogs.js'),
  openAdvisoryDetailsDialog() {}, openNpmCompareAdvisoriesDialog() {}, openWhyDialog() {} } })
mock.module('../ui/view/prism-highlight.js', { exports: { langForPath: () => null, langForTag: () => null, highlight: () => Promise.resolve(null) } })
const { state } = await import('../client/state.ts')
const { renderBundlesList } = await import('../ui/view/render-bundle.js')
globalThis.document = { querySelector: () => null }

let bundleId = 0
beforeEach(() => {
  findingsByHash.clear()
  state.currentView = 'bundles'
  state.bundleDetailsTab = 'code'
  state.bundleSourceFile = null
  state.bundleSourceFindingIdx = null
  state.bundleDetails = null
  state.bundleCodeSearchMode = 'files'
  state.bundleCodeSearchQuery = ''
  state.triage = new Map()
})

function stasis(own, dep, entries = []) {
  return { kind: 'stasis', bundle: new Bundle({
    entries: new Set(entries),
    modules: new Map([
      ['.', { name: 'app', version: '1', files: own }],
      ['node_modules/dep', { name: 'dep', version: '1', files: dep }],
    ]),
  }) }
}

function findings(file, severities) {
  findingsByHash.set(`hash:${file}`, severities.map((severity, i) => ({
    id: `${file}:${i}`, file, fileHash: `hash:${file}`, severity, line: 1, description: 'Test finding',
  })))
}

function openBundle(fields) {
  const integrity = `sha512-code-${++bundleId}`
  const entry = { name: 'test.bundle', integrity }
  state.bundles = [entry]
  state.selectedBundle = integrity
  state.bundleDetails = { ...fields, integrity, size: 123,
    fileHashes: new Map([...bundleSourcesAsMap(fields).keys()].map(file => [file, `hash:${file}`])),
  }
  const render = () => renderBundlesList([entry])
  render()
  return render
}

test('findings never pick the file shown, nor change it as they arrive', () => {
  findings('src/issue.js', ['critical'])
  const render = openBundle(stasis({ 'src/main.js': 'entry', 'src/issue.js': 'issue' }, { 'index.js': 'dep' }, ['src/main.js']))
  assert.equal(state.bundleSourceFile, 'src/main.js')
  findings('src/main.js', ['low'])
  findings('src/other.js', ['high'])
  render()
  assert.equal(state.bundleSourceFile, 'src/main.js')
})

test('a bundle opens its first entry point, else its top-most package.json outside its dependencies, the first in path order among those as high', () => {
  // app/…, app/package.json, node_modules/…, packages/…/…, and no file at its root.
  const workspace = entries => ({ kind: 'stasis', bundle: new Bundle({
    entries: new Set(entries),
    modules: new Map([
      ['app', { name: 'app', version: '1', files: { 'package.json': '{}', 'src/index.js': 'entry', 'src/large.js': 'x'.repeat(100) } }],
      ['packages/shared', { name: 'shared', version: '1', files: { 'package.json': '{}', 'index.js': 'shared' } }],
      ['node_modules/dep', { name: 'dep', version: '1', files: { 'package.json': '{}', 'index.js': 'dep' } }],
    ]),
  }) })
  openBundle(workspace(['app/src/index.js']))
  assert.equal(state.bundleSourceFile, 'app/src/index.js', 'its entry point first')
  state.bundleSourceFile = null
  openBundle(workspace([]))
  assert.equal(state.bundleSourceFile, 'app/package.json')
  state.bundleSourceFile = null
  openBundle(stasis({ 'package.json': '{}', 'app/package.json': '{}', 'src/main.js': 'x'.repeat(100) }, { 'package.json': '{}' }))
  assert.equal(state.bundleSourceFile, 'package.json', 'its root\'s, where it has one')
  state.bundleSourceFile = null
  openBundle(stasis({ 'web/package.json': '{}', 'api/package.json': '{}', 'src/main.js': 'x'.repeat(100) }, {}))
  assert.equal(state.bundleSourceFile, 'api/package.json')
})

test('a dependency\'s package.json is never the default, nor in a flat capture', () => {
  openBundle(stasis({ 'src/main.js': 'x'.repeat(100), 'node_modules/dep/package.json': '{}', 'node_modules/dep/index.js': 'dep' }, {}))
  assert.equal(state.bundleSourceFile, 'src/main.js')
  state.bundleSourceFile = null
  openBundle(stasis({}, { 'package.json': '{}', 'entry.js': 'entry', 'large.js': 'x'.repeat(100) }, ['node_modules/dep/entry.js']))
  assert.equal(state.bundleSourceFile, 'node_modules/dep/entry.js', 'a dependency-only bundle\'s entry point')
  state.bundleSourceFile = null
  openBundle(stasis({}, { 'package.json': '{}', 'small.js': 'small', 'large.js': 'x'.repeat(100) }))
  assert.equal(state.bundleSourceFile, 'node_modules/dep/large.js', 'else its largest file')
})

test('without a package.json, Stasis selects the first entry point, else the largest own file within recorded own-package boundaries', () => {
  openBundle(stasis({ 'src/z.js': 'entry', 'src/a.js': 'other entry', 'src/large.js': 'x'.repeat(100) },
    { 'index.js': 'x'.repeat(1000) }, ['src/z.js', 'src/a.js']))
  assert.equal(state.bundleSourceFile, 'src/z.js')
  state.bundleSourceFile = null
  openBundle(stasis({ 'dependencies/internal.js': 'x'.repeat(200), 'src/large.js': 'x'.repeat(100) }, { 'index.js': 'x'.repeat(1000) }))
  assert.equal(state.bundleSourceFile, 'dependencies/internal.js', 'an app\'s own dependencies/ folder is its own')
})

test('an npm version opens its main, else its largest file rather than its package.json', () => {
  const version = npmEntries => ({ kind: 'sourcemap', npmEntries, json: {
    version: 3, sources: ['package.json', 'lib/index.js', 'lib/large.js'], sourcesContent: ['{}', 'main', 'x'.repeat(100)],
  } })
  openBundle(version(['lib/index.js']))
  assert.equal(state.bundleSourceFile, 'lib/index.js')
  state.bundleSourceFile = null
  openBundle(version([]))
  assert.equal(state.bundleSourceFile, 'lib/large.js')
})

test('a file open in the last bundle opens where this one has the same path, or the usual pick does', () => {
  for (const [carried, opened] of [['node_modules/dep/index.js', 'node_modules/dep/index.js'], ['src/gone.js', 'src/main.js']]) {
    state.bundleSourceFile = null
    state.bundleCodeFileRequest = { bundle: `sha512-code-${bundleId + 1}`, path: carried }
    openBundle(stasis({ 'src/main.js': 'own' }, { 'index.js': 'dep' }, ['src/main.js']))
    assert.equal(state.bundleSourceFile, opened)
    assert.equal(state.bundleCodeFileRequest, null)
  }
})

test('findings arriving after a manual selection keep the selected file', () => {
  const render = openBundle(stasis({ 'src/entry.js': 'entry', 'src/issue.js': 'issue' }, { 'index.js': 'dep' }, ['src/entry.js']))
  state.bundleSourceFile = 'node_modules/dep/index.js'
  findings('src/issue.js', ['high'])
  render()
  assert.equal(state.bundleSourceFile, 'node_modules/dep/index.js')
})

test('sourcemaps open their top-most package.json outside node_modules, else their largest source', () => {
  findings('src/main.js', ['critical'])
  openBundle({ kind: 'sourcemap', json: {
    version: 3, sources: ['src/main.js', 'node_modules/dep/index.js'], sourcesContent: ['own', 'x'.repeat(100)],
  } })
  assert.equal(state.bundleSourceFile, 'node_modules/dep/index.js')
  state.bundleSourceFile = null
  openBundle({ kind: 'sourcemap', json: {
    version: 3, sources: ['webpack:///./package.json', 'webpack:///./node_modules/dep/package.json', 'webpack:///./src/main.js'], sourcesContent: ['{}', '{}', 'x'.repeat(100)],
  } })
  assert.equal(state.bundleSourceFile, 'webpack:///./package.json')
})
