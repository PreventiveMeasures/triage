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
import { describe, it } from 'node:test'

const { layoutDir, layoutPackageDirs, treeLayout } = await import('@preventive/compare')
const { bundleFileMeta, comparePackages, compareSemver, computeBundleDiff, computeVersionUpdates, versionDirection } = await import('../ui/view/bundle-compare-diff.js')
const { Bundle } = await import('@exodus/stasis-core/bundle')
const { bundlePkgOf } = await import('../ui/view/bundle-pkg-of.js')

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
    // Unsaid on a side, or another kind of bundle: nothing to compare.
    assert.equal(computeBundleDiff(m({ 'a/x.js': 'x' }), m({ 'a/x.js': 'x' }), firstSeg, undefined, [stasis({}), stasis({ 'a/x.js': 'module' })]).totals.identical, true, 'a format one side leaves unsaid')
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
