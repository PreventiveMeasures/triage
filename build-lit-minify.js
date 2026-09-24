// The Lit-template minifier the build runs over every source file,
// kept here rather than inline in build.js so a test can hold it to
// what it must not do.
//
// `minify-html-literals` collapses the static parts of `html` and
// `css` tagged templates. It does that by joining a template's parts
// around a placeholder — `@TEMPLATE_EXPRESSION();` — running the
// result through html-minifier-terser, and splitting the output back
// apart on the placeholder.
//
// That placeholder ENDS IN A SEMICOLON, which is a declaration
// separator, so inside a `style` attribute everything after an
// expression is a new declaration to the CSS minifier — and an
// invalid one:
//
//     style="--w: ${n}ch"     → style="--w:${n}"        the unit, gone
//     style="--w: ${n}ch; color: red"
//                             → style="--w:${n}"        and the rest with it
//
// The value the expression was meant to carry a unit for then reaches
// the page as a bare number, and the declaration that reads it —
// `calc(var(--w) + 1.4rem)`, `animation-duration: var(--w)` — is
// invalid at computed-value time and drops. In dev this never
// happens: `serve` doesn't minify, so the templates work in devtools
// and break only once built. It cost us a gutter that collapsed the
// export preview into one column (`--evd-lineno-width: ${…}ch`) and a
// terminal note that stopped fading (`--dwell-out: ${…}ms`).
//
// So the HTML path minifies with CSS minification off: whitespace,
// comments and attribute collapsing still run, style attributes and
// `<style>` blocks come through as written. `css` tagged templates
// take a different path inside the library (`strategy.minifyCSS`). Its
// bundled clean-css does not understand @container: it drops the wrapper
// and leaks some of the narrow-layout rules into the global stylesheet.
// Use esbuild for static CSS templates, just as for imported CSS files.
// Leave interpolated CSS untouched: the library's semicolon placeholder
// is not a valid stand-in for arbitrary CSS values, units, or selectors.
import { transformSync } from 'esbuild'
import { defaultShouldMinifyCSS, defaultStrategy, minifyHTMLLiterals } from 'minify-html-literals'

const litStrategy = {
  ...defaultStrategy,
  minifyHTML: (html, options = {}) => defaultStrategy.minifyHTML(html, { ...options, minifyCSS: false }),
  minifyCSS: (css) => transformSync(css, { loader: 'css', minify: true }).code.trim(),
}

// Returns the minified source, or null when the file holds no
// tagged templates to minify (the library's own "nothing to do").
export function minifyLitSource(source, fileName) {
  const result = minifyHTMLLiterals(source, {
    fileName, strategy: litStrategy,
    shouldMinifyCSS: (template) => template.parts.length === 1 && defaultShouldMinifyCSS(template),
  })
  return result ? result.code : null
}
