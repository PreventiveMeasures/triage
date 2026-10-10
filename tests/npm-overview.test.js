import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

const state = {}
let advisoriesAnswer = () => Promise.resolve({ versions: [], advisories: [] })
mock.module('../client/index.js', { exports: {
  state, isManagedUiMode: () => true, ensureBundleFindingsIndexed() {}, hasBundleFileHashes() {},
  readBundle() {}, readBundleIndex() {}, recordBundleFileHashes() {}, saveBundleIndex() {},
} })
mock.module('../ui/view/render.js', { exports: { render() {} } })
mock.module('../ui/view/graph/state.js', { exports: { cleanupGraph2() {}, graph2: {} } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchNpmAdvisories: name => advisoriesAnswer(name), fetchNpmStats: () => Promise.resolve({}),
  fetchNpmPackage() {}, fetchNpmVersions: () => Promise.resolve({ versions: [] }), fetchBundleContents() {}, fetchBundleMetadata() {},
} })
const { NPM_LONG_LINE, npmAdvisoryStatus, npmFileExtension, npmFileExtensions, npmFileReadability, npmMergedAdvisories, npmTextEncoding } = await import('../ui/view/npm-overview.js')

test('a file\'s extension follows its name\'s last dot, a declaration file\'s whole', () => {
  for (const [path, extension] of [
    ['lib/index.js', '.js'], ['README.MD', '.md'], ['dist/a.min.js', '.js'], ['lib/index.js.map', '.map'],
    ['types/index.d.ts', '.d.ts'], ['index.d.mts', '.d.mts'], ['x.D.CTS', '.d.cts'], ['.d.ts', '.ts'],
    ['LICENSE', ''], ['.npmignore', ''], ['bin/cli', ''], ['dir.v2/file', ''], ['trailing.', '.'],
  ]) assert.equal(npmFileExtension(path), extension, path)
})

test('extensions list most files first, then by name, with their sizes summed', () => {
  const paths = ['a.js', 'b.js', 'c.js', 'README.md', 'LICENSE', 'x.d.ts', 'y.d.ts', 'logo.png']
  const sizes = new Map([['a.js', 10], ['b.js', 20], ['c.js', 5], ['README.md', 100], ['x.d.ts', 3], ['y.d.ts', 4], ['logo.png', 900]])
  assert.deepEqual(npmFileExtensions(paths, sizes), [
    { extension: '.js', files: 3, bytes: 35 },
    { extension: '.d.ts', files: 2, bytes: 7 },
    { extension: '', files: 1, bytes: 0 },
    { extension: '.md', files: 1, bytes: 100 },
    { extension: '.png', files: 1, bytes: 900 },
  ])
  assert.deepEqual(npmFileExtensions([], new Map()), [])
})

test('a file is ASCII or UTF-8 text, either with control characters, or binary', () => {
  const kind = text => { const { kind: found, controls } = npmTextEncoding(text); return `${found}${controls ? ' + controls' : ''}` }
  assert.equal(kind('const a = 1\n\tb\r\n'), 'ascii', 'tab, line feed and carriage return are text')
  assert.equal(kind('héllo — ✓ 😀'), 'utf8')
  assert.equal(kind('\u001B[31mred\u001B[0m'), 'ascii + controls')
  assert.equal(kind('a\u000Cb\u000Bc\u007Fd'), 'ascii + controls', 'form feed, vertical tab and DEL are controls')
  assert.equal(kind('é\u0085'), 'utf8 + controls', 'C1 controls')
  assert.equal(kind('if (admin) {\u202E } \u2066// x\u2069'), 'utf8 + controls', 'bidirectional controls')
  assert.equal(kind('\uFEFFbom and\u200Bzero width'), 'utf8', 'a BOM and zero-width characters are not controls')
  assert.equal(kind(null), 'binary')
  assert.deepEqual(npmTextEncoding('a\u001Bb\u001B\u202E'), { kind: 'utf8', controls: new Map([[0x1B, 2], [0x202E, 1]]) })
  assert.deepEqual(npmTextEncoding('plain'), { kind: 'ascii', controls: null })
})

test('a file reads as text, or is not UTF-8, holds controls, is a source map, minified, or has unexpected long lines', () => {
  const category = (path, text) => npmFileReadability(path, text).category
  const long = 'x'.repeat(NPM_LONG_LINE + 1)
  const code = Array.from({ length: 40 }, (_, i) => `export const value${i} = ${i}`).join('\n')
  assert.equal(category('lib/a.js', code), 'ascii')
  assert.equal(category('lib/a.js', `// héllo\n${code}`), 'utf8')
  assert.equal(category('lib/a.png', null), 'binary')
  assert.equal(category('lib/a.js', `${code}\u001B`), 'controls')
  assert.equal(category('lib/a.js', `${code}\n${long}\u202E`), 'controls', 'controls before anything else a text has')
  assert.equal(category('lib/a.js.map', '{"version":3,"mappings":"AAAA"}'), 'map')
  assert.equal(category('dist/a.js', `${long}${long}\n${long}`), 'minified', 'most of it on long lines')
  assert.equal(category('dist/a.min.js', `${code}\n${long}`), 'minified', 'named minified, with any long line')
  assert.equal(category('lib/a.js', `${code}\n${code}\nconst payload = '${long}'\n${code}`), 'long', 'a long line among readable ones')
  assert.equal(category('lib/a.js', `${code}\r\n${'y'.repeat(NPM_LONG_LINE)}\r\n${code}`), 'ascii', 'up to the limit, a carriage return aside')
  assert.equal(category('lib/a.js', `${code}\n//# sourceMappingURL=data:application/json;base64,${long}`), 'ascii', 'an inline source map comment is no long line')
  for (const prose of ['README.md', 'docs/guide.markdown', 'LICENSE', 'CHANGELOG', 'notes.txt', 'LICENSE-MIT']) {
    assert.equal(category(prose, `${long} words\nmore`), 'ascii', `${prose}: prose wraps`)
  }
  const read = npmFileReadability('lib/a.js', `${code}\n${long}\n${long}y\n${code}`)
  assert.deepEqual([read.longLines, read.longest], [2, NPM_LONG_LINE + 2])
})

test('an advisory affects the version shown, is fixed in it, or covers later versions only', () => {
  const versions = ['2.0.0', '1.2.0', '1.1.0', '1.0.0']
  const advisory = affected => ({ affected })
  assert.equal(npmAdvisoryStatus(advisory([2, 3]), versions, '1.1.0'), 'affects')
  assert.equal(npmAdvisoryStatus(advisory([2, 3]), versions, '1.2.0'), 'fixed')
  assert.equal(npmAdvisoryStatus(advisory([0]), versions, '1.2.0'), 'later')
  assert.equal(npmAdvisoryStatus(advisory([3]), versions, '2.0.0-beta.1'), 'fixed', 'a version not listed compares by semver')
  assert.equal(npmAdvisoryStatus(advisory([]), versions, '1.0.0'), 'later')
})

test('downloads group into 7-day weeks ending on the last day, a partial oldest week left out', async () => {
  const { niceCeiling, npmDownloadWeeks } = await import('../ui/view/npm-downloads-chart.js')
  const days = Array.from({ length: 16 }, (_, i) => i + 1)
  const weeks = npmDownloadWeeks({ start: '2026-01-01', end: '2026-01-16', days })
  assert.deepEqual(weeks.map(week => [week.from.toISOString().slice(0, 10), week.to.toISOString().slice(0, 10), week.total]), [
    ['2026-01-03', '2026-01-09', 3 + 4 + 5 + 6 + 7 + 8 + 9],
    ['2026-01-10', '2026-01-16', 10 + 11 + 12 + 13 + 14 + 15 + 16],
  ])
  assert.deepEqual(npmDownloadWeeks({ start: '2026-01-01', end: '2026-01-03', days: [1, 2, 3] }), [])
  assert.deepEqual(npmDownloadWeeks(null), [])
  assert.deepEqual([0, 1, 7, 12, 23, 180, 2600, 999_999].map(niceCeiling), [1, 1, 10, 20, 25, 200, 5000, 1_000_000])
})

test('an advisory npm answers once a range is one row, its ranges, versions and CWEs together', () => {
  const rows = npmMergedAdvisories([
    { id: 'GHSA-a', source: 'registry', severity: 'moderate', cvss: 6.1, cwe: ['CWE-79'], range: '>=4.0.0 <4.5.0', affected: [3, 1] },
    { id: 'GHSA-b', source: 'registry', severity: 'low', cwe: [], affected: [0] },
    { id: 'GHSA-a', source: 'registry', severity: 'moderate', cwe: ['CWE-79', 'CWE-20'], range: '<3.11.0', affected: [5, 1] },
    { id: 'GHSA-a', source: 'repository', severity: 'moderate', cwe: [], range: '< 5.0.0', affected: [2] },
  ])
  assert.deepEqual(rows, [
    { id: 'GHSA-a', source: 'registry', severity: 'moderate', cvss: 6.1, cwe: ['CWE-79', 'CWE-20'], range: '>=4.0.0 <4.5.0 || <3.11.0', affected: [1, 3, 5] },
    { id: 'GHSA-b', source: 'registry', severity: 'low', cwe: [], affected: [0] },
    { id: 'GHSA-a', source: 'repository', severity: 'moderate', cwe: [], range: '< 5.0.0', affected: [2] },
  ])
})
