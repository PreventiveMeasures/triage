import { lineDiff } from './bundle-compare-code-model.js'

// Directories before files at every depth, matching the review tree even when
// some folders are collapsed. All file navigation uses this same order.
export function compareReviewPaths(a, b) {
  const left = a.split('/'), right = b.split('/')
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] === right[i]) continue
    return Number(i < right.length - 1) - Number(i < left.length - 1) || left[i].localeCompare(right[i])
  }
  return left.length - right.length
}

const lines = text => text === '' ? 0 : (text.match(/\n/gu)?.length ?? 0) + Number(!text.endsWith('\n'))
export function reviewLineCounts({ before, after }) {
  if (typeof before !== 'string' || typeof after !== 'string') return null
  if (before === '') return { additions: lines(after), deletions: 0 }
  if (after === '') return { additions: 0, deletions: lines(before) }
  // Keep navigation cheap for very large files; their diff can still be opened
  // explicitly in the code viewer. Only visible tree rows request these counts.
  if (before.length + after.length > 2_000_000 || lines(before) + lines(after) > 20_000) return null
  const { additions, deletions } = lineDiff(before, after)
  return { additions, deletions }
}
