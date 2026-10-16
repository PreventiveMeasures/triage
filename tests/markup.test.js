// view/markup.js is the one way a string becomes markup on the page, and it
// takes only the markup the app writes. Held here both ways: everything the
// app does write passes — every icon, Prism's colouring in every language
// it bundles, the source links, control and diff marks laid over it, the
// export preview's rows — and nothing else does, however it is spelled.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import './_polyfills.js'
import { nothing } from 'lit'

// Prism first: it hands the gate the token names its spans carry.
const prism = await import('../ui/prism.js')
const { appMarkup, isAppMarkup } = await import('../ui/view/markup.js')
const { splitHighlightedLines } = await import('../ui/view/prism-highlight.js')
const { controlMarkup } = await import('../ui/view/control-chars.js')
const { markHighlighted } = await import('../ui/view/bundle-compare-code-model.js')
const { escapeHtml } = await import('../ui/view/export-view-chunks.js')

// The grammars ui/prism.js bundles, as its imports name them.
const LANGUAGES = [...readFileSync('ui/prism.js', 'utf8').matchAll(/prismjs\/components\/prism-([\w-]+)\.js/gu)].map(([, name]) => name)
  .filter(name => !['markup-templating', 'php-extras'].includes(name))
const CODE = [
  'const a = `x${b}y` // <b>bold</b> & "q"\nimport fs from "node:fs"\nimport x from "./a.js"\nlet r = /<[a-z]+>/g',
  '<div class="a" onclick="b()">&amp; &lt; &copy; &#x3c;<!-- c --><![CDATA[d]]></div><script>e()</script><style>f{}</style>',
  '<?php echo "<b>$x</b>"; $a = <<<EOT\nhi {$y}\nEOT; ?>',
  '# Title\n\n**b** `c` [l](https://github.com/org/repo)\n\n```html\n<img src=x onerror=alert(1)>\n```\n\n| a | b |\n|---|---|\n| <i>x</i> | y |',
  'fn main() { let s = "<a href=\'x\'>"; println!("{}", s); } // \u0000 \u202E \u200B',
  'def f(x):\n    return f"<{x}>"  # \u2028 ok',
  'a { background: url("javascript:x"); content: "<b>"; } @media (x) { b { c: d } }',
  'echo "<x>" | sh; cat <<EOF\n<y>\nEOF',
  '{"a": "<b>", "c": [1, 2.5e3, null, true]}',
  'key: <value> # c\nlist:\n  - "a"\n  - &anchor b',
  'pragma solidity ^0.8.0; contract C { string s = "<i>"; }',
  '#include <stdio.h>\nint main() { char *s = "<a>"; return 0; } // ??=',
  '@interface A : NSObject @end NSString *s = @"<b>";',
  'public class A { String s = "<b>"; /** <p>doc</p> */ }',
  'class A; def b = "<c>" end; %w[<d> e]',
]

test('every icon the app writes is markup it may draw', async () => {
  const icons = []
  const walk = (value, where) => {
    if (typeof value === 'string') { if (value.includes('<')) icons.push([where, value]) } else if (value && typeof value === 'object' && !value.strings) for (const [key, inner] of Object.entries(value)) walk(inner, `${where}.${key}`)
  }
  for (const path of ['../ui/view/icons.js', '../ui/view/file-display.js', '../ui/view/report-logos.js']) {
    for (const [name, value] of Object.entries(await import(path))) walk(value, `${path}:${name}`)
  }
  assert.ok(icons.length > 30, 'the icons were found')
  assert.deepEqual(icons.filter(([, svg]) => !isAppMarkup(svg)).map(([where]) => where), [])
})

test('Prism\'s colouring is markup it may draw, in every language it bundles and with what is laid over it', () => {
  assert.ok(LANGUAGES.length > 15, 'the grammars were found')
  const resolve = value => (value === './a.js' ? 'a.js' : null)
  for (const lang of LANGUAGES) {
    for (const code of CODE) {
      const html = prism.highlight(code, lang)
      assert.ok(isAppMarkup(html), `${lang}: ${html.slice(0, 200)}`)
      assert.ok(isAppMarkup(prism.highlight(code, lang, resolve)), `${lang}, with source links`)
      assert.ok(isAppMarkup(controlMarkup(html, true)), `${lang}, with control marks`)
      for (const line of splitHighlightedLines(html)) {
        assert.ok(isAppMarkup(markHighlighted(line, [[0, 2], [4, 9]])), `${lang}, with diff marks`)
        assert.ok(isAppMarkup(`<span class="evd-lineno" aria-hidden="true">1</span><code class="evd-line">${line}\n</code>`), `${lang}, as an export row`)
      }
    }
  }
  const links = prism.highlight(CODE[0], 'javascript', resolve)
  assert.match(links, /<button type="button" class="bundle-source-link" data-bundle-source-link="a\.js">/u)
  assert.match(links, /<a class="source-node-doc" href="https:\/\/nodejs\.org\/api\/fs\.html"/u)
  assert.ok(isAppMarkup(`<code class="evd-line">${escapeHtml(CODE[1])}\n</code>`), 'an export row left plain')
})

test('nothing else passes, however it is spelled', () => {
  const refused = [
    // Elements the app never writes as a string.
    '<img src=x>', '<img src="x" onerror="alert(1)">', '<a href="https://evil.example/">x</a>', '<a href="https://github.com/org/repo">x</a>',
    '<script>alert(1)</script>', '<style>body{display:none}</style>', '<iframe srcdoc="x"></iframe>', '<form action="https://evil.example/"></form>',
    '<meta http-equiv="refresh" content="0;url=https://evil.example/">', '<link rel="stylesheet" href="https://evil.example/x.css">', '<base href="https://evil.example/">',
    '<object data="x"></object>', '<embed src="x">', '<input>', '<textarea></textarea>', '<template></template>', '<noscript></noscript>', '<math></math>',
    '<title>x</title>', '<div>x</div>', '<p>x</p>', '<details open ontoggle="alert(1)">',
    '<svg><foreignObject></foreignObject></svg>', '<svg><use href="#x"></use></svg>', '<svg><animate onbegin="alert(1)"></animate></svg>', '<svg><style>x</style></svg>',
    '<svg><a href="https://evil.example/"><text>x</text></a></svg>', '<svg><script>alert(1)</script></svg>',
    // Attributes an allowed element doesn't take.
    '<span class="token keyword" onclick="alert(1)">x</span>', '<span style="position:fixed;inset:0">x</span>', '<span class="token" id="header-slot">',
    '<span class="token" href="x">', '<svg onload="alert(1)"></svg>', '<path d="M0 0" style="x"></path>', '<button type="submit" class="bundle-source-link">',
    '<button type="button" class="bundle-source-link" formaction="x">', '<mark class="diff-word" onmouseover="x">',
    // Values an allowed attribute doesn't take.
    '<span class="token kanban-detail-dim">x</span>', '<span class="token bundle-source-overlay">x</span>', '<span class="token  keyword">x</span>',
    '<span class="kanban-detail-dim">x</span>', '<svg class="file-icon screen-crack"></svg>', '<mark class="kanban-detail-side">', '<span aria-hidden="false">',
    '<a class="source-node-doc" href="https://evil.example/api/fs.html">', '<a class="source-node-doc" href="http://nodejs.org/api/fs.html">',
    '<a class="source-node-doc" href="https://nodejs.org.evil.example/api/fs.html">', '<a class="source-node-doc" href="https://nodejs.org/api/../x.html">',
    '<a class="source-node-doc" href="javascript:alert(1)">', '<a class="source-node-doc" href="&#x6a;avascript:alert(1)">',
    '<a class="source-node-doc" href="https://nodejs.org/api/fs.html" target="_self">', '<path d="M0 0" fill="url(https://evil.example/x.svg#p)"></path>',
    // Spellings a parser reads differently from what a pattern might.
    '<SPAN>x</SPAN>', '<span CLASS="token">', '<span class=token>', '<span class=\'token\'>', '<span hidden>', '<span/onclick="alert(1)">',
    '<span\u00A0onclick="alert(1)">', '<span class="token"\u00A0onclick="alert(1)">', '<span class="token"onclick="alert(1)">', '<span class="token" onclick=alert(1)>',
    '<!-- x -->', '<!---->', '<!doctype html>', '<?xml x?>', '<![CDATA[x]]>', '< span>', '<', 'x<', '<span', '</script>', '<spanx>', '<span1>',
  ]
  assert.deepEqual(refused.filter(html => isAppMarkup(html)), [])
  for (const html of ['', 'plain text', 'a > b & c', '&lt;img src=x&gt;', '<span>Scan</span>', '<span class="token keyword">const</span>']) assert.ok(isAppMarkup(html), html)
})

test('appMarkup draws the app\'s markup as markup and anything else as its own text, reported', (t) => {
  const reported = t.mock.method(console, 'error', () => {})
  const icon = appMarkup('<svg class="file-icon" viewBox="0 0 16 16"><path d="M0 0h16"/></svg>')
  assert.equal(icon['_$litDirective$']?.directiveName, 'unsafeHTML')
  assert.equal(appMarkup('<span class="token keyword">const</span>')['_$litDirective$']?.directiveName, 'unsafeHTML')
  const overlay = '<a href="https://evil.example/login" style="position:fixed;inset:0">Session expired: sign in again</a>'
  assert.equal(appMarkup(overlay), overlay, 'as text: Lit escapes a string')
  assert.equal(reported.mock.callCount(), 1)
  assert.match(String(reported.mock.calls[0].arguments.join(' ')), /shown as text/u)
  for (const empty of [null, undefined, nothing]) assert.equal(appMarkup(empty), empty)
})
