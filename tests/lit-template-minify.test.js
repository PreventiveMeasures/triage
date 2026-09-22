// The build's Lit-template minifier (build-lit-minify.js), held to
// what it must not do.
//
// The library's placeholder ends in a semicolon, so with CSS
// minification on, a `style` attribute loses everything after its
// first expression — the unit the value needed, and any declaration
// that followed. Nothing in the app's own tests can see that: `serve`
// doesn't minify, so the templates under test are the ones that
// work. Only the built bundle carries the damage, which is how a
// collapsed export-preview gutter and a terminal note that stopped
// fading both reached a release.
//
// These pin the property, not the setting: a style attribute's
// expression keeps what follows it, whitespace is still collapsed
// (so the fix isn't "stop minifying"), and `css` templates are still
// minified (so it isn't "turn CSS minification off" either).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { minifyLitSource } = await import('../build-lit-minify.js')

const minify = (src) => minifyLitSource(src, 'probe.js') ?? src

describe('build: minifying Lit templates', () => {
  it('keeps the unit after an expression in a style attribute', () => {
    // ui/view/dialogs/export-view-dialog.js: the export preview's
    // gutter width. Without the unit `calc(2 + 1.4rem)` is invalid,
    // the grid loses its columns, and every line takes two rows.
    const out = minify('html`<div class="evd-lines" style="--evd-lineno-width: ${String(n).length}ch">x</div>`')
    assert.match(out, /\$\{String\(n\)\.length\}ch/u)
  })

  it('keeps a time unit too', () => {
    // ui/terminal.js: the silenced-gap note's fade. A bare number is
    // not a <time>, so the animation it feeds never runs.
    const out = minify('html`<div class="note" style="--dwell-out: ${d}ms">${t}</div>`')
    assert.match(out, /\$\{d\}ms/u)
  })

  it('keeps the declarations after the one holding an expression', () => {
    const out = minify('html`<div style="--w: ${n}ch; color: red">x</div>`')
    assert.match(out, /\$\{n\}ch/u)
    assert.match(out, /color: ?red/u)
  })

  it('still collapses the HTML around the templates', () => {
    const out = minify('html`<div   class="a">\n  <span> hi </span>\n</div>`')
    assert.equal(out, 'html`<div class="a"><span>hi</span></div>`')
  })

  it('still minifies a `css` tagged template', () => {
    // These are whole component sheets (ui/client-admin.js), and the
    // library minifies them down a different path — one the style
    // attribute fix must not take with it.
    const out = minify('css`.a {  color : red ;  }`')
    assert.equal(out, 'css`.a{color:red}`')
  })

  it('passes a file with no templates through untouched', () => {
    assert.equal(minifyLitSource('export const a = 1\n', 'probe.js'), null)
  })
})
