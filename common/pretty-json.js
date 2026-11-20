// JSON pretty-printed for reading, by the viewer (ui/view/pretty-source.js).

// Whether a path is JSON, which the viewer formats rather than the server.
export const jsonPrinted = path => /\.json$/iu.test(path)

const isContainer = value => value !== null && typeof value === 'object'

// `value` on one line, `{ "a": [1, 2] }`, or null where that is longer than
// `room`: given up on as soon as it is, as a long one is tried at every level.
function oneLine(value, room) {
  if (!isContainer(value)) {
    if (typeof value === 'string' && value.length + 2 > room) return null
    const text = JSON.stringify(value)
    return text.length <= room ? text : null
  }
  const array = Array.isArray(value), keys = array ? null : Object.keys(value)
  const count = array ? value.length : keys.length
  if (count === 0) return array ? '[]' : '{}'
  let text = array ? '[' : '{ '
  for (let i = 0; i < count && text.length <= room; i++) {
    if (i > 0) text += ', '
    if (!array) text += `${JSON.stringify(keys[i])}: `
    const part = oneLine(array ? value[i] : value[keys[i]], room - text.length - (array ? 1 : 2))
    if (part === null) return null
    text += part
  }
  text += array ? ']' : ' }'
  return text.length <= room ? text : null
}

// `data`, a value JSON.parse returned, laid out as `JSON.stringify(data,
// undefined, 2)` does, but for each object or array whose one-line form fits
// its line within `width`, kept on it, and an array of strings alone that
// doesn't, as many to a line as fit: each line to `push`, in order.
function layOut(data, width, push) {
  const write = (value, indent, head, tail) => {
    const line = oneLine(value, width - indent.length - head.length - tail.length)
    if (line !== null || !isContainer(value)) {
      push(`${indent}${head}${line ?? JSON.stringify(value)}${tail}`)
      return
    }
    const array = Array.isArray(value), keys = array ? null : Object.keys(value)
    const count = array ? value.length : keys.length
    push(`${indent}${head}${array ? '[' : '{'}`)
    if (array && value.every(item => typeof item === 'string')) {
      const room = width - indent.length - 2
      let row = ''
      for (const [i, item] of value.entries()) {
        const part = `${JSON.stringify(item)}${i < count - 1 ? ',' : ''}`
        if (row && row.length + 1 + part.length > room) {
          push(`${indent}  ${row}`)
          row = ''
        }
        row = row ? `${row} ${part}` : part
      }
      push(`${indent}  ${row}`)
    } else {
      for (let i = 0; i < count; i++) {
        write(array ? value[i] : value[keys[i]], `${indent}  `, array ? '' : `${JSON.stringify(keys[i])}: `, i < count - 1 ? ',' : '')
      }
    }
    push(`${indent}${array ? ']' : '}'}${tail}`)
  }
  write(data, '', '', '')
}

// `data` laid out (layOut) at `width`, 120 unless given. Throws past `limit`
// characters, which deep nesting can run to from a short text.
export function prettyJSON(data, { width = 120, limit = Infinity } = {}) {
  const lines = []
  let length = -1 // no line end before the first line
  layOut(data, width, line => {
    if ((length += line.length + 1) > limit) throw new RangeError(`The copy would run past ${limit.toLocaleString('en')} characters.`)
    lines.push(line)
  })
  return lines.join('\n')
}

const DIFFERS = Symbol('differs')

// Whether `text` is `data` laid out at `width` already (prettyJSON), but for
// a last line end: told at the first line that differs, never past its end.
export function laidOutAs(text, data, width) {
  let at = 0, lines = 0
  try {
    layOut(data, width, line => {
      if (lines++ > 0 && text[at++] !== '\n') throw DIFFERS
      if (!text.startsWith(line, at)) throw DIFFERS
      at += line.length
    })
  } catch (err) {
    if (err === DIFFERS) return false
    throw err
  }
  return at === text.length || (at === text.length - 1 && text[at] === '\n')
}

// The most characters a text's copy (prettyJsonText) runs to: four times the
// largest file formatted, far past what a file not nested hundreds deep needs.
const COPY_LIMIT = 16 * 1024 * 1024

// A JSON text without the blanks between its tokens.
const blankless = text => text.replaceAll(/("(?:[^"\\]+|\\.)*")|[\t\n\r ]+/gu, '$1')

// A JSON text pretty-printed (prettyJSON, `width` 0 for JSON.stringify's
// layout), keeping whether it ends in a line end, or null where it isn't JSON.
// Throws where the copy would read otherwise than the text: a key given
// twice, an escape or a number respelled.
export function prettyJsonText(text, { width } = {}) {
  let value
  try { value = JSON.parse(text) } catch { return null }
  if (!text.isWellFormed()) throw new Error('Its text has lone surrogates.')
  const copy = `${prettyJSON(value, { width, limit: COPY_LIMIT })}${text.endsWith('\n') ? '\n' : ''}`
  if (JSON.stringify(JSON.parse(copy)) !== JSON.stringify(value)) throw new Error('The copy reads as another value.')
  if (blankless(text) !== blankless(copy)) throw new Error('The copy would change more than its layout: a key given twice, or an escape, a number or the order of keys written otherwise.')
  return copy
}
