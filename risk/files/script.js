// How a script's text is read, for risk's readers of a file
// (readability.js, runs-code.js, hosts.js): JavaScript's and CSS's strings,
// regular expressions and comments, set apart from their code, what of their
// blanks a minifier drops, which files are scripts node runs, and each
// offset's line.

// Code minified into lines shorter than NPM_LONG_LINE: outside its strings and
// comments (`/* @__PURE__ */`), its lines average more than anyone writes and
// next to none of its spaces are ones a minifier drops. Told only in what
// minifiers write, as GitHub Linguist tells minified files only in JavaScript
// and CSS, each by its strings and comments (matched in one pass, so that
// neither starts inside the other, a comment with the spaces around it) and
// the spaces it can do without.
export const MINIFIED_AVERAGE = 110
const MINIFIED_SPACES = .01
// What a regular expression set aside holds.
const REGEX = '\uE000'
const JS = {
  // A hashbang, the file's first line (`#!/usr/bin/env node`), a comment,
  // after a byte order mark too, which node's ES module loader drops first.
  // A string's or template's escape may be a line continuation (`\` before a
  // line break, CRLF's whole).
  // Linear on any text: a regular expression's context looked back on only
  // before a `/`, a comment's leading blanks taken only from where they
  // start, and what is left open read to where it would end, a string or a
  // regular expression its line's end, a template or a comment the text's,
  // rather than tried again from each later quote or slash.
  // A regular expression first where a value starts (after `=>`, `...`, an operator or a keyword, not a property: `x.default/2`, `this.#in/2`), so a quote in it (`/["']/`) starts no string.
  stringOrComment: /((?=\/)(?<=(?:^|\.\.\.|[(,=:[!&|?{};>+\-*/%^<~]|(?<![\p{ID_Continue}$.#])(?:await|case|default|delete|do|else|extends|in|instanceof|new|of|return|throw|typeof|void|yield))[ \t]*)\/(?![/*])(?:[^/\\[\n]|\\.|\[(?:[^\]\\\n]|\\.)*(?:\]|(?=\\?$)))+(?:\/[a-z]*|(?=\\?$))|"(?:[^"\\\n]|\\(?:\r\n|[\s\S]))*(?:"|$)|'(?:[^'\\\n]|\\(?:\r\n|[\s\S]))*(?:'|$)|`(?:[^`\\]|\\(?:\r\n|[\s\S]))*(?:`|(?![\s\S])))|(?<![ \t])[ \t]*(?:\/\*[\s\S]*?(?:\*\/|(?![\s\S]))|\/\/.*|(?<![\s\S])\uFEFF?#!.*)[ \t]*/gmu,
  // Beside punctuation (`a, b`, `x = 1`), not between two words, as
  // JavaScript tells a word's characters (`return a`, `var π`, `var \u03c0`),
  droppable: /(?<![\p{ID_Continue}$\\\u200C\u200D])[ \t]+|[ \t]+(?![\p{ID_Continue}$\\\u200C\u200D])/gu,
  // nor between two `+`, two `-` or two `/` (`a+ +b` is no `a++b`, `a/ /b/`
  // no comment), nor after a regular expression before a word (`/a/ in b`).
  needed: (code, index, run) => ('+-/'.includes(code[index - 1]) && code[index + run.length] === code[index - 1])
    || (code[index - 2] === REGEX && /[\p{ID_Continue}$\\\u200C\u200D]/u.test(code[index + run.length])),
}
const CSS = {
  // No `//` comments, so `url(https://…)` is code.
  stringOrComment: /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|[ \t]*\/\*[\s\S]*?\*\/[ \t]*/gu,
  // Beside braces, `;`, `,`, `>`, parentheses, after `:` (`a { color: red }`)
  // and beside a selector's `+` or `~` (`.a + .b`), not those a selector or a
  // value needs (`.a .b`, `1px solid #fff`, `a :hover`),
  droppable: /(?<=[{};,:>(])[ \t]+|[ \t]+(?=[{};,>)!])|(?<=[+~])[ \t]+|[ \t]+(?=[+~])/gu,
  // nor beside `+` or `~` in parentheses (`calc(1px + var(--x))`) or in a
  // custom property's value, kept for a `calc()` to come (`--gap:1px + 2px`).
  needed: (code, index, run, depth) => /[+~]/u.test(code[index - 1] + code[index + run.length])
    && (depth > 0 || /^\s*--[^:]*:/u.test(code.slice(Math.max(...['{', ';', '}'].map(end => code.lastIndexOf(end, index))) + 1, index))),
}
// JavaScript's strings and regular expressions (the first group) and its
// comments, for a reader that sets them aside (runs-code.js, hosts.js).
export const JS_STRING_OR_COMMENT = JS.stringOrComment
// A stylesheet's by its name, else JavaScript's for a script by its name, or
// for any other where node runs it as one (`script`).
export const minifiable = (path, script = false) => /\.css$/iu.test(path) ? CSS : script || /\.[cm]?js$/iu.test(path) ? JS : null
// How much of a text is read for how its lines are minified: their average
// is told by as much of them, and a text of millions of lines is read no
// further.
const MINIFIED_READ = 4 * 1024 * 1024
// Its code's lines' average length where they are minified into short ones,
// else 0, told by its first MINIFIED_READ characters.
export function minifiedAverage(whole, { stringOrComment, droppable, needed }) {
  const text = whole.length > MINIFIED_READ ? whole.slice(0, whole.lastIndexOf('\n', MINIFIED_READ) + 1 || MINIFIED_READ) : whole
  // Its lines of code alone, as long as what is on them: a comment set aside
  // leaves nothing but its line breaks, a string or template `""` and its, a
  // regular expression `/REGEX/`, so the code either side stays apart.
  const lines = text.replaceAll(stringOrComment, (match, string) => (string === undefined ? '' : string[0] === '/' ? `/${REGEX}/` : '""') + match.replaceAll(/[^\n]/gu, ''))
    .replaceAll(/^[ \t]+/gmu, '')
    .split('\n').filter(line => line.trim() !== '')
  const code = lines.join('\n'), length = code.length - (lines.length - 1)
  // Counted by character: a run aligning `=` is as many spaces as it is wide.
  let depth = 0, dropped = 0, scanned = 0
  for (const { 0: run, index } of code.matchAll(droppable)) {
    for (; scanned < index; scanned++) depth = Math.max(0, depth + (code[scanned] === '(' ? 1 : code[scanned] === ')' ? -1 : 0))
    if (!needed(code, index, run, depth)) dropped += run.length
  }
  return lines.length > 0 && length > MINIFIED_AVERAGE * lines.length && dropped < MINIFIED_SPACES * length ? Math.round(length / lines.length) : 0
}

// JavaScript or TypeScript (a declaration file too, which node runs as any
// other), or a script run by node by its hashbang (`bin/cli`, with no
// extension), a byte order mark before it or not, as node runs one after it
// as an ES module (in a `"type": "module"` package).
const SCRIPT = /\.[cm]?[jt]sx?$/iu
const NODE_HASHBANG = /^\uFEFF?#!.*\bnode\b/u
// Whether a file (its path and text) is a script, as SCRIPT and NODE_HASHBANG
// tell, or as node runs it whatever its name (`script`, npm/files.js
// npmLoadedScripts).
export const npmIsScript = (path, text, script = false) => typeof text === 'string' && (script || SCRIPT.test(path) || NODE_HASHBANG.test(text))
// How many places a file is told doing a thing, the first ones, at most
// (runs-code.js, hosts.js): a file doing it on millions of lines is told by
// its first, and what it holds of them kept to a bound however many there
// are.
export const NPM_MAX_FOUND = 100
// Every how many line breaks one is kept where lineOf counts from.
const LINE_MARK = 1024
// Each offset in a text as its line: one more than the line breaks before it,
// counted on from the nearest of every LINE_MARKth, which alone are kept.
export function lineOf(text) {
  let marks = null
  return offset => {
    if (!marks) {
      marks = []
      for (let at = text.indexOf('\n'), count = 0; at !== -1; at = text.indexOf('\n', at + 1), count++) if (count % LINE_MARK === 0) marks.push(at)
    }
    let high = marks.length, low = 0
    while (low < high) {
      const middle = (low + high) >> 1
      if (marks[middle] < offset) low = middle + 1
      else high = middle
    }
    if (low === 0) return 1
    let breaks = (low - 1) * LINE_MARK + 1
    for (let at = text.indexOf('\n', marks[low - 1] + 1); at !== -1 && at < offset; at = text.indexOf('\n', at + 1)) breaks++
    return breaks + 1
  }
}

