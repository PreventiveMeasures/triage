// How a file's text reads, for a reviewer: the npm Overview's tags and
// warnings (npm-overview.js), and which files the Code tab offers
// pretty-printed (pretty-source.js).

// What a text holds beyond printing characters and its line breaks: the C0
// controls other than tab, line feed and carriage return, DEL, the C1
// controls, and the bidirectional controls that can make code read other than
// it runs ("Trojan Source").
const CONTROLS = /(?![\t\n\r])\p{Cc}|[\u202A-\u202E\u2066-\u2069]/gu
const NON_ASCII = /\P{ASCII}/u

// A file's text: `kind` 'ascii' or 'utf8', by whether it holds anything past
// ASCII, else 'binary' (which the server tells by its bytes, sending no
// text); `controls` the control characters a text holds, how often by code
// point, or null for none.
export function npmTextEncoding(text) {
  if (typeof text !== 'string') return { kind: 'binary', controls: null }
  const controls = new Map()
  for (const [char] of text.matchAll(CONTROLS)) controls.set(char.codePointAt(0), (controls.get(char.codePointAt(0)) ?? 0) + 1)
  return { kind: NON_ASCII.test(text) ? 'utf8' : 'ascii', controls: controls.size > 0 ? controls : null }
}

// Lines longer than anyone writes by hand.
export const NPM_LONG_LINE = 1000
// Prose, which wraps where it is read: its long lines are paragraphs.
const PROSE = /(?:\.(?:md|markdown|mdx|txt|rst|adoc|asciidoc|textile)|(?:^|\/)(?:licen[cs]e|copying|notice|authors|contributors|readme|changelog|changes|history)(?:[-.][^/]*)?)$/iu
const SOURCE_MAP_COMMENT = /^\s*(?:\/\/|\/\*)[#@] sourceMappingURL=/u
// A line that is all one, the map in it as a data: URL, base64 or
// percent-encoded: not code that writes one.
const INLINE_SOURCE_MAP = /^\s*(?:\/\/|\/\*)[#@] sourceMappingURL=data:[^\s,]*,[\w+/=%.~-]*\s*(?:\*\/)?\s*$/u
const SOURCE_MAP = /\.map$/iu
const MINIFIED_NAME = /\.min\.[^/.]+$/iu
// Code minified into lines shorter than NPM_LONG_LINE: outside its strings and
// comments (`/* @__PURE__ */`), its lines average more than anyone writes and
// next to none of its spaces are ones a minifier drops. Told only in what
// minifiers write, as GitHub Linguist tells minified files only in JavaScript
// and CSS, each by its strings and comments (matched in one pass, so that
// neither starts inside the other, a comment with the spaces around it) and
// the spaces it can do without.
const MINIFIED_AVERAGE = 110
const MINIFIED_SPACES = .01
// What a regular expression set aside holds.
const REGEX = '\uE000'
const JS = {
  // A hashbang, the file's first line (`#!/usr/bin/env node`), a comment.
  // A regular expression first where a value starts (after `=>`, an operator or a keyword, not a property: `x.default/2`), so a quote in it (`/["']/`) starts no string.
  stringOrComment: /((?<=(?:^|[(,=:[!&|?{};>+\-*/%^<~]|(?<![\p{ID_Continue}$.])(?:await|case|default|delete|do|else|in|of|return|throw|typeof|void|yield))[ \t]*)\/(?![/*])(?:[^/\\[\n]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[a-z]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|[ \t]*(?:\/\*[\s\S]*?\*\/|\/\/.*|(?<![\s\S])#!.*)[ \t]*/gmu,
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
const minifiable = path => /\.[cm]?js$/iu.test(path) ? JS : /\.css$/iu.test(path) ? CSS : null
function minifiedCode(text, { stringOrComment, droppable, needed }) {
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
  return lines.length > 0 && length > MINIFIED_AVERAGE * lines.length && dropped < MINIFIED_SPACES * length
}

// How a file reads, as its `category`, the first that holds (READABILITY):
// binary (no text), controls (text holding control or bidirectional
// characters), map (a source map), long (code with some lines longer than
// anyone writes), inline-map (code with its source map in it, minified or
// not), minified (code mostly on long lines, or named .min., or minified
// into shorter lines: see MINIFIED_AVERAGE), else utf8 or ascii. Prose is
// readable whatever its lines' lengths, and an inline source map's line
// counts for none, nor for how much of the code is on long lines. With
// npmTextEncoding's `kind` and `controls`, its `longest` line's length and
// `longLines`, its non-blank lines' `average` length, and how long its
// inline map is (`inlineMap`, 0 for none).
export function npmFileReadability(path, text) {
  const encoding = npmTextEncoding(text)
  if (encoding.kind === 'binary') return { ...encoding, category: 'binary', longest: 0, longLines: 0, average: 0, inlineMap: 0 }
  let codeChars = 0, codeLines = 0, inlineMap = 0, longChars = 0, longLines = 0, longest = 0
  for (let at = 0; at <= text.length;) {
    const next = text.indexOf('\n', at)
    const end = next === -1 ? text.length : next
    const length = end - at - (text[end - 1] === '\r' ? 1 : 0)
    if (SOURCE_MAP_COMMENT.test(text.slice(at, at + 64)) && INLINE_SOURCE_MAP.test(text.slice(at, end))) inlineMap += length
    else {
      if (length > NPM_LONG_LINE) {
        longLines++
        longChars += length
      }
      longest = Math.max(longest, length)
      if (text.slice(at, end).trim() !== '') {
        codeLines++
        codeChars += length
      }
    }
    at = end + 1
  }
  const read = { ...encoding, longest, longLines, average: codeLines === 0 ? 0 : Math.round(codeChars / codeLines), inlineMap }
  if (encoding.controls) return { ...read, category: 'controls' }
  if (SOURCE_MAP.test(path)) return { ...read, category: 'map' }
  if (PROSE.test(path)) return { ...read, category: inlineMap > 0 ? 'inline-map' : encoding.kind }
  if (longLines === 0) {
    // None of its lines longer than MINIFIED_AVERAGE, none of its code's can
    // average more: told without reading its code.
    const language = minifiable(path)
    const minified = language !== null && longest > MINIFIED_AVERAGE && minifiedCode(text, language)
    return { ...read, category: inlineMap > 0 ? 'inline-map' : minified ? 'minified' : encoding.kind }
  }
  if (longChars / (text.length - inlineMap) < .5 && !MINIFIED_NAME.test(path)) return { ...read, category: 'long' }
  return { ...read, category: inlineMap > 0 ? 'inline-map' : 'minified' }
}
