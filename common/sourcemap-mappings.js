// A source map's `mappings` read and written by the format's rules
// (ECMA-426): a line of segments to each line of the generated file, `;`
// between lines and `,` between segments, each segment one, four or five
// base64 VLQ values. The first is a column of the generated line, from the
// one before on the line; the others are an index into `sources`, a line and
// a column of that source, and an index into `names`, each from the segment
// before, whatever its line. Read strictly: whatever the format doesn't allow
// throws, so a listing (pretty-sourcemap.js) shows mappings as they are or
// not at all.

const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const DIGIT_OF = new Int8Array(128).fill(-1)
for (let i = 0; i < DIGITS.length; i++) DIGIT_OF[DIGITS.codePointAt(i)] = i
// Values are 32-bit, as the format has them: no more than seven digits.
const LIMIT = 2 ** 31
const COMMA = 44, SEMICOLON = 59

export class MappingsError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MappingsError'
  }
}

// `mappings` as `[line][segment]`, a segment `[column]` (mapped from no
// source) or `[column, source, line, column]`, with `name` after those where
// it has one, every value absolute and counted from zero. Throws a
// MappingsError for any character not a base64 digit or separator, a value
// cut short or past 32 bits, a segment of two, three or more than five
// values or none (`,,`, a `,` before a `;`), or one whose column, source,
// line or name falls outside zero, `sources` (`sourcesCount`) and `names`
// (`namesCount`).
export function decodeMappings(mappings, sourcesCount, namesCount) {
  const lines = []
  let line = []
  // The values so far: each a segment's, from the one before.
  let column = 0, name = 0, source = 0, sourceColumn = 0, sourceLine = 0
  let fields = [], shift = 0, value = 0
  const end = (separator, at) => {
    if (shift !== 0) throw new MappingsError(`A value is cut short before ${at}.`)
    if (fields.length === 0) {
      if (separator === COMMA || line.length > 0) throw new MappingsError(`An empty segment at ${at}.`)
      return
    }
    if (fields.length !== 1 && fields.length !== 4 && fields.length !== 5) throw new MappingsError(`A segment of ${fields.length} values before ${at}.`)
    column += fields[0]
    if (column < 0) throw new MappingsError(`A segment before ${at} is at a column before the line's first.`)
    const segment = [column]
    if (fields.length >= 4) {
      source += fields[1]
      sourceLine += fields[2]
      sourceColumn += fields[3]
      if (source < 0 || source >= sourcesCount) throw new MappingsError(`A segment before ${at} names source ${source}, of ${sourcesCount}.`)
      if (sourceLine < 0 || sourceColumn < 0) throw new MappingsError(`A segment before ${at} maps from before its source's first line or column.`)
      segment.push(source, sourceLine, sourceColumn)
      if (fields.length === 5) {
        name += fields[4]
        if (name < 0 || name >= namesCount) throw new MappingsError(`A segment before ${at} names name ${name}, of ${namesCount}.`)
        segment.push(name)
      }
    }
    line.push(segment)
    fields = []
  }
  for (let i = 0; i < mappings.length; i++) {
    const code = mappings.codePointAt(i)
    if (code === COMMA || code === SEMICOLON) {
      end(code, i)
      if (code === SEMICOLON) {
        lines.push(line)
        line = []
        column = 0
      }
      continue
    }
    const digit = DIGIT_OF[code] ?? -1
    if (digit < 0) throw new MappingsError(`${JSON.stringify(mappings[i])} at ${i} is no base64 digit.`)
    value += (digit & 31) * 2 ** shift
    shift += 5
    if (digit & 32) {
      if (shift >= 35) throw new MappingsError(`A value past 32 bits at ${i}.`)
      continue
    }
    const magnitude = Math.floor(value / 2)
    if (magnitude >= LIMIT) throw new MappingsError(`A value past 32 bits at ${i}.`)
    fields.push(value % 2 === 1 ? -magnitude : magnitude)
    value = 0
    shift = 0
  }
  end(SEMICOLON, mappings.length)
  lines.push(line)
  return lines
}

function vlq(number) {
  let text = '', value = number < 0 ? -number * 2 + 1 : number * 2
  do {
    let digit = value % 32
    value = Math.floor(value / 32)
    if (value > 0) digit += 32
    text += DIGITS[digit]
  } while (value > 0)
  return text
}

// Lines of segments as decodeMappings reads them, written as the format
// writes them, each value in the fewest digits: so for mappings as any
// generator writes them, `encodeMappings(decodeMappings(m, …))` is `m`.
export function encodeMappings(lines) {
  let name = 0, source = 0, sourceColumn = 0, sourceLine = 0
  return lines.map(line => {
    let column = 0
    return line.map(segment => {
      let text = vlq(segment[0] - column)
      column = segment[0]
      if (segment.length >= 4) {
        text += vlq(segment[1] - source) + vlq(segment[2] - sourceLine) + vlq(segment[3] - sourceColumn)
        ;[, source, sourceLine, sourceColumn] = segment
        if (segment.length === 5) {
          text += vlq(segment[4] - name)
          name = segment[4]
        }
      }
      return text
    }).join(',')
  }).join(';')
}
