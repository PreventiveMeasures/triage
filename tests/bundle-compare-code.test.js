import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'

mock.module('../client/index.js', { namedExports: { state: {}, BUNDLE_SOURCE_WRAP_KEY: 'wrap' } })
mock.module('../ui/view/bundle-code-splitter.js', { namedExports: {} })
mock.module('lit/directives/repeat.js', { namedExports: { repeat: (items, _key, template) => items.map(template) } })
const { computeBundleDiff, computeResolutionDiff } = await import('../ui/view/bundle-compare-diff.js')
const { bundleCompareResolutions } = await import('../ui/view/bundle-compare-inputs.js')
const { bundleFilesAsMap } = await import('../ui/view/bundle-sources.js')
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

function details(integrity, version, extra = {}) {
  const v2 = version === 2
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

test('the kind filters hide files, keeping a modified file under Repointed when its imports moved', () => {
  const element = view()
  element._toggleKind('changed')
  element._toggleKind('added')
  element._toggleKind('removed')
  assert.deepEqual(Object.keys(fileMarks(renderText(element.render()))), ['src/server.js'])
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

test('Next change past the rows shown brings the next change in instead of leaving the file', () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`)
  const big = list => `${list.join('\n')}\n`
  const element = view('src/big.js', [{ 'src/big.js': big(lines) }, { 'src/big.js': big(lines.map((line, i) => i % 2 ? `${line} changed` : line)) }])
  renderText(element.render())
  const { key, rows, limit } = element._shownRows
  assert.ok(rows.length > limit, 'more rows than one page')
  // Every rendered change is above the viewport top.
  element.querySelector = () => ({ getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => [] })
  let selected = null
  element.addEventListener('compare-code-select', event => { selected = event.detail.path })
  element._stepChange(1)
  const next = rows.findIndex((row, i) => i >= limit && row.change !== undefined && rows[i - 1].change !== row.change)
  assert.equal(element._limits.get(key), next + 2000)
  assert.equal(selected, null, 'stays on the file')
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

test('the Diff view lists every changed file\'s diff in one list, and counts the rows it would show', async () => {
  const { COMBINED_DIFF_MAX, combinedDiffRows } = await import('../ui/view/bundle-compare-all.js')
  const CompareAll = customElements.get('bundle-compare-all')
  const code = view()
  const all = new CompareAll()
  for (const name of ['base', 'other', 'files', 'baseName', 'otherName']) all[name] = code[name]
  const counted = combinedDiffRows(code.base, code.other, code.files)
  all.models = counted.models
  all.willUpdate(new Map([['base'], ['other'], ['files']]))
  const markup = renderText(all.render())
  const heads = [...markup.matchAll(/<section class="bundle-compare-all-file" aria-label=([^\s>]+)>/gu)].map(m => m[1])
  assert.deepEqual(heads, ['assets/logo.png', 'node_modules/left-pad/index.js', 'node_modules/zod/index.js', 'src/api.js', 'src/features/search.js', 'src/legacy.js'],
    'every added, removed and changed file, by path; a repointed importer has no text that changed')
  assert.match(markup, /6 files changed/u)
  assert.match(markup, /Binary file changed/u)
  assert.equal([...markup.matchAll(/class=bundle-compare-diff-table/gu)].length, 5, 'a diff for every text file')
  assert.ok(counted.rows > heads.length && counted.rows < COMBINED_DIFF_MAX)
  assert.deepEqual([...counted.models.keys()].toSorted(), heads.filter(path => path !== 'assets/logo.png'), 'the line models found counting')
  // Counted only until it passes the limit; two rows a file at least, so too
  // many files for it are told without a diff.
  const capped = combinedDiffRows(code.base, code.other, code.files, 13)
  assert.ok(capped.rows >= 13 && Number.isFinite(capped.rows), `${capped.rows}`)
  assert.equal(combinedDiffRows(code.base, code.other, code.files, 12).rows, Infinity)
})
