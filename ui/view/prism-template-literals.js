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
// (`.replace(/`/g, "\\`")`) opens nothing. A template the text never closes
// runs to its end, as it would for the parser.
//
// Prism matches a pattern by setting its `lastIndex` and calling `exec`, and
// reads the match's text and `index`, so an object with those stands in for
// the regex. Its `global` keeps a greedy rule from being rebuilt as a RegExp
// from a `source` it doesn't have.

// Stack entries: a template, or a `${…}` counting the braces opened in it
// and not closed yet.
const TEMPLATE = -1

function isNewline(c) {
  return c === '\n' || c === '\r'
}

// A quoted string ends at its closing quote; one cut by a line end (it can't
// cross one) stops there, so a stray quote costs a line at most.
function quotedEnd(text, at) {
  const quote = text[at]
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i]
    if (c === quote) return i + 1
    if (isNewline(c)) return i
    if (c === '\\') i += text.startsWith('\r\n', i + 1) ? 2 : 1
  }
  return text.length
}

// Whether a `/` here may start a regex rather than divide: Prism's own rule
// for its regex token (not after a name, a number, a literal or a closing
// bracket), and after a keyword that ends a statement's start or an operand.
// Not after a postfix `++` or `--` either, which ends an operand too: there
// is no incrementing a regex.
const DIVIDES_AFTER = /[$\w\u00A0-\uFFFF.'"`)\]]/u
const KEYWORD_BEFORE = /(?:^|[^$\w\u00A0-\uFFFF.])(?:await|case|delete|do|else|in|instanceof|new|of|return|throw|typeof|void|yield)$/u

function regexMayStart(text, at) {
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
// next (`/`/ && ok`). Not `<` or `>`, which compare nothing with a regex but
// follow the slash of a JSX tag. What looks like one followed by anything
// else is a division with a slash further on: `${/a/ / 2}/${n}`.
const REGEX_FOLLOWED = /[a-z]*[^\S\r\n]*(?:$|[\r\n,.;:})\]?&|+\-*%=!^]|\/[/*]|in(?:stanceof)?(?![$\w]))/uy

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
    const end = text.indexOf('\n', at)
    return end === -1 ? text.length : end
  }
  if (next === '*') {
    const end = text.indexOf('*/', at + 2)
    return end === -1 ? text.length : end + 2
  }
  if (at < regexFailedAt || !regexMayStart(text, at)) return at + 1
  let i = at + 1
  for (let inClass = false; i < text.length; i++) {
    const c = text[i]
    if (isNewline(c) || (c === '\\' && isNewline(text[i + 1]))) break
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

// Past the end of what `stack` holds open from `at`: the closing backtick
// or brace, or the text's end when it closes none.
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
  return Math.min(at, text.length)
}

// The first template opening in the code from `from`, which Prism calls at
// the start of a stretch no earlier rule took: the text's or the one after a
// comment, or after the last template matched.
function nextTemplate(text, from) {
  for (let at = from; at < text.length;) {
    if (text[at] === '`') return [at, closeEnd(text, at + 1, [TEMPLATE])]
    at = codeStep(text, at)
  }
  return null
}

// The first `${…}` in a template's text from `from`, which Prism calls at
// the text's start and after each `${…}` matched in it.
function nextInterpolation(text, from) {
  for (let at = from; at < text.length - 1; at++) {
    if (text[at] === '\\') at++
    else if (text[at] === '$' && text[at + 1] === '{') return [at, closeEnd(text, at + 2, [0])]
  }
  return null
}

function scanner(find) {
  return {
    global: true,
    lastIndex: 0,
    exec(text) {
      regexFailedAt = -1
      const found = find(text, this.lastIndex)
      if (!found) return null
      const [start, end] = found
      return Object.assign([text.slice(start, end)], { index: start })
    },
  }
}

// Every JavaScript-family grammar carries its own copy of the rule (Prism's
// `extend` clones it into TypeScript, JSX and TSX, and into the grammars that
// embed one: markup's `<script>`, TypeScript's types), so this walks them all
// and rewires each copy it finds.
export function scanTemplateLiterals(languages) {
  const seen = new Set()
  const visit = (grammar) => {
    if (!grammar || typeof grammar !== 'object' || grammar instanceof RegExp || seen.has(grammar)) return
    seen.add(grammar)
    for (const [key, rule] of Object.entries(grammar)) {
      if (key === 'template-string' && rule?.inside?.interpolation) {
        rule.pattern = scanner(nextTemplate)
        rule.inside.interpolation.pattern = scanner(nextInterpolation)
        // Escapes are the scanner's to read; Prism's lookbehind group was
        // the regex's way of skipping them.
        delete rule.inside.interpolation.lookbehind
      }
      visit(rule)
    }
  }
  for (const grammar of Object.values(languages)) visit(grammar)
}
