// One line's worth of value: a scalar, or a flow collection of scalars.

import { take } from '../lines.js'
import { YamlError, excerpt } from './error.js'

// A plain scalar opens with anything but an indicator (`-`, `?` and `:` are
// fine when not followed by a space), contains no `: ` and no ` #`, and ends
// before trailing spaces; in a flow collection `,[]{}` end it too. Only the
// space counts as whitespace: tabs were refused earlier, and to YAML a
// Unicode space is an ordinary character. A `#` can only be reached after
// something that is not a space, so past the first character it is content.
const plain = (end) => new RegExp(`(?:[^ ?:,[\\]{}#&*!|>'"%@\`-]|[-?:](?=[^${end}]))(?:[^:${end}]|:(?=[^${end}])| +(?=[^#:${end}]|:[^${end}]))*`, 'uy')
const PLAIN = { block: plain(' '), flow: plain(' ,[\\]{}') }
const SINGLE = /'((?:[^']|'')*)'/uy
const DOUBLE = /"((?:[^"\\]|\\.)*)"/uy

const ESCAPE = {
  __proto__: null,
  0: '\u0000', a: '\u0007', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\u001B',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00A0', L: '\u2028', P: '\u2029',
}
const ESCAPED = /\\(?:x([\dA-Fa-f]{2})|u([\dA-Fa-f]{4})|U([\dA-Fa-f]{8})|(.))/gu

function unescape(raw, src) {
  return raw.replace(ESCAPED, (_, x, u, U, c) => {
    if (c !== undefined) {
      if (!(c in ESCAPE)) throw new YamlError(`unknown escape \\${c}`, src.line)
      return ESCAPE[c]
    }
    const code = Number.parseInt(x ?? u ?? U, 16)
    if (code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) throw new YamlError(`${_} is not a Unicode scalar value`, src.line)
    return String.fromCodePoint(code)
  })
}

// Only the spellings JS itself prints are typed. Everything else the core
// schema would type (`~`, `TRUE`, `0x1F`, `1_000`, `.5`, `1.`, `+1`, `01`,
// `.inf`, ...) is refused rather than silently read as a string, and so is
// a number beyond 2^53, where an integer has already lost digits. So is
// `-0`, which is 0 to js-yaml and -0 to JSON.parse, and a date or timestamp
// (`2001-12-14`, `2001-12-14 21:59:43.10 -5`), which js-yaml reads as a Date.
const KNOWN = { __proto__: null, true: true, false: false, null: null }
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[Ee][+-]?\d+)?$/u
const TYPED = /^(?:~|null|true|false|\.nan|[+-]?(?:\.inf|0[box][\d_a-f]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:e[+-]?\d+)?))$/iu
const DATE = /^\d{4}-(?:\d\d-\d\d|\d\d?-\d\d?(?:[Tt]| +)\d\d?:\d\d:\d\d(?:\.\d*)?(?: *(?:Z|[+-]\d\d?(?::\d\d)?))?)$/u

function resolve(text, src) {
  if (text in KNOWN) return KNOWN[text]
  if (NUMBER.test(text) && text !== '-0') {
    const number = Number(text)
    if (Math.abs(number) > Number.MAX_SAFE_INTEGER) throw new YamlError(`number out of range ${excerpt(text)}`, src.line)
    return number
  }
  if (TYPED.test(text) || DATE.test(text)) throw new YamlError(`ambiguous scalar ${excerpt(text)}, quote it`, src.line)
  return text
}

const found = (src) => (src.pos < src.text.length ? excerpt(src.text.slice(src.pos)) : 'the end of the line')

// A double-quoted scalar's text, its quotes off, unescaped: for one read
// over more than one line (workflow.js).
export const unescapeDouble = (raw, line) => unescape(raw, { line })

function matchScalar(src, context) {
  let m = take(src, SINGLE)
  if (m !== null) return m[1].replaceAll("''", "'")
  m = take(src, DOUBLE)
  if (m !== null) return unescape(m[1], src)
  m = take(src, PLAIN[context])
  return m === null ? undefined : resolve(m[0], src)
}

function readScalar(src, context) {
  const value = matchScalar(src, context)
  if (value === undefined) throw new YamlError(`expected a scalar, found ${found(src)}`, src.line)
  return value
}

// `<<` is refused because to YAML 1.1 readers, js-yaml among them, it merges
// another mapping in rather than naming a key.
export function setKey(map, key, value, line) {
  if (typeof key !== 'string') throw new YamlError('keys must be strings', line)
  if (key === '<<') throw new YamlError('merge keys are not supported', line)
  if (key in map) throw new YamlError(`duplicate key ${excerpt(key)}`, line)
  map[key] = value
}

const SPACES = / */uy
const COMMA = /, */uy
const PAIR = /: +/uy
const KEY_END = /:(?: +(?:#.*)?|$)/uy
const LINE_END = /(?: +#.*| *)$/uy

// How deep flow collections nest, where `workflow` reads them nested.
const MAX_FLOW_DEPTH = 64

// `[a, b]` or `{a: 1, b: 2}`, of scalars alone, up to `closer`; where
// `workflow` reads it, of flow collections too, and a comma after the
// last.
function readFlow(src, closer) {
  const collection = closer === ']' ? [] : Object.create(null)
  if (src.workflow && ++src.depth > MAX_FLOW_DEPTH) throw new YamlError('nested too deep', src.line)
  src.pos++
  take(src, SPACES)
  if (src.text[src.pos] !== closer) {
    do {
      if (src.workflow && src.text[src.pos] === closer) break
      if (src.workflow) readEntry(src, collection, closer)
      else {
        const item = readItem(src)
        if (closer === ']') collection.push(item)
        else if (take(src, PAIR) === null) throw new YamlError(`expected ": " after the key, found ${found(src)}`, src.line)
        else setKey(collection, item, readItem(src), src.line)
      }
      take(src, SPACES)
    } while (take(src, COMMA) !== null)
  }
  if (src.text[src.pos] !== closer) throw new YamlError(`expected "," or "${closer}", found ${found(src)}`, src.line)
  src.pos++
  if (src.workflow) src.depth--
  return collection
}

// An entry of a flow collection: a scalar, or where `workflow` reads it, a
// flow collection.
function readItem(src) {
  const char = src.text[src.pos]
  if (src.workflow && (char === '[' || char === '{')) return readFlow(src, char === '[' ? ']' : '}')
  return readScalar(src, 'flow')
}

// A key's `:`, spaces before it too (`{a : 1}`); right before its value
// after a quoted key (`{"a":1}`), as JSON writes it.
const COLON = / *:(?=[ ,\]}]|$)/uy
const QUOTED_COLON = / *:/uy

// An entry of a flow collection as `workflow` reads it, as YAML has it: a
// mapping's key with its value left empty, or its `:` too (`{a: , b}`),
// null, and a sequence's `a: 1` a mapping of that one key.
function readEntry(src, collection, closer) {
  const quoted = src.text[src.pos] === '"' || src.text[src.pos] === "'"
  const item = readItem(src)
  const colon = take(src, quoted ? QUOTED_COLON : COLON) !== null
  if (closer === ']' && !colon) { collection.push(item); return }
  take(src, SPACES)
  const value = colon && src.text[src.pos] !== ',' && src.text[src.pos] !== closer ? readItem(src) : null
  if (closer === '}') { setKey(collection, item, value, src.line); return }
  const pair = Object.create(null)
  setKey(pair, item, value, src.line)
  collection.push(pair)
}

export function parseInline(text, line, workflow = false) {
  const src = { text, pos: 0, line, workflow, depth: 0 }
  const value = text.startsWith('{') ? readFlow(src, '}') : text.startsWith('[') ? readFlow(src, ']') : readScalar(src, 'block')
  if (take(src, LINE_END) === null) throw new YamlError(`unexpected ${found(src)} after the value`, line)
  return value
}

// `key: rest` or `key:` at the start of a line, a comment after the colon
// counting as nothing; null when the line is not a mapping entry. YAML holds
// such a key to 1024 characters, quotes included, counted here in UTF-16
// units: so the yaml package counts when it refuses a longer one, and so
// js-yaml's writer counts when it puts one after `? ` instead.
export function readKey(text, line) {
  const src = { text, pos: 0, line }
  const key = matchScalar(src, 'block')
  const length = src.pos
  if (key === undefined || take(src, KEY_END) === null) return null
  if (length > 1024) throw new YamlError('a key longer than 1024 characters is written after "? "', line)
  return { key, rest: text.slice(src.pos) }
}
