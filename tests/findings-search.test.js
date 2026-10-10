// `ui/view/filters.js` — `matchesFilters` is the per-finding predicate
// behind the findings search box (`state.filterInclude`). This file
// pins the search surface: base finding fields, triage annotations
// (`comment` and `fix`), and finding IDs for words of six or more characters.
// See the search block in matchesFilters.

import assert from 'node:assert/strict'
import { beforeEach, describe, it, test } from 'node:test'

// Polyfills for `localStorage` etc. — client modules pulled in
// transitively through `state.ts` touch them at module-load time.
import './_polyfills.js'

const { state } = await import('../client/state.ts')
const { matchesFilters, applyFilters } = await import('../ui/view/filters.js')

// Neutralise every non-search filter so each assertion isolates the
// `filterInclude` search path. Findings carry no confidence, so the
// 0..10 range passes them through (see matchesFilters' conf branch).
function reset() {
  state.filterSeverities = new Set()
  state.filterColors = new Set()
  state.filterSources = new Set()
  state.filterAnalyzer = ''
  state.filterModel = ''
  state.filterRepo = ''
  state.filterConfMin = 0
  state.filterConfMax = 10
  state.filterInclude = ''
  state.filterIncludeNegate = false
  state.filterComment = ''
  state.filterFix = ''
  state.filterFlagged = ''
  state.triage = new Map()
}

function makeFinding(id, extra = {}) {
  return { id, severity: 'high', file: `src/${id}.js`, description: `desc for ${id}`, ...extra }
}

describe('matchesFilters — findings search', () => {
  beforeEach(reset)

  it('matches base finding fields (description, file path)', () => {
    const f = makeFinding('A', { description: 'prototype pollution in merge' })
    state.filterInclude = 'pollution'
    assert.equal(matchesFilters(f), true)
    state.filterInclude = 'src/A.js'
    assert.equal(matchesFilters(f), true)
    state.filterInclude = 'absent-term'
    assert.equal(matchesFilters(f), false)
  })

  it('matches finding IDs case-insensitively from six characters, including interior and suffix fragments', () => {
    const f = makeFinding('6d8215a0-ABcDef-4f72-81ba-3456789abcde', { file: 'src/index.js', description: 'prototype pollution' })
    for (const term of [f.id, '6d8215', 'a0-abc', 'ABCDEF', '9abcde']) {
      state.filterInclude = term
      assert.equal(matchesFilters(f), true, term)
    }
    for (const term of ['6d821', 'abcde', 'abcdf0', 'abc def', '  abcde  ']) {
      state.filterInclude = term
      assert.equal(matchesFilters(f), false, term)
    }
    state.filterInclude = 'src'
    assert.equal(matchesFilters(f), true, 'short words still match normal finding fields')
  })

  it('matches individual long ID words without changing text phrase matching', () => {
    const f = makeFinding('prefix-ABCDEF-suffix', { file: 'src/index.js', description: 'prototype pollution' })
    for (const term of ['unrelated ABCDEF', 'absent\tAbCdEf\nother', '  abcdef  ']) {
      state.filterInclude = term
      assert.equal(matchesFilters(f), true, term)
    }
    for (const term of ['unrelated ABCDE', 'prototype absent']) {
      state.filterInclude = term
      assert.equal(matchesFilters(f), false, term)
    }
    state.filterInclude = 'abcdef'
    assert.equal(matchesFilters({ ...f, id: undefined }), false, 'findings without an ID still support text search')
  })

  it('applies ID search to each finding and respects negation and other filters', () => {
    const a = makeFinding('prefix-ABCDEF-suffix', { file: 'src/index.js', description: 'one' })
    const b = makeFinding('prefix-123456-suffix', { file: 'src/index.js', description: 'two' })
    state.filterInclude = 'abcdef'
    assert.deepEqual(applyFilters([[a, b], [b]]), [[a, b]], 'a matching tab keeps its group visible')
    state.filterIncludeNegate = true
    assert.equal(matchesFilters(a), false)
    assert.equal(matchesFilters(b), true)
    assert.deepEqual(applyFilters([[a], [a, b], [b]]), [[a, b], [b]])
    state.filterIncludeNegate = false
    state.filterSeverities = new Set(['low'])
    assert.equal(matchesFilters(a), false, 'an ID hit cannot bypass other filters')
  })

  it('matches the triage comment, case-insensitively', () => {
    const f = makeFinding('B')
    state.triage.set('B', { comment: 'Looks like a FALSE positive' })
    state.filterInclude = 'false positive'
    assert.equal(matchesFilters(f), true)
  })

  it('matches a fix URL, including a plain keyword within it', () => {
    const f = makeFinding('C')
    state.triage.set('C', { fix: 'https://github.com/owner/repo/pull/123' })
    state.filterInclude = 'https://github.com/owner/repo/pull/123'
    assert.equal(matchesFilters(f), true)
    // Plain (non-URL) substrings of the fix link now match too — the
    // previous code only consulted `fix` for `https://`-prefixed
    // queries.
    state.filterInclude = 'pull/123'
    assert.equal(matchesFilters(f), true)
  })

  it('matches a free-form (non-URL) fix note', () => {
    const f = makeFinding('D')
    state.triage.set('D', { fix: 'Internal ticket SEC-42, see Slack' })
    state.filterInclude = 'sec-42'
    assert.equal(matchesFilters(f), true)
  })

  it('does not match when the term is absent from every field', () => {
    const f = makeFinding('E')
    state.triage.set('E', { comment: 'noted', fix: 'https://example.com/x' })
    state.filterInclude = 'nonexistent'
    assert.equal(matchesFilters(f), false)
  })

  it('an annotation match is scoped to the finding that carries it', () => {
    const annotated = makeFinding('F')
    const other = makeFinding('G')
    state.triage.set('F', { comment: 'revisit later' })
    state.filterInclude = 'revisit'
    assert.equal(matchesFilters(annotated), true)
    assert.equal(matchesFilters(other), false)
  })

  it('an empty query keeps every finding', () => {
    state.filterInclude = ''
    assert.equal(matchesFilters(makeFinding('H')), true)
  })

  it('negation inverts the match — keeps findings that DON\'T contain the term', () => {
    const f = makeFinding('I', { description: 'prototype pollution in merge' })
    state.filterIncludeNegate = true
    state.filterInclude = 'pollution'
    assert.equal(matchesFilters(f), false)   // matches term → excluded
    state.filterInclude = 'absent-term'
    assert.equal(matchesFilters(f), true)    // no match → kept
  })

  it('negation also inverts triage-annotation matches', () => {
    const f = makeFinding('J')
    state.triage.set('J', { comment: 'false positive' })
    state.filterIncludeNegate = true
    state.filterInclude = 'false positive'
    assert.equal(matchesFilters(f), false)
  })

  it('negation has no effect on an empty query — every finding kept', () => {
    state.filterIncludeNegate = true
    state.filterInclude = ''
    assert.equal(matchesFilters(makeFinding('K')), true)
  })

  it('negation inverts only the text match — other filters still reject', () => {
    const f = makeFinding('L', { severity: 'low', description: 'no term here' })
    state.filterIncludeNegate = true
    state.filterInclude = 'absent-term'         // f doesn't match → text side passes
    state.filterSeverities = new Set(['high'])  // but f is 'low' → severity rejects
    assert.equal(matchesFilters(f), false)
  })

  it('negation is per-finding — a group stays visible if any tab is a non-match', () => {
    const a = makeFinding('M', { description: 'contains foobar token' })
    const b = makeFinding('N', { description: 'unrelated' })
    state.filterIncludeNegate = true
    state.filterInclude = 'foobar'
    // [a, b]: a matches (dropped), b doesn't (kept) → g.some keeps the
    // group, same group-visibility rule as the positive filter.
    assert.deepEqual(applyFilters([[a, b]]), [[a, b]])
    // Every tab matches the excluded term → the group drops out.
    assert.deepEqual(applyFilters([[a]]), [])
  })
})

describe('applyFilters — annotation filters (comment | fix | flag, group-level tri-state)', () => {
  beforeEach(reset)

  it("comment 'with' keeps commented groups; 'without' keeps the rest; '' is off", () => {
    state.triage.set('A', { comment: 'note' })
    const commented = [makeFinding('A')]
    const plain = [makeFinding('B')]
    state.filterComment = 'with'
    assert.deepEqual(applyFilters([commented, plain]), [commented])
    state.filterComment = 'without'
    assert.deepEqual(applyFilters([commented, plain]), [plain])
    state.filterComment = ''
    assert.deepEqual(applyFilters([commented, plain]), [commented, plain])
  })

  it("fix 'with' / 'without'", () => {
    state.triage.set('A', { fix: 'https://x/pr/1' })
    const withFix = [makeFinding('A')]
    const noFix = [makeFinding('B')]
    state.filterFix = 'with'
    assert.deepEqual(applyFilters([withFix, noFix]), [withFix])
    state.filterFix = 'without'
    assert.deepEqual(applyFilters([withFix, noFix]), [noFix])
  })

  it("flag 'without' matches the false tombstone and unset, not flagged===true", () => {
    state.triage.set('F', { flagged: true })
    state.triage.set('T', { flagged: false })
    const flagged = [makeFinding('F')]
    const tomb = [makeFinding('T')]
    const unset = [makeFinding('U')]
    state.filterFlagged = 'with'
    assert.deepEqual(applyFilters([flagged, tomb, unset]), [flagged])
    state.filterFlagged = 'without'
    assert.deepEqual(applyFilters([flagged, tomb, unset]), [tomb, unset])
  })

  it('dedup group: with/without are complementary at the GROUP level (¬∃)', () => {
    // The bug this fixes: a dedup group with one commented tab and one
    // uncommented tab must be EXCLUDED by "without comment" (the group DOES
    // have a comment), not kept just because a sibling tab lacks one.
    state.triage.set('M1', { comment: 'note on one tab' })
    const mixed = [makeFinding('M1'), makeFinding('M2')]  // M2 uncommented
    state.filterComment = 'with'
    assert.deepEqual(applyFilters([mixed]), [mixed], 'has a comment somewhere → kept by "with"')
    state.filterComment = 'without'
    assert.deepEqual(applyFilters([mixed]), [], 'has a comment somewhere → excluded by "without"')
    // A group with NO comment on ANY tab is the complement.
    const none = [makeFinding('N1'), makeFinding('N2')]
    state.filterComment = 'with'
    assert.deepEqual(applyFilters([none]), [])
    state.filterComment = 'without'
    assert.deepEqual(applyFilters([none]), [none])
  })

  it('combines as AND across annotations (commented AND not-flagged)', () => {
    state.triage.set('A', { comment: 'c', flagged: true })  // commented + flagged
    state.triage.set('B', { comment: 'c' })                 // commented, not flagged
    state.triage.set('C', { flagged: true })                // flagged, no comment
    const a = [makeFinding('A')], b = [makeFinding('B')], c = [makeFinding('C')]
    state.filterComment = 'with'
    state.filterFlagged = 'without'
    assert.deepEqual(applyFilters([a, b, c]), [b])
  })
})


test('Has fix includes automatic and manual links across siblings, with Without as its complement', t => {
  reset()
  const next = { serverMode: 'managed', localMode: false, currentManagedTeam: 'team', managedSession: { id: 'user' },
    managedIssues: new Map([['auto', { url: 'https://github.com/o/r/issues/1', autoFix: 'https://github.com/o/r/pull/2' }]]) }
  const previous = Object.fromEntries(Object.keys(next).map(key => [key, state[key]]))
  Object.assign(state, next)
  t.after(() => { Object.assign(state, previous); reset() })
  state.triage.set('manual', { fix: 'manual override' })
  const auto = [makeFinding('auto'), makeFinding('sibling')], manual = [makeFinding('manual')], plain = [makeFinding('plain')]
  state.filterFix = 'with'
  assert.deepEqual(applyFilters([auto, manual, plain]), [auto, manual])
  state.filterFix = 'without'
  assert.deepEqual(applyFilters([auto, manual, plain]), [plain])
  state.localMode = true
  state.filterFix = 'with'
  assert.deepEqual(applyFilters([auto, manual, plain]), [manual], 'managed automatic links never bleed into local mode')
})
