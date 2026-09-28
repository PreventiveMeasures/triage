import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { bundleSourceLinkResolver } from '../ui/view/bundle-source-links.js'
import { highlight } from '../ui/prism.js'

function sourcemap(paths) {
  return { kind: 'sourcemap', json: { sources: paths, sourcesContent: paths.map(() => '') } }
}

function stasis(imports) {
  const paths = ['src/main.js', 'src/other.js', 'src/foo.js', 'src/foo.android.js', 'lib/utils.ts', 'node_modules/pkg/index.js', 'script']
  const bundle = Bundle.parse(new Bundle({
    modules: new Map([['.', { files: Object.fromEntries(paths.map(path => [path, ''])), name: 'app', version: '1' }]]),
    imports: new Map(Object.entries(imports).map(([condition, parents]) => [condition,
      new Map(Object.entries(parents).map(([parent, specifiers]) => [parent, new Map(Object.entries(specifiers))]))])),
  }).serialize())
  return { kind: 'stasis', bundle }
}

test('relative strings resolve exact files with extensions from the current directory', () => {
  const resolve = bundleSourceLinkResolver(sourcemap(['src/main.js', 'src/foo.js', 'utils.ts', 'src/noext', 'src/.env', 'other/foo.js']), 'src/main.js')
  assert.equal(resolve('./foo.js'), 'src/foo.js')
  assert.equal(resolve('../utils.ts'), 'utils.ts')
  assert.equal(resolve('./nested/../foo.js'), 'src/foo.js')
  for (const value of ['./missing.js', './foo', './noext', './.env', './foo.js/', 'foo.js', 'src/foo.js', '/src/foo.js', 'https://host/foo.js', '../../foo.js']) {
    assert.equal(resolve(value), null, value)
  }
})

test('normalizes display paths without dropping sourcemap roots or guessing ambiguous keys', () => {
  const details = sourcemap(['webpack:///./src/main.js', 'webpack:///./utils.ts', '../src/main.js', '../utils.ts', './src/foo.js', 'src/foo.js'])
  assert.equal(bundleSourceLinkResolver(details, 'webpack:///./src/main.js')('../utils.ts'), 'webpack:///./utils.ts')
  assert.equal(bundleSourceLinkResolver(details, '../src/main.js')('../utils.ts'), '../utils.ts')
  assert.equal(bundleSourceLinkResolver(details, 'src/main.js')('./foo.js'), null)
  assert.equal(bundleSourceLinkResolver(sourcemap(['/foo.js']), '/src/main.js')('../../foo.js'), null)
})

test('Stasis specifiers can be bare or extensionless when recorded conditions agree', () => {
  const details = stasis({
    'node,import': { 'src/main.js': { pkg: 'node_modules/pkg/index.js', './foo': 'src/foo.js', '#run': 'script' } },
    'node,require': { 'src/main.js': { pkg: 'node_modules/pkg/index.js' }, 'src/other.js': { pkg: 'lib/utils.ts' } },
  })
  const resolve = bundleSourceLinkResolver(details, 'src/main.js')
  assert.equal(resolve('pkg'), 'node_modules/pkg/index.js')
  assert.equal(resolve('./foo'), 'src/foo.js')
  assert.equal(resolve('#run'), 'script')
  assert.equal(bundleSourceLinkResolver(details, 'src/other.js')('pkg'), 'lib/utils.ts')
  assert.equal(bundleSourceLinkResolver(details, 'src/foo.js')('pkg'), null)
})

test('conflicting conditions, missing files, and platform maps block links and relative fallback', () => {
  const details = stasis({
    browser: { 'src/main.js': {
      pkg: 'node_modules/pkg/index.js', './foo.js': 'src/foo.js', missing: 'absent.js', builtin: 'node:fs',
      platform: new Map([['ios', 'src/foo.js'], ['android', 'src/foo.android.js']]),
      samePlatform: new Map([['ios', 'src/foo.js'], ['android', 'src/foo.js']]),
      './other.js': new Map([['ios', 'src/other.js']]),
    } },
    node: { 'src/main.js': { pkg: 'lib/utils.ts', './foo.js': 'src/foo.android.js', missing: 'src/foo.js' } },
    default: { 'src/main.js': { pkg: 'node_modules/pkg/index.js', './foo.js': 'src/foo.js' } },
  })
  const resolve = bundleSourceLinkResolver(details, 'src/main.js')
  for (const value of ['pkg', './foo.js', 'missing', 'builtin', 'platform', 'samePlatform', './other.js']) assert.equal(resolve(value), null, value)
  assert.equal(resolve('../lib/utils.ts'), 'lib/utils.ts')
})

test('does not offer sources for directories, resources, or files with missing bodies', () => {
  const details = stasis({ node: { 'src/main.js': { binary: 'src/foo.js' } } })
  details.bundle.formats.set('src/foo.js', 'resource:base64')
  details.bundle.formats.set('src/other.js', 'directory')
  const resolve = bundleSourceLinkResolver(details, 'src/main.js')
  for (const value of ['binary', './foo.js', './other.js']) assert.equal(resolve(value), null)
  assert.equal(bundleSourceLinkResolver({ kind: 'sourcemap', json: { sources: ['foo.js'] } }, 'main.js')('./foo.js'), null)
})

test('links actual string tokens while preserving syntax, comments, and regexes', () => {
  const resolve = bundleSourceLinkResolver(sourcemap(['src/main.js', 'src/foo.js', 'utils.ts']), 'src/main.js')
  const code = `import foo from "./foo.js";
const path = '../utils.ts';
const template = \`./foo.js\`;
const dynamic = \`./\${name}.js\`;
// './foo.js'
/* "../utils.ts" */
const regex = /'..\\/utils.ts'/;
const missing = './absent.js';`
  const html = highlight(code, 'javascript', resolve)
  assert.equal((html.match(/data-bundle-source-link=/gu) ?? []).length, 3)
  assert.match(html, /data-bundle-source-link="src\/foo.js"/u)
  assert.match(html, /data-bundle-source-link="utils.ts"/u)
  assert.equal(html.replaceAll(/<button [^>]+>(.*?)<\/button>/gsu, '$1'), highlight(code, 'javascript'))
  assert.doesNotMatch(highlight(code, 'javascript'), /bundle-source-link/u, 'other highlight callers stay unchanged')
})

test('Stasis link rendering skips ambiguous imports and preserves source escaping', () => {
  const details = stasis({
    node: { 'src/main.js': { pkg: 'node_modules/pkg/index.js', conflict: 'src/foo.js' } },
    browser: { 'src/main.js': { pkg: 'node_modules/pkg/index.js', conflict: 'src/foo.android.js' } },
  })
  const html = highlight(`import a from 'pkg'; import b from 'conflict';`, 'typescript', bundleSourceLinkResolver(details, 'src/main.js'))
  assert.equal((html.match(/data-bundle-source-link=/gu) ?? []).length, 1)
  const target = `src/<img>&" onmouseover="bad.js`
  const escaped = highlight(`const file = './<img>&" onmouseover="bad.js';`, 'javascript', bundleSourceLinkResolver(sourcemap(['src/main.js', target]), 'src/main.js'))
  assert.match(escaped, /data-bundle-source-link="src\/&lt;img&gt;&amp;&quot; onmouseover=&quot;bad.js"/u)
  assert.doesNotMatch(escaped.match(/<[^>]+>/gu).join(''), /<img|" onmouseover="/u)
})

test('nested syntax retains Prism output when no target resolves', () => {
  const examples = [
    ['javascript', 'const a = `./${"./foo.js"}`;'],
    ['tsx', 'const x = <div title="./foo.js">{"./foo.js"}</div>;'],
    ['json', '{"file":"./foo.js"}'],
    ['css', 'a { background: url("./foo.js"); }'],
    ['markup', '<script>const x = "./foo.js";</script>'],
    ['php', '<?php echo "./foo.js"; ?>'],
  ]
  for (const [language, code] of examples) assert.equal(highlight(code, language, () => null), highlight(code, language), language)
})
