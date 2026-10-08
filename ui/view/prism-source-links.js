import Prism from 'prismjs/prism.js'
import { NODEJS_MARK_PATH } from './icons.js'
import { nodeApiDocUrl, nodeBuiltinName } from './node-api-docs.js'
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

function nodeApiLink(name) {
  const label = attribute(`Node.js docs for node:${name}`)
  return `<a class="source-node-doc" href="${attribute(nodeApiDocUrl(name))}" target="_blank" rel="noopener noreferrer" data-tooltip="${label}" aria-label="${label}">`
    + `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${NODEJS_MARK_PATH}"></path></svg></a>`
}

const NODE_API_LANGUAGES = new Set(['javascript', 'jsx', 'typescript', 'tsx'])
// What leads a specifier: `require(`, esbuild's `__require(`, `import(`, `from`
// or a bare `import`. `\0` stands for blanked comments and literals.
const IMPORT_BEFORE = /(?<![\p{ID_Continue}$.#])(?:((?:__)?require|import)[\s\0]*\(|from|import)[\s\0]*$/u
const CALL_AFTER = /^[\s\0]*[),]/u

// Line ends to mark with a link to the Node.js docs: lines that import one
// built-in module by a literal specifier the bundle does not link.
function nodeApiMarks(tokens, language, resolve) {
  if (!resolve || !NODE_API_LANGUAGES.has(language)) return []
  const pieces = []
  const literals = []
  let length = 0
  function walk(token, blank) {
    if (typeof token === 'string') {
      pieces.push(blank ? token.replaceAll(/[^\r\n]/gu, '\0') : token)
      length += token.length
    } else if (Array.isArray(token)) {
      for (const child of token) walk(child, blank)
    } else {
      const start = length
      walk(token.content, blank || /comment|string|regex/u.test(token.type))
      const value = blank ? null : literalValue(token)
      const name = nodeBuiltinName(value)
      if (name && !resolve(value)) literals.push({ start, end: length, name })
    }
  }
  walk(tokens, false)
  if (literals.length === 0) return []
  const code = pieces.join('')
  const lines = new Map()
  for (const { start, end, name } of literals) {
    const before = IMPORT_BEFORE.exec(code.slice(Math.max(0, start - 256), start))
    if (!before || before[1] && !CALL_AFTER.test(code.slice(end, end + 256))) continue
    // Before a CRLF's CR: alone, the HTML parser would read it as a newline.
    let at = code.indexOf('\n', end)
    if (at === -1) at = code.length
    else if (code[at - 1] === '\r') at--
    lines.set(at, lines.has(at) && lines.get(at) !== name ? null : name)
  }
  return [...lines].filter(([, name]) => name).map(([at, name]) => ({ at, html: nodeApiLink(name) }))
}

function append(parts, part) {
  if (parts.at(-1)?.link === part.link) parts.at(-1).html += part.html
  else parts.push(part)
}

// Serialize Prism's token tree, so quoted comments and regexes never become
// links. Preserve nested syntax and hooks, and encode source text exactly once.
// Node.js doc links go at the end of their lines, inside any open token.
export function stringifySourceLinks(tokens, language, resolve) {
  const links = sourceNameLinks(tokens, language, resolve)
  const marks = nodeApiMarks(tokens, language, resolve)
  let offset = 0
  let next = 0
  let mark = 0
  function stringify(token, resolveLiteral) {
    if (typeof token === 'string') {
      const parts = []
      const end = offset + token.length
      let start = 0
      while (offset < end) {
        if (marks[mark]?.at === offset) {
          parts.push({ link: null, html: marks[mark++].html })
          continue
        }
        while (links[next]?.end <= offset) next++
        const candidate = links[next]
        const link = candidate?.start <= offset ? candidate : null
        const stop = Math.min(end, (link ? link.end : candidate?.start) ?? end, marks[mark]?.at ?? end)
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
  const parts = stringify(tokens, resolve)
  // A last line without a newline ends the source.
  for (const { html } of marks.slice(mark)) parts.push({ link: null, html })
  return parts.map(({ link, html }) => link ? button(html, link.target) : html).join('')
}
