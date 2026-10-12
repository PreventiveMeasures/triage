// Code search over a comparison — pure logic, no Lit / DOM / `state`, as
// bundle-search-scan.js is to the Code tab's: the lines each file's diff in
// Compare's Code shows that match a query. A file added is searched in its
// new text and a removed one in its old; a changed one in its new text, each
// line there added or unchanged, and in the lines its old text had that the
// new one dropped. Lines are numbered as the diff numbers them, from zero
// (bundle-compare-code-model.js), each hit naming its side: `b` the new text,
// `a` the old.
import { alignLines, textLines } from './bundle-compare-code-model.js'

// As the Code tab's rail caps its code search (render-bundle.js): the files
// listed, and the lines each lists.
export const SEARCH_MAX_FILES = 100
export const SEARCH_MAX_FILE_HITS = 20

// A text's lines (`lines`) that match, `{ line, text, ranges }` each, the
// first `limit` of those from line `from` up to `to`, so a common query over
// a large text stops at what is listed.
function matching(lines, matcher, limit = SEARCH_MAX_FILE_HITS, from = 0, to = lines.length) {
  const hits = []
  for (let i = from; i < Math.min(to, lines.length) && hits.length < limit; i++) {
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
  if (before === after) return matching(textLines(after), matcher).map(hit => ({ ...hit, side: 'b', sign: ' ' }))
  if (before === '') return matching(textLines(after), matcher).map(hit => ({ ...hit, side: 'b', sign: '+' }))
  if (after === '') return matching(textLines(before), matcher).map(hit => ({ ...hit, side: 'a', sign: '−' }))
  return changedHits(textLines(before), textLines(after), matcher, blocks, split)
}

// A changed file's hits, from its old and new texts' lines `a` and `b`: the
// first of its new text's lines, and of its old text's lines its new one
// dropped, in the order its diff shows them.
function changedHits(a, b, matcher, blocks, split) {
  const newer = matching(b, matcher)
  if (!blocks) return newer.map(hit => ({ ...hit, side: 'b', sign: null }))
  // A line's change block on its side (`a0`–`a1` old, `b0`–`b1` new), found
  // among the blocks in order, not by indexing every changed line; null where
  // the line is unchanged.
  const blockAt = (side, line) => {
    const [start, end] = side === 'a' ? ['a0', 'a1'] : ['b0', 'b1']
    let high = blocks.length, low = 0
    while (low < high) {
      const mid = (low + high) >> 1
      if (blocks[mid][end] <= line) low = mid + 1
      else high = mid
    }
    return low < blocks.length && blocks[low][start] <= line ? blocks[low] : null
  }
  // The old lines dropped, read block by block up to those listed.
  const older = []
  for (const { a0, a1 } of blocks) {
    if (older.length === SEARCH_MAX_FILE_HITS) break
    older.push(...matching(a, matcher, SEARCH_MAX_FILE_HITS - older.length, a0, a1))
  }
  // Split, each changed line's row in its block, aligned as the view aligns
  // them (alignLines), in the blocks a hit is in.
  const rows = new Map()
  if (split) {
    const hit = new Set([...newer.map(({ line }) => blockAt('b', line)), ...older.map(({ line }) => blockAt('a', line))])
    for (const block of hit) {
      if (!block) continue
      alignLines(a, b, block).forEach(([left, right], row) => {
        if (left !== null) rows.set(`a${left}`, row)
        if (right !== null) rows.set(`b${right}`, row)
      })
    }
  }
  // A changed line shows after the unchanged line before its block: unified,
  // the block's removed lines over its added ones; split, the two sides row
  // by row, the removed line of a row before the added.
  const at = hit => {
    const block = blockAt(hit.side, hit.line)
    if (!block) return [hit.line, 1, 0, 0]
    if (split) return [block.b0, 0, rows.get(`${hit.side}${hit.line}`), hit.side === 'a' ? 0 : 1]
    return hit.side === 'a' ? [block.b0, 0, 0, hit.line] : [hit.line, 1, 0, 0]
  }
  return [
    ...newer.map(hit => ({ ...hit, side: 'b', sign: blockAt('b', hit.line) ? '+' : ' ' })),
    ...older.map(hit => ({ ...hit, side: 'a', sign: '−' })),
  ].toSorted((x, y) => {
    const kx = at(x), ky = at(y)
    return kx[0] - ky[0] || kx[1] - ky[1] || kx[2] - ky[2] || kx[3] - ky[3]
  }).slice(0, SEARCH_MAX_FILE_HITS)
}

// `files` the comparison's, `{ path, before, after }` in the order to list
// them, a side without the file '' and one that isn't text skipped;
// `matcher` a substring's (buildSearchMatcher's, not a regular expression's),
// whose matches lie within a line; `blocksOf(path, before, after)` a changed
// file's change blocks, or null where they aren't known (yet), asked for
// only where either text matches, a file they find no change in left out,
// as its diff draws no rows; `split` the diff's layout, which orders a
// change block's lines.
// Returns `{ files, hits, truncated }`: the files with a hit, `{ path, hits }`,
// each listing up to SEARCH_MAX_FILE_HITS lines, collected no further;
// `hits` the lines listed; `truncated` where files were left out.
export function searchCompareFiles(files, matcher, blocksOf, { split = false } = {}) {
  const found = []
  let hits = 0
  // Whether a text matches anywhere, read whole: a substring found in a
  // line is in the whole text, and one found there lies within a line.
  const matches = text => text !== '' && matcher.ranges(text).length > 0
  for (const { path, before, after } of files) {
    if (typeof before !== 'string' || typeof after !== 'string') continue
    // A file matching on neither side is neither split into lines nor diffed.
    if (!matches(before) && (before === after || !matches(after))) continue
    let lines
    if (before === after || before === '' || after === '') {
      lines = fileHits(before, after, matcher, null)
    } else {
      // Listed only where its diff shows a change (none where it hides what
      // changed, as whitespace).
      const a = textLines(before), b = textLines(after)
      const blocks = blocksOf(path, before, after)
      if (blocks?.length === 0) continue
      lines = changedHits(a, b, matcher, blocks, split)
    }
    if (lines.length === 0) continue
    if (found.length === SEARCH_MAX_FILES) return { files: found, hits, truncated: true }
    found.push({ path, hits: lines })
    hits += lines.length
  }
  return { files: found, hits, truncated: false }
}
