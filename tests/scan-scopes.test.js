import assert from 'node:assert/strict'
import { test } from 'node:test'
import './_polyfills.js'
import { scanScopeOptions } from '../ui/scan/scopes.js'
import { ScanPage } from '../ui/scan/page.js'

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


function renderText(value) {
  if (value?.strings) return value.strings.map((text, index) => text + renderText(value.values[index])).join('')
  if (Array.isArray(value)) return value.map(renderText).join('')
  return value == null || typeof value === 'symbol' ? '' : String(value)
}

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
