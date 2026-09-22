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
const { bundleFilesAsMap, bundlePackageDirs, bundlePackageVersions, bundleSourcesAsMap } = await import('../ui/view/bundle-sources.js')

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

  it('lists the directory once, not once per role', async () => {
    assert.deepEqual((await terminal().run('ls')).stdout, 'index.js\nlib\n')
  })

  it('lets the directory be listed, which the phantom file prevented', async () => {
    assert.deepEqual((await terminal().run('ls lib')).stdout, 'util.js\n')
  })

  it('reports the path as a directory rather than reading a listing out of it', async () => {
    const r = await terminal().run('cat lib')
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /Is a directory/u)
  })

  it('walks each path exactly once', async () => {
    const paths = (await terminal().run('find /sources')).stdout.trim().split('\n')
    assert.deepEqual(paths, [...new Set(paths)], 'no path appears twice')
    assert.deepEqual(paths.toSorted(), [
      '/sources', '/sources/index.js', '/sources/lib', '/sources/lib/util.js',
    ])
  })
})

describe('bundleFilesAsMap — the filesystem, not just the source', () => {
  // Stasis stores a resource as text when its bytes are valid UTF-8 and
  // as base64 when they are not, so the two formats need opposite
  // treatment. A round trip through the package's own serializer is
  // what proves which is which.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x01])
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>'

  const details = () => {
    const bundle = new Bundle({
      config: { scope: 'full' },
      modules: new Map([['.', { name: 'app', version: '1.0.0', files: {
        'index.js': 'export const a = 1\n',
        'logo.png': Buffer.from(png).toString('base64'),
        'icon.svg': svg,
        'assets': JSON.stringify(['a.png']),
      } }]]),
      formats: new Map([
        ['index.js', 'commonjs'], ['logo.png', 'resource:base64'],
        ['icon.svg', 'resource'], ['assets', 'directory'],
      ]),
    })
    return { kind: 'stasis', bundle: Bundle.parse(bundle.serialize()) }
  }

  it('hands a base64 resource over still spelt base64, for the terminal to decode', () => {
    // Undecoded on purpose since 2.0: the terminal decodes on first
    // read, so a bundle of images costs strings rather than buffers.
    const logo = bundleFilesAsMap(details()).get('logo.png')
    assert.deepEqual(logo, { format: 'base64', data: Buffer.from(png).toString('base64') })
  })

  it('leaves a utf8 resource as the text it already is', () => {
    // `resource` is not base64 — decoding it would corrupt a readable file.
    assert.equal(bundleFilesAsMap(details()).get('icon.svg'), svg)
  })

  it('still skips directory captures', () => {
    assert.equal(bundleFilesAsMap(details()).has('assets'), false)
  })

  it('carries the source entries too', () => {
    assert.equal(bundleFilesAsMap(details()).get('index.js'), 'export const a = 1\n')
  })

  it('leaves bundleSourcesAsMap textual, which its readers rely on', () => {
    // render-bundle.js tells the language bar resources are absent.
    assert.deepEqual([...bundleSourcesAsMap(details()).keys()], ['index.js'])
  })

  it('passes a corrupt base64 spelling along for the terminal to report', async () => {
    // Decoding here could only drop the file silently. Left spelt as it
    // is, the file exists, and the command that reads it says why it
    // cannot — on stderr and on the diagnostic channel.
    const broken = { kind: 'stasis', bundle: new Bundle({
      config: { scope: 'full' },
      modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'index.js': 'x\n', 'bad.png': '!!!not base64!!!' } }]]),
      formats: new Map([['index.js', 'commonjs'], ['bad.png', 'resource:base64']]),
    }) }
    const files = bundleFilesAsMap(broken)
    assert.deepEqual([...files.keys()].toSorted(), ['bad.png', 'index.js'], 'the file is still there')
    const t = createTerminal(files, { mount: '/sources', home: '/', writable: '/tmp/' })
    assert.equal((await t.run('ls')).stdout, 'bad.png\nindex.js\n')
    const r = await t.run('cat bad.png')
    assert.match(r.stderr, /base64 that does not decode/u)
    assert.deepEqual(r.unsupported.map((u) => u.detail), ['base64 source'])
  })
})

describe('bundleFilesAsMap — what the terminal makes of the bytes', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x01])
  const files = () => bundleFilesAsMap({ kind: 'stasis', bundle: new Bundle({
    config: { scope: 'full' },
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: {
      'index.js': 'export const a = 1\n',
      'logo.png': Buffer.from(png).toString('base64'),
    } }]]),
    formats: new Map([['index.js', 'commonjs'], ['logo.png', 'resource:base64']]),
  }) })
  const terminal = () => createTerminal(files(), { mount: '/sources', home: '/', writable: '/tmp/' })

  it('sizes the file by its bytes, not by the base64 that carried it', async () => {
    // 12 bytes; the base64 spelling of them is 16 characters.
    assert.equal((await terminal().run('wc -c logo.png')).stdout.trim().split(/\s+/u)[0], String(png.length))
  })

  it('declines to print bytes that spell no text', async () => {
    const r = await terminal().run('cat logo.png')
    assert.equal(r.stdout, '', 'nothing is printed')
    assert.notEqual(r.exitCode, 0, 'and the command fails')
    assert.match(r.stderr, /^cat: /u, 'saying which command refused')
    // The wording is the package's and has already been rephrased once
    // between betas, so what is pinned here is that refusing is
    // *reported* — on stderr and on the diagnostic channel — rather
    // than the file being printed as mojibake.
    assert.notEqual(r.unsupported.length, 0, 'and reported as a gap')
  })

  it('round-trips the bytes back out through base64', async () => {
    const out = (await terminal().run('base64 logo.png')).stdout.trim()
    assert.deepEqual([...Uint8Array.fromBase64(out)], [...png])
  })

  it('lists it beside the source, as a file like any other', async () => {
    assert.equal((await terminal().run('ls')).stdout, 'index.js\nlogo.png\n')
  })
})
