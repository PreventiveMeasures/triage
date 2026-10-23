import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { bundleCompareFiles, bundleCompareResolutions } from '../ui/view/bundle-compare-inputs.js'
import { computeBundleDiff, computeResolutionDiff } from '../ui/view/bundle-compare-diff.js'
import { prepareComparison } from '../common/bundle-comparison.js'

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

test('reports added and removed resolutions only of an importer told identical, including specifiers sharing a target', () => {
  const base = bundleCompareResolutions(details(imports([['unchanged', 'a.js'], ['removed', 'a.js']])))
  const other = bundleCompareResolutions(details(imports([['unchanged', 'a.js'], ['added', 'a.js']])))
  const unchanged = computeResolutionDiff(base, other)
  assert.deepEqual([unchanged.changed, unchanged.onlyBase, unchanged.onlyOther, unchanged.totalChanges], [[], [], [], 0], 'no importer told identical')
  const identical = computeResolutionDiff(base, other, new Map(), new Map(), null, path => path === 'app.js')
  assert.equal(identical.totalChanges, 2)
  assert.deepEqual(identical.changed, [])
  assert.deepEqual(identical.onlyBase.map(({ key: _key, ...row }) => row), [{
    parent: 'app.js', specifier: 'removed', conditions: 'node, import', platform: null, baseTarget: 'a.js', otherTarget: null,
  }])
  assert.deepEqual(identical.onlyOther.map(({ key: _key, ...row }) => row), [{
    parent: 'app.js', specifier: 'added', conditions: 'node, import', platform: null, baseTarget: null, otherTarget: 'a.js',
  }])
  assert.equal(computeResolutionDiff(base, other, new Map(), new Map(), null, path => path === 'other.js').totalChanges, 0, 'another importer told identical')
})

test('the comparison tells resolutions one side records alone of an importer it holds alike, renamed or not, and of none whose contents changed', () => {
  const side = (changed, specifier, target) => details([['node, import', [
    ['app.js', [['dep', 'a.js'], [specifier, target]]],
    ['lib.js', [['dep', 'a.js'], [specifier, target]]],
    [changed ? 'new/mod.js' : 'old/mod.js', [['dep', 'a.js'], changed ? ['extra', 'b.js'] : ['was', 'a.js']]],
  ]]], { files: { 'app.js': 'import "dep"', 'lib.js': changed ? 'lib 2' : 'lib 1', [changed ? 'new/mod.js' : 'old/mod.js']: 'import "dep"; import "extra"', 'a.js': 'a', 'b.js': 'b' } })
  const { files, resolutions } = prepareComparison(side(false, 'gone', 'a.js'), side(true, 'new', 'b.js'))
  assert.deepEqual(files.changed.filter(row => row.renamedFrom).map(row => [row.renamedFrom, row.path, row.modified]), [['old/mod.js', 'new/mod.js', false]])
  assert.deepEqual(resolutions.changed, [])
  assert.deepEqual(resolutions.onlyBase.map(row => [row.parent, row.specifier, row.baseTarget, row.otherTarget]),
    [['app.js', 'gone', 'a.js', null], ['new/mod.js', 'was', 'a.js', null]], 'a renamed importer\'s under its new path')
  assert.deepEqual(resolutions.onlyOther.map(row => [row.parent, row.specifier, row.baseTarget, row.otherTarget]),
    [['app.js', 'new', null, 'b.js'], ['new/mod.js', 'extra', null, 'b.js']], 'lib.js, whose contents changed, left out')
  assert.equal(resolutions.totalChanges, 4)
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

test('a renamed importer pairs its resolutions with its new path\'s, and a renamed target is the same target', () => {
  const resolutions = parents => bundleCompareResolutions(details([['node, import', parents]]))
  const base = resolutions([['src/a.js', [['dep', 'node_modules/dep/v1.js'], ['./b.js', 'src/b.js']]], ['main.js', [['./src/b.js', 'src/b.js']]]])
  const other = resolutions([['lib/a.js', [['dep', 'node_modules/dep/v2.js'], ['./b.js', 'lib/b.js']]], ['main.js', [['./src/b.js', 'lib/b.js']]]])
  const renames = new Map([['src/a.js', 'lib/a.js'], ['src/b.js', 'lib/b.js']])
  assert.deepEqual(computeResolutionDiff(base, other, renames).changed.map(({ key: _key, ...row }) => row), [{
    parent: 'lib/a.js', specifier: 'dep', conditions: 'node, import', platform: null,
    baseTarget: 'node_modules/dep/v1.js', otherTarget: 'node_modules/dep/v2.js',
  }], 'reported under the new path; imports that follow a rename are not repointed')
  assert.deepEqual(computeResolutionDiff(base, other).changed.map(row => `${row.parent} ${row.specifier}`), ['main.js ./src/b.js'],
    'without the renames, the moved importer pairs with nothing')
})

test('pairs resolutions across bundles taken from different roots', () => {
  const nested = (target, files) => ({ kind: 'stasis', bundle: Bundle.parse(new Bundle({
    entries: new Set(['src/app.js']), reason: {},
    modules: new Map([['.', { name: 'app', version: '1.0.0', files }]]),
    imports: new Map([['node, import', new Map([['src/app.js', new Map([['dep', target]])]])]]),
  }).serialize()) })
  const base = details(imports([['dep', 'a.js']]))
  const files = { 'src/app.js': 'import "dep"', 'src/a.js': 'a', 'src/b.js': 'b', __prelude__: 'p' }
  const result = other => {
    const { basePaths } = computeBundleDiff(bundleCompareFiles(base), bundleCompareFiles(other), () => '__own__').files
    return computeResolutionDiff(bundleCompareResolutions(base), bundleCompareResolutions(other), new Map(), basePaths)
  }
  assert.equal(result(nested('src/a.js', files)).totalChanges, 0, 'the same target under the root')
  assert.deepEqual(result(nested('src/b.js', files)).changed.map(row => [row.parent, row.baseTarget, row.otherTarget]),
    [['src/app.js', 'src/a.js', 'src/b.js']], 'the base target shown under the root')
})

test('reads an importer the bundles did not capture through the root, in a scope or not', () => {
  const make = (prefix, target, extra = {}) => details([['*', [[`${prefix}app.js`, [['dep', target], ['fs', 'node:fs']]]]]], {
    files: { [`${prefix}a.js`]: 'a', [`${prefix}b.js`]: 'b', ...extra },
    reason: { lib: [`${prefix}a.js`, `${prefix}b.js`] },
  })
  const base = make('', 'a.js')
  const result = (other, scope = '') => {
    const { files } = computeBundleDiff(bundleCompareFiles(base, scope), bundleCompareFiles(other, scope), () => '__own__')
    return computeResolutionDiff(bundleCompareResolutions(base, scope), bundleCompareResolutions(other, scope), new Map(), files.basePaths, files.root)
  }
  for (const scope of ['', 'reason:lib']) {
    assert.equal(result(make('src/', 'src/a.js', { __prelude__: 'p' }), scope).totalChanges, 0, `the same target, a builtin as it is (${scope || 'no scope'})`)
    assert.deepEqual(result(make('src/', 'src/b.js', { __prelude__: 'p' }), scope).changed.map(row => [row.parent, row.baseTarget, row.otherTarget]),
      [['src/app.js', 'src/a.js', 'src/b.js']], scope || 'no scope')
  }
})
