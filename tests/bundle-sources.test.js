// `ui/view/bundle-sources.js` — the shared bundle-shape extractors the
// Code tab, finding tree, graph data, treemap, and in-shell FS all read
// through. Pure (no Lit / DOM / `state`), so the test imports it straight
// and feeds it hand-built `details` shapes.
//
// `bundlePackageDirs` is the piece exercised here: it mirrors a stasis
// `Bundle.sources` getter's path construction (`dir/rel`, or bare `rel`
// for the `.` root) to map every source path back to the package dir
// that owns it — the authoritative separation the package views bucket
// by. Only stasis bundles carry that metadata; sourcemaps return null.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { bundlePackageDirs } = await import('../ui/view/bundle-sources.js')

// Minimal stand-in for an `@exodus/stasis` Bundle: the helper only
// touches `.modules` (a Map<dir, { files }>), so that's all we build.
function stasisDetails(modules) {
  return { kind: 'stasis', bundle: { modules: new Map(modules) } }
}

describe('bundlePackageDirs', () => {
  it('maps `.` root files to bare relative paths', () => {
    const map = bundlePackageDirs(stasisDetails([
      ['.', { files: { 'index.php': 'a', 'src/App.php': 'b' } }],
    ]))
    assert.equal(map.get('index.php'), '.')
    assert.equal(map.get('src/App.php'), '.')
  })

  it('prefixes non-root package files with the package dir', () => {
    const map = bundlePackageDirs(stasisDetails([
      ['vendor/aws/aws-crt-php', { files: { 'src/AWS.php': 'a' } }],
      ['vendor/aws/aws-sdk-php', { files: { 'src/S3/S3Client.php': 'b' } }],
    ]))
    // The two sibling workspace packages stay distinct — the whole
    // point of following stasis separation over the path heuristic
    // (which would collapse both under `vendor`).
    assert.equal(map.get('vendor/aws/aws-crt-php/src/AWS.php'), 'vendor/aws/aws-crt-php')
    assert.equal(map.get('vendor/aws/aws-sdk-php/src/S3/S3Client.php'), 'vendor/aws/aws-sdk-php')
  })

  it('lines up with the `dir/rel` keys callers look up by', () => {
    const map = bundlePackageDirs(stasisDetails([
      ['.', { files: { 'index.js': 'x' } }],
      ['node_modules/foo', { files: { 'index.js': 'y' } }],
    ]))
    assert.deepEqual([...map.keys()].toSorted(), ['index.js', 'node_modules/foo/index.js'])
    assert.equal(map.get('node_modules/foo/index.js'), 'node_modules/foo')
  })

  it('returns null for sourcemap bundles (no package metadata)', () => {
    assert.equal(bundlePackageDirs({ kind: 'sourcemap', json: { sources: ['a.js'] } }), null)
  })

  it('returns null when there is no parsed bundle', () => {
    assert.equal(bundlePackageDirs({ kind: 'stasis' }), null)
    assert.equal(bundlePackageDirs(null), null)
    assert.equal(bundlePackageDirs(undefined), null)
  })
})
