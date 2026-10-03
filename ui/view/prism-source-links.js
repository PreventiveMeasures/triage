import Prism from 'prismjs/prism.js'
import { sourceNameLinks } from './prism-source-names.js'

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

function button(content, target) {
  return `<button type="button" class="bundle-source-link" data-bundle-source-link="${attribute(target)}">${content}</button>`
}

function append(parts, part) {
  if (parts.at(-1)?.link === part.link) parts.at(-1).html += part.html
  else parts.push(part)
}

// Serialize Prism's token tree, so quoted comments and regexes never become
// links. Preserve nested syntax and hooks, and encode source text exactly once.
export function stringifySourceLinks(tokens, language, resolve) {
  const links = sourceNameLinks(tokens, language, resolve)
  let offset = 0
  let next = 0
  function stringify(token, resolveLiteral) {
    if (typeof token === 'string') {
      const parts = []
      const end = offset + token.length
      let start = 0
      while (offset < end) {
        while (links[next]?.end <= offset) next++
        const candidate = links[next]
        const link = candidate?.start <= offset ? candidate : null
        const stop = Math.min(end, (link ? link.end : candidate?.start) ?? end)
        parts.push({ link, html: Prism.util.encode(token.slice(start, start + stop - offset)) })
        start += stop - offset
        offset = stop
      }
      return parts
    }
    if (Array.isArray(token)) {
      const parts = []
      for (const child of token) for (const part of stringify(child, resolveLiteral)) append(parts, part)
      return parts
    }
    const value = literalValue(token)
    const target = value === null ? null : resolveLiteral?.(value)
    const parts = stringify(token.content, target ? null : resolveLiteral)
    // Split syntax spans at link boundaries so a link across sibling tokens
    // remains one button with valid, properly nested highlighted markup.
    return parts.map(({ link, html }) => {
      const markup = Prism.Token.stringify({ ...token, content: html }, language)
      return { link, html: target ? button(markup, target) : markup }
    })
  }
  return stringify(tokens, resolve).map(({ link, html }) => link ? button(html, link.target) : html).join('')
}
