// Template literals for Prism's JavaScript family, found by scanning rather
// than by its regex. A regex can't count: Prism's nests `${…}` braces two
// deep at most, counting those in strings and regexes too, so a lit
// template whose handler builds an object ends at the wrong brace, and the
// leftover backticks pair the other way round — inverting the highlighting
// to the end of the file.
//
// The scan reads a template as the language does: braces counted in a
// `${…}` at any depth; strings, comments and regex literals in one skipped
// whole; a nested template its own. Outside templates too, a backtick in a
// string, comment or regex opens nothing. A slash's meaning is a guess from
// what precedes it, and a wrong one inside a `${…}` would leave the
// template open to the end of the text — so a template or `${…}` the scan
// leaves open is matched by Prism's own pattern instead: a misread costs
// what it did before, not the rest of the file.
//
// Prism matches by setting `lastIndex` and calling `exec`, reading the
// match's text and `index`, so an object with those stands in for the
// regex; its `global` keeps a greedy rule from being rebuilt as a RegExp.

// Stack entries: a template, or a `${…}` counting the braces opened in it
// and not closed yet.
const TEMPLATE = -1

// A line terminator: what ends a line comment, and what a regex literal can't
// hold. A string can hold the last two, so it stops at the first two only.
const LINE_END = /[\n\r\u2028\u2029]/gu

function isLineEnd(c) {
  return c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029'
}

// A quoted string ends at its closing quote; one cut by a line end (it can't
// cross one) stops there, so a stray quote costs a line at most.
function quotedEnd(text, at) {
  const quote = text[at]
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i]
    if (c === quote) return i + 1
    if (c === '\n' || c === '\r') return i
    if (c === '\\') i += text.startsWith('\r\n', i + 1) ? 2 : 1
  }
  return text.length
}

// Whether a `/` here may start a regex rather than divide: Prism's rule
// (not after a name, number, literal or closing bracket), or after a
// keyword that leaves an operand to come; never after a postfix `++` /
// `--`. In JSX and TSX not at a closing tag's `</` (`</p>`, `</Foo.Bar>`,
// `</组件>`, `</>`) — a regex there that reads as a tag name and `>` is left
// misread; in JavaScript and TypeScript `</` is a comparison with a regex
// (`i</x/.exec(s).index`).
const DIVIDES_AFTER = /[$\w\u00A0-\uFFFF.'"`)\]]/u
const KEYWORD_BEFORE = /(?:^|[^$\w\u00A0-\uFFFF.])(?:await|case|delete|do|else|in|instanceof|new|of|return|throw|typeof|void|yield)$/u
const JSX_CLOSE_REST = /\s*(?:[\p{ID_Start}$_][\p{ID_Continue}$.:-]*\s*)?>/uy

// Whether the grammar being scanned is JSX or TSX: set by each scan.
let jsx = false

function regexMayStart(text, at) {
  JSX_CLOSE_REST.lastIndex = at + 1
  if (jsx && text[at - 1] === '<' && JSX_CLOSE_REST.test(text)) return false
  let i = at - 1
  while (i >= 0 && /\s/u.test(text[i])) i--
  if (i < 0) return true
  if ((text[i] === '+' || text[i] === '-') && text[i - 1] === text[i]) return false
  if (!DIVIDES_AFTER.test(text[i])) return true
  return KEYWORD_BEFORE.test(text.slice(Math.max(0, i - 10), i + 1))
}

// What may follow a regex literal past its flags: a line or text end, a
// comment, punctuation closing an operand (Prism's lookahead), or an
// operator (`/`/ && ok`). Anything else makes it a division with a slash
// further on: `${/a/ / 2}/${n}`.
const REGEX_FOLLOWED = /[a-z]*[^\S\n\r\u2028\u2029]*(?:$|[\n\r\u2028\u2029,.;:})\]?&|+\-*%=!^<>]|\/[/*]|in(?:stanceof)?(?![$\w]))/uy

// Where the scan of the last would-be regex that wasn't one stopped: a `/`
// before that divides, so a long line of `(/[` isn't rescanned from every
// slash (a real regex in between goes unread, on a line already misread).
let regexFailedAt = -1

// Past the comment or regex literal a `/` starts, or past the `/` alone
// when it divides (as is a would-be regex crossing a line end).
function slashEnd(text, at) {
  const next = text[at + 1]
  if (next === '/') {
    LINE_END.lastIndex = at
    return LINE_END.exec(text)?.index ?? text.length
  }
  if (next === '*') {
    const end = text.indexOf('*/', at + 2)
    return end === -1 ? text.length : end + 2
  }
  if (at < regexFailedAt || !regexMayStart(text, at)) return at + 1
  let i = at + 1
  for (let inClass = false; i < text.length; i++) {
    const c = text[i]
    if (isLineEnd(c) || (c === '\\' && isLineEnd(text[i + 1]))) break
    if (c === '\\') i++
    else if (inClass) inClass = c !== ']'
    else if (c === '[') inClass = true
    else if (c === '/') {
      REGEX_FOLLOWED.lastIndex = i + 1
      if (REGEX_FOLLOWED.test(text)) return i + 1
      break
    }
  }
  regexFailedAt = i
  return at + 1
}

// Past the code at `at` that can hide a backtick or a brace: a string, a
// comment, a regex. Anything else is one character.
function codeStep(text, at) {
  const c = text[at]
  if (c === '"' || c === "'") return quotedEnd(text, at)
  if (c === '/') return slashEnd(text, at)
  return at + 1
}

// Past the end of what `stack` holds open from `at`, the closing backtick or
// brace, or -1 when the text ends first.
function closeEnd(text, at, stack) {
  while (stack.length > 0 && at < text.length) {
    const top = stack.length - 1
    const c = text[at]
    if (stack[top] === TEMPLATE) {
      if (c === '\\') at += 2
      else if (c === '`') { stack.pop(); at++ }
      else if (c === '$' && text[at + 1] === '{') { stack.push(0); at += 2 }
      else at++
    } else if (c === '`') { stack.push(TEMPLATE); at++ }
    else if (c === '{') { stack[top]++; at++ }
    else if (c === '}') {
      if (stack[top] === 0) stack.pop()
      else stack[top]--
      at++
    } else at = codeStep(text, at)
  }
  return stack.length > 0 ? -1 : at
}

// The first template opening in the code from `from`, and its end or -1,
// which Prism calls at the start of a stretch no earlier rule took: the
// text's or the one after a comment, or after the last template matched.
function nextTemplate(text, from) {
  for (let at = from; at < text.length;) {
    if (text[at] === '`') return [at, closeEnd(text, at + 1, [TEMPLATE])]
    at = codeStep(text, at)
  }
  return null
}

// The first `${…}` in a template's text from `from`, and its end or -1, which
// Prism calls at the text's start and after each `${…}` matched in it.
function nextInterpolation(text, from) {
  for (let at = from; at < text.length - 1; at++) {
    if (text[at] === '\\') at++
    else if (text[at] === '$' && text[at + 1] === '{') return [at, closeEnd(text, at + 2, [0])]
  }
  return null
}

// Texts the scan left something open in, and how often: past a few,
// Prism's pattern takes every match, so a text failing over and over isn't
// rescanned to its end each time. Cleared around each tokenizing (Prism's
// hooks), so counts never carry into the next highlight.
const unclosed = new Map()
const UNCLOSED_MAX = 4

// A rule's matcher: the scan, falling back to Prism's own pattern (`stock`,
// made global) where the scan leaves the match open. A template's pattern
// searches from the backtick the scan found; a `${…}`'s from where Prism
// asked, so its lookbehind group can read the escapes before the `$` (the
// group cut off here, as Prism would).
function scanner(find, stock, lookbehind, inJsx) {
  return {
    global: true,
    lastIndex: 0,
    exec(text) {
      regexFailedAt = -1
      jsx = inJsx
      stock.lastIndex = this.lastIndex
      if (unclosed.size === 0 || (unclosed.get(text) ?? 0) < UNCLOSED_MAX) {
        const found = find(text, this.lastIndex)
        if (!found) return null
        const [start, end] = found
        if (end !== -1) return Object.assign([text.slice(start, end)], { index: start })
        unclosed.set(text, (unclosed.get(text) ?? 0) + 1)
        if (!lookbehind) stock.lastIndex = start
      }
      const match = stock.exec(text)
      if (match && lookbehind && match[1]) {
        match.index += match[1].length
        match[0] = match[0].slice(match[1].length)
      }
      return match
    },
  }
}

function globalCopy(pattern) {
  return new RegExp(pattern.source, pattern.global ? pattern.flags : `${pattern.flags}g`)
}

// Prism's `extend` clones the rule into every JavaScript-family grammar and
// those embedding one (markup's `<script>`, TypeScript's types), so all are
// walked and each copy rewired once (a copy can sit in two grammars). The
// copies reached from JSX and TSX read `</` as a closing tag; JavaScript's
// and TypeScript's own, met first, don't.
export function scanTemplateLiterals({ languages, hooks }) {
  const seen = new Set()
  const visit = (grammar, inJsx) => {
    if (!grammar || typeof grammar !== 'object' || grammar instanceof RegExp || seen.has(grammar)) return
    seen.add(grammar)
    for (const [key, rule] of Object.entries(grammar)) {
      if (key === 'template-string' && rule?.pattern instanceof RegExp && rule.inside?.interpolation) {
        const { interpolation } = rule.inside
        rule.pattern = scanner(nextTemplate, globalCopy(rule.pattern), false, inJsx)
        interpolation.pattern = scanner(nextInterpolation, globalCopy(interpolation.pattern), Boolean(interpolation.lookbehind), inJsx)
        // The scanner cuts the lookbehind group itself.
        delete interpolation.lookbehind
      }
      visit(rule, inJsx)
    }
  }
  for (const [name, grammar] of Object.entries(languages)) visit(grammar, name === 'jsx' || name === 'tsx')
  const forget = () => unclosed.clear()
  hooks.add('before-tokenize', forget)
  hooks.add('after-tokenize', forget)
}
