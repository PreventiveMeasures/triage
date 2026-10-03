import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Bundle } from '@exodus/stasis-core/bundle'
import { bundleSourceLinkResolver } from '../ui/view/bundle-source-links.js'
import { highlight } from '../ui/prism.js'
import { splitHighlightedLines } from '../ui/view/prism-highlight.js'

function sourcemap(paths) {
  return { kind: 'sourcemap', json: { sources: paths, sourcesContent: paths.map(() => '') } }
}

function stasis(imports, paths = ['src/main.js', 'src/other.js', 'src/foo.js', 'src/foo.android.js', 'lib/utils.ts', 'node_modules/pkg/index.js', 'script']) {
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

// Compare the text and syntax classes at every character, allowing spans to be
// split at button boundaries while checking that the resulting HTML nests.
function styledText(html) {
  const stack = []
  const characters = []
  for (const [part] of html.matchAll(/<[^>]+>|[^<]+/gu)) {
    if (part.startsWith('</')) {
      assert.equal(stack.pop()?.tag, part.slice(2, -1))
    } else if (part.startsWith('<')) {
      const tag = /^<(\w+)/u.exec(part)[1]
      if (tag === 'button') assert.ok(stack.every(item => item.tag !== 'button'), 'links cannot nest')
      stack.push({ tag, classes: /class="([^"]*)"/u.exec(part)?.[1] ?? '' })
    } else {
      const classes = stack.filter(item => item.tag !== 'button').map(item => item.classes)
      for (const character of part) characters.push([character, classes])
    }
  }
  assert.equal(stack.length, 0)
  return characters
}

function sourceLinks(code, language, resolve) {
  const html = highlight(code, language, resolve)
  assert.deepEqual(styledText(html), styledText(highlight(code, language)), 'links preserve text and syntax')
  return [...html.matchAll(/<button [^>]*data-bundle-source-link="([^"]*)"[^>]*>(.*?)<\/button>/gsu)]
    .map(([, target, content]) => [content.replaceAll(/<[^>]+>/gu, ''), target])
}

test('PHP links recorded names across syntax tokens and accepts a leading namespace separator', () => {
  const parent = 'vendor/brick/math/src/BigRational.php'
  const decimal = 'vendor/brick/math/src/BigDecimal.php'
  const integer = 'vendor/brick/math/src/BigInteger.php'
  const override = 'vendor/symfony/polyfill-php83/Resources/stubs/Override.php'
  const details = stasis({ php: { [parent]: {
    'Brick\\Math\\BigDecimal': decimal, 'Brick\\Math\\BigInteger': integer, Override: override,
  } } }, [parent, decimal, integer, override])
  const code = String.raw`<p>Brick\Math\BigInteger Override</p>
<?php
use Brick\Math\BigDecimal;
#[Override]
function convert(?\Brick\Math\BigInteger $value): Brick\Math\BigDecimal {
    return new \Brick\Math\BigDecimal(Brick\Math\BigInteger::of($value));
}
$Override = 'Override';
echo "Brick\\Math\\BigInteger";
// Brick\Math\BigInteger
/* Override */
new Brick\Math\BigIntegerExtra();
new Other\Brick\Math\BigInteger();
new Brick\Math\BigInteger\Nested();
new éBrick\Math\BigInteger();
new 🧱Brick\Math\BigInteger();
?>`
  assert.deepEqual(sourceLinks(code, 'php', bundleSourceLinkResolver(details, parent)), [
    ['Brick\\Math\\BigDecimal', decimal], ['Override', override],
    ['\\Brick\\Math\\BigInteger', integer], ['Brick\\Math\\BigDecimal', decimal],
    ['\\Brick\\Math\\BigDecimal', decimal], ['Brick\\Math\\BigInteger', integer],
    ["'Override'", override], // Existing exact string links remain supported.
  ])
})

test('Rust links recorded paths, grouped imports, glob parents, and external crate roots', () => {
  const parent = 'vendor/syn-1.0.109/src/file.rs'
  const parse = 'vendor/syn-1.0.109/src/parse.rs'
  const attr = 'vendor/syn-1.0.109/src/attr.rs'
  const lib = 'vendor/syn-1.0.109/src/lib.rs'
  const procMacro = 'vendor/proc-macro2/src/lib.rs'
  const quote = 'vendor/quote/src/lib.rs'
  const details = stasis({ rust: { [parent]: {
    'crate::attr::FilterAttrs': attr, 'crate::parse::Parse': parse,
    'crate::parse::ParseStream': parse, 'crate::parse::Result': parse,
    super: lib, 'use proc_macro2': procMacro, 'use quote': quote,
  } } }, [parent, parse, attr, lib, procMacro, quote])
  const code = `use crate::attr::FilterAttrs;
use crate::parse::{Parse, ParseStream, Result as ParseResult};
use crate::{parse::{Parse, Result}, attr::FilterAttrs};
use super::*;
use proc_macro2::{TokenStream};
use quote::quote;
extern crate quote;
fn f(value: crate::parse::Parse) { quote::quote!(); }
fn compact(value:crate::parse::Parse) {}
use crate :: parse :: {Parse};
use crate::r#parse::Parse;
use r#quote :: quote;
use ::quote::quote;
// crate::parse::Parse use quote
/* super */
let s = "crate::parse::Parse use quote";
let raw = r#"crate::parse::Parse"#;
let c = 'x';
use crate::parse::ParseExtra;
use other::crate::parse::Parse;
use crate::parse::Parse::Extra;
use écrate::parse::Parse;
use quote_extra::quote;
use proc_macro2_extra;
let superfluous = 1;`
  assert.deepEqual(sourceLinks(code, 'rust', bundleSourceLinkResolver(details, parent)), [
    ['crate::attr::FilterAttrs', attr], ['Parse', parse], ['ParseStream', parse], ['Result', parse],
    ['Parse', parse], ['Result', parse], ['attr::FilterAttrs', attr], ['super', lib],
    ['proc_macro2', procMacro], ['quote', quote], ['quote', quote],
    ['crate::parse::Parse', parse], ['quote', quote],
    ['crate::parse::Parse', parse], ['Parse', parse], ['crate::r#parse::Parse', parse],
    ['r#quote', quote], ['::quote', quote],
  ])
})

test('PHP and Rust names obey per-file visibility and conflicting import conditions', () => {
  for (const [language, parent, name, code] of [
    ['php', 'src/main.php', 'A\\B', '<?php use A\\B; new \\A\\B();'],
    ['rust', 'src/main.rs', 'crate::a::B', 'use crate::a::B; use crate::a::{B};'],
    ['rust', 'src/main.rs', 'mod borsh', 'pub mod borsh;'],
  ]) {
    const imports = { a: { [parent]: { [name]: 'one' } }, b: { [parent]: { [name]: 'two' } } }
    const details = stasis(imports, [parent, 'other', 'one', 'two'])
    assert.deepEqual(sourceLinks(code, language, bundleSourceLinkResolver(details, parent)), [])
    assert.deepEqual(sourceLinks(code, language, bundleSourceLinkResolver(details, 'other')), [])
    assert.deepEqual(sourceLinks(code, language, bundleSourceLinkResolver(stasis(imports, [parent]), parent)), [])
    assert.equal(highlight(code, language, () => null), highlight(code, language))
  }
})

test('Rust module declarations use mod keys, including inline module prefixes', () => {
  const parent = 'src/lib.rs'
  const details = stasis({ rust: { [parent]: {
    'mod borsh': 'src/borsh.rs',
    'mod outer::borsh': 'src/outer/borsh.rs',
    'mod outer::nested::borsh': 'src/outer/nested/borsh.rs',
    'use borsh': 'vendor/borsh/src/lib.rs',
    borsh: 'src/other.rs',
  } } }, [parent, 'src/borsh.rs', 'src/outer/borsh.rs', 'src/outer/nested/borsh.rs', 'vendor/borsh/src/lib.rs', 'src/other.rs'])
  const code = `pub mod borsh;
mod borsh;
pub(crate) mod borsh;
pub(in crate::private) mod borsh;
pub mod /* comment */ r#borsh;
mod outer {
    mod borsh;
    fn unrelated() { let value = 1; }
    mod nested { pub mod borsh; }
    pub mod borsh;
}
pub mod borsh;
mod borsh {}
mod borsh_extra;
mod missing { mod borsh; }
// pub mod borsh;
/* mod borsh; */
let text = "mod borsh;";
use borsh;`
  assert.deepEqual(sourceLinks(code, 'rust', bundleSourceLinkResolver(details, parent)), [
    ['borsh', 'src/borsh.rs'], ['borsh', 'src/borsh.rs'], ['borsh', 'src/borsh.rs'],
    ['borsh', 'src/borsh.rs'], ['r#borsh', 'src/borsh.rs'], ['borsh', 'src/outer/borsh.rs'],
    ['borsh', 'src/outer/nested/borsh.rs'], ['borsh', 'src/outer/borsh.rs'],
    ['borsh', 'src/borsh.rs'], ['borsh', 'src/other.rs'],
  ])
  details.bundle.imports.get('rust').get(parent).set('mod borsh', 'missing.rs')
  assert.deepEqual(sourceLinks('pub mod borsh;', 'rust', bundleSourceLinkResolver({ ...details, bundle: Bundle.parse(details.bundle.serialize()) }, parent)), [])
})

test('Rust path links remain valid when the viewer splits highlighted source into lines', () => {
  const code = 'use crate::\n    parse::Parse;'
  const resolve = bundleSourceLinkResolver(stasis({ rust: { 'src/main.rs': { 'crate::parse::Parse': 'src/parse.rs' } } }, ['src/main.rs', 'src/parse.rs']), 'src/main.rs')
  const linked = splitHighlightedLines(highlight(code, 'rust', resolve))
  const plain = splitHighlightedLines(highlight(code, 'rust'))
  assert.equal(linked.length, 2)
  for (const [i, line] of linked.entries()) {
    assert.deepEqual(styledText(line), styledText(plain[i]))
    assert.equal((line.match(/data-bundle-source-link="src\/parse.rs"/gu) ?? []).length, 1)
  }
})
