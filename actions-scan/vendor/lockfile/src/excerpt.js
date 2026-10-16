// A piece of the input for a message: cut short where it runs long, as a
// line may be a megabyte and a message is for a person to read, and quoted
// as JSON quotes it, with the controls, line separators and bidi controls
// JSON leaves raw escaped, so input cannot act on a terminal or reorder
// what is shown.

const UNSHOWN = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu

// At most `max` code units, cut between characters.
export const cut = (text, max) => (text.length > max ? text.slice(0, text.codePointAt(max - 1) > 0xFFFF ? max - 1 : max) : text)

// A character by its code point, for one that is not shown.
export const hex = (char) => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`

export const quoted = (text) => JSON.stringify(text).replaceAll(UNSHOWN, (char) => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`)

// The TOML and YAML parsers': at most 64, and `...` after the quote where cut.
export const EXCERPT = 64

export function excerpt(text) {
  const short = cut(text, EXCERPT)
  return short === text ? quoted(text) : `${quoted(short)}...`
}

// An error at `line` of the input, counted from zero; the message counts
// from one. The YAML and TOML parsers' errors are of it.
export class LineError extends Error {
  constructor(detail, line) {
    super(line === undefined ? detail : `${detail} at line ${line + 1}`)
    this.name = new.target.name
    this.line = line
  }
}
