import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import './_polyfills.js'
import '../ui/view/frontend-install.js'
import { Bundle } from '@exodus/stasis-core/bundle'
import { langForPath } from '../common/code-language.js'
import { createBundleMetadata, parseBundleMetadata } from '../ui/view/bundle-metadata.js'

// Keep the real modal and bundle source rendering without unrelated page
// navigation, tooltip listeners, or asynchronous syntax highlighting.
mock.module('../ui/view/render.js', { namedExports: { render() {} } })
mock.module('../ui/view/dom.js', { namedExports: { report: null } })
mock.module('../ui/view/scan-navigation.js', { namedExports: { canScanBundle: () => false, openScan() {} } })
mock.module('../ui/view/ingest.js', { namedExports: { bundleKind: name => name.endsWith('.br') ? 'stasis' : null } })
mock.module('../ui/view/tooltip.js', { namedExports: { hideTooltip() {}, showTooltip() {} } })
// Advisory popups have separate tests; keep their browser-only dependencies out of source rendering.
mock.module('../ui/view/dialogs/advisory-details-dialog.js', { exports: { openAdvisoryDetailsDialog() {} } })
mock.module('../ui/view/dialogs/dependency-chains-dialog.js', { exports: { openDependencyChainsDialog() {} } })
const highlightCalls = []
mock.module('../ui/view/prism-highlight.js', { namedExports: { langForPath, langForTag: () => null, highlight: (content, lang) => { highlightCalls.push({ content, lang }); return Promise.resolve(null) } } })
mock.module('lit/directives/repeat.js', { namedExports: { repeat: (items, _key, template) => items.map(template) } })
const { state } = await import('../client/state.ts')
const { renderBundleSourceModal, renderBundlesList } = await import('../ui/view/render-bundle.js')

function renderText(value) {
  if (Array.isArray(value)) return value.map(renderText).join('')
  if (value?.strings) return value.strings.map((text, index) => text + renderText(value.values[index])).join('')
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

beforeEach(() => {
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
  assert.match(soldeerRows[0], /data-tooltip=dependencies\/@openzeppelin-contracts-5\.2\.0>/u)
  assert.match(rail, /data-bundle-view-source=dependencies\/@openzeppelin-contracts-5\.2\.0\/contracts\/Token\.sol/u)
  const composerRows = rail.match(/<summary\b[^>]*>.*?<\/summary>/gsu).filter(row => row.includes('class="bundle-code-tree-composer"')).join('')
  assert.match(composerRows, /class="bundle-code-tree-package-name">org\/package<\/span><span class="bundle-code-tree-package-version">- 1\.2\.3<\/span>/u)
  assert.match(composerRows, /class="bundle-code-tree-package-name">org\/dirs<\/span><span class="bundle-code-tree-package-version">- dev-main<\/span>/u)
  assert.match(composerRows, /data-tooltip=vendor\/org\/package\/src>/u)
  assert.match(composerRows, /data-tooltip=vendor\/org\/dirs>/u)
  assert.match(composerRows, /data-tooltip=vendor\/org\/root>/u)
  assert.doesNotMatch(composerRows, /data-tooltip=vendor\/org\/(?:dirs|root)\/src>/u)
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
    for (const attr of ['data-tooltip-package=actual-package', 'data-tooltip-version=1.2.3', 'data-tooltip-files=3', 'data-tooltip-repo=org/actual-package', 'data-tooltip=node_modules/alias>']) assert.ok(pkg.includes(attr), attr)
  }
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
      assert.deepEqual([...packages.matchAll(/class="bundles-dist-pkg"[^>]*>(.*?)<\/span>/gu)].map(match => match[1]), expected)
      assert.equal(state.bundleOverviewFilesSort, 'name')
    }
  }
})
