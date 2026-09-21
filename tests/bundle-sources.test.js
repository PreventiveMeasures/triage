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

const { Bundle } = await import('@exodus/stasis-core/bundle')
const { createTerminal } = await import('@preventive/terminal')
const { bundlePackageDirs, bundlePackageVersions, bundleSourcesAsMap } = await import('../ui/view/bundle-sources.js')

// A real Bundle, because the point of these cases is what the package
// actually stores: `Bundle.sources` is the raw content of every entry,
// resources included, so only `Bundle.formats` separates source from
// the rest.
function bundleWith(files, formats) {
  return { kind: 'stasis', bundle: new Bundle({
    config: { scope: 'full' },
    modules: new Map([['.', { name: 'app', version: '1.0.0', files }]]),
    formats: new Map(Object.entries(formats)),
  }) }
}

// Minimal stand-in for an `@exodus/stasis-core` Bundle: the helper only
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

describe('bundlePackageVersions', () => {
  it('maps each node_modules dependency to its version set', () => {
    const versions = bundlePackageVersions(stasisDetails([
      ['node_modules/lodash', { name: 'lodash', version: '4.17.21', files: {} }],
      ['node_modules/@scope/pkg', { name: '@scope/pkg', version: '1.2.0', files: {} }],
    ]))
    assert.deepEqual([...versions.get('lodash')], ['4.17.21'])
    assert.deepEqual([...versions.get('@scope/pkg')], ['1.2.0'])
  })

  it('collects duplicate majors of one package into a single set', () => {
    const versions = bundlePackageVersions(stasisDetails([
      ['node_modules/.pnpm/foo@1.0.0/node_modules/foo', { name: 'foo', version: '1.0.0', files: {} }],
      ['node_modules/.pnpm/foo@2.0.0/node_modules/foo', { name: 'foo', version: '2.0.0', files: {} }],
    ]))
    assert.deepEqual([...versions.get('foo')].toSorted(), ['1.0.0', '2.0.0'])
  })

  it('skips workspace / own-source entries and versionless modules', () => {
    const versions = bundlePackageVersions(stasisDetails([
      ['.', { name: null, version: null, files: {} }],                       // own source
      ['vendor/aws/aws-sdk-php', { name: 'aws-sdk-php', version: '3.0.0', files: {} }], // workspace, not node_modules
      ['node_modules/bar', { name: 'bar', version: '', files: {} }],          // no concrete version
      ['node_modules/baz', { name: 'baz', version: '1.0.0', files: {} }],     // kept
    ]))
    assert.deepEqual([...versions.keys()], ['baz'])
  })

  it('returns an empty map for sourcemaps and unparsed bundles', () => {
    assert.equal(bundlePackageVersions({ kind: 'sourcemap', json: {} }).size, 0)
    assert.equal(bundlePackageVersions({ kind: 'stasis' }).size, 0)
    assert.equal(bundlePackageVersions(null).size, 0)
  })
})

describe('bundleSourcesAsMap — what counts as a source', () => {
  it('keeps ordinary source entries', () => {
    const map = bundleSourcesAsMap(bundleWith({ 'index.js': 'export const a = 1\n' }, { 'index.js': 'commonjs' }))
    assert.deepEqual([...map], [['index.js', 'export const a = 1\n']])
  })

  // The reported bug: a readdir capture's content is a JSON array of
  // names, which is a string, so a type check waves it through and the
  // terminal mounts a file where a directory belongs.
  it('drops a `directory` capture rather than calling its listing a file', () => {
    const map = bundleSourcesAsMap(bundleWith(
      { 'index.js': 'x\n', 'assets': JSON.stringify(['a.png', 'b.png']) },
      { 'index.js': 'commonjs', 'assets': 'directory' },
    ))
    assert.deepEqual([...map.keys()], ['index.js'])
    assert.equal(map.get('assets'), undefined, 'the listing is not source')
  })

  it('drops resources, base64 ones included', () => {
    // `resource` is bytes and was already skipped by type; `resource:base64`
    // is stored as base64 TEXT and was not, despite every consumer being
    // told resources are absent.
    const map = bundleSourcesAsMap(bundleWith(
      { 'index.js': 'x\n', 'logo.png': 'iVBORw0KGgoAAAANSUhEUg==', 'blob.bin': Buffer.from([1, 2, 3]) },
      { 'index.js': 'commonjs', 'logo.png': 'resource:base64', 'blob.bin': 'resource' },
    ))
    assert.deepEqual([...map.keys()], ['index.js'])
  })

  it('keeps every entry of a bundle that records no formats (v0)', () => {
    // v0 bundles carry no per-file formats: `formats.get` is undefined,
    // which is not a resource format, so nothing is newly dropped.
    const map = bundleSourcesAsMap(bundleWith({ 'index.js': 'x\n', 'other.js': 'y\n' }, {}))
    assert.deepEqual([...map.keys()].toSorted(), ['index.js', 'other.js'])
  })

  it('leaves sourcemap bundles alone', () => {
    const map = bundleSourcesAsMap({ kind: 'sourcemap', json: { sources: ['a.js', 'b.js'], sourcesContent: ['A', null] } })
    assert.deepEqual([...map], [['a.js', 'A']], 'an omitted sourcesContent slot is still skipped')
  })
})

describe('bundleSourcesAsMap — the filesystem the terminal is handed', () => {
  // A directory capture keyed at a path real files also live under is
  // the damaging shape: before the format check the terminal saw both a
  // file and a directory at `lib`.
  const details = bundleWith(
    {
      'index.js': 'x\n',
      'lib/util.js': 'y\n',
      'lib': JSON.stringify(['util.js']),
    },
    { 'index.js': 'commonjs', 'lib/util.js': 'commonjs', 'lib': 'directory' },
  )

  const terminal = () => createTerminal(bundleSourcesAsMap(details), { mount: '/sources', home: '/', writable: '/tmp/' })

  it('lists the directory once, not once per role', () => {
    assert.deepEqual(terminal().run('ls').stdout, 'index.js\nlib\n')
  })

  it('lets the directory be listed, which the phantom file prevented', () => {
    assert.deepEqual(terminal().run('ls lib').stdout, 'util.js\n')
  })

  it('reports the path as a directory rather than reading a listing out of it', () => {
    const r = terminal().run('cat lib')
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /Is a directory/u)
  })

  it('walks each path exactly once', () => {
    const paths = terminal().run('find /sources').stdout.trim().split('\n')
    assert.deepEqual(paths, [...new Set(paths)], 'no path appears twice')
    assert.deepEqual(paths.toSorted(), [
      '/sources', '/sources/index.js', '/sources/lib', '/sources/lib/util.js',
    ])
  })
})
