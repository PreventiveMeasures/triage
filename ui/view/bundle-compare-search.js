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

// A text's lines that match, `{ line, text, ranges }` each, the first
// `limit` of those `kept` (by line number), so a common query over a large
// text stops at what is listed.
function matching(text, matcher, limit = SEARCH_MAX_FILE_HITS, kept = () => true) {
  const hits = []
  const lines = textLines(text)
  for (let i = 0; i < lines.length && hits.length < limit; i++) {
    if (!kept(i)) continue
    const ranges = matcher.ranges(lines[i])
    if (ranges.length > 0) hits.push({ line: i, text: lines[i], ranges })
  }
  return hits
}

// One file's first SEARCH_MAX_FILE_HITS hits in the order its diff shows
// them, unified or `split`, each with its `side` and `sign`: `+` a line
// added, `−` one removed, ` ` one unchanged, null where its diff isn't known
// yet (`blocks` null), when only the new text is searched. `blocks` are the
// change blocks between its two texts, as lineDiff has them.
export function fileHits(before, after, matcher, blocks, { split = false } = {}) {
  if (before === after) return matching(after, matcher).map(hit => ({ ...hit, side: 'b', sign: ' ' }))
  if (before === '') return matching(after, matcher).map(hit => ({ ...hit, side: 'b', sign: '+' }))
  if (after === '') return matching(before, matcher).map(hit => ({ ...hit, side: 'a', sign: '−' }))
  return changedHits(before, after, matcher, blocks, split)
}

// A changed file's hits: the first of its new text's lines, and of its old
// text's lines its new one dropped, in the order its diff shows them.
function changedHits(before, after, matcher, blocks, split) {
  const newer = matching(after, matcher)
  if (!blocks) return newer.map(hit => ({ ...hit, side: 'b', sign: null }))
  const added = new Map(), dropped = new Map()
  for (const block of blocks) {
    for (let j = block.b0; j < block.b1; j++) added.set(j, block)
    for (let i = block.a0; i < block.a1; i++) dropped.set(i, block)
  }
  // A changed line shows after the unchanged line before its block: unified,
  // the block's removed lines over its added ones; split, the two sides row
  // by row, a removed line beside the added one at its place in the block.
  const at = hit => {
    const block = (hit.side === 'a' ? dropped : added).get(hit.line)
    if (!block) return [hit.line, 1, 0, 0]
    if (split) return [block.b0, 0, hit.line - (hit.side === 'a' ? block.a0 : block.b0), hit.side === 'a' ? 0 : 1]
    return hit.side === 'a' ? [block.b0, 0, 0, hit.line] : [hit.line, 1, 0, 0]
  }
  return [
    ...newer.map(hit => ({ ...hit, side: 'b', sign: added.has(hit.line) ? '+' : ' ' })),
    ...matching(before, matcher, SEARCH_MAX_FILE_HITS, i => dropped.has(i)).map(hit => ({ ...hit, side: 'a', sign: '−' })),
  ].toSorted((x, y) => {
    const kx = at(x), ky = at(y)
    return kx[0] - ky[0] || kx[1] - ky[1] || kx[2] - ky[2] || kx[3] - ky[3]
  }).slice(0, SEARCH_MAX_FILE_HITS)
}

// `files` the comparison's, `{ path, before, after }` in the order to list
// them, a side without the file '' and one that isn't text skipped;
// `blocksOf(path, before, after)` a changed file's change blocks, or null
// where they aren't known (yet), asked for only where either text matches;
// `split` the diff's layout, which orders a change block's lines.
// Returns `{ files, hits, truncated }`: the files with a hit, `{ path, hits }`,
// each listing up to SEARCH_MAX_FILE_HITS lines, collected no further;
// `hits` the lines listed; `truncated` where files were left out.
export function searchCompareFiles(files, matcher, blocksOf, { split = false } = {}) {
  const found = []
  let hits = 0
  for (const { path, before, after } of files) {
    if (typeof before !== 'string' || typeof after !== 'string') continue
    let lines
    if (before === after || before === '' || after === '') {
      lines = fileHits(before, after, matcher, null)
    } else {
      // Diffed only where either text matches at all.
      if (matching(after, matcher, 1).length === 0 && matching(before, matcher, 1).length === 0) continue
      lines = changedHits(before, after, matcher, blocksOf(path, before, after), split)
    }
    if (lines.length === 0) continue
    if (found.length === SEARCH_MAX_FILES) return { files: found, hits, truncated: true }
    found.push({ path, hits: lines })
    hits += lines.length
  }
  return { files: found, hits, truncated: false }
}
