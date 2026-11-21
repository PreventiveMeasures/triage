// Code search over a comparison — pure logic, no Lit / DOM / `state`: the
// lines each file's diff in Compare's Code shows that match a query. An added
// file is searched in its new text and a removed one in its old; a changed
// one in its new text and in the old lines it dropped. Lines are numbered
// from zero, as the diff numbers them (bundle-compare-code-model.js), each
// hit naming its side: `b` the new text, `a` the old.
import { alignLines, textLines } from './bundle-compare-code-model.js'

// As the Code tab's rail caps its code search: the files listed, and the lines each lists.
export const SEARCH_MAX_FILES = 100
export const SEARCH_MAX_FILE_HITS = 20

// A text's matching lines, `{ line, text, ranges }` each, the first `limit`
// of those from line `from` up to `to`.
function matching(lines, matcher, limit = SEARCH_MAX_FILE_HITS, from = 0, to = lines.length) {
  const hits = []
  for (let i = from; i < Math.min(to, lines.length) && hits.length < limit; i++) {
    const ranges = matcher.ranges(lines[i])
    if (ranges.length > 0) hits.push({ line: i, text: lines[i], ranges })
  }
  return hits
}

// A change block's split rows, `blocks` the file's blocks it is one of.
const alignFresh = (a, b, blocks, block) => alignLines(a, b, block)

// One file's first SEARCH_MAX_FILE_HITS hits in the order its diff shows
// them, unified or `split`, each with its `side` and `sign` (`+`, `−`, ` `,
// or null where its diff isn't known yet, `blocks` null, the new text alone
// searched). `blocks` are lineDiff's change blocks; `align` gives a block's
// split rows (a caller may keep them).
export function fileHits(before, after, matcher, blocks, { split = false, align = alignFresh } = {}) {
  if (before === after) return matching(textLines(after), matcher).map(hit => ({ ...hit, side: 'b', sign: ' ' }))
  if (before === '') return matching(textLines(after), matcher).map(hit => ({ ...hit, side: 'b', sign: '+' }))
  if (after === '') return matching(textLines(before), matcher).map(hit => ({ ...hit, side: 'a', sign: '−' }))
  return changedHits(textLines(before), textLines(after), matcher, blocks, split, align)
}

// A changed file's hits, from its old and new lines `a` and `b`.
function changedHits(a, b, matcher, blocks, split, align) {
  const newer = matching(b, matcher)
  if (!blocks) return newer.map(hit => ({ ...hit, side: 'b', sign: null }))
  // A line's change block on its side, found by binary search; null where unchanged.
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
  // Split, each changed line's row in its block, for the blocks a hit is in.
  const rows = new Map()
  if (split) {
    const hit = new Set([...newer.map(({ line }) => blockAt('b', line)), ...older.map(({ line }) => blockAt('a', line))])
    for (const block of hit) {
      if (!block) continue
      align(a, b, blocks, block).forEach(([left, right], row) => {
        if (left !== null) rows.set(`a${left}`, row)
        if (right !== null) rows.set(`b${right}`, row)
      })
    }
  }
  // A changed line shows after the unchanged line before its block: unified,
  // the block's removed lines over its added ones; split, row by row, the
  // removed line of a row before the added.
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

// `files` the comparison's `{ path, before, after }` in the order to list
// them (a missing side '', one not text skipped); `matcher` a substring's
// (buildSearchMatcher's), whose matches lie within a line; `blocksOf(path,
// before, after)` a changed file's change blocks, or null where not known
// yet, asked only where either text matches (a file with none left out, as
// its diff draws no rows). Returns `{ files, hits, truncated }`: the files
// with a hit, `{ path, hits }`, the lines listed, and whether files were left out.
export function searchCompareFiles(files, matcher, blocksOf, { split = false, align = alignFresh } = {}) {
  const found = []
  let hits = 0
  // A substring found in a line is in the whole text, and one found there lies within a line.
  const matches = text => text !== '' && matcher.ranges(text).length > 0
  for (const { path, before, after } of files) {
    if (typeof before !== 'string' || typeof after !== 'string') continue
    // A file matching on neither side is neither split into lines nor diffed.
    if (!matches(before) && (before === after || !matches(after))) continue
    // A changed one listed only where its diff shows a change (none where it hides what changed).
    const blocks = before !== after && before !== '' && after !== '' ? blocksOf(path, before, after) : null
    if (blocks?.length === 0) continue
    const lines = fileHits(before, after, matcher, blocks, { split, align })
    if (lines.length === 0) continue
    if (found.length === SEARCH_MAX_FILES) return { files: found, hits, truncated: true }
    found.push({ path, hits: lines })
    hits += lines.length
  }
  return { files: found, hits, truncated: false }
}
