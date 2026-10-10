import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

const state = {}
mock.module('../client/index.js', { exports: {
  state, isManagedUiMode: () => true, ensureBundleFindingsIndexed() {}, hasBundleFileHashes() {},
  readBundle() {}, readBundleIndex() {}, recordBundleFileHashes() {}, saveBundleIndex() {},
} })
mock.module('../ui/view/render.js', { exports: { render() {} } })
mock.module('../ui/view/dialogs/advisory-details-dialog.js', { exports: { openAdvisoryDetailsDialog() {} } })
mock.module('../ui/view/graph/state.js', { exports: { cleanupGraph2() {}, graph2: {} } })
mock.module('../ui/view/client-managed.js', { exports: {
  fetchNpmAdvisories: () => Promise.resolve({ versions: [], advisories: [] }), fetchNpmStats: () => Promise.resolve({}),
  fetchNpmPackage() {}, fetchNpmSocket: () => Promise.resolve({ socket: null }), fetchNpmTags: () => Promise.resolve({ tags: [] }), fetchNpmVersions: () => Promise.resolve({ versions: [] }), fetchBundleContents() {}, fetchBundleMetadata() {},
} })
const { NPM_LONG_LINE, npmAdvisoryStatus, npmFileExtension, npmFileExtensions, npmFileReadability, npmFileTypes, npmTakenDown, npmTextEncoding } = await import('../ui/view/npm-overview.js')

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
    { extension: '.js', files: 3, bytes: 35, lines: null },
    { extension: '.d.ts', files: 2, bytes: 7, lines: null },
    { extension: '', files: 1, bytes: 0, lines: null },
    { extension: '.md', files: 1, bytes: 100, lines: null },
    { extension: '.png', files: 1, bytes: 900, lines: null },
  ])
  const lines = new Map([['a.js', 3], ['b.js', 4], ['README.md', 0]])
  assert.deepEqual(npmFileExtensions(paths, sizes, lines).map(row => [row.extension, row.lines]),
    [['.js', 7], ['.d.ts', null], ['', null], ['.md', 0], ['.png', null]], 'lines of code where any of its files is text')
  assert.deepEqual(npmFileExtensions([], new Map()), [])
})

test('a package\'s own files at its root are a type of their own, their extensions shown only where other files have them', () => {
  const paths = ['package.json', 'README.md', 'LICENSE', 'licence.md', 'lib/index.js', 'docs/guide.md', 'lib/README.md', 'lib/package.json']
  const sizes = new Map(paths.map((path, i) => [path, i + 1]))
  assert.deepEqual(npmFileTypes(paths, sizes), {
    package: { files: 4, bytes: 1 + 2 + 3 + 4, lines: null },
    // `.md` counts README.md and licence.md too, as docs/guide.md and lib/README.md have it;
    // `.json` stays, for lib/package.json; LICENSE alone had no extension.
    extensions: [{ extension: '.md', files: 4, bytes: 2 + 4 + 6 + 7, lines: null }, { extension: '.json', files: 2, bytes: 1 + 8, lines: null }, { extension: '.js', files: 1, bytes: 5, lines: null }],
  })
  const lines = new Map([['package.json', 20], ['README.md', 5], ['lib/index.js', 9]])
  const typed = npmFileTypes(paths, sizes, lines)
  assert.equal(typed.package.lines, 25, 'its own files\' lines, those that are text')
  assert.deepEqual(typed.extensions.map(row => [row.extension, row.lines]), [['.md', 5], ['.json', 20], ['.js', 9]])
  assert.deepEqual(npmFileTypes(['package.json', 'index.js'], new Map()), { package: { files: 1, bytes: 0, lines: null }, extensions: [{ extension: '.js', files: 1, bytes: 0, lines: null }] })
  assert.deepEqual(npmFileTypes(['LICENSE-MIT', 'LICENSE-APACHE', 'LICENCE.txt', 'license-bsd.md', 'licenses/x.js', 'LICENSE_x'], new Map()).package, { files: 4, bytes: 0, lines: null },
    'a license file named after its license is one too')
  assert.deepEqual(npmFileTypes([], new Map()), { package: null, extensions: [] })
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

test('a file reads as text, or is not UTF-8, holds controls, is a source map, has one in it, is minified, or has unexpected long lines', () => {
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
  const inline = `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${long.repeat(8)}`
  assert.equal(category('lib/a.js', `${code}\n//# sourceMappingURL=a.js.map`), 'ascii', 'a source map beside it')
  assert.equal(category('lib/a.js', `${code}\n${inline}`), 'inline-map', 'its source map in it, which is no long line')
  assert.equal(category('lib/a.css', `a { b: c }\n/*# sourceMappingURL=data:application/json;base64,e30= */`), 'inline-map')
  assert.equal(category('dist/a.js', `${long}${long}\n${code}\n${inline}`), 'inline-map', 'minified, the map not counted against it')
  assert.equal(category('lib/a.js', `${code}\n${code}\nconst payload = '${long}'\n${code}\n${inline}`), 'long', 'unexpected long lines before its map')
  assert.equal(npmFileReadability('lib/a.js', `${code}\n${inline}`).inlineMap, inline.length)
  assert.equal(category('lib/a.js', `${code}\nconst map = \`\n//# sourceMappingURL=data:application/json;base64,\${encode(map)}\``), 'ascii',
    'code that writes one has none')
  assert.equal(category('lib/a.js', `${code}\n//# sourceMappingURL=data:application/json,%7B%22version%22%3A3%7D`), 'inline-map', 'percent-encoded')
  for (const prose of ['README.md', 'docs/guide.markdown', 'LICENSE', 'CHANGELOG', 'notes.txt', 'LICENSE-MIT']) {
    assert.equal(category(prose, `${long} words\nmore`), 'ascii', `${prose}: prose wraps`)
  }
  const read = npmFileReadability('lib/a.js', `${code}\n${long}\n${long}y\n${code}`)
  assert.deepEqual([read.longLines, read.longest], [2, NPM_LONG_LINE + 2])
})

test('code minified into shorter lines is minified too, by its lines\' length and its spacing', () => {
  const category = (path, text) => npmFileReadability(path, text).category
  // tsx's dist/temporary-directory-*.mjs (one 782-character line), shortened.
  const minified = 'var c=Object.defineProperty;var r=(s,t)=>c(s,"name",{value:t,configurable:!0});import m from"node:path";import n from"node:os";'
    + 'const i=r((s,t)=>{const e=s[0]-t[0];if(e===0){const o=s[1]-t[1];return o===0?s[2]>=t[2]:o>0}return e>0},"isVersionGreaterOrEqual");'
    + 'export{i as a,m as b};\n'
  assert.equal(category('dist/temporary-directory.mjs', minified), 'minified')
  assert.equal(npmFileReadability('dist/a.mjs', minified).average, minified.length - 1)
  assert.equal(category('dist/a.mjs', `"use strict";const a=new Set(["${'Custom ESM Loaders is an experimental feature. '.repeat(3)}"]);export{a};\n`), 'minified',
    'spaces in its strings aside')
  // Lines as long, written by a person: spaced after commas and around operators.
  assert.equal(category('v4/checks.js', `export { ${Array.from({ length: 30 }, (_, i) => `_check${i} as check${i}`).join(', ')} } from "../core/index.js";\n`), 'ascii')
  assert.equal(category('types/bufferTime.d.ts', Array.from({ length: 4 }, () =>
    'export declare function bufferTime<T>(bufferTimeSpan: number, bufferCreationInterval: number | null | undefined, scheduler?: SchedulerLike): OperatorFunction<T, T[]>;').join('\n')), 'ascii')
  assert.equal(category('lib/table.js', Array.from({ length: 3 }, (_, i) => `${'value'.repeat(20)}${i}${' '.repeat(20)}=${' '.repeat(20)}${'other'.repeat(20)};`).join('\n')), 'ascii',
    'spaces aligning `=` count by character, not by run')
  assert.equal(category('dist/a.mjs', 'export{a as b}from"./c.js";\n'), 'ascii', 'lines as short as anyone writes')
  assert.equal(category('README.md', `${minified}${minified}`), 'ascii', 'prose is never minified')
})

test('an advisory affects the version shown, is fixed in it, or covers later versions', () => {
  const versions = ['2.0.0', '1.2.0', '1.1.0', '1.0.0']
  const advisory = affected => ({ affected })
  assert.equal(npmAdvisoryStatus(advisory([2, 3]), versions, '1.1.0'), 'affects')
  assert.equal(npmAdvisoryStatus(advisory([2, 3]), versions, '1.2.0'), 'fixed')
  assert.equal(npmAdvisoryStatus(advisory([0]), versions, '1.2.0'), 'later')
  assert.equal(npmAdvisoryStatus(advisory([0, 2]), versions, '1.2.0'), 'later', 'ranges either side of it: a later version is still affected')
  assert.equal(npmAdvisoryStatus(advisory([3]), versions, '2.0.0-beta.1'), 'fixed', 'a version not listed compares by semver')
  assert.equal(npmAdvisoryStatus(advisory([]), versions, '1.0.0'), 'later')
})

test('downloads group into 7-day weeks ending on the last day, a partial oldest week left out', async () => {
  const { niceCeiling, npmDownloadMonths, npmDownloadWeeks } = await import('../ui/view/npm-downloads-chart.js')
  const days = Array.from({ length: 16 }, (_, i) => i + 1)
  const weeks = npmDownloadWeeks({ start: '2026-01-01', end: '2026-01-16', days })
  assert.deepEqual(weeks.map(week => [week.from.toISOString().slice(0, 10), week.to.toISOString().slice(0, 10), week.total]), [
    ['2026-01-03', '2026-01-09', 3 + 4 + 5 + 6 + 7 + 8 + 9],
    ['2026-01-10', '2026-01-16', 10 + 11 + 12 + 13 + 14 + 15 + 16],
  ])
  assert.deepEqual(npmDownloadWeeks({ start: '2026-01-01', end: '2026-01-03', days: [1, 2, 3] }), [])
  assert.deepEqual(npmDownloadWeeks(null), [])
  assert.deepEqual([0, 1, 7, 12, 23, 180, 2600, 999_999].map(niceCeiling), [1, 1, 10, 20, 25, 200, 5000, 1_000_000])
  // From Jan 30 to Apr 2: February and March whole, the partial months at
  // either end left out.
  const months = npmDownloadMonths({ start: '2026-01-30', end: '2026-04-02', days: Array.from({ length: 63 }, () => 1) })
  assert.deepEqual(months.map(month => [month.from.toISOString().slice(0, 10), month.to.toISOString().slice(0, 10), month.total]),
    [['2026-02-01', '2026-02-28', 28], ['2026-03-01', '2026-03-31', 31]])
  assert.deepEqual(npmDownloadMonths({ start: '2026-03-01', end: '2026-03-31', days: Array.from({ length: 31 }, () => 2) }).map(month => month.total), [62], 'a month whole at both ends')
  assert.deepEqual(npmDownloadMonths(null), [])
})

test('each license in an expression opens its own file, else the package\'s only one', async () => {
  const { npmLicenseParts } = await import('../ui/view/npm-package.js')
  const parts = (license, paths) => npmLicenseParts(license, paths).map(({ text, file }) => file ? `${text}→${file}` : text)
  assert.deepEqual(parts('MIT OR Apache-2.0', ['LICENSE-MIT', 'LICENSE-APACHE', 'index.js']), ['MIT→LICENSE-MIT', ' OR ', 'Apache-2.0→LICENSE-APACHE'])
  assert.deepEqual(parts('(MIT AND BSD-3-Clause)', ['LICENSE']), ['(', 'MIT→LICENSE', ' AND ', 'BSD-3-Clause→LICENSE', ')'])
  assert.deepEqual(parts('MIT OR Apache-2.0', ['LICENSE-MIT', 'LICENSE-APACHE', 'LICENSE']), ['MIT→LICENSE-MIT', ' OR ', 'Apache-2.0→LICENSE-APACHE'])
  assert.deepEqual(parts('ISC', ['LICENSE-MIT', 'LICENSE-APACHE']), ['ISC'], 'no file of its own, and no only one')
  assert.deepEqual(parts('MIT', []), ['MIT'])
})

test('npm\'s placeholder for a package its security team took down is told by its version and npm\'s marks', () => {
  const holder = (version, manifest) => npmTakenDown({ npm: { version, manifest } })
  assert.equal(holder('2.0.0', { description: 'security holding package', publisher: 'npm' }), true, 'its description, published by npm')
  assert.equal(holder('2.0.0', { github: { github: 'NPM/security-holder' }, publisher: 'npm' }), true, 'its repository, published by npm')
  assert.equal(holder('0.0.1-security', { description: 'security holding package', github: { github: 'npm/security-holder' }, publisher: 'staff' }), true,
    'published by npm\'s staff, as npm numbers it')
  assert.equal(holder('2.0.0', { description: 'security holding package', github: { github: 'npm/security-holder' }, publisher: 'someone' }), false,
    'npm\'s marks on a version of its own')
  assert.equal(holder('0.0.1-security', { publisher: 'npm' }), false, 'without npm\'s marks')
  assert.equal(holder('1.0.0-security', { description: 'a security scanner', publisher: 'someone' }), false)
})

test('a package\'s tier among npm\'s by downloads goes by the most it had in any of its latest six weeks', async () => {
  const { npmDownloadTier } = await import('../ui/view/npm-downloads-chart.js')
  const tier = days => npmDownloadTier({ start: '2026-01-01', end: '2026-12-31', days })
  const weeks = (count, perDay) => Array.from({ length: count * 7 }, () => perDay)
  assert.equal(tier(weeks(4, 25e6)), 200, '175M a week')
  assert.equal(tier(weeks(4, 10e6)), 1000, '70M a week')
  assert.equal(tier(weeks(4, 200)), Infinity, 'unpopular, below the last tier')
  const gappy = weeks(4, 25e6)
  gappy[27] = 0
  gappy[26] = 0
  gappy[20] = 0
  assert.equal(tier(gappy), 200, 'weeks lower for days npm failed to count are passed over')
  assert.equal(tier([...weeks(1, 25e6), ...weeks(6, 10e6)]), 1000, 'only the latest six weeks')
  assert.equal(tier(Array.from({ length: 6 }, () => 25e6)), null, 'no whole week')
  assert.equal(npmDownloadTier(null), null)
})
