// Code search over a comparison — pure logic, no Lit / DOM / `state`, as
// bundle-search-scan.js is to the Code tab's: the lines each file's diff in
// Compare's Code shows that match a query. A file added is searched in its
// new text and a removed one in its old; a changed one in its new text, each
// line there added or unchanged, and in the lines its old text had that the
// new one dropped. Lines are numbered as the diff numbers them, from zero
// (bundle-compare-code-model.js), each hit naming its side: `b` the new text,
// `a` the old.
import { textLines } from '../../common/line-diff.js'

// As the Code tab's rail caps its code search (render-bundle.js): the files
// listed, and the lines each lists.
export const SEARCH_MAX_FILES = 100
export const SEARCH_MAX_FILE_HITS = 20

// A text's lines that match, `{ line, text, ranges }` each.
function matching(text, matcher) {
  const hits = []
  textLines(text).forEach((line, i) => {
    const ranges = matcher.ranges(line)
    if (ranges.length > 0) hits.push({ line: i, text: line, ranges })
  })
  return hits
}

// One file's hits in the order its diff shows them, each with its `side` and
// `sign`: `+` a line added, `−` one removed, ` ` one unchanged, null where its
// diff isn't known yet (`blocks` null), when only the new text is searched.
// `blocks` are the change blocks between its two texts, as lineDiff has them.
export function fileHits(before, after, matcher, blocks) {
  if (before === after) return matching(after, matcher).map(hit => ({ ...hit, side: 'b', sign: ' ' }))
  if (before === '') return matching(after, matcher).map(hit => ({ ...hit, side: 'b', sign: '+' }))
  if (after === '') return matching(before, matcher).map(hit => ({ ...hit, side: 'a', sign: '−' }))
  return changedHits(matching(after, matcher), matching(before, matcher), blocks)
}

// A changed file's hits, from those in its new text (`newer`) and its old
// (`older`).
function changedHits(newer, older, blocks) {
  if (!blocks) return newer.map(hit => ({ ...hit, side: 'b', sign: null }))
  const added = new Set(), dropped = new Map()
  for (const block of blocks) {
    for (let j = block.b0; j < block.b1; j++) added.add(j)
    for (let i = block.a0; i < block.a1; i++) dropped.set(i, block)
  }
  // A removed line shows over the lines added in its block, after the
  // unchanged line before that block.
  const at = hit => hit.side === 'b' ? [hit.line, 1] : [dropped.get(hit.line).b0, 0]
  return [
    ...newer.map(hit => ({ ...hit, side: 'b', sign: added.has(hit.line) ? '+' : ' ' })),
    ...older.filter(hit => dropped.has(hit.line)).map(hit => ({ ...hit, side: 'a', sign: '−' })),
  ].toSorted((x, y) => {
    const [xb, xs] = at(x), [yb, ys] = at(y)
    return xb - yb || xs - ys || x.line - y.line
  })
}

// `files` the comparison's, `{ path, before, after }` in the order to list
// them, a side without the file '' and one that isn't text skipped;
// `blocksOf(path, before, after)` a changed file's change blocks, or null
// where they aren't known (yet), asked for only where either text matches.
// Returns `{ files, hits, truncated }`: the files with a hit, `{ path, hits }`,
// each listing up to SEARCH_MAX_FILE_HITS lines; `hits` the lines listed;
// `truncated` where files were left out.
export function searchCompareFiles(files, matcher, blocksOf) {
  const found = []
  let hits = 0
  for (const { path, before, after } of files) {
    if (typeof before !== 'string' || typeof after !== 'string') continue
    let lines
    if (before === after || before === '' || after === '') {
      lines = fileHits(before, after, matcher, null)
    } else {
      const newer = matching(after, matcher), older = matching(before, matcher)
      if (newer.length === 0 && older.length === 0) continue
      lines = changedHits(newer, older, blocksOf(path, before, after))
    }
    if (lines.length === 0) continue
    if (found.length === SEARCH_MAX_FILES) return { files: found, hits, truncated: true }
    const listed = lines.slice(0, SEARCH_MAX_FILE_HITS)
    found.push({ path, hits: listed })
    hits += listed.length
  }
  return { files: found, hits, truncated: false }
}
