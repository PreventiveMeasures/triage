// `ui/view/bundle-compare-diff.js` — the pure diff behind the Compare
// slide in the bundles view (view/bundle-compare.js). It takes two
// `Map<path, content>` file maps plus a `pkgOf` bucketing function
// and returns per-file (onlyBase / onlyOther / changed) + per-package
// deltas plus roll-up totals. This module has no Lit / DOM / `state`
// dependency, so the test imports it straight — no polyfills needed.
//
// `base` is the open bundle, `other` the one picked to compare; the
// result names the sides onlyBase / onlyOther (not added / removed) so
// the UI can label them with each bundle's actual name. `delta` is
// always `other − base`.

import assert from 'node:assert/strict'
import { describe, it, test } from 'node:test'
import { layoutDir, layoutPackageDirs, treeLayout } from '@preventive/compare'
import { Bundle } from '@exodus/stasis-core/bundle'
import { bundleCompareFiles, bundleCompareScopes, bundleCompareSideScopes } from '../ui/view/bundle-compare-inputs.js'
import { prepareComparison } from '../ui/view/bundle-comparison-local.js'
import { scanScopeOptions } from '../ui/scan/scopes.js'
import { DIFF_CONTEXT, diffRows, fileLineCounts, lineDiff, markHighlighted, markSegments, textLines, whitespaceHidden, whitespaceInsensitive } from '../ui/view/bundle-compare-code-model.js'
import { bundlePackageVersions } from '../ui/view/bundle-sources.js'
import { bundleFileMeta, comparePackages, compareSemver, computeBundleDiff, computeVersionUpdates, versionDirection } from '../ui/view/bundle-compare-diff.js'
import { bundlePkgOf } from '../ui/view/bundle-pkg-of.js'

// All fixtures use ASCII content so a string's byte length equals its
// `.length` — keeps the expected-bytes assertions readable.
const m = (obj) => new Map(Object.entries(obj))
// First path segment as the package bucket — exercises the grouping /
// classification logic with a trivial stand-in; the real `bundlePkgOf`
// (and its node_modules / pnpm handling) has its own coverage in
// `bundle-pkg-of.test.js`.
const firstSeg = (p) => p.split('/')[0]

describe('computeBundleDiff', () => {
  it('compares npm package binaries by digest, sized by their bytes', () => {
    const file = (digest, size) => ({ format: 'digest', digest, size })
    const base = m({ 'a/same.bin': file('sha256-a', 10), 'a/moved.bin': file('sha256-b', 10), 'a/gone.bin': file('sha256-c', 4) })
    const other = m({ 'a/same.bin': file('sha256-a', 10), 'a/moved.bin': file('sha256-d', 30) })
    const diff = computeBundleDiff(base, other, firstSeg)
    assert.equal(diff.totals.unchangedFiles, 1)
    assert.deepEqual(diff.files.changed.map(row => [row.path, row.baseBytes, row.otherBytes]), [['a/moved.bin', 10, 30]])
    assert.deepEqual(diff.files.onlyBase.map(row => [row.path, row.bytes]), [['a/gone.bin', 4]])
  })

  it('compares what stasis bundles record of a file beside its bytes: its format, execute bit and being an entry point', () => {
    // Each side's record of its files, as bundleFileMeta reads a stasis bundle's.
    const stasis = (formats, executable = [], entries = []) => bundleFileMeta({ kind: 'stasis', bundle: { formats: m(formats), executable: new Set(executable), entries: new Set(entries) } })
    const files = m({ 'a/data.js': 'x', 'a/run.sh': 'echo', 'a/main.js': 'y', 'a/same.js': 'z', 'a/edited.js': '1' })
    const edited = m({ 'a/data.js': 'x', 'a/run.sh': 'echo', 'a/main.js': 'y', 'a/same.js': 'z', 'a/edited.js': '2' })
    const meta = [
      stasis({ 'a/data.js': 'resource', 'a/main.js': 'commonjs', 'a/same.js': 'module', 'a/edited.js': 'module' }),
      stasis({ 'a/data.js': 'module', 'a/main.js': 'commonjs', 'a/same.js': 'module', 'a/edited.js': 'commonjs' }, ['a/run.sh'], ['a/main.js']),
    ]
    const diff = computeBundleDiff(files, edited, firstSeg, undefined, meta)
    const rows = Object.fromEntries(diff.files.changed.map(row => [row.path, row]))
    assert.deepEqual(rows['a/data.js'].meta, [{ field: 'format', from: 'resource', to: 'module' }], 'carried as data, now run as code')
    assert.equal(rows['a/data.js'].modified, false, 'its bytes the same')
    assert.deepEqual(rows['a/run.sh'].meta, [{ field: 'executable', from: false, to: true }])
    assert.deepEqual(rows['a/main.js'].meta, [{ field: 'entry', from: false, to: true }])
    assert.deepEqual(rows['a/edited.js'].meta, [{ field: 'format', from: 'module', to: 'commonjs' }], 'with its bytes changed too')
    assert.equal(rows['a/edited.js'].modified, undefined)
    assert.equal(rows['a/same.js'], undefined, 'one recorded alike is unchanged')
    assert.equal(diff.totals.unchangedFiles, 1)
    assert.equal(diff.totals.identical, false)
    // A format a side leaves unsaid is one too: stasis runs the file as code.
    const unsaid = (before, after) => computeBundleDiff(m({ 'a/x.js': 'x' }), m({ 'a/x.js': 'x' }), firstSeg, undefined, [stasis(before), stasis(after)]).files.changed[0]?.meta
    assert.deepEqual(unsaid({ 'a/x.js': 'resource' }, {}), [{ field: 'format', from: 'resource', to: undefined }], 'a resource whose format is dropped, run now')
    assert.deepEqual(unsaid({}, { 'a/x.js': 'module' }), [{ field: 'format', from: undefined, to: 'module' }])
    assert.equal(unsaid({}, {}), undefined, 'unsaid on both sides')
    // Another kind of bundle: nothing to compare.
    assert.equal(computeBundleDiff(m({ 'a/x.js': 'x' }), m({ 'a/x.js': 'x' }), firstSeg, undefined, [null, stasis({}, ['a/x.js'])]).totals.identical, true, 'a side that is no stasis bundle')
    assert.equal(bundleFileMeta({ kind: 'sourcemap' }), null)
    // A renamed file's record, from its old path to its new one.
    const renamed = computeBundleDiff(m({ 'a/old.js': 'same text\n'.repeat(20) }), m({ 'a/new.js': 'same text\n'.repeat(20) }), firstSeg, undefined,
      [stasis({ 'a/old.js': 'resource' }), stasis({ 'a/new.js': 'module' }, ['a/new.js'])])
    assert.deepEqual(renamed.files.changed.map(({ path, renamedFrom, modified, meta: changes }) => ({ path, renamedFrom, modified, changes })),
      [{ path: 'a/new.js', renamedFrom: 'a/old.js', modified: false, changes: [{ field: 'format', from: 'resource', to: 'module' }, { field: 'executable', from: false, to: true }] }])
    // As a stasis bundle records them.
    const bundle = new Bundle({ modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'bin/run': 'echo', 'a.js': 'x' } }]]), formats: new Map([['a.js', 'module']]),
      executable: new Set(['bin/run']), entries: new Set(['a.js']) })
    const read = bundleFileMeta({ kind: 'stasis', bundle })
    assert.deepEqual([read('a.js'), read('bin/run')], [{ format: 'module', executable: false, entry: true }, { format: undefined, executable: true, entry: false }])
  })

  it('flags identical bundles and counts every file as unchanged', () => {
    const base = m({ 'a/x.js': 'aaaa', 'a/y.js': 'bb' })
    const other = m({ 'a/x.js': 'aaaa', 'a/y.js': 'bb' })
    const diff = computeBundleDiff(base, other, firstSeg)
    assert.equal(diff.totals.identical, true)
    assert.equal(diff.totals.unchangedFiles, 2)
    assert.equal(diff.totals.changedFiles, 0)
    assert.equal(diff.totals.onlyBaseFiles, 0)
    assert.equal(diff.totals.onlyOtherFiles, 0)
    assert.equal(diff.totals.byteDelta, 0)
    assert.equal(diff.totals.fileDelta, 0)
    assert.deepEqual(diff.files.onlyBase, [])
    assert.deepEqual(diff.files.onlyOther, [])
    assert.deepEqual(diff.files.changed, [])
    // No package moved → no package rows at all.
    assert.deepEqual(diff.packages.onlyBase, [])
    assert.deepEqual(diff.packages.onlyOther, [])
    assert.deepEqual(diff.packages.changed, [])
  })

  it('detects added files (only in other) and is not identical', () => {
    const base = m({ 'a/x.js': 'aaaa' })
    const other = m({ 'a/x.js': 'aaaa', 'a/new.js': 'zzzzz' })
    const diff = computeBundleDiff(base, other, firstSeg)
    assert.equal(diff.totals.identical, false)
    assert.equal(diff.totals.onlyOtherFiles, 1)
    assert.equal(diff.totals.onlyOtherBytes, 5)
    assert.equal(diff.totals.fileDelta, 1)
    assert.equal(diff.totals.byteDelta, 5)
    assert.deepEqual(diff.files.onlyOther, [{ path: 'a/new.js', bytes: 5 }])
    assert.deepEqual(diff.files.onlyBase, [])
    // The package 'a' exists on both sides but gained a file → changed.
    assert.equal(diff.packages.changed.length, 1)
    assert.equal(diff.packages.changed[0].pkg, 'a')
    assert.equal(diff.packages.changed[0].delta, 5)
  })

  it('detects removed files (only in base)', () => {
    const base = m({ 'a/x.js': 'aaaa', 'a/gone.js': 'bbb' })
    const other = m({ 'a/x.js': 'aaaa' })
    const diff = computeBundleDiff(base, other, firstSeg)
    assert.equal(diff.totals.onlyBaseFiles, 1)
    assert.equal(diff.totals.onlyBaseBytes, 3)
    assert.equal(diff.totals.fileDelta, -1)
    assert.equal(diff.totals.byteDelta, -3)
    assert.deepEqual(diff.files.onlyBase, [{ path: 'a/gone.js', bytes: 3 }])
  })

  it('detects changed files with correct base/other bytes and delta', () => {
    const base = m({ 'a/x.js': 'aaaa' })       // 4 bytes
    const other = m({ 'a/x.js': 'aaaaaaa' })   // 7 bytes
    const diff = computeBundleDiff(base, other, firstSeg)
    assert.equal(diff.totals.changedFiles, 1)
    assert.equal(diff.totals.unchangedFiles, 0)
    assert.equal(diff.totals.changedDelta, 3)
    assert.deepEqual(diff.files.changed, [
      { path: 'a/x.js', baseBytes: 4, otherBytes: 7, delta: 3 },
    ])
    assert.equal(diff.totals.byteDelta, 3)
  })

  it('classifies packages as only-base, only-other, and changed', () => {
    const base = m({
      'keep/a.js': 'xx',
      'dropped/a.js': 'yyy',     // package only in base
      'shared/a.js': 'aaaa',     // changes below
    })
    const other = m({
      'keep/a.js': 'xx',
      'added/a.js': 'zzzz',      // package only in other
      'shared/a.js': 'aaaaaa',   // grew by 2
    })
    const diff = computeBundleDiff(base, other, firstSeg)
    assert.deepEqual(diff.packages.onlyBase, [{ pkg: 'dropped', bytes: 3 }])
    assert.deepEqual(diff.packages.onlyOther, [{ pkg: 'added', bytes: 4 }])
    // 'keep' is unchanged (omitted); 'shared' grew → changed.
    assert.equal(diff.packages.changed.length, 1)
    assert.deepEqual(diff.packages.changed[0], {
      pkg: 'shared', baseBytes: 4, otherBytes: 6, delta: 2,
    })
  })

  it('flags a package changed even when its byte total is unchanged', () => {
    // Same package, same total bytes, but the file content differs —
    // a content shuffle a byte-total-only check would miss.
    const base = m({ 'pkg/a.js': 'aaaa' })
    const other = m({ 'pkg/a.js': 'bbbb' })
    const diff = computeBundleDiff(base, other, firstSeg)
    assert.equal(diff.totals.changedFiles, 1)
    assert.equal(diff.packages.changed.length, 1)
    assert.equal(diff.packages.changed[0].pkg, 'pkg')
    assert.equal(diff.packages.changed[0].delta, 0)
  })

  it('sorts changed files by absolute delta, only-* lists by bytes', () => {
    const base = m({
      'a/small.js': 'aa',        // → +1  (changed)
      'a/big.js': 'aaaaaaaa',    // → −5  (changed, bigger magnitude)
      'a/r1.js': 'r',            // removed, 1 byte
      'a/r2.js': 'rrrr',         // removed, 4 bytes
    })
    const other = m({
      'a/small.js': 'aaa',       // 3 bytes (delta +1)
      'a/big.js': 'aaa',         // 3 bytes (delta −5)
      'a/n1.js': 'n',            // added, 1 byte
      'a/n2.js': 'nnnnn',        // added, 5 bytes
    })
    const diff = computeBundleDiff(base, other, firstSeg)
    // Changed: |−5| before |+1|.
    assert.deepEqual(diff.files.changed.map((r) => r.path), ['a/big.js', 'a/small.js'])
    // Removed: 4-byte before 1-byte.
    assert.deepEqual(diff.files.onlyBase.map((r) => r.path), ['a/r2.js', 'a/r1.js'])
    // Added: 5-byte before 1-byte.
    assert.deepEqual(diff.files.onlyOther.map((r) => r.path), ['a/n2.js', 'a/n1.js'])
  })

  it('handles empty bundles as identical with zero totals', () => {
    const diff = computeBundleDiff(new Map(), new Map(), firstSeg)
    assert.equal(diff.totals.identical, true)
    assert.equal(diff.totals.baseFiles, 0)
    assert.equal(diff.totals.otherFiles, 0)
    assert.equal(diff.totals.baseBytes, 0)
    assert.equal(diff.totals.otherBytes, 0)
  })

  it('counts content with no size to give as zero bytes', () => {
    // An entry that is neither text nor a base64 declaration has no
    // size; it still contributes a file.
    const base = m({ 'a/x.js': 'aaaa' })
    const other = new Map([['a/x.js', 'aaaa'], ['a/blob.bin', null]])
    const diff = computeBundleDiff(base, other, firstSeg)
    assert.equal(diff.totals.onlyOtherFiles, 1)
    assert.equal(diff.totals.onlyOtherBytes, 0)
    assert.deepEqual(diff.files.onlyOther, [{ path: 'a/blob.bin', bytes: 0 }])
  })

  it('measures multibyte content by UTF-8 byte length, not code points', () => {
    // '€' is 3 UTF-8 bytes; the diff must report bytes, matching the
    // analyzer-side hashing the rest of the bundle view relies on.
    const base = m({ 'a/x.js': 'a' })          // 1 byte
    const other = m({ 'a/x.js': '€' })         // 3 bytes
    const diff = computeBundleDiff(base, other, firstSeg)
    assert.deepEqual(diff.files.changed, [
      { path: 'a/x.js', baseBytes: 1, otherBytes: 3, delta: 2 },
    ])
  })
})

// Resources, as the Compare tab receives them from `bundleFilesAsMap`: a
// `resource` as the text it is, a `resource:base64` as a fresh
// `{ format: 'base64', data }` per side, just as each bundle's parse
// hands it over.
describe('computeBundleDiff — resources', () => {
  const b64 = (bytes) => ({ format: 'base64', data: Buffer.from(bytes).toString('base64') })

  it('sees a change to an image, which a diff of source alone reported as identical', () => {
    const base = new Map([['a/x.js', 'x'], ['a/logo.png', b64([0x89, 1, 2])]])
    const other = new Map([['a/x.js', 'x'], ['a/logo.png', b64(Buffer.alloc(5000, 0xff))]])
    const diff = computeBundleDiff(base, other, firstSeg)
    assert.equal(diff.totals.identical, false)
    assert.deepEqual(diff.files.changed, [{ path: 'a/logo.png', baseBytes: 3, otherBytes: 5000, delta: 4997 }])
    assert.equal(diff.totals.baseBytes, 1 + 3)
    assert.equal(diff.totals.otherBytes, 1 + 5000)
  })

  it('compares a base64 resource by its spelling, not by the object carrying it', () => {
    // Each side's parse builds its own wrapper; identity would call every
    // image in the bundle changed.
    const base = new Map([['a/logo.png', b64([1, 2, 3])]])
    const other = new Map([['a/logo.png', b64([1, 2, 3])]])
    const diff = computeBundleDiff(base, other, firstSeg)
    assert.equal(diff.totals.identical, true)
    assert.equal(diff.totals.unchangedFiles, 1)
  })

  it('sizes a resource as the Overview does: base64 by the bytes it decodes to, text by its UTF-8', () => {
    const base = new Map()
    const other = new Map([['a/logo.png', b64(Buffer.alloc(1000, 7))], ['a/icon.svg', '<svg>€</svg>'], ['a/bad.png', { format: 'base64', data: '!!!' }]])
    const diff = computeBundleDiff(base, other, firstSeg)
    assert.deepEqual(diff.files.onlyOther, [
      { path: 'a/logo.png', bytes: 1000 },
      { path: 'a/icon.svg', bytes: Buffer.byteLength('<svg>€</svg>') },
      // A spelling that does not decode has no size, but is still a file
      // that was added.
      { path: 'a/bad.png', bytes: 0 },
    ])
  })

  it('calls a file changed when it turns from text into base64', () => {
    const base = new Map([['a/data.bin', 'AAAA']])
    const other = new Map([['a/data.bin', { format: 'base64', data: 'AAAA' }]])
    assert.equal(computeBundleDiff(base, other, firstSeg).totals.changedFiles, 1)
  })
})

// Build a `Map<name, Set<version>>` (the shape `bundlePackageVersions`
// returns) from a plain object; a string value is a single version, an
// array is the multi-version (pnpm duplicate-major) case.
const vmap = (obj) => new Map(
  Object.entries(obj).map(([k, v]) => [k, new Set(Array.isArray(v) ? v : [v])]),
)

describe('compareSemver', () => {
  it('orders by the dotted-numeric core', () => {
    assert.equal(compareSemver('1.2.3', '1.2.4') < 0, true)
    assert.equal(compareSemver('1.2.10', '1.2.9') > 0, true)   // numeric, not lexical
    assert.equal(compareSemver('2.0.0', '1.9.9') > 0, true)
    assert.equal(compareSemver('1.2.3', '1.2.3'), 0)
  })

  it('treats a missing core segment as zero', () => {
    assert.equal(compareSemver('1.2', '1.2.0'), 0)
    assert.equal(compareSemver('1.2.1', '1.2') > 0, true)
  })

  it('ranks a release above a prerelease, and orders prerelease ids', () => {
    assert.equal(compareSemver('1.0.0', '1.0.0-rc.1') > 0, true)
    assert.equal(compareSemver('1.0.0-alpha', '1.0.0-beta') < 0, true)
    assert.equal(compareSemver('1.0.0-rc.2', '1.0.0-rc.10') < 0, true) // numeric ids
    // A numeric identifier ranks below a non-numeric one (semver).
    assert.equal(compareSemver('1.0.0-1', '1.0.0-alpha') < 0, true)
  })

  it('ignores +build metadata for precedence', () => {
    assert.equal(compareSemver('1.0.0+a', '1.0.0+b'), 0)
  })

  it('falls back to a stable string compare for non-numeric cores', () => {
    // Not a real semver — must still return a total, stable order.
    assert.equal(compareSemver('next', 'latest') > 0, true)
    assert.equal(compareSemver('latest', 'latest'), 0)
  })
})

describe('computeVersionUpdates', () => {
  it('flags a package present on both sides whose version changed', () => {
    const vu = computeVersionUpdates(
      vmap({ lodash: '4.17.20' }),
      vmap({ lodash: '4.17.21' }),
    )
    assert.equal(vu.updated.length, 1)
    assert.deepEqual(vu.updated[0], {
      pkg: 'lodash',
      baseVersions: ['4.17.20'],
      otherVersions: ['4.17.21'],
      direction: 'up',
    })
    assert.deepEqual(vu.added, [])
    assert.deepEqual(vu.removed, [])
  })

  it('labels a downgrade and ignores an unchanged package', () => {
    const vu = computeVersionUpdates(
      vmap({ a: '2.0.0', same: '1.0.0' }),
      vmap({ a: '1.5.0', same: '1.0.0' }),
    )
    assert.equal(vu.updated.length, 1)
    assert.equal(vu.updated[0].pkg, 'a')
    assert.equal(vu.updated[0].direction, 'down')
  })

  it('separates added and removed dependencies', () => {
    const vu = computeVersionUpdates(
      vmap({ gone: '1.0.0' }),
      vmap({ fresh: '3.1.0' }),
    )
    assert.deepEqual(vu.removed, [{ pkg: 'gone', versions: ['1.0.0'] }])
    assert.deepEqual(vu.added, [{ pkg: 'fresh', versions: ['3.1.0'] }])
    assert.deepEqual(vu.updated, [])
  })

  it('treats a reordered multi-version set as unchanged', () => {
    // Same two versions on both sides (a duplicate major pnpm keeps) —
    // set membership matches, so it is not an update.
    const vu = computeVersionUpdates(
      vmap({ dup: ['1.0.0', '2.0.0'] }),
      vmap({ dup: ['2.0.0', '1.0.0'] }),
    )
    assert.deepEqual(vu.updated, [])
  })

  it('sorts versions ascending and flags a changed multi-version set', () => {
    const vu = computeVersionUpdates(
      vmap({ dup: ['2.0.0', '1.0.0'] }),
      vmap({ dup: ['2.0.0', '1.5.0'] }),
    )
    assert.equal(vu.updated.length, 1)
    assert.deepEqual(vu.updated[0].baseVersions, ['1.0.0', '2.0.0'])
    assert.deepEqual(vu.updated[0].otherVersions, ['1.5.0', '2.0.0'])
    // The older copy moved up (1.0.0 → 1.5.0) beside the same 2.0.0.
    assert.equal(vu.updated[0].direction, 'up')
  })

  it('sorts each list by package name and reports distinct dep counts', () => {
    const vu = computeVersionUpdates(
      vmap({ b: '1.0.0', a: '1.0.0', drop: '1.0.0' }),
      vmap({ b: '2.0.0', a: '2.0.0', add: '1.0.0' }),
    )
    assert.deepEqual(vu.updated.map((r) => r.pkg), ['a', 'b'])
    assert.equal(vu.totals.baseDeps, 3)
    assert.equal(vu.totals.otherDeps, 3)
  })

  it('returns empty lists for empty inventories (sourcemap / v0 pair)', () => {
    const vu = computeVersionUpdates(new Map(), new Map())
    assert.deepEqual(vu.updated, [])
    assert.deepEqual(vu.added, [])
    assert.deepEqual(vu.removed, [])
    assert.deepEqual(vu.totals, { baseDeps: 0, otherDeps: 0 })
  })
})

describe('versionDirection', () => {
  it('reads dropped and added versions against each other, or against the kept ones', () => {
    for (const [before, after, direction] of [
      [['1.0.0', '2.0.0'], ['2.0.0'], 'up'],
      [['2.0.0'], ['1.0.0', '2.0.0'], 'down'],
      [['1.0.0', '1.2.0', '2.0.0'], ['1.0.0', '2.0.0'], 'changed'],
      [['1.0.0'], ['2.0.0'], 'up'],
      [['2.0.0'], ['1.5.0'], 'down'],
      [['1.0.0'], ['1.0.0', '2.0.0'], 'up'],
      [['1.0.0', '2.0.0'], ['1.0.0'], 'down'],
      [['1.0.0', '3.0.0'], ['2.0.0', '3.0.0'], 'up'],
      [['1.0.0', '3.0.0'], ['2.0.0'], 'changed'],
    ]) assert.equal(versionDirection(before, after), direction, `${before} → ${after}`)
  })
})

describe('comparePackages', () => {
  it('joins sizes and versions into one row per package that moved', () => {
    const rows = comparePackages(
      { onlyBase: [{ pkg: 'gone', bytes: 3 }], onlyOther: [], changed: [{ pkg: '__own__', baseBytes: 10, otherBytes: 12, delta: 2 }],
        unchanged: [{ pkg: 'bumped', bytes: 5 }, { pkg: 'same', bytes: 7 }] },
      vmap({ gone: '1.0.0', bumped: '1.0.0', same: '2.0.0', meta: '1.0.0' }),
      vmap({ bumped: '1.1.0', same: '2.0.0', fresh: '0.1.0' }),
    )
    assert.deepEqual(rows.removed, [
      { pkg: 'gone', bytes: 3, versions: ['1.0.0'] },
      { pkg: 'meta', bytes: null, versions: ['1.0.0'] },
    ])
    assert.deepEqual(rows.added, [{ pkg: 'fresh', bytes: null, versions: ['0.1.0'] }])
    assert.deepEqual(rows.changed, [
      { pkg: '__own__', baseBytes: 10, otherBytes: 12, delta: 2, baseVersions: [], otherVersions: [], direction: null },
      { pkg: 'bumped', baseBytes: 5, otherBytes: 5, delta: 0, baseVersions: ['1.0.0'], otherVersions: ['1.1.0'], direction: 'up' },
    ])
  })
})

describe('renames', () => {
  // The package a path is in: the one after its last node_modules, or own source.
  const pkgOf = path => /^(?:.*\/)?node_modules\/(?:@[^/]+\/)?[^/]+/u.exec(path)?.[0] ?? '__own__'
  // Renames by path alone: each file's content its path, so that no two are alike.
  const own = paths => m(Object.fromEntries(paths.map(path => [path, path])))
  const renames = (removed, added) => Object.fromEntries(computeBundleDiff(own(removed), own(added), pkgOf).files.changed.map(row => [row.renamedFrom, row.path]))

  it('pairs an extension change, a directory swapped, and both', () => {
    assert.deepEqual(renames(['src/a.js'], ['src/a.ts']), { 'src/a.js': 'src/a.ts' })
    assert.deepEqual(renames(['src/a.js'], ['lib/a.js']), { 'src/a.js': 'lib/a.js' })
    assert.deepEqual(renames(['src/a.ts'], ['lib/a.js']), { 'src/a.ts': 'lib/a.js' })
    assert.deepEqual(renames(['x/src/y/a.css'], ['x/lib/y/a.scss']), { 'x/src/y/a.css': 'x/lib/y/a.scss' }, 'at any depth')
    assert.deepEqual(renames(['node_modules/a/src/x.ts'], ['node_modules/a/lib/x.js']), { 'node_modules/a/src/x.ts': 'node_modules/a/lib/x.js' })
  })

  it('pairs a clear rename, and a build\'s by its path', () => {
    // A path a build makes of another (`lib` for `src`, `.js` for `.ts`) pairs with the best of those it could be, alike all else the first.
    assert.deepEqual(renames(['src/a.js'], ['lib/a.js', 'src/a.ts']), { 'src/a.js': 'lib/a.js' }, 'two files it could be')
    assert.deepEqual(renames(['src/a.js', 'lib/a.ts'], ['lib/a.js']), { 'lib/a.ts': 'lib/a.js' }, 'two files it could be from')
    assert.deepEqual(renames(['src/a.js', 'src/a.css'], ['lib/a.js', 'lib/a.css']), { 'src/a.js': 'lib/a.js', 'src/a.css': 'lib/a.css' },
      'a script and a style of one name move apart')
    assert.deepEqual(renames(['src/a.css'], ['src/a.js']), {}, 'a style does not become a script')
    assert.deepEqual(renames(['src/a.json'], ['src/a.yaml']), {}, 'other files keep their extension')
    assert.deepEqual(renames(['src/a.js'], ['src/b.js']), {}, 'nor change their name')
    assert.deepEqual(renames(['src/x/a.js'], ['lib/y/a.js']), {}, 'one directory swaps, not two')
    assert.deepEqual(renames(['src/a.js'], ['src/lib/a.js']), {}, 'nor moves deeper')
  })

  it('stays within a package, past its last node_modules', () => {
    assert.deepEqual(renames(['node_modules/left-pad/index.js'], ['node_modules/zod/index.js']), {})
    assert.deepEqual(renames(['a/node_modules/b/x.js'], ['c/node_modules/b/x.js']), {})
    assert.deepEqual(renames(['node_modules/a/index.js'], ['src/index.js']), {})
  })

  it('pairs a file moved under another name by its content, as git diff -M does, within its package', () => {
    const body = Array.from({ length: 20 }, (_, i) => `export const line${i} = 'a line long enough to weigh'\n`).join('')
    const moved = (old, now) => computeBundleDiff(m(old), m(now), firstSeg).files.changed.map(row => [row.renamedFrom, row.path, row.modified])
    assert.deepEqual(moved({ 'own/util.js': body }, { 'own/helpers/strings.js': body }), [['own/util.js', 'own/helpers/strings.js', false]])
    assert.deepEqual(moved({ 'own/util.js': body }, { 'own/helpers/strings.js': `${body}export const more = 1\n` }), [['own/util.js', 'own/helpers/strings.js', true]],
      'edited too, as its row says')
    assert.deepEqual(moved({ 'own/util.js': body }, { 'other/util.js': body }), [], 'never into another package')
    const file = digest => ({ format: 'digest', digest, size: 10 })
    assert.deepEqual(moved({ 'own/a.bin': file('sha256-a') }, { 'own/b.bin': file('sha256-a') }), [['own/a.bin', 'own/b.bin', false]], 'a binary by its digest')
    assert.deepEqual(moved({ 'own/a.bin': file('sha256-a') }, { 'own/b.bin': file('sha256-b') }), [])
    assert.deepEqual(moved({ 'own/a.bin': { format: 'base64', data: 'AQ==' } }, { 'own/b.txt': '\0base64\0AQ==' }), [], 'nor text that spells a resource as it is read')
    assert.deepEqual(moved({ 'own/a.js': null }, { 'own/b.js': null }), [], 'one with no content alike no other')
    assert.deepEqual(moved({ 'own/src/a.js': null }, { 'own/lib/a.js': null }), [['own/src/a.js', 'own/lib/a.js', false]], 'but where its path says so')
  })

  it('counts a renamed file as changed, at its new path, not as removed and added', () => {
    const base = m({ 'own/src/a.js': 'aaaa', 'own/keep.js': 'k', 'own/gone.js': 'g' })
    const other = m({ 'own/lib/a.ts': 'aaaaaa', 'own/keep.js': 'k', 'own/new.js': 'n' })
    const { totals, files, packages } = computeBundleDiff(base, other, firstSeg)
    assert.deepEqual(files.changed, [{ path: 'own/lib/a.ts', renamedFrom: 'own/src/a.js', basePath: 'own/src/a.js', baseBytes: 4, otherBytes: 6, delta: 2, modified: true }])
    assert.deepEqual(files.onlyBase.map(row => row.path), ['own/gone.js'])
    assert.deepEqual(files.onlyOther.map(row => row.path), ['own/new.js'])
    assert.equal(totals.changedFiles, 1)
    assert.equal(totals.renamedFiles, 1)
    assert.equal(totals.onlyBaseBytes, 1)
    assert.equal(totals.onlyOtherBytes, 1)
    assert.equal(totals.changedDelta, 2)
    assert.equal(totals.identical, false)
    assert.deepEqual(packages.changed.map(row => row.pkg), ['own'])
    const pure = computeBundleDiff(m({ 'own/src/a.js': 'a' }), m({ 'own/lib/a.js': 'a' }), firstSeg)
    assert.deepEqual(pure.files.changed, [{ path: 'own/lib/a.js', renamedFrom: 'own/src/a.js', basePath: 'own/src/a.js', baseBytes: 1, otherBytes: 1, delta: 0, modified: false }])
    assert.equal(pure.totals.identical, false, 'a rename alone is a change')
  })
})

describe('bundles taken from different roots', () => {
  const own = () => 'own'
  const flat = m({ 'dir/file/a.js': 'a', 'dir/file/b.js': 'b' })
  const nested = m({ 'src/dir/file/a.js': 'a', 'src/dir/file/b.js': 'b', __prelude__: 'p' })

  it('compares one bundle as if under the directory the other holds it in', () => {
    const { files, totals } = computeBundleDiff(flat, nested, own)
    assert.deepEqual(files.root, { base: '', other: 'src/' })
    assert.deepEqual(files.changed, [], 'not changed, nor renamed')
    assert.deepEqual(files.onlyBase, [])
    assert.deepEqual(files.onlyOther.map(row => row.path), ['__prelude__'], "the other's own extra stays added")
    assert.equal(totals.renamedFiles, 0)
    assert.equal(totals.unchangedFiles, 2)
    assert.deepEqual([...files.basePaths], [['dir/file/a.js', 'src/dir/file/a.js'], ['dir/file/b.js', 'src/dir/file/b.js']])
  })

  it('works the other way round, a base file outside the root above it', () => {
    const { files } = computeBundleDiff(nested, flat, own)
    assert.deepEqual(files.root, { base: 'src/', other: '' })
    assert.deepEqual(files.changed, [])
    assert.deepEqual(files.onlyBase, [{ path: '../__prelude__', basePath: '__prelude__', bytes: 1 }])
  })

  it('names the base file wherever it differs, for changed, removed and renamed files', () => {
    const base = m({ 'dir/a.js': 'a', 'dir/b.js': 'b', 'dir/c.js': 'c', 'dir/gone.js': 'g', 'dir/d.js': 'd' })
    const other = m({ 'src/dir/a.js': 'aa', 'src/dir/b.js': 'b', 'src/dir/c.js': 'c', 'src/dir/d.ts': 'd', __prelude__: 'p' })
    const { files, totals } = computeBundleDiff(base, other, own)
    assert.deepEqual(files.root, { base: '', other: 'src/' })
    assert.deepEqual(files.changed, [
      { path: 'src/dir/a.js', basePath: 'dir/a.js', baseBytes: 1, otherBytes: 2, delta: 1 },
      { path: 'src/dir/d.ts', renamedFrom: 'src/dir/d.js', basePath: 'dir/d.js', baseBytes: 1, otherBytes: 1, delta: 0, modified: false },
    ])
    assert.deepEqual(files.onlyBase, [{ path: 'src/dir/gone.js', basePath: 'dir/gone.js', bytes: 1 }])
    assert.equal(totals.renamedFiles, 1)
  })

  it('pairs a file both keep at their own root as it is', () => {
    const base = m({ 'package.json': '{}', 'dir/a.js': 'a', 'dir/b.js': 'b' })
    const other = m({ 'package.json': '{}', 'src/dir/a.js': 'a', 'src/dir/b.js': 'b' })
    const { files, totals } = computeBundleDiff(base, other, own)
    assert.deepEqual(files.root, { base: '', other: 'src/' })
    assert.equal(totals.identical, true)
  })

  it('gives every base file a path of its own, one the root cannot place a `../` further out', () => {
    const base = m({ 'src/a.js': 'a', 'src/b.js': 'b', 'a.js': 'x', '../a.js': 'y' })
    const other = m({ 'a.js': 'a', 'b.js': 'b', '../a.js': 'y' })
    const { files, totals } = computeBundleDiff(base, other, own)
    assert.deepEqual(files.root, { base: 'src/', other: '' })
    assert.equal(new Set(files.basePaths.values()).size, 4)
    assert.deepEqual(files.onlyBase, [{ path: '../../a.js', basePath: 'a.js', bytes: 1 }])
    assert.equal(totals.unchangedFiles, 3)
    assert.equal(totals.baseBytes, 4)
  })

  it('keeps package boundaries across the root, recorded on one side or both', () => {
    const base = m({ 'crates/foo/lib.rs': 'v1', 'crates/foo/old.rs': 'o', 'node_modules/x/i.js': 'x', 'a.js': 'a', 'b.js': 'b' })
    const baseDirs = new Map([['crates/foo/lib.rs', 'crates/foo'], ['crates/foo/old.rs', 'crates/foo'], ['node_modules/x/i.js', 'node_modules/x'], ['a.js', '.'], ['b.js', '.']])
    const other = m({ 'src/crates/foo/lib.rs': 'v2', 'src/node_modules/x/i.js': 'x', 'src/a.js': 'a', 'src/b.js': 'b', __prelude__: 'p' })
    const compare = otherDirs => {
      const layout = treeLayout(base.keys(), other.keys())
      const dirs = layoutPackageDirs(baseDirs, otherDirs, layout)
      return { dirs, diff: computeBundleDiff(base, other, path => bundlePkgOf(path, { packageDir: dirs?.get(path) }), layout) }
    }
    const { dirs, diff: againstMap } = compare(null)
    assert.deepEqual([...dirs], [['src/crates/foo/lib.rs', 'src/crates/foo'], ['src/crates/foo/old.rs', 'src/crates/foo'],
      ['src/node_modules/x/i.js', 'src/node_modules/x'], ['src/a.js', '.'], ['src/b.js', '.']])
    assert.deepEqual(againstMap.packages.changed.map(row => row.pkg).toSorted(), ['__own__', 'src/crates/foo'], 'a sourcemap side keeps the boundary the base records, own source gaining __prelude__')
    const otherDirs = new Map([['src/crates/foo/lib.rs', 'src/crates/foo'], ['src/node_modules/x/i.js', 'src/node_modules/x'], ['src/a.js', '.'], ['src/b.js', '.'], ['__prelude__', '.']])
    const { diff: againstStasis } = compare(otherDirs)
    assert.deepEqual(againstStasis.packages.changed.map(row => row.pkg).toSorted(), ['__own__', 'src/crates/foo'], 'one package, not removed and added')
    assert.deepEqual([...againstStasis.packages.onlyBase, ...againstStasis.packages.onlyOther], [])
    assert.equal(layoutPackageDirs(null, null, { root: null, paths: new Map() }), null)
    assert.deepEqual([...layoutPackageDirs(new Map([['src/a.js', 'src'], ['src/b/c.js', 'src/b'], ['tools/t.js', 'tools']]), null,
      { root: { base: 'src/', other: '' }, paths: new Map([['src/a.js', 'a.js'], ['src/b/c.js', 'b/c.js'], ['tools/t.js', '../tools/t.js']]) })],
    [['a.js', '.'], ['b/c.js', 'b'], ['../tools/t.js', '../tools']], 'the root itself reads as `.`, a directory outside it as its files do')
  })

  it('takes no root where two would pair as many, so the open bundle never decides', () => {
    const one = ['a.js', 'b.js', 'x/c.js', 'x/d.js'], two = ['x/a.js', 'x/b.js', 'c.js', 'd.js']
    assert.equal(treeLayout(one, two).root, null, 'x/ either way')
    assert.equal(treeLayout(two, one).root, null)
    const contents = paths => m(Object.fromEntries(paths.map(path => [path, path.at(-4)])))
    const forward = computeBundleDiff(contents(one), contents(two), own)
    const backward = computeBundleDiff(contents(two), contents(one), own)
    assert.deepEqual([forward.totals.unchangedFiles, forward.totals.onlyBaseFiles], [backward.totals.unchangedFiles, backward.totals.onlyOtherFiles])
    assert.equal(treeLayout(['a.js', 'b.js'], ['x/a.js', 'x/b.js', 'y/a.js', 'y/b.js']).root, null, 'two directories holding as many')
  })

  it('places a module where its files went, a ../ further out where the root could not place them clear', () => {
    const base = m({ 'src/a.js': 'a', 'src/b.js': 'b', 'tools/crate/lib.rs': 'r' })
    const other = m({ 'a.js': 'a', 'b.js': 'b', '../tools/crate/lib.rs': 'other' })
    const layout = treeLayout(base.keys(), other.keys())
    assert.equal(layout.paths.get('tools/crate/lib.rs'), '../../tools/crate/lib.rs')
    assert.equal(layoutDir(layout, 'tools/crate', ['lib.rs']), '../../tools/crate')
    assert.equal(layoutDir(layout, 'tools/other', ['x.rs']), '../tools/other', 'a module none of whose files are laid out moves with the root')
    assert.equal(layoutDir(layout, '.', ['src/a.js']), '.')
    assert.deepEqual(layoutPackageDirs(new Map([['tools/crate/lib.rs', 'tools/crate']]), null, layout).get('../../tools/crate/lib.rs'), '../../tools/crate')
  })

  it('keeps paths as they are where they line up, or only a few would move', () => {
    assert.equal(treeLayout(['a.js', 'b.js', 'lib/a.js'], ['a.js', 'b.js', 'lib/a.js']).root, null)
    assert.equal(treeLayout(['a.js', 'b.js', 'c.js', 'd.js'], ['src/a.js', 'x.js', 'y.js', 'z.js']).root, null, 'one file of four')
    assert.equal(treeLayout(['own/src/a.js', 'own/keep.js'], ['own/lib/a.ts', 'own/keep.js']).root, null)
    assert.equal(computeBundleDiff(m({ 'a.js': 'a' }), m({ 'a.js': 'b' }), own).files.root, null)
  })
})

describe('Code view model', () => {
  const lines = n => Array.from({ length: n }, (_, i) => `line ${i + 1}`)
  const text = list => list.map(line => `${line}\n`).join('')

  test('lines are numbered as the diff numbers them', () => {
    assert.deepEqual(textLines(''), [])
    assert.deepEqual(textLines('a'), ['a'])
    assert.deepEqual(textLines('a\n'), ['a'])
    assert.deepEqual(textLines('a\n\nb'), ['a', '', 'b'])
  })

  test('a changed file folds unchanged runs down to their context', () => {
    const before = lines(40)
    const after = before.toSpliced(19, 1, 'line 20 changed')
    const model = lineDiff(text(before), text(after))
    assert.deepEqual(model.blocks, [{ a0: 19, a1: 20, b0: 19, b1: 20 }])
    assert.equal(model.additions, 1)
    assert.equal(model.deletions, 1)
    const rows = diffRows(model)
    assert.deepEqual(rows.map(row => row.kind), ['fold', 'ctx', 'ctx', 'ctx', 'del', 'add', 'ctx', 'ctx', 'ctx', 'fold'])
    assert.deepEqual(rows[0], { kind: 'fold', run: 0, a: 0, b: 0, count: 19 - DIFF_CONTEXT, up: true, down: false })
    assert.deepEqual(rows.at(-1), { kind: 'fold', run: 1, a: 23, b: 23, count: 17, up: false, down: true })
    assert.equal(rows[4].pair, 19, 'the removed line pairs with the added one')
    assert.equal(rows[5].pair, 19)

    // Expanding reveals lines next to the change, or the whole run.
    const up = diffRows(model, new Map([[0, { bottom: 5 }]]))
    assert.equal(up[0].count, 19 - DIFF_CONTEXT - 5)
    assert.equal(up.filter(row => row.kind === 'ctx').length, 2 * DIFF_CONTEXT + 5)
    const all = diffRows(model, new Map([[0, { all: true }], [1, { all: true }]]))
    assert.equal(all.filter(row => row.kind === 'fold').length, 0)
    assert.equal(all.length, 41)
  })

  test('short unchanged runs show in full instead of folding', () => {
    const edges = n => { const before = lines(n); return lineDiff(text(before), text(before.toSpliced(0, 1, 'first').toSpliced(n - 1, 1, 'last'))) }
    const folds = n => diffRows(edges(n)).filter(row => row.kind === 'fold').map(row => row.count)
    assert.deepEqual(folds(11), [], '9 lines between the changes: three on each side leave three, too few to fold')
    assert.deepEqual(folds(12), [4])
  })

  test('added and removed files are one block of every line', () => {
    const added = lineDiff('', 'a\nb\n')
    assert.deepEqual(diffRows(added).map(row => [row.kind, row.b]), [['add', 0], ['add', 1]])
    const removed = lineDiff('a\nb', '')
    assert.deepEqual(diffRows(removed).map(row => [row.kind, row.a]), [['del', 0], ['del', 1]])
    assert.deepEqual(removed.noEol, { a: true, b: false })
  })

  test('ignoring whitespace pairs lines that differ only in how much of it they have, as diff -b does', () => {
    assert.equal(lineDiff('a  b\nc\n', 'a b\nc\n', { ignoreWhitespace: true }).blocks.length, 0)
    assert.equal(lineDiff('a  b\nc\n', 'a b\nc\n').blocks.length, 1)
    assert.equal(lineDiff('  a()\n', '    a()\n', { ignoreWhitespace: true }).blocks.length, 0, 're-indented')
    for (const [before, after] of [['exec("rm -rf /tmp/x")\n', 'exec("rm -rf / tmp/x")\n'], ['return x\n', 'returnx\n'], ['c()\n', '    c()\n']]) {
      assert.equal(lineDiff(before, after, { ignoreWhitespace: true }).blocks.length, 1, `${JSON.stringify(before)} → ${JSON.stringify(after)}: blanks put between other characters, or taken from there`)
    }
  })

  test('what diff -b would hide: whether it hides a change, and one mixing kinds of blank', () => {
    assert.deepEqual(whitespaceHidden('  a()\n', '    a()\n'), { hides: true, mixed: false })
    assert.deepEqual(whitespaceHidden('  a()\n', '\ta()\n'), { hides: true, mixed: true }, 'spaces turned to a tab')
    assert.deepEqual(whitespaceHidden('\t  a()\n', '\t    a()\n'), { hides: true, mixed: true }, 'a run of tabs and spaces made longer')
    assert.deepEqual(whitespaceHidden('a b\n', 'ab\n'), { hides: false, mixed: false }, 'a blank taken from between two characters shows')
  })

  test('whitespace is hidden only in files whose whitespace means nothing, told by extension or #! line', () => {
    for (const path of ['src/a.js', 'src/a.mjs', 'src/a.cjs', 'src/a.jsx', 'src/a.ts', 'types/a.d.ts', 'src/a.tsx', 'package.json', 'tsconfig.jsonc', 'styles/a.css', 'styles/a.SCSS',
      'styles/a.less', 'index.html', 'icon.svg', 'pom.xml', 'src/a.c', 'src/a.h', 'src/a.cpp', 'src/A.java', 'build.gradle.kts', 'main.go', 'src/lib.rs', 'App.cs', 'App.swift', 'index.php', 'install.sh']) {
      assert.equal(whitespaceInsensitive(path), true, path)
    }
    for (const path of ['tools/gen.py', '.github/workflows/ci.yml', 'Makefile', 'README.md', 'src/a.coffee', 'views/a.pug', 'styles/a.sass', 'data/a.tsv', 'src/Main.lagda',
      'src/App.vue', 'LICENSE', 'notes.txt', 'binding.gyp', 'pyproject.toml', 'src/a.jsonl', 'src/a.json.py']) {
      assert.equal(whitespaceInsensitive(path), false, `${path}: whatever its type might be, its whitespace shows`)
    }
    // An extensionless script, by its #! line, one known whole.
    for (const line of ['#!/usr/bin/env node', '#! /usr/bin/env node', '#!/usr/local/bin/node', '#!/bin/sh', '#!/bin/bash -e', '#!/usr/bin/env deno']) {
      assert.equal(whitespaceInsensitive('bin/tool', `${line}\nrun()\n`), true, line)
      assert.equal(whitespaceInsensitive('bin/tool', line), true, `${line}, alone`)
    }
    for (const line of ['#!/usr/bin/env python3', '#!/usr/bin/env -S -u node python3', '#!/usr/bin/env -S node --no-warnings', '#!/usr/bin/env node2',
      '#!/usr/bin/env node # python', '#!/usr/bin/env node\r', '#!/usr/bin/env shellcheck', '#!/usr/bin/coffee', '// #!/usr/bin/env node', ' #!/bin/sh']) {
      assert.equal(whitespaceInsensitive('bin/tool', `${line}\nrun()\n`), false, JSON.stringify(line))
    }
    assert.equal(whitespaceInsensitive('bin/tool', 'run()\n'), false, 'nor one with no #! line')
    assert.equal(whitespaceInsensitive('bin/tool', null), false, 'nor a side that is not text')
    // A stasis bundle's own format for the file, where it records one, over its name.
    for (const [path, format, insensitive] of [['src/a.js', 'module', true], ['CMakeLists.txt', 'cmake', true], ['gradlew', 'shell', true], ['App.xcodeproj/project.pbxproj', 'pbxproj', true],
      ['src/a.js', 'resource', false], ['src/a.js', 'resource:base64', false], ['tools/gen.py', 'python', false], ['Podfile', 'podfile', false], ['ios/Podfile.lock', 'podfile-lock', false],
      ['fix.patch', 'patch', false], ['src/a.js', 'a-format-no-one-knows', false]]) {
      assert.equal(whitespaceInsensitive(path, '', format), insensitive, `${path} as ${format}`)
    }
  })

  test('changed lines pair with the added line they were edited into, in unified and split rows alike', () => {
    const before = 'start\n  const rows = query.all({ limit: 50 })\n  res.json(rows)\nend\n'
    const after = 'start\n  const limit = Math.min(Number(req.query.limit) || 50, 200)\n  const rows = query.all({ limit })\n  res.json(rows)\nend\n'
    const model = lineDiff(before, after)
    assert.deepEqual(model.blocks, [{ a0: 1, a1: 2, b0: 1, b1: 3 }])
    const unified = diffRows(model)
    assert.deepEqual(unified.filter(row => row.kind !== 'ctx').map(row => [row.kind, row.a ?? row.b, row.pair]), [
      ['del', 1, 2], ['add', 1, null], ['add', 2, 1],
    ], 'the removed line pairs with the second added line, not the first')
    const split = diffRows(model, new Map(), { split: true })
    assert.deepEqual(split.map(row => row.kind === 'change' ? [row.left, row.right, row.paired] : row.kind), [
      'ctx', [null, 1, false], [1, 2, true], 'ctx', 'ctx',
    ], 'the added line before the pair runs against a blank')

    const positional = lineDiff('a\nb\nc\nd\n', 'a\nB\nC2\nC3\nd\n')
    assert.deepEqual(diffRows(positional, new Map(), { split: true }).map(row => row.kind === 'change' ? [row.left, row.right] : row.kind), [
      'ctx', [1, 1], [2, 2], [null, 3], 'ctx',
    ], 'unrelated lines share rows by position')
  })

  test('marks go around the changed characters without crossing highlight tags', () => {
    const markup = '<span class="token keyword">const</span> a <span class="token operator">=</span> &lt;b&gt;'
    // Text: `const a = <b>` — mark `a = <` (6..11).
    assert.equal(markHighlighted(markup, [[6, 11]]),
      '<span class="token keyword">const</span> <mark class="diff-word">a </mark><span class="token operator"><mark class="diff-word">=</mark></span><mark class="diff-word"> &lt;</mark>b&gt;')
    assert.equal(markHighlighted(markup, []), markup)
    assert.deepEqual(markSegments('abcdef', [[1, 3], [4, 5]]), [
      { text: 'a', marked: false }, { text: 'bc', marked: true }, { text: 'd', marked: false }, { text: 'e', marked: true }, { text: 'f', marked: false },
    ])
  })

  test('a block the server marks is marked, its lines counted apart, and a mark that is no block of the diff is none', () => {
    const after = 'function q(b) {\n  return b;\n}\nf(2);\n', before = 'function q(a) {\n  return a;\n}\nf(1);\n'
    const { blocks } = lineDiff(before, after)
    assert.deepEqual(blocks, [{ a0: 0, a1: 2, b0: 0, b1: 2 }, { a0: 3, a1: 4, b0: 3, b1: 4 }])
    const marked = lineDiff(before, after, { marks: [blocks[0]] })
    assert.deepEqual([...marked.marked], [0])
    assert.deepEqual([marked.additions, marked.deletions, marked.renamed], [1, 1, 2], 'the renamed lines counted apart')
    assert.equal(lineDiff(before, after, { marks: [{ a0: 0, a1: 1, b0: 0, b1: 1 }] }).marked.size, 0, 'part of a block')
  })

  test('a file\'s lines added and removed, as the tree lists them', () => {
    assert.deepEqual(fileLineCounts('a\nb\nc\n', 'a\nB\nc\nd\n'), { additions: 2, deletions: 1 })
    assert.deepEqual(fileLineCounts('same\n', 'same\n'), { additions: 0, deletions: 0 }, 'renamed as it was')
    assert.deepEqual(fileLineCounts('', 'a\nb'), { additions: 2, deletions: 0 }, 'added, last line unended')
    assert.deepEqual(fileLineCounts('a\nb\n', ''), { additions: 0, deletions: 2 }, 'removed')
    assert.deepEqual(fileLineCounts('a', 'a\n'), { additions: 1, deletions: 1 }, 'a newline added at the end changes that line')
    // As the diff's head counts them, for the same two sides.
    const before = text(lines(40))
    const after = text(lines(40).map((line, i) => i % 7 === 0 ? `${line} changed` : line))
    const { additions, deletions } = lineDiff(before, after)
    assert.deepEqual(fileLineCounts(before, after), { additions, deletions })
    assert.equal(fileLineCounts(new Uint8Array([1]), ''), null, 'not text')
    assert.equal(fileLineCounts('', new Uint8Array([1])), null)
    assert.equal(fileLineCounts(text(lines(10_001)), text(lines(10_000))), null, 'too large to count while the tree draws')
    assert.deepEqual(fileLineCounts('', text(lines(30_000))), { additions: 30_000, deletions: 0 }, 'an added file is counted however large')
  })
})

describe('Compare inputs', () => {
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
  test('Compare hides scopes unless one changes the files compared on some side', () => {
    const base = details({ 'cli.js': 'old', 'lib.js': 'lib' }, { run: ['cli.js', 'lib.js'] })
    assert.deepEqual(bundleCompareScopes(base), [])
    assert.deepEqual(bundleCompareScopes(base, null), [])
    assert.deepEqual(bundleCompareScopes(base, details({ 'cli.js': 'new' }, { run: ['cli.js'] })), [])
    const narrowed = details({ 'cli.js': 'new', 'extra.js': 'extra' }, { run: ['cli.js'] })
    assert.deepEqual(bundleCompareScopes(base, narrowed).map(scope => scope.id), ['reason:run'])
    const partial = details({ 'cli.js': 'old', 'lib.js': 'lib' }, { run: ['cli.js'] })
    assert.deepEqual(bundleCompareScopes(partial).map(scope => scope.id), ['reason:run'])
  })
  test('custom trees retain their exact paths and sourcemaps have no named trees', () => {
    const bundle = details({ 'src/app.js': 'a', 'tool.js': 'b' }, { 'custom build': ['src/app.js'] })
    assert.deepEqual(bundleCompareScopes(bundle), [{ id: 'reason:custom build', label: 'custom build' }])
    assert.deepEqual([...bundleCompareFiles(bundle, 'reason:custom build').keys()], ['src/app.js'])
    const map = { kind: 'sourcemap', json: { sources: ['file.js'], sourcesContent: ['source'] } }
    assert.deepEqual(bundleCompareScopes(map), [])
    assert.equal(bundleCompareFiles(map).size, 1)
    assert.equal(bundleCompareFiles(map, 'reason:run').size, 1, 'a sourcemap is compared whole under any tree')
  })
  test('a tree narrows only the stasis side of a comparison with a sourcemap', () => {
    const stasis = details({ 'cli.js': 'cli', 'metro.js': 'metro' }, { run: ['cli.js'], metro: ['metro.js'] })
    const map = { kind: 'sourcemap', json: { sources: ['metro.js', 'other.js'], sourcesContent: ['metro', 'other'] } }
    assert.deepEqual(bundleCompareScopes(stasis, map).map(scope => scope.id), ['reason:metro', 'reason:run'])
    const diff = computeBundleDiff(bundleCompareFiles(stasis, 'reason:metro'), bundleCompareFiles(map, 'reason:metro'), () => '__own__')
    assert.deepEqual([diff.totals.baseFiles, diff.totals.otherFiles, diff.totals.unchangedFiles, diff.totals.onlyOtherFiles], [1, 2, 1, 1])
    const whole = details({ 'metro.js': 'metro' }, { metro: ['metro.js'] })
    assert.deepEqual(bundleCompareScopes(whole, map), [], 'a sourcemap alone narrows nothing')
  })
  test('a side whose sole tree holds all its files, named by no other, is compared within it under the others\' trees', () => {
    const scoped = details({ 'cli.js': 'new', 'metro.js': 'metro', 'manual.js': 'added' }, { run: ['cli.js'], metro: ['metro.js'], add: ['manual.js'] })
    const whole = details({ 'cli.js': 'old', 'metro.js': 'metro' }, { bundle: ['cli.js', 'metro.js'] })
    assert.deepEqual(bundleCompareScopes(scoped, whole).map(scope => scope.id), ['reason:add', 'reason:metro', 'reason:run'], 'its tree not offered')
    assert.deepEqual(bundleCompareScopes(whole, scoped).map(scope => scope.id), ['reason:add', 'reason:metro', 'reason:run'], 'on either side')
    assert.deepEqual(bundleCompareSideScopes(whole, scoped, 'reason:metro'), ['reason:bundle', 'reason:metro'])
    assert.deepEqual(bundleCompareSideScopes(scoped, whole, 'reason:run'), ['reason:run', 'reason:bundle'])
    assert.deepEqual(bundleCompareSideScopes(whole, scoped, ''), ['', ''], 'unscoped, both whole')
    assert.deepEqual(bundleCompareSideScopes(whole, scoped, null), ['', ''])
    const metro = prepareComparison(whole, scoped, 'reason:metro')
    assert.deepEqual([metro.totals.baseFiles, metro.totals.otherFiles, metro.totals.unchangedFiles, metro.totals.onlyBaseFiles], [2, 1, 1, 1], 'the metro tree against every file of the other')
    assert.equal(metro.scope, 'reason:metro')
    const run = prepareComparison(whole, scoped, 'reason:run')
    assert.deepEqual([run.totals.baseFiles, run.totals.otherFiles, run.totals.changedFiles], [2, 1, 1])
  })
  test('a sole tree holding all its files is compared within its own tree where the other names it too', () => {
    const whole = details({ 'cli.js': 'old' }, { bundle: ['cli.js'] })
    const shared = details({ 'cli.js': 'new', 'metro.js': 'metro' }, { bundle: ['cli.js'], metro: ['metro.js'] })
    assert.deepEqual(bundleCompareScopes(whole, shared).map(scope => scope.id), ['reason:bundle', 'reason:metro'])
    assert.deepEqual(bundleCompareSideScopes(whole, shared, 'reason:metro'), ['reason:metro', 'reason:metro'], 'the metro tree absent from it')
    assert.equal(prepareComparison(whole, shared, 'reason:metro').totals.baseFiles, 0)
    // Each side's one tree holding all its files, named by no other: nothing narrows.
    const app = details({ 'cli.js': 'new' }, { app: ['cli.js'] })
    assert.deepEqual(bundleCompareScopes(whole, app), [])
    assert.deepEqual(bundleCompareSideScopes(whole, app, 'reason:app'), ['reason:bundle', 'reason:app'])
    // Narrower than all its files, or one of several trees: compared within the scope asked.
    const partial = details({ 'cli.js': 'old', 'lib.js': 'lib' }, { bundle: ['cli.js'] })
    assert.deepEqual(bundleCompareScopes(partial, shared).map(scope => scope.id), ['reason:bundle', 'reason:metro'])
    assert.deepEqual(bundleCompareScopes(partial, app).map(scope => scope.id), ['reason:bundle'])
    assert.deepEqual(bundleCompareSideScopes(partial, app, 'reason:bundle'), ['reason:bundle', 'reason:app'])
    const both = details({ 'cli.js': 'old', 'lib.js': 'lib' }, { bundle: ['cli.js', 'lib.js'], lib: ['lib.js'] })
    assert.deepEqual(bundleCompareSideScopes(both, app, 'reason:lib'), ['reason:lib', 'reason:app'])
  })
  test('where neither side is trivial and each names a tree the other doesn\'t, the shared trees are offered and each own tree paired with each of the other\'s', () => {
    const base = details({ 'cli.js': 'old', 'metro.js': 'metro', 'manual.js': 'added' }, { run: ['cli.js'], metro: ['metro.js'], add: ['manual.js'] })
    const other = details({ 'cli.js': 'new', 'app.js': 'metro', 'tool.js': 'tool' }, { run: ['cli.js'], bundle: ['app.js'], build: ['tool.js'] })
    const scopes = bundleCompareScopes(base, other)
    assert.deepEqual(scopes.map(scope => scope.label), ['run', 'add → build', 'add → bundle', 'metro → build', 'metro → bundle'], 'from the first side\'s to the second\'s')
    assert.deepEqual(scopes[0].id, 'reason:run')
    const pair = scopes.find(scope => scope.label === 'metro → bundle').id
    assert.deepEqual(bundleCompareScopes(other, base).map(scope => scope.label), ['run', 'build → add', 'build → metro', 'bundle → add', 'bundle → metro'])
    assert.ok(bundleCompareScopes(other, base).some(scope => scope.id === pair), 'the same scope whichever side is first')
    assert.deepEqual(bundleCompareSideScopes(base, other, pair), ['reason:metro', 'reason:bundle'])
    assert.deepEqual(bundleCompareSideScopes(other, base, pair), ['reason:bundle', 'reason:metro'])
    assert.deepEqual(bundleCompareSideScopes(base, other, 'reason:run'), ['reason:run', 'reason:run'], 'a shared tree on both sides')
    const diff = prepareComparison(base, other, pair)
    assert.deepEqual([diff.totals.baseFiles, diff.totals.otherFiles], [1, 1], 'metro.js against app.js')
    assert.deepEqual(diff.files.changed.map(row => [row.renamedFrom, row.path]), [['metro.js', 'app.js']], 'paired as one renamed')
    assert.equal(diff.scope, pair)
    assert.deepEqual([...bundleCompareFiles(base, bundleCompareSideScopes(base, other, 'reasons:not json')[0])], [], 'a scope naming no pair names no tree')
    const known = details({ 'cli.js': 'new', 'manual.js': 'added' }, { run: ['cli.js'], add: ['manual.js'] })
    const metro = details({ 'cli.js': 'old', 'metro.js': 'metro' }, { run: ['cli.js'], metro: ['metro.js'] })
    assert.deepEqual(bundleCompareScopes(metro, known).map(scope => scope.label), ['run', 'metro → add'])
    assert.equal(scanScopeOptions(bundleCompareScopes(metro, known)), null, 'one dropdown, its trees all known as they are')
    assert.notEqual(scanScopeOptions(bundleCompareScopes(metro, details({ 'cli.js': 'new' }, { run: ['cli.js'] }))), null, 'toggles where the trees are one union')
  })
  test('trees are offered as one union where a side is trivial or names none but the other\'s', () => {
    const scoped = details({ 'cli.js': 'old', 'metro.js': 'metro' }, { run: ['cli.js'], metro: ['metro.js'] })
    const subset = details({ 'cli.js': 'new', 'tool.js': 'tool' }, { run: ['cli.js'] })
    assert.deepEqual(bundleCompareScopes(scoped, subset).map(scope => scope.id), ['reason:metro', 'reason:run'], 'one side\'s trees within the other\'s')
    const whole = details({ 'cli.js': 'new' }, { run: ['cli.js'] })
    assert.deepEqual(bundleCompareScopes(scoped, whole).map(scope => scope.id), ['reason:metro', 'reason:run'], 'its sole tree holding all its files, named by the other')
    const none = details({ 'cli.js': 'new' })
    assert.deepEqual(bundleCompareScopes(scoped, none).map(scope => scope.id), ['reason:metro', 'reason:run'], 'naming no tree')
    const map = { kind: 'sourcemap', json: { sources: ['cli.js'], sourcesContent: ['new'] } }
    assert.deepEqual(bundleCompareScopes(scoped, map).map(scope => scope.id), ['reason:metro', 'reason:run'])
  })
  test('a capture\'s and a static build\'s names for the same trees are compared as one, labelled as the capture names them, with extra for add', () => {
    const capture = details({ 'cli.js': 'old', 'app.js': 'app', 'manual.js': 'added' }, { run: ['cli.js'], metro: ['app.js'], add: ['manual.js'] })
    const built = details({ 'cli.js': 'new', 'app.js': 'app', 'extra.js': 'extra' }, { bundle: ['cli.js'], 'bundle:metro': ['app.js'], extra: ['extra.js'] })
    for (const [first, second] of [[capture, built], [built, capture]]) {
      const scopes = bundleCompareScopes(first, second)
      assert.deepEqual(scopes.map(scope => scope.id), ['reason:extra', 'reason:metro', 'reason:run'], 'whichever side is first')
      assert.deepEqual(scanScopeOptions(scopes).map(option => [option.label, option.subtitle]),
        [['All files', 'Everything'], ['metro', 'Metro bundle contents'], ['run', 'Bundler and Node.js CLI'], ['extra', 'Extra files']], 'the inline toggle')
    }
    assert.deepEqual(bundleCompareSideScopes(capture, built, 'reason:metro'), ['reason:metro', 'reason:bundle:metro'])
    assert.deepEqual(bundleCompareSideScopes(built, capture, 'reason:run'), ['reason:bundle', 'reason:run'])
    assert.deepEqual(bundleCompareSideScopes(capture, built, 'reason:extra'), ['reason:add', 'reason:extra'])
    const run = prepareComparison(capture, built, 'reason:run')
    assert.deepEqual(run.files.changed.map(row => row.path), ['cli.js'], 'the capture\'s run tree against the build\'s bundle tree')
    assert.deepEqual([run.totals.baseFiles, run.totals.otherFiles], [1, 1])
    assert.deepEqual([...prepareComparison(capture, built, 'reason:extra').files.onlyOther.map(row => row.path)], ['extra.js'])
  })
  test('names are compared as one only where each side names one of them alone', () => {
    const tree = (reason) => details({ 'cli.js': 'cli', 'app.js': 'app', 'manual.js': 'added' }, reason)
    const ids = (first, second) => bundleCompareScopes(tree(first), tree(second)).map(scope => scope.label)
    assert.deepEqual(ids({ run: ['cli.js'], add: ['manual.js'] }, { run: ['cli.js'], extra: ['manual.js'] }), ['extra', 'run'], 'add as extra')
    assert.deepEqual(ids({ run: ['cli.js'], add: ['manual.js'], extra: ['app.js'] }, { run: ['cli.js'], extra: ['manual.js'] }), ['add', 'extra', 'run'], 'not where one side names both')
    assert.deepEqual(ids({ run: ['cli.js'], metro: ['app.js'] }, { run: ['cli.js'], 'bundle:metro': ['app.js'] }), ['metro', 'run'], 'bundle:metro as metro alone')
    assert.deepEqual(ids({ run: ['cli.js'], add: ['manual.js'] }, { bundle: ['cli.js'], extra: ['manual.js'] }), ['extra', 'run → bundle'], 'bundle as run only where bundle:metro is metro: a pair of trees each names alone')
    assert.deepEqual(ids({ run: ['cli.js'], metro: ['app.js'] }, { bundle: ['cli.js'], 'bundle:metro': ['app.js'], run: ['manual.js'] }), ['bundle', 'metro', 'run'], 'nor where the build names run too')
    assert.deepEqual(ids({ metro: ['app.js'], add: ['manual.js'] }, { bundle: ['cli.js'], 'bundle:metro': ['app.js'] }), ['metro', 'add → bundle'], 'nor where the capture names no run')
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
  test('Code view diffs list every line of both sides in order, whitespace included', () => {
    for (const [before, after] of [
      ['const x = 1;\n', 'const x = 2;\n'],
      ['a\nb', 'a\nb\n'],
      ['é\n  first\n', 'é\n first\n<script>alert(1)</script>\n'],
      ['', 'new\n'], ['removed\n', ''],
    ]) {
      const model = lineDiff(before, after)
      const rows = diffRows(model, new Map(Array.from({ length: model.blocks.length + 1 }, (_, run) => [run, { all: true }])))
      assert.deepEqual(rows.filter(row => row.kind !== 'add').map(row => model.a[row.a]), model.a)
      assert.deepEqual(rows.filter(row => row.kind !== 'del').map(row => model.b[row.b]), model.b)
      assert.ok(rows.some(row => ['add', 'del'].includes(row.kind)))
    }
  })
})
