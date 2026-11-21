// The bundle Search tab's scan, pure logic (render-bundle.js renders it).
// Plain queries match as a case-insensitive substring, the `.*` modifier as
// a regular expression per line.
//
// Walking every line of every source is the expensive part, so
// `runBundleSearch` keeps recent results by bundle tag and modifiers: the
// same query (case-folded for substrings) replays its result, truncated or
// not, as the scan is deterministic; a substring query containing an
// earlier one whose result is exhaustive ("foo" → "food") re-checks only its
// hit lines, as every line the longer matches the shorter did. A truncated
// base is missing matches past its cap, and regex containment says nothing
// of matches (`a|b` contains `a`). Tags are bundle integrities, which
// content-address the sources, so cached `lines` never go stale.
//
// A result is `{ fileResults, totalHits, truncated }`, or `{ error }` for a
// regex that doesn't compile. `fileResults` follow the caller's `order` (own
// source first: ownSourceFirst), else sorted paths, so the caps cut its end;
// each is `{ path, lines, hits }`, `lines` the content split (refinements
// share their base's), `hits` its matched lines `{ ln, ranges }`, `ln`
// 1-based, `ranges` [start, end) spans. `totalHits` counts matched lines.

// Caps a keystroke's work and DOM, as a bare `.` matches almost everything:
// past them a result is truncated.
export const SEARCH_MAX_TOTAL_HITS = 5000
export const SEARCH_MAX_FILES = 500
export const SEARCH_MAX_MARKS_PER_LINE = 50

// Recent results kept, for a typing burst and a few backspaces; each costs
// its hit list, sharing its `lines` with the result it refined.
const SEARCH_HISTORY_MAX = 8

// A pattern for the regex modifier, `{ re }` or `{ error }`: Unicode mode,
// else legacy mode for what `u` rejects but a user reasonably types (a bare
// `{` or `}`, a redundant escape), matching those as literals.
function compileSearchRegex(pattern, caseSensitive) {
  const unicodeFlags = caseSensitive ? 'gu' : 'giu'
  const legacyFlags = caseSensitive ? 'g' : 'gi'
  try {
    return { re: new RegExp(pattern, unicodeFlags) }
  } catch {
    try {
      // eslint-disable-next-line require-unicode-regexp
      return { re: new RegExp(pattern, legacyFlags) }
    } catch (err) {
      return { error: err.message }
    }
  }
}

// A line matcher: `.ranges(line)` the [start, end) spans matching, capped a
// line; `{ error }` for a regex that doesn't compile. Zero-width regex
// matches are skipped, so `^`, `$` or `a*` can't spin.
export function buildSearchMatcher(query, useRegex, caseSensitive) {
  if (useRegex) {
    const compiled = compileSearchRegex(query, caseSensitive)
    if (compiled.error) return { error: compiled.error }
    const { re } = compiled
    return {
      ranges(line) {
        re.lastIndex = 0
        const out = []
        let m
        while ((m = re.exec(line)) !== null) {
          if (m[0].length === 0) { re.lastIndex++; continue }
          out.push([m.index, m.index + m[0].length])
          if (out.length >= SEARCH_MAX_MARKS_PER_LINE) break
        }
        return out
      },
    }
  }
  const needle = caseSensitive ? query : query.toLowerCase()
  const len = needle.length
  return {
    ranges(line) {
      const hay = caseSensitive ? line : line.toLowerCase()
      const out = []
      let from = 0
      let idx
      while ((idx = hay.indexOf(needle, from)) !== -1) {
        out.push([idx, idx + len])
        from = idx + len
        if (out.length >= SEARCH_MAX_MARKS_PER_LINE) break
      }
      return out
    },
  }
}

// Every line of every text source, in scan order, to the caps.
function fullSearch(sources, matcher, allPaths) {
  const fileResults = []
  let totalHits = 0
  let truncated = false
  for (const path of allPaths) {
    const content = sources.get(path)
    if (typeof content !== 'string') continue
    const lines = content.split('\n')
    const hits = []
    for (let i = 0; i < lines.length; i++) {
      const ranges = matcher.ranges(lines[i])
      if (ranges.length === 0) continue
      hits.push({ ln: i + 1, ranges })
      totalHits++
      if (totalHits >= SEARCH_MAX_TOTAL_HITS) { truncated = true; break }
    }
    if (hits.length > 0) fileResults.push({ path, lines, hits })
    if (truncated) break
    if (fileResults.length >= SEARCH_MAX_FILES) { truncated = true; break }
  }
  return { fileResults, totalHits, truncated }
}

// The hit lines of an exhaustive result whose query the new one contains,
// checked again; exhaustive in turn, as a subset of one under the caps.
function refineSearch(base, matcher) {
  const fileResults = []
  let totalHits = 0
  for (const { path, lines, hits } of base.fileResults) {
    const kept = []
    for (const { ln } of hits) {
      const ranges = matcher.ranges(lines[ln - 1])
      if (ranges.length === 0) continue
      kept.push({ ln, ranges })
      totalHits++
    }
    if (kept.length > 0) fileResults.push({ path, lines, hits: kept })
  }
  return { fileResults, totalHits, truncated: false }
}

// Results, most recent first, of one tag and modifier set at a time.
const history = { tag: null, useRegex: false, caseSensitive: false, entries: [] }

export function runBundleSearch(tag, sources, query, useRegex, caseSensitive, order = null) {
  // Never kept: every query contains '', so it would base any refinement.
  if (!query) return { fileResults: [], totalHits: 0, truncated: false }
  const matcher = buildSearchMatcher(query, useRegex, caseSensitive)
  // A regex not compiling yet (`foo(`) leaves the history to serve on.
  if (matcher.error) return { error: matcher.error }
  if (history.tag !== tag || history.useRegex !== useRegex || history.caseSensitive !== caseSensitive) {
    history.tag = tag
    history.useRegex = useRegex
    history.caseSensitive = caseSensitive
    history.entries.length = 0
  }
  // Substrings matching case-insensitively are the same search folded;
  // patterns compare verbatim, as `i` doesn't fold pattern text (`\W`).
  const fold = useRegex || caseSensitive ? (q) => q : (q) => q.toLowerCase()
  const key = fold(query)
  let base = null
  let baseLen = -1
  for (let i = 0; i < history.entries.length; i++) {
    const entry = history.entries[i]
    const entryKey = fold(entry.query)
    if (entryKey === key) {
      // Moved to the front, so a query returned to outlives a burst.
      history.entries.splice(i, 1)
      history.entries.unshift(entry)
      return entry.result
    }
    if (useRegex || entry.result.truncated) continue
    if (entryKey.length <= baseLen || !key.includes(entryKey)) continue
    // The longest contained query leaves the fewest lines to check.
    base = entry.result
    baseLen = entryKey.length
  }
  const result = base ? refineSearch(base, matcher) : fullSearch(sources, matcher, order ?? [...sources.keys()].toSorted())
  history.entries.unshift({ query, result })
  if (history.entries.length > SEARCH_HISTORY_MAX) history.entries.pop()
  return result
}
