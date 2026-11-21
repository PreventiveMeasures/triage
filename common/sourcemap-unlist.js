// A source map's listing (sourcemap-listing.js) read back to the map it
// lists: what JSON.parse made of the text it was listed from. Its glosses are
// read past, as listing the map again makes them; any row that is neither a
// value's nor a gloss of one throws.
import { MAPPINGS_OPEN, RUN_AS_ABOVE, RUN_OF_NO_SOURCE, counted, sourceLabels } from './sourcemap-listing.js'
import { encodeMappings } from './sourcemap-mappings.js'

const KEY_ROW = /^("(?:[^"\\]|\\.)*"): (.*)$/u
const RUN_ROW = /^ {2}← (\S+) ([+-]\d+)(?: {2}.+)?$/u
const SEGMENT = /([+-]?\d+)(?::(\d+)(?: ("(?:[^"\\]|\\.)*"|#\d+))?)?(?: |$)/uy
const MINUS = 45, PLUS = 43

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

// A run's row read: the source line it maps from, as the map read so far has
// it (`read`), or none.
function runFrom(read, row, i) {
  if (row === RUN_OF_NO_SOURCE) return { source: null }
  if (row === RUN_AS_ABOVE) return read.above ? { source: read.above[0], line: read.above[1] } : fail(i, 'maps from the line above, with none above.')
  const [, label, step] = RUN_ROW.exec(row)
  const source = read.labels.get(label)
  if (source === undefined) fail(i, `names no source as ${JSON.stringify(label)}.`)
  const line = read.last[source] + Number(step)
  if (!Number.isSafeInteger(line) || line < 0) fail(i, "maps from before its source's first line.")
  read.last[source] = line
  read.above = [source, line]
  return { source, line }
}

// A run's segments read (`text`, its row past the indent) onto the line read.
function segmentsFrom(read, text, i) {
  const { run } = read
  if (text === '') fail(i, 'gives no segment.')
  for (let at = 0; at < text.length;) {
    SEGMENT.lastIndex = at
    const match = SEGMENT.exec(text)
    if (!match || (SEGMENT.lastIndex === text.length && match[0].endsWith(' '))) fail(i, 'gives a segment that reads as none.')
    at = SEGMENT.lastIndex
    const [, step, sourceColumn, name] = match
    const sign = step.codePointAt(0)
    if ((sign === PLUS || sign === MINUS) === (read.previous === null)) fail(i, 'gives a column neither first on its line nor from the one before.')
    const column = (read.previous ?? 0) + Number(step)
    if (!Number.isSafeInteger(column) || column < 0) fail(i, "gives a column before its line's first.")
    read.previous = column
    if ((run.source === null) !== (sourceColumn === undefined)) fail(i, 'gives a source column in a run of no source, or none in a run of one.')
    if (run.source === null) {
      read.line.push([column])
      continue
    }
    const segment = [column, run.source, run.line, Number(sourceColumn)]
    if (name !== undefined) {
      const index = name.startsWith('#') ? Number(name.slice(1)) : read.nameIndex.get(JSON.parse(name))
      if (!(index < read.names.length)) fail(i, 'names no name of the map.')
      segment.push(index)
    }
    read.line.push(segment)
  }
}

// Mappings written back of their rows (`from` the first's index), by the
// map's sources and names as read.
function mappingsFrom(rows, from, { sources, names = [] }) {
  if (!Array.isArray(sources) || !Array.isArray(names) || !names.every(name => typeof name === 'string')) fail(from - 1, 'decodes the mappings of a map whose sources or names are no list.')
  const counts = counted(names)
  const read = {
    names, labels: new Map(sourceLabels(sources).map((label, i) => [label, i])),
    nameIndex: new Map(names.flatMap((name, i) => (counts.get(name) === 1 ? [[name, i]] : []))),
    last: sources.map(() => 0), lines: [], line: null, run: null, above: null, previous: null,
  }
  const unpaid = i => {
    if (read.run && !read.run.paid) fail(i, 'starts before the run above has segments.')
  }
  rows.forEach((row, k) => {
    const i = from + k
    if (row === '@' || row.startsWith('@ ')) {
      unpaid(i)
      read.lines.push(read.line = [])
      read.run = null
      read.previous = null
    } else if (read.line === null) fail(i, 'comes before the first line of mappings (@).')
    else if (row === RUN_OF_NO_SOURCE || row === RUN_AS_ABOVE || RUN_ROW.test(row)) {
      unpaid(i)
      read.run = runFrom(read, row, i)
    } else if (row.startsWith('      ')) {
      if (!read.run || read.run.paid) fail(i, 'gives segments of no run.')
      read.run.paid = true
      segmentsFrom(read, row.slice(6), i)
    // Glosses, held to the map by listing it again.
    } else if (!(row === '    ‹' || row.startsWith('    ‹ ') || row.startsWith('    renamed: '))) fail(i, 'is no row of mappings.')
  })
  unpaid(from + rows.length)
  if (read.line === null) fail(from, 'decodes mappings of no line.')
  return encodeMappings(read.lines)
}

// The map a listing lists, as JSON.parse made it of the text it was listed
// from. Throws for rows that aren't a listing's.
export function unlistSourcemap(text) {
  if (!text.endsWith('\n')) throw new Error('Its listing ends with no line end.')
  const rows = text.slice(0, -1).split('\n'), value = {}
  let i = 0, mappings = null
  while (i < rows.length && rows[i].startsWith('# ')) i++
  while (i < rows.length) {
    const match = KEY_ROW.exec(rows[i])
    if (!match) fail(i, 'names no key.')
    const key = JSON.parse(match[1])
    if (Object.hasOwn(value, key)) fail(i, `names ${match[1]} again.`)
    let item = null
    if (match[2] === '[') [item, i] = itemsFrom(rows, i + 1)
    else if (match[2] === MAPPINGS_OPEN) {
      const end = rows.indexOf('}', i + 1)
      if (key !== 'mappings' || end < 0) fail(i, 'opens decoded mappings of another key, or with no `}` after.')
      mappings = { from: i + 1, rows: rows.slice(i + 1, end) }
      i = end + 1
    } else {
      item = JSON.parse(match[2])
      i++
    }
    // Defined, not set: a `__proto__` key is a key like any other in JSON.
    Object.defineProperty(value, key, { value: item, enumerable: true, writable: true, configurable: true })
  }
  if (mappings) value.mappings = mappingsFrom(mappings.rows, mappings.from, value)
  return value
}
