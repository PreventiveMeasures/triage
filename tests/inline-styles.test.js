// The pages take no inline style (`style-src 'self'`): a `style` attribute
// in markup and a `<style>` element are refused, so markup that gets into
// the page can't restyle it, and nothing the app draws may rely on one.
// Styles come from the stylesheets, Lit's adopted sheets, and the CSSOM,
// which `element.style` and the app's `styleMap` (view/style-map.js)
// write through — Lit's own sets its first styles as an attribute. Nothing
// under Node enforces the CSP, so this holds the app to it.
import assert from 'node:assert/strict'
import { globSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

test('no page admits an inline style', () => {
  for (const path of globSync('ui/*.html')) {
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/u.exec(readFileSync(path, 'utf8'))?.[1] ?? ''
    const style = csp.split(';').map(part => part.trim().split(/\s+/u)).find(([name]) => name === 'style-src')
    if (style) assert.deepEqual(style.slice(1), ["'self'"], path)
    else assert.match(csp, /default-src 'none'/u, `${path} styles nothing`)
  }
})

test('the app sets no style attribute as a string and adds no style element', () => {
  const offenders = []
  for (const path of globSync('ui/**/*.{js,html,svg}')) {
    const source = readFileSync(path, 'utf8')
    // A name bound to `style` must be a `styleMap`: made by one in this
    // file, as a value or as a function's result.
    const isStyleMap = name => name === 'styleMap' || new RegExp(`\\b${name} = styleMap\\(`, 'u').test(source)
      || (new RegExp(`function ${name}\\(`, 'u').test(source) && /return styleMap\(/u.test(source))
    source.split('\n').forEach((line, i) => {
      const code = line.replace(/^\s*(?:\/\/|<!--).*$/u, '')
      const at = `${path}:${i + 1}: ${line.trim()}`
      if (/\sstyle="|\sstyle='/u.test(code)) offenders.push(at)
      for (const [, name] of code.matchAll(/\sstyle=\$\{\s*([\w$]*)/gu)) if (!name || !isStyleMap(name)) offenders.push(at)
      if (/createElement(?:NS)?\([^)]*['"]style['"]\)|setAttribute\(\s*['"]style['"]|<style\b/u.test(code)) offenders.push(at)
      if (/lit(?:-html)?\/directives\/style-map\.js/u.test(code)) offenders.push(at)
    })
  }
  assert.deepEqual(offenders, [])
})

test('the app\'s styleMap writes through the CSSOM from the first render, never a style attribute', async () => {
  const { styleMap } = await import('../ui/view/style-map.js')
  const { PartType } = await import('lit/directive.js')
  // The declarations set, as the CSSOM keeps them: by `setProperty`, or by a
  // property's own name, which a null clears.
  const set = new Map()
  const style = new Proxy({ setProperty: (name, value, priority) => set.set(name, [value, priority]), removeProperty: name => set.delete(name) }, {
    set: (target, name, value) => (value == null ? set.delete(name) : set.set(name, [value, '']), true),
  })
  const element = { style, setAttribute: () => assert.fail('a style attribute was set') }
  const result = styleMap({ color: 'red', '--x': '1px', '--y': null, width: '2px !important' })
  const Directive = result['_$litDirective$']
  const directive = new Directive({ type: PartType.ATTRIBUTE, name: 'style', strings: ['', ''] })
  const part = { element }
  assert.equal(directive.update(part, result.values), directive.render())
  assert.deepEqual([...set], [['color', ['red', '']], ['--x', ['1px', '']], ['width', ['2px ', 'important']]], 'the first render already styled')
  directive.update(part, [{ '--x': '3px' }])
  assert.deepEqual([...set], [['--x', ['3px', '']]], 'a property dropped is removed')
  assert.throws(() => new Directive({ type: PartType.ATTRIBUTE, name: 'class', strings: ['', ''] }), /whole of a `style` attribute/u)
  assert.throws(() => new Directive({ type: PartType.ATTRIBUTE, name: 'style', strings: ['', '/'] }), /whole of a `style` attribute/u, 'run into a `/>`')
})
