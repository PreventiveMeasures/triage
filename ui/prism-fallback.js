// Prism syntax highlighter fallback — loaded ONLY when the bundle
// source viewer opens a file whose extension we know how to
// highlight. Built as a separate esbuild entry point so prismjs
// (~50KB minified for the core + the languages we care about)
// doesn't land in the main view.js bundle. `view/prism-highlight.js`
// `await import('./prism-fallback.js')`s this file lazily on first
// use; the dynamic import URL is a runtime string so esbuild leaves
// it alone and the browser resolves it against the page's URL.
import Prism from 'prismjs/prism.js'

// Components reference `Prism` as a global (they're plain scripts,
// not modules), so attach the imported namespace to globalThis
// before pulling in the language packs. The `await import()` chain
// below ensures execution order: each language imports run AFTER
// this assignment, even though static imports would hoist past it.
Prism.manual = true
globalThis.Prism = Prism

// Languages to support out of the box. Each component registers
// itself on `Prism.languages` as a side-effect — once loaded,
// `highlight()` below can pick it up by name. clike is a base
// grammar that javascript / typescript extend; markup is a base
// for html. Order within each chain matters; await keeps it.
await import('prismjs/components/prism-markup.js')
await import('prismjs/components/prism-clike.js')
await import('prismjs/components/prism-javascript.js')
await import('prismjs/components/prism-jsx.js')
await import('prismjs/components/prism-typescript.js')
await import('prismjs/components/prism-tsx.js')
await import('prismjs/components/prism-json.js')
await import('prismjs/components/prism-css.js')
await import('prismjs/components/prism-yaml.js')
await import('prismjs/components/prism-bash.js')
await import('prismjs/components/prism-markdown.js')

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
