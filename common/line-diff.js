// The change blocks between two texts' lines, found by @preventive/diff: what
// the viewer's Compare diffs (ui/view/bundle-compare-code-model.js); and the
// server's check, apart from @preventive/compare's own, that its diff with
// renamed names hidden takes the old side to the new (server-managed/rename-diff.ts).
//
// Lines are numbered the way the diff numbers them: from zero, a final
// newline ending the last line rather than starting an empty one.
import { diff, parseDiff } from '@preventive/diff'

export function textLines(text) {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

// Whether a text's last line ends in a newline. One added or dropped there is
// a change of that line, as diff has it (the viewer marks it on that line's
// row), but for diff -b, which ignores it as it does other trailing blanks.
const endsLine = text => text === '' || text.endsWith('\n')

// A line as diff -b reads it (@preventive/diff's): a run of the C locale's
// blanks as one space, and those that end it as none.
const spacing = line => line.replace(/[ \t\n\v\f\r]+$/u, '').replaceAll(/[ \t\n\v\f\r]+/gu, ' ')

// Each `a[a0..a1)` replaced by `b[b0..b1)`. `ignoreWhitespace` is diff -b:
// lines differing only in how much whitespace they have pair up as unchanged,
// whitespace added or removed between other characters still a change.
export function changeBlocks(before, after, ignoreWhitespace = false) {
  const text = diff(before, after, { format: 'unified', context: 0, whitespace: ignoreWhitespace ? 'change' : 'none' })
  return text ? (parseDiff(text)[0]?.blocks ?? []).map(({ a0, a1, b0, b1 }) => ({ a0, a1, b0, b1 })) : []
}

// Whether `blocks` take `before`'s lines to `after`'s: each in order and apart
// from the last, within both texts, and every line between them alike on both
// sides (alike but for how much whitespace they have where `ignoreWhitespace`,
// as diff -b has them), the last line in a block where a newline was added or
// dropped after it, so that a diff drawn from them hides no change. A check on
// what changeBlocks found, or on one found apart from the texts drawn.
export function blocksHold(before, after, blocks, ignoreWhitespace = false) {
  if (!Array.isArray(blocks)) return false
  const a = textLines(before), b = textLines(after)
  const alike = ignoreWhitespace ? (x, y) => spacing(x) === spacing(y) : (x, y) => x === y
  let i = 0, j = 0
  for (const block of [...blocks, { a0: a.length, a1: a.length, b0: b.length, b1: b.length, last: true }]) {
    const { a0, a1, b0, b1 } = block ?? {}
    if (![a0, a1, b0, b1].every(Number.isInteger) || a0 < i || b0 < j || a1 < a0 || b1 < b0 || a1 > a.length || b1 > b.length) return false
    // A block changes a line, and as many lines are alike before it on each side.
    if ((!block.last && a1 === a0 && b1 === b0) || a0 - i !== b0 - j) return false
    if (block.last && a0 > i && !ignoreWhitespace && endsLine(before) !== endsLine(after)) return false
    for (; i < a0; i++, j++) if (!alike(a[i], b[j])) return false
    i = a1
    j = b1
  }
  return true
}
