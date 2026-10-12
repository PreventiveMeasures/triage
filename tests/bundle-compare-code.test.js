import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { computeFileHash } from '@preventive/report'
import { renamedDiff } from '@preventive/compare/names.js'

const state = {}
mock.module('../client/index.js', { namedExports: { state, BUNDLE_SOURCE_WRAP_KEY: 'wrap' } })
mock.module('../ui/view/bundle-code-splitter.js', { namedExports: {} })
// The server's pretty-printed copies, by bundle and path, and its diffs of
// two with renamed names hidden, worked out from them as it does
// (@preventive/compare's renamedDiff), naming the two files' hashes (each
// asked for noted; an error in place of the base's copy fails its diff).
const pretty = new Map(), renameDiffs = []
// Bundles whose diffs the server answers for another base file than the one
// asked about, or (`id:copy`) as worked out from another copy of it.
const misanswered = new Set()
mock.module('../ui/view/client-managed.js', { namedExports: {
  fetchPrettyBundleFile: (id, path, hash) => (pretty.get(`${id}:${path}`) instanceof Error ? Promise.reject(pretty.get(`${id}:${path}`)) : Promise.resolve({ text: pretty.get(`${id}:${path}`), source: hash })),
  fetchPrettyNpmFile() {},
  async fetchBundleRenameDiff(id, other, params) {
    renameDiffs.push({ id, other, ...params })
    const [before, after] = [pretty.get(`${id}:${params.path}`), pretty.get(`${other}:${params.otherPath}`)]
    if (before instanceof Error) throw before
    const { warnings, ...diff } = await renamedDiff(before, after, { whitespace: params.ignoreWhitespace ? 'all' : 'none' })
    assert.deepEqual(warnings, [])
    const [prettyHash, otherPrettyHash] = await Promise.all([misanswered.has(`${id}:copy`) ? `${before}x` : before, after].map(computeFileHash))
    return { ...diff, hash: misanswered.has(id) ? `${params.hash}x` : params.hash, otherHash: params.otherHash, prettyHash, otherPrettyHash }
  },
  fetchNpmRenameDiff() {},
} })
mock.module('lit/directives/repeat.js', { namedExports: { repeat: (items, _key, template) => items.map(template) } })
const { bundleFileMeta, computeBundleDiff, computeResolutionDiff } = await import('../ui/view/bundle-compare-diff.js')
const { bundleCompareResolutions } = await import('../ui/view/bundle-compare-inputs.js')
const { bundleFilesAsMap } = await import('../ui/view/bundle-sources.js')
const { npmDependencyFlagTags } = await import('../ui/view/npm-dependency-checks.js')
await import('../ui/view/bundle-compare-code.js')
const CompareCode = customElements.get('bundle-compare-code')

// Template text with class maps spelled out, so rows can be matched by class.
function renderText(value) {
  if (Array.isArray(value)) return value.map(renderText).join('')
  if (value?.strings) return value.strings.map((text, i) => text + renderText(value.values[i])).join('')
  if (value?._$litDirective$) {
    const [first] = value.values
    if (first && typeof first === 'object' && !Array.isArray(first) && !first.strings) {
      return Object.entries(first).filter(([, on]) => on).map(([name]) => name).join(' ')
    }
    return renderText(first)
  }
  return value == null || typeof value === 'symbol' || typeof value === 'function' ? '' : String(value)
}

// A source map's version, by its integrity and files; an npm version's where
// it has a `manifest`.
const version = (integrity, files, manifest = null) => ({ integrity, kind: 'sourcemap', json: { version: 3, sources: Object.keys(files), sourcesContent: Object.values(files) },
  ...manifest && { npm: { name: 'pkg', version: integrity, manifest } } })

// Code comparing `base` with `other`, `fields` among its properties, ready to
// render: `render(path)` its text with `path` open, `head(path)` its file's head.
function compareOf(base, other, fields = {}) {
  const element = Object.assign(new CompareCode(), { base, other, resolutions: [],
    files: computeBundleDiff(bundleFilesAsMap(base), bundleFilesAsMap(other), () => '__own__').files, ...fields })
  element.willUpdate(new Map([['base'], ['other'], ['files'], ['resolutions']]))
  const render = path => { element.path = path; return renderText(element.render()) }
  return { element, render, head: path => /<header class="bundle-code-main-bar bundle-compare-code-bar">([^]*?)<\/header>/u.exec(render(path))[1] }
}

function details(integrity, major, extra = {}) {
  const v2 = major === 2
  const own = {
    ...extra,
    'src/api.js': v2 ? 'export const a = 2\nexport const b = 1\n' : 'export const a = 1\nexport const b = 1\n',
    'src/server.js': "import pick from 'lodash/pick'\nexport const start = () => pick\n",
    'assets/logo.png': v2 ? 'AQ==' : 'AA==',
    ...v2 ? { 'src/features/search.js': 'export const search = 1\n' } : { 'src/legacy.js': 'module.exports = 1\n' },
  }
  const modules = new Map([['.', { name: 'app', version: '1.0.0', files: own }],
    v2 ? ['node_modules/zod', { name: 'zod', version: '3.0.0', files: { 'index.js': 'export const z = 1\n' } }]
      : ['node_modules/left-pad', { name: 'left-pad', version: '1.0.0', files: { 'index.js': 'module.exports = 1\n' } }]])
  const imports = new Map([['node, import', new Map([['src/server.js', new Map([['lodash/pick', v2 ? 'node_modules/lodash/pick.js' : 'node_modules/lodash/pick.cjs']])]])]])
  return { integrity, kind: 'stasis', bundle: new Bundle({ modules, imports, formats: new Map([['assets/logo.png', 'resource:base64']]) }) }
}

function view(path = null, extra = [{}, {}]) {
  const base = details('base', 1, extra[0]), other = details('other', 2, extra[1])
  const element = new CompareCode()
  element.base = base
  element.other = other
  element.files = computeBundleDiff(bundleFilesAsMap(base), bundleFilesAsMap(other), file => /^node_modules\/[^/]+/u.exec(file)?.[0] ?? '__own__').files
  element.resolutions = computeResolutionDiff(bundleCompareResolutions(base), bundleCompareResolutions(other)).changed
  element.baseName = 'Before'
  element.otherName = 'After'
  element.path = path
  element.willUpdate(new Map([['base'], ['other'], ['files'], ['resolutions']]))
  return element
}

// Bound attributes render unquoted here: `class=a b data-tooltip=path>`.
const dirMarks = markup => Object.fromEntries([...markup.matchAll(/<summary[^]*?<\/summary>/gu)].map(([summary]) => [
  /data-tooltip-truncated data-tooltip=([^\s>]+)>/u.exec(summary)[1], /bundle-compare-code-letter (\w+)/u.exec(summary)?.[1] ?? null]))
const fileMarks = markup => Object.fromEntries([...markup.matchAll(/<button type="button" class=bundle-code-tree-link[^]*?<\/button>/gu)].map(([row]) => [
  /bundle-code-tree-name[^>]*data-tooltip=([^\s>]+)>/u.exec(row)[1], [...row.matchAll(/bundle-compare-code-letter (\w+)/gu)].map(m => m[1])]))

test('the Code tree keeps a package the base records across a root move, and a removed file its format', () => {
  const base = { integrity: 'base', kind: 'stasis', bundle: new Bundle({
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'a.js': 'a', 'b.js': 'b', 'old.png': 'AA==' } }],
      ['crates/foo', { name: 'foo', version: '0.1.0', ecosystem: 'cargo', files: { 'lib.rs': 'fn a() {}\n', 'old.rs': 'fn o() {}\n' } }]]),
    formats: new Map([['old.png', 'resource:base64']]),
  }) }
  const sources = { 'src/a.js': 'a', 'src/b.js': 'b', 'src/crates/foo/lib.rs': 'fn b() {}\n', __prelude__: 'p' }
  const other = { integrity: 'other', kind: 'sourcemap', json: { version: 3, sources: Object.keys(sources), sourcesContent: Object.values(sources), mappings: '' } }
  const { element } = compareOf(base, other)
  assert.deepEqual(element.files.root, { base: '', other: 'src/' })
  assert.equal(element._tree().tree.dirs.get('src')?.dirs.get('crates')?.dirs.get('foo')?.package?.name, 'foo')
  assert.equal(element._format('src/old.png'), 'resource:base64')
})

test('an npm file either side holds as binary reads `binary` in the Code view, each side under its own path', () => {
  const npm = (integrity, sources, binaries = []) => ({ integrity, kind: 'sourcemap', json: { version: 3, sources: Object.keys(sources), sourcesContent: Object.values(sources), mappings: '' },
    npmBinaries: new Map(binaries.map(path => [path, { size: 4, digest: `sha512-${path}` }])) })
  const { element } = compareOf(npm('base', { 'index.js': 'a\n' }, ['LICENSE']), npm('other', { 'index.js': 'b\n', 'LICENSE': 'MIT\n' }))
  assert.equal(element._entries.get('LICENSE')?.kind, 'changed')
  assert.equal(element._format('LICENSE'), 'binary', 'binary in the base, text in the open one')
  assert.equal(element._format('index.js'), undefined)
})

test('a Stasis file either side holds as not text reads that format in the Code view, though the other holds it as text', () => {
  const stasis = (integrity, files, formats) => ({ integrity, kind: 'stasis', bundle: new Bundle({ modules: new Map([['.', { name: 'app', version: '1.0.0', files }]]), formats: new Map(formats) }) })
  const base = stasis('base', { 'LICENSE': 'AA==', 'a.js': 'a' }, [['LICENSE', 'resource:base64']])
  for (const other of [stasis('other', { 'LICENSE': 'MIT\n', 'a.js': 'b' }, [['LICENSE', 'resource']]),
    { integrity: 'other', kind: 'sourcemap', json: { version: 3, sources: ['LICENSE', 'a.js'], sourcesContent: ['MIT\n', 'b'], mappings: '' } }]) {
    const { element } = compareOf(base, other)
    assert.equal(element._entries.get('LICENSE')?.kind, 'changed', other.kind)
    assert.equal(element._format('LICENSE'), 'resource:base64', other.kind)
  }
})

test('the Code tree keeps a base package outside a stripped root where its files read', () => {
  const base = { integrity: 'base', kind: 'stasis', bundle: new Bundle({
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'a', 'src/b.js': 'b' } }],
      ['tools/crate', { name: 'crate', version: '0.1.0', ecosystem: 'cargo', files: { 'lib.rs': 'fn a() {}\n' } }]]),
  }) }
  const sources = { 'a.js': 'a2', 'b.js': 'b' }
  const other = { integrity: 'other', kind: 'sourcemap', json: { version: 3, sources: Object.keys(sources), sourcesContent: Object.values(sources), mappings: '' } }
  const { element } = compareOf(base, other)
  assert.deepEqual(element.files.root, { base: 'src/', other: '' })
  assert.deepEqual(element.files.onlyBase.map(row => row.path), ['../tools/crate/lib.rs'])
  assert.equal(element._tree().tree.dirs.get('..')?.dirs.get('tools')?.dirs.get('crate')?.package?.name, 'crate')
})

test('the Code tree keeps a base package where a colliding fallback placed its files', () => {
  const base = { integrity: 'base', kind: 'stasis', bundle: new Bundle({
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'src/a.js': 'a', 'src/b.js': 'b' } }],
      ['tools/crate', { name: 'crate', version: '0.1.0', ecosystem: 'cargo', files: { 'lib.rs': 'fn a() {}\n' } }]]),
  }) }
  const sources = { 'a.js': 'a2', 'b.js': 'b', '../tools/crate/lib.rs': 'fn other() {}\n' }
  const other = { integrity: 'other', kind: 'sourcemap', json: { version: 3, sources: Object.keys(sources), sourcesContent: Object.values(sources), mappings: '' } }
  const { element } = compareOf(base, other)
  assert.deepEqual(element.files.onlyBase.map(row => row.path), ['../../tools/crate/lib.rs'])
  assert.equal(element._tree().tree.dirs.get('..')?.dirs.get('..')?.dirs.get('tools')?.dirs.get('crate')?.package?.name, 'crate')
})

test('the Code view lists every differing file, repointed importers too, with kind letters on files and on new or gone directories', () => {
  const markup = renderText(view().render())
  const dirs = dirMarks(markup)
  assert.equal(dirs['node_modules/left-pad'], 'removed', 'a package only the base carries is marked D')
  assert.equal(dirs['node_modules/zod'], 'added')
  assert.equal(dirs['src/features'], 'added')
  assert.equal(dirs.src, null, 'a directory both sides carry has no mark')
  assert.deepEqual(fileMarks(markup), {
    'assets/logo.png': ['changed'],
    'node_modules/left-pad/index.js': ['removed'],
    'node_modules/zod/index.js': ['added'],
    'src/features/search.js': ['added'],
    'src/api.js': ['changed'],
    'src/legacy.js': ['removed'],
    'src/server.js': ['repointed'],
  })
  assert.match(markup, /@click=>repointed<\/button>/u, "kind toggles carry no counts: the summary has them")
})

test('a file whose import was repointed shows its imports and its whole source, the importing line marked', () => {
  const markup = renderText(view('src/server.js').render())
  assert.match(markup, /bundle-compare-code-pill repointed>Repointed/u)
  assert.match(markup, /<code[^>]*>lodash\/pick<\/code>/u)
  assert.match(markup, /Before<\/span><code[^>]*>node_modules\/lodash\/pick\.cjs/u)
  assert.match(markup, /After<\/span><code[^>]*>node_modules\/lodash\/pick\.js/u)
  assert.match(markup, /aria-label=Go to line 1/u)
  const source = markup.slice(markup.indexOf('aria-label="Source"'))
  assert.deepEqual([...source.matchAll(/data-line=(\d+)>/gu)].map(m => m[1]), ['1', '2'], 'every line of the file, in one column')
  assert.match(source, /class=diff-row ctx is-import role="row" data-line=1>/u)
  assert.doesNotMatch(source, /diff-row ctx is-import role="row" data-line=2>/u)
  assert.doesNotMatch(markup, /Unified<\/button>/u, 'no diff layout to choose')
})

test('a changed text file renders its diff and a binary one says so', () => {
  const diff = renderText(view('src/api.js').render())
  assert.match(diff, /class=diff-row del/u)
  assert.match(diff, /class=diff-row add/u)
  assert.match(diff, /class="add">\+1<\/span><span class="del">−1/u)
  const binary = renderText(view('assets/logo.png').render())
  assert.match(binary, /Binary file changed · 1 B → 1 B\. A text diff is not available\./u)
})

test('minified files diff pretty-printed, and names renamed alike throughout can be hidden', async t => {
  t.after(() => { state.bundleSourcePretty = false; element._setRenames(false) })
  // A minifier's two builds of a CommonJS module: one function more, and every name after it moved.
  const element = view('dist/app.min.js', [{ 'dist/app.min.js': `var Y=1;function q(n){return Y+n}${'q(Y);'.repeat(250)}module.exports=q;\n` },
    { 'dist/app.min.js': `var X=1;function Z(n){return X+n}${'Z(X);'.repeat(250)}Z(1);module.exports=Z;\n` }])
  element.base.managedId = 'b1'
  element.other.managedId = 'b2'
  pretty.set('b1:dist/app.min.js', 'var Y = 1;\nfunction q(n) {\n  return Y + n;\n}\nq(Y);\nmodule.exports = q;\n')
  pretty.set('b2:dist/app.min.js', 'var X = 1;\nfunction Z(n) {\n  return X + n;\n}\nZ(X);\nZ(1);\nmodule.exports = Z;\n')
  const off = renderText(element.render())
  assert.match(off, /aria-pressed=false aria-busy= aria-label="Pretty-print"/u, 'a minified file offers pretty-printing')
  assert.doesNotMatch(off, /Hide renamed names/u, 'renamed names are hidden in the copies alone')
  state.bundleSourcePretty = true
  assert.match(renderText(element.render()), /is-loading/u, 'busy while both copies are asked for')
  // Until both copies came, each hashed first.
  for (let i = 0; i < 200 && /is-loading/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
  const formatted = renderText(element.render())
  assert.match(formatted, /class="add">\+6<\/span><span class="del">−5/u, 'each copy line by line')
  element._setRenames(true)
  // The server diffs the two copies, asked by the files' paths and hashes.
  assert.match(renderText(element.render()), /aria-busy="true">Hiding renamed names…/u)
  for (let i = 0; i < 200 && /Hiding renamed names…/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
  const renames = renderText(element.render())
  assert.match(renames, /class="add">\+1<\/span><span class="del">−0/u, 'what is new alone')
  assert.match(renames, /var X = 1;/u, 'the old side read with the new names')
  assert.doesNotMatch(renames, /var Y = 1;/u)
  assert.match(renames, /aria-pressed=true aria-label="Hide renamed names"/u)
  const files = bundleFilesAsMap(element.base).get('dist/app.min.js'), others = bundleFilesAsMap(element.other).get('dist/app.min.js')
  assert.deepEqual(renameDiffs, [{ id: 'b1', other: 'b2', path: 'dist/app.min.js', hash: await computeFileHash(files), otherPath: 'dist/app.min.js',
    otherHash: await computeFileHash(others), ignoreWhitespace: false }], 'asked once, for the files as published')
  renderText(element.render())
  assert.equal(renameDiffs.length, 1, 'kept')
})

test('a diff the server could not hide renamed names in says why and shows them', async t => {
  t.after(() => { state.bundleSourcePretty = false; element._setRenames(false) })
  const element = view('dist/lib.min.js', [{ 'dist/lib.min.js': `var Y=1;${'q(Y);'.repeat(250)}\n` }, { 'dist/lib.min.js': `var X=1;${'q(X);'.repeat(250)}\n` }])
  element.base.managedId = 'b5'
  element.other.managedId = 'b6'
  pretty.set('b5:dist/lib.min.js', 'var Y = 1;\nq(Y);\n')
  pretty.set('b6:dist/lib.min.js', 'var X = 1;\nq(X);\n')
  state.bundleSourcePretty = true
  for (let i = 0; i < 200 && /is-loading/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
  pretty.set('b5:dist/lib.min.js', Object.assign(new Error('Comparing this file took too long.'), { status: 504 }))
  element._setRenames(true)
  for (let i = 0; i < 200 && /Hiding renamed names…/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
  const failed = renderText(element.render())
  assert.match(failed, /Couldn't hide renamed names: Comparing this file took too long\./u)
  assert.match(failed, /Show renamed names<\/button>/u)
  element._setRenames(false)
  assert.match(renderText(element.render()), /class="add">\+2<\/span><span class="del">−2/u, 'shown, as the copies differ')
})

test('names are hidden renamed only as a minifier gave them, each side minified: an author\'s renamed shows', t => {
  t.after(() => { element._setRenames(false) })
  const element = view('dist/app.js', [{ 'dist/app.js': 'const fn = require("m");\nfn(1);\n' }, { 'dist/app.js': 'const cb = require("m");\ncb(1);\n' }])
  element._setRenames(true)
  const diff = renderText(element.render())
  assert.match(diff, /class="add">\+2<\/span><span class="del">−2/u)
  assert.doesNotMatch(diff, /Hide renamed names/u, 'nor is it offered')
})

test('names are hidden renamed in JavaScript alone: in CSS a short selector changed shows', t => {
  t.after(() => { element._setRenames(false) })
  const element = view('dist/app.css', [{ 'dist/app.css': '#foo{color:red}\n' }, { 'dist/app.css': '#bar{color:red}\n' }])
  element._setRenames(true)
  const diff = renderText(element.render())
  assert.match(diff, /class="add">\+1<\/span><span class="del">−1/u)
  assert.doesNotMatch(diff, /Hide renamed names/u, 'nor is it offered')
})

test('the Diff view pretty-prints no more minified files together than it keeps copies of', async t => {
  t.after(() => { state.bundleSourcePretty = false })
  await import('../ui/view/bundle-compare-all.js')
  const files = Array.from({ length: 5 }, (_, i) => `dist/f${i}.min.js`)
  const code = view(files[0], [Object.fromEntries(files.map(path => [path, `var Y=1;${'q(Y);'.repeat(250)}\n`])),
    Object.fromEntries(files.map(path => [path, `var X=1;${'q(X);'.repeat(250)}\n`]))])
  code.base.managedId = 'b1'
  code.other.managedId = 'b2'
  const all = new (customElements.get('bundle-compare-all'))()
  for (const name of ['base', 'other', 'files', 'baseName', 'otherName']) all[name] = code[name]
  all.willUpdate(new Map([['base'], ['other'], ['files']]))
  state.bundleSourcePretty = true
  const markup = renderText(all.render())
  assert.match(markup, /\?disabled=true\s+data-tooltip=Too many minified files to pretty-print together: open one in Code/u)
  assert.doesNotMatch(markup, /is-loading/u, 'none asked for')
})

test('the Diff view draws its files 40 at a time, more on asking or as one past them opens, counting them all', async () => {
  await import('../ui/view/bundle-compare-all.js')
  const source = (integrity, files) => ({ integrity, kind: 'sourcemap', json: { version: 3, sources: Object.keys(files), sourcesContent: Object.values(files) } })
  const names = Array.from({ length: 95 }, (_, i) => `lib/f${String(i).padStart(2, '0')}.js`)
  const base = source('a', Object.fromEntries(names.map(path => [path, 'a\n']))), other = source('b', Object.fromEntries(names.map(path => [path, 'b\n'])))
  const all = Object.assign(new (customElements.get('bundle-compare-all'))(), { base, other, baseName: 'a', otherName: 'b', resolutions: [],
    files: computeBundleDiff(bundleFilesAsMap(base), bundleFilesAsMap(other), () => '__own__').files })
  all.willUpdate(new Map([['base'], ['other'], ['files'], ['resolutions']]))
  const drawn = () => {
    const markup = renderText(all.render())
    return { files: [...markup.matchAll(/<section class="bundle-compare-all-file" aria-label=([^\s>]+)/gu)].map(match => match[1]),
      more: /Show more files \(([\d,]+) remaining\)/u.exec(markup)?.[1] ?? null, title: /bundle-compare-all-title">([^<]+)</u.exec(markup)?.[1] }
  }
  assert.deepEqual(drawn(), { files: names.slice(0, 40), more: '55', title: '95 files changed' }, 'the first 40, in the tree\'s order, the head counting all')
  all._more()
  assert.deepEqual(drawn().files.length, 80)
  assert.equal(drawn().more, '15')
  // What updated() does once it's drawn, its pane and the sections drawn stood in for.
  const pane = { scrollTop: 0 }, scrolled = []
  all.querySelector = selector => selector === '.bundle-compare-diff' ? pane : null
  all.querySelectorAll = () => drawn().files.map(path => ({ dataset: { path }, scrollIntoView: () => scrolled.push(path) }))
  const afterDraw = () => { pane.scrollTop = 900; all.updated() }
  all._current = 'lib/f75.js'
  all.willUpdate(new Map([['files']]))
  assert.equal(drawn().files.length, 40, 'a comparison anew from 40, not from the file the last one was at')
  assert.equal(all._current, 'lib/f00.js', 'its first file the rail\'s')
  afterDraw()
  assert.equal(pane.scrollTop, 0, 'and the list from its top, however far it was scrolled')
  all.path = 'lib/f85.js'
  all.willUpdate(new Map([['path']]))
  assert.deepEqual(drawn(), { files: names, more: null, title: '95 files changed' }, 'the batches up to a file opened past them')
  afterDraw()
  assert.deepEqual([scrolled.at(-1), pane.scrollTop], ['lib/f85.js', 900], 'scrolled to')
  all.willUpdate(new Map([['files']]))
  assert.deepEqual([drawn().files.length, all._current], [95, 'lib/f85.js'], 'the file last picked reopened in a new comparison, as Code reopens it')
  afterDraw()
  assert.deepEqual([scrolled.length, pane.scrollTop], [2, 900], 'scrolled to it, not to the top')
  all.path = 'lib/gone.js'
  all.willUpdate(new Map([['files']]))
  assert.deepEqual([drawn().files.length, all._current], [40, 'lib/f00.js'], 'one the new comparison lacks not')
  afterDraw()
  assert.deepEqual([scrolled.length, pane.scrollTop], [2, 0], 'its list from its top')
})

test('the Diff view\'s pretty-print toggle shows any file\'s failure, not only the first file\'s state', async t => {
  t.after(() => { state.bundleSourcePretty = false })
  await import('../ui/view/bundle-compare-all.js')
  const files = ['dist/g0.min.js', 'dist/g1.min.js']
  const code = view(files[0], [Object.fromEntries(files.map(path => [path, `var Y=1;${'q(Y);'.repeat(250)}\n`])),
    Object.fromEntries(files.map(path => [path, `var X=1;${'q(X);'.repeat(250)}\n`]))])
  code.base.managedId = 'b3'
  code.other.managedId = 'b4'
  for (const id of ['b3', 'b4']) {
    pretty.set(`${id}:${files[0]}`, 'var Y = 1;\n')
    pretty.set(`${id}:${files[1]}`, Object.assign(new Error("This file couldn't be read as code."), { status: 422 }))
  }
  const all = new (customElements.get('bundle-compare-all'))()
  for (const name of ['base', 'other', 'files', 'baseName', 'otherName']) all[name] = code[name]
  all.willUpdate(new Map([['base'], ['other'], ['files']]))
  state.bundleSourcePretty = true
  for (let i = 0; i < 200 && /is-loading/u.test(renderText(all.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
  assert.match(renderText(all.render()), /is-error[\s\S]*data-tooltip=Couldn't pretty-print: This file couldn't be read as code\./u)
})

test('the Diff view keeps its renamed names toggles where hiding them hides every change listed', async t => {
  t.after(() => { state.bundleSourcePretty = false; all._setRenames(false) })
  await import('../ui/view/bundle-compare-all.js')
  const code = view(null, [{ 'dist/rn.min.js': `(function(){var Y=1;${'q(Y);'.repeat(250)}})();\n` },
    { 'dist/rn.min.js': `(function(){var X=1;${'q(X);'.repeat(250)}})();\n` }])
  code.base.managedId = 'b13'
  code.other.managedId = 'b14'
  pretty.set('b13:dist/rn.min.js', '(function () {\n  var Y = 1;\n  q(Y);\n})();\n')
  pretty.set('b14:dist/rn.min.js', '(function () {\n  var X = 1;\n  q(X);\n})();\n')
  const all = new (customElements.get('bundle-compare-all'))()
  for (const name of ['base', 'other', 'files', 'baseName', 'otherName']) all[name] = code[name]
  all.willUpdate(new Map([['base'], ['other'], ['files']]))
  all._query = 'rn.min'
  state.bundleSourcePretty = true
  for (let i = 0; i < 200 && /is-loading/u.test(renderText(all.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
  all._setRenames(true)
  for (let i = 0; i < 200 && /Hiding renamed names…/u.test(renderText(all.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
  const markup = renderText(all.render())
  assert.match(markup, /Only renamed names changed in this file\./u, 'its one change hidden')
  const bar = markup.slice(markup.indexOf('bundle-compare-code-bar'), markup.indexOf('bundle-compare-diff"'))
  assert.match(bar, /aria-pressed=true aria-label="Hide renamed names"/u, 'there to turn off')
  assert.match(bar, /aria-label="Mark renamed lines"/u)
})

test('the kind filters hide files, keeping a modified file under Repointed when its imports moved', () => {
  const element = view()
  element._toggleKind('changed')
  element._toggleKind('added')
  element._toggleKind('removed')
  assert.deepEqual(Object.keys(fileMarks(renderText(element.render()))), ['src/server.js'])
})

test('the rail\'s Code mode searches the code the diffs show, each hit signed and numbered as its diff has it, the tree no longer filtered by path', () => {
  const element = view()
  element._query = 'export'
  assert.deepEqual(element._railState().order, [], 'Files mode filters paths, and none holds the query')
  element._mode = 'code'
  assert.equal(element._railState().order.length, 7, 'Code mode filters none')
  const markup = renderText(element.render())
  assert.doesNotMatch(markup, /class=bundle-code-tree-link/u, 'results in place of the tree')
  // Each file's hits as `sign line`, in the order its diff shows them.
  const found = Object.fromEntries([...markup.matchAll(/data-tooltip=([^\s>]+) @click=>[^<]*<\/button>\s*<ul class="bundle-code-search-hits">([^]*?)<\/ul>/gu)].map(([, path, hits]) =>
    [path, [...hits.matchAll(/bundle-code-search-hit-ln">(\d+)<\/span>\s*<span class=bundle-compare-search-sign (\w*) aria-hidden="true">/gu)].map(([, line, sign]) => `${sign} ${line}`)]))
  assert.deepEqual(found, {
    'src/api.js': ['del 1', 'add 1', 'ctx 2'],
    'src/features/search.js': ['add 1'],
    'src/legacy.js': ['del 1'],
    'src/server.js': ['ctx 2'],
    'node_modules/left-pad/index.js': ['del 1'],
    'node_modules/zod/index.js': ['add 1'],
  })
  assert.match(markup, /8 hits in 6 files/u)
  assert.match(markup, /<mark class="bundle-search-mark">export<\/mark>/u)
  element._query = 'nothing like it'
  assert.match(renderText(element.render()), /No matches\./u)
})

test('the search diffs a changed file as the view does: a long one\'s removed lines found, a large one\'s once its diff is asked for', () => {
  const text = (lines, line) => Array.from({ length: lines }, (_, i) => i === 7 ? line : `line ${i}`).join('\n') + '\n'
  const hits = (element, path) => element._searchResults(element._railState().order).files.find(file => file.path === path)?.hits.map(hit => `${hit.sign ?? '?'}${hit.side}${hit.line}`)
  // Past the tree's line counts (20,000 lines), short of a diff too large to show unasked.
  const long = view(null, [{ 'src/long.js': text(25_000, 'fetch(old)') }, { 'src/long.js': text(25_000, 'fetch(new)') }])
  long._mode = 'code'
  long._query = 'fetch('
  assert.deepEqual(hits(long, 'src/long.js'), ['−a7', '+b7'])
  // Too large to diff unasked (isLargeDiff): its new text alone, said so, until asked for.
  const large = view(null, [{ 'src/large.js': text(60_000, 'fetch(old)') }, { 'src/large.js': text(60_000, 'fetch(new)') }])
  large._mode = 'code'
  large._query = 'fetch('
  assert.deepEqual(hits(large, 'src/large.js'), ['?b7'])
  assert.match(renderText(large.render()), /A large diff, not shown yet: the lines it removed aren't searched\./u)
  large._forced.add('src/large.js')
  assert.deepEqual(hits(large, 'src/large.js'), ['−a7', '+b7'], 'asked for, it is diffed, and the results with it')
  assert.doesNotMatch(renderText(large.render()), /A large diff, not shown yet/u)
})

test('the search signs a line as the diff shows it with whitespace changes hidden: re-indented, it is unchanged', t => {
  t.after(() => view()._setWhitespace(false))
  const element = view(null, [{ 'src/indent.js': 'if (a) {\n  fetch(x)\n}\nfetch(old)\n' }, { 'src/indent.js': 'if (a) {\n    fetch(x)\n}\nfetch(new)\n' }])
  element._mode = 'code'
  element._query = 'fetch('
  const signs = () => element._searchResults(element._railState().order).files.find(file => file.path === 'src/indent.js').hits.map(hit => `${hit.sign}${hit.side}${hit.line}`)
  assert.deepEqual(signs(), ['−a1', '+b1', '−a3', '+b3'])
  element._setWhitespace(true)
  assert.deepEqual(signs(), [' b1', '−a3', '+b3'], 'as its diff has it, the re-indented line unchanged')
})

test('a hit in a diff too large to show unasked asks for it, and opens at its line', () => {
  const text = line => Array.from({ length: 60_000 }, (_, i) => i === 7 ? line : `line ${i}`).join('\n') + '\n'
  const element = view('src/large.js', [{ 'src/large.js': text('fetch(old)') }, { 'src/large.js': text('fetch(new)') }])
  element._mode = 'code'
  element._query = 'fetch('
  const markup = renderText(element.render())
  assert.match(markup, /This diff is large/u)
  const { hits: [hit] } = element._searchResults(element._railState().order).files.find(file => file.path === 'src/large.js')
  element._seek('src/large.js', hit, element._searchResults(element._railState().order).unsigned.get('src/large.js') === 'large')
  assert.ok(element._forced.has('src/large.js'), 'its diff asked for')
  const shown = renderText(element.render())
  assert.doesNotMatch(shown, /This diff is large/u)
  const rows = shown.slice(shown.indexOf('aria-label="Diff"')).split('role="row"').slice(1)
  assert.match(rows[element._soughtRow.index], /<span class="diff-num">8<\/span><span class="diff-sign">\+<\/span>[^]*fetch\(<mark class="diff-word">new/u)
})

test('a file whose diff is of its pretty-printed copies lists its lines as published, unsigned, saying so', t => {
  t.after(() => { state.bundleSourcePretty = false })
  const element = view(null, [{ 'dist/printed.min.js': `var Y=1;${'q(Y);'.repeat(250)}fetch(1);\n` }, { 'dist/printed.min.js': `var X=1;${'q(X);'.repeat(250)}fetch(2);\n` }])
  // Managed, as the server pretty-prints a managed bundle's files.
  element.base.managedId = 'b9'
  element.other.managedId = 'b10'
  element._mode = 'code'
  element._query = 'fetch('
  const signs = () => element._searchResults(element._railState().order).files.find(file => file.path === 'dist/printed.min.js').hits.map(hit => `${hit.sign ?? '?'}${hit.side}${hit.line}`)
  assert.deepEqual(signs(), ['−a0', '+b0'], 'as published while it is diffed so')
  state.bundleSourcePretty = true
  assert.deepEqual(signs(), ['?b0'])
  assert.match(renderText(element.render()), /Shown pretty-printed: its lines as published, unsigned, the lines it removed not searched\./u)
})

test('an added file shown pretty-printed lists its lines signed, numbered as published, saying so', t => {
  t.after(() => { state.bundleSourcePretty = false })
  const element = view(null, [{}, { 'dist/added.min.js': `var X=1;${'q(X);'.repeat(250)}fetch(2);\n` }])
  element.base.managedId = 'b11'
  element.other.managedId = 'b12'
  state.bundleSourcePretty = true
  element._mode = 'code'
  element._query = 'fetch('
  const found = element._searchResults(element._railState().order)
  assert.deepEqual(found.files.find(file => file.path === 'dist/added.min.js').hits.map(hit => `${hit.sign}${hit.side}${hit.line}`), ['+b0'])
  assert.equal(found.unsigned.get('dist/added.min.js'), 'numbered')
  assert.match(renderText(element.render()), /Shown pretty-printed: its lines numbered as published\./u)
})

test('a hit opens at the same match pretty-printed where the printer respaced an earlier one but kept a later', async t => {
  t.after(() => { state.bundleSourcePretty = false })
  const element = view('dist/mixed.min.js', [{ 'dist/mixed.min.js': `var x=a-b;s="a+b";${'q(x);'.repeat(250)}\n` },
    { 'dist/mixed.min.js': `var x=a+b;s="a+b";${'q(x);'.repeat(250)}\n` }])
  element.base.managedId = 'b13'
  element.other.managedId = 'b14'
  pretty.set('b13:dist/mixed.min.js', 'var x = a - b;\ns = "a+b";\nq(x);\n')
  pretty.set('b14:dist/mixed.min.js', 'var x = a + b;\ns = "a+b";\nq(x);\n')
  state.bundleSourcePretty = true
  for (let i = 0; i < 200 && /is-loading/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
  element._mode = 'code'
  element._query = 'a+b'
  element.render()
  const { hits: [hit] } = element._searchResults(element._railState().order).files.find(file => file.path === 'dist/mixed.min.js')
  assert.deepEqual(hit.ranges[0], [6, 9], 'the expression\'s, the first on the line')
  element._seek('dist/mixed.min.js', hit)
  const markup = renderText(element.render())
  const rows = markup.slice(markup.indexOf('aria-label="Diff"')).split('role="row"').slice(1)
  assert.match(rows[element._soughtRow.index], /<span class="diff-num">1<\/span>[^]*var x = /u, 'the expression\'s line, not the string\'s')
})

test('a file whose printed copy failed shows, and is searched, as published', async t => {
  t.after(() => { state.bundleSourcePretty = false })
  const element = view(null, [{ 'dist/failed.min.js': `var Y=1;${'q(Y);'.repeat(250)}fetch(1);\n` }, { 'dist/failed.min.js': `var X=1;${'q(X);'.repeat(250)}fetch(2);\n` }])
  element.base.managedId = 'b15'
  element.other.managedId = 'b16'
  pretty.set('b15:dist/failed.min.js', Object.assign(new Error('Comparing this file took too long.'), { status: 504 }))
  pretty.set('b16:dist/failed.min.js', 'var X = 1;\nfetch(2);\n')
  state.bundleSourcePretty = true
  element.path = 'dist/failed.min.js'
  for (let i = 0; i < 200 && /is-loading/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
  assert.match(renderText(element.render()), /is-error/u, 'its copy failed')
  element._mode = 'code'
  element._query = 'fetch('
  const found = element._searchResults(element._railState().order)
  assert.deepEqual(found.files.find(file => file.path === 'dist/failed.min.js').hits.map(hit => `${hit.sign}${hit.side}${hit.line}`), ['−a0', '+b0'])
  assert.equal(found.unsigned.has('dist/failed.min.js'), false)
})

test('a hit in a file whose printed copy is still coming is sought again in the copy once it comes', async t => {
  t.after(() => { state.bundleSourcePretty = false })
  const element = view('src/api.js', [{ 'dist/coming.min.js': `var Y=1;function q(n){return Y+n}${'q(Y);'.repeat(250)}module.exports=q;\n` },
    { 'dist/coming.min.js': `var X=1;function Z(n){return X+n}${'Z(X);'.repeat(250)}Z(1);module.exports=Z;\n` }])
  element.base.managedId = 'b17'
  element.other.managedId = 'b18'
  pretty.set('b17:dist/coming.min.js', 'var Y = 1;\nfunction q(n) {\n  return Y + n;\n}\nq(Y);\nmodule.exports = q;\n')
  pretty.set('b18:dist/coming.min.js', 'var X = 1;\nfunction Z(n) {\n  return X + n;\n}\nZ(X);\nZ(1);\nmodule.exports = Z;\n')
  state.bundleSourcePretty = true
  element._mode = 'code'
  element._query = 'Z(1)'
  element.render()
  const { hits: [hit] } = element._searchResults(element._railState().order).files.find(file => file.path === 'dist/coming.min.js')
  element._seek('dist/coming.min.js', hit)
  element.path = 'dist/coming.min.js'
  // Opened while its copies are asked for: the published diff's row, the seek kept.
  assert.match(renderText(element.render()), /is-loading/u)
  // As the view does once drawn, the row's scrolling aside (there is no DOM here).
  element._soughtRow = null
  element._scrollSought()
  assert.ok(element._sought, 'kept while the copies come')
  for (let i = 0; i < 200 && /is-loading/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
  const markup = renderText(element.render())
  const rows = markup.slice(markup.indexOf('aria-label="Diff"')).split('role="row"').slice(1)
  assert.match(rows[element._soughtRow.index], /<span class="diff-num">6<\/span>[^]*Z\(1\)/u, 'the copy\'s line 6')
  element._soughtRow = null
  element._scrollSought()
  assert.equal(element._sought, null, 'and done with once found there')
})

test('a hit in a file whose renamed names failed to hide waits, and opens at its line once they are shown', async t => {
  t.after(() => { state.bundleSourcePretty = false; element._setRenames(false) })
  const element = view('dist/unhidden.min.js', [{ 'dist/unhidden.min.js': `var Y=1;${'q(Y);'.repeat(250)}\n` }, { 'dist/unhidden.min.js': `var X=1;${'q(X);'.repeat(250)}\n` }])
  element.base.managedId = 'b19'
  element.other.managedId = 'b20'
  pretty.set('b19:dist/unhidden.min.js', 'var Y = 1;\nq(Y);\n')
  pretty.set('b20:dist/unhidden.min.js', 'var X = 1;\nq(X);\n')
  state.bundleSourcePretty = true
  for (let i = 0; i < 200 && /is-loading/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
  pretty.set('b19:dist/unhidden.min.js', Object.assign(new Error('Comparing this file took too long.'), { status: 504 }))
  element._setRenames(true)
  for (let i = 0; i < 200 && /Hiding renamed names…/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
  assert.match(renderText(element.render()), /Couldn't hide renamed names/u)
  element._mode = 'code'
  element._query = 'q(X)'
  element.render()
  const { hits: [hit] } = element._searchResults(element._railState().order).files.find(file => file.path === 'dist/unhidden.min.js')
  element._seek('dist/unhidden.min.js', hit)
  element.render()
  // As the view does once drawn, the row's scrolling aside (there is no DOM here).
  element._soughtRow = null
  element._scrollSought()
  assert.ok(element._sought, 'kept: its diff isn\'t drawn')
  element._setRenames(false)
  const markup = renderText(element.render())
  const rows = markup.slice(markup.indexOf('aria-label="Diff"')).split('role="row"').slice(1)
  assert.match(rows[element._soughtRow.index], /<span class="diff-num">2<\/span>[^]*q\(<mark class="diff-word">X/u, 'shown, at the copy\'s line 2')
})

test('however long the search\'s scan takes, each render diffs a file more, and signs its hits', t => {
  // Every reading of the clock past the budget: the scan alone outlasts it.
  let clock = 0
  t.mock.method(performance, 'now', () => (clock += 1000))
  const element = view(null, [{ 'src/one.js': 'a\nfetch(1)\n', 'src/two.js': 'b\nfetch(2)\n' }, { 'src/one.js': 'a\nfetch(10)\n', 'src/two.js': 'b\nfetch(20)\n' }])
  element._mode = 'code'
  element._query = 'fetch('
  const signs = () => element._searchResults(element._railState().order).files.map(file => file.hits.map(hit => hit.sign ?? '?').join(''))
  assert.deepEqual(signs(), ['−+', '?'], 'the first file diffed, the next left for another render')
  assert.deepEqual(signs(), ['−+', '−+'])
  clearTimeout(element._searchLater)
})

test('the one list\'s search leaves out a file it shows only the imports of: its source isn\'t there to open at', async () => {
  const { combinedDiffRows } = await import('../ui/view/bundle-compare-all.js')
  const code = view()
  const all = new (customElements.get('bundle-compare-all'))()
  for (const name of ['base', 'other', 'files', 'resolutions', 'baseName', 'otherName']) all[name] = code[name]
  all.models = combinedDiffRows(code.base, code.other, code.files).models
  all.willUpdate(new Map([['base'], ['other'], ['files'], ['resolutions']]))
  for (const element of [code, all]) {
    element._mode = 'code'
    element._query = 'export'
  }
  const found = element => element._searchResults(element._railState().order).files.map(file => file.path)
  assert.ok(found(code).includes('src/server.js'), 'a file at a time, its source shows, and is searched')
  assert.ok(!found(all).includes('src/server.js'))
  assert.ok(found(all).includes('src/api.js'))
})

test('a search hit in an unchanged run opens its fold to it, and its row is the one scrolled to', () => {
  const long = (marker, change) => Array.from({ length: 60 }, (_, i) => i === 30 ? `const needle = ${marker}` : i === 59 ? `tail ${change}` : `line ${i}`).join('\n') + '\n'
  const element = view('src/long.js', [{ 'src/long.js': long(1, 'a') }, { 'src/long.js': long(1, 'b') }])
  const numbers = markup => [...markup.slice(markup.indexOf('aria-label="Diff"')).matchAll(/<span class="diff-num">(\d+)<\/span>/gu)].map(m => Number(m[1]))
  assert.ok(!numbers(renderText(element.render())).includes(31), 'line 31 starts folded away')
  element._mode = 'code'
  element._query = 'needle'
  element.render()
  const { hits: [hit] } = element._searchResults(element._railState().order).files.find(file => file.path === 'src/long.js')
  assert.deepEqual([hit.side, hit.line, hit.sign], ['b', 30, ' '])
  element._seek('src/long.js', hit)
  const shown = numbers(renderText(element.render()))
  assert.ok(shown.includes(31), 'its fold opened to it')
  assert.ok(!shown.includes(5), 'and no further than a margin past it')
  const { index } = element._soughtRow
  const rows = renderText(element.render()).slice(renderText(element.render()).indexOf('aria-label="Diff"')).split('role="row"').slice(1)
  assert.match(rows[index], /<span class="diff-num">31<\/span>/u, 'the row scrolled to is line 31')
})

test('a search hit in a minified file opens, pretty-printed, at the line holding the same match', async t => {
  t.after(() => { state.bundleSourcePretty = false })
  const element = view('dist/search.min.js', [{ 'dist/search.min.js': `var Y=1;function q(n){return Y+n}${'q(Y);'.repeat(250)}module.exports=q;\n` },
    { 'dist/search.min.js': `var X=1;function Z(n){return X+n}${'Z(X);'.repeat(250)}Z(1);module.exports=Z;\n` }])
  element.base.managedId = 'b1'
  element.other.managedId = 'b2'
  pretty.set('b1:dist/search.min.js', 'var Y = 1;\nfunction q(n) {\n  return Y + n;\n}\nq(Y);\nmodule.exports = q;\n')
  pretty.set('b2:dist/search.min.js', 'var X = 1;\nfunction Z(n) {\n  return X + n;\n}\nZ(X);\nZ(1);\nmodule.exports = Z;\n')
  state.bundleSourcePretty = true
  for (let i = 0; i < 200 && /is-loading/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
  element._mode = 'code'
  element._query = 'Z(1)'
  element.render()
  const { hits: [hit] } = element._searchResults(element._railState().order).files.find(file => file.path === 'dist/search.min.js')
  assert.deepEqual([hit.side, hit.line, hit.sign], ['b', 0, null], 'found on the one line of the file as published, unsigned: its diff is of the copies')
  element._seek('dist/search.min.js', hit)
  const markup = renderText(element.render())
  const rows = markup.slice(markup.indexOf('aria-label="Diff"')).split('role="row"').slice(1)
  assert.match(rows[element._soughtRow.index], /<span class="diff-num">6<\/span>[^]*Z\(1\)/u, 'the pretty-printed copy\'s line 6, Z(1);')
})

test('a search hit whose match pretty-printing spaces opens at the line its first character falls on', async t => {
  t.after(() => { state.bundleSourcePretty = false })
  const element = view('dist/spaced.min.js', [{ 'dist/spaced.min.js': `var Y=1;function q(n){return Y+n}${'q(Y);'.repeat(250)}module.exports=q;\n` },
    { 'dist/spaced.min.js': `var X=1;function Z(n){return X+n}${'Z(X);'.repeat(250)}module.exports=Z;\n` }])
  element.base.managedId = 'b7'
  element.other.managedId = 'b8'
  pretty.set('b7:dist/spaced.min.js', 'var Y = 1;\nfunction q(n) {\n  return Y + n;\n}\nq(Y);\nmodule.exports = q;\n')
  pretty.set('b8:dist/spaced.min.js', 'var X = 1;\nfunction Z(n) {\n  return X + n;\n}\nZ(X);\nmodule.exports = Z;\n')
  state.bundleSourcePretty = true
  for (let i = 0; i < 200 && /is-loading/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
  element._mode = 'code'
  element._query = 'X+n'
  element.render()
  const { hits: [hit] } = element._searchResults(element._railState().order).files.find(file => file.path === 'dist/spaced.min.js')
  element._seek('dist/spaced.min.js', hit)
  const markup = renderText(element.render())
  const rows = markup.slice(markup.indexOf('aria-label="Diff"')).split('role="row"').slice(1)
  assert.match(rows[element._soughtRow.index], /<span class="diff-num">3<\/span>[^]*return [^]*X[^]* \+ n;/u, 'the copy\'s line 3, return X + n')
})

test('a repointed file stays a source view with its line links while whitespace changes are hidden', t => {
  const element = view('src/server.js')
  element._setWhitespace(true)
  t.after(() => element._setWhitespace(false))
  const markup = renderText(element.render())
  assert.match(markup, /\?disabled=false\s+aria-label=Go to line 1/u)
  assert.match(markup, /aria-label="Source"/u)
  assert.doesNotMatch(markup, /Unified<\/button>/u)
})

test('the one-list Code lists a file whose only change is a repointed import by its imports alone, counting them', async () => {
  const { combinedDiffRows } = await import('../ui/view/bundle-compare-all.js')
  const CompareAll = customElements.get('bundle-compare-all')
  const code = view()
  const all = new CompareAll()
  for (const name of ['base', 'other', 'files', 'resolutions', 'baseName', 'otherName']) all[name] = code[name]
  all.models = combinedDiffRows(code.base, code.other, code.files).models
  all.willUpdate(new Map([['base'], ['other'], ['files'], ['resolutions']]))
  const sections = Object.fromEntries(renderText(all.render()).split('<section class="bundle-compare-all-file" aria-label=').slice(1)
    .map(part => [part.slice(0, part.indexOf(' ')), part]))
  assert.match(sections['src/server.js'], /Repointed import/u)
  assert.doesNotMatch(sections['src/server.js'], /class=bundle-compare-diff-table|aria-label="Source"/u, 'not its whole source')
  assert.equal(combinedDiffRows(code.base, code.other, code.files, { resolutions: code.resolutions }).rows,
    combinedDiffRows(code.base, code.other, code.files).rows + code.resolutions.length * 2 + 1, 'its head and its imports counted')
})

test('a file\'s head tags how it reads, as the npm Overview does: as it reads now, after how it read where that differs, its controls and long lines beside that', () => {
  const code = Array.from({ length: 40 }, (_, i) => `export const value${i} = ${i}`).join('\n')
  const files = [{ 'src/ctl.js': 'const a = 1\n', 'src/same.js': 'const b = 1\n', 'src/long.js': `${code}\n`, 'src/short.js': `${code}\nconst x = '${'y'.repeat(1001)}'\n${code}\n`,
    'dist/min.js': `${code}\n`, 'dist/min.js.map': '{"version":3,"mappings":"AAAA"}\n' },
  { 'src/ctl.js': 'const a = "\u202E1"\n', 'src/same.js': 'const b = 2\n', 'src/new.js': 'const ü = 1\n', 'src/long.js': `${code}\nconst x = '${'y'.repeat(1001)}'\n${code}\n`,
    'src/short.js': `${code}\n`, 'dist/min.js': `var r=/[ \t\f]/;${'var a=1;'.repeat(200)}\n`, 'dist/min.js.map': '{"version":3,"mappings":"AACA"}\n' }]
  const rendered = path => renderText(view(path, files).render())
  const head = path => /<header class="bundle-code-main-bar bundle-compare-code-bar">([^]*?)<\/header>/u.exec(rendered(path))[1]
  const tags = markup => [...markup.matchAll(/class=npm-encoding-tag[^>]*>([^<]+)</gu)].map(m => m[1])
  const flags = markup => [...markup.matchAll(/class="?npm-flag-tag is-(\w+)"? data-tooltip=[^>]*>([^<]+)</gu)].map(([, mark, tag]) => `${tag} ${mark}`)
  assert.deepEqual(tags(head('src/ctl.js')), ['ASCII', 'UTF-8'], 'how it reads, its controls aside')
  assert.match(head('src/ctl.js'), /bundle-compare-code-readability/u)
  assert.deepEqual(flags(head('src/ctl.js')), ['Controls warn'], 'beside it')
  // Every label a minified file has, as lit-html 2's lit-html.js: a form feed
  // in a regular expression, its long lines, minified code's.
  assert.deepEqual(flags(head('dist/min.js')), ['Controls warn', 'Long lines notice'])
  assert.deepEqual(tags(head('dist/min.js')), ['ASCII', 'Minified'])
  assert.deepEqual(tags(head('src/same.js')), ['ASCII'], 'once where it reads alike')
  assert.deepEqual(tags(head('src/new.js')), ['UTF-8'], 'an added file as it reads now')
  assert.deepEqual(tags(head('src/legacy.js')), ['ASCII'], 'a removed one as it read')
  // Long lines don't take the place of how a file reads: beside it, as it reads now.
  const longLines = markup => [...markup.matchAll(/class="?npm-flag-tag is-warn"? data-tooltip=([^>]*)>Long lines</gu)].map(m => m[1])
  assert.deepEqual(longLines(head('src/long.js')), ['1 line over 1000 characters, the longest 1,013, among readable ones'])
  assert.deepEqual(tags(head('src/long.js')), ['ASCII'], 'once, read alike')
  assert.doesNotMatch(head('src/long.js'), /bundle-compare-code-readability/u)
  assert.deepEqual(longLines(head('src/short.js')), [], 'not where it had them')
  const tree = /<ul class=bundle-code-tree root[^]*<\/ul>/u.exec(rendered('src/long.js'))[0]
  const row = name => /<button type="button" class=bundle-code-tree-link[^]*?<\/button>/gu[Symbol.match](tree).find(markup => markup.includes(`data-tooltip=src/${name}.js>`))
  assert.deepEqual(flags(row('long')), ['Long lines warn'])
  assert.doesNotMatch(row('long'), /npm-encoding-tag/u, 'the tree leaving ASCII untagged')
  const minRow = /<button type="button" class=bundle-code-tree-link[^]*?<\/button>/gu[Symbol.match](tree).find(markup => markup.includes('data-tooltip=dist/min.js>'))
  assert.deepEqual(flags(minRow), ['Controls warn'], 'the tree briefer: what it warns of')
  assert.match(minRow, /npm-encoding-tag is-notice[^>]*>Minified</u)
  assert.doesNotMatch(row('ctl'), /npm-encoding-tag/u, 'its controls alone where it reads as UTF-8')
  assert.deepEqual(flags(row('ctl')), ['Controls warn'])
  // A source map tagged Map in its head, wide enough, not in the tree, where its name says so.
  assert.deepEqual(tags(head('dist/min.js.map')), ['Map'])
  const mapRow = /<button type="button" class=bundle-code-tree-link[^]*?<\/button>/gu[Symbol.match](tree).find(markup => markup.includes('data-tooltip=dist/min.js.map>'))
  assert.doesNotMatch(mapRow, /npm-encoding-tag/u)
})

test('over the package\'s package.json, its dependencies\' changes as chips under one head, each opening as the Overview\'s do, in either Code', async () => {
  const { combinedDiffRows } = await import('../ui/view/bundle-compare-all.js')
  const base = version('a', { 'package.json': '{"dependencies":{"kept":"^1.0.0","gone":"1.0.0"}}\n', 'lib/package.json': '{}\n' })
  const other = version('b', { 'package.json': '{"dependencies":{"kept":"^1.1.0"},"peerDependencies":{"fresh":"2.0.0"}}\n', 'lib/package.json': '{"a":1}\n' })
  const opened = []
  const shared = { base, other, baseName: 'a', otherName: 'b', resolutions: [],
    files: computeBundleDiff(bundleFilesAsMap(base), bundleFilesAsMap(other), () => '__own__').files,
    dependencies: { removed: [{ key: '\0gone', name: 'gone', kind: null, range: '1.0.0', opens: 'gone' }],
      added: [{ key: 'peer\0fresh', name: 'fresh', kind: 'peer', range: '2.0.0', opens: 'fresh', flags: [] }],
      changed: [{ key: '\0kept', name: 'kept', kind: null, from: '^1.0.0', to: '^1.1.0', opens: 'kept', flags: [] }] },
    openDependency: row => opened.push(row.name),
    dependencyTags: (row, kind) => [npmDependencyFlagTags(row.flags), kind === 'added' ? `[tier ${row.opens}]` : ''] }
  const element = Object.assign(new CompareCode(), shared)
  element.willUpdate(new Map([['base'], ['other'], ['files'], ['resolutions']]))
  const render = path => { element.path = path; return renderText(element.render()) }
  const pkg = render('package.json')
  assert.match(pkg, /class="bundle-compare-code-deps"[^]*<h4>Dependencies <span>1 new · 1 updated · 1 removed<\/span><\/h4>[^]*class=bundle-compare-diff-table/u, 'one head, over its diff')
  const chips = [...pkg.matchAll(/class=bundle-compare-code-dep (is-\w+) aria-label=([^@>]+?) @click=>([^]*?)<\/button>/gu)]
    .map(([, kind, label, content]) => [kind, label.trim(), content.replaceAll(/<[^>]+>/gu, '')])
  assert.deepEqual(chips, [['is-added', 'New: fresh', 'freshpeer2.0.0[tier fresh]'], ['is-changed', 'Updated: kept', 'kept^1.0.0 → ^1.1.0'], ['is-removed', 'Removed: gone', 'gone1.0.0']],
    'new, updated and removed, each its range beside its name, a peer dependency marked, and what the source tags one with')
  assert.doesNotMatch(render('lib/package.json'), /bundle-compare-code-deps/u, 'only over the package\'s own')
  // Each flagged where it calls for a look (npm-dependency-checks.js), the head counting them.
  const source = { check: 'source', label: 'non-registry', tooltip: 'From GitHub, not npm\'s registry: github:a/kept' }
  const unimported = { check: 'unimported', label: 'unimported', tooltip: 'New in b, and nothing of it imports it' }
  element.dependencies = { removed: [], added: [{ ...shared.dependencies.added[0], kind: null, flags: [unimported] }],
    changed: [{ ...shared.dependencies.changed[0], to: 'github:a/kept', flags: [source] }, { key: '\0other', name: 'other', kind: null, from: '1', to: 'github:a/other', opens: null, flags: [source] }] }
  const flagged = render('package.json')
  assert.match(flagged, /<h4>Dependencies <span>1 new · 2 updated<\/span><span class="bundle-compare-code-deps-flagged">1 unimported<\/span><span class="bundle-compare-code-deps-flagged">2 non-registry<\/span><\/h4>/u)
  assert.match(flagged, /aria-label=New: fresh[^]*>fresh<\/span><span class="bundle-compare-code-dep-range">2\.0\.0<\/span><span class=npm-dependency-flag is-unimported data-tooltip=New in b, and nothing of it imports it>unimported<\/span>/u)
  assert.match(flagged, /aria-label=Updated: kept[^]*<b>github:a\/kept<\/b><\/span><span class=npm-dependency-flag is-source data-tooltip=From GitHub, not npm's registry: github:a\/kept>non-registry</u)
  assert.match(flagged, /<span class=bundle-compare-code-dep is-changed aria-label=Updated: other>[^]*non-registry<\/span><\/span>/u, 'one opening nothing')
  element.dependencies = shared.dependencies
  // Each opens as the Overview's rows do.
  const handlers = value => Array.isArray(value) ? value.flatMap(handlers) : value?.values ? value.values.flatMap(handlers) : typeof value === 'function' ? [value] : []
  for (const click of handlers(element._dependencyChanges('package.json'))) click()
  assert.deepEqual(opened, ['fresh', 'kept', 'gone'])
  const all = Object.assign(new (customElements.get('bundle-compare-all'))(), shared)
  all.models = combinedDiffRows(base, other, shared.files).models
  all.willUpdate(new Map([['base'], ['other'], ['files'], ['resolutions']]))
  const sections = Object.fromEntries(renderText(all.render()).split('<section class="bundle-compare-all-file" aria-label=').slice(1)
    .map(part => [part.slice(0, part.indexOf(' ')), part]))
  assert.match(sections['package.json'], /class="bundle-compare-code-deps"[^]*1 new · 1 updated · 1 removed/u, 'in the one-list Code too')
  assert.doesNotMatch(sections['lib/package.json'], /bundle-compare-code-deps/u)
})

test('a file is labelled where a package starts from it, a package.json with its install scripts, and the tree tags what can\'t be read', () => {
  const base = version('a', { 'index.js': 'module.exports = 1\n', 'package.json': '{"scripts":{"preinstall":"x","prepare":"tsc","postinstall":"node a.js"}}\n', 'bin/cli.js': '1\n',
    'LICENSE-MIT': 'MIT\n' }, { main: 'index.js', license: 'MIT' })
  const other = version('b', { 'index.js': 'module.exports = 2\n', 'package.json': '{"scripts":{"postinstall":"node setup.js","prepare":"tsc -b","test":"t"}}\n', 'bin/cli.js': '2\n',
    'dist/app.min.js': `${'var a=1;'.repeat(200)}\n`, 'LICENSE-MIT': 'MIT License\n' }, { main: './index', bin: { tool: './bin/cli.js' }, license: 'MIT',
    github: { github: 'org/pkg' }, gitHead: 'b'.repeat(40) })
  const { element, render, head } = compareOf(base, other, { baseName: 'a', otherName: 'b' })
  const labels = (markup, kind) => [...markup.matchAll(new RegExp(`class="?bundle-compare-code-${kind}[^>]*>([^<]+)<`, 'gu'))].map(m => m[1])
  assert.match(head('index.js'), new RegExp(`class="bundle-code-github-link" href=https://github\\.com/org/pkg/blob/${'b'.repeat(40)}/index\\.js `, 'u'),
    'on GitHub at the commit the open version was published from')
  assert.deepEqual(labels(head('index.js'), 'entry'), ['main'], 'as require finds it')
  assert.deepEqual(labels(head('bin/cli.js'), 'entry'), ['bin'])
  assert.deepEqual(labels(head('package.json'), 'entry'), [])
  const pkg = head('package.json')
  assert.deepEqual(labels(pkg, 'install'), ['postinstall', 'preinstall'], 'what runs on install now, then what no longer does; not prepare, run only for a local or git install')
  assert.deepEqual(labels(head('LICENSE-MIT'), 'entry'), ['license'])
  assert.match(head('LICENSE-MIT'), /bundle-compare-code-entry is-license[^]*?data-tooltip=License: MIT>license/u)
  assert.match(pkg, /data-tooltip=node setup\.js, was: node a\.js>postinstall/u)
  assert.match(pkg, /bundle-compare-code-install is-dropped/u)
  const rows = Object.fromEntries([...render('index.js').matchAll(/<button type="button" class=bundle-code-tree-link[^]*?<\/button>/gu)]
    .map(([row]) => [/bundle-code-tree-name[^>]*data-tooltip=([^\s>]+)>/u.exec(row)[1], row]))
  assert.deepEqual(labels(rows['package.json'], 'install'), ['postinstall'], 'the tree tags what runs on install now')
  assert.match(rows['dist/app.min.js'], /class=npm-encoding-tag is-notice[^>]*>Minified</u)
  assert.doesNotMatch(rows['index.js'], /npm-encoding-tag|bundle-compare-code-entry/u, 'no tag for what reads as it is, and entry points in the head alone')
  // Alerts on a side's files, as Socket's on an npm version's, in the head and the tree.
  Object.assign(element, { otherAlerts: new Map([['dist/app.min.js', [{ type: 'malware' }]]]), baseAlerts: new Map([['index.js', [{ type: 'gone' }]]]),
    alertTags: alerts => alerts.map(alert => `<alert ${alert.type}>`) })
  assert.match(head('dist/app.min.js'), /<alert malware>/u)
  assert.doesNotMatch(head('index.js'), /<alert/u, 'the open one\'s alerts on a file it has')
  assert.match(render('index.js'), /<alert malware>[^]*?bundle-compare-code-letter added/u, 'in the tree too')
})

test('a file is tagged Large and Obfuscated in its head and the tree, as the npm Files list tags it: as it is now, or as it was, for one removed', () => {
  const obfuscated = Array.from({ length: 25 }, (_, i) => `var _0x${(0x1a2b + i).toString(16)}=${i};`).join('')
  const big = '// big\n'.repeat(40_000)
  const base = version('a', { 'lib/gone.js': obfuscated, 'lib/big.js': '// small\n', 'lib/plain.js': 'export const a = 1\n' })
  const other = version('b', { 'dist/payload.js': `${obfuscated}\n${big}`, 'lib/big.js': big, 'lib/plain.js': 'export const a = 2\n' })
  const { render, head } = compareOf(base, other, { baseName: 'a', otherName: 'b' })
  const flags = markup => [...markup.matchAll(/class="npm-flag-tag (is-\w+)"[^>]*>([^<]+)</gu)].map(([, mark, tag]) => `${tag} ${mark}`)
  assert.deepEqual(flags(head('dist/payload.js')), ['Large is-notice', 'Obfuscated is-warn'])
  assert.match(head('dist/payload.js'), /Obfuscated<\/span>[^]*class=npm-encoding-tag is-notice[^>]*>Minified</u, 'before how it reads')
  assert.deepEqual(flags(head('lib/big.js')), ['Large is-notice'], 'as it is now')
  assert.deepEqual(flags(head('lib/gone.js')), ['Obfuscated is-warn'], 'as it was, removed')
  assert.deepEqual(flags(head('lib/plain.js')), [])
  const rows = Object.fromEntries([...render('lib/plain.js').matchAll(/<button type="button" class=bundle-code-tree-link[^]*?<\/button>/gu)]
    .map(([row]) => [/bundle-code-tree-name[^>]*data-tooltip=([^\s>]+)>/u.exec(row)[1], row]))
  assert.deepEqual(flags(rows['dist/payload.js']), ['Large is-notice', 'Obfuscated is-warn'], 'in the tree too')
  assert.deepEqual(flags(rows['lib/gone.js']), ['Obfuscated is-warn'])
  assert.deepEqual(flags(rows['lib/plain.js']), [])
})

test('a file is labelled with what its code can run beyond itself, in its head and in the tree, a kind new since saying so', () => {
  const base = version('a', { 'index.js': 'module.exports = eval("1")\n', 'old.js': 'require("child_process")\n', 'plain.js': '1\n' }, {})
  const other = version('b', { 'index.js': 'module.exports = eval("2")\nnew Function("x")\n', 'run.js': 'require("child_process").exec("ls")\n', 'plain.js': '2\n',
    'release.js': 'execSync("npm publish")\nsend(JSON.stringify(process.env))\nreadFileSync(".npmrc")\n' }, {})
  const { render, head } = compareOf(base, other, { baseName: 'a', otherName: 'b' })
  const tags = markup => [...markup.matchAll(/class="?npm-runs-code[^>]*? data-tooltip=([^>]*)>([^<]+)</gu)].map(([, tooltip, tag]) => [tag, tooltip])
  assert.deepEqual(tags(head('index.js')), [['eval', 'Runs a string as code: eval, line 1; Function, line 2, new']],
    'one tag for a string run as code however, each way named, as it is now, what it held before not new')
  assert.deepEqual([...head('release.js').matchAll(/class="?(npm-runs-code[^"]*?)"? data-tooltip=[^>]*>([^<]+)</gu)].map(([, mark, tag]) => `${tag}: ${mark}`),
    ['credentials: npm-runs-code', 'whole env: npm-runs-code is-critical', 'publish: npm-runs-code is-critical'], 'the whole environment and publishing marked worse')
  assert.deepEqual(tags(head('run.js')), [['child_process', 'Runs other programs (child_process): line 1, new']], 'all of an added file\'s new')
  assert.deepEqual(tags(head('old.js')), [['child_process', 'Runs other programs (child_process): line 1']], 'a removed file as it was')
  assert.deepEqual(tags(head('plain.js')), [])
  const rows = Object.fromEntries([...render('index.js').matchAll(/<button type="button" class=bundle-code-tree-link[^]*?<\/button>/gu)]
    .map(([row]) => [/bundle-code-tree-name[^>]*data-tooltip=([^\s>]+)>/u.exec(row)[1], row]))
  assert.deepEqual(tags(rows['run.js']).map(([tag]) => tag), ['child_process'], 'the tree tags it too')
  assert.deepEqual(tags(rows['plain.js']), [])
})

test('a file naming an exfiltration host is tagged so in its head and the tree, a service new to it saying so', () => {
  const base = version('a', { 'lib/send.js': 'post("https://webhook.site/x")\n', 'lib/gone.js': 'bot("https://api.telegram.org/bot")\n' })
  const other = version('b', { 'lib/send.js': 'post("https://webhook.site/x")\nbot("https://api.telegram.org/bot")\n' })
  const { render, head } = compareOf(base, other, { baseName: 'a', otherName: 'b' })
  const tags = markup => [...markup.matchAll(/class="npm-exfiltration" data-tooltip=([^>]*)>Exfiltration</gu)].map(m => m[1])
  assert.deepEqual(tags(head('lib/send.js')), ['Names a host malicious packages send what they take to: webhook.site (line 1), Telegram (line 2, new)'])
  assert.deepEqual(tags(head('lib/gone.js')), ['Names a host malicious packages send what they take to: Telegram (line 1)'], 'a removed file as it was')
  const row = /<button type="button" class=bundle-code-tree-link[^]*?<\/button>/gu[Symbol.match](render('lib/send.js')).find(markup => markup.includes('data-tooltip=lib/send.js>'))
  assert.equal(tags(row).length, 1, 'in the tree too')
})

test('a file whose whitespace changes mix kinds of blank is diffed as it is while whitespace changes are hidden, its toggle off', async t => {
  const tabbed = [{ 'src/tabs.js': '  a()\n  b()\n' }, { 'src/tabs.js': '\ta()\n\tb()\n' }]
  const spaced = [{ 'src/spaces.js': '  a()\n' }, { 'src/spaces.js': '    a()\n' }]
  const toggle = markup => /<button type="button" class="bundle-compare-code-toggle" aria-pressed=(\w+) aria-disabled=(\w*)\s*aria-label=([^>]*?) data-tooltip/u.exec(markup)
  const shownAll = renderText(view('src/tabs.js', tabbed).render())
  assert.equal(toggle(shownAll), null, 'not offered while whitespace changes show, as it may hide none here')
  const element = view('src/tabs.js', tabbed)
  element._setWhitespace(true)
  t.after(() => element._setWhitespace(false))
  const markup = renderText(element.render())
  assert.match(markup, /class=bundle-compare-diff-table/u, 'its whitespace changes show')
  assert.doesNotMatch(markup, /Only whitespace changed/u)
  assert.deepEqual(toggle(markup).slice(1), ['false', 'true', 'Its whitespace changes mix spaces with tabs or other blanks, so all of them show'])
  // A run mixing tabs and spaces made longer mixes kinds too.
  const runs = [{ 'src/runs.js': '\t  a()\n' }, { 'src/runs.js': '\t    a()\n' }]
  const run = renderText(view('src/runs.js', runs).render())
  assert.match(run, /class=bundle-compare-diff-table/u)
  assert.deepEqual(toggle(run).slice(1), ['false', 'true', 'Its whitespace changes mix spaces with tabs or other blanks, so all of them show'])
  const plain = renderText(view('src/spaces.js', spaced).render())
  assert.match(plain, /Only whitespace changed in this file/u, 'one only re-indented hides them')
  assert.deepEqual(toggle(plain).slice(1, 3), ['true', ''])
  const { combinedDiffRows } = await import('../ui/view/bundle-compare-all.js')
  const CompareAll = customElements.get('bundle-compare-all')
  const code = view(null, [{ ...tabbed[0], ...spaced[0] }, { ...tabbed[1], ...spaced[1] }])
  const all = new CompareAll()
  for (const name of ['base', 'other', 'files', 'baseName', 'otherName']) all[name] = code[name]
  all.models = combinedDiffRows(code.base, code.other, code.files).models
  all.willUpdate(new Map([['base'], ['other'], ['files']]))
  const sections = Object.fromEntries([...renderText(all.render()).matchAll(/<section class="bundle-compare-all-file" aria-label=([^\s>]+) data-path=[^\s>]+>([^]*?)<\/section>/gu)].map(m => [m[1], m[2]]))
  assert.match(sections['src/tabs.js'], /aria-disabled=true/u, 'the Diff view marks it in its head')
  assert.match(sections['src/tabs.js'], /class=bundle-compare-diff-table/u)
  assert.doesNotMatch(sections['src/spaces.js'], /aria-disabled|bundle-compare-diff-table/u)
})

test('Hide whitespace changes is offered only where it hides one, while they show and while they are hidden', async t => {
  const offered = markup => /aria-label=Hide whitespace changes/u.test(markup)
  const files = [{ 'src/spaces.js': '  a()\n', 'src/eol.js': 'a()', 'src/old.js': 'x\n' }, { 'src/spaces.js': '    a()\n', 'src/eol.js': 'a()\n', 'src/new.js': 'x\n' }]
  const shown = path => renderText(view(path, files).render())
  assert.ok(!offered(shown('src/api.js')), 'not for a change of more than whitespace')
  assert.ok(!offered(shown('src/features/search.js')), 'nor for an added file')
  assert.ok(offered(shown('src/spaces.js')), 'for one re-indented')
  assert.ok(offered(shown('src/eol.js')), 'and for a newline added at the end, which diff -w ignores too')
  const element = view('src/api.js', files)
  element._setWhitespace(true)
  t.after(() => element._setWhitespace(false))
  const hidden = path => renderText(view(path, files).render())
  const changed = hidden('src/api.js')
  assert.ok(!offered(changed), 'nor while they are hidden, where hiding them hides none')
  assert.match(changed, /class=bundle-compare-diff-table/u)
  const spaces = hidden('src/spaces.js')
  assert.match(spaces, /aria-pressed=true aria-disabled=\s*aria-label=Hide whitespace changes/u, 'on, to turn off, where it hides one')
  assert.match(spaces, /Only whitespace changed in this file\.[^]*?Show whitespace changes/u)
  const pure = hidden('src/new.js')
  assert.match(pure, /Renamed without changes\./u)
  assert.ok(!offered(pure))
  assert.doesNotMatch(pure, /Show whitespace changes/u, 'a pure rename hides no whitespace to show')
  // The Diff view's bar, for any file it lists.
  const { combinedDiffRows } = await import('../ui/view/bundle-compare-all.js')
  const CompareAll = customElements.get('bundle-compare-all')
  const bar = (extra, query = '') => {
    const code = view(null, extra)
    const all = new CompareAll()
    for (const name of ['base', 'other', 'files', 'baseName', 'otherName']) all[name] = code[name]
    all.models = combinedDiffRows(code.base, code.other, code.files).models
    all.willUpdate(new Map([['base'], ['other'], ['files']]))
    all._query = query
    const markup = renderText(all.render())
    return markup.slice(markup.indexOf('bundle-compare-code-bar'), markup.indexOf('bundle-compare-diff"'))
  }
  assert.ok(!offered(bar()), 'none of its files hides one')
  assert.ok(offered(bar(files)))
  assert.match(bar(files, 'spaces'), /aria-pressed=true aria-disabled=\s*aria-label=Hide whitespace changes/u, 'there to turn off where it hides every change listed')
})

test('with renamed names hidden, Hide whitespace changes is offered where the server\'s diff hides one', async t => {
  t.after(() => { state.bundleSourcePretty = false; element._setRenames(false); element._setWhitespace(false) })
  const element = view('dist/ws.min.js', [{ 'dist/ws.min.js': `(function(){var Y=1;${'q(Y);'.repeat(250)}})();\n` },
    { 'dist/ws.min.js': `(function(){var X=1;${'q(X);'.repeat(250)}})();\n` }])
  element.base.managedId = 'b9'
  element.other.managedId = 'b10'
  pretty.set('b9:dist/ws.min.js', '(function () {\n  var Y = 1;\n  q(Y);\n  q(Y);\n})();\n')
  pretty.set('b10:dist/ws.min.js', '(function () {\n  var X = 1;\n    q(X);\n  q(X);\n})();\n')
  state.bundleSourcePretty = true
  for (let i = 0; i < 200 && /is-loading/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
  element._setRenames(true)
  const settled = async () => {
    for (let i = 0; i < 200 && /Hiding renamed names…/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
    return renderText(element.render())
  }
  const shown = await settled()
  assert.match(shown, /var X = 1;/u, 'renamed names hidden')
  assert.match(shown, /aria-pressed=false aria-disabled=\s*aria-label=Hide whitespace changes/u)
  element._setWhitespace(true)
  const hidden = await settled()
  assert.equal(renameDiffs.at(-1).ignoreWhitespace, true, 'the server diffs them with whitespace changes hidden')
  assert.match(hidden, /Only whitespace and renamed names changed in this file\./u)
  assert.match(hidden, /aria-pressed=true aria-disabled=\s*aria-label=Hide whitespace changes/u, 'still there to turn off')
})

test('hidden whitespace changes are how much whitespace a line has alone: blanks put between other characters, or taken from there, show', t => {
  const files = [{ 'src/run.js': 'exec("rm -rf /tmp/x")\n', 'src/ret.js': 'function f(x) {\n  return x\n}\n', 'src/indent.js': 'if (a) {\n  b()\n}\n' },
    { 'src/run.js': 'exec("rm -rf / tmp/x")\n', 'src/ret.js': 'function f(x) {\n  returnx\n}\n', 'src/indent.js': 'if (a) {\n    b()\n}\n' }]
  const element = view('src/run.js', files)
  element._setWhitespace(true)
  t.after(() => element._setWhitespace(false))
  for (const path of ['src/run.js', 'src/ret.js']) {
    const markup = renderText(view(path, files).render())
    assert.match(markup, /class=diff-row del[^]*class=diff-row add/u, `${path}: its change shows`)
    assert.doesNotMatch(markup, /Only whitespace changed|aria-label=Hide whitespace changes/u, `${path}: and nothing is hidden`)
  }
  const indent = renderText(view('src/indent.js', files).render())
  assert.match(indent, /Only whitespace changed in this file\./u, 'a line re-indented reads as unchanged')
  assert.match(indent, /data-tooltip=Hide whitespace changes, in code whose whitespace means nothing[^>]*: a line re-indented/u, 'as the toggle says')
})

test('whitespace changes all show in a file whose whitespace may mean something, hiding them not offered there', async t => {
  const files = [{ 'tools/gen.py': 'if a:\n    b()\n', 'tools/same.py': 'a = 1\n' }, { 'tools/gen.py': 'if a:\n        b()\n', 'tools/same.py': 'a = 2\n' }]
  const off = renderText(view('tools/gen.py', files).render())
  assert.match(off, /class=diff-row del[^]*class=diff-row add/u)
  assert.doesNotMatch(off, /aria-label=(?:Hide whitespace changes|Whitespace changes are hidden only)/u, 'not offered: it may hide none here')
  const element = view('tools/gen.py', files)
  element._setWhitespace(true)
  t.after(() => element._setWhitespace(false))
  const on = renderText(element.render())
  assert.match(on, /class=diff-row del[^]*class=diff-row add/u, 'its re-indented line shows while whitespace changes are hidden')
  assert.doesNotMatch(on, /Only whitespace changed/u)
  assert.match(on, /aria-pressed=false aria-disabled=true\s*aria-label=Whitespace changes are hidden only in code whose whitespace means nothing, as JavaScript, CSS or JSON: all of this file's show/u, 'its toggle off, saying why')
  assert.doesNotMatch(renderText(view('tools/same.py', files).render()), /aria-label=(?:Hide whitespace changes|Whitespace changes are hidden only)/u, 'nor told where hiding would hide none')
  const script = [{ 'bin/gen': '#!/usr/bin/env python3\nif a:\n    b()\n' }, { 'bin/gen': '#!/usr/bin/env python3\nif a:\n        b()\n' }]
  const gen = renderText(view('bin/gen', script).render())
  assert.match(gen, /aria-label=Whitespace changes are hidden only/u, 'an extensionless script alike, unless its #! line names Node or a shell')
  assert.match(gen, /class=diff-row del[^]*class=diff-row add/u)
  const node = [{ 'bin/run': '#!/usr/bin/env node\nif (a) {\n  b()\n}\n' }, { 'bin/run': '#!/usr/bin/env node\nif (a) {\n    b()\n}\n' }]
  assert.match(renderText(view('bin/run', node).render()), /Only whitespace changed in this file\./u, 'one whose #! line names Node hides them')
  const { combinedDiffRows } = await import('../ui/view/bundle-compare-all.js')
  const code = view(null, files)
  const all = new (customElements.get('bundle-compare-all'))()
  for (const name of ['base', 'other', 'files', 'baseName', 'otherName']) all[name] = code[name]
  all.models = combinedDiffRows(code.base, code.other, code.files).models
  all.willUpdate(new Map([['base'], ['other'], ['files']]))
  const sections = Object.fromEntries([...renderText(all.render()).matchAll(/<section class="bundle-compare-all-file" aria-label=([^\s>]+) data-path=[^\s>]+>([^]*?)<\/section>/gu)].map(m => [m[1], m[2]]))
  assert.match(sections['tools/gen.py'], /aria-disabled=true\s*aria-label=Whitespace changes are hidden only/u, 'the Diff view says so in its head')
  assert.match(sections['tools/gen.py'], /class=bundle-compare-diff-table/u)
})

test('in a stasis bundle, whether whitespace may be hidden is told by the format it records for the file, over its name', t => {
  const reindent = ['if (a) {\n  b()\n}\n', 'if (a) {\n    b()\n}\n']
  const files = [{ 'CMakeLists.txt': reindent[0], 'src/data.js': reindent[0] }, { 'CMakeLists.txt': reindent[1], 'src/data.js': reindent[1] }]
  const formatted = path => {
    const element = view(path, files)
    for (const side of [element.base, element.other]) {
      side.bundle.formats.set('CMakeLists.txt', 'cmake')
      side.bundle.formats.set('src/data.js', 'resource')
    }
    return renderText(element.render())
  }
  const element = view('CMakeLists.txt', files)
  element._setWhitespace(true)
  t.after(() => element._setWhitespace(false))
  assert.match(formatted('CMakeLists.txt'), /Only whitespace changed in this file\./u, 'CMake, which a .txt name alone would not say')
  const data = formatted('src/data.js')
  assert.match(data, /class=diff-row del[^]*class=diff-row add/u, 'a .js name carried as a resource shows its whitespace changes')
  assert.match(data, /aria-disabled=true\s*aria-label=Whitespace changes are hidden only/u)
  assert.match(renderText(view('src/data.js', files).render()), /Only whitespace changed in this file\./u, 'by its name, where the bundle records no format')
})

test('a file whose bytes are the same, its record in the stasis bundle changed, is listed, saying how', () => {
  const same = { 'src/data.js': 'export const data = 1\n', 'bin/run': 'echo run\n', 'src/main.js': 'export default 1\n', 'src/asset.js': 'export {}\n' }
  const recorded = path => {
    const element = view(path, [same, same])
    const { base, other } = element
    base.bundle.formats.set('src/data.js', 'resource')
    base.bundle.formats.set('src/asset.js', 'resource')
    other.bundle.formats.set('src/data.js', 'module')
    other.bundle.executable.add('bin/run')
    other.bundle.entries.add('src/main.js')
    element.files = computeBundleDiff(bundleFilesAsMap(base), bundleFilesAsMap(other), file => /^node_modules\/[^/]+/u.exec(file)?.[0] ?? '__own__', undefined,
      [bundleFileMeta(base), bundleFileMeta(other)]).files
    element.willUpdate(new Map([['files']]))
    return renderText(element.render())
  }
  const data = recorded('src/data.js')
  const marks = fileMarks(data)
  for (const path of ['src/data.js', 'bin/run', 'src/main.js', 'src/asset.js']) assert.deepEqual(marks[path], ['changed'], `${path}: listed as changed`)
  assert.match(data, /bundle-compare-code-meta"?>resource → module</u, 'in its head, with no tooltip')
  assert.match(data, /The contents are the same\. The bundle loads it as module, as resource before, carried as data before, run as code now\./u)
  assert.match(data, /bundle-code-tree-link[^]*?bundle-compare-code-meta"?>format<\/span>\s*<span class="bundle-compare-code-line-counts unchanged" aria-label="No line changes">=/u,
    'and its tree row, its lines the same')
  assert.match(recorded('bin/run'), /The contents are the same\. It is now executable\.[^]*/u)
  assert.match(recorded('bin/run'), /bundle-compare-code-meta"?>\+x</u)
  assert.match(recorded('src/main.js'), /bundle-compare-code-meta"?>new entry</u)
  assert.match(recorded('src/main.js'), /It is now an entry point of the bundle\./u)
  // A resource whose format is dropped: stasis runs a file with none as code.
  const dropped = recorded('src/asset.js')
  assert.match(dropped, /bundle-compare-code-meta"?>resource → none</u)
  assert.match(dropped, /The contents are the same\. The bundle records no format for it now, resource before, carried as data before, run as code now\./u)
})

test('a large file whose bytes are the same, its record changed, says so without asking to diff it', async () => {
  const { combinedDiffRows } = await import('../ui/view/bundle-compare-all.js')
  const big = { 'src/big.js': 'x\n'.repeat(60_000) }
  const element = view('src/big.js', [big, big])
  const { base, other } = element
  base.bundle.formats.set('src/big.js', 'resource')
  other.bundle.formats.set('src/big.js', 'module')
  element.files = computeBundleDiff(bundleFilesAsMap(base), bundleFilesAsMap(other), () => '__own__', undefined, [bundleFileMeta(base), bundleFileMeta(other)]).files
  element.willUpdate(new Map([['files']]))
  const markup = renderText(element.render())
  assert.match(markup, /The contents are the same\. The bundle loads it as module, as resource before, carried as data before, run as code now\./u)
  assert.doesNotMatch(markup, /This diff is large/u)
  assert.ok(Number.isFinite(combinedDiffRows(base, other, element.files).rows), 'and the one list is not too large for it')
})

test('Previous and Next file step through the files in the order the file menu lists them, filtered or not', () => {
  const files = ['a.js', 'a/b.js', 'Z.js', 'src/z/y.js', 'src/b.js', 'lib/x/y/z.js']
  const element = view(null, [Object.fromEntries(files.map(path => [path, '1'])), Object.fromEntries(files.map(path => [path, '2']))])
  const menu = () => [...renderText(element.render()).matchAll(/<button type="button" class=bundle-code-tree-link[^]*?<\/button>/gu)]
    .map(([row]) => /bundle-code-tree-name[^>]*data-tooltip=([^\s>]+)>/u.exec(row)[1])
  const listed = menu()
  assert.deepEqual(element._order, listed)
  assert.deepEqual(listed.slice(0, 3), ['a/b.js', 'assets/logo.png', 'lib/x/y/z.js'], 'directories first, as the menu lists them')
  element._query = 'src/'
  const narrowed = menu()
  assert.deepEqual(element._order, narrowed, 'and as a search narrows it')
  assert.ok(narrowed.length > 0 && narrowed.length < listed.length, narrowed.join())
})

test('a specifier repointed under several conditions links and marks every line that imports it', () => {
  const source = "import pick from 'lodash/pick'\nexport const start = () => pick\nconst again = require('lodash/pick')\n"
  const side = (integrity, target) => ({ integrity, kind: 'stasis', bundle: new Bundle({
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { 'src/server.js': source } }]]),
    imports: new Map(['node, import', 'node, require'].map(conditions => [conditions, new Map([['src/server.js', new Map([['lodash/pick', target]])]])])),
  }) })
  const base = side('base', 'node_modules/lodash/pick.cjs'), other = side('other', 'node_modules/lodash/pick.js')
  const element = new CompareCode()
  Object.assign(element, { base, other, path: 'src/server.js',
    files: computeBundleDiff(bundleFilesAsMap(base), bundleFilesAsMap(other), () => '__own__').files,
    resolutions: computeResolutionDiff(bundleCompareResolutions(base), bundleCompareResolutions(other)).changed })
  element.willUpdate(new Map([['base'], ['other'], ['files'], ['resolutions']]))
  const markup = renderText(element.render())
  const panel = markup.slice(0, markup.indexOf('aria-label="Source"'))
  assert.equal([...panel.matchAll(/aria-label=Go to line 1 @click/gu)].length, 2, 'each condition set links the first import')
  assert.equal([...panel.matchAll(/aria-label=Go to line 3 @click/gu)].length, 2, 'and the second')
  const marked = [...markup.matchAll(/class=diff-row ctx is-import role="row" data-line=(\d+)>/gu)].map(m => m[1])
  assert.deepEqual(marked, ['1', '3'])
})

test('an importer only one bundle carries is highlighted under that bundle', () => {
  const element = view()
  assert.equal(element._textSide('src/legacy.js'), element.base)
  assert.equal(element._textSide('src/features/search.js'), element.other)
  assert.equal(element._textSide('src/api.js'), element.other)
})

// Each file row's line counts, from the tree's markup: what sits between its
// name and its letter, its spans' classes kept (`class=del empty` is unseen).
const rowCounts = markup => Object.fromEntries([...markup.matchAll(/<button type="button" class=bundle-code-tree-link[^]*?<\/button>/gu)].map(([row]) => [
  /bundle-code-tree-name[^>]*data-tooltip=([^\s>]+)>/u.exec(row)[1],
  /class="bundle-compare-code-line-counts[^]*?(?=<span class=(?:"|)bundle-compare-code-letter)/u.exec(row)?.[0].replaceAll(/\s+/gu, ' ').trim() ?? null]))

test('the tree counts each file\'s lines added and removed before its letter, an added file\'s −0 unseen', () => {
  const renamed = [{ 'src/util.js': 'export const u = 1\nexport const v = 2\n', 'src/same.js': 'x\n' },
    { 'lib/util.ts': 'export const u: number = 1\nexport const v = 2\n', 'lib/same.js': 'x\n' }]
  const counts = rowCounts(renderText(view(null, renamed).render()))
  assert.match(counts['src/api.js'], /class=add>\+1<\/span> <span class=del>−1<\/span>/u, 'modified')
  assert.match(counts['src/features/search.js'], /class=add>\+1<\/span> <span class=del empty>−0<\/span>/u, 'added: its −0 keeps its room unseen')
  assert.match(counts['src/legacy.js'], /class=add>\+0<\/span> <span class=del>−1<\/span>/u, 'removed')
  assert.match(counts['lib/util.ts'], /class=add>\+1<\/span> <span class=del>−1<\/span>/u, 'renamed and modified, against its old contents')
  assert.match(counts['lib/same.js'], /unchanged" aria-label="No line changes">=/u, 'renamed as it was')
  assert.equal(counts['assets/logo.png'], null, 'not text')
  assert.equal(counts['src/server.js'], null, 'its imports repointed alone')
})

test('a long tree counts its lines a little at a time, so it paints at once and fills in', t => {
  const all = rowCounts(renderText(view().render()))
  const element = view()
  // Every count outlasts the budget.
  let now = 0
  t.mock.method(performance, 'now', () => (now += 40))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const update = t.mock.method(element, 'requestUpdate', () => {})
  renderText(element.render())
  assert.equal(element._counted.size, 1, 'the first file is counted, then the budget is spent')
  t.mock.timers.tick(0)
  assert.equal(update.mock.callCount(), 1, 'another render is asked for, once')
  for (let i = 0; i < 20; i++) renderText(element.render())
  assert.deepEqual(rowCounts(renderText(element.render())), all, 'filled in, as counted at once')
})

test('a renamed file lists once at its new path, diffed against its old one; a pure rename says so', () => {
  const renamed = [{ 'src/util.js': 'export const u = 1\nexport const v = 2\n' }, { 'lib/util.ts': 'export const u: number = 1\nexport const v = 2\n' }]
  const markup = renderText(view(null, renamed).render())
  const marks = fileMarks(markup)
  assert.deepEqual(marks['lib/util.ts'], ['renamed'])
  assert.equal(marks['src/util.js'], undefined, 'not also removed')
  assert.match(markup, /class=bundle-compare-code-letter renamed\s+data-tooltip=Renamed and modified from src\/util\.js>→</u)
  assert.match(markup, />util\.ts<\/span>\s*<span class="bundle-compare-code-oldname"[^>]*>← src\/util\.js</u, 'the tree shows the old name too')
  const diff = renderText(view('lib/util.ts', renamed).render())
  assert.match(diff, /bundle-compare-code-pill renamed>Renamed/u)
  assert.match(diff, /data-tooltip=src\/util\.js → lib\/util\.ts>\{<span class="bundle-compare-rename-from">src\/util\.js<\/span> → <span class="bundle-compare-rename-to">lib\/util\.ts<\/span>\}</u,
    'the old part red, the new green')
  assert.match(diff, /class="add">\+1<\/span><span class="del">−1/u, 'the old contents are the before side')
  const pure = renderText(view('lib/same.js', [{ 'src/same.js': 'x\n' }, { 'lib/same.js': 'x\n' }]).render())
  assert.match(pure, /Renamed without changes\./u)
  assert.match(pure, /class=bundle-compare-code-letter renamed pure\s+data-tooltip=Renamed from src\/same\.js>→</u, 'a pure rename reads blue')
  assert.match(pure, /class=bundle-compare-code-pill renamed pure>Renamed/u)
  const ext = renderText(view(null, [{ 'src/a.js': 'x\n' }, { 'src/a.ts': 'x\n' }]).render())
  assert.match(ext, />a\.ts<\/span>\s*<span class="bundle-compare-code-oldname"[^>]*>← a\.js</u, 'the old name, whole')
  const bar = renderText(view('src/a.ts', [{ 'src/a.js': 'x\n' }, { 'src/a.ts': 'x\n' }]).render())
  assert.match(bar, />src\/a\{<span class="bundle-compare-rename-from">\.js<\/span> → <span class="bundle-compare-rename-to">\.ts<\/span>\}</u,
    'the bar narrows an extension change to the extension')
})

test('a renamed file modified too shows under Modified as well as Renamed; a pure rename under Renamed alone', () => {
  const both = [{ 'src/util.js': 'a\n', 'src/same.js': 'x\n' }, { 'lib/util.js': 'b\n', 'lib/same.js': 'x\n' }]
  const shown = (...hidden) => {
    const element = view(null, both)
    for (const kind of hidden) element._toggleKind(kind)
    return Object.keys(fileMarks(renderText(element.render()))).filter(path => path.startsWith('lib/'))
  }
  assert.deepEqual(shown('renamed'), ['lib/util.js'])
  assert.deepEqual(shown('changed'), ['lib/same.js', 'lib/util.js'])
  assert.deepEqual(shown('changed', 'renamed'), [])
})

test('a renamed file whose contents are the same but whose import was repointed reads as its source, its import marked', () => {
  const source = "import pick from 'lodash/pick'\nexport const start = () => pick\n"
  const side = (integrity, parent, target) => ({ integrity, kind: 'stasis', bundle: new Bundle({
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { [parent]: source } }]]),
    imports: new Map([['node, import', new Map([[parent, new Map([['lodash/pick', target]])]])]]),
  }) })
  const base = side('base', 'src/server.js', 'node_modules/lodash/pick.cjs'), other = side('other', 'lib/server.js', 'node_modules/lodash/pick.js')
  const files = computeBundleDiff(bundleFilesAsMap(base), bundleFilesAsMap(other), () => '__own__').files
  const element = new CompareCode()
  Object.assign(element, { base, other, path: 'lib/server.js', files,
    resolutions: computeResolutionDiff(bundleCompareResolutions(base), bundleCompareResolutions(other),
      new Map(files.changed.map(row => [row.basePath, row.path]))).changed })
  element.willUpdate(new Map([['base'], ['other'], ['files'], ['resolutions']]))
  const markup = renderText(element.render())
  assert.deepEqual(fileMarks(markup)['lib/server.js'], ['repointed', 'renamed'])
  assert.doesNotMatch(markup, /Renamed without changes/u)
  assert.match(markup, /class=diff-row ctx is-import role="row" data-line=1>/u)
  assert.doesNotMatch(markup, /Unified<\/button>/u, 'no diff layout to choose')
})

test('a renamed file whose contents are the same, its import repointed and its record changed, says how its record changed, in Code and in the one list', async () => {
  const { combinedDiffRows } = await import('../ui/view/bundle-compare-all.js')
  const source = "import pick from 'lodash/pick'\nexport const start = () => pick\n"
  const side = (integrity, parent, target, format) => ({ integrity, kind: 'stasis', bundle: new Bundle({
    modules: new Map([['.', { name: 'app', version: '1.0.0', files: { [parent]: source } }]]),
    imports: new Map([['node, import', new Map([[parent, new Map([['lodash/pick', target]])]])]]), formats: new Map([[parent, format]]),
  }) })
  const base = side('base', 'src/server.js', 'node_modules/lodash/pick.cjs', 'resource'), other = side('other', 'lib/server.js', 'node_modules/lodash/pick.js', 'module')
  const files = computeBundleDiff(bundleFilesAsMap(base), bundleFilesAsMap(other), () => '__own__', undefined, [bundleFileMeta(base), bundleFileMeta(other)]).files
  const shared = { base, other, files, baseName: 'a', otherName: 'b',
    resolutions: computeResolutionDiff(bundleCompareResolutions(base), bundleCompareResolutions(other), new Map(files.changed.map(row => [row.basePath, row.path]))).changed }
  const said = /Renamed, its contents the same\. The bundle loads it as module, as resource before, carried as data before, run as code now\./u
  const element = Object.assign(new CompareCode(), shared, { path: 'lib/server.js' })
  element.willUpdate(new Map([['base'], ['other'], ['files'], ['resolutions']]))
  const markup = renderText(element.render())
  assert.match(markup, said)
  assert.match(markup, /Repointed import/u, 'its import listed too')
  const all = Object.assign(new (customElements.get('bundle-compare-all'))(), shared)
  all.models = combinedDiffRows(base, other, files).models
  all.willUpdate(new Map([['base'], ['other'], ['files'], ['resolutions']]))
  const list = renderText(all.render())
  assert.match(list, said, 'in the one list')
  assert.match(list, /Repointed import/u)
})

test('the Diff view lists every changed file\'s diff in one list, in its rail\'s order, and counts the rows it would show', async () => {
  const { COMBINED_DIFF_MAX, combinedDiffRows } = await import('../ui/view/bundle-compare-all.js')
  const CompareAll = customElements.get('bundle-compare-all')
  const code = view()
  const all = new CompareAll()
  for (const name of ['base', 'other', 'files', 'baseName', 'otherName']) all[name] = code[name]
  const counted = combinedDiffRows(code.base, code.other, code.files)
  all.models = counted.models
  all.willUpdate(new Map([['base'], ['other'], ['files']]))
  const markup = renderText(all.render())
  const heads = [...markup.matchAll(/<section class="bundle-compare-all-file" aria-label=([^\s>]+) data-path=\1>/gu)].map(m => m[1])
  assert.deepEqual(heads, ['assets/logo.png', 'node_modules/left-pad/index.js', 'node_modules/zod/index.js', 'src/features/search.js', 'src/api.js', 'src/legacy.js'],
    'every added, removed and changed file, as the rail lists them; a repointed importer has no text that changed')
  const rail = [...markup.matchAll(/<button type="button" class=bundle-code-tree-link[^]*?<\/button>/gu)].map(([row]) => /bundle-code-tree-name[^>]*data-tooltip=([^\s>]+)>/u.exec(row)[1])
  assert.deepEqual(rail, heads, 'the rail lists them beside the list')
  assert.match(markup, /6 files changed/u)
  assert.doesNotMatch(markup, /aria-label="Hide renamed names"/u, 'its JavaScript files, an author\'s names in them, offer no renamed names hidden')
  assert.match(markup, /Binary file changed/u)
  assert.equal([...markup.matchAll(/class=bundle-compare-diff-table/gu)].length, 5, 'a diff for every text file')
  assert.ok(counted.rows > heads.length && counted.rows < COMBINED_DIFF_MAX)
  assert.deepEqual([...counted.models.keys()].toSorted(), heads.filter(path => path !== 'assets/logo.png').toSorted(), 'the line models found counting')
  // Counted only until it passes the limit; two rows a file at least, so too
  // many files for it are told without a diff.
  const capped = combinedDiffRows(code.base, code.other, code.files, { max: 13 })
  assert.ok(capped.rows >= 13 && Number.isFinite(capped.rows), `${capped.rows}`)
  assert.equal(combinedDiffRows(code.base, code.other, code.files, { max: 12 }).rows, Infinity)
})

test('a diff shows control characters as boxes, and a CRLF\'s CR only where it is what changed', () => {
  const before = 'const a = 1\r\nconst b = "\u001B"\r\nconst c = 3\r\n'
  const after = 'const a = 1\nconst b = "\u001B"\r\nconst c = 4\r\n'
  const markup = renderText(view('src/eol.js', [{ 'src/eol.js': before }, { 'src/eol.js': after }]).render())
  const rows = Object.groupBy([...markup.matchAll(/<div class="?diff-row (\w+)[^]*?<\/div>/gu)], ([, kind]) => kind)
  const boxes = row => [...row[0].matchAll(/class="code-control" data-tooltip=[^>]*>(\w+)</gu)].map(m => m[1])
  assert.deepEqual(rows.del.map(boxes), [['CR'], []], 'the CR a line lost shows, not the one both sides end a line with')
  assert.deepEqual(rows.add.map(boxes), [[], []])
  assert.deepEqual(rows.ctx.map(boxes), [['ESC']])
})

test('a rename diff that failed for a reason that may pass is asked for again when renamed names are hidden again', async t => {
  t.after(() => { state.bundleSourcePretty = false; element._setRenames(false) })
  const element = view('dist/busy.min.js', [{ 'dist/busy.min.js': `var Y=1;${'q(Y);'.repeat(250)}\n` }, { 'dist/busy.min.js': `var X=1;${'q(X);'.repeat(250)}\n` }])
  element.base.managedId = 'b9'
  element.other.managedId = 'b10'
  pretty.set('b9:dist/busy.min.js', 'var Y = 1;\nq(Y);\nmodule.exports = Y;\n')
  pretty.set('b10:dist/busy.min.js', 'var X = 1;\nq(X);\nmodule.exports = X;\n')
  state.bundleSourcePretty = true
  for (let i = 0; i < 200 && /is-loading/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
  const settle = async () => { for (let i = 0; i < 200 && /Hiding renamed names…/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) }) }
  pretty.set('b9:dist/busy.min.js', Object.assign(new Error('Too many files are being compared. Try again shortly.'), { status: 429 }))
  element._setRenames(true)
  await settle()
  assert.match(renderText(element.render()), /Couldn't hide renamed names: Too many files are being compared/u)
  pretty.set('b9:dist/busy.min.js', 'var Y = 1;\nq(Y);\nmodule.exports = Y;\n')
  assert.match(renderText(element.render()), /Couldn't hide renamed names/u, 'kept while shown, not asked for on every paint')
  element._setRenames(false)
  element._setRenames(true)
  await settle()
  const shown = renderText(element.render())
  assert.doesNotMatch(shown, /Couldn't hide renamed names/u)
  assert.match(shown, /Only renamed names changed in this file\./u)
})

test('a diff the server answers for other files than those asked about, or of other copies than those drawn, shows the names, and is asked for again', async t => {
  t.after(() => { state.bundleSourcePretty = false; element._setRenames(false); misanswered.clear() })
  const element = view('dist/told.min.js', [{ 'dist/told.min.js': `var Y=1;${'q(Y);'.repeat(250)}f(1);\n` }, { 'dist/told.min.js': `var X=1;${'q(X);'.repeat(250)}f(2);\n` }])
  element.base.managedId = 'b11'
  element.other.managedId = 'b12'
  pretty.set('b11:dist/told.min.js', 'var Y = 1;\nq(Y);\nf(1);\n')
  pretty.set('b12:dist/told.min.js', 'var X = 1;\nq(X);\nf(2);\n')
  state.bundleSourcePretty = true
  for (let i = 0; i < 200 && /is-loading/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
  const settle = async () => { for (let i = 0; i < 200 && /Hiding renamed names…/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) }) }
  // The answer of another file's diff, or of another copy of this one: drawn, either might hide a change.
  for (const told of ['b11', 'b11:copy']) {
    misanswered.add(told)
    element._setRenames(true)
    await settle()
    assert.match(renderText(element.render()), /Couldn't hide renamed names: The server's diff doesn't match this file as shown\./u, told)
    misanswered.clear()
    element._setRenames(false)
  }
  element._setRenames(true)
  await settle()
  const shown = renderText(element.render())
  assert.doesNotMatch(shown, /Couldn't hide renamed names/u)
  assert.match(shown, /diff-row add/u, 'the change shown')
  assert.doesNotMatch(shown, /Only renamed names changed/u)
})

test('names a file reads keep renamed names from being hidden: its renamed lines are marked instead, the file as it is', async t => {
  t.after(() => { state.bundleSourcePretty = false; element._setMarks(false); element._setRenames(false); misanswered.clear() })
  const element = view('dist/named.min.js', [{ 'dist/named.min.js': `var Y=1;${'q(Y);'.repeat(250)}f(Y.name);\n` }, { 'dist/named.min.js': `var X=1;${'q(X);'.repeat(250)}f(X.name);\n` }])
  element.base.managedId = 'b13'
  element.other.managedId = 'b14'
  // Three lines differing in names alone, one between them unchanged, and a number changed.
  pretty.set('b13:dist/named.min.js', 'var Y = 1;\nq(Y);\nf(Y.name);\nh();\ng(1);\nmodule.exports = 1;\n')
  pretty.set('b14:dist/named.min.js', 'var X = 1;\nq(X);\nf(X.name);\nh();\ng(2);\nmodule.exports = 1;\n')
  state.bundleSourcePretty = true
  for (let i = 0; i < 200 && /is-loading/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
  const settle = async () => { for (let i = 0; i < 200 && /(?:Hiding renamed names|Marking renamed lines)…/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) }) }
  element._setRenames(true)
  await settle()
  const read = renderText(element.render())
  assert.match(read, /Renamed lines are marked rather than hidden: the file reads names \(\.name\), which a rename changes\./u)
  assert.match(read, /aria-pressed=true aria-disabled=true\s+aria-label="Mark renamed lines"/u, 'marking on, and kept on')
  assert.match(read, /var <mark class="diff-word">Y<\/mark> = 1;/u, 'the old side as it is, marked')
  assert.match(read, /diff-row del renamed/u)
  assert.match(read, /class="add">\+1<\/span><span class="del">−1/u, 'what changed besides, counted')
  assert.match(read, /≈3/u, 'the renamed lines counted apart')
  element._setMarks(true)
  const marked = renderText(element.render())
  assert.match(marked, /diff-row del renamed/u, 'marked as asked, too')
  assert.doesNotMatch(marked, /Renamed lines are marked rather than hidden/u, 'no note where the viewer asked for it')
  assert.match(marked, /aria-pressed=true aria-disabled=\s+aria-label="Mark renamed lines"/u, 'and the toggle free to turn it off for other files')
})

test('a file renamed from another type to JavaScript offers no renamed names hidden', async t => {
  t.after(() => { state.bundleSourcePretty = false })
  const minifiedLib = name => `var ${name}=1;${`q(${name});`.repeat(250)}module.exports=${name};\n`
  const element = view('dist/lib.min.js', [{ 'dist/lib.min.jsx': minifiedLib('Y') }, { 'dist/lib.min.js': minifiedLib('X') }])
  assert.equal(element._entries.get('dist/lib.min.js')?.basePath, 'dist/lib.min.jsx', 'a re-extensioned file')
  element.base.managedId = 'b11'
  element.other.managedId = 'b12'
  pretty.set('b11:dist/lib.min.jsx', 'var Y = 1;\nq(Y);\nmodule.exports = Y;\n')
  pretty.set('b12:dist/lib.min.js', 'var X = 1;\nq(X);\nmodule.exports = X;\n')
  state.bundleSourcePretty = true
  for (let i = 0; i < 200 && /is-loading/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
  assert.doesNotMatch(renderText(element.render()), /Hide renamed names/u)
})

test('a file whose names the server could not give the new side\'s says why, its renamed names shown', async t => {
  t.after(() => { state.bundleSourcePretty = false; element._setRenames(false) })
  const element = view('dist/eval.min.js', [{ 'dist/eval.min.js': `var Y=1;eval("Y");${'q(Y);'.repeat(250)}\n` }, { 'dist/eval.min.js': `var X=1;eval("X");${'q(X);'.repeat(250)}\n` }])
  element.base.managedId = 'b7'
  element.other.managedId = 'b8'
  pretty.set('b7:dist/eval.min.js', 'var Y = 1;\neval("Y");\nq(Y);\n')
  pretty.set('b8:dist/eval.min.js', 'var X = 1;\neval("X");\nq(X);\n')
  state.bundleSourcePretty = true
  for (let i = 0; i < 200 && /is-loading/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
  element._setRenames(true)
  for (let i = 0; i < 200 && /Hiding renamed names…/u.test(renderText(element.render())); i++) await new Promise(resolve => { setTimeout(resolve, 5) })
  const shown = renderText(element.render())
  assert.match(shown, /Renamed names are shown: the file reads names by their spelling \(eval or with\)\./u)
  assert.match(shown, /class="add">\+3<\/span><span class="del">−3/u)
})
