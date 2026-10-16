// A lockfile read a line at a time, as yarn.lock and foundry.lock are, and
// the strings in a line that JSON writes.

import { LockfileError, attempt, quote } from './error.js'
import { hex } from './excerpt.js'

export const fail = (detail, number) => new LockfileError(`${detail} at line ${Math.max(number, 0) + 1}`)

// What none of yarn, Bundler and pnpm writes raw: controls, tabs among
// them, lone surrogates, a byte order mark, which would read as part of the
// first key, U+FFFE and U+FFFF, which js-yaml refuses, and U+2028 and
// U+2029, which end a line to a YAML 1.1 reader and some others, as a lone
// CR does to yarn.
export const UNWRITTEN = /[\p{Cc}\p{Cs}\uFEFF\uFFFE\uFFFF\u2028\u2029]/u

// npm and yarn read a file with all three of these anywhere in it, in a
// string too, as a merge conflict, and merge its sides into one.
const CONFLICT = ['<<<<<<<', '=======', '>>>>>>>']

export function checkConflict(text, tool) {
  if (CONFLICT.every((marker) => text.includes(marker))) {
    throw new LockfileError(`${tool} reads a file with ${CONFLICT.map((marker) => quote(marker)).join(', ')} in it as a merge conflict`)
  }
}

// A JSON file's line end after `{` and the indentation of the line after, which
// `tool` writes it again with: npm as json-parse-even-better-errors finds them,
// Composer as JsonFile::detectIndenting does.
export function jsonLayout(text, tool) {
  const format = /^\{(\r?\n)([\t ]+)"/u.exec(text)
  if (format === null) throw fail(`expected "{" alone on the first line and an indented key on the next, as ${tool} writes the file`, 0)
  return format.slice(1)
}

// A sticky `re` read at `src.pos`, which it moves past the match.
export function take(src, re) {
  re.lastIndex = src.pos
  const m = re.exec(src.text)
  if (m !== null) src.pos = re.lastIndex
  return m
}

// What follows `pos`, for a message.
export const rest = (line, pos) => (pos < line.length ? quote(line.slice(pos)) : 'the end of the line')

// The spaces a line is indented by.
export const indentOf = (line) => /^ */u.exec(line)[0].length

// A line some 2^23 characters long runs V8's regex engine out of
// backtracking stack, which is a RangeError, so a line is held to well
// below that, as yaml/parse.js holds one: no tool writes one near it.
export const MAX_LINE = 2 ** 20

// `forbidden` is what no line may have, refused by its code point.
export const lines = (text, forbidden) => ({ text, forbidden, pos: 0, number: -1, line: undefined, crlf: undefined })

// The next line into `src.line`, undefined past the last. Every line ends
// alike: a tool keeps the line ends of the file it rewrites, and git may
// check one out with CRLF throughout.
export function advance(src) {
  const { text, pos } = src
  src.line = undefined
  if (pos >= text.length) return
  let end = text.indexOf('\n', pos)
  if (end === -1) end = text.length
  src.pos = end + 1
  src.number++
  const crlf = end < text.length && text[end - 1] === '\r'
  const line = text.slice(pos, crlf ? end - 1 : end)
  if (line.length > MAX_LINE) throw fail(`a line longer than ${MAX_LINE} characters`, src.number)
  const char = src.forbidden.exec(line)?.[0]
  if (char !== undefined) throw fail(`${hex(char)} is not allowed`, src.number)
  if (end < text.length && crlf !== (src.crlf ??= crlf)) throw fail(`a ${crlf ? 'CRLF' : 'LF'} line end, after ${src.crlf ? 'CRLF' : 'LF'} ones`, src.number)
  src.line = line
}

// The string opening at `pos`, as JSON.stringify writes it and no other
// way, and the position past its closing quote; a backslash escapes the
// character after it. Without one, the text is the value, as a line's
// controls and lone surrogates are refused before.
export function readJsonString(line, pos, number) {
  let end = pos + 1
  while (end < line.length && line[end] !== '"') end += line[end] === '\\' ? 2 : 1
  if (end >= line.length) throw fail('a string with no closing quote', number)
  const raw = line.slice(pos, ++end)
  if (!raw.includes('\\')) return [raw.slice(1, -1), end]
  const value = attempt(() => JSON.parse(raw), () => {
    throw fail(`${quote(raw)} is not a string as JSON writes it`, number)
  })
  if (JSON.stringify(value) !== raw) throw fail(`${quote(raw)} is not written as JSON writes ${quote(value)}`, number)
  return [value, end]
}
