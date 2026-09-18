// CSS-side adapter over @preventive/diff/color.js, which does the
// recognising: which of the three formats a block of text is written
// in, and what part each line plays, from the text's own markers
// rather than from the command that ran — so `cat` of a patch file is
// coloured too. The terminal package's REPL colorizer calls the same
// function; only the painting differs, a stream there, classes here.

import { diffLineStyles } from '@preventive/diff/color.js'

// Styles are named as node:util's styleText names them, for that ANSI
// caller. Against theme tokens the names mislead — `cyan` is the accent
// blue, `bold` no hue at all — so they are translated once, here.
const KIND = { bold: 'head', cyan: 'hunk', green: 'add', red: 'del', yellow: 'chg', gray: 'meta' }

// null when the text is not a diff, leaving the caller to render it as
// the one text node it already was. An empty `kind` leaves a line
// unwrapped — most of a unified diff is context lines — and a style
// this map doesn't know falls back to it, rendering that line plain
// rather than emitting a dead class name.
export function classifyDiff(text) {
  const styles = diffLineStyles(text)
  if (styles === null) return null
  return text.split('\n').map((line, i) => ({
    text: line,
    kind: styles[i] === null ? '' : KIND[styles[i]] ?? '',
  }))
}
