import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import '../ui/view/frontend-install.js'

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

function details(integrity, version) {
  const v2 = version === 2
  const own = {
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

function view(path = null) {
  const base = details('base', 1), other = details('other', 2)
  const element = new CompareCode()
  element.base = base
  element.other = other
  element.files = computeBundleDiff(bundleFilesAsMap(base), bundleFilesAsMap(other), () => '__own__').files
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
  assert.match(markup, />1 repointed<\/button>/u)
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
