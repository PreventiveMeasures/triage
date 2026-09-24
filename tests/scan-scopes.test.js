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
