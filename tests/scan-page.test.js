import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import './_polyfills.js'
import { scanScopeOptions } from '../ui/scan/scopes.js'
import { duplicateRegimes, normalizeRegimes } from '../ui/scan/regimes.js'
import { RegimeEditor } from '../ui/scan/regime-editor.js'
import { storedScanBundle, storedScanSource } from '../ui/scan/bundle-source.js'
import { codeScanFiles, sourceMetrics, sourceStats } from '../ui/scan/metrics.js'
import { appFindingCount, linkableReport, localReportSources, managedReportSources } from '../ui/scan/report-source.js'
import { ReportInputs } from '../ui/scan/report-inputs.js'
import { ScanPage } from '../ui/scan/page.js'
import { templateText as renderText } from './_lit.js'
import { cloneScanFixtures } from '../ui/scan/fixtures.js'
import { bundleOptions } from '../ui/view/bundle-selector.js'
import { createBundleMetadata, parseBundleMetadata } from '../ui/view/bundle-metadata.js'
import { createBundleSummary } from '../common/bundle-metadata.js'

describe('Scan scopes', () => {
  test('recognized scope options use fixed order and subtitles while preserving bundle IDs', () => {
    const options = scanScopeOptions([{ id: 'all' }, { id: 'reason:add' }, { id: 'reason:metro' }, { id: 'reason:run' }])
    assert.deepEqual(options, [
      { id: '', label: 'All files', subtitle: 'Everything' },
      { id: 'reason:metro', label: 'metro', subtitle: 'Metro bundle contents' },
      { id: 'reason:run', label: 'run', subtitle: 'Bundler and Node.js CLI' },
      { id: 'reason:add', label: 'add', subtitle: 'Manually added files' },
    ])
    assert.deepEqual(scanScopeOptions([{ id: 'run' }]).map(option => option.id), ['', 'run'])
    assert.equal(scanScopeOptions([{ id: 'reason:add' }, { id: 'reason:run' }])[1].subtitle, 'Node.js CLI')
    assert.equal(scanScopeOptions([{ id: 'all' }]), null)
    assert.equal(scanScopeOptions([{ id: 'reason:run' }, { id: 'reason:custom-build' }]), null)
    assert.equal(scanScopeOptions([{ id: 'metro' }, { id: 'reason:metro' }]), null)
    assert.deepEqual(scanScopeOptions([{ id: 'reason:extra' }, { id: 'reason:bundle' }, { id: 'reason:bundle:metro' }]), [
      { id: '', label: 'All files', subtitle: 'Everything' },
      { id: 'reason:bundle:metro', label: 'bundle:metro', subtitle: 'Metro bundle contents (static)' },
      { id: 'reason:bundle', label: 'bundle', subtitle: 'Static code bundle' },
      { id: 'reason:extra', label: 'extra', subtitle: 'Extra files' },
    ], 'a static build\'s, each beside the one a capture names')
    assert.deepEqual(scanScopeOptions([{ id: 'reason:extra' }, { id: 'reason:run' }, { id: 'reason:metro' }]).map(option => option.label), ['All files', 'metro', 'run', 'extra'])
  })

  test('scope selection keeps exact file sets and clears old manual exclusions', () => {
    const page = new ScanPage()
    page.source = { bundles: [{ id: 'bundle', repoId: 'repo', filename: 'app.stasis', files: [
      { path: 'app.js', module: '__own__', bytes: 10 }, { path: 'cli.js', module: '__own__', bytes: 20 }, { path: 'manual.js', module: '__own__', bytes: 30 },
    ], reasons: [{ id: 'all', filePaths: null }, { id: 'reason:metro', filePaths: ['app.js'] }, { id: 'reason:run', filePaths: ['cli.js'] }, { id: 'reason:add', filePaths: ['manual.js'] }] }] }
    page.willUpdate(new Map([['source', null]]))
    for (const [scope, path] of [['metro', 'app.js'], ['run', 'cli.js'], ['add', 'manual.js']]) {
      page._excluded.add(path)
      page._excludedModules.add('__own__')
      page._changeReason(`reason:${scope}`)
      assert.deepEqual(page._files.map(file => file.path), [path])
      assert.equal(page._excluded.size, 0)
      assert.equal(page._excludedModules.size, 0)
    }
    page._changeReason('')
    assert.equal(page._files.length, 3)
  })


  test('dependency alerts show the reason selector without a source filter and preserve it on restart', () => {
    const page = new ScanPage()
    page.source = { bundles: [{ id: 'bundle', repoId: 'repo', filename: 'app.stasis', files: [
      { path: 'app.js', module: '__own__', bytes: 10 },
      { path: 'node_modules/dep/index.js', module: 'dep', bytes: 20 },
      { path: 'node_modules/tool/data.bin', format: 'resource:base64', module: 'tool', bytes: 30 },
    ], reasons: [{ id: 'all', label: 'All', filePaths: null }, { id: 'reason:metro', label: 'metro', filePaths: ['app.js', 'node_modules/dep/index.js'] }, { id: 'reason:run', label: 'run', filePaths: ['node_modules/tool/data.bin'] }] }] }
    page.willUpdate(new Map([['source', null]]))
    page._changeMode('dependencies')
    const text = renderText(page._newScan())
    assert.match(text, /bundle-scope-selector/u)
    assert.doesNotMatch(text, /Source filter|package-pane|file-panel/u)
    page._changeReason('reason:run')
    assert.deepEqual(page._scopeFiles.map(file => file.path), ['node_modules/tool/data.bin'], 'dependency scopes retain resource-only packages')
    page._runScan()
    const scan = page._scans[0]
    assert.equal(scan.files, 1)
    assert.equal(scan.reason, 'run')
    assert.equal(scan.scopeId, 'reason:run')
    page._stopScan(scan)
    page._changeReason('reason:metro')
    page._restartScan(scan)
    assert.equal(page._mode, 'dependencies')
    assert.equal(page._reason, 'reason:run')
    page._changeReason('')
    assert.equal(page._scopeFiles.length, 3)
    for (const timer of page._timers) clearTimeout(timer)
  })


  test('link reports navigation opens Reports → Link before and after scan sources load', () => {
    const page = new ScanPage()
    page._tab = 'history'
    page._reportMode = 'merge'
    page.selection = { mode: 'report', reportMode: 'link' }
    page.willUpdate(new Map([['selection', null]]))
    assert.equal(page._tab, 'new')
    assert.equal(page._mode, 'report')
    assert.equal(page._reportMode, 'link')
    assert.equal(page._notice, null)
    page.source = { bundles: [{ id: 'bundle', repoId: 'repo', filename: 'bundle.stasis', reasons: [] }] }
    page.willUpdate(new Map([['source', null]]))
    assert.equal(page._mode, 'report')
    assert.equal(page._reportMode, 'link')
    assert.equal(page._notice, null)
  })
})

describe('Scan regimes', () => {
  const catalogue = { defaultModel: 'model-a', models: [
    { id: 'model-a', efforts: ['low', 'high'] }, { id: 'model-b', efforts: ['medium', 'max'] },
  ] }
  const regime = { mode: 'generic', model: 'model-a', effort: 'high', isolate: false }

  test('regime validation preserves duplicates and compares the entire mode/model/effort/search tuple', () => {
    const rows = [regime, { ...regime }, { ...regime, mode: 'security' }, { ...regime, model: 'model-b', effort: 'max' },
      { ...regime, effort: 'low' }, { ...regime, isolate: true }]
    assert.deepEqual(duplicateRegimes(normalizeRegimes(rows, catalogue)), [false, true, false, false, false, false])
    assert.equal(normalizeRegimes([], catalogue).length, 1)
    assert.deepEqual(normalizeRegimes([], { models: [] }), [])
  })

  test('Add regime copies the last row, labels duplicates, and blocks running without silently changing settings', async () => {
    const editor = new RegimeEditor()
    editor.value = [regime]
    editor.loadModels = () => Promise.resolve(catalogue)
    let latest
    editor.addEventListener('regimes-change', e => { latest = e.detail })
    await editor._load()
    assert.deepEqual(latest, { value: [regime], ready: true, appModel: { model: 'model-a', effort: 'high' }, appModelAutomatic: true })
    editor._remove(editor._rows[0].id)
    assert.equal(editor._rows.length, 1)
    editor._add()
    assert.deepEqual(latest.value, [regime, regime])
    assert.equal(latest.ready, false)
    assert.notEqual(editor._rows[0].id, editor._rows[1].id)
    editor._change(editor._rows[1].id, { isolate: true })
    assert.equal(latest.ready, true)
    editor._add()
    assert.equal(latest.value[2].isolate, true, 'copy the last row, not the first')
    assert.equal(latest.ready, false)
    editor._change(editor._rows[2].id, { effort: 'low' })
    assert.equal(latest.ready, true)
    editor._change(editor._rows[2].id, { effort: 'high' })
    assert.equal(latest.value[2].effort, 'high', 'retain a duplicate edit for the user to correct')
    assert.equal(latest.ready, false)
    editor._remove(editor._rows[2].id)
    assert.equal(latest.ready, true)
  })

  test('provider changes revalidate unsupported models/efforts without removing rows; stale catalogue loads cannot enable Run', async () => {
    const editor = new RegimeEditor()
    editor.value = [regime, { ...regime, model: 'model-b', effort: 'max' }]
    let latest
    editor.addEventListener('regimes-change', e => { latest = e.detail })
    editor.loadModels = () => Promise.resolve(catalogue)
    await editor._load()
    const pending = []
    editor.loadModels = signal => new Promise(resolve => { pending.push({ signal, resolve }) })
    const first = editor._load()
    assert.equal(latest.ready, false)
    const second = editor._load()
    assert.equal(pending[0].signal.aborted, true)
    pending[1].resolve({ defaultModel: 'only', models: [{ id: 'only', efforts: ['max'] }] })
    await second
    assert.equal(editor._rows.length, 2)
    assert.deepEqual(latest.value.map(row => [row.model, row.effort]), [['only', 'max'], ['only', 'max']])
    assert.equal(latest.ready, false, 'model filtering can create a duplicate and must block Run')
    pending[0].resolve(catalogue)
    await first
    assert.equal(editor._rows[0].model, 'only')
    editor._change(editor._rows[1].id, { mode: 'correctness' })
    assert.equal(latest.ready, true)
    editor.loadModels = () => Promise.reject(new Error('offline'))
    await editor._load()
    assert.equal(latest.ready, false)
    assert.match(editor._error, /offline/u)
  })

  test('Advanced scan records and restores every regime, and reselecting Advanced does not block a ready editor', () => {
    const page = new ScanPage()
    page.source = { bundles: cloneScanFixtures() }
    page.willUpdate(new Map([['source', null]]))
    page._options = { ...page._options, ...regime, analyzer: 'security' }
    page._setOption('analyzer', 'advanced')
    assert.equal(page._regimes[0].mode, 'security')
    page._regimes = [regime, { ...regime, isolate: true }]
    page._regimesReady = false
    page._runScan()
    assert.equal(page._scans.length, 0)
    page._regimesReady = true
    page._setOption('analyzer', 'advanced')
    assert.equal(page._regimesReady, true)
    page._runScan()
    for (const timer of page._timers) clearTimeout(timer)
    const scan = page._scans[0]
    assert.deepEqual(scan.regimes, [regime, { ...regime, isolate: true }])
    assert.notEqual(scan.regimes, page._regimes)
    page._restartScan(scan)
    assert.deepEqual(page._regimes, scan.regimes)
    assert.equal(page._regimesReady, false)
    assert.equal(page._options.analyzer, 'advanced')
    assert.equal(page._reason, scan.scopeId)
    page._setOption('analyzer', 'correctness')
    page._runScan()
    for (const timer of page._timers) clearTimeout(timer)
    const basic = page._scans[0]
    page._setOption('analyzer', 'advanced')
    page._restartScan(basic)
    assert.equal(page._options.analyzer, 'correctness', 'restarting a basic run leaves Advanced')
  })

  test('App model follows agreement, expands on differences, and preserves an independent selection', async () => {
    const editor = new RegimeEditor()
    editor.value = [regime, { ...regime, mode: 'security' }]
    editor.loadModels = () => Promise.resolve(catalogue)
    await editor._load()
    assert.deepEqual(editor._resolvedAppModel, { model: 'model-a', effort: 'high' })
    assert.equal(editor._appModelOpen, false)
    editor._appModelOpen = true
    editor._change(editor._rows[1].id, { isolate: true })
    assert.equal(editor._appModelOpen, true, 'manual expansion survives unrelated edits')
    editor._appModelOpen = false
    editor._change(editor._rows[1].id, { effort: 'low' })
    assert.equal(editor._appModelOpen, true, 'effort disagreement reveals the app controls')
    assert.deepEqual(editor._resolvedAppModel, { model: 'model-a', effort: 'high' })
    editor._change(editor._rows[0].id, { effort: 'low' })
    assert.equal(editor._appModelOpen, false)
    assert.equal(editor._resolvedAppModel.effort, 'low')
    editor._changeAppModel({ model: 'model-b', effort: 'max' })
    assert.equal(editor._appModelOpen, true)
    assert.deepEqual(editor._rows.map(row => row.model), ['model-a', 'model-a'], 'the app model does not rewrite scan regimes')
    editor._change(editor._rows[0].id, { effort: 'high' })
    editor._remove(editor._rows[1].id)
    assert.deepEqual(editor._resolvedAppModel, { model: 'model-b', effort: 'max' }, 'an explicit app choice survives regime edits')
    editor.loadModels = () => Promise.resolve({ models: [{ id: 'replacement', efforts: [] }] })
    await editor._load()
    assert.deepEqual(editor._resolvedAppModel, { model: 'replacement', effort: null })
    assert.deepEqual(editor.appModel, editor._resolvedAppModel, 'provider changes revalidate the explicit app choice')
  })

  test('Advanced runs snapshot and restore the independent app model and effort', () => {
    const page = new ScanPage()
    page.source = { bundles: cloneScanFixtures() }
    page.willUpdate(new Map([['source', null]]))
    page._setOption('analyzer', 'advanced')
    page._regimes = [regime]
    page._regimesReady = true
    page._appModel = { model: 'model-b', effort: 'max' }
    page._appModelAutomatic = false
    page._runScan()
    for (const timer of page._timers) clearTimeout(timer)
    const scan = page._scans[0]
    assert.deepEqual(scan.appModel, { model: 'model-b', effort: 'max' })
    assert.notEqual(scan.appModel, page._appModel)
    assert.equal(scan.appModelAutomatic, false)
    page._appModel = null
    page._appModelAutomatic = true
    page._restartScan(scan)
    assert.deepEqual(page._appModel, scan.appModel)
    assert.equal(page._appModelAutomatic, false)
  })

  test('restoring a mixed regime list preserves its automatic app choice until the regimes agree again', async () => {
    const editor = new RegimeEditor()
    editor.value = [regime, { ...regime, model: 'model-b', effort: 'max' }]
    editor.appModel = { model: 'model-b', effort: 'max' }
    editor.loadModels = () => Promise.resolve(catalogue)
    let latest
    editor.addEventListener('regimes-change', event => { latest = event.detail })
    await editor._load()
    assert.deepEqual(latest.appModel, { model: 'model-b', effort: 'max' })
    assert.equal(latest.appModelAutomatic, true)
    assert.equal(editor._appModelOpen, true)
    editor._remove(editor._rows[1].id)
    assert.deepEqual(latest.appModel, { model: 'model-a', effort: 'high' })
    assert.equal(editor._appModelOpen, false)
  })
})

describe('Agentic scans', () => {
  test('Agentic retains ordered prompts through editing, removal, and restart, with at least one field', () => {
    const page = new ScanPage()
    page.source = { bundles: cloneScanFixtures() }
    page.willUpdate(new Map([['source', null]]))
    page._mode = 'agentic'
    page._removePrompt(page._prompts[0].id)
    assert.equal(page._prompts.length, 1)
    // Rendering/focus is exercised in the browser; adding updates the list
    // synchronously before waiting for the next render.
    void page._addPrompt()
    void page._addPrompt()
    assert.equal(page._prompts.length, 3)
    assert.equal(new Set(page._prompts.map(prompt => prompt.id)).size, 3)
    assert.equal(page._promptPlaceholder(1), 'What should the second agent focus on?')
    assert.equal(page._promptPlaceholder(2), 'What should the third agent focus on?')
    page._prompts = page._prompts.map((prompt, index) => ({ ...prompt, text: `Instructions ${index + 1}` }))
    page._removePrompt(page._prompts[1].id)
    page._runScan()
    for (const timer of page._timers) clearTimeout(timer)
    const scan = page._scans[0]
    assert.deepEqual(scan.prompts, ['Instructions 1', 'Instructions 3'])
    page._prompts = []
    page._restartScan(scan)
    assert.deepEqual(page._prompts.map(prompt => prompt.text), scan.prompts)
  })
})

describe('Scan Code inputs', () => {
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
    assert.deepEqual(createBundleSummary(full, metadata), { files: 3, codeFiles: 2, lines: 1, stasisVersion: 1 })
    assert.deepEqual(createBundleSummary(resourceBundle()), { files: 3, codeFiles: 2, lines: 1, stasisVersion: 1 }, 'summary backfills need no file hashes or full metadata')
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

  test('a selected bundle shows its catalogue counts while loading, and they match the loaded inventory', async () => {
    const full = resourceBundle()
    const summary = createBundleSummary(full, await createBundleMetadata(full))
    const pending = { ...storedScanSource([{ name: 'resources.stasis', integrity: full.integrity }]).bundles[0], size: '8.8 KiB', summary }
    const loaded = storedScanBundle(pending, full)
    for (const mode of ['code', 'dependencies', 'agentic']) {
      const files = mode === 'code' ? codeScanFiles(loaded.files) : loaded.files
      const after = sourceStats(loaded, files, mode)
      assert.deepEqual(sourceStats(pending, [], mode), { ...after, packages: null }, mode)
    }
    assert.deepEqual(sourceStats({ ...pending, summary: null }, [], 'code'), { files: null, lines: null, packages: null })
    assert.deepEqual(sourceStats({ ...pending, summary: { files: -1, codeFiles: 1.5, lines: '7' } }, [], 'code'), { files: null, lines: null, packages: null })

    const page = new ScanPage()
    page.source = { bundles: [pending] }
    page.willUpdate(new Map([['source', null]]))
    const text = value => Array.isArray(value) ? value.map(text).join('')
      : value?.strings ? value.strings.map((part, index) => part + text(value.values[index])).join('') : value == null || typeof value !== 'string' && typeof value !== 'number' ? '' : String(value)
    const stats = text(page._sourcePanel(page._bundle, page._files)).match(/aria-label="Bundle statistics">(.*?)<\/div><\/div>/su)[1]
      .replaceAll(/<[^>]*>/gu, ' ').replaceAll(/\s+/gu, ' ').trim()
    assert.equal(stats, '8.8 KiB bundle size 2 files 1 LoC — packages')
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
})

describe('Scan report inputs', () => {
  const reportText = (repo, findings = [{ title: 'Finding' }]) => JSON.stringify({ source: 'claude-security', repo: { github: repo }, findings })

  test('Link requires an application-layer finding using the report library source and revalidation rules', () => {
    const eligible = [
      { source: 'claude-security', findings: [{ title: 'External' }] },
      { findings: [{ revalidate: 'revalidation' }] },
      { groups: [[{ title: 'Source' }, { revalidate: 'revalidation' }]] },
      { groups: [[{ source: 'codex-security' }]] },
    ]
    const ineligible = [
      { source: 'claude-security', findings: [] },
      { source: 'claude-security', findings: [null, 'not a finding'] },
      { findings: [{ title: 'Source only' }] },
      { findings: [{ isApp: true }] },
      { findings: [{ revalidate: 'verdict' }] },
      { findings: [{ revalidate: 'validation' }] },
      { groups: [[{ title: 'No stamp' }]] },
      { source: 'claude-security', findings: [{ source: 'deepview' }] },
    ]
    for (const data of eligible) assert.ok(linkableReport(JSON.stringify(data)))
    for (const data of ineligible) assert.equal(linkableReport(JSON.stringify(data)), null)
    const sources = localReportSources([...eligible, ...ineligible].map((data, index) => ({ name: `report-${index}`, content: JSON.stringify(data) })), [])
    assert.equal(sources.link.reports.length, eligible.length)
    assert.equal(appFindingCount({ findings: [{ title: 'Source' }, { revalidate: 'revalidation' }, { revalidate: 'verdict' }] }), 1)
    assert.equal(appFindingCount({ source: 'claude-security', groups: [[{ title: 'One' }, { title: 'Duplicate' }], [{ title: 'Two' }]] }), 2)
    assert.equal(sources.link.reports[0].appFindings, 1)
    assert.equal('size' in sources.link.reports[0], false)
  })

  test('local Link inputs use stored reports and exact workspace memberships, while Merge stays empty', () => {
    const source = localReportSources([
      { name: 'one.json', content: reportText('https://github.com/acme/app.git'), fallbackRepo: 'wrong/repo' },
      { name: 'two.json', content: reportText(null, [{ id: 'two', file: 'src/main.js' }]), fallbackRepo: 'acme/worker' },
      { name: 'unattached.json', content: reportText(null) },
      { name: 'links.json', content: JSON.stringify([{ ids: ['one', 'two'] }]) },
      { name: 'invalid.json', content: '{}' },
    ], [
      { id: 'work-1', name: 'One', privateKey: 'never-copy', reports: ['one.json', 'two.json', 'missing.json', 'links.json'] },
      { id: 'work-2', name: 'Two', reports: ['one.json', 'unattached.json'] },
      { id: 'empty-workspace', name: 'Empty', reports: ['missing.json'] },
    ])
    assert.deepEqual(source.merge, { bundles: [], results: [] })
    assert.deepEqual(source.link.reports.map(report => report.id), ['one.json', 'two.json', 'unattached.json'])
    assert.deepEqual(source.link.repositories, [{ id: 'acme/app', label: 'acme/app' }, { id: 'acme/worker', label: 'acme/worker' }])
    assert.deepEqual(source.link.workspaces, [
      { id: 'work-1', label: 'One', reports: ['one.json', 'two.json'] },
      { id: 'work-2', label: 'Two', reports: ['one.json', 'unattached.json'] },
    ])
  })

  test('reports without a repository header can name multiple own-code repositories, excluding dependencies', () => {
    const source = localReportSources([{ name: 'many.json', content: reportText(null, [
      { file: 'src/a.js', repo: { github: 'acme/a' } },
      [{ file: 'src/b.js', repo: { github: 'https://github.com/acme/b' } }],
      { file: 'node_modules/dep/a.js', repo: { github: 'vendor/dependency' } },
    ]) }], [])
    assert.deepEqual(source.link.reports[0].repoIds, ['acme/a', 'acme/b'])
  })

  test('managed Merge results are independent of report visibility; Link contains only visible reports', () => {
    const source = managedReportSources({ reports: [
      { id: 'hidden', repoId: 1, visible: false },
      { id: 'visible', filename: 'saved.json', repoId: 1, repoFullName: 'acme/app', visible: true, byteSize: 1024, content: reportText('acme/app') },
      { id: 'source-only', repoId: 1, visible: true, content: JSON.stringify({ findings: [{ title: 'No revalidation' }] }) },
      { id: 'not-readable', repoId: 1, visible: true },
      { id: 'unassigned', repoId: null, visible: true },
    ], repos: [{ repoId: 1, fullName: 'acme/app' }, { repoId: 2, fullName: 'acme/empty' }] }, {
      bundles: [{ id: 'bundle', filename: 'app.zip', kind: 'sourcemaps' }, { id: 'no-results' }],
      results: [{ id: 'unsaved-result', bundleId: 'bundle', findings: 8 }],
    })
    assert.deepEqual(source.link.reports.map(report => report.id), ['visible'])
    assert.equal(source.link.reports[0].appFindings, 1)
    assert.equal('size' in source.link.reports[0], false)
    assert.deepEqual(source.link.repositories, [{ id: 1, label: 'acme/app' }])
    assert.equal('workspaces' in source.link, false)
    assert.deepEqual(source.merge.results.map(result => result.id), ['unsaved-result'])
    assert.deepEqual(source.merge.bundles.map(bundle => bundle.id), ['bundle'])
    assert.equal(bundleOptions(source.merge.bundles)[0].format, 'sourcemap')
  })

  function inputs() {
    const component = new ReportInputs()
    component.mode = 'merge'
    component._sources = {
      merge: { bundles: [{ id: 'bundle-1', filename: 'one.stasis' }, { id: 'bundle-2', filename: 'two.stasis' }],
        results: [{ id: 'result-1', bundleId: 'bundle-1' }, { id: 'result-2', bundleId: 'bundle-1' }, { id: 'result-3', bundleId: 'bundle-2' }] },
      link: { repositories: [{ id: 1, label: 'acme/one' }, { id: 2, label: 'acme/two' }],
        workspaces: [{ id: 'workspace-1', label: 'Workspace', reports: ['report-1', 'report-3'] }, { id: 'empty', label: 'Empty', reports: [] }],
        reports: [{ id: 'report-1', repoIds: [1] }, { id: 'report-2', repoIds: [1] }, { id: 'report-3', repoIds: [2] }] },
    }
    return component
  }

  const selectedIds = component => component.selection.inputs.map(input => input.id)

  test('Merge selects all results for the chosen bundle and prevents cross-bundle selection', () => {
    const component = inputs()
    assert.deepEqual(selectedIds(component), [])
    component._selectSource('bundle-1')
    assert.deepEqual(selectedIds(component), ['result-1', 'result-2'])
    component._toggle('result-3', true)
    assert.deepEqual(selectedIds(component), ['result-1', 'result-2'])
    component._toggle('result-1', false)
    component._selectSource('bundle-1')
    assert.deepEqual(selectedIds(component), ['result-2'])
    component._selectSource('missing')
    assert.deepEqual(selectedIds(component), ['result-2'])
    component._selectSource('bundle-2')
    assert.deepEqual(selectedIds(component), ['result-3'])
    component._selectAll(false)
    assert.deepEqual(selectedIds(component), [])
    component._selectAll(true)
    assert.deepEqual(selectedIds(component), ['result-3'])
  })

  test('Link scopes select all reports, without changing the independent Merge selection', () => {
    const component = inputs()
    component._selectSource('bundle-1')
    component._toggle('result-1', false)
    component.mode = 'link'
    component._changeKind('workspace')
    component._selectSource('workspace-1')
    assert.deepEqual(selectedIds(component), ['report-1', 'report-3'])
    component._toggle('report-2', true)
    assert.deepEqual(selectedIds(component), ['report-1', 'report-3'])
    component._toggle('report-1', false)
    component.mode = 'merge'
    assert.deepEqual(selectedIds(component), ['result-2'])
    component.mode = 'link'
    assert.deepEqual(selectedIds(component), ['report-3'])
    component._changeKind('repository')
    assert.deepEqual(selectedIds(component), [])
    component._selectSource(1)
    assert.deepEqual(selectedIds(component), ['report-1', 'report-2'])
    component._changeKind('workspace')
    component._selectSource('empty')
    assert.deepEqual(selectedIds(component), ['report-1', 'report-3'])
    assert.deepEqual(component._parents.map(parent => parent.id), ['workspace-1'])
  })

  test('Link auto-selects a sole workspace or repository, without undoing deselection or choosing among multiple scopes', async () => {
    const component = inputs()
    component.mode = 'link'
    component._changeKind('repository')
    assert.equal(component.selection.source, null)
    assert.deepEqual(component._scopeOptions.map(option => option.detail), ['2 reports', '1 report'])
    component._changeKind('workspace')
    assert.equal(component.selection.source.id, 'workspace-1')
    assert.deepEqual(selectedIds(component), ['report-1', 'report-3'])
    component._selectAll(false)
    component._changeKind('workspace')
    assert.deepEqual(selectedIds(component), [])
    component._sources.link.reports = [{ id: 'report-1', repoIds: [1] }]
    component._changeKind('repository')
    assert.deepEqual(component.selection.source.ids, [1])
    assert.deepEqual(selectedIds(component), ['report-1'])
    component.loadSources = () => Promise.resolve(component._sources)
    await component._load()
    assert.equal(component.selection.source.id, 'workspace-1')
    assert.deepEqual(selectedIds(component), ['report-1'])
  })

  test('managed Link rejects workspace scopes and restored inputs stay within their original source', () => {
    const component = inputs()
    component.mode = 'link'
    delete component._sources.link.workspaces
    component._changeKind('workspace')
    assert.equal(component._current.kind, 'repository')
    component.restore = { mode: 'link', source: { kind: 'repository', id: 1 }, inputIds: ['report-2', 'report-3', 'deleted'] }
    component._restore()
    assert.deepEqual(selectedIds(component), ['report-2'])
    component.restore = { mode: 'link', source: { kind: 'repository', id: 99 }, inputIds: ['report-2'] }
    component._restore()
    assert.deepEqual(selectedIds(component), [])
    assert.equal(component.selection.source, null)
  })

  test('Link combines repositories once and preserves report choices when adding, replacing, and removing rows', () => {
    const component = inputs()
    component.mode = 'link'
    component._sources.link.repositories.push({ id: 3, label: 'acme/three' })
    component._sources.link.reports.push({ id: 'shared', repoIds: [1, 2] }, { id: 'report-4', repoIds: [3] })
    component._addRepository()
    assert.deepEqual(component._current.sourceIds, [null], 'choose the initial repository before adding another')
    component._selectSource(1)
    component._toggle('report-1', false)
    component._toggle('shared', false)
    component._addRepository()
    component._addRepository()
    assert.deepEqual(component._current.sourceIds, [1, null], 'only one empty picker at a time')
    component._selectSource(1, 1)
    component._selectSource(99, 1)
    assert.deepEqual(component._current.sourceIds, [1, null], 'reject duplicate and unavailable repositories')
    component._selectSource(2, 1)
    assert.deepEqual(component._inputs.map(input => input.id), ['report-1', 'report-2', 'report-3', 'shared'])
    assert.deepEqual(selectedIds(component), ['report-2', 'report-3'], 'adding a repository keeps existing deselections')
    assert.deepEqual(component.selection.source, { kind: 'repository', ids: [1, 2], label: 'acme/one, acme/two' })
    component._selectAll(true)
    assert.deepEqual(selectedIds(component), ['report-1', 'report-2', 'report-3', 'shared'], 'shared reports are selected only once')
    component._toggle('report-3', false)
    component._selectSource(3, 0)
    assert.deepEqual(selectedIds(component), ['shared', 'report-4'], 'replacement removes old-only reports and preserves the remaining scope')
    component._removeRepository(0)
    assert.deepEqual(component.selection.source.ids, [2])
    assert.deepEqual(selectedIds(component), ['shared'], 'removal retains shared reports and prior deselections')
    component._removeRepository(0)
    assert.deepEqual(component._current.sourceIds, [2], 'the final picker stays')
    component._selectAll(false)
    assert.deepEqual(selectedIds(component), [])
    component._selectAll(true)
    assert.deepEqual(selectedIds(component), ['report-3', 'shared'])
  })

  test('repository rows retain opaque local/managed IDs and stay independent of Merge and workspace scopes', () => {
    for (const ids of [[1, 2], ['acme/one', 'acme/two']]) {
      const component = inputs()
      component._sources.link.repositories.forEach((repo, index) => { repo.id = ids[index] })
      component._sources.link.reports.forEach(report => { report.repoIds = report.repoIds.map(id => ids[id - 1]) })
      component._selectSource('bundle-1')
      component._toggle('result-1', false)
      component.mode = 'link'
      component._selectSource(ids[0])
      component._addRepository()
      component._selectSource(ids[1], 1)
      assert.equal(component._canAddRepository, false, 'no more rows when all repositories are selected')
      component._addRepository()
      assert.deepEqual(component.selection.source.ids, ids)
      component._loading = true
      component._removeRepository(0)
      assert.deepEqual(component._current.sourceIds, ids)
      assert.deepEqual(selectedIds(component), [])
      component._loading = false
      component.mode = 'merge'
      assert.deepEqual(selectedIds(component), ['result-2'])
      component._addRepository()
      assert.deepEqual(component._current.sourceIds, ['bundle-1'])
      component.mode = 'link'
      assert.deepEqual(component.selection.source.ids, ids)
      component._changeKind('workspace')
      assert.equal(component.selection.source.id, 'workspace-1')
      assert.deepEqual(selectedIds(component), ['report-1', 'report-3'])
      component._addRepository()
      assert.deepEqual(component._current.sourceIds, ['workspace-1'])
    }
  })

  test('multi-repository restarts retain exact inputs and exclude unavailable scopes and reports', () => {
    const component = inputs()
    component.mode = 'link'
    component._selectSource(1)
    component._addRepository()
    component._selectSource(2, 1)
    component._toggle('report-1', false)
    const page = new ScanPage()
    page._mode = 'report'
    page._reportMode = 'link'
    page._reportInput = component.selection
    page._runScan()
    for (const timer of page._timers) clearTimeout(timer)
    const scan = page._scans[0]
    assert.deepEqual(scan.reportSource.ids, [1, 2])
    assert.deepEqual(scan.inputIds, ['report-2', 'report-3'])
    assert.equal(scan.bundleName, 'acme/one, acme/two')
    component._removeRepository(0)
    assert.deepEqual(scan.reportSource.ids, [1, 2], 'editing the form cannot mutate saved settings')
    page._restartScan(scan)
    component.restore = page._reportRestore
    component._restore()
    assert.deepEqual(component.selection.source.ids, [1, 2])
    assert.deepEqual(selectedIds(component), ['report-2', 'report-3'])
    component._sources.link.repositories = component._sources.link.repositories.filter(repo => repo.id !== 1)
    component._restore()
    assert.deepEqual(component.selection.source.ids, [2])
    assert.deepEqual(selectedIds(component), ['report-3'], 'stale reports cannot reintroduce a removed repository')
    component._sources.link.reports = []
    component._restore()
    assert.equal(component.selection.source, null)
    assert.deepEqual(selectedIds(component), [])
  })

  test('stale report-source loads are ignored and loading/errors cannot submit earlier selections', async () => {
    const component = inputs()
    const source = component._sources
    component._selectSource('bundle-1')
    const pending = []
    component.loadSources = signal => new Promise(resolve => { pending.push({ signal, resolve }) })
    const first = component._load()
    assert.deepEqual(selectedIds(component), [])
    const second = component._load()
    assert.equal(pending[0].signal.aborted, true)
    pending[1].resolve(source)
    await second
    component._selectSource('bundle-2')
    pending[0].resolve({})
    await first
    assert.deepEqual(selectedIds(component), ['result-3'])
    component.loadSources = () => Promise.reject(new Error('unavailable'))
    await component._load()
    assert.deepEqual(selectedIds(component), [])
    assert.match(component._error, /unavailable/u)
  })

  test('report scan settings retain the exact submode, source, and selected IDs for restart', () => {
    for (const mode of ['merge', 'link']) {
      const page = new ScanPage()
      page._mode = 'report'
      page._reportMode = mode
      page._reportInput = { mode, source: { kind: mode === 'merge' ? 'bundle' : 'workspace', id: 'scope', label: 'Scope' }, inputs: [{ id: 'second' }, { id: 'fourth' }] }
      page._runScan()
      for (const timer of page._timers) clearTimeout(timer)
      const scan = page._scans[0]
      assert.deepEqual(scan.inputIds, ['second', 'fourth'])
      assert.equal(scan.reportMode, mode)
      assert.equal(scan.bundleId, mode === 'merge' ? 'scope' : null)
      page._restartScan(scan)
      assert.deepEqual(page._reportRestore, { mode, source: page._reportInput?.source ?? scan.reportSource, inputIds: ['second', 'fourth'] })
    }
  })
})
