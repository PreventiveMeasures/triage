// Prism, an esbuild entry of its own (~50KB) that view/prism-highlight.js
// imports by a runtime string the first time a known language is
// highlighted. prismjs/prism.js publishes `window.Prism`, which the language
// packs use as a free global, in import order: a base grammar precedes those
// extending it (clike → javascript/typescript → jsx/tsx, c, java, ruby;
// c → cpp, objectivec; markup → markup-templating → php → php-extras).
import Prism from 'prismjs/prism.js'
import { stringifySourceLinks } from './view/prism-source-links.js'
import { scanTemplateLiterals } from './view/prism-template-literals.js'
import { allowTokenNames } from './view/markup.js'
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
import 'prismjs/components/prism-rust.js'
import 'prismjs/components/prism-c.js'
import 'prismjs/components/prism-cpp.js'
import 'prismjs/components/prism-objectivec.js'
import 'prismjs/components/prism-java.js'
import 'prismjs/components/prism-ruby.js'
import 'prismjs/components/prism-python.js'
import 'prismjs/components/prism-markup-templating.js'
import 'prismjs/components/prism-php.js'
import 'prismjs/components/prism-php-extras.js'

// No highlightAll: Prism reads this on DOMContentLoaded, after this module runs.
Prism.manual = true

// After every grammar above, so each copy of the JavaScript rule is there to
// rewire (view/prism-template-literals.js says why).
scanTemplateLiterals(Prism)

// Every name and alias a token of the grammars above can carry, and the
// languages' own names, for view/markup.js to tell Prism's spans from
// the app's own classes.
allowTokenNames(tokenNames(Prism.languages))
function tokenNames(languages) {
  const names = new Set()
  const seen = new Set()
  const walk = (grammar) => {
    if (!grammar || typeof grammar !== 'object' || seen.has(grammar)) return
    seen.add(grammar)
    for (const [name, rules] of Object.entries(grammar)) {
      if (name === 'rest') { walk(rules); continue }
      names.add(name)
      for (const rule of [rules].flat()) {
        if (rule instanceof RegExp) continue
        for (const alias of [rule?.alias ?? []].flat()) names.add(alias)
        walk(rule?.inside)
      }
    }
  }
  // Two tokens no grammar names: markup-templating's, named after the
  // language it embeds, and the text jsx gathers between tags.
  names.add('plain-text')
  for (const [language, grammar] of Object.entries(languages)) {
    names.add(language)
    walk(grammar)
  }
  return names
}

// Highlighted, escaped HTML for view/markup.js's `appMarkup`, or null for a
// language not loaded. A bundle viewer's resolver links strings, PHP names
// and Rust paths to its sources.
export function highlight(code, lang, resolveString = null) {
  const grammar = Prism.languages[lang]
  if (!grammar) return null
  if (resolveString) {
    const env = { code, grammar, language: lang }
    Prism.hooks.run('before-tokenize', env)
    env.tokens = Prism.tokenize(env.code, env.grammar)
    Prism.hooks.run('after-tokenize', env)
    return stringifySourceLinks(env.tokens, env.language, resolveString)
  }
  return Prism.highlight(code, grammar, lang)
}
