// `ui/styles/theme.css` — Prism's token spans must stay selectable.
//
// The chrome rule there makes the app's own furniture behave like
// native UI: arrow cursor, no drag-select. It spots that furniture by
// SUFFIX (`[class$='-name']`, `[class*='-name ']`, …) over the
// project's class-naming convention, so new chrome inherits the
// treatment for free — the trade being that the match is on the class
// attribute's spelling, not on who wrote it.
//
// Prism writes class names too, and they are content. `throw new
// SyntaxError(err)` comes out with `<span class="token class-name">`
// around the identifier, and that attribute ends in `-name` just as
// `bundles-name` does: the identifier went unselectable, and dragging
// across the line copied `throw new (err)`. The `pre` / `code` entries
// in the reassert rule didn't save it — those cover the container, and
// a wildcard matching the span itself beats a value inherited from it.
//
// So this pins the invariant rather than the remedy: whatever a token's
// class attribute is, the chrome rule must not get the last word on it.
// An exemption on `.token` satisfies that, and so would dropping a
// suffix or adding `:not(.token)` to the wildcards.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'

const themeCSS = await readFile(new URL('../ui/styles/theme.css', import.meta.url), 'utf8')

// Lift one rule out of the stylesheet by a string only it contains.
// theme.css nests (`&`) and carries `@media`, so this walks braces from
// the needle rather than regexing whole rules out of the file: the
// selector list runs from the end of the preceding comment or rule up
// to the `{`, and the body to the matching `}`. Both rules of interest
// are flat and declaration-only, so the first `}` closes them.
function ruleAround(needle) {
  const at = themeCSS.indexOf(needle)
  assert.ok(at > 0, `theme.css no longer contains ${needle}`)
  const open = themeCSS.indexOf('{', at)
  const close = themeCSS.indexOf('}', open)
  assert.ok(open > 0 && close > open, `could not bracket the rule around ${needle}`)
  const commentEnd = themeCSS.lastIndexOf('*/', at)
  const prevClose = themeCSS.lastIndexOf('}', at)
  const start = Math.max(commentEnd >= 0 ? commentEnd + 2 : 0, prevClose >= 0 ? prevClose + 1 : 0)
  return { selectors: themeCSS.slice(start, open).trim(), body: themeCSS.slice(open + 1, close), at: open }
}

const chrome = ruleAround("[class$='-title']")
const reassert = ruleAround('[contenteditable],')

// `[class$='-name']` / `[class*='-name ']` → the suffix and how to test
// it against a class attribute's value.
const wildcards = [...chrome.selectors.matchAll(/\[class(\$|\*)=['"]([^'"]+)['"]\]/gu)]
  .map(([, op, pattern]) => ({ op, pattern }))
// `.mono`, `.token` — the class selectors that win selectability back.
const reasserted = new Set([...reassert.selectors.matchAll(/(?:^|[\s,])\.([\w-]+)/gu)].map((m) => m[1]))

const chromeClaims = (value) => wildcards.some(({ op, pattern }) => (
  op === '$' ? value.endsWith(pattern) : value.includes(pattern)
))
const reassertClaims = (value) => value.split(/\s+/u).some((c) => reasserted.has(c))

// A class attribute the chrome rule claims is only safe if the reassert
// rule claims it back — and, since the two have the same specificity,
// only if it is the later of the two in the file.
const selectable = (value) => !chromeClaims(value) || (reassertClaims(value) && reassert.at > chrome.at)

describe('theme.css — the rules this rests on', () => {
  it('still has a chrome rule that kills selection by class-name suffix', () => {
    assert.match(chrome.body, /user-select:\s*none/u)
    assert.ok(wildcards.length > 0, 'no [class$=…] wildcards found in the chrome rule')
  })

  it('still has a later rule that reasserts it', () => {
    assert.match(reassert.body, /user-select:\s*text/u)
    assert.ok(reassert.at > chrome.at, 'the reassert rule must come after the chrome rule to win the tie')
  })
})

describe('prism tokens survive the chrome wildcards', () => {
  it('keeps the class-name in `throw new SyntaxError(err)` selectable', async () => {
    // The reported case, through the real bundle: select the line and
    // `SyntaxError` used to fall out of the copy.
    await import('../ui/prism.js')
    const { default: Prism } = await import('prismjs/prism.js')
    const html = Prism.highlight('throw new SyntaxError(err)', Prism.languages.javascript, 'javascript')
    const classes = [...html.matchAll(/class="([^"]*)"/gu)].map((m) => m[1])

    const className = classes.find((c) => c.split(/\s+/u).includes('class-name'))
    assert.ok(className, 'prism no longer tags the constructor as a class-name')
    assert.ok(selectable(className), `\`${className}\` is left unselectable by the chrome rule`)
    for (const value of classes) assert.ok(selectable(value), `\`${value}\` is left unselectable`)
  })

  it('keeps every token kind the bundle can emit selectable', async () => {
    // Not one snippet per language: walk the loaded grammars for every
    // token name and alias they can stamp, so a grammar added later is
    // covered the day it lands. Nine collide today — class-name,
    // attr-name, macro-name, function-name, argument-name,
    // attribute-class-name, doctype-tag, table-header, type-hint.
    await import('../ui/prism.js')
    const { default: Prism } = await import('prismjs/prism.js')

    const names = new Set()
    const seen = new Set()
    const walk = (grammar) => {
      if (!grammar || typeof grammar !== 'object' || seen.has(grammar)) return
      seen.add(grammar)
      if (Array.isArray(grammar)) { for (const entry of grammar) walk(entry) ; return }
      for (const [key, value] of Object.entries(grammar)) {
        if (key === 'inside') { walk(value); continue }
        if (key === 'alias') { for (const alias of [value].flat()) names.add(alias); continue }
        if (key === 'pattern' || key === 'lookbehind' || key === 'greedy') continue
        names.add(key)
        walk(value)
      }
    }
    for (const grammar of Object.values(Prism.languages)) walk(grammar)
    assert.ok(names.size > 100, `only found ${names.size} token names — did the bundle fail to load?`)

    for (const name of names) {
      // Both shapes Prism writes: the kind last (`token class-name`),
      // and the kind followed by an alias (`token macro-name function`)
      // — which is what `[class*='-name ']` is there to catch.
      assert.ok(selectable(`token ${name}`), `\`token ${name}\` is left unselectable`)
      assert.ok(selectable(`token ${name} alias`), `\`token ${name} alias\` is left unselectable`)
    }
  })
})
