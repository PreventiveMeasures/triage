import Prism from 'prismjs/prism.js'

function literalValue(token) {
  let text = token.content
  if (token.type === 'template-string' && Array.isArray(text)) {
    if (text.some(part => typeof part === 'string' || !['template-punctuation', 'string'].includes(part.type)
        || typeof part.content !== 'string')) return null
    text = text.map(part => part.content).join('')
  } else if (token.type !== 'string') return null
  if (typeof text !== 'string' || text.length < 2 || !['"', "'", '`'].includes(text[0]) || text.at(-1) !== text[0]) return null
  // Escaped/interpolated spellings differ across languages. Only exact
  // literal text is a portable path; don't reinterpret source as JS here.
  const value = text.slice(1, -1)
  return /[\\\r\n]/u.test(value) ? null : value
}

function attribute(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

// Serialize Prism's token tree, so quoted comments and regexes never become
// links. Preserve nested syntax and hooks, and encode source text exactly once.
export function stringifySourceLinks(tokens, language, resolveString) {
  if (typeof tokens === 'string') return Prism.util.encode(tokens)
  if (Array.isArray(tokens)) return tokens.map(token => stringifySourceLinks(token, language, resolveString)).join('')
  const value = literalValue(tokens)
  const target = value === null ? null : resolveString?.(value)
  const content = stringifySourceLinks(tokens.content, language, target ? null : resolveString)
  const markup = Prism.Token.stringify({ ...tokens, content }, language)
  if (!target) return markup
  return `<button type="button" class="bundle-source-link" data-bundle-source-link="${attribute(target)}" title="Open ${attribute(target)}">${markup}</button>`
}
