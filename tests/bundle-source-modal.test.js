import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import '../ui/view/frontend-install.js'
import { Bundle } from '@exodus/stasis-core/bundle'
import { langForPath } from '../common/code-language.js'
import { createBundleMetadata, parseBundleMetadata } from '../ui/view/bundle-metadata.js'
import { autorun } from '@rray/frontend/state-management'
import { bundleWhy } from '../ui/view/bundle-why.js'

// Keep the real modal and bundle source rendering without unrelated page
// navigation, tooltip listeners, or asynchronous syntax highlighting.
mock.module('../ui/view/render.js', { namedExports: { render() {} } })
mock.module('../ui/view/dom.js', { namedExports: { report: null } })
mock.module('../ui/view/scan-navigation.js', { namedExports: { canScanBundle: () => false, openScan() {} } })
mock.module('../ui/view/ingest.js', { namedExports: { bundleKind: name => name.endsWith('.br') ? 'stasis' : null } })
mock.module('../ui/view/tooltip.js', { namedExports: { hideTooltip() {}, showTooltip() {} } })
// Dialogs have separate rendering tests; capture why requests without browser-only dependencies.
mock.module('../ui/view/dialogs/advisory-details-dialog.js', { exports: { openAdvisoryDetailsDialog() {} } })
const openedWhy = []
mock.module('../ui/view/dialogs/why-dialog.js', { exports: { openWhyDialog: props => openedWhy.push(props) } })
const highlightCalls = []
mock.module('../ui/view/prism-highlight.js', { namedExports: { langForPath, langForTag: () => null, highlight: (content, lang) => { highlightCalls.push({ content, lang }); return Promise.resolve(null) } } })
mock.module('lit/directives/repeat.js', { namedExports: { repeat: (items, key, template) => {
  assert.equal(new Set(items.map(key)).size, items.length, 'repeat keys must distinguish every rendered row')
  return items.map(template)
} } })
const { state } = await import('../client/state.ts')
const { buildBundleGraphData, renderBundleSourceModal, renderBundlesList, renderIssuesGroupedByFile } = await import('../ui/view/render-bundle.js')

function renderText(value) {
  if (Array.isArray(value)) return value.map(renderText).join('')
  if (value?.strings) return value.strings.map((text, index) => text + renderText(value.values[index])).join('')
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function templates(value) {
  if (Array.isArray(value)) return value.flatMap(templates)
  return value?.strings ? [value, ...value.values.flatMap(templates)] : []
}

beforeEach(() => {
  openedWhy.length = 0
  highlightCalls.length = 0
  state.currentView = 'findings'
  state.bundleDetailsTab = 'overview'
  state.bundleSourceFile = 'src/main.js'
  state.bundleSourceFindingIdx = null
  state.bundleOverviewFilesSort = 'name'
  state.bundleOverviewPackagesSort = 'size'
  state.bundleDetails = null
})

test('losing security access removes the advisory tab and restores Overview', t => {
  const previous = { managedSession: state.managedSession, managedTeams: state.managedTeams, currentManagedTeam: state.currentManagedTeam }
  t.after(() => Object.assign(state, previous))
  const entry = { managedId: 'bundle-id', name: 'bundle.br', integrity: 'advisory-access' }
  const team = { id: 'team', permissions: { security: true }, bundles: [{ id: entry.managedId }] }
  Object.assign(state, { managedSession: { role: 'view' }, managedTeams: [team], currentManagedTeam: team.id,
    selectedBundle: entry.integrity, bundles: [entry], bundleDetailsTab: 'advisories' })
  assert.match(renderText(renderBundlesList([entry])), /data-bundle-tab="advisories"/u)
  assert.equal(state.bundleDetailsTab, 'advisories')
  team.permissions.security = false
  const text = renderText(renderBundlesList([entry]))
  assert.doesNotMatch(text, /data-bundle-tab="advisories"|Failed to fetch advisories/u)
  assert.equal(state.bundleDetailsTab, 'overview')
})

test('managed bundles have no Issues tab, and an Issues selection restores Overview', t => {
  const previous = { serverMode: state.serverMode, localMode: state.localMode }
  t.after(() => Object.assign(state, previous))
  for (const [serverMode, localMode, shown] of [['managed', false, false], ['managed', true, true], ['standalone', true, true]]) {
    const entry = { name: 'issues.map', integrity: 'issues-tab-hash' }
    Object.assign(state, { serverMode, localMode, selectedBundle: entry.integrity, bundles: [entry], bundleDetailsTab: 'issues' })
    const text = renderText(renderBundlesList([entry]))
    assert.equal(/data-bundle-tab="issues"/u.test(text), shown)
    assert.equal(/data-bundle-tab="overview"/u.test(text), true)
    assert.equal(state.bundleDetailsTab, shown ? 'issues' : 'overview')
  }
})

test('a managed bundle without dependency packages keeps an open Advisories tab, as a link or bundle switch opens it', async t => {
  const previous = { managedSession: state.managedSession, serverMode: state.serverMode, localMode: state.localMode }
  t.after(() => Object.assign(state, previous))
  const entry = { managedId: 'own-only', name: 'own-only.br', integrity: 'sha512-own-only' }
  const full = { integrity: entry.integrity, kind: 'stasis', size: 3, bundle: new Bundle({
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'app.js': 'app' } }]]),
  }) }
  // Managed bundles open with their metadata already parsed: no load window keeps the tab.
  // (The entry makes it managed; details without its id leave the audit unrequested.)
  const details = parseBundleMetadata(await createBundleMetadata(full), entry.integrity)
  Object.assign(state, { serverMode: 'managed', localMode: false, managedSession: { role: 'admin' },
    selectedBundle: entry.integrity, bundles: [entry], bundleDetails: details })
  for (const [tab, shown] of [['advisories', true], ['overview', false]]) {
    state.bundleDetailsTab = tab
    assert.equal(/data-bundle-tab="advisories"/u.test(renderText(renderBundlesList([entry]))), shown)
    assert.equal(state.bundleDetailsTab, tab)
  }
})

test('switching to a sourcemap keeps the open Advisories tab', t => {
  const previous = { managedSession: state.managedSession }
  t.after(() => Object.assign(state, previous))
  const entry = { managedId: 'map-id', name: 'app.map', integrity: 'sha512-map' }
  const details = { integrity: entry.integrity, kind: 'sourcemap', json: { version: 3, sources: [] }, sourceSizes: [] }
  Object.assign(state, { managedSession: { role: 'admin' }, selectedBundle: entry.integrity, bundles: [entry], bundleDetails: details, bundleDetailsTab: 'advisories' })
  const text = renderText(renderBundlesList([entry]))
  assert.match(text, /data-bundle-tab="advisories"/u)
  assert.match(text, /Advisories are only available for stasis bundles/u)
  assert.equal(state.bundleDetailsTab, 'advisories')
})

test('without a second bundle, an open Compare tab stays rather than falling back to Overview', () => {
  const entry = { name: 'only.map', integrity: 'sha512-only' }
  Object.assign(state, { selectedBundle: entry.integrity, bundles: [entry] })
  for (const [tab, shown] of [['compare', true], ['overview', false]]) {
    state.bundleDetailsTab = tab
    assert.equal(/data-bundle-tab="compare"/u.test(renderText(renderBundlesList([entry]))), shown)
    assert.equal(state.bundleDetailsTab, tab)
  }
})

test('unattached managed bundle headers return to Manage Bundles before the bundle identity', t => {
  const previous = { serverMode: state.serverMode, localMode: state.localMode }
  const previousDocument = globalThis.document
  const document = new EventTarget()
  globalThis.document = document
  t.after(() => {
    Object.assign(state, previous)
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  })
  const events = []
  document.addEventListener('managed-admin-navigate', event => events.push(event.detail))
  for (const [serverMode, localMode, managedId, repoId, shown] of [
    ['managed', false, 'bundle-id', null, true],
    ['managed', false, 'bundle-id', 7, false],
    ['managed', true, 'bundle-id', null, false],
    ['standalone', true, undefined, null, false],
  ]) {
    const entry = { name: 'unattached.map', integrity: 'breadcrumb-hash', managedId, repoId }
    Object.assign(state, { serverMode, localMode, selectedBundle: entry.integrity, bundles: [entry] })
    const view = renderBundlesList([entry])
    const header = renderText(view).match(/<header class="bundles-slide-bar">(.*?)<\/header>/su)[1]
    assert.equal(header.includes('bundles-slide-breadcrumb'), shown)
    if (!shown) continue
    assert.ok(header.indexOf('>Bundles</button>') < header.indexOf('bundles-slide-icon'))
    assert.match(header, /<span aria-hidden="true">&gt;<\/span>/u)
    const breadcrumb = view.values.find(value => value?.strings?.some(string => string.includes('bundles-slide-breadcrumb')))
    breadcrumb.values.find(value => typeof value === 'function')()
  }
  assert.deepEqual(events, [{ view: 'manage-bundles' }])
})

test('extensionless Stasis sources use recorded formats in tree, filtered tree, header, and modal', () => {
  const path = 'node_modules/example/bin/example'
  const content = 'const example = require("example")'
  const entry = { name: 'formats.stasis', integrity: 'sha512-format-language' }
  const bundle = Bundle.parse(new Bundle({
    modules: new Map([['node_modules/example', { name: 'example', version: '1.0.0', files: { 'bin/example': content } }]]),
    formats: new Map([[path, 'commonjs']]),
  }).serialize())
  Object.assign(state, { currentView: 'bundles', bundleDetailsTab: 'code', bundleSourceFile: path,
    bundleCodeSearchMode: 'files', selectedBundle: entry.integrity, bundles: [entry],
    bundleDetails: { kind: 'stasis', integrity: entry.integrity, size: 123, bundle } })
  for (const query of ['', 'bin/example']) {
    state.bundleCodeSearchQuery = query
    const markup = renderText(renderBundlesList([entry]))
    assert.match(markup.match(/<aside class="bundle-code-rail">(.*?)<\/aside>/su)[1], /data-file-type=js/u)
    assert.match(markup.match(/<header class="bundle-code-main-bar">(.*?)<\/header>/su)[1], /data-file-type=js/u)
    assert.match(markup, /<code class=language-javascript>/u)
  }
  assert.deepEqual(highlightCalls, [{ content, lang: 'javascript' }])
  state.currentView = 'findings'
  state.bundleDetailsTab = 'overview'
  assert.match(renderText(renderBundleSourceModal()), /<code class=language-javascript>/u)
})

test('the source popup shows loading through a cold open and metadata upgrade, then displays the file', () => {
  for (const details of [null, { metadataOnly: true }]) {
    state.bundleDetails = details
    const markup = renderText(renderBundleSourceModal())
    assert.match(markup, /aria-busy=true/u)
    assert.match(markup, /role="status">Loading source…/u)
    assert.match(markup, /src\/main\.js/u, 'keep the requested path visible while loading')
    assert.match(markup, /aria-label="Close source viewer"/u)
    assert.doesNotMatch(markup, /Source content not bundled|Failed to load source/u)
  }
  state.bundleDetails = { kind: 'sourcemap', json: { sources: ['src/main.js'], sourcesContent: ['export const ready = true'] } }
  const markup = renderText(renderBundleSourceModal())
  assert.match(markup, /aria-busy=false/u)
  assert.match(markup, /export const ready = true/u)
  assert.doesNotMatch(markup, /Loading source|Source content not bundled/u)
})

test('only a loaded bundle without the file content shows the missing-source message', () => {
  for (const sourcesContent of [[], [null]]) {
    state.bundleDetails = { kind: 'sourcemap', json: { sources: ['src/main.js'], sourcesContent } }
    const markup = renderText(renderBundleSourceModal())
    assert.match(markup, /Source content not bundled/u)
    assert.match(markup, /aria-busy=false/u)
    assert.doesNotMatch(markup, /Loading source/u)
  }
})

test('bundle read failures and failed source upgrades end loading with a distinct error', () => {
  for (const details of [{ error: 'Could not read bundle' }, { metadataOnly: true, sourceError: 'Could not fetch sources' }]) {
    state.bundleDetails = details
    const markup = renderText(renderBundleSourceModal())
    assert.match(markup, /role="status">Failed to load source:/u)
    assert.ok(markup.includes(details.error || details.sourceError))
    assert.match(markup, /aria-busy=false/u)
    assert.doesNotMatch(markup, /Loading source|Source content not bundled/u)
  }
})

test('closing during loading keeps the popup closed after sources arrive', () => {
  state.bundleSourceFile = null
  assert.equal(renderText(renderBundleSourceModal()), '')
  state.bundleDetails = { kind: 'sourcemap', json: { sources: ['src/main.js'], sourcesContent: ['ready'] } }
  assert.equal(renderText(renderBundleSourceModal()), '')
})

test('Code renders Composer and Soldeer package rows with physical tooltips alongside Cargo and npm', () => {
  const entry = { name: 'mixed.stasis', integrity: 'sha512-composer-code' }
  const bundle = Bundle.parse(new Bundle({ modules: new Map([
    ['.', { name: 'app', files: { 'index.PHP': 'own', 'views/main.phtml': 'view' } }],
    ['vendor/org/package', { name: 'org/package', version: '1.2.3', files: { 'src/main.php': 'main' } }],
    ['vendor/org/dirs', { name: 'org/dirs', version: 'dev-main', ecosystem: 'composer', files: { 'src/main.php': 'main', 'lib/helper.php': 'helper' } }],
    ['vendor/org/root', { name: 'org/root', ecosystem: 'composer', files: { 'main.php': 'main' } }],
    ['vendor/ahash', { name: 'ahash', version: '0.8.12', ecosystem: 'cargo', files: { 'src/lib.rs': 'lib' } }],
    ['dependencies/@openzeppelin-contracts-5.2.0', { name: '@openzeppelin-contracts', version: '5.2.0', ecosystem: 'soldeer', files: { 'contracts/Token.sol': 'contract Token {}' } }],
    ['node_modules/dep', { name: 'dep', version: '1.0.0', files: { 'index.js': 'dep' } }],
  ]) }).serialize())
  state.currentView = 'bundles'
  state.bundleDetailsTab = 'code'
  state.bundleSourceFile = 'index.PHP'
  state.bundleCodeSearchMode = 'files'
  state.bundleCodeSearchQuery = ''
  state.selectedBundle = entry.integrity
  state.bundles = [entry]
  state.bundleDetails = { kind: 'stasis', integrity: entry.integrity, size: 123, bundle }
  const markup = renderText(renderBundlesList([entry]))
  const rail = markup.match(/<aside class="bundle-code-rail">(.*?)<\/aside>/su)[1]
  assert.equal(rail.match(/class="bundle-code-tree-composer"/gu).length, 3)
  assert.equal(rail.match(/class="bundle-code-tree-cargo"/gu).length, 1)
  assert.equal(rail.match(/class="bundle-code-tree-npm"/gu).length, 1)
  const soldeerRows = rail.match(/<summary\b[^>]*>.*?<\/summary>/gsu).filter(row => row.includes('class="bundle-code-tree-soldeer"'))
  assert.equal(soldeerRows.length, 1)
  assert.match(soldeerRows[0], /class="bundle-code-tree-package-name">@openzeppelin-contracts<\/span><span class="bundle-code-tree-package-version">- 5\.2\.0<\/span>/u)
  assert.match(soldeerRows[0], /data-tooltip=dependencies\/@openzeppelin-contracts-5\.2\.0\s+data-tooltip-placement=right-start>/u)
  assert.match(rail, /data-bundle-view-source=dependencies\/@openzeppelin-contracts-5\.2\.0\/contracts\/Token\.sol/u)
  const composerRows = rail.match(/<summary\b[^>]*>.*?<\/summary>/gsu).filter(row => row.includes('class="bundle-code-tree-composer"')).join('')
  assert.match(composerRows, /class="bundle-code-tree-package-name">org\/package<\/span><span class="bundle-code-tree-package-version">- 1\.2\.3<\/span>/u)
  assert.match(composerRows, /class="bundle-code-tree-package-name">org\/dirs<\/span><span class="bundle-code-tree-package-version">- dev-main<\/span>/u)
  assert.match(composerRows, /data-tooltip=vendor\/org\/package\/src\s+data-tooltip-placement=right-start>/u)
  assert.match(composerRows, /data-tooltip=vendor\/org\/dirs\s+data-tooltip-placement=right-start>/u)
  assert.match(composerRows, /data-tooltip=vendor\/org\/root\s+data-tooltip-placement=right-start>/u)
  assert.doesNotMatch(composerRows, /data-tooltip=vendor\/org\/(?:dirs|root)\/src[\s>]/u)
  assert.equal(rail.match(/data-file-type=php/gu).length, 6)
  assert.match(rail, /data-bundle-view-source=vendor\/org\/package\/src\/main\.php/u)
})

test('Code retains the dependencies row for bundles containing only multiple Soldeer packages', () => {
  const entry = { name: 'soldeer.stasis', integrity: 'sha512-soldeer-code' }
  state.currentView = 'bundles'
  state.bundleDetailsTab = 'code'
  state.bundleCodeSearchMode = 'files'
  state.bundleCodeSearchQuery = ''
  state.selectedBundle = entry.integrity
  state.bundles = [entry]
  for (const checkout of ['', 'packages/app/']) {
    const bundle = Bundle.parse(new Bundle({ modules: new Map([
      [`${checkout}dependencies/foo-1.0.0`, { name: 'foo', version: '1.0.0', ecosystem: 'soldeer', files: { 'src/Foo.sol': 'contract Foo {}' } }],
      [`${checkout}dependencies/bar-2.0.0`, { name: 'bar', version: '2.0.0', ecosystem: 'soldeer', files: { 'src/Bar.sol': 'contract Bar {}' } }],
    ]) }).serialize())
    state.bundleSourceFile = `${checkout}dependencies/foo-1.0.0/src/Foo.sol`
    state.bundleDetails = { kind: 'stasis', integrity: entry.integrity, size: 123, bundle }
    const rail = renderText(renderBundlesList([entry])).match(/<aside class="bundle-code-rail">(.*?)<\/aside>/su)[1]
    assert.ok(rail.includes(`data-tooltip=${checkout}dependencies>`), 'keep the shared container visible in the tree')
    assert.equal(rail.match(/class="bundle-code-tree-soldeer"/gu).length, 2)
    assert.ok(rail.includes(`data-bundle-view-source=${checkout}dependencies/foo-1.0.0/src/Foo.sol`))
    assert.ok(rail.includes(`data-bundle-view-source=${checkout}dependencies/bar-2.0.0/src/Bar.sol`))
  }
})

test('Code search marks each match in its rail row and keeps far matches in view', t => {
  t.after(() => Object.assign(state, { bundleCodeSearchMode: 'files', bundleCodeSearchQuery: '' }))
  const entry = { name: 'search.stasis', integrity: 'sha512-code-search-marks' }
  const content = `const Needle = needle\n${'x'.repeat(50)} <needle>\n        indented(needle)\nnope`
  const bundle = Bundle.parse(new Bundle({ modules: new Map([
    ['node_modules/pkg', { name: 'pkg', version: '1.0.0', files: { 'index.js': content } }],
  ]) }).serialize())
  Object.assign(state, { currentView: 'bundles', bundleDetailsTab: 'code', selectedBundle: entry.integrity, bundles: [entry],
    bundleSourceFile: 'node_modules/pkg/index.js', bundleCodeSearchMode: 'code', bundleCodeSearchQuery: 'needle',
    bundleDetails: { kind: 'stasis', integrity: entry.integrity, size: 123, bundle } })
  const rail = renderText(renderBundlesList([entry])).match(/<aside class="bundle-code-rail">(.*?)<\/aside>/su)[1]
  const rows = [...rail.matchAll(/<span class="bundle-code-search-hit-text mono">(.*?)<\/span>\s*<\/button>/gsu)].map(m => m[1])
  const mark = text => `<mark class="bundle-search-mark">${text}</mark>`
  assert.deepEqual(rows, [
    `const ${mark('Needle')} = ${mark('needle')}`,
    `<span class="bundle-search-clip">…</span>${'x'.repeat(10)} <${mark('needle')}>`,
    `        indented(${mark('needle')})`,
  ])
})

test('Code and Search tab code search list own source before dependencies', t => {
  const previous = { bundleCodeSearchMode: state.bundleCodeSearchMode, bundleCodeSearchQuery: state.bundleCodeSearchQuery,
    bundleSearchQuery: state.bundleSearchQuery, bundleSearchRegex: state.bundleSearchRegex, bundleSearchCase: state.bundleSearchCase }
  t.after(() => Object.assign(state, previous))
  const entry = { name: 'order.stasis', integrity: 'sha512-own-source-first' }
  // Own code (root source and the `packages/ui` workspace) sorts after both dependencies, so path order
  // alone would list dependencies first.
  const bundle = Bundle.parse(new Bundle({ modules: new Map([
    ['.', { name: 'app', version: '1.0.0', files: { 'src/app.js': 'needle()', 'zz/own.js': 'needle' } }],
    ['packages/ui', { name: 'ui', version: '1.0.0', files: { 'index.js': 'needle' } }],
    ['node_modules/dep', { name: 'dep', version: '1.0.0', files: { 'index.js': 'needle' } }],
    ['lib/vendor/log', { name: 'log', version: '1.0.0', files: { 'needle.rs': 'needle' } }],
  ]) }).serialize())
  Object.assign(state, { currentView: 'bundles', selectedBundle: entry.integrity, bundles: [entry], bundleSourceFile: 'src/app.js',
    bundleCodeSearchMode: 'code', bundleCodeSearchQuery: 'needle', bundleSearchQuery: 'needle', bundleSearchRegex: false, bundleSearchCase: false,
    bundleDetails: { kind: 'stasis', integrity: entry.integrity, size: 123, bundle } })
  const expected = ['packages/ui/index.js', 'src/app.js', 'zz/own.js', 'lib/vendor/log/needle.rs', 'node_modules/dep/index.js']
  state.bundleDetailsTab = 'code'
  const rail = renderText(renderBundlesList([entry])).match(/<aside class="bundle-code-rail">(.*?)<\/aside>/su)[1]
  assert.deepEqual([...rail.matchAll(/class="bundle-code-search-file-name"\s+data-bundle-view-source=(\S+)/gu)].map(m => m[1]), expected)
  state.bundleDetailsTab = 'search'
  const search = renderText(renderBundlesList([entry]))
  assert.deepEqual([...search.matchAll(/class="bundle-search-file-name mono"\s+data-bundle-view-source=(\S+)/gu)].map(m => m[1]), expected)
})

test('the source viewer marks the line a search result opened, only in that bundle and file', t => {
  t.after(() => { state.bundleSourceTargetLine = null })
  const entry = { name: 'target.stasis', integrity: 'sha512-target-line' }
  const bundle = Bundle.parse(new Bundle({ modules: new Map([
    ['.', { name: 'app', version: '1.0.0', files: { 'src/app.js': 'one\ntwo needle\nthree', 'src/other.js': 'a\nb' } }],
  ]) }).serialize())
  Object.assign(state, { currentView: 'bundles', bundleDetailsTab: 'code', selectedBundle: entry.integrity, bundles: [entry],
    bundleSourceFile: 'src/app.js', bundleDetails: { kind: 'stasis', integrity: entry.integrity, size: 123, bundle } })
  const marked = () => templates(renderBundlesList([entry]))
    .filter(part => part.strings.join('').includes('data-line='))
    .filter(part => part.values[0].values[0]['is-target']).map(part => part.values[1])
  for (const [target, lines] of [
    [{ bundle: entry.integrity, path: 'src/app.js', line: 2 }, [2]],
    [{ bundle: entry.integrity, path: 'src/other.js', line: 2 }, []],
    [{ bundle: 'sha512-another-bundle', path: 'src/app.js', line: 2 }, []],
    [null, []],
  ]) {
    state.bundleSourceTargetLine = target
    assert.deepEqual(marked(), lines, JSON.stringify(target))
  }
})

test('Code package tooltips include recorded identities and counts even while filtering', () => {
  const entry = { name: 'npm.stasis', integrity: 'sha512-package-tooltip' }
  const bundle = Bundle.parse(new Bundle({ modules: new Map([
    ['node_modules/alias', { name: 'actual-package', version: '1.2.3', files: {
      'package.json': JSON.stringify({ repository: 'org/actual-package' }), 'index.js': 'index', 'lib/helper.js': 'helper',
    } }],
  ]) }).serialize())
  Object.assign(state, { currentView: 'bundles', bundleDetailsTab: 'code', selectedBundle: entry.integrity, bundles: [entry],
    bundleSourceFile: 'node_modules/alias/index.js', bundleCodeSearchMode: 'files', bundleCodeSearchQuery: '',
    bundleDetails: { kind: 'stasis', integrity: entry.integrity, size: 123, bundle } })
  for (const query of ['', 'index.js']) {
    state.bundleCodeSearchQuery = query
    const rail = renderText(renderBundlesList([entry])).match(/<aside class="bundle-code-rail">(.*?)<\/aside>/su)[1]
    const pkg = rail.match(/<summary\b[^>]*>.*?<\/summary>/gsu).find(row => row.includes('class="bundle-code-tree-npm"'))
    for (const attr of ['data-tooltip-package=actual-package', 'data-tooltip-version=1.2.3', 'data-tooltip-files=3', 'data-tooltip-repo=org/actual-package']) assert.ok(pkg.includes(attr), attr)
    assert.match(pkg, /data-tooltip=node_modules\/alias\s+data-tooltip-placement=right-start>/u)
  }
})

test('Code package tooltips show the commit a recorded repository pins, as its files do', () => {
  const entry = { name: 'commit.stasis', integrity: 'sha512-package-commit' }
  const commit = 'c'.repeat(40)
  const bundle = Bundle.parse(new Bundle({ modules: new Map([
    ['node_modules/pinned', { name: 'pinned', version: '1.0.0', repo: { github: 'org/mono', directory: 'packages/pinned', commit }, files: { 'index.js': 'pinned' } }],
    ['node_modules/manifest', { name: 'manifest', version: '1.0.0', files: { 'package.json': JSON.stringify({ repository: 'org/manifest' }), 'index.js': 'manifest' } }],
  ]) }).serialize())
  Object.assign(state, { currentView: 'bundles', bundleDetailsTab: 'code', selectedBundle: entry.integrity, bundles: [entry],
    bundleSourceFile: 'node_modules/pinned/index.js', bundleCodeSearchMode: 'files', bundleCodeSearchQuery: '',
    bundleDetails: { kind: 'stasis', integrity: entry.integrity, size: 123, bundle } })
  const html = renderText(renderBundlesList([entry]))
  const rows = html.match(/<aside class="bundle-code-rail">(.*?)<\/aside>/su)[1].match(/<summary\b[^>]*>/gsu)
  const row = name => rows.find(summary => summary.includes(`data-tooltip-package=${name}`))
  assert.ok(row('pinned').includes('data-tooltip-repo=org/mono/packages/pinned'))
  assert.ok(row('pinned').includes(`data-tooltip-commit=${commit}`), 'the package names its commit')
  assert.ok(row('manifest').includes('data-tooltip-repo=org/manifest'))
  assert.doesNotMatch(row('manifest'), /data-tooltip-commit=\S/u, 'a captured package.json pins no commit')
  const header = html.match(/<header class="bundle-code-main-bar">(.*?)<\/header>/su)[1]
  assert.ok(header.includes(`data-tooltip-commit=${commit}`), 'its file links at the same commit')
})

test('Code file header links a file to GitHub after copy where its package or bundle names a repository', () => {
  const entry = { name: 'github.stasis', integrity: 'sha512-file-github' }
  const bundle = Bundle.parse(new Bundle({ modules: new Map([
    ['.', { name: 'app', version: '1.0.0', files: { 'src/index.js': 'app' } }],
    ['node_modules/dep', { name: 'dep', version: '1.2.3', repo: { github: 'org/mono', directory: 'packages/dep' }, files: { 'index.js': 'dep' } }],
    ['node_modules/unplaced', { name: 'unplaced', version: '1.0.0', repo: { github: 'org/unplaced' }, files: { 'index.js': 'unplaced' } }],
    ['node_modules/no-repo', { name: 'no-repo', version: '1.0.0', files: { 'index.js': 'no-repo' } }],
  ]) }).serialize())
  bundle.repo = { github: 'org/app', directory: '' }
  Object.assign(state, { currentView: 'bundles', bundleDetailsTab: 'code', selectedBundle: entry.integrity, bundles: [entry],
    bundleCodeSearchMode: 'files', bundleCodeSearchQuery: '', bundleDetails: { kind: 'stasis', integrity: entry.integrity, size: 123, bundle } })
  const header = file => {
    state.bundleSourceFile = file
    return renderText(renderBundlesList([entry])).match(/<header class="bundle-code-main-bar">(.*?)<\/header>/su)[1]
  }
  const dep = header('node_modules/dep/index.js')
  assert.match(dep, /data-copy-path=node_modules\/dep\/index\.js[^>]*>.*?<\/button>\s*<a\s+class="bundle-code-github-link"/su, 'the link follows the copy button')
  for (const attr of ['href=https://github.com/org/mono/blob/HEAD/packages/dep/index.js', 'aria-label="Open on GitHub"', 'data-tooltip=packages/dep/index.js',
    'data-tooltip-repo=org/mono', 'data-tooltip-package=dep', 'data-tooltip-ecosystem=npm', 'data-tooltip-version=1.2.3']) assert.ok(dep.includes(attr), attr)
  assert.match(dep, /<span hidden data-tooltip-package-icon><svg class="bundle-code-tree-npm"/u, 'the tooltip shows the package icon, not GitHub')
  const own = header('src/index.js')
  assert.ok(own.includes('href=https://github.com/org/app/blob/HEAD/src/index.js'))
  assert.doesNotMatch(own, /data-tooltip-package=\S|data-tooltip-package-icon/u, 'own files name no package')
  assert.ok(header('node_modules/unplaced/index.js').includes('href=https://github.com/org/unplaced/blob/HEAD/index.js'), 'an unknown directory is the root')
  assert.ok(!header('node_modules/no-repo/index.js').includes('bundle-code-github-link'), 'no repository shows no link')
})

test('Code own files in a managed bundle without a stamp link to its stored repository and directory', () => {
  const bundle = Bundle.parse(new Bundle({ modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'src/index.js': 'app' } }]]) }).serialize())
  const stored = { repoId: 7, repoFullName: 'org/app', repoDirectory: 'apps/web' }
  const header = entry => {
    Object.assign(state, { currentView: 'bundles', bundleDetailsTab: 'code', selectedBundle: entry.integrity, bundles: [entry], bundleSourceFile: 'src/index.js',
      bundleCodeSearchMode: 'files', bundleCodeSearchQuery: '', bundleDetails: { kind: 'stasis', integrity: entry.integrity, size: 123, bundle } })
    return renderText(renderBundlesList([entry])).match(/<header class="bundle-code-main-bar">(.*?)<\/header>/su)[1]
  }
  const managed = header({ name: 'managed.stasis', integrity: 'sha512-managed-github', managedId: 'b1', ...stored })
  assert.ok(managed.includes('href=https://github.com/org/app/blob/HEAD/apps/web/src/index.js'), 'the stored location fills in the missing stamp')
  assert.ok(managed.includes('data-tooltip=apps/web/src/index.js'))
  assert.ok(!header({ name: 'unattached.stasis', integrity: 'sha512-unattached-github', managedId: 'b2', ...stored, repoId: null }).includes('bundle-code-github-link'), 'an unattached bundle has no stored repository')
  assert.ok(!header({ name: 'local.stasis', integrity: 'sha512-local-github', ...stored }).includes('bundle-code-github-link'), 'only managed bundles have one')
})

test('bundle Overview displays origin links from full contents and cached managed metadata', async () => {
  const entry = { name: 'app.stasis.code.br', integrity: 'sha512-origin' }
  const commit = '0123456789abcdef'.repeat(3).slice(0, 40)
  const full = { integrity: entry.integrity, kind: 'stasis', size: 123, bundle: new Bundle({
    repo: { github: 'org/repo', directory: 'packages/app', commit }, package: { npm: { name: '@org/app', version: '1.2.3' } },
    modules: new Map([['.', { name: 'app', version: '1.2.3', files: { 'src/a.js': 'a', 'src/b.js': 'b' } }]]),
  }) }
  const cached = parseBundleMetadata(await createBundleMetadata(full), entry.integrity)
  state.selectedBundle = entry.integrity
  state.bundles = [entry]
  for (const [details, managedId] of [[full, undefined], [cached, 'managed-bundle']]) {
    state.bundleDetails = details
    const markup = renderText(renderBundlesList([{ ...entry, managedId }]))
    assert.match(markup, /<dt>GitHub<\/dt><dd class="bundle-origin-row">\s*<a class="bundle-origin-link" href=https:\/\/github\.com\/org\/repo/u)
    assert.match(markup, /<dt>npm<\/dt><dd class="bundle-origin-row">\s*<a class="bundle-origin-link" href=https:\/\/www\.npmjs\.com\/package\/@org\/app\/v\/1\.2\.3/u)
    const githubRow = markup.match(/<dt>GitHub<\/dt><dd class="bundle-origin-row">(.*?)<\/dd>/su)[1]
    assert.ok(githubRow.includes(`href=https://github.com/org/repo/tree/${commit}/packages/app/src`))
    assert.match(markup, /<dt>Prefix<\/dt><dd class="mono">src\/<\/dd>/u)
    assert.ok(githubRow.includes(`href=https://github.com/org/repo/commit/${commit}`))
    assert.match(githubRow, /<span>0123456<\/span>/u)
    assert.match(githubRow, /class="bundle-origin-link bundle-commit-link"/u)
    assert.doesNotMatch(markup, /<dt>Commit<\/dt>/u)
    assert.match(markup, /target="_blank" rel="noopener noreferrer"/u)
  }
  for (const details of [null, { ...full, integrity: 'previous' }, { ...full, error: 'broken' }, { ...full, bundle: new Bundle() }]) {
    state.bundleDetails = details
    const markup = renderText(renderBundlesList([entry]))
    assert.match(markup, /<dt>Name<\/dt><dd>app\.stasis\.code\.br<\/dd>/u)
    assert.doesNotMatch(markup, /<dt>GitHub<\/dt>|<dt>npm<\/dt>/u)
  }
})

test('bundle Overview lists entry points on the left and puts Size under Sources for local and managed metadata', async () => {
  const entry = { name: 'app.stasis.code.br', integrity: 'sha512-entries' }
  const full = { integrity: entry.integrity, kind: 'stasis', size: 123, bundle: new Bundle({
    entries: new Set(['src/main.js', 'src/worker.js']),
    modules: new Map([['.', { name: 'app', version: '1', files: {
      'src/main.js': 'main', 'src/worker.js': 'worker', 'src/helper.js': 'helper',
    } }]]),
  }) }
  const cached = parseBundleMetadata(await createBundleMetadata(full), entry.integrity)
  state.selectedBundle = entry.integrity
  state.bundles = [entry]
  for (const [details, managedId] of [[full, undefined], [cached, 'managed-bundle']]) {
    state.bundleDetails = details
    const markup = renderText(renderBundlesList([{ ...entry, managedId }]))
    const firstMeta = markup.match(/<dl class="bundles-detail-meta">(.*?)<\/dl>/su)[1]
    assert.match(firstMeta, /<dt>Prefix<\/dt><dd class="mono">src\/<\/dd>/u)
    const points = firstMeta.match(/<dt>Entry points<\/dt><dd class="mono">(.*?)<\/dd>/su)[1]
    assert.match(points, /data-bundle-view-source=src\/main\.js>main\.js<\/button>/u)
    assert.match(points, /data-bundle-view-source=src\/worker\.js>worker\.js<\/button>/u)
    assert.doesNotMatch(points, /helper/u)
    assert.match(markup, /<dt>Sources<\/dt><dd>3<\/dd>\s*<dt>Size<\/dt><dd>123 B<\/dd>/u)
    assert.doesNotMatch(firstMeta, /<dt>Size<\/dt>/u)
  }
})

test('bundles without entry-point metadata keep their counts and Size without inventing entries', () => {
  const entry = { name: 'app.stasis.code.br', integrity: 'sha512-no-entries' }
  const legacy = Bundle.parse(JSON.stringify({ version: 0, config: { scope: 'node_modules' },
    sources: { 'node_modules/dep/a.js': 'dep' }, formats: {}, imports: {} }))
  state.selectedBundle = entry.integrity
  state.bundles = [entry]
  for (const fields of [
    { kind: 'stasis', bundle: new Bundle() },
    { kind: 'stasis', bundle: legacy },
    { kind: 'sourcemap', json: { version: 3, sources: ['src/main.js'], sourcesContent: ['main'] } },
  ]) {
    state.bundleDetails = { ...fields, integrity: entry.integrity, size: 200 }
    const markup = renderText(renderBundlesList([entry]))
    assert.doesNotMatch(markup, /<dt>Entry points<\/dt>/u)
    assert.match(markup, /<dt>Sources<\/dt><dd>\d<\/dd>\s*<dt>Size<\/dt><dd>200 B<\/dd>/u)
  }
})

test('bundle Overview shows the unpacked total of every file beside Size for local and managed bundles', async () => {
  const entry = { name: 'app.stasis.code.br', integrity: 'sha512-unpacked' }
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe])
  const full = { integrity: entry.integrity, kind: 'stasis', size: 999, bundle: Bundle.parse(new Bundle({
    modules: new Map([['.', { name: 'app', version: '1', files: {
      'src/main.js': 'export default 1\n',
      'assets': JSON.stringify(['icon.svg', 'logo.png']),
      'assets/icon.svg': '<svg/>',
      'assets/logo.png': png.toString('base64'),
    } }]]),
    formats: new Map([['src/main.js', 'module'], ['assets', 'directory'], ['assets/icon.svg', 'resource'], ['assets/logo.png', 'resource:base64']]),
  }).serialize()) }
  const cached = parseBundleMetadata(await createBundleMetadata(full), entry.integrity)
  state.selectedBundle = entry.integrity
  state.bundles = [entry]
  for (const details of [full, cached]) {
    state.bundleDetails = details
    // 17 B of source, plus the 6 B SVG and the 7 B its base64 PNG decodes to.
    for (const managedId of [undefined, 'managed-bundle']) {
      assert.match(renderText(renderBundlesList([{ ...entry, managedId }])), /<dt>Size<\/dt><dd>999 B<\/dd>\s*<dt>Unpacked<\/dt><dd>30 B<\/dd>/u)
    }
  }
  // Sourcemap sources left without content have no size to add.
  const json = { version: 3, sources: ['src/a.js', 'src/b.js', 'src/missing.js'], sourcesContent: ['1234', '😀', null] }
  for (const managedId of [undefined, 'managed-map']) {
    state.bundleDetails = { integrity: entry.integrity, kind: 'sourcemap', size: 50, json }
    assert.match(renderText(renderBundlesList([{ ...entry, managedId }])), /<dt>Size<\/dt><dd>50 B<\/dd>\s*<dt>Unpacked<\/dt><dd>8 B<\/dd>/u)
    state.bundleDetails = { integrity: entry.integrity, kind: 'sourcemap', size: 50, json: { ...json, sourcesContent: [] } }
    assert.doesNotMatch(renderText(renderBundlesList([{ ...entry, managedId }])), /<dt>Unpacked<\/dt>/u)
  }
})

test('the Overview Files header offers Name and Size ordering for local and cached managed bundles', async () => {
  const entry = { name: 'app.stasis.code.br', integrity: 'sha512-file-order' }
  const full = { integrity: entry.integrity, kind: 'stasis', size: 123, bundle: new Bundle({
    modules: new Map([['.', { name: 'app', version: '1', files: {
      'src/z.js': '123456', 'src/b.js': '123', 'src/a.js': '😀', 'src/c.js': '123',
    } }]]),
  }) }
  const cached = parseBundleMetadata(await createBundleMetadata(full), entry.integrity)
  state.selectedBundle = entry.integrity
  state.bundles = [entry]
  for (const [details, managedId] of [[full, undefined], [cached, 'managed-bundle']]) {
    state.bundleDetails = details
    for (const [sort, expected] of [
      ['name', ['a.js', 'b.js', 'c.js', 'z.js']],
      ['size', ['z.js', 'a.js', 'b.js', 'c.js']],
    ]) {
      state.bundleOverviewFilesSort = sort
      const markup = renderText(renderBundlesList([{ ...entry, managedId }]))
      const header = markup.match(/<header class="bundles-overview-col-head">\s*<span class="bundles-overview-col-title">Files (.*?)<\/header>/su)[1]
      assert.match(header, /role="group" aria-label="File order"/u)
      assert.match(header, new RegExp(`aria-pressed=${sort === 'name'}[^>]*>Name<`, 'u'))
      assert.match(header, new RegExp(`aria-pressed=${sort === 'size'}[^>]*>Size<`, 'u'))
      const files = markup.match(/<ul class="bundles-sources-list">(.*?)<\/ul>/su)[1]
      assert.deepEqual([...files.matchAll(/class="bundles-source-path"[^>]*>(.*?)<\/span>/gu)].map(match => match[1]), expected)
      assert.match(files, /data-bundle-view-source=src\/a\.js/u)
    }
  }
})

test('Overview Size ordering puts known zero-byte sourcemap files before unknown sizes', () => {
  const entry = { name: 'app.map', integrity: 'sha512-map-file-order' }
  state.selectedBundle = entry.integrity
  state.bundleDetails = { integrity: entry.integrity, kind: 'sourcemap', size: 123, json: {
    version: 3, sources: ['src/missing.js', 'src/empty.js', 'src/full.js'], sourcesContent: [null, '', 'content'],
  } }
  state.bundleOverviewFilesSort = 'size'
  const markup = renderText(renderBundlesList([entry]))
  const files = markup.match(/<ul class="bundles-sources-list">(.*?)<\/ul>/su)[1]
  assert.deepEqual([...files.matchAll(/class="bundles-source-path"[^>]*>(.*?)<\/span>/gu)].map(match => match[1]), ['full.js', 'empty.js', 'missing.js'])
})

test('the Overview Packages header sorts by total bytes or displayed name independently of Files', async () => {
  const entry = { name: 'app.stasis.code.br', integrity: 'sha512-package-order' }
  const full = { integrity: entry.integrity, kind: 'stasis', size: 123, bundle: new Bundle({
    modules: new Map([
      ['vendor/zeta', { name: 'zeta', version: '1', files: { 'a.rs': '1234', 'b.rs': '5678' } }],
      ['vendor/beta', { name: 'beta', version: '1', files: { 'a.rs': '😀' } }],
      ['vendor/aaa', { name: 'aaa', version: '1', files: { 'a.rs': 'a' } }],
      ['vendor/alpha', { name: 'alpha', version: '1', files: { 'a.rs': 'abcd' } }],
    ]),
  }) }
  const cached = parseBundleMetadata(await createBundleMetadata(full), entry.integrity)
  const sourcemap = { integrity: entry.integrity, kind: 'sourcemap', size: 123, json: {
    version: 3,
    sources: ['node_modules/zeta/a.js', 'node_modules/zeta/b.js', 'node_modules/beta/a.js', 'node_modules/aaa/a.js', 'node_modules/alpha/a.js'],
    sourcesContent: ['1234', '5678', '😀', 'a', 'abcd'],
  } }
  state.selectedBundle = entry.integrity
  state.bundles = [entry]
  for (const [details, managedId] of [[full, undefined], [cached, 'managed-bundle'], [sourcemap, undefined]]) {
    state.bundleDetails = details
    for (const [sort, expected] of [
      ['size', ['zeta', 'alpha', 'beta', 'aaa']],
      ['name', ['aaa', 'alpha', 'beta', 'zeta']],
    ]) {
      state.bundleOverviewPackagesSort = sort
      const markup = renderText(renderBundlesList([{ ...entry, managedId }]))
      const header = markup.match(/<header class="bundles-overview-col-head">\s*<span class="bundles-overview-col-title">Packages (.*?)<\/header>/su)[1]
      assert.match(header, /role="group" aria-label="Package order"/u)
      assert.match(header, new RegExp(`aria-pressed=${sort === 'name'}[^>]*>Name<`, 'u'))
      assert.match(header, new RegExp(`aria-pressed=${sort === 'size'}[^>]*>Size<`, 'u'))
      const packages = markup.match(/<ul class="bundles-dist-list">(.*?)<\/ul>/su)[1]
      assert.deepEqual([...packages.matchAll(/class="bundles-dist-pkg"[^>]*>(.*?)<\/(?:span|button)>/gu)].map(match => match[1]), expected)
      assert.equal(state.bundleOverviewFilesSort, 'name')
    }
  }
})

test('Overview and graph classify ordinary directories directly as Own source while preserving packages', async () => {
  const entry = { name: 'app.stasis.code.br', integrity: 'sha512-own-source' }
  const full = { integrity: entry.integrity, kind: 'stasis', size: 123, bundle: new Bundle({
    modules: new Map([
      ['.', { name: 'app', version: '1', files: { 'src/main.js': '1', 'lib/util.js': '2', 'index.js': '3' } }],
      ['node_modules/dep', { name: 'dep', version: '1', files: { 'index.js': '12345678' } }],
      ['packages/shared', { name: 'shared', version: '1', files: { 'index.js': '1234' } }],
    ]),
  }) }
  const cached = parseBundleMetadata(await createBundleMetadata(full), entry.integrity)
  const sourcemap = { integrity: entry.integrity, kind: 'sourcemap', size: 123, json: {
    version: 3,
    sources: ['src/main.js', 'lib/util.js', 'index.js', 'node_modules/dep/index.js', 'node_modules/shared/index.js'],
    sourcesContent: ['1', '2', '3', '12345678', '1234'],
  } }
  state.selectedBundle = entry.integrity
  state.bundles = [entry]
  for (const [details, managedId] of [[full, undefined], [cached, 'managed-bundle'], [sourcemap, undefined]]) {
    state.bundleDetails = details
    const workspace = details === sourcemap ? 'shared' : 'packages/shared'
    for (const sort of ['name', 'size']) {
      state.bundleOverviewPackagesSort = sort
      const markup = renderText(renderBundlesList([{ ...entry, managedId }]))
      assert.match(markup, /Packages <span class="bundles-overview-col-count">3<\/span>/u)
      const distribution = markup.match(/<ul class="bundles-dist-list">(.*?)<\/ul>/su)[1]
      assert.deepEqual([...distribution.matchAll(/class="bundles-dist-pkg"[^>]*>(.*?)<\/(?:span|button)>/gu)].map(match => match[1]), ['Own source', 'dep', workspace])
      assert.match(distribution, /class="bundles-dist-size">3 B<\/span>/u)
    }
    const graph = buildBundleGraphData(details)
    assert.deepEqual(new Set(graph.files.map(graph.options.pkgOf)), new Set(['__own__', 'dep', workspace]))
    assert.deepEqual(graph.ownSourceFiles, new Set(['src/main.js', 'lib/util.js', 'index.js']))
    assert.deepEqual(graph.ownSourcePackages, new Set(details === sourcemap ? ['__own__'] : ['__own__', workspace]))
  }
})

test('full and metadata-only bundle graphs preserve multiple own entry packages separately from own source', async () => {
  const full = { integrity: 'sunflower-entries', kind: 'stasis', size: 123, bundle: new Bundle({
    entries: new Set(['apps/web/index.js', 'apps/cli/index.js', 'node_modules/dep/index.js']),
    modules: new Map([
      ['.', { name: 'app', files: { 'src/helper.js': 'helper' } }],
      ['apps/web', { name: 'web', files: { 'index.js': 'web' } }],
      ['apps/cli', { name: 'cli', files: { 'index.js': 'cli' } }],
      ['packages/shared', { name: 'shared', files: { 'index.js': 'shared' } }],
      ['node_modules/dep', { name: 'dep', version: '1', files: { 'index.js': 'dep' } }],
    ]),
    imports: new Map([['node,import', new Map([
      ['apps/web/index.js', new Map([['shared', 'packages/shared/index.js']])],
      ['apps/cli/index.js', new Map([['shared', 'packages/shared/index.js']])],
      ['packages/shared/index.js', new Map([['web', 'apps/web/index.js']])],
    ])]]),
  }) }
  const cached = parseBundleMetadata(await createBundleMetadata(full), full.integrity)
  for (const details of [full, cached]) {
    const prep = buildBundleGraphData(details)
    assert.deepEqual(prep.ownSourcePackages, new Set(['__own__', 'apps/web', 'apps/cli', 'packages/shared']))
    assert.deepEqual(prep.entryPackages, new Set(['apps/web', 'apps/cli', 'dep']))
    assert.ok(prep.layerRoots.roots.includes('__own__'), 'being a traversal root alone does not make a package an entry')
  }
})

test('Overview and graph retain a sourcemap package identity when its entire directory prefix is stripped', () => {
  const entry = { name: 'dep.map', integrity: 'sha512-single-dependency' }
  state.selectedBundle = entry.integrity
  state.bundleDetails = { integrity: entry.integrity, kind: 'sourcemap', size: 123, json: {
    version: 3, sources: ['node_modules/@scope/dep/index.js', 'node_modules/@scope/dep/helper.js'], sourcesContent: ['dep', 'helper'],
  } }
  const markup = renderText(renderBundlesList([entry]))
  const distribution = markup.match(/<ul class="bundles-dist-list">(.*?)<\/ul>/su)[1]
  assert.match(distribution, />@scope\/dep<\/span>/u)
  assert.doesNotMatch(distribution, /Own source/u)
  const graph = buildBundleGraphData(state.bundleDetails)
  assert.deepEqual(graph.files, ['index.js', 'helper.js'])
  assert.equal(graph.options.pkgOf('index.js'), '@scope/dep')
})

test('Overview package names preserve row grouping in why without requiring advisory access', async t => {
  const previous = { managedSession: state.managedSession, managedTeams: state.managedTeams, currentManagedTeam: state.currentManagedTeam }
  t.after(() => Object.assign(state, previous))
  const entry = { name: 'app.stasis', integrity: 'why-overview', managedId: 'bundle-id' }
  const full = { ...entry, kind: 'stasis', size: 123, bundle: new Bundle({ modules: new Map([
    ['.', { name: 'app', files: { 'index.js': 'app', 'src/index.js': 'own' } }],
    ['node_modules/dep', { name: 'dep', version: '1.0.0', files: { 'index.js': 'one' } }],
    ['node_modules/parent/node_modules/dep', { name: 'dep', version: '2.0.0', files: { 'index.js': 'two' } }],
    ['node_modules/alias', { name: 'real-name', version: '1', files: { 'index.js': 'alias' } }],
    ['vendor/dep', { name: 'dep', ecosystem: 'cargo', version: '3', files: { 'main.rs': 'cargo' } }],
    ['packages/workspace', { name: '@app/workspace', files: { 'index.js': 'workspace' } }],
    ['packages/dep', { name: 'dep', version: '1.0.0', files: { 'index.js': 'workspace dep' } }],
    ['vendor/rand', { name: 'rand', ecosystem: 'cargo', version: '0.8.0', files: { 'main.rs': 'rand' } }],
    ['vendor/rand-0.7.3', { name: 'rand', ecosystem: 'cargo', version: '0.7.3', files: { 'main.rs': 'old rand' } }],
  ]) }) }
  const cached = { ...parseBundleMetadata(await createBundleMetadata(full), entry.integrity), managedId: entry.managedId }
  Object.assign(state, { currentView: 'bundles', selectedBundle: entry.integrity, bundles: [entry],
    managedSession: { role: 'view' }, currentManagedTeam: 'team',
    managedTeams: [{ id: 'team', permissions: { security: false }, bundles: [{ id: entry.managedId }] }] })
  for (const details of [full, cached]) {
    state.bundleDetails = details
    const view = renderBundlesList([entry])
    assert.doesNotMatch(renderText(view), /data-bundle-tab="advisories"/u)
    const buttons = templates(view).filter(template => template.strings.some(s => s.includes('class="bundles-dist-pkg" aria-haspopup="dialog"')))
    assert.equal(buttons.length, 7, 'own-source rows stay text and npm versions share one package link')
    for (const button of buttons) button.values.find(value => typeof value === 'function')()
    const opened = openedWhy.splice(0)
    assert.deepEqual(opened.map(props => props.packageKey).toSorted(), ['@app/workspace', 'cargo:dep', 'cargo:rand', 'cargo:rand', 'dep', 'dep', 'real-name'])
    const expected = new Map([
      ['dep', ['node_modules/dep', 'node_modules/parent/node_modules/dep']],
      ['alias', ['node_modules/alias']], ['vendor/dep', ['vendor/dep']], ['packages/workspace', ['packages/workspace']],
      ['packages/dep', ['packages/dep']], ['vendor/rand', ['vendor/rand']], ['vendor/rand-0.7.3', ['vendor/rand-0.7.3']],
    ])
    for (const props of opened) {
      assert.equal(props.version, undefined)
      assert.equal(props.reason, undefined, 'overview uses the whole bundle')
      assert.equal(props.isCurrent(), true)
      const graph = bundleWhy(props.details, props)
      assert.deepEqual(graph.targets, expected.get(props.packageGroup), 'the popup selects exactly the installations represented by the clicked row')
    }
    const props = opened[0]
    let current
    const dispose = autorun(() => { current = props.isCurrent() })
    try {
      assert.equal(current, true, 'reactive wrappers do not invalidate the current bundle')
      for (const [key, replacement] of [['currentView', 'findings'], ['selectedBundle', 'different-bundle'],
        ['bundleDetails', null], ['currentManagedTeam', 'other-team'], ['managedSession', null], ['currentWorkspace', 'other-workspace']]) {
        const original = state[key]
        state[key] = replacement
        assert.equal(current, false, `close on ${key} change`)
        state[key] = original
        assert.equal(current, true)
      }
    } finally { dispose() }
  }
})

test('sourcemap package labels stay text when dependency metadata is unavailable', () => {
  const entry = { name: 'app.map', integrity: 'why-sourcemap' }
  Object.assign(state, { currentView: 'bundles', selectedBundle: entry.integrity, bundles: [entry], bundleDetails: {
    kind: 'sourcemap', integrity: entry.integrity, size: 10,
    json: { version: 3, sources: ['node_modules/dep/index.js'], sourcesContent: ['dep'] },
  } })
  const markup = renderText(renderBundlesList([entry]))
  assert.match(markup, /<span class="bundles-dist-pkg"[^>]*>dep<\/span>/u)
  assert.doesNotMatch(markup, /<button[^>]*class="bundles-dist-pkg"/u)
})

test('aggregate issue badges respect shared-ignore scope for the same finding id', t => {
  const id = 'shared-ignore-issue-badge'
  const previous = state.triage.get(id)
  t.after(() => previous === undefined ? state.triage.delete(id) : state.triage.set(id, previous))
  const dependency = { id, file: 'node_modules/pkg/index.js', isApp: false, severity: 'high', line: 1, description: 'Shared issue' }
  const own = { ...dependency, file: 'src/index.js' }
  const app = { ...dependency, isApp: true }
  for (const kind of ['bundle', 'package', 'repository']) {
    state.triage.set(id, { triage: 'ignored', ignoredReports: ['dependency.json'] })
    for (const finding of [dependency, own, app]) {
      const text = renderText(renderIssuesGroupedByFile(new Map([[finding.file, [finding]]]), { kind }))
      assert.match(text, /Shared issue/u, `${kind}: the issue remains visible`)
      if (finding === dependency) assert.doesNotMatch(text, /bundle-issues-finding-triage/u, `${kind}: dependency ignores are per report`)
      else assert.match(text, /triage-ignored>Ignored<\/span>/u, `${kind}: App/own shared ignore is shown`)
    }
    state.triage.set(id, { triage: 'fixed' })
    const text = renderText(renderIssuesGroupedByFile(new Map([[dependency.file, [dependency]]]), { kind }))
    assert.match(text, /triage-fixed>FIXED<\/span>/u, `${kind}: other shared statuses still apply to dependencies`)
  }
})

test('same-ID App and dependency findings remain selectable in package and bundle triage views', async t => {
  const { saveFile, deleteFile } = await import('../client/storage.js')
  const { ensureBundleFindingsIndexed, findingsForFileHash } = await import('../client/bundle-finding-index.js')
  const { renderPackagesView } = await import('../ui/view/render-packages.js')
  const previous = { shownTriage: state.shownTriage, selectedPackage: state.selectedPackage }
  t.after(() => Object.assign(state, previous))
  state.selectedPackage = null
  for (const reverse of [false, true]) {
    const pkg = `aggregate-scope-${reverse}`
    const file = `node_modules/${pkg}/a.js`, hash = `hash-${pkg}`
    const dep = { id: pkg, file, fileHash: hash, isApp: false, severity: 'high', description: 'Scope regression',
      package: { npm: { name: pkg, version: '1.0.0' } } }
    const app = { ...dep, isApp: true }
    const name = `${pkg}.json`
    await saveFile(name, JSON.stringify({ findings: reverse ? [dep, app] : [app, dep] }))
    t.after(async () => { await deleteFile(name); state.triage.delete(pkg) })
    await ensureBundleFindingsIndexed()
    state.triage.set(pkg, { triage: 'ignored' })
    const details = { kind: 'sourcemap', integrity: pkg, fileHashes: new Map([[file, hash]]),
      json: { version: 3, sources: [file], sourcesContent: ['source'] } }
    for (const triage of [null, 'ignored']) {
      state.shownTriage = triage
      assert.ok(renderText(renderPackagesView()).includes(`data-select-package=${pkg}`), `package remains visible in ${triage ?? 'live'}`)
      const graph = buildBundleGraphData(details)
      assert.equal([...graph.fileFindings.values()].flat().length, 1, `graph keeps the matching scope in ${triage ?? 'live'}`)
    }
    const markup = renderText(renderIssuesGroupedByFile(new Map([[file, findingsForFileHash(hash)]]), { kind: 'package', bucketKey: pkg }))
    assert.equal((markup.match(/class="bundle-issues-finding"/gu) ?? []).length, 2)
    assert.equal((markup.match(/triage-ignored>Ignored/gu) ?? []).length, 1)
  }
})
