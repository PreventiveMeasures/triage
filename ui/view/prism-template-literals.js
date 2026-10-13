// Template literals for Prism's JavaScript family, found by scanning rather
// than by its regular expression.
//
// Prism finds a template literal with one regex, and a regex can't count:
// a `${…}` in it may nest braces two deep at most, and every brace counts,
// those in a string or a regex too. A lit template whose handler builds an
// object (`@click=${() => { fire(new CustomEvent(n, { detail: { … } })) }}`)
// is deeper than that, so the match ends at the wrong brace or fails at the
// opening backtick. Prism then pairs the backticks left over the other way
// round, and everything after reads inverted: the template's markup coloured
// as code, the code between templates as a string, down to the file's end.
//
// So here a template runs to its closing backtick as the language reads it:
// braces counted in a `${…}`, at any depth; a quote, a comment or a regex
// literal in one skipped whole; a template in one its own nested template.
// Outside templates too, a backtick in a string, a comment or a regex
// (`.replace(/`/g, "\\`")`) opens nothing.
//
// What a slash starts is a guess from what comes before it, though, and a
// wrong one inside a `${…}` (a regex taken for division, so its backtick
// opens a template; division taken for a regex, so it swallows the `}`)
// leaves the template open to the end of the text, which Prism's regex,
// blind to what a `${…}` holds, never did. So a template or a `${…}` the
// scan leaves open is matched by Prism's own pattern instead: a misread
// costs what it did before this module, not the rest of the file.
//
// Prism matches a pattern by setting its `lastIndex` and calling `exec`, and
// reads the match's text and `index`, so an object with those stands in for
// the regex. Its `global` keeps a greedy rule from being rebuilt as a RegExp
// from a `source` it doesn't have.

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

// Whether a `/` here may start a regex rather than divide: Prism's own rule
// for its regex token (not after a name, a number, a literal or a closing
// bracket), and after a keyword that ends a statement's start or an operand.
// Not after a postfix `++` or `--` either, which ends an operand too: there
// is no incrementing a regex. Nor, in JSX and TSX, at the `</` of a closing
// tag (`</p>`, `</Foo.Bar>`, `</组件>`, `</>`), though a regex may follow a `<` there
// too: one that opens with what reads as a tag's name and `>` is left to
// misread. JavaScript and TypeScript have no tags, so in them `</` is a
// comparison with a regex (`i</x/.exec(s).index`), whatever follows.
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

// What may follow a regex literal, its flags aside: a line's or the text's
// end, a comment, punctuation that closes an operand (`.test`, `,`, `)`) —
// Prism's lookahead for its regex token — or an operator joining it to the
// next (`/`/ && ok`). What looks like one followed by anything else is a
// division with a slash further on: `${/a/ / 2}/${n}`.
const REGEX_FOLLOWED = /[a-z]*[^\S\n\r\u2028\u2029]*(?:$|[\n\r\u2028\u2029,.;:})\]?&|+\-*%=!^<>]|\/[/*]|in(?:stanceof)?(?![$\w]))/uy

// Where the scan of the last slash that looked like a regex and wasn't one
// stopped, in the text being scanned: a `/` before that divides. Without it a
// long line of `(/[` would rescan to the line's end from every slash. A regex
// that does start in between goes unread as one, on a line already misread.
let regexFailedAt = -1

// Past the comment or regex literal a `/` starts, or past the `/` alone when
// it divides. A regex can't cross a line end either: one that would is read
// as division.
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

// Texts the scan left something open in, and how many times. Past a few,
// Prism's pattern takes every match in the text, so one that fails over and
// over isn't rescanned to its end each time. Kept for one tokenizing: Prism's
// hooks clear it before and after each, so one highlight's count never
// carries into the next, of the same text or another.
const unclosed = new Map()
const UNCLOSED_MAX = 4

// A rule's matcher: the scan, and Prism's own pattern for it (`stock`, made
// global) where the scan leaves the match open. A template's pattern searches
// from the backtick the scan found, past those in strings and comments; a
// `${…}`'s from where Prism asked, for its lookbehind group to read the
// escapes before the `$`, a group cut off here as Prism would.
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

// Every JavaScript-family grammar carries its own copy of the rule (Prism's
// `extend` clones it into TypeScript, JSX and TSX, and into the grammars that
// embed one: markup's `<script>`, TypeScript's types), so this walks them all
// and rewires each copy it finds, once: a copy can sit in two grammars (JSX
// shares its own with the JavaScript clone its `${…}` reads code by). The
// copies JSX and TSX lead to read `</` as a closing tag; JavaScript's own and
// TypeScript's, met first, from their own names or markup's `<script>`, don't.
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
        // The scanner cuts the lookbehind group from a match of Prism's own
        // pattern itself; its own matches have none to cut.
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
