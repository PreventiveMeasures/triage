import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { applyChangeSet, parseDiff } from '@preventive/diff'
import { bundleCompareFiles, bundleCompareScopes } from '../ui/view/bundle-compare-inputs.js'
import { bundleFileDiff } from '../ui/view/bundle-file-diff.js'
import { bundlePackageVersions } from '../ui/view/bundle-sources.js'
import { computeBundleDiff } from '../ui/view/bundle-compare-diff.js'

function details(files, reason = {}, modules = []) {
  return { kind: 'stasis', bundle: new Bundle({ config: { scope: 'full' }, reason,
    modules: new Map([['.', { files }], ...modules]),
  }) }
}
test('Compare scopes include trees covering an entire side and trees unique to either side', () => {
  const base = details({ 'cli.js': 'old' }, { run: ['cli.js'], empty: ['missing.js'] })
  const other = details({ 'cli.js': 'new', 'metro.js': 'metro', 'manual.js': 'added' }, { run: ['cli.js'], metro: ['metro.js'], add: ['manual.js'] })
  assert.deepEqual(bundleCompareScopes(base, other).map(scope => scope.id), ['reason:add', 'reason:metro', 'reason:run'])
  assert.equal(bundleCompareFiles(base, 'reason:metro').size, 0)
  assert.deepEqual([...bundleCompareFiles(other, 'reason:metro').keys()], ['metro.js'])
  const diff = computeBundleDiff(bundleCompareFiles(base, 'reason:run'), bundleCompareFiles(other, 'reason:run'), () => '__own__')
  assert.equal(diff.totals.changedFiles, 1)
  assert.equal(diff.totals.onlyOtherFiles, 0)
  assert.equal(diff.totals.baseFiles, 1)
  assert.equal(diff.totals.otherFiles, 1)
  assert.equal(bundleCompareFiles(other).size, 3)
})
test('custom trees retain their exact paths and sourcemaps have no named trees', () => {
  const bundle = details({ 'src/app.js': 'a', 'tool.js': 'b' }, { 'custom build': ['src/app.js'] })
  assert.deepEqual(bundleCompareScopes(bundle), [{ id: 'reason:custom build', label: 'custom build' }])
  assert.deepEqual([...bundleCompareFiles(bundle, 'reason:custom build').keys()], ['src/app.js'])
  const map = { kind: 'sourcemap', json: { sources: ['file.js'], sourcesContent: ['source'] } }
  assert.deepEqual(bundleCompareScopes(map), [])
  assert.equal(bundleCompareFiles(map).size, 1)
  assert.equal(bundleCompareFiles(map, 'reason:run').size, 0)
})
test('dependency versions follow the selected tree, including multiple installed versions', () => {
  const bundle = details({}, { run: ['node_modules/dep/a.js'] }, [
    ['node_modules/dep', { name: 'dep', version: '1.0.0', files: { 'a.js': 'a' } }],
    ['node_modules/nested/node_modules/dep', { name: 'dep', version: '2.0.0', files: { 'a.js': 'b' } }],
  ])
  assert.deepEqual([...bundlePackageVersions(bundle).get('dep')], ['1.0.0', '2.0.0'])
  assert.deepEqual([...bundlePackageVersions(bundle, bundleCompareFiles(bundle, 'reason:run').keys()).get('dep')], ['1.0.0'])
  assert.equal(bundlePackageVersions(bundle, []).size, 0)
})
test('file popup diffs reconstruct the new contents, preserve whitespace, and classify colored changes', () => {
  for (const [before, after] of [
    ['const x = 1;\n', 'const x = 2;\n'],
    ['a\nb', 'a\nb\n'],
    ['é\n  first\n', 'é\n first\n<script>alert(1)</script>\n'],
    ['', 'new\n'], ['removed\n', ''],
  ]) {
    const lines = bundleFileDiff(before, after)
    const text = lines.map(line => line.text).join('\n')
    assert.equal(applyChangeSet(before, parseDiff(text)[0].blocks), after)
    assert.ok(lines.some(line => ['add', 'del'].includes(line.kind)))
  }
})
test('binary resources are not diffed as their base64 representation', () => {
  assert.equal(bundleFileDiff({ format: 'base64', data: 'AA==' }, { format: 'base64', data: 'AQ==' }), null)
  assert.equal(bundleFileDiff('text', { format: 'base64', data: 'AA==' }), null)
})
