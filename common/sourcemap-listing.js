// How a source map is listed (pretty-sourcemap.js): its values alone, each
// key in order, its value as JSON on the key's row, but a list's items each on
// a row of its own below it, sourcesContent's texts line by line, mappings a
// line of the generated file to a row, and what follows the JSON (a line end)
// as JSON on the last row. A segment is its values as the format writes them,
// from the one before (sourcemap-mappings.js mappingsDeltas), so that a line
// added above moves none of the rows below.
import { UNSEEN } from '../risk/files/characters.js'
import { COPY_LIMIT } from './pretty-json.js'
import { decodeMappings, encodeMappings, mappingsDeltas } from './sourcemap-mappings.js'

// A line of a text written as JSON (`┊`) where it holds a character that
// shows as another or none (risk/files/characters.js UNSEEN), so that a
// listing never leaves one to the viewer.
const UNSEEN_ALL = new RegExp(UNSEEN.source, 'gu')
function escapeUnseen(char) {
  const point = char.codePointAt(0)
  const units = point > 0xFFFF ? [Math.floor((point - 0x10000) / 0x400) + 0xD800, ((point - 0x10000) % 0x400) + 0xDC00] : [point]
  return units.map(unit => `\\u${unit.toString(16).padStart(4, '0')}`).join('')
}
// A JSON value as JSON.stringify writes it, but for its UNSEEN characters
// escaped: JSON.parse reads it back to the same value.
export const literal = value => JSON.stringify(value).replaceAll(UNSEEN_ALL, escapeUnseen)

// What opens a map's mappings decoded, on its key's row; `}` closes them.
export const MAPPINGS_OPEN = '{'

// A map's mappings as lines of segments, or null where they are shown as
// written: `sources` (or `names`, where given) no list, mappings the format
// doesn't allow (decodeMappings), or written otherwise than in the fewest
// digits, which rows read back wouldn't be.
function decoded({ mappings, sources, names }) {
  if (typeof mappings !== 'string' || !Array.isArray(sources) || !(names === undefined || Array.isArray(names))) return null
  let lines
  try {
    lines = decodeMappings(mappings, sources.length, names?.length ?? 0)
  } catch {
    return null
  }
  return encodeMappings(lines) === mappings ? lines : null
}

// Whether a value is listed an item to a row: a list of values each of which
// is null or holds to `each`.
const listOf = (value, each) => Array.isArray(value) && value.length > 0 && value.every(item => item === null || each(item))

// The listing of a map JSON.parse made (`value`), and what followed its JSON
// in the text (`trailing`, blanks). Throws a RangeError past COPY_LIMIT.
export function sourcemapListing(value, trailing = '') {
  const lines = [], mappings = decoded(value)
  let length = 0
  const push = line => {
    if ((length += line.length + 1) > COPY_LIMIT) throw new RangeError(`Its listing would run past ${COPY_LIMIT.toLocaleString('en')} characters.`)
    lines.push(line)
  }
  for (const key of Object.keys(value)) {
    const head = `${literal(key)}: `, item = value[key]
    if (key === 'mappings' && mappings) {
      push(`${head}${MAPPINGS_OPEN}`)
      for (const line of mappingsDeltas(mappings)) push(line.length === 0 ? '' : `  ${line.map(values => values.join(' ')).join(', ')}`)
      push('}')
    } else if (key === 'sourcesContent' && listOf(item, text => typeof text === 'string')) {
      push(`${head}[`)
      item.forEach((text, i) => {
        if (text === null) return push('  null')
        push(Array.isArray(value.sources) && i < value.sources.length ? `  ┌ ${literal(value.sources[i])}` : '  ┌')
        for (const line of text.split('\n')) push(UNSEEN.test(line) ? `  ┊ ${literal(line)}` : line === '' ? '  │' : `  │ ${line}`)
      })
      push(']')
    } else if (listOf(item, each => typeof each !== 'object')) {
      push(`${head}[`)
      for (const each of item) push(`  ${literal(each)}`)
      push(']')
    } else push(`${head}${literal(item)}`)
  }
  if (trailing !== '') push(literal(trailing))
  return `${lines.join('\n')}\n`
}
