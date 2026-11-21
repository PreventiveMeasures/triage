// Lazy prismjs highlighting: `prism.js` and its grammars load on first use,
// through a runtime import that keeps them out of the main view.js bundle.
// Languages come from a path (`langForPath`, the source viewers) or a fence
// tag (`langForTag`, description code blocks); unknown ones resolve to null,
// plain text without the download.
export { langForPath } from '../../common/code-language.js'
import { utf8ByteLength } from '../../common/utf8.js'

let loadPromise = null

function loadPrism() {
  // Through a variable, so esbuild can't resolve it into the main bundle.
  const path = './prism.js'
  return (loadPromise ??= import(path))
}

// Sources over 1 MiB stay plain text. Prism tokenizes on the main thread,
// at about a second per MiB, into markup several times the source's size,
// so a large file would freeze the viewer that opens it. The length bounds
// the byte count from below, so only a source near the limit is encoded.
const HIGHLIGHT_MAX_BYTES = 1024 * 1024
export function highlightable(code) {
  return code.length <= HIGHLIGHT_MAX_BYTES && utf8ByteLength(code) <= HIGHLIGHT_MAX_BYTES
}

// Fence tag → prism language: a HARD allowlist of exactly the grammars
// `ui/prism.js` bundles (adding a language means both lists), so an unlisted
// tag costs no ~50KB download and a report can't make the app fetch a
// grammar. Aliases are the ones reports write; null-prototype, so
// `constructor` aliases nothing. C is there because cpp and objectivec
// extend it anyway.
const TAG_TO_LANG = {
  __proto__: null,
  js: 'javascript', javascript: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  jsx: 'jsx',
  ts: 'typescript', typescript: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  css: 'css',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', markup: 'markup',
  yaml: 'yaml', yml: 'yaml',
  sh: 'bash', bash: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  md: 'markdown', markdown: 'markdown',
  sol: 'solidity', solidity: 'solidity',
  rs: 'rust', rust: 'rust',
  rb: 'ruby', ruby: 'ruby',
  py: 'python', python: 'python', py3: 'python', python3: 'python',
  php: 'php', phtml: 'php',
  java: 'java',
  cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', 'h++': 'cpp', h: 'cpp',
  c: 'c',
  objc: 'objectivec', objectivec: 'objectivec', 'objective-c': 'objectivec', m: 'objectivec', mm: 'objectivec',
}

export function langForTag(tag) {
  if (typeof tag !== 'string') return null
  return TAG_TO_LANG[tag.toLowerCase()] ?? null
}

// Highlighted HTML, or null (plain text) for an unsupported language or an
// oversized source; async for the first call's download.
export async function highlight(code, lang, resolveString = null) {
  if (!lang || !highlightable(code)) return null
  try {
    const mod = await loadPrism()
    return mod.highlight(code, lang, resolveString)
  } catch {
    return null
  }
}

// Highlighted markup as one HTML string per source line. A token can span
// lines (a markdown fence is one), so every tag open at a newline is closed
// there and reopened on the next line. String surgery suffices: the input
// is Prism's (and our source-link buttons') — no self-closing tags or
// comments, every `<` `>` `&` of the text escaped. As many entries as
// `code.split('\n')`, so callers can pair them with line numbers.
export function splitHighlightedLines(html) {
  const lines = []
  const open = []
  let current = ''
  let at = 0
  while (at < html.length) {
    const lt = html.indexOf('<', at)
    const text = lt === -1 ? html.slice(at) : html.slice(at, lt)
    const parts = text.split('\n')
    current += parts[0]
    for (let p = 1; p < parts.length; p++) {
      // Close the stack innermost-first to end the line, then reopen it
      // outermost-first to start the next one.
      for (let d = open.length - 1; d >= 0; d--) current += open[d].close
      lines.push(current)
      current = open.map((o) => o.open).join('') + parts[p]
    }
    if (lt === -1) break
    const gt = html.indexOf('>', lt)
    // Unexpected input: keep the rest verbatim.
    if (gt === -1) { current += html.slice(lt); break }
    const tag = html.slice(lt, gt + 1)
    if (tag.startsWith('</')) open.pop()
    else open.push({ open: tag, close: `</${/^<([a-zA-Z][^\s/>]*)/u.exec(tag)?.[1] ?? 'span'}>` })
    current += tag
    at = gt + 1
  }
  lines.push(current)
  return lines
}
