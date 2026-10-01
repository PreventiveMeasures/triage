import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { bundleCompareFiles, bundleCompareResolutions } from '../ui/view/bundle-compare-inputs.js'
import { computeBundleDiff, computeResolutionDiff } from '../ui/view/bundle-compare-diff.js'

function details(imports, { files = { 'app.js': 'import "dep"', 'a.js': 'a', 'b.js': 'b' }, reason = {} } = {}) {
  return { kind: 'stasis', bundle: Bundle.parse(new Bundle({
    entries: new Set(['app.js']), reason,
    modules: new Map([['.', { name: 'app', version: '1.0.0', files }]]),
    imports: new Map(imports.map(([conditions, parents]) => [conditions,
      new Map(parents.map(([parent, specifiers]) => [parent, new Map(specifiers)])),
    ])),
  }).serialize()) }
}
const imports = specs => [['node, import', [['app.js', specs]]]]
const diff = (base, other, scope = '') => computeResolutionDiff(bundleCompareResolutions(base, scope), bundleCompareResolutions(other, scope))

test('detects a redirected import even when all file contents and sizes are identical', () => {
  const base = details(imports([['dep', 'a.js']]))
  const other = details(imports([['dep', 'b.js']]))
  assert.equal(computeBundleDiff(bundleCompareFiles(base), bundleCompareFiles(other), () => '__own__').totals.identical, true)
  const result = diff(base, other)
  assert.equal(result.totalChanges, 1)
  assert.deepEqual(result.changed.map(({ key: _key, ...row }) => row), [{
    parent: 'app.js', specifier: 'dep', conditions: 'node, import', platform: null,
    baseTarget: 'a.js', otherTarget: 'b.js',
  }])
  assert.equal(diff(other, base).changed[0].baseTarget, 'b.js')
  assert.equal(diff(other, base).changed[0].otherTarget, 'a.js')
})

test('ignores added and removed resolutions, including specifiers sharing a target', () => {
  const base = details(imports([['unchanged', 'a.js'], ['removed', 'a.js']]))
  const other = details(imports([['unchanged', 'a.js'], ['added', 'a.js']]))
  const result = diff(base, other)
  assert.equal(result.totalChanges, 0)
  assert.deepEqual(result.changed, [])
})

test('preserves importer, condition, and import-attribute identities', () => {
  const base = details([
    ['node, import', [['app.js', [['dep', 'a.js']]], ['a.js', [['dep', 'a.js']]]]],
    ['node, require', [['app.js', [['dep', 'a.js']]]]],
    ['node, import (with: {"type":"json"})', [['app.js', [['dep', 'a.js']]]]],
  ])
  const other = details([
    ['node, import', [['app.js', [['dep', 'a.js']]], ['a.js', [['dep', 'b.js']]]]],
    ['node, require', [['app.js', [['dep', 'b.js']]]]],
    ['node, import (with: {"type":"json"})', [['app.js', [['dep', 'b.js']]]]],
  ])
  const result = diff(base, other)
  assert.equal(result.totalChanges, 3)
  assert.deepEqual(new Set(result.changed.map(r => `${r.parent} ${r.conditions}`)), new Set([
    'a.js node, import', 'app.js node, require', 'app.js node, import (with: {"type":"json"})',
  ]))
  const changedConditions = details([['browser, import', [['app.js', [['dep', 'a.js']]]]]])
  const conditionDiff = diff(details(imports([['dep', 'a.js']])), changedConditions)
  assert.equal(conditionDiff.totalChanges, 0)
})

test('compares Metro platforms separately and ignores specifier and platform insertion order', () => {
  const base = details(imports([
    ['dep', new Map([['ios', 'a.js'], ['android', 'a.js'], ['web', 'a.js']])], ['plain', 'a.js'],
  ]))
  const reordered = details(imports([
    ['plain', 'a.js'], ['dep', new Map([['web', 'a.js'], ['android', 'a.js'], ['ios', 'a.js']])],
  ]))
  assert.equal(diff(base, reordered).totalChanges, 0)
  const other = details(imports([
    ['dep', new Map([['ios', 'b.js'], ['android', 'a.js'], ['native', 'b.js']])], ['plain', 'a.js'],
  ]))
  const result = diff(base, other)
  assert.equal(result.totalChanges, 1)
  assert.deepEqual(result.changed.map(r => r.platform), ['ios'])
  // New platform identities are additions, not repointed existing resolutions.
  const plain = details(imports([['dep', 'a.js']]))
  const platform = details(imports([['dep', new Map([['ios', 'a.js']])]]))
  assert.equal(diff(plain, platform).totalChanges, 0)
})

test('scopes by importer, retaining uncaptured parents but excluding other bundled trees', () => {
  const make = target => details([['*', [
    ['app.js', [['dep', target]]], ['build.js', [['dep', target]]], ['uncaptured.js', [['dep', target]]],
  ]]], {
    files: { 'app.js': 'run', 'build.js': 'build', 'a.js': 'a', 'b.js': 'b' },
    reason: { run: ['app.js', 'a.js', 'b.js'], build: ['build.js'] },
  })
  const base = make('a.js'), other = make('b.js')
  assert.equal(diff(base, other).totalChanges, 3)
  assert.deepEqual(diff(base, other, 'reason:run').changed.map(r => r.parent), ['app.js', 'uncaptured.js'])
  assert.deepEqual(diff(base, other, 'reason:build').changed.map(r => r.parent), ['build.js'])
  assert.equal(diff(base, other, 'reason:missing').totalChanges, 0)
  const onlyOtherScope = details(imports([['dep', 'b.js']]), { reason: { extra: ['app.js'] } })
  const result = diff(base, onlyOtherScope, 'reason:extra')
  assert.equal(result.totalChanges, 0)
})

test('compares recorded resolutions even when neither endpoint has captured source', () => {
  const base = details([['*', [['outside.js', [['dep', 'not-captured-a.js']]]]]])
  const other = details([['*', [['outside.js', [['dep', 'not-captured-b.js']]]]]])
  assert.equal(diff(base, other).changed.length, 1)
})

test('empty and sourcemap inputs have no recorded resolutions', () => {
  for (const value of [null, { kind: 'stasis' }, { kind: 'sourcemap', json: { sources: [], sourcesContent: [] } }, details([])]) {
    assert.equal(bundleCompareResolutions(value).size, 0)
    assert.equal(diff(value, value).totalChanges, 0)
  }
})
