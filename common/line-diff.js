// The change blocks between two texts' lines, found by @preventive/diff: what
// the viewer's Compare diffs (ui/view/bundle-compare-code-model.js), and the
// server's diff with renamed names hidden (server-managed/rename-diff.ts).
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
// row), but for diff -w, which ignores it as it does other whitespace.
const endsLine = text => text === '' || text.endsWith('\n')

// Each `a[a0..a1)` replaced by `b[b0..b1)`. `ignoreWhitespace` is diff -w:
// lines differing only in whitespace pair up as unchanged.
export function changeBlocks(before, after, ignoreWhitespace = false) {
  const text = diff(before, after, { format: 'unified', context: 0, whitespace: ignoreWhitespace ? 'all' : 'none' })
  return text ? (parseDiff(text)[0]?.blocks ?? []).map(({ a0, a1, b0, b1 }) => ({ a0, a1, b0, b1 })) : []
}

// Whether `blocks` take `before`'s lines to `after`'s: each in order and apart
// from the last, within both texts, and every line between them alike on both
// sides (alike but for whitespace where `ignoreWhitespace`, as diff -w has
// them), the last line in a block where a newline was added or dropped after
// it, so that a diff drawn from them hides no change. A check on what
// changeBlocks found, or on one found apart from the texts drawn.
export function blocksHold(before, after, blocks, ignoreWhitespace = false) {
  if (!Array.isArray(blocks)) return false
  const a = textLines(before), b = textLines(after)
  const alike = ignoreWhitespace ? (x, y) => x.replaceAll(/\s/gu, '') === y.replaceAll(/\s/gu, '') : (x, y) => x === y
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

// The blocks of the diff of `before` and `after` whose lines differ in names
// renamed alone: those whose old lines, as `given` has them (the old text with
// the new side's names, line for line), are their new lines, alike as the
// diff has lines alike, and no newline added or dropped after their last.
// None (null) where `given` has other lines than `before`.
export function markedBlocks(before, given, after, ignoreWhitespace = false) {
  const news = textLines(after), renamed = textLines(given)
  if (renamed.length !== textLines(before).length) return null
  const alike = ignoreWhitespace ? (x, y) => x.replaceAll(/\s/gu, '') === y.replaceAll(/\s/gu, '') : (x, y) => x === y
  const ended = endsLine(before) === endsLine(after)
  return changeBlocks(before, after, ignoreWhitespace)
    .filter(({ a0, a1, b0, b1 }) => a1 - a0 === b1 - b0 && (ended || b1 < news.length) && renamed.slice(a0, a1).every((line, k) => alike(line, news[b0 + k])))
}
