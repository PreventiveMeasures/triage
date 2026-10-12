import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

const state = {}
mock.module('../client/index.js', { exports: {
  state, isManagedUiMode: () => true, ensureBundleFindingsIndexed() {}, hasBundleFileHashes() {},
  readBundle() {}, readBundleIndex() {}, recordBundleFileHashes() {}, saveBundleIndex() {},
} })
mock.module('../ui/view/render.js', { exports: { render() {} } })
mock.module('../ui/view/dialogs/advisory-details-dialog.js', { exports: { openAdvisoryDetailsDialog() {} } })
// What Compare's advisories dialog is opened with, each time.
const comparedAdvisories = []
mock.module('../ui/view/dialogs/npm-compare-advisories-dialog.js', { exports: { openNpmCompareAdvisoriesDialog: props => { comparedAdvisories.push(props) } } })
mock.module('../ui/view/graph/state.js', { exports: { cleanupGraph2() {}, graph2: {} } })
// What the server answers, by package (and version, for Socket); each
// Socket question asked, by `name@version`.
const answers = { advisories: {}, stats: {}, socket: {}, provenance: {}, versions: {}, counts: {} }
// Each request for many packages' recent downloads, by its names; each
// package whose version list was asked for, and those the server answers
// none for, as for a reader who can't open it.
const countsAsked = [], socketAsked = [], versionsAsked = [], versionsFail = new Set()
mock.module('../ui/view/client-managed.js', { exports: {
  fetchNpmAdvisories: name => Promise.resolve(answers.advisories[name] ?? { versions: [], advisories: [] }), fetchNpmStats: name => Promise.resolve(answers.stats[name] ?? {}),
  fetchNpmDownloadCounts: names => { countsAsked.push(names); return Promise.resolve({ downloads: Object.fromEntries(names.filter(name => name in answers.counts).map(name => [name, answers.counts[name]])) }) },
  fetchNpmPackage() {}, fetchNpmProvenance: (name, version) => Promise.resolve({ provenance: answers.provenance[`${name}@${version}`] ?? null }), fetchNpmSocket: (name, version) => { socketAsked.push(`${name}@${version}`); return Promise.resolve({ socket: answers.socket[`${name}@${version}`] ?? null }) }, fetchNpmTags: () => Promise.resolve({ tags: [] }), fetchNpmVersions: name => { versionsAsked.push(name); return versionsFail.has(name) ? Promise.reject(new Error('package-not-found')) : Promise.resolve(answers.versions[name] ?? { versions: [] }) }, fetchBundleContents() {}, fetchBundleMetadata() {},
} })
const { npmAdvisoryStatus, npmCompareBadges, npmCompareFiles, npmDependencyTags, npmSettledDownloads, npmFilesFilter, npmReadabilityWarning, npmFileExtension, npmProvenanceFact, npmProvenanceNamesBuilder, npmFileExtensions, npmFileTypes, npmSocketFileTags, npmTakenDown } = await import('../ui/view/npm-overview.js')
const { NPM_LARGE_CODE, NPM_LONG_LINE, npmBecameUnreadable, npmFileFlagTags, npmFileReadability, npmFileReadabilityOf, npmLargeCode, npmObfuscation, npmObfuscationFound, npmReadabilityFlags, npmReadabilityLabels, npmTextEncoding } = await import('../ui/view/file-readability.js')
const { computeBundleDiff } = await import('../ui/view/bundle-compare-diff.js')
const { bundleFilesAsMap } = await import('../ui/view/bundle-sources.js')
// Template text, its values spelled out, `nothing` as none.
const rendered = value => Array.isArray(value) ? value.map(rendered).join('') : value?.strings ? value.strings.map((part, i) => part + rendered(value.values[i])).join('') : typeof value === 'symbol' ? '' : String(value ?? '')
// Code an obfuscator wrote, with `count` names of its own, from `from` on.
const obfuscated = (count, from = 0x1a2b) => Array.from({ length: count }, (_, i) => `var _0x${(from + i).toString(16)}=_0x${from.toString(16)}[${i}];`).join('')

test('a file\'s readability is read once a version and path, and again for another text', () => {
  const code = 'export const a = 1\n', details = {}
  const read = npmFileReadabilityOf(details, 'index.js', code)
  assert.deepEqual(read, npmFileReadability('index.js', code))
  assert.equal(npmFileReadabilityOf(details, 'index.js', code), read, 'kept')
  assert.equal(npmFileReadabilityOf({}, 'index.js', code) === read, false, 'by version')
  assert.equal(npmFileReadabilityOf(details, 'index.js', null).category, 'binary', 'another text read anew')
})

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
  assert.equal(kind('eval(d(`|\u{E0151}\u{E0156}\u{E0152}`))'), 'utf8 + controls', 'variation selectors that vary nothing hide text')
  assert.equal(kind('const { timeout,\u3164 } = req.query'), 'utf8 + controls', 'a Hangul filler hides a name')
  assert.equal(kind('Made with ❤\uFE0F, \u2229\uFE00 🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}'), 'utf8', 'an emoji\'s, a registered variant\'s and a flag\'s are text')
  assert.equal(kind(null), 'binary')
  assert.deepEqual(npmTextEncoding('a\u001Bb\u001B\u202E'), { kind: 'utf8', controls: new Map([[0x1B, 2], [0x202E, 1]]) })
  assert.deepEqual(npmTextEncoding('a\u001B \u3164'), { kind: 'utf8', controls: new Map([[0x1B, 1], [0x3164, 1]]) })
  assert.deepEqual(npmTextEncoding('plain'), { kind: 'ascii', controls: null })
  const notes = text => Object.fromEntries([...rendered(npmReadabilityFlags(npmFileReadability('lib/a.js', text))).matchAll(/data-tooltip=([^>]*)>(Controls|Invisible)</gu)]
    .map(([, note, tag]) => [tag, note]))
  assert.deepEqual(notes('a\u001B\u202E\u001B'), { Controls: 'Control chars: U+001B \u00D72, U+202E \u00D71' })
  assert.deepEqual(notes('x\u3164'), { Invisible: 'Invisible chars: U+3164 \u00D71' })
  assert.deepEqual(notes('a\u001B \u3164\u3164'), { Controls: 'Control chars: U+001B \u00D71', Invisible: 'Invisible chars: U+3164 \u00D72' },
    'each kind its own tag, though found in one pass')
})

test('a file reads as text, or is not UTF-8, holds controls, is a source map, has one in it, is minified, or has unexpected long lines', () => {
  const category = (path, text) => npmFileReadability(path, text).category
  const long = 'x'.repeat(NPM_LONG_LINE + 1)
  const code = Array.from({ length: 40 }, (_, i) => `export const value${i} = ${i}`).join('\n')
  assert.equal(category('lib/a.js', code), 'ascii')
  assert.equal(category('lib/a.js', `// héllo\n${code}`), 'utf8')
  assert.equal(category('lib/a.png', null), 'binary')
  // Controls are counted beside how a file otherwise reads, not in its place.
  const labels = (path, text) => npmReadabilityLabels(npmFileReadability(path, text))
  assert.equal(category('lib/a.js', `${code}\u001B`), 'ascii')
  assert.deepEqual(labels('lib/a.js', `${code}\u001B`), ['controls'], 'not as readable ASCII')
  assert.deepEqual(labels('lib/a.js', `${code}\u3164`), ['invisible'], 'nor as readable UTF-8')
  assert.deepEqual(labels('lib/a.js', `${code}\u001B\u3164`), ['controls', 'invisible'], 'each kind its own')
  assert.deepEqual(labels('lib/a.js', `${code}\n${code}\n${long}\u202E\n${code}`), ['controls', 'long'])
  assert.deepEqual(labels('dist/a.js', `var r=/[ \f]/;${long}`), ['controls', 'long', 'minified'], 'a minified file holding a form feed is all three')
  assert.deepEqual(labels('lib/a.js', `${code}\n${code}\n${long}\n${code}`), ['long'], 'long lines among readable ones, not as readable ASCII')
  assert.deepEqual(labels('README.md', `${long}\u001B`), ['controls'], 'prose\'s long lines are paragraphs')
  assert.deepEqual(labels('a.js.map', `{"mappings":"${long}"}`), ['map'], 'a source map\'s, all it is')
  assert.deepEqual(labels('lib/a.js', code), ['ascii'])
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
  for (const prose of ['README.md', 'docs/guide.markdown', 'LICENSE', 'CHANGELOG', 'CHANGELOG.md', 'HISTORY', 'notes.txt', 'LICENSE-MIT', 'LICENSE.txt',
    'LICENSE-LGPL2.1', 'LICENSE-GPL-3.0', 'README.org', 'README.rdoc', 'README.asc', 'History.mdown', 'CHANGES.2.0', 'LICENSE.2.0']) {
    assert.equal(category(prose, `${long} words\nmore`), 'ascii', `${prose}: prose wraps`)
  }
  assert.equal(category('dist/notice.min.js', `${code}\n${long}`), 'minified', 'code named as prose is code')
  for (const path of ['lib/history.js', 'src/changes.ts', 'lib/readme-parser.js', 'lib/changes-2.0.js']) {
    assert.equal(category(path, `${code}\n${code}\nconst payload = '${'x'.repeat(2000)}'\n${code}`), 'long', `${path}: code named as prose`)
  }
  const read = npmFileReadability('lib/a.js', `${code}\n${long}\n${long}y\n${code}`)
  assert.deepEqual([read.longLines, read.longest], [2, NPM_LONG_LINE + 2])
})

test('the Overview finds a file under each label it has, counting it once, each chip marked as the most it is on one', () => {
  const code = Array.from({ length: 40 }, (_, i) => `export const value${i} = ${i}`).join('\n')
  const minified = `var r=/[ \t\f]/;${'var a=1;'.repeat(200)}\n`
  const long = `${code}\n${code}\nconst x = '${'x'.repeat(1001)}'\n${code}\n`
  const version = (name, files) => ({ entry: { npm: { name, version: '1.0.0' } },
    details: { integrity: name, kind: 'sourcemap', json: { version: 3, sources: Object.keys(files), sourcesContent: Object.values(files) } } })
  const functions = value => Array.isArray(value) ? value.flatMap(functions) : value?.values ? value.values.flatMap(functions) : typeof value === 'function' ? [value] : []
  const chipsOf = warning => [...rendered(warning).matchAll(/class=npm-extension npm-category ?(is-\w+)?[^]*?<span>([^<]+)<\/span><span class="npm-extension-count">(\d+)</gu)]
    .map(([, mark, name, count]) => `${name} ${count}${mark ? ` ${mark}` : ''}`)
  // Each chip pressed narrows the Files list to the files labelled with it.
  const found = ({ entry, details }) => functions(npmReadabilityWarning(entry, details)).map(click => {
    click()
    const { keeps } = npmFilesFilter(entry)
    return details.json.sources.filter(keeps)
  })

  const mixed = version('labelled', { 'dist/min.js': minified, 'dist/min.js.map': '{"version":3,"mappings":"AAAA"}', 'lib/long.js': long, 'lib/a.js': 'const a = 1\n',
    'lib/hidden.js': 'const { timeout,\u3164 } = req.query\n' })
  const warning = npmReadabilityWarning(mixed.entry, mixed.details)
  assert.match(rendered(warning), /<strong>4 of 5 files<\/strong>/u, 'each file once')
  assert.match(rendered(warning), /npm-readability-warning is-warn/u)
  assert.deepEqual(chipsOf(warning), ['Control chars 1 is-warn', 'Invisible chars 1 is-warn', 'Long lines 2 is-warn', 'Minified 1 is-notice', 'Source maps 1 is-notice'],
    'control and invisible characters each a chip of their own; long lines a warning where some are unexpected')
  assert.deepEqual(found(mixed), [['dist/min.js'], ['lib/hidden.js'], ['dist/min.js', 'lib/long.js'], ['dist/min.js'], ['dist/min.js.map']], 'the minified file under each of its labels')
  // Each file's tags in the list: all its labels, but Map, which a source map's name says.
  const listed = path => [...rendered(npmCompareFiles.tag(mixed.details, path)).matchAll(/class="?npm-(?:flag|encoding)-tag[^>]*>([^<]+)</gu)].map(m => m[1])
  assert.deepEqual(listed('dist/min.js'), ['Controls', 'Long lines', 'Minified'])
  assert.deepEqual(listed('dist/min.js.map'), [], 'no Map in a list')
  assert.deepEqual(listed('lib/long.js'), ['Long lines'], 'nor ASCII, as most files are')
  assert.deepEqual(listed('lib/a.js'), [])
  assert.deepEqual(listed('lib/hidden.js'), ['Invisible', 'UTF-8'])
  const utf8 = version('utf8', { 'lib/b.js': 'const ü = 1\n' })
  assert.deepEqual([...rendered(npmCompareFiles.tag(utf8.details, 'lib/b.js')).matchAll(/class="?npm-encoding-tag[^>]*>([^<]+)</gu)].map(m => m[1]), ['UTF-8'], 'UTF-8 tagged')

  const bundled = version('bundled', { 'dist/min.js': `${'var a=1;'.repeat(200)}\n`, 'lib/a.js': 'const a = 1\n' })
  const quiet = npmReadabilityWarning(bundled.entry, bundled.details)
  assert.deepEqual(chipsOf(quiet), ['Long lines 1 is-notice', 'Minified 1 is-notice'], 'minified code\'s long lines a notice, as it is')
  assert.doesNotMatch(rendered(quiet), /npm-readability-warning is-warn/u)
})

test('code minified into shorter lines is minified too, by its lines\' length and its spacing', () => {
  const category = (path, text) => npmFileReadability(path, text).category
  // tsx's dist/temporary-directory-*.mjs (one 782-character line), shortened.
  const minified = 'var c=Object.defineProperty;var r=(s,t)=>c(s,"name",{value:t,configurable:!0});import m from"node:path";import n from"node:os";'
    + 'const i=r((s,t)=>{const e=s[0]-t[0];if(e===0){const o=s[1]-t[1];return o===0?s[2]>=t[2]:o>0}return e>0},"isVersionGreaterOrEqual");'
    + 'export{i as a,m as b};\n'
  assert.equal(category('dist/temporary-directory.mjs', minified), 'minified')
  assert.equal(npmFileReadability('dist/a.mjs', minified).average, minified.trimEnd().replaceAll(/"[^"]*"/gu, '""').length, 'its code\'s average, strings aside')
  assert.equal(category('dist/a.mjs', `${minified.trimEnd()}const a=new Set(["${'Custom ESM Loaders is an experimental feature. '.repeat(3)}"]);\n`), 'minified',
    'spaces in its strings aside')
  assert.equal(category('dist/a.mjs', `${minified.trimEnd()}var p=/* @__PURE__ */ m(1),q=/* @__PURE__ */ n(2);\n`), 'minified',
    'spaces in its comments aside')
  assert.equal(category('dist/a.mjs', `const q=/["']/g;${'var c=Object.defineProperty;var r=(s,t)=>c(s,t);'.repeat(4)}const l="x";\n`), 'minified',
    'a quote in a regular expression starts no string')
  assert.equal(category('dist/a.mjs', `${'var a=b+ +c,d=e- -f;'.repeat(6)}\n`), 'minified', 'nor are spaces between two operators droppable')
  assert.equal(category('dist/a.mjs', `${'var a=b/ /x/.test(s),c=d;'.repeat(5)}\n`), 'minified', 'two slashes either')
  assert.equal(category('dist/a.mjs', `${'var a=/x/ instanceof RegExp,b=c;'.repeat(5)}\n`), 'minified', 'nor a regular expression\'s before a word')
  assert.equal(category('dist/a.mjs', `${'var π=()=>π;'.repeat(12)}\n`), 'minified', 'a word of any script')
  assert.equal(category('dist/a.mjs', `${'var \\u03c0=()=>\\u03c0;'.repeat(6)}\n`), 'minified', 'or escaped')
  assert.equal(category('dist/a.mjs', `${'var ℘=1;b=℘;'.repeat(12)}\n`), 'minified', 'as JavaScript tells one')
  assert.equal(category('dist/a.mjs', `${'b=cafe\u0301 in o;'.repeat(9)}\n`), 'minified', 'marks and all')
  assert.equal(category('dist/a.mjs', `async function f(v){return await /["']/.test(v)}${'var c=Object.defineProperty;var r=(s,t)=>c(s,t);'.repeat(4)}const l="x";\n`),
    'minified', 'a regular expression after `await` too')
  assert.equal(category('dist/a.mjs', `var x=a+/["']/.test(s);${'var c=Object.defineProperty;var r=(s,t)=>c(s,t);'.repeat(4)}const l="x";\n`), 'minified',
    'or after an operator')
  assert.equal(category('dist/a.mjs', `/*! license */\n${'var c=Object.defineProperty;var r=(s,t)=>c(s,t);'.repeat(3)}\n`), 'minified', 'a banner aside')
  assert.equal(npmFileReadability('dist/a.mjs', `/*! license */\n${'var c=Object.defineProperty;var r=(s,t)=>c(s,t);'.repeat(3)}\n`).average, 144, 'from its average too')
  assert.equal(npmFileReadability('src/a.js', 'export const a = 1\n').average, 0, 'none where not minified so')
  assert.equal(category('dist/cli.js', `#!/usr/bin/env node\n${'var c=Object.defineProperty;var r=(s,t)=>c(s,t);'.repeat(3)}\n`), 'minified', 'a hashbang too')
  // Lines as long, written by a person: spaced after commas and around operators.
  assert.equal(category('v4/checks.js', `export { ${Array.from({ length: 30 }, (_, i) => `_check${i} as check${i}`).join(', ')} } from "../core/index.js";\n`), 'ascii')
  assert.equal(category('types/bufferTime.d.ts', Array.from({ length: 4 }, () =>
    'export declare function bufferTime<T>(bufferTimeSpan: number, bufferCreationInterval: number | null | undefined, scheduler?: SchedulerLike): OperatorFunction<T, T[]>;').join('\n')), 'ascii')
  assert.equal(category('lib/table.js', Array.from({ length: 3 }, (_, i) => `${'value'.repeat(20)}${i}${' '.repeat(20)}=${' '.repeat(20)}${'other'.repeat(20)};`).join('\n')), 'ascii',
    'spaces aligning `=` count by character, not by run')
  assert.equal(category('dist/a.mjs', 'export{a as b}from"./c.js";\n'), 'ascii', 'lines as short as anyone writes')
  // svelte's src/internal/index.js, shortened: long, but in its comment and string.
  assert.equal(category('src/internal/index.js', `// ${'We may reimplement some of the legacy private APIs here. '.repeat(3)}\n\n`
    + `throw new Error(\n\t\`${'Your application imported from svelte/internal, a private module that no longer exists. '.repeat(3)}\`\n);\n`), 'ascii',
    'lines long by their comments and strings, not their code')
  assert.equal(category('lib/stub.js', `// ${'We may reimplement some of the legacy private APIs here. '.repeat(3)}\n`), 'ascii', 'nor one of comments alone')
  assert.equal(category('lib/stub.js', `${Array.from({ length: 102 }, () => `// ${'ordinary words '.repeat(8)}`).join('\n')}\nexport{};\n`), 'ascii',
    'nor one of comments around a line of code')
  const code60 = 'x=Object.defineProperty(a,b,{value:c,configurable:!0});y=z;'
  assert.equal(category('lib/split.js', `${code60}/* ${'ordinary words '.repeat(6)}\n${'more words '.repeat(6)} */${code60}\n`), 'ascii',
    'a comment spanning lines leaves its code on them')
  assert.equal(category('dist/a.mjs', `if(a)b();else/["']/.test(x);${'var c=Object.defineProperty;var r=(s,t)=>c(s,t);'.repeat(4)}const l="x";\n`), 'minified',
    'a regular expression after `else` too')
  assert.equal(category('dist/a.mjs', `const f=x=>/["']/.test(x);${'var c=Object.defineProperty;var r=(s,t)=>c(s,t);'.repeat(4)}const l="x";\n`), 'minified',
    'a regular expression after `=>` too')
  for (const keyword of ['new', 'v instanceof', 'class extends']) {
    assert.equal(category('dist/a.mjs', `var y=${keyword} /'/.constructor;${'var c=Object.defineProperty;var r=(s,t)=>c(s,t);'.repeat(4)}const l='x';\n`), 'minified',
      `a regular expression after \`${keyword}\` too`)
  }
  assert.equal(category('dist/a.mjs', `export default/["']/.test(x);${'var c=Object.defineProperty;var r=(s,t)=>c(s,t);'.repeat(4)}const l="x";\n`), 'minified',
    'a regular expression after `default` too')
  assert.equal(category('dist/a.mjs', `var u=n.default/2+"/"+v;${'var c=Object.defineProperty;var r=(s,t)=>c(s,t);'.repeat(4)}const l="x";\n`), 'minified',
    'but a property named so is divided')
  assert.equal(category('dist/a.mjs', `class A{#default=1;f(v){return this.#default/2+"/"+v}}${'var c=Object.defineProperty;var r=(s,t)=>c(s,t);'.repeat(4)}const l="x";\n`),
    'minified', 'a private one too')
  assert.equal(category('dist/a.mjs', `var y=[.../'/.exec(s)];${'var c=Object.defineProperty;var r=(s,t)=>c(s,t);'.repeat(4)}const l='x';\n`), 'minified',
    'a regular expression after `...` too')
  assert.equal(category('dist/g.css', `${'.a{width:calc(1px + var(--x))}'.repeat(5)}\n`), 'minified', 'a sum\'s spaces in calc() needed, nested too')
  assert.equal(category('dist/g.css', `${'.a{--gap:1px + 2px;width:calc(var(--gap))}'.repeat(3)}\n`), 'minified', 'and in a custom property\'s value')
  assert.equal(category('src/e.css', `${'.a{--gap:0}.a + .b{color:red}'.repeat(5)}\n`), 'ascii', 'not past it')
  assert.equal(category('README.md', `${minified}${minified}`), 'ascii', 'prose is never minified')
  // Only in what minifiers write, JavaScript and CSS, whose strings and comments are read.
  assert.equal(category('tool.py', `x = 1\n# ${'ordinary words '.repeat(15)}\n# ${'ordinary words '.repeat(15)}\n`), 'ascii', 'nor a language it can\'t read')
  assert.equal(category('index.html', `<!-- ${'ordinary words '.repeat(15)}-->\n`), 'ascii')
  assert.equal(category('dist/a.css', '.a{color:red;margin:0 auto;padding:0}.b{display:flex;align-items:center;justify-content:space-between}.c{font:12px/1.5 sans-serif}\n'), 'minified')
  assert.equal(category('dist/b.css', '.a{background:url(https://cdn.example.com/a.svg) no-repeat}.b{display:flex;align-items:center;justify-content:space-between}.c{margin:0}\n'), 'minified',
    'a URL in CSS is no `//` comment')
  assert.equal(category('dist/c.css', `${'.a .b{color:red}'.repeat(8)}\n`), 'minified', 'a descendant selector\'s space is no minifier\'s to drop')
  assert.equal(category('src/e.css', `${'.a + .b{color:red}'.repeat(8)}\n`), 'ascii', 'a sibling selector\'s is')
  assert.equal(category('dist/f.css', `${'.a{width:calc(1px + 2px)}'.repeat(6)}\n`), 'minified', 'but not a sum\'s in calc()')
  assert.equal(category('src/d.css', `${Array.from({ length: 6 }, (_, i) => `.list .item-${i}`).join(', ')} { color: red; margin: 0 auto; }\n`), 'ascii')
  assert.equal(category('src/About.jsx', `export const About = () => <p>${'We build tools that make reviewing code a little easier for everyone '.repeat(8)}</p>\n`), 'ascii',
    'nor what minifiers never write, as JSX')
})

test('an obfuscator\'s fingerprint is 20 of its _0x names or more, or the loop it turns its strings with', () => {
  assert.deepEqual(npmObfuscation(obfuscated(20)), { names: 20, loop: false })
  assert.deepEqual(npmObfuscation(`${obfuscated(5000)}while(!![]){}`), { names: 1000, loop: true }, 'counted to 1,000, the loop found past them')
  assert.equal(npmObfuscationFound({ names: 1000, loop: false }), '1,000 or more names such as _0x1a2b')
  assert.equal(npmObfuscationFound({ names: 999, loop: true }), '999 names such as _0x1a2b, and while(!![])')
  assert.equal(npmObfuscation(obfuscated(19)), null, 'fewer')
  assert.equal(npmObfuscation(`${obfuscated(10)}${obfuscated(10)}`), null, 'a name used again counts once')
  assert.deepEqual(npmObfuscation('(function(){while(!![]){try{break}catch(e){}}})()'), { names: 0, loop: true })
  assert.deepEqual(npmObfuscation('while (!![]) {\n  break\n}'), { names: 0, loop: true }, 'pretty-printed')
  const lookalikes = Array.from({ length: 30 }, (_, i) => {
    const hex = (0x1000 + i).toString(16)
    return `a_0x${hex} _0x${hex}0000 _0X${hex} _0x${hex.slice(0, 3)} $x._0x${hex}z`
  }).join('\n')
  assert.equal(npmObfuscation(lookalikes), null, 'not inside another name, past six digits, with a capital X, under four digits')
  assert.equal(npmObfuscation('while(!![].length){}'), null)
  assert.deepEqual(npmFileReadability('dist/a.js', obfuscated(25)).obfuscation, { names: 25, loop: false }, 'as a file reads')
  assert.equal(npmFileReadability('lib/a.js', 'const a = 1\n').obfuscation, null)
  assert.equal(npmFileReadability('lib/a.png', null).obfuscation, null)
  for (const path of ['dist/a.js.map', 'README.md', 'docs/deobfuscate.md', 'CHANGELOG']) {
    assert.equal(npmFileReadability(path, `${obfuscated(25)}while(!![]){}`).obfuscation, null, `${path}: no code that runs`)
  }
})

test('a large code file is JavaScript or TypeScript of 256 KiB or more, not a declaration file', () => {
  assert.equal(NPM_LARGE_CODE, 256 * 1024)
  for (const path of ['dist/a.js', 'a.mjs', 'a.cjs', 'a.jsx', 'a.ts', 'a.mts', 'a.cts', 'a.tsx', 'LIB/A.JS']) assert.equal(npmLargeCode(path, NPM_LARGE_CODE), true, path)
  assert.equal(npmLargeCode('dist/a.js', NPM_LARGE_CODE - 1), false, 'smaller')
  for (const path of ['a.d.ts', 'a.d.mts', 'a.json', 'a.js.map', 'a.css', 'a.wasm', 'README.md', 'bin/cli']) assert.equal(npmLargeCode(path, 10 * NPM_LARGE_CODE), false, path)
  assert.equal(npmLargeCode('dist/a.js', undefined), false, 'no size')
})

test('a file becomes unreadable with no line over 200 characters before and one over 2,000 now, prose, maps and inline maps aside', () => {
  const became = (path, before, after) => npmBecameUnreadable(path, npmFileReadability(path, before), npmFileReadability(path, after))
  const short = `const a = '${'x'.repeat(188)}'\n`
  const long = `const a = '${'y'.repeat(2001)}'\n`
  assert.equal(short.length - 1, 200)
  assert.equal(became('lib/a.js', short, long), true)
  assert.equal(became('lib/a.js', `${short}x${short}`, long), false, 'one line over 200 before')
  assert.equal(became('lib/a.js', short, `const a = '${'y'.repeat(1988)}'\n`), false, 'none over 2,000 now')
  assert.equal(became('package.json', '{\n  "a": 1\n}\n', `{"a":"${'z'.repeat(2001)}"}`), true, 'any text')
  for (const path of ['README.md', 'CHANGELOG', 'lib/a.js.map']) assert.equal(became(path, short, long), false, path)
  assert.equal(became('lib/a.js', short, `${short}//# sourceMappingURL=data:application/json;base64,${'A'.repeat(4000)}\n`), false, 'its inline map\'s line counts for none')
  assert.equal(became('lib/a.js', null, long), false, 'not text before')
  assert.equal(npmBecameUnreadable('lib/a.js', null, npmFileReadability('lib/a.js', long)), false, 'no side before')
})

test('a file is tagged Large, a code file of 256 KiB or more, as a notice, and Obfuscated, as a warning', () => {
  const tags = rendered(npmFileFlagTags('dist/a.js', npmFileReadability('dist/a.js', `${obfuscated(25)}while(!![]){}`), NPM_LARGE_CODE))
  assert.equal(tags, '<span class="npm-flag-tag is-notice" data-tooltip=A code file of 256.0 KiB, 256 KiB or more>Large</span>'
    + '<span class="npm-flag-tag is-warn" data-tooltip=An obfuscator\'s fingerprint: 25 names such as _0x1a2b, and while(!![])>Obfuscated</span>')
  assert.match(rendered(npmFileFlagTags('dist/b.js', npmFileReadability('dist/b.js', 'while(!![]){}'), 10)), /^<span class="npm-flag-tag is-warn" data-tooltip=An obfuscator's fingerprint: while\(!!\[\]\)>Obfuscated<\/span>$/u)
  assert.equal(typeof npmFileFlagTags('lib/a.js', npmFileReadability('lib/a.js', 'const a = 1\n'), 20), 'symbol', 'nothing for neither')
  assert.equal(typeof npmFileFlagTags('lib/a.d.ts', null, NPM_LARGE_CODE), 'symbol')
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
  const { npmLicenseParts } = await import('../ui/view/npm-entries.js')
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

test('a file Socket raises an alert on is named in its severity\'s color, its note in the tooltip', () => {
  const text = value => Array.isArray(value) ? value.map(text).join('') : value?.strings ? value.strings.map((part, i) => part + text(value.values[i])).join('') : String(value ?? '')
  const [malware, scripts] = npmSocketFileTags([{ type: 'malware', severity: 'critical', note: 'Steals tokens.' }, { type: 'installScripts', severity: 'middle', note: null }]).map(text)
  assert.match(malware, /npm-socket-file-alert sev-critical/u)
  assert.match(malware, /data-tooltip=Socket: Malware, critical · Steals tokens\.>Malware</u)
  assert.match(scripts, /sev-moderate[^]*>Install scripts</u, 'Socket\'s middle severity reads as moderate')
  assert.deepEqual(npmSocketFileTags(), [])
})

test('Compare\'s badges flag the advisories affecting either version, Socket\'s scores under their bars, and a package few download', async () => {
  const text = value => Array.isArray(value) ? value.map(text).join('') : value?.strings ? value.strings.map((part, i) => part + text(value.values[i])).join('') : typeof value === 'symbol' ? '' : String(value ?? '')
  const scores = changed => ({ overall: 1, supplyChain: 1, vulnerability: 1, quality: 1, maintenance: 1, license: 1, ...changed })
  answers.advisories.flagged = { versions: ['2.0.0', '1.0.0'], advisories: [{ id: 'a', severity: 'high', affected: [1] }, { id: 'b', severity: 'moderate', affected: [0, 1] }] }
  // 500 a day: 3,500 a week, among the top 100,000.
  answers.stats.flagged = { downloads: { start: '2026-08-01', end: '2026-09-30', days: Array.from({ length: 61 }, () => 500) } }
  answers.socket['flagged@1.0.0'] = { scores: scores({ quality: .3 }), alerts: [] }
  answers.socket['flagged@2.0.0'] = { scores: scores({ supplyChain: .85, quality: .9, license: .7 }), alerts: [] }
  const side = (name, version, extra = {}) => ({ npm: { name, version, ...extra } })
  const badges = async (...sides) => { npmCompareBadges(...sides); await new Promise(resolve => { setImmediate(resolve) }); return text(npmCompareBadges(...sides)) }

  const flagged = await badges(side('flagged', '1.0.0'), side('flagged', '2.0.0'))
  assert.match(flagged, /<button type="button" class=npm-extension npm-compare-advisories sev-moderate[^]*>2 → 1</u)
  assert.match(flagged, /data-tooltip=Advisories affecting 1\.0\.0: 2, 2\.0\.0: 1\s/u, 'in text, where it can\'t be styled')
  assert.match(flagged, new RegExp(['compare-tip-version">1\\.0\\.0<', 'compare-tip-count">2<', 'sev-high>1 high<', 'sev-moderate>1 moderate<',
    'compare-tip-version">2\\.0\\.0<', 'compare-tip-count">1<', 'sev-moderate>1 moderate<', 'compare-tip-note">0 new · 1 fixed<'].join('[^]*'), 'u'),
  'styled, a row for each version, its severities in their colors')
  assert.match(flagged, /npm-socket-score is-fair[^]*>License<[^]*>100 → 70</u, 'the open one under its bar, from the one compared with')
  assert.doesNotMatch(flagged, />(?:Supply chain|Vulnerability|Quality|Maintenance)</u, 'the open one at or over their bars, its quality 90 though 1.0.0\'s was 30')
  assert.match(flagged, /npm-downloads-tier is-low data-tooltip=15,000 downloads\/month, September 2026[^>]*<div><strong>15,000<\/strong> downloads\/month<\/div><div class="compare-tip-note">September 2026<\/div>>top 100,000</u,
    'last month\'s downloads over the month\'s name')

  answers.stats.edge = { downloads: { start: '2026-08-01', end: '2026-09-30', days: Array.from({ length: 61 }, () => 1e6) } }
  answers.socket['edge@1.0.0'] = { scores: scores({ quality: .7, maintenance: .7 }), alerts: [] }
  answers.socket['edge@1.1.0'] = { scores: scores({ quality: .69 }), alerts: [] }
  const edge = await badges(side('edge', '1.0.0'), side('edge', '1.1.0'))
  assert.match(edge, />Quality<[^]*>70 → 69</u, 'quality under 70')
  assert.doesNotMatch(edge, />Maintenance</u, 'maintenance at 70')

  // Socket's vulnerability score shows only where it tells of worse than the
  // advisories found: none at all, or only less severe ones.
  const vulnerable = (name, vulnerability, advisories) => {
    answers.advisories[name] = advisories ?? { versions: ['1.1.0', '1.0.0'], advisories: [] }
    answers.socket[`${name}@1.1.0`] = { scores: scores({ vulnerability }), alerts: [] }
    return badges(side(name, '1.0.0'), side(name, '1.1.0'))
  }
  const affecting = severity => ({ versions: ['1.1.0', '1.0.0'], advisories: [{ id: 'x', severity, affected: [0] }] })
  assert.match(await vulnerable('unadvised', .84), />Vulnerability<[^]*>– → 84</u, 'where none are found')
  assert.doesNotMatch(await vulnerable('advised', .84, affecting('high')), />Vulnerability</u, 'a high one found, as 84 tells')
  assert.match(await vulnerable('understated', .84, affecting('moderate')), />Vulnerability</u, 'only a moderate one found')
  assert.match(await vulnerable('critical', .25, affecting('high')), />Vulnerability<[^]*>– → 25</u, 'its floor, past a high one found')
  assert.doesNotMatch(await vulnerable('found', .25, affecting('critical')), />Vulnerability</u, 'a critical one found')
  answers.advisories.pending = new Promise(() => {})
  answers.socket['pending@1.1.0'] = { scores: scores({ vulnerability: .25 }), alerts: [] }
  assert.doesNotMatch(await badges(side('pending', '1.0.0'), side('pending', '1.1.0')), />Vulnerability</u, 'not until the advisories arrive')

  // Supply chain under 85, green from 85.
  answers.socket['chained@1.0.0'] = { scores: scores({ supplyChain: .84 }), alerts: [] }
  answers.socket['chained@1.1.0'] = { scores: scores({ supplyChain: .85 }), alerts: [] }
  assert.doesNotMatch(await badges(side('chained', '1.0.0'), side('chained', '1.1.0')), />Supply chain</u, 'the open one at its bar, though the one compared with was under it')
  answers.socket['chained@1.2.0'] = { scores: scores({ supplyChain: .84 }), alerts: [] }
  assert.match(await badges(side('chained', '1.1.0'), side('chained', '1.2.0')), /npm-socket-score is-fair[^]*>Supply chain<[^]*>85 → 84</u)

  // A click lists them: what the open one brings, still has, and fixes.
  const clicked = npmCompareBadges(side('flagged', '1.0.0'), side('flagged', '2.0.0')).values[0][0].values
  clicked.find(value => typeof value === 'function')()
  const [dialog] = comparedAdvisories
  assert.equal(dialog.heading, 'Advisories · flagged 1.0.0 → 2.0.0')
  assert.deepEqual(dialog.groups.map(({ status, heading, rows }) => [status, heading, rows.length]), [['kept', 'Still affecting 2.0.0', 1], ['fixed', 'Fixed in 2.0.0', 1]])
  assert.equal(dialog.isCurrent(), true)
  assert.match(text(npmCompareBadges(side('flagged', '1.0.0'), side('flagged', '2.0.0'))),
    /compare-tip-head">Socket's license score<[^]*compare-tip-version">1\.0\.0<[^]*compare-tip-score is-good is-max>[^]*100<[^]*compare-tip-version">2\.0\.0<[^]*compare-tip-score is-fair>[^]*70<[^]*compare-tip-note">Shown under 80</u,
    'Socket\'s, a ring and a tint for each version\'s')

  // Socket has no report on the open one yet, as on one just published:
  // nothing to show; on the one compared with, none in its row.
  answers.socket['unscanned@1.0.0'] = { scores: scores({ quality: .3 }), alerts: [] }
  assert.doesNotMatch(await badges(side('unscanned', '1.0.0'), side('unscanned', '1.1.0')), />Quality</u)
  answers.socket['unscanned@1.2.0'] = { scores: scores({ quality: .3 }), alerts: [] }
  const fresh = await badges(side('unscanned', '1.1.0'), side('unscanned', '1.2.0'))
  assert.match(fresh, /href=https:\/\/socket\.dev\/npm\/package\/unscanned\/overview\/1\.2\.0 [^]*>Quality<[^]*>– → 30</u)
  assert.match(fresh, /compare-tip-version">1\.1\.0<\/span><span class="compare-tip-said"><span class="compare-tip-none">none</u, 'none where it has none')

  // A publisher that changed, as when a package changes hands: each account
  // green where it is known to publish, else orange; the chip light yellow to
  // a known one, orange between unknown ones, red from a known one to one not.
  const published = (publisher, known = false) => ({ manifest: { publisher, ...known ? { knownAccounts: [publisher] } : {} } })
  const account = (name, known) => `<span class=npm-compare-account ${known ? 'is-known' : 'is-unknown'}>~${name}</span>`
  const handed = await badges(side('handed', '1.0.0', published('alice')), side('handed', '1.1.0', published('mallory')))
  assert.ok(handed.includes(`<span>Publisher</span><span class="npm-extension-count">${account('alice', false)} → ${account('mallory', false)}</span></a></li>`), 'first, both unknown')
  assert.match(handed, /<li><a class=npm-extension npm-compare-publisher is-to-unknown href=https:\/\/www\.npmjs\.com\/~mallory /u, 'orange, linking to the new publisher')
  assert.match(handed, /compare-tip-head">Published by<[^]*>1\.0\.0<[^]*npm-compare-account is-unknown>~alice<[^]*>1\.1\.0<[^]*npm-compare-account is-unknown>~mallory<[^]*neither publishes/u, 'its tooltip alike')
  const taken = await badges(side('taken', '1.0.0', published('alice', true)), side('taken', '1.1.0', published('mallory')))
  assert.match(taken, /npm-compare-publisher is-from-known /u, 'red from a known account to one not')
  assert.ok(taken.includes(`${account('alice', true)} → ${account('mallory', false)}`))
  assert.match(taken, /compare-tip-said"><span class=npm-compare-account is-known>~alice<[^]*after one that does/u)
  const joined = await badges(side('joined', '1.0.0', published('alice')), side('joined', '1.1.0', published('bob', true)))
  assert.match(joined, /npm-compare-publisher is-to-known /u, 'light yellow to a known one')
  assert.ok(joined.includes(`${account('alice', false)} → ${account('bob', true)}`))
  assert.doesNotMatch(await badges(side('same-hands', '1.0.0', published('alice')), side('same-hands', '1.1.0', published('alice'))), /npm-compare-publisher/u)
  assert.doesNotMatch(await badges(side('unsaid', '1.0.0'), side('unsaid', '1.1.0', published('alice'))), /npm-compare-publisher/u, 'not where npm doesn\'t say')

  // Provenance the open version lost.
  const attested = provenance => ({ manifest: { provenance } })
  const lost = await badges(side('lost', '1.0.0', attested(true)), side('lost', '1.1.0', attested(undefined)))
  assert.match(lost, /<li><span class="npm-extension npm-compare-provenance"[^]*compare-tip-head">npm provenance<[^]*>Listed by npm<[^]*compare-tip-none">None<[^]*>Provenance lost<\/span><\/li>/u)
  assert.doesNotMatch(await badges(side('gained', '1.0.0', attested(undefined)), side('gained', '1.1.0', attested(true))), /npm-compare-provenance/u, 'not one it gained')
  assert.doesNotMatch(await badges(side('kept-attested', '1.0.0', attested(true)), side('kept-attested', '1.1.0', attested(true))), /npm-compare-provenance/u)

  // The open version deprecated, its message in the tooltip, npm's
  // placeholder to its first sentence.
  const deprecated = message => ({ manifest: { deprecated: message } })
  const gone = await badges(side('gone', '1.0.0'), side('gone', '1.1.0', deprecated('Package no longer supported. Contact Support at https://www.npmjs.com/support for more info.')))
  assert.match(gone, /^<ul [^>]*><li><span class="npm-extension npm-compare-deprecated" data-tooltip=Package no longer supported\.>Deprecated<\/span><\/li>/u, 'first')
  assert.match(await badges(side('moved', '1.0.0'), side('moved', '1.1.0', deprecated('Use @scope/moved instead'))), /data-tooltip=Use @scope\/moved instead>Deprecated</u)
  assert.doesNotMatch(await badges(side('undeprecated', '1.0.0', deprecated('Broken build')), side('undeprecated', '1.1.0')), /npm-compare-deprecated/u,
    'not for the one compared with alone')
  // Socket scores a deprecated version's maintenance 50 for that alone: its
  // chip shows only lower, where it says more.
  answers.socket['stale@1.1.0'] = { scores: scores({ maintenance: .5 }), alerts: [] }
  const stale = await badges(side('stale', '1.0.0'), side('stale', '1.1.0', deprecated('Use fresh instead')))
  assert.match(stale, /npm-compare-deprecated/u)
  assert.doesNotMatch(stale, />Maintenance</u, 'no more than Deprecated says')
  assert.match(await badges(side('stale', '1.0.0'), side('stale', '1.1.0')), />Maintenance<[^]*>– → 50</u, 'shown where it is not deprecated')
  answers.socket['abandoned@1.1.0'] = { scores: scores({ maintenance: .3 }), alerts: [] }
  assert.match(await badges(side('abandoned', '1.0.0'), side('abandoned', '1.1.0', deprecated('Unmaintained'))), />Maintenance<[^]*>– → 30</u, 'lower, as it says more')

  // Install scripts the open version adds or changes, node-gyp's for a
  // binding.gyp among them; not one it drops.
  const scripted = (name, version, installScripts, sources = []) => ({ npm: { name, version, manifest: { installScripts } }, json: { sources } })
  const added = await badges(scripted('scripted', '1.0.0', undefined), scripted('scripted', '1.1.0', { postinstall: 'node steal.js' }))
  assert.match(added, /<li><span class="npm-extension is-warn npm-compare-install"\s+data-tooltip=1\.0\.0: none · 1\.1\.0: postinstall: node steal\.js[^]*compare-tip-head">Install scripts<[^]*compare-tip-none">None<[^]*class=is-flagged>postinstall: <code>node steal\.js<\/code>[^]*<span>Install script<\/span><span class="npm-extension-count">postinstall added<\/span>/u)
  const changed = await badges(scripted('rescripted', '1.0.0', { install: 'node-gyp rebuild', postinstall: 'node a.js' }), scripted('rescripted', '1.1.0', { install: 'node-gyp rebuild', postinstall: 'node b.js' }))
  assert.match(changed, />Install script<\/span><span class="npm-extension-count">postinstall changed</u, 'one changed, not one kept')
  assert.match(changed, /<span class=>install: <code>node-gyp rebuild<\/code>/u, 'each version\'s, the kept one plain')
  assert.match(await badges(scripted('gyp', '1.0.0', undefined), scripted('gyp', '1.1.0', undefined, ['binding.gyp', 'index.js'])), /npm-extension-count">install added</u, 'node-gyp\'s, for a binding.gyp it adds')
  assert.match(await badges(scripted('both', '1.0.0', { install: 'a' }), scripted('both', '1.1.0', { preinstall: 'x', install: 'b' })), />Install scripts<\/span><span class="npm-extension-count">preinstall added, install changed</u)
  assert.doesNotMatch(await badges(scripted('dropped', '1.0.0', { postinstall: 'node a.js' }), scripted('dropped', '1.1.0', undefined)), /npm-compare-install/u, 'not one it drops')
  assert.doesNotMatch(await badges(scripted('kept', '1.0.0', { postinstall: 'node a.js' }), scripted('kept', '1.1.0', { postinstall: 'node a.js' })), /npm-compare-install/u)

  // Dependencies the open version takes from elsewhere than the registry
  // anew, each version's spec in the tooltip; new ones nothing of it
  // imports, as axios 1.14.1's plain-crypto-js, which ran its own
  // postinstall; after install scripts.
  const depending = (name, version, dependencies, files = {}) => ({ npm: { name, version, manifest: { dependencies } },
    json: { sources: Object.keys(files), sourcesContent: Object.values(files) } })
  const fetched = await badges(depending('fetched', '1.2.0', { websocket: '^1.0.29' }),
    depending('fetched', '1.2.1', { websocket: 'github:web3-js/WebSocket-Node#polyfill/globalThis' }, { 'src/index.js': 'require("websocket")' }))
  assert.match(fetched, /<li><span class="npm-extension is-warn npm-compare-registry"\s+data-tooltip=1\.2\.0: websocket \^1\.0\.29 · 1\.2\.1: websocket github:web3-js\/WebSocket-Node#polyfill\/globalThis[^]*compare-tip-head">From elsewhere than npm's registry<[^]*compare-tip-version">1\.2\.0<[^]*<span class=>websocket: <code>\^1\.0\.29<\/code>[^]*compare-tip-version">1\.2\.1<[^]*class=is-flagged>websocket: <code>github:web3-js\/WebSocket-Node#polyfill\/globalThis<\/code><[^]*>\s*Non-registry deps<\/span><\/li><\/ul>$/u)
  assert.doesNotMatch(fetched, /npm-compare-unimported/u, 'imported')
  const compromised = await badges(depending('compromised', '1.14.0', { 'follow-redirects': '^1.15.6' }, { 'lib/axios.js': 'require("follow-redirects")' }),
    depending('compromised', '1.14.1', { 'follow-redirects': '^1.15.6', 'plain-crypto-js': '^4.2.1' }, { 'lib/axios.js': 'require("follow-redirects")' }))
  assert.match(compromised, /<li><span class="npm-extension is-warn npm-compare-unimported"\s+data-tooltip=New in 1\.14\.1, imported by nothing of it: plain-crypto-js \^4\.2\.1[^]*compare-tip-head">New, and nothing imports it<[^]*compare-tip-version">1\.14\.1<[^]*class=is-flagged>plain-crypto-js: <code>\^4\.2\.1<\/code><[^]*compare-tip-note">No code file of 1\.14\.1 names it as an import would, nor does an install script; npm installs it all the same, running its install scripts<[^]*>\s*Unused deps<\/span><\/li>/u)
  assert.doesNotMatch(compromised, /npm-compare-registry/u)
  const many = await badges(depending('many', '1.0.0', { kept: 'github:a/kept' }),
    depending('many', '1.1.0', { kept: 'github:a/kept', a: '1', b: '1', c: 'https://example.com/c.tgz', d: 'git+ssh://git@example.com:d.git' }))
  assert.match(many, /data-tooltip=1\.0\.0: c none; d none · 1\.1\.0: c https:\/\/example\.com\/c\.tgz; d git\+ssh:\/\/git@example\.com:d\.git\s[^]*>\s*Non-registry deps<\/span><\/li>[^]*>\s*Unused deps<\/span><\/li>/u,
    'each named in its tooltip; not one fetched from elsewhere by the same spec before')
  assert.match(many, /data-tooltip=New in 1\.1\.0, imported by nothing of it: a 1, b 1, c https:\/\/example\.com\/c\.tgz, d git\+ssh:\/\/git@example\.com:d\.git[^]*compare-tip-head">New, and nothing imports them</u,
    'the unused ones named in its tooltip alone')
  assert.match(await badges(scripted('first', '1.0.0', undefined), { ...scripted('first', '1.1.0', { postinstall: 'node x.js' }), npm: { name: 'first', version: '1.1.0', manifest: { installScripts: { postinstall: 'node x.js' }, dependencies: { y: '1' } } } }),
    /npm-compare-install[^]*npm-compare-unimported/u, 'after install scripts')
  assert.doesNotMatch(await badges(depending('dropping', '1.0.0', { gone: 'github:a/gone' }), depending('dropping', '1.1.0', {})), /npm-compare-(?:registry|unimported)/u, 'not one it drops')

  // An open version under two weeks old: how long ago, the day in its
  // tooltip; not one of a scope a team lists.
  const ago = days => new Date(Date.now() - days * 24 * 60 * 60_000).toISOString()
  const recent = await badges(side('recent', '1.0.0', { published: ago(30) }), side('recent', '1.1.0', { published: ago(3) }))
  assert.match(recent, /<li><span class="npm-extension is-warn npm-compare-published" data-tooltip=Published on [A-Z][a-z]{2} \d{1,2}, \d{4}>3 days ago<\/span><\/li>/u)
  assert.doesNotMatch(await badges(side('recent', '1.1.0', { published: ago(3) }), side('recent', '1.0.0', { published: ago(30) })), /npm-compare-published/u, 'only the open one')
  assert.doesNotMatch(await badges(side('settled', '1.0.0', { published: ago(30) }), side('settled', '1.1.0', { published: ago(15) })), /npm-compare-published/u)
  answers.versions.listed = { versions: ['1.1.0', '1.0.0'], times: { '1.1.0': ago(5), '1.0.0': ago(30) } }
  assert.match(await badges(side('listed', '1.0.0'), side('listed', '1.1.0')), />5 days ago</u, 'its time from the version list, where it came without')
  answers.versions['@team/fresh'] = { versions: [], teamScoped: true }
  assert.doesNotMatch(await badges(side('@team/fresh', '1.0.0', { published: ago(30) }), side('@team/fresh', '1.1.0', { published: ago(3) })), /npm-compare-published/u, 'a team\'s own')

  answers.socket['@acme/secret@1.1.0'] = { scores: scores({ quality: .1 }), alerts: [] }
  assert.doesNotMatch(await badges(side('@acme/secret', '1.0.0', { private: true }), side('@acme/secret', '1.1.0', { private: true })), /Quality/u)
  assert.ok(!socketAsked.some(asked => asked.startsWith('@acme/')), 'Socket is never asked about a private package')
})

test('a dependency Compare lists new is tagged with its package\'s tier by downloads but its latest two weeks\', whatever it is, once they arrive, asked with the others\'', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-12T12:00:00Z') })
  // 500 a day: 3,500 a week, among the top 100,000; 4M a day, 28M a week, among the top 2,000.
  answers.counts['new-low'] = { start: '2026-08-01', end: '2026-10-11', days: Array.from({ length: 72 }, () => 500) }
  answers.counts['new-top'] = { start: '2026-08-01', end: '2026-10-11', days: Array.from({ length: 72 }, () => 4e6) }
  const settle = () => new Promise(resolve => { setImmediate(resolve) })
  // Asked for in one pass, as a Compare's are: one request for all.
  countsAsked.length = 0
  npmDependencyTags({ name: 'new-low', opens: 'new-low' }, 'added')
  npmDependencyTags({ name: 'new-top', opens: 'new-top' }, 'added')
  npmDependencyTags({ name: 'unlisted', opens: 'unlisted' }, 'added')
  await settle()
  assert.deepEqual(countsAsked, [['new-low', 'new-top', 'unlisted']])
  assert.equal(rendered(npmDependencyTags({ name: 'unlisted', opens: 'unlisted' }, 'added')), '', 'nothing for one not answered')
  // Shown one after another, each package's downloads asked for once a
  // session: 1 depending on A and B, 2 on B and C, 3 on all three.
  for (const name of ['dep-a', 'dep-b', 'dep-c']) answers.counts[name] = answers.counts['new-low']
  const show = async (...names) => { countsAsked.length = 0; for (const name of names) npmDependencyTags({ name, opens: name }, 'added'); await settle(); return countsAsked }
  assert.deepEqual(await show('dep-a', 'dep-b'), [['dep-a', 'dep-b']])
  assert.deepEqual(await show('dep-b', 'dep-c'), [['dep-c']], 'only the one not had')
  assert.deepEqual(await show('dep-a', 'dep-b', 'dep-c'), [], 'none, all had')
  // As many as fit a request line: a long list in more than one request.
  const many = Array.from({ length: 300 }, (_, i) => `a-dependency-with-a-rather-long-name-${String(i).padStart(3, '0')}`)
  const split = await show(...many)
  assert.ok(split.length > 1 && split.every(names => names.map(encodeURIComponent).join(',').length <= 8000), `${split.length} requests`)
  assert.deepEqual(split.flat(), many, 'each once, in order')
  // One whose own figures the session has (as its Overview read them) isn't asked for again.
  answers.stats['dep-figured'] = { downloads: answers.counts['new-top'] }
  npmCompareBadges({ npm: { name: 'dep-figured', version: '1.0.0' } }, { npm: { name: 'dep-figured', version: '1.1.0' } })
  await settle()
  assert.deepEqual(await show('dep-figured'), [])
  assert.match(rendered(npmDependencyTags({ name: 'dep-figured', opens: 'dep-figured' }, 'added')), />top 2,000</u)
  const tag = async (row, kind = 'added') => { npmDependencyTags(row, kind); await settle(); return rendered(npmDependencyTags(row, kind)) }
  assert.match(await tag({ name: 'alias', range: 'npm:new-low@^1.0.0', opens: 'new-low' }), /<span class=npm-downloads-tier is-low data-tooltip=15,500 downloads\/month, August 2026[^]*downloads\/month<\/div>[^]*>top 100,000<\/span>/u,
    'the package it opens, an alias\'s too, to Sep 27: its last whole month August')
  // A package just pulled in, its latest two weeks' downloads 1M a day, but
  // 100 a day before them: unpopular, as it was.
  answers.counts['new-spiked'] = { start: '2026-08-01', end: '2026-10-11', days: Array.from({ length: 72 }, (_, i) => i < 58 ? 100 : 1e6) }
  assert.match(await tag({ name: 'new-spiked', opens: 'new-spiked' }), /npm-downloads-tier is-unpopular[^]*>unpopular</u, 'not by its latest two weeks')
  assert.deepEqual(npmSettledDownloads(answers.counts['new-spiked'], Date.parse('2026-10-12T12:00:00Z')),
    { start: '2026-08-01', end: '2026-09-27', days: Array.from({ length: 58 }, () => 100) }, 'to the day before the latest two weeks, Sep 28 to Oct 11')
  assert.match(await tag({ name: 'new-top', opens: 'new-top' }), /npm-downloads-tier is-top[^]*>top 2,000</u, 'green ones too')
  assert.equal(await tag({ name: 'new-low', opens: 'new-low' }, 'changed'), '', 'not one the version compared with had')
  assert.equal(await tag({ name: 'new-low', opens: 'new-low' }, 'removed'), '')
  assert.equal(await tag({ name: 'local', opens: null }), '', 'nor one that opens no package, as npm doesn\'t install it from the registry')
  // What calls for a look at one, flagged, whatever its kind.
  const source = { check: 'source', label: 'non-registry', tooltip: 'From GitHub, not npm\'s registry: github:a/b' }
  assert.equal(await tag({ name: 'b', opens: null, flags: [source] }, 'changed'), '<span class=npm-dependency-flag is-source data-tooltip=From GitHub, not npm\'s registry: github:a/b>non-registry</span>')
})

test('a new dependency npm counts no downloads of is unpopular; one below the top 20,000 whose package is new since the version compared with, how old it was', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-12T12:00:00Z') })
  const settle = () => new Promise(resolve => { setImmediate(resolve) })
  // Its downloads asked for, then its version list, then shown.
  const tag = async row => { npmDependencyTags(row, 'added'); await settle(); npmDependencyTags(row, 'added'); await settle(); return rendered(npmDependencyTags(row, 'added')) }
  const days = perDay => ({ start: '2026-08-01', end: '2026-10-11', days: Array.from({ length: 72 }, () => perDay) })
  // npm's downloads API answers none for a package until the day after its
  // first is over: axios 1.14.1, 21 minutes past midnight, named one first
  // published the morning before, plain-crypto-js.
  const axios = [{ name: 'axios', version: '1.14.0', published: '2026-03-27T19:01:40.000Z' }, { name: 'axios', version: '1.14.1', published: '2026-03-31T00:21:58.000Z' }]
  answers.counts['crypto-uncounted'] = null
  answers.versions['crypto-uncounted'] = { versions: ['0.0.1-security'], times: { '0.0.1-security': '2026-03-31T03:25:11.636Z' }, created: '2026-03-30T05:57:32.867Z' }
  const uncounted = await tag({ name: 'crypto-uncounted', opens: 'crypto-uncounted', compared: axios })
  assert.match(uncounted, /<span class="npm-downloads-tier is-unpopular"\s+data-tooltip="No downloads counted by npm, which counts a package's from the day after it was first published">unpopular<\/span>/u)
  assert.match(uncounted, /<span class="npm-dependency-flag is-new" data-tooltip=First published on Mar 30, 2026, 18 hours before 1\.14\.1 was; npm had no package by its name when 1\.14\.0 was published>18 hours old<\/span>$/u,
    'its first version\'s day, one npm took down since')
  // Not a private one, whose downloads npm's API tells no one, nor one the
  // reader can't open: neither its tier nor its age.
  answers.counts['@acme/internal'] = null
  answers.versions['@acme/internal'] = { versions: ['1.0.0'], times: { '1.0.0': '2026-03-30T05:57:32.867Z' }, created: '2026-03-30T05:57:32.867Z', private: true }
  assert.equal(await tag({ name: '@acme/internal', opens: '@acme/internal', compared: axios }), '')
  answers.counts['@acme/unopened'] = null
  versionsFail.add('@acme/unopened')
  assert.equal(await tag({ name: '@acme/unopened', opens: '@acme/unopened', compared: axios }), '')
  // Orange too, its age in days; the versions' times from their package's
  // version list where they came without.
  answers.counts['fresh-low'] = days(500)
  answers.versions['fresh-low'] = { versions: ['1.0.0'], times: { '1.0.0': '2026-02-01T00:00:00.000Z' }, created: '2026-02-01T00:00:00.000Z' }
  answers.versions.listing = { versions: ['1.1.0', '1.0.0'], times: { '1.1.0': '2026-03-31T00:21:00.000Z', '1.0.0': '2026-01-01T00:00:00.000Z' } }
  const listed = [{ name: 'listing', version: '1.0.0', published: null }, { name: 'listing', version: '1.1.0', published: null }]
  assert.match(await tag({ name: 'fresh-low', opens: 'fresh-low', compared: listed }), /npm-downloads-tier is-low[^]*>top 100,000<\/span>[^]*<span class="npm-dependency-flag is-new" data-tooltip=First published on Feb 1, 2026, 58 days before 1\.1\.0 was;[^>]*>58 days old<\/span>$/u)
  // One first published after the open version was: npm had none by its
  // name then, as where someone took a name a release named.
  answers.counts['taken-later'] = days(0)
  answers.versions['taken-later'] = { versions: ['1.0.0'], times: { '1.0.0': '2026-04-02T06:00:00.000Z' }, created: '2026-04-02T06:00:00.000Z' }
  assert.match(await tag({ name: 'taken-later', opens: 'taken-later', compared: axios }),
    /<span class="npm-dependency-flag is-new" data-tooltip=First published on Apr 2, 2026, 2 days after 1\.14\.1 was: npm had no package by its name when either version was published>published later<\/span>$/u)
  // Not one that existed when the version compared with was published.
  answers.counts['old-unpopular'] = days(0)
  answers.versions['old-unpopular'] = { versions: ['1.0.0'], times: { '1.0.0': '2020-01-01T00:00:00.000Z' }, created: '2020-01-01T00:00:00.000Z' }
  const old = await tag({ name: 'old-unpopular', opens: 'old-unpopular', compared: axios })
  assert.match(old, />unpopular<\/span>$/u)
  assert.doesNotMatch(old, /is-new/u)
  // Nor, its version list not even asked for, one in the top 20,000, nor
  // one changed, which the version compared with had.
  answers.counts['fresh-popular'] = days(4e6)
  answers.versions['fresh-popular'] = { versions: ['1.0.0'], times: {}, created: '2026-03-30T00:00:00.000Z' }
  versionsAsked.length = 0
  assert.doesNotMatch(await tag({ name: 'fresh-popular', opens: 'fresh-popular', compared: axios }), /is-new/u)
  npmDependencyTags({ name: 'crypto-uncounted', opens: 'crypto-uncounted', compared: axios }, 'changed')
  await settle()
  assert.deepEqual(versionsAsked, [])
  // A package's own figures saying none, as npm failing leaves them too: its
  // downloads asked for again, alone.
  answers.stats['figured-none'] = { downloads: null }
  npmCompareBadges({ npm: { name: 'figured-none', version: '1.0.0' } }, { npm: { name: 'figured-none', version: '1.1.0' } })
  await settle()
  answers.counts['figured-none'] = days(4e6)
  countsAsked.length = 0
  assert.match(await tag({ name: 'figured-none', opens: 'figured-none' }), />top 2,000<\/span>$/u)
  assert.deepEqual(countsAsked, [['figured-none']])
})

test('Compare flags in red the files the open version adds or changes that call for a look: a large code file added, one become unreadable, one newly obfuscated', async () => {
  const version = (ver, files) => ({ integrity: `files@${ver}`, kind: 'sourcemap', json: { version: 3, sources: Object.keys(files), sourcesContent: Object.values(files) },
    npm: { name: 'files', version: ver } })
  const compared = (base, other) => computeBundleDiff(bundleFilesAsMap(base), bundleFilesAsMap(other), () => '__own__').files
  const badges = async (base, other, files = compared(base, other)) => {
    npmCompareBadges(base, other, files); await new Promise(resolve => { setImmediate(resolve) }); return rendered(npmCompareBadges(base, other, files))
  }
  const code = Array.from({ length: 40 }, (_, i) => `export const value${i} = ${i}`).join('\n')
  const payload = `${obfuscated(25)}\n${'// padding padding padding\n'.repeat(12_000)}`
  const big = '// big\n'.repeat(40_000)
  const base = version('1.0.0', { 'package.json': '{"name":"files"}\n', 'index.js': `${code}\n${code}\n${code}\n`, 'lib/vendor.js': obfuscated(25, 0x2000), 'lib/big.js': big,
    'lib/util.js': `${code}\n` })
  const other = version('1.1.0', { 'package.json': '{"name":"files"}\n', 'index.js': `${code}\n${code}\nconst payload = '${'y'.repeat(2001)}'\n${code}\n`, 'lib/vendor.js': obfuscated(30, 0x3000),
    'lib/big-moved.js': big, 'lib/helpers.js': `${code}\n${obfuscated(25)}\n`, 'dist/payload.js': payload })
  const files = compared(base, other)
  assert.deepEqual(files.changed.filter(row => row.renamedFrom).map(row => [row.renamedFrom, row.path, row.modified]).toSorted(),
    [['lib/big.js', 'lib/big-moved.js', false], ['lib/util.js', 'lib/helpers.js', true]], 'renames paired, one as it was, one modified')
  const flagged = await badges(base, other, files)
  const chips = [...flagged.matchAll(/<li><span class=npm-extension npm-compare-file (npm-compare-\w+)[^]*?>\s*<span>([^<]+)<\/span>(?:<span class="npm-extension-count">([^<]+)<\/span>)?<\/span><\/li>/gu)]
    .map(([, kind, label, count]) => [kind, label, count ?? null])
  assert.deepEqual(chips, [['npm-compare-large', 'Large new code', null], ['npm-compare-unreadable', 'Now unreadable', null],
    ['npm-compare-obfuscated', 'Obfuscated', '2']], 'a large code file added, not one moved; a file become unreadable; files newly obfuscated, one renamed, not one obfuscated before; counted where several, no file named')
  const outside = flagged.replaceAll(/data-tooltip=[^\n]*|\.tooltipContent=[^]*?<\/div>\s*<\/div>>/gu, '')
  assert.match(outside, /<span>Large new code<[^]*<span>Now unreadable<[^]*<span>Obfuscated</u)
  assert.doesNotMatch(outside, /payload\.js|index\.js|helpers\.js/u, 'the files in their tooltips alone')
  const size = `${(payload.length / 1024).toFixed(1)} KiB`
  assert.match(flagged, new RegExp(`data-tooltip=Large new code: dist/payload\\.js \\(${size}\\)\\s`, 'u'), 'in text, where it can\'t be styled')
  assert.match(flagged, new RegExp(`compare-tip-head">Large new code<[^]*compare-tip-rows is-files"><span class="compare-tip-path">dist/payload\\.js</span><span class="compare-tip-said">${size}</span></div>`
    + '[^]*compare-tip-note">Code files the open version adds, of 256 KiB or more<', 'u'), 'styled, a row for each file')
  assert.match(flagged, /compare-tip-path">index\.js<\/span><span class="compare-tip-said">25 → 2,019 characters</u, 'its longest line before and now')
  assert.match(flagged, /compare-tip-path">dist\/payload\.js<\/span><span class="compare-tip-said">25 names such as _0x1a2b<[^]*compare-tip-path">lib\/helpers\.js</u)
  assert.doesNotMatch(flagged, /compare-tip-path">lib\/(?:vendor|big-moved)\.js</u)
  assert.doesNotMatch(await badges(base, other, null), /npm-compare-file/u, 'none until the files are compared')
  assert.doesNotMatch(await badges(other, base), /npm-compare-file/u, 'none the other way: a file dropped, one readable again, obfuscation gone')

  // Their tags on the files, as in the Files list: what each is now, whatever
  // it was before.
  const tags = path => [...rendered(npmCompareFiles.tag(other, path)).matchAll(/class="?(npm-\w+-tag)[^>]*>([^<]+)</gu)].map(([, kind, tag]) => `${kind}:${tag}`)
  assert.deepEqual(tags('dist/payload.js'), ['npm-flag-tag:Large', 'npm-flag-tag:Obfuscated', 'npm-encoding-tag:Minified'])
  assert.deepEqual(tags('lib/vendor.js'), ['npm-flag-tag:Obfuscated', 'npm-encoding-tag:Minified'], 'obfuscated before too: tagged, not flagged')
  assert.deepEqual(tags('lib/big-moved.js'), ['npm-flag-tag:Large'], 'ASCII untagged in a list')
  assert.deepEqual(tags('index.js'), ['npm-flag-tag:Long lines'], 'one become unreadable by its Long lines tag')

  // Many files: counted, the tooltip listing the first eight.
  const many = (ver, line) => version(ver, Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`lib/f${i}.js`, `${code}\n${line}\n`])))
  const counted = await badges(many('2.0.0', 'export {}'), many('2.1.0', `const x = '${'z'.repeat(2001)}'`))
  assert.match(counted, /<span>Now unreadable<\/span><span class="npm-extension-count">10</u)
  assert.equal(counted.match(/compare-tip-path"/gu).length, 8)
  assert.match(counted, /compare-tip-note">and 2 more</u)
  assert.match(counted, /data-tooltip=Now unreadable: lib\/f0\.js \(25 → 2,013 characters\), (?:lib\/f\d\.js \([^)]+\), ){7}and 2 more\s/u, 'in text, as many')
})

test('Compare flags in red code that runs beyond itself new to a file the open version adds or changes, naming the kinds', async () => {
  const version = (ver, files) => ({ integrity: `runs@${ver}`, kind: 'sourcemap', json: { version: 3, sources: Object.keys(files), sourcesContent: Object.values(files) },
    npm: { name: 'runs', version: ver } })
  const badges = async (base, other) => {
    const files = computeBundleDiff(bundleFilesAsMap(base), bundleFilesAsMap(other), () => '__own__').files
    npmCompareBadges(base, other, files); await new Promise(resolve => { setImmediate(resolve) }); return rendered(npmCompareBadges(base, other, files))
  }
  const code = Array.from({ length: 30 }, (_, i) => `export const value${i} = ${i}`).join('\n')
  const base = version('1.0.0', { 'lib/a.js': 'module.exports = 1\n', 'lib/b.js': 'module.exports = x => eval(x)\n', 'lib/old.js': `${code}\n`, 'lib/same.js': 'eval(y)\n' })
  const other = version('1.1.0', { 'lib/a.js': "module.exports = x => require('child_process').exec(x)\n", 'lib/b.js': 'module.exports = x => eval(x) + eval(x)\n',
    'lib/new.js': "module.exports = new Function('return 1')\n", 'lib/moved.js': `${code}\nmodule.exports = s => eval(s)\n`, 'lib/same.js': 'eval(y)\n' })
  const flagged = await badges(base, other)
  assert.match(flagged, /<li><span class=npm-extension npm-compare-file npm-compare-runs[^]*?<span>Runs code<\/span><span class="npm-extension-count">eval, Function, child_process<\/span><\/span><\/li>/u,
    'red, every kind new to a file named, in their order')
  const rows = [...flagged.matchAll(/compare-tip-path">([^<]+)<\/span><span class="compare-tip-said">([^<]+)</gu)].map(([, path, said]) => `${path}: ${said}`)
  assert.deepEqual(rows.filter(row => /\((?:line|lines) /u.test(row)), ['lib/new.js: Function (line 1)', 'lib/a.js: child_process (line 1)', 'lib/moved.js: eval (line 31)'],
    'an added file\'s, a changed one\'s, a renamed one\'s new to it; not eval kept in lib/b.js, nor lib/same.js unchanged')
  assert.doesNotMatch(await badges(other, base), /npm-compare-runs/u, 'none the other way: run code dropped')
  assert.doesNotMatch(await badges(base, version('1.0.1', { ...Object.fromEntries(base.json.sources.map((path, i) => [path, base.json.sourcesContent[i]])), 'lib/b.js': 'module.exports = x => eval(x) // more\n' })),
    /npm-compare-runs/u, 'nor for eval a file already held')
  // Laid out under other roots (`package/` read as none), a file added at a
  // path the one compared with held another file at is new all the same.
  const rooted = version('2.0.0', { 'package/lib/a.js': 'eval(x)\nconst a = 1\n', 'package/index.js': 'module.exports = 1\n' })
  const unrooted = version('2.1.0', { 'lib/a.js': 'eval(x)\nconst a = 1\n', 'index.js': 'module.exports = 1\n', 'package/lib/a.js': 'eval(y)\n' })
  assert.match(await badges(rooted, unrooted), /npm-compare-runs[^]*?compare-tip-path">package\/lib\/a\.js<[^]*?<span>Runs code<\/span><span class="npm-extension-count">eval<\/span>/u)
})

test('the Overview\'s provenance: what built the version, from which commit, then by which workflow, in which run, its log entry; none, or nothing for a private package', async () => {
  const text = value => Array.isArray(value) ? value.map(text).join('') : value?.strings ? value.strings.map((part, i) => part + text(value.values[i])).join('') : typeof value === 'symbol' ? '' : String(value ?? '')
  const entry = (name, manifest, extra = {}) => ({ npm: { name, version: '1.0.0', manifest, ...extra } })
  const fact = async version => { npmProvenanceFact(version); await new Promise(resolve => { setImmediate(resolve) }); return text(npmProvenanceFact(version)) }
  answers.provenance['built@1.0.0'] = { repository: 'https://github.com/org/repo', commit: 'b'.repeat(40), workflow: '.github/workflows/release.yml', ref: 'refs/tags/v1.0.0',
    builder: 'https://github.com/actions/runner/github-hosted', run: 'https://github.com/org/repo/actions/runs/7/attempts/1', logIndex: 42 }
  const built = await fact(entry('built', { provenance: true, github: { github: 'org/repo' } }))
  assert.match(built, /<span class="npm-provenance-line">\s*<span class=npm-provenance-builder is-hosted>GitHub Actions<\/span>\s*<span class="npm-provenance-sep">from<\/span>/u,
    'green, built on GitHub\'s runners from the repository it names, on one line with where from')
  assert.match(built, new RegExp(`href=https://github\\.com/org/repo/commit/${'b'.repeat(40)} [^>]*><span>org/repo@bbbbbbb<`, 'u'), 'its source at its commit')
  assert.match(built, new RegExp(`href=https://github\\.com/org/repo/blob/${'b'.repeat(40)}/\\.github/workflows/release\\.yml [^>]*data-tooltip=\\.github/workflows/release\\.yml [^>]*><span>release\\.yml<`, 'u'),
    'its workflow, at that commit, by its file\'s name')
  assert.match(built, /href=https:\/\/github\.com\/org\/repo\/actions\/runs\/7\/attempts\/1 data-tooltip= [^>]*><span>Run</u, 'no tooltip, which would only say what it is')
  assert.match(built, /href=https:\/\/search\.sigstore\.dev\/\?logIndex=42 data-tooltip= [^>]*><span>Transparency log</u)
  assert.doesNotMatch(built, /npm-provenance-warning/u)
  answers.provenance['moved@1.0.0'] = { ...answers.provenance['built@1.0.0'], builder: 'https://github.com/actions/runner/self-hosted' }
  const moved = await fact(entry('moved', { provenance: true, github: { github: 'org/other' } }))
  assert.match(moved, /<span class=npm-provenance-builder>GitHub Actions, self-hosted runner</u, 'not green: the publisher\'s own runner')
  assert.match(moved, /npm-provenance-warning" data-tooltip=The package names org\/other>Not the repository it names</u, 'built from another repository than it names')
  answers.provenance['lab@1.0.0'] = { repository: 'https://gitlab.com/group/project', commit: 'd'.repeat(40), workflow: 'publish', ref: null,
    builder: 'https://gitlab.com/group/project/-/runners/12345', run: 'https://gitlab.com/group/project/-/jobs/678', logIndex: null }
  const lab = await fact(entry('lab', { provenance: true }))
  assert.match(lab, /<span class=npm-provenance-builder>GitLab CI<\/span>/u, 'not green where nothing says whose runner it was')
  answers.provenance['lab-hosted@1.0.0'] = { ...answers.provenance['lab@1.0.0'], runner: 'gitlab-hosted' }
  assert.match(await fact(entry('lab-hosted', { provenance: true })), /<span class=npm-provenance-builder is-hosted>GitLab CI<\/span>/u, 'green on GitLab\'s own, as its certificate says')
  answers.provenance['lab-own@1.0.0'] = { ...answers.provenance['lab@1.0.0'], runner: 'self-hosted' }
  assert.match(await fact(entry('lab-own', { provenance: true })), /<span class=npm-provenance-builder>GitLab CI, self-hosted runner<\/span>/u)
  assert.match(lab, new RegExp(`href=https://gitlab\\.com/group/project/-/commit/${'d'.repeat(40)} [^>]*><span>gitlab\\.com/group/project@ddddddd<`, 'u'), 'its commit, as GitLab links one')
  assert.match(lab, /<span class="mono" data-tooltip=>publish</u, 'its job, by name, no tooltip saying it again')
  assert.doesNotMatch(await fact(entry('lab', { provenance: true, gitlab: 'Group/Project' })), /npm-provenance-warning/u, 'the GitLab project it names')
  answers.provenance['lab-moved@1.0.0'] = answers.provenance['lab@1.0.0']
  const labMoved = await fact(entry('lab-moved', { provenance: true, gitlab: 'group/other' }))
  assert.match(labMoved, /data-tooltip=The package names gitlab\.com\/group\/other>Not the repository it names</u, 'another GitLab project')
  assert.match(labMoved, /<span class=npm-provenance-builder>GitLab CI</u, 'not green, from another repository')
  answers.provenance['lab-github@1.0.0'] = answers.provenance['lab@1.0.0']
  assert.match(await fact(entry('lab-github', { provenance: true, github: { github: 'org/repo' } })), /data-tooltip=The package names org\/repo>Not the repository it names</u,
    'a GitHub repository, built on GitLab')
  assert.equal(text(npmProvenanceFact(entry('unbuilt', {}))), '<span class="npm-commit-missing">None</span>')
  // Listed in its manifest, but no statement the server reads (as one naming
  // another tarball): never shown as attested, nor while it's asked for.
  const rejected = entry('rejected', { provenance: true })
  assert.equal(text(npmProvenanceFact(rejected)), '<span class="npm-commit-missing">Checking…</span>')
  assert.match(await fact(rejected), /npm-provenance-warning[^>]*>Listed, but none for this tarball</u)
  assert.doesNotMatch(await fact(rejected), /Attested/u)
  assert.equal(text(npmProvenanceFact(entry('secret', { provenance: true }, { private: true }))), '', 'nothing for a private package')

  // Whether it names what built the version, for the facts not to name its
  // trusted publisher again: while it's asked for, and once read with a builder.
  assert.equal(npmProvenanceNamesBuilder(entry('built', { provenance: true }).npm), true)
  assert.equal(npmProvenanceNamesBuilder(entry('rejected', { provenance: true }).npm), false, 'not where no statement was read')
  assert.equal(npmProvenanceNamesBuilder(entry('pending', { provenance: true }).npm), true, 'nor yet while it is asked for')
  assert.equal(npmProvenanceNamesBuilder(entry('unbuilt', {}).npm), false)
  answers.provenance['builderless@1.0.0'] = { ...answers.provenance['built@1.0.0'], builder: null }
  assert.equal(await (async () => { npmProvenanceNamesBuilder(entry('builderless', { provenance: true }).npm); await new Promise(resolve => { setImmediate(resolve) })
    return npmProvenanceNamesBuilder(entry('builderless', { provenance: true }).npm) })(), false, 'nor where it names no builder')
})
