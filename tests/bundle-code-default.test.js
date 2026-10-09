import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import '../ui/view/frontend-install.js'
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
mock.module('../ui/view/tooltip.js', { exports: { hideTooltip() {}, showTooltip() {} } })
// Dialogs have separate tests; keep their browser-only dependencies out of source selection.
mock.module('../ui/view/dialogs/advisory-details-dialog.js', { exports: { openAdvisoryDetailsDialog() {} } })
mock.module('../ui/view/dialogs/why-dialog.js', { exports: { openWhyDialog() {} } })
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

test('Stasis opens an own file with issues even when a dependency has worse issues', () => {
  findings('src/main.js', ['low'])
  findings('node_modules/dep/index.js', ['critical', 'critical'])
  openBundle(stasis({ 'src/main.js': 'own' }, { 'index.js': 'dep' }, ['src/main.js']))
  assert.equal(state.bundleSourceFile, 'src/main.js')
})

test('Stasis selects the first entry point when only dependencies have issues', () => {
  findings('node_modules/dep/index.js', ['critical'])
  openBundle(stasis({ 'src/z.js': 'entry', 'src/a.js': 'other entry', 'src/large.js': 'x'.repeat(100) },
    { 'index.js': 'x'.repeat(1000) }, ['src/z.js', 'src/a.js']))
  assert.equal(state.bundleSourceFile, 'src/z.js')
})

test('named app and workspace modules are own source even without a dot-root module', () => {
  findings('app/src/issue.js', ['low'])
  findings('packages/shared/index.js', ['high'])
  findings('app/node_modules/dep/index.js', ['critical'])
  const render = openBundle({ kind: 'stasis', bundle: new Bundle({
    entries: new Set(['app/src/entry.js']),
    modules: new Map([
      ['app', { name: 'app', version: '1', files: { 'src/entry.js': 'entry', 'src/issue.js': 'issue' } }],
      ['packages/shared', { name: 'shared', version: '1', files: { 'index.js': 'shared' } }],
      ['app/node_modules/dep', { name: 'dep', version: '1', files: { 'index.js': 'dep' } }],
    ]),
  }) })
  assert.equal(state.bundleSourceFile, 'packages/shared/index.js')
  findingsByHash.delete('hash:packages/shared/index.js')
  state.bundleSourceFile = null
  render()
  assert.equal(state.bundleSourceFile, 'app/src/issue.js')
  findingsByHash.delete('hash:app/src/issue.js')
  state.bundleSourceFile = null
  render()
  assert.equal(state.bundleSourceFile, 'app/src/entry.js')
  findings('app/src/issue.js', ['low'])
  render()
  assert.equal(state.bundleSourceFile, 'app/src/issue.js')
})

test('node_modules files in a flat root capture are still dependencies', () => {
  findings('node_modules/dep/index.js', ['critical'])
  openBundle(stasis({ 'src/main.js': 'own', 'node_modules/dep/index.js': 'dep' }, {}, ['src/main.js']))
  assert.equal(state.bundleSourceFile, 'src/main.js')
})

test('Stasis preserves severity, count, and path ordering among own files', () => {
  findings('src/high.js', ['high'])
  findings('src/a.js', ['low', 'low'])
  findings('src/b.js', ['low', 'low'])
  findings('node_modules/dep/index.js', ['critical'])
  const render = openBundle(stasis({ 'src/high.js': 'high', 'src/a.js': 'a', 'src/b.js': 'b' }, { 'index.js': 'dep' }))
  assert.equal(state.bundleSourceFile, 'src/high.js')
  findingsByHash.delete('hash:src/high.js')
  state.bundleSourceFile = null
  render()
  assert.equal(state.bundleSourceFile, 'src/a.js')
})

test('Stasis respects recorded own-package boundaries and falls back to the largest own file without entries', () => {
  findings('dependencies/internal.js', ['low'])
  findings('node_modules/dep/index.js', ['critical'])
  const render = openBundle(stasis({ 'dependencies/internal.js': 'own', 'src/large.js': 'x'.repeat(100) }, { 'index.js': 'x'.repeat(1000) }))
  assert.equal(state.bundleSourceFile, 'dependencies/internal.js')
  findingsByHash.clear()
  state.bundleSourceFile = null
  render()
  assert.equal(state.bundleSourceFile, 'src/large.js')
})

test('dependency-only Stasis bundles retain issue, entry-point, and largest-file defaults', () => {
  findings('node_modules/dep/issue.js', ['high'])
  const render = openBundle(stasis({}, { 'entry.js': 'entry', 'issue.js': 'issue', 'large.js': 'x'.repeat(100) }, ['node_modules/dep/entry.js']))
  assert.equal(state.bundleSourceFile, 'node_modules/dep/issue.js')
  findingsByHash.clear()
  state.bundleSourceFile = null
  render()
  assert.equal(state.bundleSourceFile, 'node_modules/dep/entry.js')
  state.bundleSourceFile = null
  openBundle(stasis({}, { 'small.js': 'small', 'large.js': 'x'.repeat(100) }))
  assert.equal(state.bundleSourceFile, 'node_modules/dep/large.js')
})

test('dependency findings do not block a later automatic update to own-file findings', () => {
  findings('node_modules/dep/index.js', ['critical'])
  const render = openBundle(stasis({ 'src/entry.js': 'entry', 'src/issue.js': 'issue' }, { 'index.js': 'dep' }, ['src/entry.js']))
  assert.equal(state.bundleSourceFile, 'src/entry.js')
  render()
  assert.equal(state.bundleSourceFile, 'src/entry.js')
  findings('src/issue.js', ['low'])
  render()
  assert.equal(state.bundleSourceFile, 'src/issue.js')
})

test('a file open in the last bundle opens where this one has the same path, or the usual pick does', () => {
  findings('src/main.js', ['low'])
  for (const [carried, opened] of [['node_modules/dep/index.js', 'node_modules/dep/index.js'], ['src/gone.js', 'src/main.js']]) {
    state.bundleSourceFile = null
    state.bundleCodeFileRequest = { bundle: `sha512-code-${bundleId + 1}`, path: carried }
    openBundle(stasis({ 'src/main.js': 'own' }, { 'index.js': 'dep' }, ['src/main.js']))
    assert.equal(state.bundleSourceFile, opened)
    assert.equal(state.bundleCodeFileRequest, null)
  }
  // Findings arriving later don't swap it for theirs, as they would the usual pick.
  findingsByHash.clear()
  state.bundleSourceFile = null
  state.bundleCodeFileRequest = { bundle: `sha512-code-${bundleId + 1}`, path: 'node_modules/dep/index.js' }
  const render = openBundle(stasis({ 'src/main.js': 'own' }, { 'index.js': 'dep' }, ['src/main.js']))
  findings('src/main.js', ['high'])
  render()
  assert.equal(state.bundleSourceFile, 'node_modules/dep/index.js')
})

test('findings arriving after a manual selection keep the selected file', () => {
  const render = openBundle(stasis({ 'src/entry.js': 'entry', 'src/issue.js': 'issue' }, { 'index.js': 'dep' }, ['src/entry.js']))
  state.bundleSourceFile = 'node_modules/dep/index.js'
  findings('src/issue.js', ['high'])
  render()
  assert.equal(state.bundleSourceFile, 'node_modules/dep/index.js')
})

test('sourcemaps keep choosing the worst issue across all sources or the largest source', () => {
  findings('src/main.js', ['low'])
  findings('node_modules/dep/index.js', ['critical'])
  const render = openBundle({ kind: 'sourcemap', json: {
    version: 3, sources: ['src/main.js', 'node_modules/dep/index.js'], sourcesContent: ['own', 'x'.repeat(100)],
  } })
  assert.equal(state.bundleSourceFile, 'node_modules/dep/index.js')
  findingsByHash.clear()
  state.bundleSourceFile = null
  render()
  assert.equal(state.bundleSourceFile, 'node_modules/dep/index.js')
})
