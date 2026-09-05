// `ui/view/prism-highlight.js` — `langForTag`, the hard allowlist that
// decides which fenced code blocks in a finding description get
// coloured. Two things are pinned here: the tags a report actually
// writes resolve to the right grammar, and the allowlist can't drift
// from the grammars `ui/prism.js` bundles — a value naming a grammar
// that isn't imported there would download prism only to find Prism
// can't colour the block either.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

// No stubs needed: prism-highlight.js is a leaf (it imports nothing,
// and reaches prismjs only through a runtime-string dynamic import).
const { langForTag, langForPath, splitHighlightedLines } = await import('../ui/view/prism-highlight.js')

describe('langForTag — recognized tags', () => {
  it('maps the TypeScript tags', () => {
    for (const tag of ['ts', 'typescript', 'mts', 'cts']) {
      assert.equal(langForTag(tag), 'typescript', tag)
    }
    assert.equal(langForTag('tsx'), 'tsx')
  })

  it('maps the JavaScript tags', () => {
    for (const tag of ['js', 'javascript', 'mjs', 'cjs', 'node']) {
      assert.equal(langForTag(tag), 'javascript', tag)
    }
    assert.equal(langForTag('jsx'), 'jsx')
  })

  it('maps the shell tags onto bash', () => {
    for (const tag of ['sh', 'bash', 'shell', 'zsh', 'console']) {
      assert.equal(langForTag(tag), 'bash', tag)
    }
  })

  it('maps the markup / data / doc tags', () => {
    assert.equal(langForTag('json'), 'json')
    assert.equal(langForTag('css'), 'css')
    assert.equal(langForTag('yml'), 'yaml')
    assert.equal(langForTag('yaml'), 'yaml')
    assert.equal(langForTag('md'), 'markdown')
    for (const tag of ['html', 'htm', 'xml', 'svg', 'markup']) {
      assert.equal(langForTag(tag), 'markup', tag)
    }
  })

  it('maps the non-web source tags', () => {
    assert.equal(langForTag('sol'), 'solidity')
    assert.equal(langForTag('rs'), 'rust')
    assert.equal(langForTag('php'), 'php')
    assert.equal(langForTag('phtml'), 'php')
  })

  it('case-folds the tag', () => {
    assert.equal(langForTag('TS'), 'typescript')
    assert.equal(langForTag('JSON'), 'json')
  })
})

describe('langForTag — everything else', () => {
  it('refuses a language the bundle carries no grammar for', () => {
    for (const tag of ['python', 'py', 'go', 'java', 'ruby', 'sql', 'diff', 'text']) {
      assert.equal(langForTag(tag), null, tag)
    }
  })

  it('refuses a tag that is not a language name', () => {
    assert.equal(langForTag(''), null)
    assert.equal(langForTag('a b'), null)
    assert.equal(langForTag('../etc/passwd'), null)
  })

  // The map is null-prototype, so an inherited key can't answer for a
  // language — `Object.prototype.constructor` is a function, and a
  // truthy answer here would send a grammar lookup off with it.
  it('refuses an inherited Object key', () => {
    for (const tag of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      assert.equal(langForTag(tag), null, tag)
    }
  })

  it('refuses a non-string', () => {
    for (const tag of [undefined, null, 0, {}, ['ts']]) {
      assert.equal(langForTag(tag), null, String(tag))
    }
  })
})

// The allowlist is only useful if every grammar it names is actually
// in the lazy prism bundle: a value naming a grammar `ui/prism.js`
// doesn't import would cost the reader a ~50KB download to end up
// with the plain text they'd have got for free. Both lists are
// hand-maintained in different files, so this reads them rather than
// keeping a third copy — every language either resolver can return
// (the source viewers' extension map included) has to be imported
// over there.
describe('langForTag — allowlist matches the prism bundle', () => {
  it('names only grammars ui/prism.js imports', async () => {
    const bundleSrc = await readFile(new URL('../ui/prism.js', import.meta.url), 'utf8')
    const bundled = new Set(
      [...bundleSrc.matchAll(/prismjs\/components\/prism-([\w-]+)\.js/gu)].map((m) => m[1]),
    )
    assert.ok(bundled.size > 0, 'no grammar imports found in ui/prism.js')

    // The resolvers' maps are the file's only `key: 'value'` literals,
    // so every quoted value in it is a language name one of them can
    // return — a new entry is covered here the day it's added.
    const resolverSrc = await readFile(new URL('../ui/view/prism-highlight.js', import.meta.url), 'utf8')
    const named = new Set([...resolverSrc.matchAll(/:\s*'([a-z0-9-]+)'/gu)].map((m) => m[1]))
    assert.ok(named.size > 10, 'no language values found in prism-highlight.js')
    for (const lang of named) {
      assert.ok(bundled.has(lang), `${lang} is resolved to, but ui/prism.js does not import it`)
    }
  })

  it('resolves every tag this file names, and the viewer extensions', () => {
    const tags = [
      'ts', 'typescript', 'mts', 'cts', 'tsx', 'js', 'javascript', 'mjs', 'cjs', 'node', 'jsx',
      'sh', 'bash', 'shell', 'zsh', 'console', 'json', 'css', 'yml', 'yaml', 'md', 'markdown',
      'html', 'htm', 'xml', 'svg', 'markup', 'sol', 'solidity', 'rs', 'rust', 'php', 'phtml',
    ]
    for (const tag of tags) assert.ok(langForTag(tag), `${tag} should be allowlisted`)
    for (const ext of ['ts', 'tsx', 'js', 'jsx', 'json', 'css', 'html', 'yml', 'sh', 'md', 'sol', 'php', 'rs']) {
      assert.ok(langForPath(`a/b.${ext}`), `.${ext} should resolve for the source viewers`)
    }
  })
})

// `splitHighlightedLines` — one HTML string per source line, for the
// export preview's line-number gutter. The interesting case is a token
// that spans lines (a fenced block in markdown is one), where a naive
// chop would leave an unclosed span on one line and a stray closer on
// the next.
describe('splitHighlightedLines', () => {
  // Everything the browser will ever hand this comes from Prism, whose
  // markup is spans and escaped text. Reconstructing the source from a
  // line means stripping the tags and unescaping — which is also how a
  // line ends up wrong if the split lost or duplicated a character.
  const textOf = (html) => html
    .replaceAll(/<[^>]*>/gu, '')
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')

  it('returns one entry per line, as a plain split would', () => {
    assert.deepEqual(splitHighlightedLines('a\nb\nc'), ['a', 'b', 'c'])
    assert.deepEqual(splitHighlightedLines('one line'), ['one line'])
    // A trailing newline ends the last line and opens an empty one, so
    // the count still matches `split('\n')` — the caller decides
    // whether to number that one.
    assert.deepEqual(splitHighlightedLines('trailing\n'), ['trailing', ''])
  })

  it('closes and reopens a token that crosses a newline', () => {
    const out = splitHighlightedLines('<span class="token bold">a\nb</span>')
    assert.deepEqual(out, [
      '<span class="token bold">a</span>',
      '<span class="token bold">b</span>',
    ])
  })

  it('reopens the whole stack, outermost first', () => {
    const out = splitHighlightedLines('<span class="a"><span class="b">x\ny</span>z</span>')
    assert.deepEqual(out, [
      '<span class="a"><span class="b">x</span></span>',
      '<span class="a"><span class="b">y</span>z</span>',
    ])
  })

  it('leaves escaped angle brackets in the text alone', () => {
    // `&lt;` is text Prism escaped, not a tag — splitting must not read
    // it as one, or the stack goes out of step for the rest of the file.
    const out = splitHighlightedLines('&lt;div&gt; is text\n<span class="token tag">&lt;b&gt;</span>')
    assert.equal(out.length, 2)
    assert.equal(textOf(out[0]), '<div> is text')
    assert.equal(textOf(out[1]), '<b>')
  })

  it('round-trips a document through Prism itself', async () => {
    // The real thing: prism's markdown grammar over a document with a
    // fenced block (one token, several lines) inside it.
    const { default: Prism } = await import('prismjs/prism.js')
    await import('prismjs/components/prism-markup.js')
    await import('prismjs/components/prism-clike.js')
    await import('prismjs/components/prism-javascript.js')
    await import('prismjs/components/prism-markdown.js')
    const source = [
      '# report.json',
      '',
      '**Findings:** 2',
      '',
      '## High (1)',
      '',
      'Compared with `===`, which short-circuits.',
      '',
      '```js',
      'if (token === expected) {',
      '  grant(user)',
      '}',
      '```',
      '',
      '**Recommendation:** use a constant-time compare.',
    ].join('\n')
    const lines = splitHighlightedLines(Prism.highlight(source, Prism.languages.markdown, 'markdown'))
    assert.equal(lines.length, source.split('\n').length)
    assert.deepEqual(lines.map(textOf), source.split('\n'))
    // Every line balanced on its own — the point of the exercise.
    for (const line of lines) {
      const opens = (line.match(/<span\b/gu) ?? []).length
      const closes = (line.match(/<\/span>/gu) ?? []).length
      assert.equal(opens, closes, line)
    }
  })
})
