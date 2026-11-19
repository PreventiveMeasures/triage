// JSON pretty-printed for reading, by the viewer (ui/view/pretty-source.js).

const isContainer = value => value !== null && typeof value === 'object'
const isBlank = char => char === ' ' || char === '\n' || char === '\r' || char === '\t'

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
// its line within `width`, kept on it.
export function prettyJSON(data, { width = 120 } = {}) {
  const lines = []
  const write = (value, indent, head, tail) => {
    const line = oneLine(value, width - indent.length - head.length - tail.length)
    if (line !== null || !isContainer(value)) {
      lines.push(`${indent}${head}${line ?? JSON.stringify(value)}${tail}`)
      return
    }
    const array = Array.isArray(value), keys = array ? null : Object.keys(value)
    const count = array ? value.length : keys.length
    lines.push(`${indent}${head}${array ? '[' : '{'}`)
    for (let i = 0; i < count; i++) {
      write(array ? value[i] : value[keys[i]], `${indent}  `, array ? '' : `${JSON.stringify(keys[i])}: `, i < count - 1 ? ',' : '')
    }
    lines.push(`${indent}${array ? ']' : '}'}${tail}`)
  }
  write(data, '', '', '')
  return lines.join('\n')
}

// Whether two JSON texts differ only in the blanks between their tokens.
function sameTokens(a, b) {
  let i = 0, j = 0, string = false
  for (;;) {
    if (!string) {
      while (isBlank(a[i])) i++
      while (isBlank(b[j])) j++
    }
    if (i >= a.length || j >= b.length) return i >= a.length && j >= b.length
    const char = a[i]
    if (char !== b[j]) return false
    if (string && char === '\\') {
      i++
      j++
      if (a[i] !== b[j]) return false
    } else if (char === '"') string = !string
    i++
    j++
  }
}

// A JSON text pretty-printed (prettyJSON), keeping whether it ends in a line
// end, or null where it isn't JSON. Throws where the copy would read
// otherwise than the text: a key given twice, an escape or a number respelled.
export function prettyJsonText(text, options) {
  let value
  try { value = JSON.parse(text) } catch { return null }
  if (!text.isWellFormed()) throw new Error('Its text has lone surrogates.')
  const copy = `${prettyJSON(value, options)}${text.endsWith('\n') ? '\n' : ''}`
  if (JSON.stringify(JSON.parse(copy)) !== JSON.stringify(value)) throw new Error('The copy reads as another value.')
  if (!sameTokens(text, copy)) throw new Error('The copy would change more than its layout: a key given twice, or an escape, a number or the order of keys written otherwise.')
  return copy
}
