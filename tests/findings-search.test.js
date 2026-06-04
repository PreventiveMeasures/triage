// `ui/view/filters.js` — `matchesFilters` is the per-finding predicate
// behind the findings search box (`state.filterInclude`). This file
// pins the search surface: the base finding fields PLUS the per-finding
// triage annotations (`comment` and `fix`), which live in
// `state.triage` and are matched on every query (not just URL-shaped
// ones). See the search block in matchesFilters.

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

// Polyfills for `localStorage` etc. — client modules pulled in
// transitively through `state.ts` touch them at module-load time.
import './_polyfills.js'

// filters.js → format.js → frontend-global.js throws at module load
// when the `@rray/frontend` slot isn't installed. Tests don't run the
// boot path that installs it, so stub it before the import chain
// evaluates; matchesFilters never calls any of these symbols.
const slotKey = Symbol.for('@rray/frontend')
if (!globalThis[slotKey]) {
  globalThis[slotKey] = {
    LitElement: class {}, html: () => null, nothing: null, render: () => null,
    unsafeCSS: () => null, StateElement: class {}, classMap: () => null,
    repeat: () => null, styleMap: () => null,
  }
}

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
  state.filterRepo = ''
  state.filterConfMin = 0
  state.filterConfMax = 10
  state.filterInclude = ''
  state.filterIncludeNegate = false
  state.filterComment = false
  state.filterFix = false
  state.filterFlagged = false
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

describe('matchesFilters — annotation filters (comment | fix | flag, AND-combined)', () => {
  beforeEach(reset)

  it('filterComment keeps only findings with a comment', () => {
    const withC = makeFinding('A'); state.triage.set('A', { comment: 'note' })
    const without = makeFinding('B')
    state.filterComment = true
    assert.equal(matchesFilters(withC), true)
    assert.equal(matchesFilters(without), false)
  })

  it('filterFix keeps only findings with a fix', () => {
    const withF = makeFinding('A'); state.triage.set('A', { fix: 'https://x/pr/1' })
    const without = makeFinding('B')
    state.filterFix = true
    assert.equal(matchesFilters(withF), true)
    assert.equal(matchesFilters(without), false)
  })

  it('filterFlagged keeps only flagged findings (false tombstone excluded)', () => {
    const flagged = makeFinding('A'); state.triage.set('A', { flagged: true })
    const tomb = makeFinding('B'); state.triage.set('B', { flagged: false })
    const none = makeFinding('C')
    state.filterFlagged = true
    assert.equal(matchesFilters(flagged), true)
    assert.equal(matchesFilters(tomb), false)
    assert.equal(matchesFilters(none), false)
  })

  it('combines as AND — each active chip narrows the set further', () => {
    state.triage.set('A', { comment: 'c', fix: 'f', flagged: true })  // all three
    state.triage.set('B', { comment: 'c', flagged: true })            // no fix
    state.triage.set('C', { comment: 'c', fix: 'f' })                 // not flagged
    const a = makeFinding('A'), b = makeFinding('B'), c = makeFinding('C')
    state.filterComment = true
    assert.equal(matchesFilters(a), true)
    assert.equal(matchesFilters(b), true)
    assert.equal(matchesFilters(c), true)
    state.filterFix = true        // + fix → drops B (no fix)
    assert.equal(matchesFilters(a), true)
    assert.equal(matchesFilters(b), false)
    assert.equal(matchesFilters(c), true)
    state.filterFlagged = true    // + flag → drops C; only A satisfies all three
    assert.equal(matchesFilters(a), true)
    assert.equal(matchesFilters(b), false)
    assert.equal(matchesFilters(c), false)
  })

  it('group stays visible if ANY tab matches all active annotation filters', () => {
    state.triage.set('A1', { comment: 'c' })
    const group = [makeFinding('A1'), makeFinding('A2')]
    state.filterComment = true
    assert.deepEqual(applyFilters([group]), [group])  // A1 carries the comment
    state.triage = new Map()                           // none commented now
    assert.deepEqual(applyFilters([group]), [])
  })
})
