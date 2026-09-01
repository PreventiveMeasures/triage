// The revalidation pass — a report re-examining its own findings and
// stamping each row with what it concluded. Three behaviours are
// pinned here, because each one changes what the user SEES rather than
// just how a field prints:
//
//   * the row that IS the pass (`revalidate: 'revalidation'`) leads its
//     group, outranking every other tab-sort key;
//   * a REFUTED row's confidence reads as 0 for the confidence filter,
//     so it can't float its group over a floor the surviving rows
//     can't meet;
//   * the toolbar's outcome filter matches per finding and group-wide
//     like every other filter, with the revalidation row riding
//     CONFIRMED.

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'

// Polyfills for `localStorage` etc. — client modules pulled in
// transitively through `state.ts` touch them at module-load time.
import './_polyfills.js'

// filters.js / group.js → format.js → frontend-global.js throws at
// module load when the `@rray/frontend` slot isn't installed. Tests
// don't run the boot path that installs it, so stub it before the
// import chain evaluates; nothing under test calls these symbols.
const slotKey = Symbol.for('@rray/frontend')
if (!globalThis[slotKey]) {
  globalThis[slotKey] = {
    LitElement: class {}, html: () => null, nothing: null, render: () => null,
    unsafeCSS: () => null, StateElement: class {}, classMap: () => null,
    repeat: () => null, styleMap: () => null,
  }
}

const { state } = await import('../client/state.ts')
const { applyFilters, matchesFilters } = await import('../ui/view/filters.js')
const { sortTabs } = await import('../ui/view/group.js')
const {
  REVALIDATE_FILTERS, REVALIDATE_KINDS, isRefuted, isRevalidation,
  reachableRevalidateFilters, revalidateKind, revalidateStamp,
} = await import('../ui/view/format.js')

// Neutralise every other filter so each assertion isolates the
// dimension under test.
function reset() {
  state.filterSeverities = new Set()
  state.filterColors = new Set()
  state.filterSources = new Set()
  state.filterAnalyzer = ''
  state.filterModel = ''
  state.filterRepo = ''
  state.filterRevalidate = ''
  state.filterConfMin = 0
  state.filterConfMax = 10
  state.filterInclude = ''
  state.filterIncludeNegate = false
  state.filterComment = ''
  state.filterFix = ''
  state.filterFlagged = ''
  state.filterModules = ''
  state.severityMode = 'corrected'
  state.triage = new Map()
  state.activeTabByGroup = new Map()
}

function makeFinding(id, extra = {}) {
  return { id, severity: 'high', file: `src/${id}.js`, description: `desc for ${id}`, ...extra }
}

describe('revalidateKind — reading the field', () => {
  it('takes the four known values, case-folded and trimmed', () => {
    for (const kind of REVALIDATE_KINDS) {
      assert.equal(revalidateKind({ revalidate: kind }), kind)
      assert.equal(revalidateKind({ revalidate: `  ${kind.toUpperCase()} ` }), kind)
    }
  })

  it('answers empty for anything else', () => {
    for (const v of ['', 'maybe', 'refute', undefined, null, 0, {}, ['refuted']]) {
      assert.equal(revalidateKind({ revalidate: v }), '', String(v))
    }
    assert.equal(revalidateKind({}), '')
    assert.equal(revalidateKind(undefined), '')
  })

  it('stamps only the three verdicts — the pass itself is not one', () => {
    assert.equal(revalidateStamp({ revalidate: 'refuted' }), 'refuted')
    assert.equal(revalidateStamp({ revalidate: 'confirmed' }), 'confirmed')
    assert.equal(revalidateStamp({ revalidate: 'unknown' }), 'unknown')
    assert.equal(revalidateStamp({ revalidate: 'revalidation' }), null)
    assert.equal(revalidateStamp({ revalidate: 'nonsense' }), null)
    assert.equal(revalidateStamp({}), null)
  })

  it('separates the two predicates the rest of the app keys off', () => {
    assert.equal(isRevalidation({ revalidate: 'revalidation' }), true)
    assert.equal(isRevalidation({ revalidate: 'refuted' }), false)
    assert.equal(isRefuted({ revalidate: 'refuted' }), true)
    assert.equal(isRefuted({ revalidate: 'revalidation' }), false)
    assert.equal(isRefuted({}), false)
  })
})

describe('sortTabs — the revalidation row leads its group', () => {
  beforeEach(reset)

  it('puts it first over a higher severity and a higher confidence', () => {
    const crit = makeFinding('A', { severity: 'critical', confidence: 10 })
    const reval = makeFinding('B', { severity: 'low', confidence: 1, revalidate: 'revalidation' })
    assert.deepEqual(sortTabs([crit, reval]).map((f) => f.id), ['B', 'A'])
    assert.deepEqual(sortTabs([reval, crit]).map((f) => f.id), ['B', 'A'])
  })

  it('puts it first over a colored (already-triaged) sibling', () => {
    const colored = makeFinding('A', { severity: 'critical' })
    const reval = makeFinding('B', { severity: 'low', revalidate: 'revalidation' })
    state.triage.set('A', { color: 'red' })
    assert.deepEqual(sortTabs([colored, reval]).map((f) => f.id), ['B', 'A'])
  })

  it('does not promote a verdict row — only the pass itself leads', () => {
    const crit = makeFinding('A', { severity: 'critical' })
    for (const verdict of ['refuted', 'confirmed', 'unknown']) {
      const row = makeFinding('B', { severity: 'low', revalidate: verdict })
      assert.deepEqual(sortTabs([crit, row]).map((f) => f.id), ['A', 'B'], verdict)
    }
  })

  it('orders several revalidation rows among themselves by the usual keys', () => {
    const low = makeFinding('A', { severity: 'low', revalidate: 'revalidation' })
    const high = makeFinding('B', { severity: 'critical', revalidate: 'revalidation' })
    const plain = makeFinding('C', { severity: 'critical' })
    assert.deepEqual(sortTabs([low, plain, high]).map((f) => f.id), ['B', 'A', 'C'])
  })
})

// A group shows in full when any of its rows matches, so a refuted
// row's confidence would otherwise carry the whole group over a floor
// its surviving rows can't reach.
describe('confidence filter — a refuted row reads as 0', () => {
  beforeEach(reset)

  const shows = (group, min) => {
    state.filterConfMin = min
    return applyFilters([group]).length === 1
  }

  it('the group behaves as its highest NON-refuted confidence', () => {
    const group = [
      makeFinding('A', { confidence: 3 }),
      makeFinding('B', { confidence: 10, revalidate: 'refuted' }),
    ]
    assert.equal(shows(group, 0), true)
    assert.equal(shows(group, 3), true)
    assert.equal(shows(group, 4), false)
    assert.equal(shows(group, 10), false)
  })

  it('an all-refuted group shows only at the unfiltered floor', () => {
    const group = [
      makeFinding('A', { confidence: 3, revalidate: 'refuted' }),
      makeFinding('B', { confidence: 10, revalidate: 'refuted' }),
    ]
    assert.equal(shows(group, 0), true)
    assert.equal(shows(group, 1), false)
    assert.equal(shows(group, 10), false)
  })

  it('leaves the other verdicts and unstamped rows alone', () => {
    for (const revalidate of [undefined, 'confirmed', 'unknown', 'revalidation']) {
      const group = [makeFinding('A', { confidence: 10, revalidate })]
      assert.equal(shows(group, 10), true, String(revalidate))
    }
  })

  it('does not let a refuted row ride the critical-flag stand-in', () => {
    // `critical: true` with no confidence normally joins the 10 bucket.
    const refuted = makeFinding('A', { critical: true, revalidate: 'refuted' })
    const plain = makeFinding('B', { critical: true })
    state.filterConfMin = 5
    assert.equal(matchesFilters(refuted), false)
    assert.equal(matchesFilters(plain), true)
  })

  it('never caps a refuted row out at the top of the range', () => {
    // Reading as 0 means the upper bound can't exclude it either.
    state.filterConfMax = 2
    assert.equal(matchesFilters(makeFinding('A', { confidence: 10, revalidate: 'refuted' })), true)
    assert.equal(matchesFilters(makeFinding('B', { confidence: 10 })), false)
  })
})

describe('revalidate filter — the toolbar dropdown', () => {
  beforeEach(reset)

  it('offers two outcomes, confirmed first', () => {
    assert.deepEqual(REVALIDATE_FILTERS.map((o) => o.value), ['confirmed', 'refuted'])
    assert.deepEqual(REVALIDATE_FILTERS.map((o) => o.label), ['Confirmed', 'Refuted'])
  })

  it('matches the selected outcome and nothing else', () => {
    state.filterRevalidate = 'refuted'
    assert.equal(matchesFilters(makeFinding('A', { revalidate: 'refuted' })), true)
    assert.equal(matchesFilters(makeFinding('B', { revalidate: 'confirmed' })), false)
    assert.equal(matchesFilters(makeFinding('C', { revalidate: 'unknown' })), false)
    assert.equal(matchesFilters(makeFinding('D')), false)
  })

  it('takes the revalidation row under Confirmed', () => {
    state.filterRevalidate = 'confirmed'
    assert.equal(matchesFilters(makeFinding('A', { revalidate: 'confirmed' })), true)
    assert.equal(matchesFilters(makeFinding('B', { revalidate: 'revalidation' })), true)
    assert.equal(matchesFilters(makeFinding('C', { revalidate: 'refuted' })), false)
    assert.equal(matchesFilters(makeFinding('D', { revalidate: 'unknown' })), false)
  })

  it('keeps the whole group when any of its rows matches', () => {
    const group = [makeFinding('A'), makeFinding('B', { revalidate: 'revalidation' })]
    state.filterRevalidate = 'confirmed'
    const [kept] = applyFilters([group])
    assert.equal(kept.length, 2)
    state.filterRevalidate = 'refuted'
    assert.equal(applyFilters([group]).length, 0)
  })

  // The two share one toolbar block and the outcome REPLACES the range
  // there, so the bounds read as 0—10 while one is selected.
  it('takes the confidence range out of play while an outcome is on', () => {
    state.filterConfMin = 8
    state.filterConfMax = 9
    state.filterRevalidate = 'refuted'
    // Below the floor, above the cap, and carrying no confidence at
    // all — all three pass, none of which they would without an
    // outcome selected.
    assert.equal(matchesFilters(makeFinding('A', { confidence: 1, revalidate: 'refuted' })), true)
    assert.equal(matchesFilters(makeFinding('B', { confidence: 10, revalidate: 'refuted' })), true)
    assert.equal(matchesFilters(makeFinding('C', { revalidate: 'refuted' })), true)
    // The outcome itself still gates.
    assert.equal(matchesFilters(makeFinding('D', { confidence: 8, revalidate: 'confirmed' })), false)
    // Clearing it hands the range back untouched.
    state.filterRevalidate = ''
    assert.equal(matchesFilters(makeFinding('E', { confidence: 1, revalidate: 'refuted' })), false)
  })

  it('is off when empty', () => {
    state.filterRevalidate = ''
    for (const revalidate of [undefined, 'refuted', 'confirmed', 'unknown', 'revalidation']) {
      assert.equal(matchesFilters(makeFinding('A', { revalidate })), true, String(revalidate))
    }
  })

  // The toolbar drops the control when this comes back empty, so a
  // pass that only ever answered `unknown` shows no dropdown at all.
  it('reaches an outcome only from the kinds that feed it', () => {
    const values = (kinds) => reachableRevalidateFilters(kinds).map((o) => o.value)
    assert.deepEqual(values(['confirmed', 'refuted', 'revalidation', 'unknown']), ['confirmed', 'refuted'])
    assert.deepEqual(values(['revalidation']), ['confirmed'])
    assert.deepEqual(values(['confirmed']), ['confirmed'])
    assert.deepEqual(values(['refuted']), ['refuted'])
    assert.deepEqual(values(['unknown']), [])
    assert.deepEqual(values([]), [])
  })
})
