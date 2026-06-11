// `ui/view/bundle-search-scan.js` — the bundle Search tab's scan
// engine. Pure (no Lit / DOM / `state`), so the test imports it
// straight and feeds hand-built `Map<path, content>` source maps.
//
// The piece exercised hardest is the refinement history: when a new
// substring query CONTAINS a previous one, the engine re-checks only
// the previous hit lines instead of re-walking the bundle — but only
// from an exhaustive (non-truncated) base, never in regex mode, and
// only within one (tag, modifiers) generation. Cache usage is
// observed behaviorally: calls that should be served from history get
// a "poisoned" sources map whose extra matches MUST NOT appear (the
// engine assumes a tag content-addresses its sources, so it never
// re-reads them on a history hit), and calls that must rescan get the
// same poison and MUST surface it.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const {
  SEARCH_MAX_FILES,
  SEARCH_MAX_MARKS_PER_LINE,
  SEARCH_MAX_TOTAL_HITS,
  buildSearchMatcher,
  runBundleSearch,
} = await import('../ui/view/bundle-search-scan.js')

// Unique tag per test (the history is module-global, keyed by tag —
// a fresh tag is a fresh generation, isolating tests from each other).
let tagSeq = 0
const freshTag = () => `tag-${tagSeq++}`

const srcs = (obj) => new Map(Object.entries(obj))

// [path, matched line numbers] pairs — the shape most assertions care
// about.
const hitLines = (result) => result.fileResults.map((f) => [f.path, f.hits.map((h) => h.ln)])

describe('buildSearchMatcher', () => {
  it('substring mode: case-insensitive by default, case-sensitive on demand', () => {
    const insensitive = buildSearchMatcher('foo', false, false)
    assert.deepEqual(insensitive.ranges('xFOOx foo'), [[1, 4], [6, 9]])
    const sensitive = buildSearchMatcher('foo', false, true)
    assert.deepEqual(sensitive.ranges('xFOOx foo'), [[6, 9]])
  })

  it('regex mode skips zero-width matches instead of spinning', () => {
    const m = buildSearchMatcher('a*', true, false)
    assert.deepEqual(m.ranges('bbb'), [])
    assert.deepEqual(m.ranges('baab'), [[1, 3]])
  })

  it('regex mode falls back to legacy compilation for `u`-rejected literals', () => {
    const m = buildSearchMatcher('{', true, false)
    assert.equal(m.error, undefined)
    assert.deepEqual(m.ranges('a{b'), [[1, 2]])
  })

  it('reports an error when the pattern compiles in neither mode', () => {
    const m = buildSearchMatcher('(', true, false)
    assert.ok(m.error)
  })

  it('caps ranges per line at SEARCH_MAX_MARKS_PER_LINE', () => {
    const m = buildSearchMatcher('a', false, false)
    const line = 'a'.repeat(SEARCH_MAX_MARKS_PER_LINE + 10)
    assert.equal(m.ranges(line).length, SEARCH_MAX_MARKS_PER_LINE)
  })
})

describe('runBundleSearch — full scan', () => {
  it('collects per-file hits in sorted-path order, counting matched lines', () => {
    const sources = new Map([
      // Inserted out of order on purpose — results must sort by path.
      ['b.js', 'needle here\nnothing\nneedle needle'],
      ['a.js', 'plain\nNEEDLE up top'],
    ])
    const r = runBundleSearch(freshTag(), sources, 'needle', false, false)
    assert.deepEqual(hitLines(r), [['a.js', [2]], ['b.js', [1, 3]]])
    // totalHits counts matched LINES — b.js line 3 holds two ranges
    // but is one hit (the UI's "match" unit).
    assert.equal(r.totalHits, 3)
    assert.deepEqual(r.fileResults[1].hits[1].ranges, [[0, 6], [7, 13]])
    assert.equal(r.truncated, false)
  })

  it('keeps the full line split on each file result (context rendering needs it)', () => {
    const content = 'one\ntwo needle\nthree'
    const r = runBundleSearch(freshTag(), srcs({ 'a.js': content }), 'needle', false, false)
    assert.deepEqual(r.fileResults[0].lines, content.split('\n'))
  })

  it('skips non-string content without throwing', () => {
    const sources = new Map([['bin.dat', 42], ['a.js', 'needle']])
    const r = runBundleSearch(freshTag(), sources, 'needle', false, false)
    assert.deepEqual(hitLines(r), [['a.js', [1]]])
  })

  it('truncates at SEARCH_MAX_TOTAL_HITS and stops mid-file', () => {
    const content = `${'match\n'.repeat(SEARCH_MAX_TOTAL_HITS)}matchier`
    const r = runBundleSearch(freshTag(), srcs({ 'a.js': content }), 'match', false, false)
    assert.equal(r.truncated, true)
    assert.equal(r.totalHits, SEARCH_MAX_TOTAL_HITS)
  })

  it('truncates at SEARCH_MAX_FILES', () => {
    const sources = new Map()
    for (let i = 0; i < SEARCH_MAX_FILES + 1; i++) {
      sources.set(`f${String(i).padStart(4, '0')}.js`, 'match')
    }
    const r = runBundleSearch(freshTag(), sources, 'match', false, false)
    assert.equal(r.truncated, true)
    assert.equal(r.fileResults.length, SEARCH_MAX_FILES)
  })

  it('returns an empty result for an empty query without caching it', () => {
    const r = runBundleSearch(freshTag(), srcs({ 'a.js': 'anything' }), '', false, false)
    assert.deepEqual(r, { fileResults: [], totalHits: 0, truncated: false })
  })
})

describe('runBundleSearch — refinement history', () => {
  it('refines a contained query from the previous hit lines, ignoring sources', () => {
    const tag = freshTag()
    const clean = srcs({ 'a.js': 'one needle\ntwo\nthree needles' })
    runBundleSearch(tag, clean, 'needle', false, false)
    // Same tag, poisoned sources: extra matches that only a rescan
    // would see. The refined result must mirror the ORIGINAL content.
    const poisoned = srcs({
      'a.js': 'one needle\ntwo needles\nthree needles',
      'b.js': 'needles',
    })
    const refined = runBundleSearch(tag, poisoned, 'needles', false, false)
    assert.deepEqual(hitLines(refined), [['a.js', [3]]])
    // …and match what a from-scratch scan of the original sources
    // produces (fresh tag → no history → full scan).
    const scratch = runBundleSearch(freshTag(), clean, 'needles', false, false)
    assert.deepEqual(hitLines(refined), hitLines(scratch))
    assert.equal(refined.totalHits, scratch.totalHits)
  })

  it('recomputes ranges against the full line text when refining', () => {
    const tag = freshTag()
    const sources = srcs({ 'a.js': 'zabzzab' })
    const base = runBundleSearch(tag, sources, 'ab', false, false)
    assert.deepEqual(base.fileResults[0].hits[0].ranges, [[1, 3], [5, 7]])
    const refined = runBundleSearch(tag, sources, 'abz', false, false)
    assert.deepEqual(refined.fileResults[0].hits[0].ranges, [[1, 4]])
    // Refined entries share the base's line split — no re-split copy.
    assert.equal(refined.fileResults[0].lines, base.fileResults[0].lines)
  })

  it('replays the identical result object for a repeated query (backspace path)', () => {
    const tag = freshTag()
    const clean = srcs({ 'a.js': 'needle' })
    const first = runBundleSearch(tag, clean, 'needle', false, false)
    runBundleSearch(tag, clean, 'needles', false, false)
    const again = runBundleSearch(tag, srcs({ 'b.js': 'needle' }), 'needle', false, false)
    assert.equal(again, first)
  })

  it('replays an exact repeat even when truncated (deterministic scan)', () => {
    const tag = freshTag()
    const content = 'match\n'.repeat(SEARCH_MAX_TOTAL_HITS)
    const first = runBundleSearch(tag, srcs({ 'a.js': content }), 'match', false, false)
    assert.equal(first.truncated, true)
    const again = runBundleSearch(tag, new Map(), 'match', false, false)
    assert.equal(again, first)
  })

  it('never refines from a truncated result — matches past the cap were unseen', () => {
    const tag = freshTag()
    // Hits 1..MAX truncate the scan before the final line, whose
    // content also matches the LONGER query. A (wrong) refinement
    // would re-check only lines 1..MAX and report zero matches.
    const content = `${'match\n'.repeat(SEARCH_MAX_TOTAL_HITS)}matchier`
    const sources = srcs({ 'a.js': content })
    const base = runBundleSearch(tag, sources, 'match', false, false)
    assert.equal(base.truncated, true)
    const next = runBundleSearch(tag, sources, 'matchi', false, false)
    assert.deepEqual(hitLines(next), [['a.js', [SEARCH_MAX_TOTAL_HITS + 1]]])
    assert.equal(next.truncated, false)
  })

  it('rescans in full when the new query does not contain the previous one', () => {
    const tag = freshTag()
    const sources = srcs({ 'a.js': 'alpha\nbeta' })
    runBundleSearch(tag, sources, 'alpha', false, false)
    const r = runBundleSearch(tag, sources, 'beta', false, false)
    assert.deepEqual(hitLines(r), [['a.js', [2]]])
  })

  it('folds case for containment and equality in case-insensitive mode', () => {
    const tag = freshTag()
    const clean = srcs({ 'a.js': 'Food fight\nfoo bar\nFOO\nfOOd' })
    runBundleSearch(tag, clean, 'foo', false, false)
    // "FOOD" contains "foo" only after folding; refinement must
    // engage (poison invisible) and fold the needle for matching.
    const poisoned = srcs({ 'a.js': 'Food fight\nfoo bar\nFOO\nfOOd', 'b.js': 'food' })
    const refined = runBundleSearch(tag, poisoned, 'FOOD', false, false)
    assert.deepEqual(hitLines(refined), [['a.js', [1, 4]]])
    // A re-cased repeat is the same search — identical needle after
    // folding — and replays the cached object.
    const recased = runBundleSearch(tag, poisoned, 'fOoD', false, false)
    assert.equal(recased, refined)
  })

  it('refines within case-sensitive mode too', () => {
    const tag = freshTag()
    const clean = srcs({ 'a.js': 'Food fight\nfood court' })
    runBundleSearch(tag, clean, 'Foo', false, true)
    const poisoned = srcs({ 'a.js': 'Food fight\nFood court' })
    const refined = runBundleSearch(tag, poisoned, 'Food', false, true)
    assert.deepEqual(hitLines(refined), [['a.js', [1]]])
  })

  it('drops the history when the case modifier flips', () => {
    const tag = freshTag()
    runBundleSearch(tag, srcs({ 'a.js': 'FOO' }), 'foo', false, false)
    // Same tag + query, now case-sensitive: nothing cached applies
    // (match semantics changed), so the new sources are scanned.
    const r = runBundleSearch(tag, srcs({ 'a.js': 'FOO', 'c.js': 'foo lowercase' }), 'foo', false, true)
    assert.deepEqual(hitLines(r), [['c.js', [1]]])
  })

  it('never refines in regex mode — pattern containment is not match containment', () => {
    const tag = freshTag()
    const sources = srcs({ 'a.js': 'alpha\nbeta\ngamma' })
    runBundleSearch(tag, sources, 'alpha', true, false)
    // 'alpha|beta' string-contains 'alpha' but matches MORE lines; a
    // (wrong) refinement would miss beta.
    const r = runBundleSearch(tag, sources, 'alpha|beta', true, false)
    assert.deepEqual(hitLines(r), [['a.js', [1, 2]]])
  })

  it('replays exact regex repeats and survives a non-compiling keystroke', () => {
    const tag = freshTag()
    const sources = srcs({ 'a.js': 'alpha\nbeta' })
    const first = runBundleSearch(tag, sources, 'alpha|beta', true, false)
    // In-progress pattern: errors out without touching the history…
    const broken = runBundleSearch(tag, sources, 'alpha|beta(', true, false)
    assert.ok(broken.error)
    // …so the prior result still replays (poisoned sources ignored).
    const again = runBundleSearch(tag, srcs({ 'a.js': 'alpha\nbeta\nalpha' }), 'alpha|beta', true, false)
    assert.equal(again, first)
  })

  it('evicts the oldest entry beyond the history cap', () => {
    const tag = freshTag()
    const word = 'abcdefghi' // 9 prefixes > the 8-entry history cap
    const clean = srcs({ 'a.js': word })
    const results = []
    for (let i = 1; i <= word.length; i++) {
      results.push(runBundleSearch(tag, clean, word.slice(0, i), false, false))
    }
    const poisoned = srcs({ 'a.js': word, 'b.js': 'a' })
    // 'ab' (within the cap) still replays its cached object. Checked
    // BEFORE the evicted query: rescanning that one re-inserts it,
    // which would evict 'ab' in turn.
    const kept = runBundleSearch(tag, poisoned, 'ab', false, false)
    assert.equal(kept, results[1])
    // The oldest query ('a') fell out — a full rescan sees the poison.
    const evicted = runBundleSearch(tag, poisoned, 'a', false, false)
    assert.deepEqual(hitLines(evicted), [['a.js', [1]], ['b.js', [1]]])
  })
})
