// How a source map is listed (pretty-sourcemap.js): each of its keys in
// order, its value as JSON on the key's line, but a list's items each on a
// line of its own below it, sourcesContent's texts line by line, and mappings
// decoded, a run of segments to a line (sourcemap-mappings.js). Every row
// holds a value or is a gloss of one, a gloss being what the values and the
// generated file tell alone: `#` rows above, an `@` row's text, a `←` row's
// past its source and step, `‹` and `renamed:` rows. So listing a map again
// makes the same rows, and reading one back (sourcemap-unlist.js) reads past
// the glosses.
//
// Positions are steps where a number would move with a line added above:
// a run's source line from the last mapped in that source, a segment's
// column from the one before on its line. So a change shows on the rows it
// changes and on none past them.
import { decodeMappings, encodeMappings } from './sourcemap-mappings.js'

// Lines as the format counts them, for a mapping's line of a file.
const LINE_END = /\r\n|[\n\r\u2028\u2029]/u
// A generated line longer than this is glossed a run of segments at a time.
const WHOLE_LINE = 160
// The longest gloss shown of a line, cut short past it.
const GLOSS_WIDTH = 160
// The most characters a listing runs to, as a JSON file's copy may.
const COPY_LIMIT = 16 * 1024 * 1024

// Characters a line is written as JSON for (`┊`), or a gloss shown as JSON:
// those control-chars.js boxes in the viewer, which show as nothing or as
// another character (controls but tab, format characters such as the bidi
// controls and zero-width ones, lone surrogates, private use and unassigned
// code points, the line and paragraph separators, spaces other than a space,
// default-ignorable ones), so that a listing never leaves one to the viewer.
// eslint-disable-next-line no-control-regex
export const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u2800\u3000\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}]/u
const HIDDEN_ALL = new RegExp(HIDDEN.source, 'gu')
function escapeHidden(char) {
  const point = char.codePointAt(0)
  const units = point > 0xFFFF ? [Math.floor((point - 0x10000) / 0x400) + 0xD800, ((point - 0x10000) % 0x400) + 0xDC00] : [point]
  return units.map(unit => `\\u${unit.toString(16).padStart(4, '0')}`).join('')
}
// A JSON value as JSON.stringify writes it, but for its HIDDEN characters
// escaped: JSON.parse reads it back to the same value.
export const literal = value => JSON.stringify(value).replaceAll(HIDDEN_ALL, escapeHidden)
// A gloss of a text: itself, or as JSON where it holds a HIDDEN character.
const shown = text => (HIDDEN.test(text) ? literal(text) : text)
// A gloss cut short past GLOSS_WIDTH, never inside a pair of surrogates.
function clip(text) {
  if (text.length <= GLOSS_WIDTH) return text
  let end = GLOSS_WIDTH - 1
  if (/[\uDC00-\uDFFF]/u.test(text[end] ?? '')) end--
  return `${text.slice(0, end)}…`
}
const signed = number => (number < 0 ? `${number}` : `+${number}`)
export function counted(list) {
  const counts = new Map()
  for (const item of list) counts.set(item, (counts.get(item) ?? 0) + 1)
  return counts
}

// The rows that stand for a run of segments of no source, one of the source
// line the run above maps from, and open a map's mappings decoded.
export const RUN_OF_NO_SOURCE = '  ∅'
export const RUN_AS_ABOVE = '  ← ″'
export const MAPPINGS_OPEN = 'decoded {'

// Each source's name in a run's row (`←`): its file name where no other
// source has that file name, else its path where no other source has that
// path, else `#` and its index, as is one with a blank, a quote or a HIDDEN
// character in it; all by index where those would name two alike.
export function sourceLabels(sources) {
  const fileName = source => source.slice(source.lastIndexOf('/') + 1)
  const plain = text => /^[^#″"\s][^"\s]*$/u.test(text) && !HIDDEN.test(text)
  const fileNames = counted(sources.map(source => (typeof source === 'string' ? fileName(source) : null)))
  const paths = counted(sources)
  const labels = sources.map((source, i) => {
    if (typeof source !== 'string') return `#${i}`
    if (plain(fileName(source)) && fileNames.get(fileName(source)) === 1) return fileName(source)
    return plain(source) && paths.get(source) === 1 ? source : `#${i}`
  })
  return new Set(labels).size === labels.length ? labels : sources.map((_, i) => `#${i}`)
}

// Each name as a segment names it: as JSON, or by `#` and its index where
// `names` holds it more than once.
export function nameLabels(names) {
  const counts = counted(names)
  return names.map((name, i) => (counts.get(name) === 1 ? literal(name) : `#${i}`))
}

// A map's mappings as lines of segments, or why it has none: `sources` no
// list, `names` (where given) no list of strings, mappings the format doesn't
// allow (decodeMappings), or written otherwise than in the fewest digits,
// which rows read back wouldn't be. Shown as written then, as other values.
function decoded({ mappings, sources, names }) {
  if (typeof mappings !== 'string') return { lines: null, reason: null }
  if (!Array.isArray(sources)) return { lines: null, reason: 'its sources are no list.' }
  if (names !== undefined && !(Array.isArray(names) && names.every(name => typeof name === 'string'))) return { lines: null, reason: 'its names are no list of strings.' }
  let lines
  try {
    lines = decodeMappings(mappings, sources.length, names?.length ?? 0)
  } catch (err) {
    return { lines: null, reason: err.message }
  }
  if (encodeMappings(lines) !== mappings) return { lines: null, reason: 'its values are written in more digits than they need.' }
  return { lines, reason: null }
}

// Whether a value is listed an item to a line: a list of values that aren't
// lists or objects; a list of texts and nulls, as sourcesContent is, a text
// at a time.
const listed = value => Array.isArray(value) && value.length > 0 && value.every(item => item === null || typeof item !== 'object')
const texts = value => Array.isArray(value) && value.length > 0 && value.every(item => item === null || typeof item === 'string')

const IDENTIFIER = /[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*/uy
// What a minifier renamed in a run: the name at each named segment of the
// generated line, where it isn't the name the segment gives.
function renamesOf(text, run, names) {
  const renamed = new Set()
  for (const [column, , , , name] of run) {
    if (name === undefined || text.startsWith('${', column)) continue
    IDENTIFIER.lastIndex = column
    const id = IDENTIFIER.exec(text)?.[0]
    if (id !== undefined && id !== names[name]) renamed.add(`${shown(id)} ← ${shown(names[name])}`)
  }
  return [...renamed].join(', ')
}

// Rows of a listing, given up on past COPY_LIMIT characters.
function listingRows() {
  const lines = []
  let length = 0
  return {
    lines,
    push(line) {
      if ((length += line.length + 1) > COPY_LIMIT) throw new RangeError(`Its listing would run past ${COPY_LIMIT.toLocaleString('en')} characters.`)
      lines.push(line)
    },
  }
}

function header(out, value, generated, { lines, reason }) {
  out.push('# A source map listed: each of its keys in order, a value to a line; a list an item to a line, below its key;')
  out.push('# sourcesContent a text at each ┌, a line to a line (│ as written, ┊ as JSON, for a character that shows as another or none);')
  out.push('# mappings decoded: @ a line of the generated file; ← the source line the segments below map from, as lines on from the')
  out.push('# last mapped in that source, ″ the one above, ∅ none; each segment its column (+ past the one before), source column, name.')
  if (lines) {
    out.push(generated ? `# Glossed (@ ‹) with ${shown(generated.path)}, whose sourceMappingURL names this map.` : '# No file beside it whose sourceMappingURL names this map, to gloss it with.')
    const segments = lines.reduce((sum, line) => sum + line.length, 0)
    const mapped = lines.filter(line => line.some(segment => segment.length > 1)).length
    const withText = value.sources.filter((_, i) => typeof value.sourcesContent?.[i] === 'string').length
    out.push(`# Sources: ${value.sources.length} (${withText} with text) · names: ${value.names?.length ?? 0} · segments: ${segments} · lines: ${lines.length}, ${mapped} mapped.`)
  } else if (reason) {
    out.push(`# Its mappings are shown as written: ${reason}`)
  }
}

function textRows(out, head, items, sources) {
  out.push(`${head}[`)
  items.forEach((item, i) => {
    if (item === null) {
      out.push('  null')
      return
    }
    out.push(Array.isArray(sources) && i < sources.length ? `  ┌ ${clip(literal(sources[i]))}` : '  ┌')
    for (const line of item.split('\n')) out.push(HIDDEN.test(line) ? `  ┊ ${literal(line)}` : line === '' ? '  │' : `  │ ${line}`)
  })
  out.push(']')
}

const pieceRow = (text, from, to) => {
  const part = text.slice(from, to)
  return part === '' ? '    ‹' : `    ‹ ${clip(shown(part))}`
}
const sameRun = (a, b) => (a.length === 1 ? b.length === 1 : b.length > 1 && b[1] === a[1] && b[2] === a[2])

// A run's rows: what it maps from, the piece of a long line it covers, what
// it renamed, and its segments; the column of its last, for the next run's.
function runRows(map, run, { text, long, end, previous }) {
  const { out } = map
  const [first] = run
  if (first.length === 1) out.push(RUN_OF_NO_SOURCE)
  else if (map.above?.[0] === first[1] && map.above[1] === first[2]) out.push(RUN_AS_ABOVE)
  else {
    const [, source, line] = first
    const lines = map.sourceLines[source]
    const at = lines?.[line]?.trim()
    const gloss = lines === null || at === '' ? '' : at === undefined ? '  (past the end of its text)' : `  ${clip(shown(at))}`
    out.push(`  ← ${map.labels[source]} ${signed(line - map.last[source])}${gloss}`)
    map.last[source] = line
    map.above = [source, line]
  }
  if (long) out.push(pieceRow(text, first[0], end ?? text.length))
  const renamed = text === undefined ? '' : renamesOf(text, run, map.names)
  if (renamed !== '') out.push(`    renamed: ${clip(renamed)}`)
  const tokens = []
  let column = previous
  for (const segment of run) {
    const step = column === null ? `${segment[0]}` : signed(segment[0] - column)
    tokens.push(segment.length === 1 ? step : `${step}:${segment[3]}${segment.length === 5 ? ` ${map.nameOf[segment[4]]}` : ''}`)
    column = segment[0]
  }
  out.push(`      ${tokens.join(' ')}`)
  return column
}

// A generated line's rows: an `@` row glossed with its text, or how long it
// is where its runs gloss it a piece at a time, and its runs'.
function lineRows(map, segments, text, path) {
  const long = text !== undefined && text.length > WHOLE_LINE
  map.out.push(path === null || text === '' ? '@'
    : text === undefined ? `@ (past the end of ${shown(path)})`
    : long ? `@ (${text.length.toLocaleString('en')} characters)`
    : `@ ${clip(shown(text))}`)
  if (long && segments.length > 0 && segments[0][0] > 0) map.out.push(pieceRow(text, 0, segments[0][0]))
  let previous = null
  for (let i = 0; i < segments.length;) {
    let j = i + 1
    while (j < segments.length && sameRun(segments[i], segments[j])) j++
    previous = runRows(map, segments.slice(i, j), { text, long, end: segments[j]?.[0], previous })
    i = j
  }
}

function mappingsRows(out, head, value, lines, generated) {
  const names = value.names ?? []
  // The line each source was last mapped from, and the run above's source and line.
  const map = {
    out, names, labels: sourceLabels(value.sources), nameOf: nameLabels(names),
    sourceLines: value.sources.map((_, i) => (typeof value.sourcesContent?.[i] === 'string' ? value.sourcesContent[i].split(LINE_END) : null)),
    last: value.sources.map(() => 0), above: null,
  }
  const code = generated ? generated.text.split(LINE_END) : null
  out.push(`${head}${MAPPINGS_OPEN}`)
  lines.forEach((segments, g) => lineRows(map, segments, code?.[g], code === null ? null : generated.path))
  out.push('}')
}

// The listing of a map JSON.parse made (`value`), glossed with its generated
// file (`{ path, text }`) or none. Throws a RangeError past COPY_LIMIT.
export function sourcemapListing(value, generated) {
  const mappings = decoded(value), out = listingRows()
  header(out, value, generated, mappings)
  for (const key of Object.keys(value)) {
    const head = `${literal(key)}: `, item = value[key]
    if (key === 'mappings' && mappings.lines) mappingsRows(out, head, value, mappings.lines, generated)
    else if (key === 'sourcesContent' && texts(item)) textRows(out, head, item, value.sources)
    else if (listed(item)) {
      out.push(`${head}[`)
      for (const each of item) out.push(`  ${literal(each)}`)
      out.push(']')
    } else out.push(`${head}${literal(item)}`)
  }
  return `${out.lines.join('\n')}\n`
}
