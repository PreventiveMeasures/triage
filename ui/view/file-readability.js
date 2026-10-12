// How a file's text reads, for a reviewer: the npm Overview's tags and
// warnings (npm-overview.js), Compare's tags in a file's head
// (bundle-compare-code.js) and its chips on what a version changes
// (npm-overview.js npmCompareBadges), and which files the Code tab offers
// pretty-printed (pretty-source.js).
import { html, nothing } from 'lit'
import { formatBytes } from '../scan/metrics.js'
import { invisibleCharacters } from './control-chars.js'

// What a text holds beyond printing characters and its line breaks: the C0
// controls other than tab, line feed and carriage return, DEL, the C1
// controls, and the bidirectional controls that can make code read other than
// it runs ("Trojan Source"); and the invisible characters that can hide text
// in it (control-chars.js invisibleCharacters), as a payload hidden in
// variation selectors or a variable named by a Hangul filler.
const CONTROLS = /(?![\t\n\r])\p{Cc}|[\u202A-\u202E\u2066-\u2069]/gu
const NON_ASCII = /\P{ASCII}/u

// A file's text: `kind` 'ascii' or 'utf8', by whether it holds anything past
// ASCII, else 'binary' (which the server tells by its bytes, sending no
// text); `controls` the control and invisible characters a text holds, how
// often by code point, or null for none.
export function npmTextEncoding(text) {
  if (typeof text !== 'string') return { kind: 'binary', controls: null }
  const controls = new Map()
  for (const [char] of text.matchAll(CONTROLS)) controls.set(char.codePointAt(0), (controls.get(char.codePointAt(0)) ?? 0) + 1)
  // The invisible characters are all past ASCII: looked for in a text that
  // has any, from its first.
  const past = text.search(NON_ASCII)
  if (past !== -1) for (const [code, times] of invisibleCharacters(text, past) ?? []) controls.set(code, times)
  return { kind: past === -1 ? 'ascii' : 'utf8', controls: controls.size > 0 ? controls : null }
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
  // A string's or template's escape may be a line continuation (`\` before a line break).
  // A regular expression first where a value starts (after `=>`, `...`, an operator or a keyword, not a property: `x.default/2`, `this.#in/2`), so a quote in it (`/["']/`) starts no string.
  stringOrComment: /((?<=(?:^|\.\.\.|[(,=:[!&|?{};>+\-*/%^<~]|(?<![\p{ID_Continue}$.#])(?:await|case|default|delete|do|else|extends|in|instanceof|new|of|return|throw|typeof|void|yield))[ \t]*)\/(?![/*])(?:[^/\\[\n]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[a-z]*|"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'|`(?:[^`\\]|\\[\s\S])*`)|[ \t]*(?:\/\*[\s\S]*?\*\/|\/\/.*|(?<![\s\S])#!.*)[ \t]*/gmu,
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
// comments, for a reader that sets them aside (file-runs-code.js).
export const JS_STRING_OR_COMMENT = JS.stringOrComment
const minifiable = path => /\.[cm]?js$/iu.test(path) ? JS : /\.css$/iu.test(path) ? CSS : null
// Its code's lines' average length where they are minified into short ones, else 0.
function minifiedAverage(text, { stringOrComment, droppable, needed }) {
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

// What javascript-obfuscator writes, and next to nothing else: its names,
// `_0x` and four to six hex digits, OBFUSCATED_NAMES of them or more, or the
// loop it turns its array of strings with, `while(!![])`, spaced or not.
const OBFUSCATED_NAME = /(?<![\p{ID_Continue}$])_0x[0-9a-f]{4,6}(?![\p{ID_Continue}$])/gu
const OBFUSCATED_NAMES = 20
const OBFUSCATED_LOOP = /while\s*\(\s*!!\[\]\s*\)/u
// Names counted before a fingerprint's count stops, reading as that many or
// more: each is kept to tell it from the others, and a file can hold millions.
const OBFUSCATED_COUNTED = 1000
// A text's obfuscator fingerprint, `{ names, loop }`: how many such names it
// has, up to OBFUSCATED_COUNTED, and whether it has the loop; null where it
// has neither enough names nor the loop.
export function npmObfuscation(text) {
  const names = new Set()
  for (const [name] of text.matchAll(OBFUSCATED_NAME)) {
    names.add(name)
    if (names.size === OBFUSCATED_COUNTED) break
  }
  const loop = OBFUSCATED_LOOP.test(text)
  return names.size >= OBFUSCATED_NAMES || loop ? { names: names.size, loop } : null
}

// What a fingerprint holds, as a tooltip says it.
export const npmObfuscationFound = ({ names, loop }) => [names >= OBFUSCATED_NAMES
  && `${names.toLocaleString('en')}${names === OBFUSCATED_COUNTED ? ' or more' : ''} names such as _0x1a2b`, loop && 'while(!![])'].filter(Boolean).join(', and ')

// A code file this large is mostly a bundle, worth a look where a version
// adds it: JavaScript or TypeScript, not a declaration file, which holds no
// code that runs.
export const NPM_LARGE_CODE = 256 * 1024
const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/iu
const DECLARATION = /\.d\.[cm]?ts$/iu
export const npmLargeCode = (path, bytes) => typeof bytes === 'number' && bytes >= NPM_LARGE_CODE && CODE.test(path) && !DECLARATION.test(path)

// A file that had no line over SHORT_LINES characters and now has one over
// UNREADABLE_LINE, by how it reads on each side (`was` and `now`,
// npmFileReadability's), `path` its path now: an inline source map's line
// counts for neither, and prose and source maps, whose long lines the Long
// lines tag passes over, never become so, nor does a file that isn't text on
// either side.
const SHORT_LINES = 200
const UNREADABLE_LINE = 2000
export function npmBecameUnreadable(path, was, now) {
  if (!was || !now || was.category === 'binary' || now.category === 'binary' || PROSE.test(path) || SOURCE_MAP.test(path)) return false
  return was.longest <= SHORT_LINES && now.longest > UNREADABLE_LINE
}

// How a file reads, as its `category`, the first that holds (READABILITY):
// binary (no text), controls (text holding control, bidirectional or
// invisible characters), map (a source map), long (code with some lines
// longer than anyone writes), inline-map (code with its source map in it, minified or
// not), minified (code mostly on long lines, or named .min., or minified
// into shorter lines: see MINIFIED_AVERAGE), else utf8 or ascii. Prose is
// readable whatever its lines' lengths, and an inline source map's line
// counts for none, nor for how much of the code is on long lines. With
// npmTextEncoding's `kind` and `controls`, its `longest` line's length and
// `longLines`, its code's lines' `average` length where it is minified into
// short ones (strings and comments aside, see MINIFIED_AVERAGE; 0 otherwise),
// how long its inline map is (`inlineMap`, 0 for none), and its obfuscator
// fingerprint (`obfuscation`, npmObfuscation's; null for none, and for prose
// or a source map).
export function npmFileReadability(path, text) {
  const encoding = npmTextEncoding(text)
  if (encoding.kind === 'binary') return { ...encoding, category: 'binary', longest: 0, longLines: 0, average: 0, inlineMap: 0, obfuscation: null }
  let inlineMap = 0, longChars = 0, longLines = 0, longest = 0
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
    }
    at = end + 1
  }
  // A source map holds the names and sources of the code it maps, and prose
  // its examples: neither runs.
  const obfuscation = PROSE.test(path) || SOURCE_MAP.test(path) ? null : npmObfuscation(text)
  const read = { ...encoding, longest, longLines, average: 0, inlineMap, obfuscation }
  if (encoding.controls) return { ...read, category: 'controls' }
  if (SOURCE_MAP.test(path)) return { ...read, category: 'map' }
  if (PROSE.test(path)) return { ...read, category: inlineMap > 0 ? 'inline-map' : encoding.kind }
  if (longLines === 0) {
    // None of its lines longer than MINIFIED_AVERAGE, none of its code's can
    // average more: told without reading its code.
    const language = minifiable(path)
    const average = language !== null && longest > MINIFIED_AVERAGE ? minifiedAverage(text, language) : 0
    return { ...read, average, category: inlineMap > 0 ? 'inline-map' : average > 0 ? 'minified' : encoding.kind }
  }
  if (longChars / (text.length - inlineMap) < .5 && !MINIFIED_NAME.test(path)) return { ...read, category: 'long' }
  return { ...read, category: inlineMap > 0 ? 'inline-map' : 'minified' }
}

// Each category: its name, its tag in a list of files or a file's head, and how it is marked,
// `warn` for what to look into, `notice` for what can be hard to review by
// reading it either way.
export const READABILITY = new Map([
  ['binary', { name: 'Binary', tag: 'Binary', mark: 'warn' }],
  ['controls', { name: 'Control or invisible characters', tag: 'Controls', mark: 'warn' }],
  ['long', { name: 'Unexpected long lines', tag: 'Long lines', mark: 'warn' }],
  ['minified', { name: 'Minified', tag: 'Minified', mark: 'notice' }],
  ['map', { name: 'Source maps', tag: 'Map', mark: 'notice' }],
  ['inline-map', { name: 'Inline source maps', tag: 'Inline map', mark: 'notice' }],
  ['utf8', { name: 'UTF-8', tag: 'UTF-8', mark: null }],
  ['ascii', { name: 'ASCII', tag: 'ASCII', mark: null }],
])

// The controls, and invisible characters, a text holds: named for which it
// has, the most found first.
const CONTROL = new RegExp(CONTROLS.source, 'u')
function controlsNote(controls) {
  const found = [...controls].toSorted((a, b) => b[1] - a[1] || a[0] - b[0])
  const named = found.slice(0, 6).map(([point, times]) => `U+${point.toString(16).toUpperCase().padStart(4, '0')} ×${times.toLocaleString('en')}`)
  const control = found.filter(([point]) => CONTROL.test(String.fromCodePoint(point))).length
  const kinds = control === found.length ? 'Control characters' : control === 0 ? 'Invisible characters' : 'Control and invisible characters'
  return `${kinds}: ${named.join(', ')}${found.length > 6 ? `, and ${found.length - 6} more` : ''}`
}

function readabilityNote({ average, category, controls, longLines, longest, inlineMap }) {
  const lines = () => `${longLines.toLocaleString('en')} ${longLines === 1 ? 'line' : 'lines'} over ${NPM_LONG_LINE} characters, the longest ${longest.toLocaleString('en')}`
  switch (category) {
    case 'binary': return 'Not UTF-8 text, or holding a NUL: there is no text to read'
    case 'controls': return controlsNote(controls)
    case 'map': return 'A source map'
    case 'inline-map': return `Inline source map, ${formatBytes(inlineMap)}${longLines > 0 ? `; minified: ${lines()}` : ''}`
    case 'minified': return `Minified: ${longLines > 0 ? lines() : `its lines of code ${average.toLocaleString('en')} characters long on average, strings and comments aside, with few spaces`}`
    case 'long': return `${lines()}, among readable ones`
    default: return nothing
  }
}

// A file's tag in the column a list keeps for it: how it reads, marked where
// it can't be read as it is, saying why; for one with unexpected long lines,
// how its text is encoded (ASCII or UTF-8), its long lines tagged beside it
// (npmLongLinesTag) rather than in its place.
export function npmEncodingTag(readability) {
  if (!readability) return nothing
  const category = readability.category === 'long' ? readability.kind : readability.category
  const { tag, mark } = READABILITY.get(category)
  return html`<span class=${`npm-encoding-tag${mark ? ` is-${mark}` : ''}`} data-tooltip=${readabilityNote({ ...readability, category })}>${tag}</span>`
}

// A file's Long lines, beside its tag as Obfuscated is (npmFileFlagTags), saying
// how many and how long; nothing for one without unexpected long lines.
export function npmLongLinesTag(readability) {
  if (readability?.category !== 'long') return nothing
  return html`<span class="npm-flag-tag is-warn" data-tooltip=${readabilityNote(readability)}>${READABILITY.get('long').tag}</span>`
}

// A file's tags of how it reads: its long lines, where it has them, then its tag.
export const npmReadabilityTag = readability => readability ? html`${npmLongLinesTag(readability)}${npmEncodingTag(readability)}` : nothing

// What a file is beyond how it reads, before its tag: Large, a code file of
// NPM_LARGE_CODE or more (`bytes` its size), which says little of a file
// alone, as `notice`; and Obfuscated, one with an obfuscator's fingerprint
// (npmObfuscation), as `warn`. Nothing for neither.
export function npmFileFlagTags(path, readability, bytes) {
  const large = npmLargeCode(path, bytes)
  const obfuscation = readability?.obfuscation
  if (!large && !obfuscation) return nothing
  return html`${large ? html`<span class="npm-flag-tag is-notice" data-tooltip=${`A code file of ${formatBytes(bytes)}, 256 KiB or more`}>Large</span>` : nothing}${
    obfuscation ? html`<span class="npm-flag-tag is-warn" data-tooltip=${`An obfuscator's fingerprint: ${npmObfuscationFound(obfuscation)}`}>Obfuscated</span>` : nothing}`
}
