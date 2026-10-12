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
const answers = { advisories: {}, stats: {}, socket: {}, provenance: {}, versions: {} }
const socketAsked = []
mock.module('../ui/view/client-managed.js', { exports: {
  fetchNpmAdvisories: name => Promise.resolve(answers.advisories[name] ?? { versions: [], advisories: [] }), fetchNpmStats: name => Promise.resolve(answers.stats[name] ?? {}),
  fetchNpmPackage() {}, fetchNpmProvenance: (name, version) => Promise.resolve({ provenance: answers.provenance[`${name}@${version}`] ?? null }), fetchNpmSocket: (name, version) => { socketAsked.push(`${name}@${version}`); return Promise.resolve({ socket: answers.socket[`${name}@${version}`] ?? null }) }, fetchNpmTags: () => Promise.resolve({ tags: [] }), fetchNpmVersions: name => Promise.resolve(answers.versions[name] ?? { versions: [] }), fetchBundleContents() {}, fetchBundleMetadata() {},
} })
const { npmAdvisoryStatus, npmCompareBadges, npmFileExtension, npmProvenanceFact, npmFileExtensions, npmFileTypes, npmSocketFileTags, npmTakenDown } = await import('../ui/view/npm-overview.js')
const { NPM_LONG_LINE, npmFileReadability, npmTextEncoding } = await import('../ui/view/file-readability.js')

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

  // A publisher that changed, as when a package changes hands.
  const published = publisher => ({ manifest: { publisher } })
  const handed = await badges(side('handed', '1.0.0', published('alice')), side('handed', '1.1.0', published('mallory')))
  assert.match(handed, /<li><a class="npm-extension is-warn npm-compare-publisher" href=https:\/\/www\.npmjs\.com\/~mallory [^]*>~alice → ~mallory<\/span><\/a><\/li>/u,
    'first, linking to the new publisher')
  assert.match(handed, /compare-tip-head">Published by<[^]*>1\.0\.0<[^]*>~alice<[^]*>1\.1\.0<[^]*>~mallory</u)
  assert.doesNotMatch(await badges(side('same-hands', '1.0.0', published('alice')), side('same-hands', '1.1.0', published('alice'))), /npm-compare-publisher/u)
  assert.doesNotMatch(await badges(side('unsaid', '1.0.0'), side('unsaid', '1.1.0', published('alice'))), /npm-compare-publisher/u, 'not where npm doesn\'t say')

  // Provenance the open version lost.
  const attested = provenance => ({ manifest: { provenance } })
  const lost = await badges(side('lost', '1.0.0', attested(true)), side('lost', '1.1.0', attested(undefined)))
  assert.match(lost, /<li><span class="npm-extension npm-compare-provenance"[^]*compare-tip-head">npm provenance<[^]*>Listed by npm<[^]*compare-tip-none">None<[^]*>Provenance lost<\/span><\/li>/u)
  assert.doesNotMatch(await badges(side('gained', '1.0.0', attested(undefined)), side('gained', '1.1.0', attested(true))), /npm-compare-provenance/u, 'not one it gained')
  assert.doesNotMatch(await badges(side('kept-attested', '1.0.0', attested(true)), side('kept-attested', '1.1.0', attested(true))), /npm-compare-provenance/u)

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

test('the Overview\'s provenance: what built the version, from which commit, by which workflow, in which run, its log entry; none, or nothing for a private package', async () => {
  const text = value => Array.isArray(value) ? value.map(text).join('') : value?.strings ? value.strings.map((part, i) => part + text(value.values[i])).join('') : typeof value === 'symbol' ? '' : String(value ?? '')
  const entry = (name, manifest, extra = {}) => ({ npm: { name, version: '1.0.0', manifest, ...extra } })
  const fact = async version => { npmProvenanceFact(version); await new Promise(resolve => { setImmediate(resolve) }); return text(npmProvenanceFact(version)) }
  answers.provenance['built@1.0.0'] = { repository: 'https://github.com/org/repo', commit: 'b'.repeat(40), workflow: '.github/workflows/release.yml', ref: 'refs/tags/v1.0.0',
    builder: 'https://github.com/actions/runner/github-hosted', run: 'https://github.com/org/repo/actions/runs/7/attempts/1', logIndex: 42 }
  const built = await fact(entry('built', { provenance: true, github: { github: 'org/repo' } }))
  assert.match(built, /<span>GitHub Actions<\/span>/u)
  assert.match(built, new RegExp(`href=https://github\\.com/org/repo/commit/${'b'.repeat(40)} [^>]*><span>org/repo@bbbbbbb<`, 'u'), 'its source at its commit')
  assert.match(built, new RegExp(`href=https://github\\.com/org/repo/blob/${'b'.repeat(40)}/\\.github/workflows/release\\.yml [^>]*data-tooltip=\\.github/workflows/release\\.yml [^>]*><span>release\\.yml<`, 'u'),
    'its workflow, at that commit, by its file\'s name')
  assert.match(built, /href=https:\/\/github\.com\/org\/repo\/actions\/runs\/7\/attempts\/1 [^>]*><span>Run</u)
  assert.match(built, /href=https:\/\/search\.sigstore\.dev\/\?logIndex=42 [^>]*><span>Transparency log</u)
  assert.doesNotMatch(built, /npm-provenance-warning/u)
  answers.provenance['moved@1.0.0'] = { ...answers.provenance['built@1.0.0'], builder: 'https://github.com/actions/runner/self-hosted' }
  const moved = await fact(entry('moved', { provenance: true, github: { github: 'org/other' } }))
  assert.match(moved, /GitHub Actions, self-hosted runner/u)
  assert.match(moved, /npm-provenance-warning" data-tooltip=The package names org\/other>Not the repository it names</u, 'built from another repository than it names')
  answers.provenance['lab@1.0.0'] = { repository: 'https://gitlab.com/group/project', commit: 'd'.repeat(40), workflow: 'publish', ref: null,
    builder: 'https://gitlab.com/group/project/-/runners/12345', run: 'https://gitlab.com/group/project/-/jobs/678', logIndex: null }
  const lab = await fact(entry('lab', { provenance: true }))
  assert.match(lab, /<span>GitLab CI<\/span>/u)
  assert.match(lab, new RegExp(`href=https://gitlab\\.com/group/project/-/commit/${'d'.repeat(40)} [^>]*><span>gitlab\\.com/group/project@ddddddd<`, 'u'), 'its commit, as GitLab links one')
  assert.match(lab, /data-tooltip=publish>publish</u, 'its job, by name')
  assert.doesNotMatch(await fact(entry('lab', { provenance: true, gitlab: 'Group/Project' })), /npm-provenance-warning/u, 'the GitLab project it names')
  answers.provenance['lab-moved@1.0.0'] = answers.provenance['lab@1.0.0']
  assert.match(await fact(entry('lab-moved', { provenance: true, gitlab: 'group/other' })), /data-tooltip=The package names gitlab\.com\/group\/other>Not the repository it names</u,
    'another GitLab project')
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
})
