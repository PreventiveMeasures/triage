// The change blocks between two texts' lines, found by @preventive/diff: what
// the viewer's Compare diffs (ui/view/bundle-compare-code-model.js), and what
// the server's diff with renamed names hidden (rename-diff.js) is made of.
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

// Each `a[a0..a1)` replaced by `b[b0..b1)`. `ignoreWhitespace` is diff -w:
// lines differing only in whitespace pair up as unchanged.
export function changeBlocks(before, after, ignoreWhitespace = false) {
  const text = diff(before, after, { format: 'unified', context: 0, whitespace: ignoreWhitespace ? 'all' : 'none' })
  return text ? (parseDiff(text)[0]?.blocks ?? []).map(({ a0, a1, b0, b1 }) => ({ a0, a1, b0, b1 })) : []
}
