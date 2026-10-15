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

// Prism's token names, which ui/prism.js hands over as it loads (read off
// its grammars, never off the code it colours), so a token's span names a
// token and not one of the app's own classes — some of which pin an
// element over the page. `language-…` is the markdown grammar's mark for a
// fence's language, and no app style matches it.
const TOKENS = new Set()
export function allowTokenNames(names) {
  for (const name of names) TOKENS.add(name)
}
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
