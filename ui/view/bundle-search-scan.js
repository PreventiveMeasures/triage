// Scan engine behind the bundle Search tab — pure logic, no Lit /
// DOM / `state` (the same split as bundle-compare-diff.js), so the
// rendering shell in render-bundle.js and the unit test consume one
// definition. Plain queries match as a case-insensitive substring;
// the `.*` modifier switches to a regular expression, matched per
// line.
//
// Walking every line of every source is the expensive part of the
// tab, so `runBundleSearch` keeps a short history of recent results
// (per bundle tag + modifier set) and serves from it:
//
//   * The same query again (case-folded in substring mode) replays
//     the cached result as-is, truncated or not — the scan is
//     deterministic — so re-renders with an unchanged query (result
//     clicks, the Context toggle) and backspacing over just-typed
//     text cost nothing.
//   * A substring query that CONTAINS a previous one ("foo" →
//     "food") can only refine it: every line the longer needle
//     matches also matched the shorter one, so only the previous hit
//     lines are re-checked — typing forward re-scans hundreds of
//     lines instead of the whole bundle. Only an EXHAUSTIVE previous
//     result qualifies as a base: a truncated one is missing every
//     match past its cap, and the longer query's matches may live
//     exactly there. Regex mode never refines — pattern containment
//     says nothing about match containment (`a|b` contains `a` but
//     matches more).
//
// Callers key the history with the bundle's integrity, which
// content-addresses the sources: a tag change wipes the history, and
// within one tag the cached `lines` arrays can never go stale.
//
// A result is `{ fileResults, totalHits, truncated }`, or
// `{ error }` when a regex pattern doesn't compile. `fileResults` is
// in sorted-path order, each entry `{ path, lines, hits }`: `lines`
// is the full content split (kept for context-window rendering and
// for refinement re-checks — refined entries share the base's array)
// and `hits` lists the matched lines as `{ ln, ranges }` with `ln`
// 1-based and `ranges` the [start, end) character spans. `totalHits`
// counts matched LINES (the UI's "match" unit), not range spans.

// Per-keystroke caps. A bare `.` regex (or a one-char substring)
// matches almost everything, so bound the work + DOM: stop after
// SEARCH_MAX_TOTAL_HITS matches or SEARCH_MAX_FILES files and flag
// the result set as truncated. Display-side clipping of overlong
// lines stays in render-bundle.js.
export const SEARCH_MAX_TOTAL_HITS = 5000
export const SEARCH_MAX_FILES = 500
export const SEARCH_MAX_MARKS_PER_LINE = 50

// How many recent results to keep per (tag, modifiers). Sized for a
// typing burst plus a few backspace corrections; entries share their
// `lines` arrays with the results they refined, so the marginal cost
// of an entry is its hit list, not another copy of the sources.
const SEARCH_HISTORY_MAX = 8

// Compile a user pattern for the regex modifier. Unicode mode first
// (stricter, consistent with the rest of the codebase); fall back to
// legacy mode for the patterns `u` rejects but a user reasonably
// types as a plain regex — a bare `{` / `}`, a redundant escape — so
// searching for those literals still works. `i` rides in unless the
// case-sensitivity toggle is on. Returns `{ re }` or `{ error }`.
function compileSearchRegex(pattern, caseSensitive) {
  const unicodeFlags = caseSensitive ? 'gu' : 'giu'
  const legacyFlags = caseSensitive ? 'g' : 'gi'
  try {
    return { re: new RegExp(pattern, unicodeFlags) }
  } catch {
    try {
      // Intentionally legacy (no `u`): `u` mode rejects patterns a
      // user reasonably types to search code — a bare `{` / `}`, a
      // redundant escape — and we want those to match as literals.
      // eslint-disable-next-line require-unicode-regexp
      return { re: new RegExp(pattern, legacyFlags) }
    } catch (err) {
      return { error: err.message }
    }
  }
}

// Build a per-line matcher: `.ranges(line)` returns the [start,end]
// character spans that match, capped per line. Substring mode is an
// `indexOf` walk (case-folded unless `caseSensitive`); regex mode
// execs the compiled pattern globally, skipping zero-width matches so
// `^` / `$` / `a*` can't spin. Returns `{ error }` when the regex
// doesn't compile.
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

// Exhaustive scan: every line of every source, in sorted-path order,
// stopping at the caps. Non-string content (resource entries, omitted
// sourcesContent slots) is skipped, mirroring bundleSourcesAsMap's
// own filter — defensive against callers that didn't pre-filter.
function fullSearch(sources, matcher) {
  const allPaths = [...sources.keys()].toSorted()
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

// Re-check ONLY the hit lines of an exhaustive previous result whose
// query the new one contains: that hit set is a complete candidate
// list for the longer needle. Ranges are recomputed against the full
// line text, so marks come out exactly as a full scan would produce
// them. The caps can't engage here — the base stayed under both and
// a refinement is a subset — so the result is exhaustive too (and in
// turn a valid base for the next keystroke).
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

// Most-recent-first result history. One bundle + modifier set at a
// time: any change of tag / regex / case wipes it (toggling a
// modifier changes match semantics, so nothing cached is reusable).
const history = { tag: null, useRegex: false, caseSensitive: false, entries: [] }

export function runBundleSearch(tag, sources, query, useRegex, caseSensitive) {
  // Empty queries never reach here from the UI (the hint panel
  // short-circuits first); guard anyway and DON'T cache — '' is
  // contained in every string, so a cached '' entry would qualify as
  // a refinement base whose hit set is every line of every file.
  if (!query) return { fileResults: [], totalHits: 0, truncated: false }
  const matcher = buildSearchMatcher(query, useRegex, caseSensitive)
  // A non-compiling regex (an in-progress pattern like `foo(`) has no
  // result to remember; leave the history alone so the entries that
  // are already there resume serving once the pattern closes.
  if (matcher.error) return { error: matcher.error }
  if (history.tag !== tag || history.useRegex !== useRegex || history.caseSensitive !== caseSensitive) {
    history.tag = tag
    history.useRegex = useRegex
    history.caseSensitive = caseSensitive
    history.entries.length = 0
  }
  // Case-insensitive substring matching lowercases both sides, so two
  // queries with the same folded form are the same search. Regex
  // patterns compare verbatim: `i` does not make pattern TEXT case-
  // blind (`\W` is the negation of `\w`).
  const fold = useRegex || caseSensitive ? (q) => q : (q) => q.toLowerCase()
  const key = fold(query)
  let base = null
  let baseLen = -1
  for (let i = 0; i < history.entries.length; i++) {
    const entry = history.entries[i]
    const entryKey = fold(entry.query)
    if (entryKey === key) {
      // Identical search — deterministic, so the cached result
      // replays as-is even when truncated. Re-rank to front so a
      // query the user keeps returning to outlives burst-typing
      // eviction.
      history.entries.splice(i, 1)
      history.entries.unshift(entry)
      return entry.result
    }
    if (useRegex || entry.result.truncated) continue
    if (entryKey.length <= baseLen || !key.includes(entryKey)) continue
    // Longest contained query wins: the tightest superset leaves the
    // fewest candidate lines to re-check.
    base = entry.result
    baseLen = entryKey.length
  }
  const result = base ? refineSearch(base, matcher) : fullSearch(sources, matcher)
  history.entries.unshift({ query, result })
  if (history.entries.length > SEARCH_HISTORY_MAX) history.entries.pop()
  return result
}
