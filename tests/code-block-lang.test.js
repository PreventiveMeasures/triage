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
const { langForTag, langForPath } = await import('../ui/view/prism-highlight.js')

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
