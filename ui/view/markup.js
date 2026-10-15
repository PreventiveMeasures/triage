// The one way markup written as a string reaches the page. Lit escapes
// everything bound into its templates; a string that is meant as markup —
// an icon, Prism's colouring of some code — goes in through `appMarkup()`
// here (in place of Lit's `unsafeHTML`), and through `trustedHTML` for the
// few sinks outside Lit (trusted-types.js), and both check it first.
//
// The check is an allowlist of the markup this app writes and nothing
// else: the SVG icons in icons.js, file-display.js and report-logos.js;
// Prism's token spans; the bundle source links Prism's output carries
// (prism-source-links.js); the marks control-chars.js and the compare
// view lay over it; the export preview's line rows. A tag that isn't one of
// those, an attribute it doesn't take, or a value outside what it allows,
// and the whole string is drawn as the text it is instead, and reported.
// So a renderer that one day hands a report's or GitHub's text over as
// markup shows that text; no link, image, form, frame or style of the
// text's own reaches the page.
//
// Rejecting rather than cleaning keeps this small: the shapes allowed are
// few and known, each tag is read whole by one pattern, and a string either
// is made only of them or is text. Nothing is parsed, so what is checked
// is what the browser reads: only lowercase names, double-quoted values,
// the HTML parser's own whitespace, and no comment, declaration or
// processing instruction, since none of the app's markup has one.
import { nothing } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'

const ANY = /^/u
const TRUE = /^true$/u
// An SVG presentation value: numbers, names, colours, path data,
// transforms. No `:` or `/`, so no `url()` reaching off the page.
const SVG = /^[\w .,#%()-]*$/u
const PAINT = Object.fromEntries(['fill', 'fill-opacity', 'fill-rule', 'clip-rule', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-opacity', 'stroke-dasharray', 'opacity', 'transform'].map(name => [name, SVG]))
const shape = (...names) => ({ ...PAINT, ...Object.fromEntries(names.map(name => [name, SVG])) })

// Prism's token names — every name and alias a token of the grammars
// ui/prism.js bundles can carry, and the languages' own names — so a token's
// span names a token and not one of the app's own classes, some of which pin
// an element over the page. Written out here rather than read off Prism as it
// loads: a page left open across a deploy loads the newer Prism, and the copy
// of this module that Prism imports is the newer build's, not the one the
// page checks with, so the page's list would stay empty and all its code be
// drawn as text. tests/markup.test.js holds the list to the grammars.
// `language-…` is the markdown grammar's mark for a fence's language, and no
// app style matches it.
export const TOKEN_NAMES = Object.freeze(`
annotation argument-name assign-left at atom atrule attr-equals attr-name attr-value attribute
attribute-class-name attribute-content backtick-quoted-string base-clause bash blockquote bold boolean
builtin c cdata char class-name class-name-definition class-name-fully-qualified clike closure-params
closure-punctuation code code-block code-language code-snippet command command-literal comment constant
content conversion-option cpp css datetime decorator delimiter directive directive-hash doctype doctype-tag
double-colon double-quoted-string entity environment expression file-descriptor for-or-select format-spec
fragment-specifier front-matter front-matter-block function function-definition function-name
function-variable generic generic-function generics global hashbang heredoc-string hr html import important
included-cdata internal-subset interpolation interpolation-punctuation italic java javascript js json jsx
key keyword lifetime-annotation list literal-property macro macro-name markdown markup markup-templating
mathml md method-definition module module-declaration name named-entity namespace nowdoc-string null number
objc objectivec operator package parameter php plain plain-text plaintext prolog property punctuation py
python raw-string rb regex regex-delimiter regex-flags regex-literal regex-source return-type rss ruby rule
rust scalar scope script script-punctuation selector selector-function-argument sh shebang shell
single-quoted-string sol solidity special-attr spread ssml static static-context strike string
string-interpolation string-literal string-property style svg symbol table table-data table-data-rows
table-header table-header-row table-line tag template-punctuation template-string text this title
triple-quoted-string ts tsx txt type-casting type-declaration type-definition type-hint typescript url
url-reference value variable version webmanifest xml yaml yml
`.trim().split(/\s+/u))
const TOKENS = new Set(TOKEN_NAMES)
const tokenClass = value => {
  const [first, ...rest] = value.split(' ')
  return first === 'token' && rest.every(word => TOKENS.has(word) || /^language-[\w-]+$/u.test(word))
}
const SPAN_CLASS = { test: value => tokenClass(value) || /^(?:code-control|evd-lineno|report-logo brand-[\w-]+)$/u.test(value) }

// Element → attribute → the pattern its whole value must match (`test`).
const ELEMENTS = {
  __proto__: null,
  // Prism's tokens (`title` on an entity), a control character's mark, an
  // export row's line number, a report logo's sticker, a bare label.
  span: { class: SPAN_CLASS, title: ANY, 'data-tooltip': ANY, 'aria-hidden': TRUE },
  mark: { class: /^diff-word$/u },
  code: { class: /^evd-line$/u },
  button: { type: /^button$/u, class: /^bundle-source-link$/u, 'data-bundle-source-link': ANY },
  a: { class: /^source-node-doc$/u, href: /^https:\/\/nodejs\.org\/api\/[\w/-]+\.html(?:#[\w-]*)?$/u, target: /^_blank$/u, rel: /^noopener noreferrer$/u, 'aria-label': ANY },
  svg: { ...shape('viewBox', 'width', 'height'), class: /^file-icon(?: brand-[\w-]+)?$/u, 'aria-hidden': TRUE },
  g: PAINT,
  path: { ...shape('d'), class: /^(?:bg|fg)$/u },
  rect: shape('x', 'y', 'width', 'height', 'rx', 'ry'),
  circle: shape('cx', 'cy', 'r'),
  ellipse: shape('cx', 'cy', 'rx', 'ry'),
  line: shape('x1', 'y1', 'x2', 'y2'),
  polyline: shape('points'),
  polygon: shape('points'),
}

// One tag, read whole: an open tag's name and attributes, or a close tag's
// name. `[\t\n\f\r ]` is the HTML parser's whitespace, not JavaScript's.
const TAG = /<(?:([a-z]+)((?:[\t\n\f\r ]+[a-zA-Z][\w-]*="[^"]*")*)[\t\n\f\r ]*\/?|\/([a-z]+)[\t\n\f\r ]*)>/uy
const ATTRIBUTE = /([a-zA-Z][\w-]*)="([^"]*)"/gu

// Whether `html` is made only of the markup this app writes.
export function isAppMarkup(html) {
  if (typeof html !== 'string') return false
  for (let at = html.indexOf('<'); at !== -1; at = html.indexOf('<', TAG.lastIndex)) {
    TAG.lastIndex = at
    const [, open, attributes, close] = TAG.exec(html) ?? []
    const allowed = ELEMENTS[open ?? close]
    if (!allowed) return false
    for (const [, name, value] of attributes?.matchAll(ATTRIBUTE) ?? []) {
      if (!Object.hasOwn(allowed, name) || !allowed[name].test(value)) return false
    }
  }
  return true
}

// What a string turned away is drawn as instead: its own text, reported.
export function refusedMarkup(html) {
  console.error('Not markup this app writes, shown as text instead:', html.length > 300 ? `${html.slice(0, 300)}…` : html)
  return html
}

// The strings already checked, so the same icon or the same file's
// colouring isn't read again on every render. Bounded: dropped whole when
// full, which costs one more read of what is still shown.
const checked = new Set()

// `unsafeHTML` for the app's own markup: `html` drawn as markup when it is
// that, as text when it isn't. Nothing, null and undefined draw nothing.
export function appMarkup(html) {
  if (html == null || html === nothing) return html
  if (checked.has(html)) return unsafeHTML(html)
  if (!isAppMarkup(html)) return refusedMarkup(String(html))
  if (checked.size >= 256) checked.clear()
  checked.add(html)
  return unsafeHTML(html)
}
