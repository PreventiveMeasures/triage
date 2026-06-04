// `ui/view/bundle-compare-diff.js` — the pure diff behind the Compare
// slide in the bundles view (view/bundle-compare.js). It takes two
// `Map<path, content>` source maps plus a `pkgOf` bucketing function
// and returns per-file (onlyBase / onlyOther / changed) + per-package
// deltas plus roll-up totals. This module has no Lit / DOM / `state`
// dependency, so the test imports it straight — no `@rray/frontend`
// stub or polyfills needed.
//
// `base` is the open bundle, `other` the one picked to compare; the
// result names the sides onlyBase / onlyOther (not added / removed) so
// the UI can label them with each bundle's actual name. `delta` is
// always `other − base`.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { computeBundleDiff } = await import('../ui/view/bundle-compare-diff.js')

// All fixtures use ASCII content so a string's byte length equals its
// `.length` — keeps the expected-bytes assertions readable.
const m = (obj) => new Map(Object.entries(obj))
// First path segment as the package bucket — exercises the grouping /
// classification logic without dragging in the real `bundlePkgOf`
// (which lives in the Lit-bound render-bundle.js).
const firstSeg = (p) => p.split('/')[0]

describe('computeBundleDiff', () => {
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

  it('counts non-string content as zero bytes', () => {
    // A stasis resource (base64) entry surfaces as non-string content;
    // it should contribute a file but no bytes.
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
