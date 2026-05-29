// Prism syntax highlighter — loaded ONLY when the bundle
// source viewer opens a file whose extension we know how to
// highlight. Built as a separate esbuild entry point so prismjs
// (~50KB minified for the core + the languages we care about)
// doesn't land in the main view.js bundle. `view/prism-highlight.js`
// `await import('./prism.js')`s this file lazily on first
// use; the dynamic import URL is a runtime string so esbuild leaves
// it alone and the browser resolves it against the page's URL.
// prismjs/prism.js publishes itself to `window.Prism` as a side
// effect of its IIFE, so the language packs (plain scripts that
// reference `Prism` as a free global) resolve correctly once they
// run. ES module evaluation order matches the import order here,
// so base-grammar chains stay correct: clike must precede the
// javascript/typescript that extend it (→ jsx/tsx), markup before html.
import Prism from 'prismjs/prism.js'
import 'prismjs/components/prism-markup.js'
import 'prismjs/components/prism-clike.js'
import 'prismjs/components/prism-javascript.js'
import 'prismjs/components/prism-jsx.js'
import 'prismjs/components/prism-typescript.js'
import 'prismjs/components/prism-tsx.js'
import 'prismjs/components/prism-json.js'
import 'prismjs/components/prism-css.js'
import 'prismjs/components/prism-yaml.js'
import 'prismjs/components/prism-bash.js'
import 'prismjs/components/prism-markdown.js'
import 'prismjs/components/prism-solidity.js'

// Suppress auto-highlightAll. Prism checks `manual` from a
// DOMContentLoaded callback, which fires after this module body
// runs, so setting it here is in time.
Prism.manual = true

// Returns highlighted HTML for `code` under `lang`, or null when
// the language isn't loaded. Caller falls back to plain text on
// null. Prism.highlight does its own escaping of the source, so
// the returned string is safe to inject via unsafeHTML.
export function highlight(code, lang) {
  const grammar = Prism.languages[lang]
  if (!grammar) return null
  return Prism.highlight(code, grammar, lang)
}

export function supports(lang) {
  return Boolean(Prism.languages[lang])
}
