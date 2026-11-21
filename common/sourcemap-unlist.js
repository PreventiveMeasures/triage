// A source map's listing (sourcemap-listing.js) read back to the text it
// lists. Any row that isn't a listing's throws.
import { MAPPINGS_OPEN } from './sourcemap-listing.js'
import { encodeDeltas } from './sourcemap-mappings.js'

const KEY_ROW = /^("(?:[^"\\]|\\.)*"): (.*)$/u
const STRING_ROW = /^"(?:[^"\\]|\\.)*"$/u
const VALUE = /^-?\d+$/u
// What JSON.parse reads past after a value.
const BLANKS = /^[\t\n\r ]+$/u

const fail = (row, why) => {
  throw new Error(`Its listing's row ${row + 1} ${why}`)
}

// A line of a text (`│` as written, `┊` as JSON).
function textLine(row, i) {
  if (row === '  │') return ''
  if (row.startsWith('  │ ')) return row.slice(4)
  const text = row.startsWith('  ┊ ') ? JSON.parse(row.slice(4)) : null
  return typeof text === 'string' && !text.includes('\n') ? text : fail(i, 'is no line of a text.')
}

// A list's items, from row `i`, and the row past its `]`.
function itemsFrom(rows, i) {
  const items = []
  for (; i < rows.length; i++) {
    const row = rows[i]
    if (row === ']') return [items, i + 1]
    if (row === '  ┌' || row.startsWith('  ┌ ')) {
      const lines = []
      while (rows[i + 1]?.startsWith('  │') || rows[i + 1]?.startsWith('  ┊')) lines.push(textLine(rows[++i], i))
      if (lines.length === 0) fail(i, 'opens a text with no line.')
      items.push(lines.join('\n'))
    } else if (row.startsWith('  ')) items.push(JSON.parse(row.slice(2)))
    else fail(i, 'is no item of a list.')
  }
  return fail(i - 1, 'ends a list with no `]` after.')
}

// Mappings written back of their rows, a line of the generated file to each
// (`from` the first's index), each segment its values from the one before.
function mappingsFrom(rows, from) {
  return encodeDeltas(rows.map((row, k) => {
    if (row === '') return []
    if (!row.startsWith('  ')) fail(from + k, 'is no line of mappings.')
    return row.slice(2).split(', ').map(segment => {
      const values = segment.split(' ')
      if (![1, 4, 5].includes(values.length) || !values.every(each => VALUE.test(each))) fail(from + k, 'gives a segment that reads as none.')
      return values.map(Number)
    })
  }))
}

// The text a listing lists. Throws for rows that aren't a listing's.
export function unlistSourcemap(text) {
  if (!text.endsWith('\n')) throw new Error('Its listing ends with no line end.')
  const rows = text.slice(0, -1).split('\n'), value = {}
  let i = 0, trailing = ''
  while (i < rows.length) {
    if (i === rows.length - 1 && STRING_ROW.test(rows[i])) {
      trailing = JSON.parse(rows[i])
      if (!BLANKS.test(trailing)) fail(i, 'follows the JSON with more than blanks.')
      break
    }
    const match = KEY_ROW.exec(rows[i])
    if (!match) fail(i, 'names no key.')
    const key = JSON.parse(match[1])
    if (Object.hasOwn(value, key)) fail(i, `names ${match[1]} again.`)
    let item
    if (match[2] === '[') [item, i] = itemsFrom(rows, i + 1)
    else if (match[2] === MAPPINGS_OPEN && key === 'mappings') {
      const end = rows.indexOf('}', i + 1)
      if (end < 0) fail(i, 'opens mappings with no `}` after.')
      item = mappingsFrom(rows.slice(i + 1, end), i + 1)
      i = end + 1
    } else {
      item = JSON.parse(match[2])
      i++
    }
    // Defined, not set: a `__proto__` key is a key like any other in JSON.
    Object.defineProperty(value, key, { value: item, enumerable: true, writable: true, configurable: true })
  }
  return `${JSON.stringify(value)}${trailing}`
}
