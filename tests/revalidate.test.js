// The revalidation pass — a report re-examining its own findings and
// stamping each row with what it concluded. Three behaviours are
// pinned here, because each one changes what the user SEES rather than
// just how a field prints:
//
//   * the row that IS the pass (`revalidate: 'revalidation'`) leads its
//     group, outranking every other tab-sort key;
//   * a row the pass knocked down — refuted or unreachable — reads as
//     confidence 0, so it can't float its group over a floor the
//     surviving rows can't meet;
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
const { readReport } = await import('../report/index.js')
const { applyFilters, applyOpeningFilters, confidenceOnScale, defaultConfidenceFloor, defaultRevalidateFilter, filterRevalidateKind, matchesFilters, rangeApplies } = await import('../ui/view/filters.js')
const { activeTabFor, getMergedGroups, getShownGroups, mergeDuplicateFields, sortTabs } = await import('../ui/view/group.js')
const {
  PARTIAL_MODES, REVALIDATE_FILTERS, REVALIDATE_KINDS, activeRevalidateKinds,
  canDropRevalidation, configureRevalidation, formatRunMeta, hasRevalidateField,
  hasRevalidateStamp, isRevalidation, isRevalidationRow, reachableRevalidateFilters,
  revalidateKind, revalidateStamp, revalidationShown, voidsConfidence,
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
  state.filterPartial = ''
  state.showRevalidation = true
  configureRevalidation(true)
  // The app view as a reader gets it: simplified, i.e. a group the
  // pass re-examined shows its row alone (group.js drawnTabs).
  state.revalidationDetailed = false
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
  it('takes every known value, case-folded and trimmed', () => {
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

  it('stamps every verdict — the pass itself is not one', () => {
    for (const verdict of ['refuted', 'unreachable', 'confirmed', 'partial', 'unknown']) {
      assert.equal(revalidateStamp({ revalidate: verdict }), verdict)
    }
    assert.equal(revalidateStamp({ revalidate: 'revalidation' }), null)
    assert.equal(revalidateStamp({ revalidate: 'nonsense' }), null)
    assert.equal(revalidateStamp({}), null)
  })

  it('separates the two predicates the rest of the app keys off', () => {
    assert.equal(isRevalidation({ revalidate: 'revalidation' }), true)
    assert.equal(isRevalidation({ revalidate: 'refuted' }), false)
    // Knocked down either way — refuted, or unreachable.
    assert.equal(voidsConfidence({ revalidate: 'refuted' }), true)
    assert.equal(voidsConfidence({ revalidate: 'unreachable' }), true)
    for (const kind of ['revalidation', 'confirmed', 'unknown', 'nonsense', undefined]) {
      assert.equal(voidsConfidence({ revalidate: kind }), false, String(kind))
    }
    assert.equal(voidsConfidence({}), false)
  })
})

// The meta line names the run a row came from, so the pass names
// itself there — right after the mode it ran in.
describe('formatRunMeta — the revalidation row names its run', () => {
  const run = { type: 'security', model: 'claude-opus-5', effort: 'max', exportsMode: 'list' }

  it('inserts revalidate after the base mode', () => {
    assert.equal(
      formatRunMeta({ ...run, revalidate: 'revalidation' }),
      'security · revalidate · opus 5 · max · list',
    )
  })

  it('leaves every other row alone', () => {
    const plain = 'security · opus 5 · max · list'
    assert.equal(formatRunMeta(run), plain)
    for (const verdict of ['refuted', 'unreachable', 'confirmed', 'partial', 'unknown', 'nonsense']) {
      assert.equal(formatRunMeta({ ...run, revalidate: verdict }), plain, verdict)
    }
  })

  it('still elides the fields a run did not carry', () => {
    assert.equal(formatRunMeta({ type: 'security', revalidate: 'revalidation' }), 'security · revalidate')
    assert.equal(formatRunMeta({ model: 'claude-opus-5', revalidate: 'revalidation' }), 'revalidate · opus 5')
  })
})

describe('sortTabs — the revalidation row leads its group', () => {
  // The DETAILED app view throughout: with the simplified one the
  // question doesn't arise — the rows this orders the pass's row
  // against aren't on the strip to be led (see the fold describe
  // below). Ordering still has to be right for the reader who asks
  // to see them.
  beforeEach(() => { reset(); state.revalidationDetailed = true })

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
    for (const verdict of ['refuted', 'unreachable', 'confirmed', 'partial', 'unknown']) {
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
// What the app view SHOWS of a group the pass re-examined. The rows
// it went back over are folded under its verdict — the strip carries
// the app-level finding and nothing else — and the icon beside the
// App switch unfolds them again. Presentation only: every folded row
// is still in the group, still counted and still filtered on.
describe('the app view folds the rows the pass re-rated', () => {
  beforeEach(reset)

  const pass = (id) => makeFinding(id, { revalidate: 'revalidation' })

  it('leaves the pass row alone on the strip, and hands the rest back on request', () => {
    const group = [makeFinding('A', { confidence: 9 }), pass('P'), makeFinding('B', { revalidate: 'confirmed' })]
    assert.deepEqual(sortTabs(group).map((f) => f.id), ['P'])
    state.revalidationDetailed = true
    assert.deepEqual(sortTabs(group).map((f) => f.id), ['P', 'A', 'B'])
  })

  it('keeps every tab of a group the pass never spoke about', () => {
    const group = [makeFinding('A'), makeFinding('B', { revalidate: 'confirmed' })]
    assert.deepEqual(sortTabs(group).map((f) => f.id), ['A', 'B'])
  })

  it('folds nothing once the layer is off', () => {
    // Off, `withoutPassRows` has already taken the pass's rows out of
    // the group — there is nothing left to fold under, and the rows
    // the pass re-rated are the whole point of the code view.
    const group = [makeFinding('A'), pass('P')]
    state.reports = [{ groups: [group] }]
    state.showRevalidation = false
    configureRevalidation(false)
    const [shown] = getMergedGroups()
    assert.deepEqual(shown.map((f) => f.id), ['A'])
    assert.deepEqual(sortTabs(shown).map((f) => f.id), ['A'])
  })

  it('opens the card on the pass row, whatever the group was parked on', () => {
    const group = [makeFinding('A'), pass('P')]
    state.activeTabByGroup.set('A', 'A')
    assert.equal(activeTabFor(group).id, 'P')
    // The reader asked for the rows: their pick is theirs again.
    state.revalidationDetailed = true
    assert.equal(activeTabFor(group).id, 'A')
  })

  it('lets no folded row take the card by carrying an annotation', () => {
    // An annotated sibling opens first among the tabs on the STRIP —
    // it must not pull the card onto a row the strip isn't drawing.
    const group = [makeFinding('A'), pass('P')]
    state.triage.set('A', { comment: 'look here' })
    assert.equal(activeTabFor(group).id, 'P')
    state.revalidationDetailed = true
    assert.equal(activeTabFor(group).id, 'A')
  })

  it('folds a row out of sight without taking it out of the count', () => {
    // The severity the group answers a filter with is a folded row's,
    // and the group still shows for it: the fold is what the strip
    // draws, not what the set contains.
    const group = [pass('P'), makeFinding('A', { severity: 'critical' })]
    state.filterSeverities = new Set(['critical'])
    assert.equal(applyFilters([group]).length, 1)
    assert.deepEqual(sortTabs(group).map((f) => f.id), ['P'])
  })

  it('orders several pass rows among themselves when a group carries more than one', () => {
    const low = makeFinding('A', { severity: 'low', revalidate: 'revalidation' })
    const high = makeFinding('B', { severity: 'critical', revalidate: 'revalidation' })
    const plain = makeFinding('C', { severity: 'critical' })
    assert.deepEqual(sortTabs([low, plain, high]).map((f) => f.id), ['B', 'A'])
  })
})

describe('confidence filter — a knocked-down row reads as 0', () => {
  beforeEach(reset)

  const shows = (group, min) => {
    state.filterConfMin = min
    return applyFilters([group]).length === 1
  }

  it('the group behaves as its highest surviving confidence', () => {
    for (const knocked of ['refuted', 'unreachable']) {
      const group = [
        makeFinding('A', { confidence: 3 }),
        makeFinding('B', { confidence: 10, revalidate: knocked }),
      ]
      assert.equal(shows(group, 0), true, knocked)
      assert.equal(shows(group, 3), true, knocked)
      assert.equal(shows(group, 4), false, knocked)
      assert.equal(shows(group, 10), false, knocked)
    }
  })

  it('an all-knocked-down group shows only at the unfiltered floor', () => {
    const group = [
      makeFinding('A', { confidence: 3, revalidate: 'refuted' }),
      makeFinding('B', { confidence: 10, revalidate: 'unreachable' }),
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

  it('does not let a knocked-down row ride the critical-flag stand-in', () => {
    // `critical: true` with no confidence normally joins the 10 bucket.
    state.filterConfMin = 5
    assert.equal(matchesFilters(makeFinding('A', { critical: true, revalidate: 'refuted' })), false)
    assert.equal(matchesFilters(makeFinding('B', { critical: true, revalidate: 'unreachable' })), false)
    assert.equal(matchesFilters(makeFinding('C', { critical: true })), true)
  })

  it('never caps a knocked-down row out at the top of the range', () => {
    // Reading as 0 means the upper bound can't exclude it either.
    state.filterConfMax = 2
    assert.equal(matchesFilters(makeFinding('A', { confidence: 10, revalidate: 'refuted' })), true)
    assert.equal(matchesFilters(makeFinding('B', { confidence: 10, revalidate: 'unreachable' })), true)
    assert.equal(matchesFilters(makeFinding('C', { confidence: 10 })), false)
  })
})

describe('revalidate filter — the toolbar dropdown', () => {
  beforeEach(reset)

  it('offers the outcomes from survived to knocked down', () => {
    assert.deepEqual(REVALIDATE_FILTERS.map((o) => o.value), ['confirmed', 'unreachable', 'refuted'])
    assert.deepEqual(REVALIDATE_FILTERS.map((o) => o.label), ['Confirmed', 'Unreachable', 'Refuted'])
    // `partial` is a value of the field with a stamp of its own, but
    // not an option: it rides Confirmed, because a partial
    // confirmation is still a yes to "does this still stand".
    assert.equal(REVALIDATE_FILTERS.some((o) => o.value === 'partial'), false)
    assert.ok(REVALIDATE_KINDS.includes('partial'))
  })

  it('matches the selected outcome and nothing else', () => {
    state.filterRevalidate = 'refuted'
    assert.equal(matchesFilters(makeFinding('A', { revalidate: 'refuted' })), true)
    assert.equal(matchesFilters(makeFinding('B', { revalidate: 'confirmed' })), false)
    assert.equal(matchesFilters(makeFinding('C', { revalidate: 'unreachable' })), false)
    assert.equal(matchesFilters(makeFinding('D', { revalidate: 'unknown' })), false)
    assert.equal(matchesFilters(makeFinding('E')), false)
  })

  it('keeps unreachable to its own option', () => {
    state.filterRevalidate = 'unreachable'
    assert.equal(matchesFilters(makeFinding('A', { revalidate: 'unreachable' })), true)
    assert.equal(matchesFilters(makeFinding('B', { revalidate: 'refuted' })), false)
    assert.equal(matchesFilters(makeFinding('C', { revalidate: 'confirmed' })), false)
  })

  it('takes the revalidation row and a partial confirmation under Confirmed', () => {
    state.filterRevalidate = 'confirmed'
    assert.equal(matchesFilters(makeFinding('A', { revalidate: 'confirmed' })), true)
    assert.equal(matchesFilters(makeFinding('B', { revalidate: 'revalidation' })), true)
    assert.equal(matchesFilters(makeFinding('C', { revalidate: 'partial' })), true)
    assert.equal(matchesFilters(makeFinding('D', { revalidate: 'refuted' })), false)
    assert.equal(matchesFilters(makeFinding('E', { revalidate: 'unreachable' })), false)
    assert.equal(matchesFilters(makeFinding('F', { revalidate: 'unknown' })), false)
  })

  // A partial confirmation still stands, so it must not read as 0 the
  // way a refutation does.
  it('leaves a partial row its confidence', () => {
    assert.equal(voidsConfidence({ revalidate: 'partial' }), false)
    state.filterConfMin = 8
    assert.equal(matchesFilters(makeFinding('A', { confidence: 9, revalidate: 'partial' })), true)
    assert.equal(matchesFilters(makeFinding('B', { confidence: 3, revalidate: 'partial' })), false)
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
    for (const revalidate of [undefined, 'refuted', 'unreachable', 'confirmed', 'partial', 'unknown', 'revalidation']) {
      assert.equal(matchesFilters(makeFinding('A', { revalidate })), true, String(revalidate))
    }
  })

  // Confirmed carries a second question inside it: the option takes
  // the partial confirmations along with the full ones, and a chip in
  // its row draws that line more finely. All three settings are plain
  // kind lists, matched existentially over the group like every other
  // filter — the chip NARROWS what Confirmed reaches rather than
  // subtracting from it.
  describe('the partial switch inside Confirmed', () => {
    it('cycles included → full-only → partial-only, and back', () => {
      assert.deepEqual(PARTIAL_MODES, ['', 'exclude', 'only'])
    })

    it('takes everything the pass left standing by default', () => {
      assert.deepEqual(activeRevalidateKinds('confirmed', ''), ['confirmed', 'partial', 'revalidation'])
      state.filterRevalidate = 'confirmed'
      assert.equal(matchesFilters(makeFinding('A', { revalidate: 'partial' })), true)
      assert.equal(matchesFilters(makeFinding('B', { revalidate: 'confirmed' })), true)
      assert.equal(matchesFilters(makeFinding('C', { revalidate: 'revalidation' })), true)
    })

    // `− Partial` is "the full confirmations", not "everything but the
    // partials": a group earns its place by carrying a `confirmed`
    // row, so the `revalidation` row — which rides Confirmed and is in
    // most groups — no longer stands in for a verdict here.
    it('takes only the full confirmations when the partials are off', () => {
      assert.deepEqual(activeRevalidateKinds('confirmed', 'exclude'), ['confirmed'])
      state.filterRevalidate = 'confirmed'
      state.filterPartial = 'exclude'
      assert.equal(matchesFilters(makeFinding('A', { revalidate: 'confirmed' })), true)
      assert.equal(matchesFilters(makeFinding('B', { revalidate: 'partial' })), false)
      assert.equal(matchesFilters(makeFinding('C', { revalidate: 'revalidation' })), false)
    })

    it('takes only the partial ones when they are all that is wanted', () => {
      assert.deepEqual(activeRevalidateKinds('confirmed', 'only'), ['partial'])
      state.filterRevalidate = 'confirmed'
      state.filterPartial = 'only'
      assert.equal(matchesFilters(makeFinding('A', { revalidate: 'partial' })), true)
      assert.equal(matchesFilters(makeFinding('B', { revalidate: 'confirmed' })), false)
      assert.equal(matchesFilters(makeFinding('C', { revalidate: 'revalidation' })), false)
    })

    // The chip only ever shows under Confirmed, but the mode is kept
    // across a change of outcome (so coming back restores it) — which
    // is only safe because it can't narrow an option that never took
    // the partial rows in the first place.
    it('is inert under every other outcome', () => {
      for (const mode of PARTIAL_MODES) {
        assert.deepEqual(activeRevalidateKinds('refuted', mode), ['refuted'], mode)
        assert.deepEqual(activeRevalidateKinds('unreachable', mode), ['unreachable'], mode)
        assert.equal(activeRevalidateKinds('', mode), null, mode)
      }
      state.filterRevalidate = 'refuted'
      state.filterPartial = 'only'
      assert.equal(matchesFilters(makeFinding('A', { revalidate: 'refuted' })), true)
      assert.equal(matchesFilters(makeFinding('B', { revalidate: 'partial' })), false)
    })

    // One matching row shows the whole group, the rule every filter
    // here follows — so a group carrying both a full and a partial
    // confirmation is in all three lists.
    it('keeps the whole group when any row answers', () => {
      const group = [makeFinding('A', { revalidate: 'confirmed' }), makeFinding('B', { revalidate: 'partial' })]
      state.filterRevalidate = 'confirmed'
      for (const mode of PARTIAL_MODES) {
        state.filterPartial = mode
        assert.equal(applyFilters([group])[0]?.length, 2, mode)
      }
    })

    // The three lists across a revalidation report's shapes — this is
    // what the chip is for, so it is pinned end to end.
    it('gives each setting its own list', () => {
      const groups = [
        [makeFinding('A', { revalidate: 'revalidation' }), makeFinding('B', { revalidate: 'partial' })],
        [makeFinding('C', { revalidate: 'revalidation' }), makeFinding('D', { revalidate: 'confirmed' })],
        [makeFinding('E', { revalidate: 'revalidation' })],
        [makeFinding('F', { revalidate: 'refuted' })],
      ]
      state.filterRevalidate = 'confirmed'
      const ids = (mode) => {
        state.filterPartial = mode
        return applyFilters(groups).map((g) => g[0].id)
      }
      assert.deepEqual(ids(''), ['A', 'C', 'E'])
      assert.deepEqual(ids('exclude'), ['C'])
      assert.deepEqual(ids('only'), ['A'])
    })
  })

  // What a freshly-loaded report OPENS on. ingest.js auto-tunes a
  // confidence floor, then asks this which face of the block should
  // lead. Confirmed does, unless it would COST the reader something —
  // an issue the range would have shown and Confirmed would not.
  // Neither a row the pass ruled out nor a row whose issues are all on
  // screen inside another row is such a cost.
  describe('the outcome a first load opens on', () => {
    const stamped = (id, extra) => makeFinding(id, { revalidate: 'confirmed', ...extra })
    const pass = (id, extra) => makeFinding(id, { revalidate: 'revalidation', ...extra })

    it('opens on Confirmed when the floor leaves only revalidated groups', () => {
      const groups = [[stamped('A', { confidence: 9 })], [stamped('B', { confidence: 8 })]]
      assert.equal(defaultRevalidateFilter(groups, 8), 'confirmed')
    })

    it('stays off when a group on screen carries no stamp at all', () => {
      const groups = [[stamped('A', { confidence: 9 })], [makeFinding('B', { confidence: 9 })]]
      assert.equal(defaultRevalidateFilter(groups, 8), '')
    })

    // Only what the FLOOR shows has to be stamped — an unstamped
    // group below it is not on screen to disagree.
    it('ignores the groups the floor already hides', () => {
      const groups = [[stamped('A', { confidence: 9 })], [makeFinding('B', { confidence: 2 })]]
      assert.equal(defaultRevalidateFilter(groups, 8), 'confirmed')
      // Drop the floor and that group is on screen, unstamped.
      assert.equal(defaultRevalidateFilter(groups, 0), '')
    })

    // One stamped row is enough for its group, the same rule every
    // other filter follows.
    it('takes a group whose stamp is on one of its rows', () => {
      const groups = [[makeFinding('A', { confidence: 9 }), stamped('B', { confidence: 9 })]]
      assert.equal(defaultRevalidateFilter(groups, 8), 'confirmed')
    })

    it('takes any stamp as revalidated, but needs Confirmed to be reachable', () => {
      // Everything on screen is stamped, and `partial` rides Confirmed.
      const partial = [[makeFinding('A', { confidence: 9, revalidate: 'partial' })]]
      assert.equal(defaultRevalidateFilter(partial, 8), 'confirmed')
      // Stamped throughout, but the pass only ever knocked things
      // down: opening on Confirmed would open on an empty screen.
      const refuted = [[makeFinding('A', { confidence: 9, revalidate: 'refuted' })]]
      assert.equal(defaultRevalidateFilter(refuted, 0), '')
      const unknown = [[makeFinding('A', { confidence: 9, revalidate: 'unknown' })]]
      assert.equal(defaultRevalidateFilter(unknown, 8), '')
      // A refuted set with one surviving finding opens on it at any
      // floor: a knocked-down finding is not a loss (see below).
      const mixed = [
        [makeFinding('A', { confidence: 9, revalidate: 'refuted' })],
        [makeFinding('B', { confidence: 9, revalidate: 'confirmed' })],
      ]
      assert.equal(defaultRevalidateFilter(mixed, 8), 'confirmed')
      assert.equal(defaultRevalidateFilter(mixed, 0), 'confirmed')
    })

    // Two reports over the same code — an analysis, and a
    // revalidation of it that carries the same findings plus the
    // pass's own rows. Whether the copies collapse into one row or sit
    // beside each other, Confirmed shows every ISSUE the range would:
    // the un-stamped copy dropping out of the list is not the issue
    // going missing, so it doesn't hold the range in front.
    it('keeps Confirmed when a missed row holds no issue of its own', () => {
      const a = [[makeFinding('1', { confidence: 9 }), makeFinding('2', { confidence: 9 })]]
      const b = [[pass('4', { confidence: 9 }), makeFinding('1', { confidence: 9 }), makeFinding('2', { confidence: 9 })]]
      // Collapsed into one row, as the dedup merge leaves them.
      assert.equal(defaultRevalidateFilter(b, 0), 'confirmed')
      // And side by side, as two rows over the same two issues.
      assert.equal(defaultRevalidateFilter([...a, ...b], 0), 'confirmed')
      // One issue the stamped row does NOT carry is a real loss.
      const extra = [...b, [makeFinding('3', { confidence: 9 })]]
      assert.equal(defaultRevalidateFilter(extra, 0), '')
    })

    // A row the pass never reached holds the range in front — those
    // issues have no answer yet, and filtering them away before the
    // reader has seen them is not a default to make.
    it('falls back to the range for a row the pass never reached', () => {
      const reached = [pass('4', { confidence: 9 }), stamped('1', { confidence: 9 })]
      assert.equal(defaultRevalidateFilter([reached, [makeFinding('9', { confidence: 9 })]], 8), '')
      // A row the range leaves off costs nothing to leave off — every
      // issue in it scored, none of them clearing the floor.
      assert.equal(defaultRevalidateFilter([reached, [makeFinding('9', { confidence: 2 })]], 8), 'confirmed')
      // An UNSCORED issue is never one of those: it disables the range
      // for the whole set (render.js hasAnyConfidence), so the floor
      // that would have hidden it never runs and its row is on screen.
      assert.equal(defaultRevalidateFilter([reached, [makeFinding('9')]], 8), '')
      // `critical: true` stands in for a score, so it doesn't disable
      // anything — and it clears any floor, so its row is on screen
      // for Confirmed to lose.
      assert.equal(defaultRevalidateFilter([reached, [makeFinding('9', { critical: true })]], 8), '')
      // A row shows in FULL, so a visible one carries its unscored
      // members onto the screen with it — and those are findings
      // Confirmed can lose. This is the row-vs-finding distinction:
      // the row is on screen for its scored issue, the unscored one is
      // on screen with it, and Confirmed takes both away.
      const unscoredRider = [makeFinding('9', { confidence: 9 }), makeFinding('10')]
      assert.equal(defaultRevalidateFilter([reached, unscoredRider], 8), '')
    })

    // A finding the pass KNOCKED DOWN is never a cost. Refuted or
    // unreachable, it isn't a finding any more, and leaving it off is
    // what a reader picks Confirmed for — so it is exempt from the
    // comparison whatever the floor is doing.
    it('never counts a knocked-down finding as a loss', () => {
      const groups = [
        [stamped('A', { confidence: 9 })],
        [makeFinding('B', { confidence: 9, revalidate: 'refuted' })],
        [makeFinding('C', { confidence: 9, revalidate: 'unreachable' })],
      ]
      assert.equal(defaultRevalidateFilter(groups, 8), 'confirmed')
      assert.equal(defaultRevalidateFilter(groups, 0), 'confirmed')
      // Exempt per FINDING, not per row: an unjudged finding sharing a
      // row with a knocked-down one is still a loss, and the row is on
      // screen for it.
      const shared = [
        [stamped('A', { confidence: 9 })],
        [makeFinding('B', { confidence: 9, revalidate: 'refuted' }), makeFinding('C', { confidence: 9 })],
      ]
      assert.equal(defaultRevalidateFilter(shared, 8), '')
      assert.equal(defaultRevalidateFilter(shared, 0), '')
      // The other way round too — the knocked-down one carries the row
      // onto the screen and the unjudged one is what's lost.
      const carried = [
        [stamped('A', { confidence: 9 })],
        [makeFinding('B', { confidence: 9, revalidate: 'refuted' }), makeFinding('C', { confidence: 2 })],
      ]
      assert.equal(defaultRevalidateFilter(carried, 0), '')
      // A row of nothing but knocked-down findings costs nothing.
      const allDown = [
        [stamped('A', { confidence: 9 })],
        [makeFinding('B', { confidence: 9, revalidate: 'refuted' }), makeFinding('C', { confidence: 9, revalidate: 'unreachable' })],
      ]
      assert.equal(defaultRevalidateFilter(allDown, 0), 'confirmed')
    })

    // The range is a whole-set control: one unscored finding and
    // render.js disables it and resets the bounds, so the auto-tuned
    // floor never runs and every row is on screen. The comparison has
    // to be made against THAT screen, not against a floor the view is
    // about to throw away.
    it('measures against the floor the view will really apply', () => {
      const reached = [pass('4', { confidence: 9 }), stamped('1', { confidence: 9 })]
      // Below the floor, so not a loss — while the floor still runs.
      const low = [makeFinding('9', { confidence: 2 })]
      assert.equal(defaultRevalidateFilter([reached, low], 8), 'confirmed')
      // Add one unscored finding ANYWHERE and the floor stops running:
      // the low row is on screen after all, and Confirmed loses it.
      assert.equal(defaultRevalidateFilter([reached, low, [makeFinding('8')]], 8), '')
      // The same set with that finding scored keeps the floor, and the
      // answer with it.
      assert.equal(defaultRevalidateFilter([reached, low, [makeFinding('8', { confidence: 9, revalidate: 'confirmed' })]], 8), 'confirmed')
      // An unscored finding inside a row Confirmed SHOWS costs
      // nothing on its own account — the floor stops running, but that
      // row is on screen under both. (Only on its own account: the
      // rows the floor WAS hiding come back with it, which is what the
      // assertion above is about.)
      assert.equal(defaultRevalidateFilter([[...reached, makeFinding('2')]], 8), 'confirmed')
    })

    it('stays off when the floor leaves nothing on screen', () => {
      assert.equal(defaultRevalidateFilter([], 0), '')
      assert.equal(defaultRevalidateFilter([[stamped('A', { confidence: 2 })]], 8), '')
    })

    // The floor's own reading of what's on screen, which is not just
    // `confidence >= min`: an unscored row shows only at floor 0
    // unless it's flagged `critical`, and a knocked-down row reads as
    // 0 whatever number it carries.
    it('reads the floor the way the filter does', () => {
      // A is stamped but unscored; B is scored but unstamped.
      const unscored = [[stamped('A')], [makeFinding('B', { confidence: 9 })]]
      // At floor 8 the unscored group drops out, leaving only B —
      // which carries no stamp, so no outcome.
      assert.equal(defaultRevalidateFilter(unscored, 8), '')
      // At floor 0 both show, and B still carries none.
      assert.equal(defaultRevalidateFilter(unscored, 0), '')
      // A `critical` row clears any floor without a score.
      const critical = [[stamped('A', { critical: true })]]
      assert.equal(defaultRevalidateFilter(critical, 8), 'confirmed')
      // A refuted 10 reads as 0, so its group is below the floor —
      // leaving only the stamped group on screen.
      const knocked = [
        [stamped('A', { confidence: 9 })],
        [makeFinding('B', { confidence: 10, revalidate: 'refuted' })],
      ]
      assert.equal(defaultRevalidateFilter(knocked, 8), 'confirmed')
    })
  })

  // The toolbar drops the control when this comes back empty, so a
  // pass that only ever answered `unknown` shows no dropdown at all.
  it('reaches an outcome only from the kinds that feed it', () => {
    const values = (kinds) => reachableRevalidateFilters(kinds).map((o) => o.value)
    assert.deepEqual(values(REVALIDATE_KINDS), ['confirmed', 'unreachable', 'refuted'])
    assert.deepEqual(values(['revalidation']), ['confirmed'])
    assert.deepEqual(values(['confirmed']), ['confirmed'])
    // A set the pass only ever partly confirmed still reaches
    // Confirmed — that option is what those rows answer to.
    assert.deepEqual(values(['partial']), ['confirmed'])
    assert.deepEqual(values(['refuted']), ['refuted'])
    assert.deepEqual(values(['unreachable']), ['unreachable'])
    assert.deepEqual(values(['unknown']), [])
    assert.deepEqual(values([]), [])
  })
})

// A finding a product's import brought in — Claude Security, Codex
// Security, DeepSec, Piolium — was never put in front of DeepView's
// revalidation pass, so that pass never ruled it out. Where nothing
// else judged it either, it rides `revalidation`, the value that names
// the pass itself: permanently standing, permanently Confirmed, and
// carrying no layer for the App switch to take off. That is what keeps
// a workspace mixing a revalidated report with imported ones from
// filtering the imports away for lacking a stamp they could never have
// carried — and it stops where the product ran a pass of its own.
describe('the findings the pass never saw', () => {
  beforeEach(reset)

  const imported = (id, extra = {}) => makeFinding(id, { _source: 'deepsec', ...extra })

  it('rides the pass row, whatever produced it', () => {
    // The analyzer's own findings answer with the pass's reading.
    for (const kind of REVALIDATE_KINDS) {
      assert.equal(filterRevalidateKind(makeFinding('A', { revalidate: kind })), kind, kind)
    }
    assert.equal(filterRevalidateKind(makeFinding('A')), '')
    // Every producer marker reads the same way — and it is the
    // FINDING's marker that counts, so a product's row out of a
    // re-imported export that mixed it with the analyzer's own runs
    // is that product's wherever it now sits.
    for (const source of ['claude-security', 'codex-security', 'deepsec', 'piolium']) {
      assert.equal(filterRevalidateKind(imported('A', { _source: source })), 'revalidation', source)
    }
    // The App switch is not theirs to flip: off, the analyzer's rows
    // go to the code view and an import still stands.
    configureRevalidation(false)
    assert.equal(filterRevalidateKind(imported('A')), 'revalidation')
    assert.equal(filterRevalidateKind(makeFinding('B', { revalidate: 'confirmed' })), '')
  })

  // Revalidating an imported report is a thing the pipeline can do,
  // and a verdict it reached is the answer — the stand-in only fills
  // the gap where the pass left none.
  it('yields to a stamp the row does carry', () => {
    assert.equal(filterRevalidateKind(imported('A', { revalidate: 'refuted' })), 'refuted')
    assert.equal(filterRevalidateKind(imported('B', { revalidate: 'partial' })), 'partial')
  })

  // And it stands aside for a producer that ran a pass of its own and
  // wrote down what it concluded, which DeepSec's report does. There
  // an unstamped row is one the pass did not reach — not one the
  // report confirmed — and saying otherwise emptied Confirmed of
  // meaning for exactly the imports that arrive with real verdicts.
  // `_sourcePass` is ingest.js's answer to "did this producer judge
  // anything in the document this row came from".
  it('stands aside where that producer\'s own pass judged something', () => {
    const judged = (id, extra = {}) => imported(id, { _sourcePass: true, ...extra })
    assert.equal(filterRevalidateKind(judged('A')), '', 'unstamped: the report never said')
    assert.equal(filterRevalidateKind(judged('B', { revalidate: 'confirmed' })), 'confirmed')
    assert.equal(filterRevalidateKind(judged('C', { revalidate: 'refuted' })), 'refuted')
    // So Confirmed means what it says: the rows that report
    // confirmed, not every row it shipped.
    state.filterRevalidate = 'confirmed'
    assert.equal(matchesFilters(judged('A')), false)
    assert.equal(matchesFilters(judged('B', { revalidate: 'confirmed' })), true)
    // A producer whose report carries no pass is untouched — that
    // stand-in is what keeps a Claude Security import on screen.
    assert.equal(matchesFilters(imported('D', { _source: 'claude-security' })), true)
  })

  it('shows under Confirmed, and under nothing else', () => {
    state.filterRevalidate = 'confirmed'
    assert.equal(matchesFilters(imported('A')), true)
    for (const value of ['refuted', 'unreachable']) {
      state.filterRevalidate = value
      assert.equal(matchesFilters(imported('A')), false, value)
    }
    // A refuted import is filtered as refuted, like any other row.
    state.filterRevalidate = 'refuted'
    assert.equal(matchesFilters(imported('B', { revalidate: 'refuted' })), true)
  })

  // The partial chip narrows Confirmed to the rows the pass FULLY
  // confirmed, and an import is not one of them — the same answer the
  // pass's own row gives there.
  it('drops out with the pass row when the partials are excluded', () => {
    state.filterRevalidate = 'confirmed'
    state.filterPartial = 'exclude'
    assert.equal(matchesFilters(imported('A')), false)
    state.filterPartial = 'only'
    assert.equal(matchesFilters(imported('A')), false)
  })

  // What a workspace mixing the two OPENS on. An imported group is
  // not an unstamped one holding the whole set on the range.
  it('does not hold a mixed workspace off Confirmed', () => {
    const groups = [
      [makeFinding('A', { confidence: 9, revalidate: 'confirmed' })],
      [imported('B', { confidence: 9 })],
    ]
    assert.equal(defaultRevalidateFilter(groups, 8), 'confirmed')
    // …and the filter that opens really does keep the import on
    // screen, which is the point of the two halves together.
    state.filterRevalidate = 'confirmed'
    assert.deepEqual(applyFilters(groups).map((g) => g[0].id), ['A', 'B'])
  })

  // The bug this pins: a workspace is ONE view over its reports, and
  // the question "what does this set open on" has to be asked of the
  // set. Asked report by report — which is what a load did, on
  // whichever member came first — a workspace holding a revalidated
  // report and an imported one answered from the import alone and sat
  // on the confidence range, with the revalidated report's own answer
  // never asked for.
  it('opens a mixed workspace on Confirmed whichever member loads first', () => {
    const revalidated = [
      [makeFinding('D1', { confidence: 9, revalidate: 'confirmed' }), makeFinding('D1r', { confidence: 9, revalidate: 'revalidation' })],
    ]
    // A Claude Security import carries no confidence of its own
    // (report/src/parse-md.js reads none) and no stamp.
    const claude = [[imported('C1', { _source: 'claude-security' })]]
    // The interim answer, from the member that happened to load
    // first: the import alone is not a revalidation report.
    assert.equal(defaultRevalidateFilter(claude, defaultConfidenceFloor(claude)), '')

    const reports = state.reports
    const merges = state.workspaceMerges
    try {
      for (const order of [[claude, revalidated], [revalidated, claude]]) {
        state.workspaceMerges = []
        state.reports = order.map((groups) => ({ groups }))
        applyOpeningFilters(getMergedGroups())
        assert.equal(state.filterRevalidate, 'confirmed', JSON.stringify(order[0][0][0].id))
        // And the outcome really does show the import, which the
        // range it was sitting on could not: an unscored finding is
        // below any floor above 0.
        assert.deepEqual(
          applyFilters(getMergedGroups()).map((g) => g[0].id).toSorted(),
          ['C1', 'D1'],
        )
      }
    } finally {
      state.reports = reports
      state.workspaceMerges = merges
    }
  })

  // A pass has to have confirmed something ITSELF before the imports
  // ride along: a set with no revalidation in it gets no dropdown
  // from the toolbar (render.js scans the real values), so opening it
  // on an outcome would set a filter with no control to clear it.
  it('cannot open a set the pass never touched on Confirmed', () => {
    assert.equal(defaultRevalidateFilter([[imported('A', { confidence: 9 })]], 8), '')
    // Same where the pass ran but only ever knocked things down.
    const refuted = [
      [makeFinding('A', { confidence: 9, revalidate: 'refuted' })],
      [imported('B', { confidence: 9 })],
    ]
    assert.equal(defaultRevalidateFilter(refuted, 0), '')
  })
})

// An analysis and the revalidation of it, loaded together — the
// workspace shape the outcome default is really about. The
// revalidation report carries the analysis's findings again plus the
// pass's own rows, so ingest dedups the copies and records a merge
// tying each pass row back to the row it belongs with (ingest.js).
// The view is that merged result, and it is what decides what the set
// opens on (switchToWorkspace).
//
// Both report shapes and both load orders are pinned here. They were
// checked end to end against a real build in a browser — toolbar on
// Confirmed, every row on screen — and this is that check kept where
// it can run.
describe('an analysis and its revalidation, loaded together', () => {
  beforeEach(reset)

  const scored = (id, extra = {}) => makeFinding(id, { confidence: 9, ...extra })
  const pass = (id) => scored(id, { revalidate: 'revalidation' })

  // One load: `reports` as ingest leaves them — the second one keeps
  // only the members the first didn't already carry — and `merges` as
  // it records them. Then the question switchToWorkspace asks once
  // every member is in.
  const opensOn = (reports, merges) => {
    const savedReports = state.reports
    const savedMerges = state.workspaceMerges
    try {
      state.reports = reports.map((groups) => ({ groups }))
      state.workspaceMerges = merges.map((ids) => new Set(ids))
      const merged = getMergedGroups()
      applyOpeningFilters(merged)
      return { rows: merged.map((g) => g.map((f) => f.id)), outcome: state.filterRevalidate }
    } finally {
      state.reports = savedReports
      state.workspaceMerges = savedMerges
    }
  }

  // The revalidation carries a pass row per row: [[4,1,2,3],[7,5,6]]
  // against an analysis of [[1,2,3],[5,6]].
  it('opens on Confirmed with a pass row per row', () => {
    // Analysis first: its findings are already loaded, so the
    // revalidation contributes only its pass rows, each tied back by a
    // merge.
    assert.deepEqual(
      opensOn(
        [[[scored('1'), scored('2'), scored('3')], [scored('5'), scored('6')]], [[pass('4')], [pass('7')]]],
        [['4', '1', '2', '3'], ['7', '5', '6']],
      ),
      { rows: [['4', '1', '2', '3'], ['7', '5', '6']], outcome: 'confirmed' },
    )
    // Revalidation first: the analysis is wholly a duplicate of what
    // is loaded and contributes nothing, so there is nothing to merge.
    assert.deepEqual(
      opensOn([[[pass('4'), scored('1'), scored('2'), scored('3')], [pass('7'), scored('5'), scored('6')]], []], []),
      { rows: [['4', '1', '2', '3'], ['7', '5', '6']], outcome: 'confirmed' },
    )
  })

  // A row the reader has already filed away — fixed, invalid, ignored,
  // deleted — is not on screen, so it is no part of what either face
  // of the block would show. Asked over the whole loaded set instead,
  // one old untriaged-looking row held every later load on the range,
  // however thoroughly the pass had covered what was actually up.
  it('ignores the rows the reader has triaged away', () => {
    const savedReports = state.reports
    const savedMerges = state.workspaceMerges
    const savedMode = state.viewMode
    const savedBucket = state.shownTriage
    try {
      state.workspaceMerges = []
      state.viewMode = 'table'
      state.shownTriage = null
      state.reports = [{ groups: [
        [pass('4'), scored('1'), scored('2')],
        [scored('9')],
      ] }]
      // Both rows live: the unstamped one is on screen and Confirmed
      // would take it away.
      applyOpeningFilters(getShownGroups())
      assert.equal(state.filterRevalidate, '')
      // Filed away, it leaves the live list — and with it the reason
      // to hold the range in front.
      state.triage = new Map([['9', { triage: 'fixed' }]])
      applyOpeningFilters(getShownGroups())
      assert.equal(state.filterRevalidate, 'confirmed')
      // Kanban lays every bucket out at once, so there it IS on screen
      // and the answer goes back.
      state.viewMode = 'kanban'
      applyOpeningFilters(getShownGroups())
      assert.equal(state.filterRevalidate, '')
      // …as it does for a reader parked in the bucket it went to.
      state.viewMode = 'table'
      state.shownTriage = 'fixed'
      applyOpeningFilters(getShownGroups())
      assert.equal(state.filterRevalidate, '')
    } finally {
      state.reports = savedReports
      state.workspaceMerges = savedMerges
      state.viewMode = savedMode
      state.shownTriage = savedBucket
    }
  })

  // The revalidation puts the lot in ONE row —
  // [[4,7,1,2,3,5,6]] — merging two of the analysis's rows. Every
  // issue is still on screen under Confirmed, so Confirmed still
  // leads.
  it('opens on Confirmed when the revalidation merges two rows into one', () => {
    assert.deepEqual(
      opensOn(
        [[[scored('1'), scored('2'), scored('3')], [scored('5'), scored('6')]], [[pass('4'), pass('7')]]],
        [['4', '7', '1', '2', '3', '5', '6']],
      ),
      { rows: [['4', '7', '1', '2', '3', '5', '6']], outcome: 'confirmed' },
    )
    assert.deepEqual(
      opensOn([[[pass('4'), pass('7'), scored('1'), scored('2'), scored('3'), scored('5'), scored('6')]], []], []),
      { rows: [['4', '7', '1', '2', '3', '5', '6']], outcome: 'confirmed' },
    )
  })
})

// Where a finding sits on the 0—10 confidence scale, and whether that
// scale is a live control at all. An import carries no confidence
// because its producer emits none, not because anyone was unsure — so
// it rides the top of the scale instead of taking the scale away from
// everyone else, which is what it used to do. Unless the producer DOES
// rate its findings, as DeepSec does: that number is the finding's own
// and answers both questions itself.
describe('the confidence scale', () => {
  beforeEach(reset)

  const imported = (id, extra = {}) => makeFinding(id, { _source: 'claude-security', ...extra })

  it('places a finding, or says it has no place', () => {
    assert.equal(confidenceOnScale(makeFinding('A', { confidence: 3 })), 3)
    assert.equal(confidenceOnScale(makeFinding('A', { confidence: 0 })), 0)
    // `critical: true` — the boolean, not the severity tier.
    assert.equal(confidenceOnScale(makeFinding('A', { critical: true })), 10)
    assert.equal(confidenceOnScale(makeFinding('A', { severity: 'critical' })), undefined)
    // An import rides the top of the scale.
    assert.equal(confidenceOnScale(imported('A')), 10)
    // …but its own score wins where it has one (DeepSec reads them).
    assert.equal(confidenceOnScale(imported('A', { confidence: 4 })), 4)
    // The analyzer's own unscored finding has no place at all.
    assert.equal(confidenceOnScale(makeFinding('A')), undefined)
  })

  it('rides the range like a 10', () => {
    const shown = (f, min, max) => { state.filterConfMin = min; state.filterConfMax = max; return matchesFilters(f) }
    for (const f of [imported('A'), makeFinding('B', { critical: true })]) {
      assert.equal(shown(f, 8, 10), true, `8—10 ${f.id}`)
      assert.equal(shown(f, 2, 10), true, `2—10 ${f.id}`)
      assert.equal(shown(f, 0, 5), false, `0—5 ${f.id}`)
      assert.equal(shown(f, 7, 9), false, `7—9 ${f.id}`)
    }
    // The analyzer's own unscored finding shows only with the floor
    // down at 0, as before.
    const plain = makeFinding('C')
    assert.equal(shown(plain, 0, 10), true)
    assert.equal(shown(plain, 1, 10), false)
  })

  // The cases the toolbar has to tell apart.
  it('is a live control only where something scored itself', () => {
    const scored = makeFinding('D', { confidence: 9 })
    // 1. Nothing on the scale at all — unscored imports only. No
    //    range: every row is a 10, and a range over one value says
    //    nothing.
    assert.equal(rangeApplies([[imported('C1')], [imported('C2')]]), false)
    // 1b. …but a producer that scores its findings establishes the
    //     scale like the analyzer does. A load of nothing but DeepSec
    //     is a real range over real numbers, and used to get none.
    assert.equal(rangeApplies([[imported('C1', { confidence: 6 })], [imported('C2', { confidence: 8 })]]), true)
    // One scored import is enough, and an unscored one beside it
    // still rides the top rather than taking the range away.
    assert.equal(rangeApplies([[imported('C1', { confidence: 4 })], [imported('C2')]]), true)
    // 4. An import beside the analyzer's own scored findings does NOT
    //    take the range away — this is the failure mode: it used to,
    //    which left the range at 0—10 filtering nothing.
    assert.equal(rangeApplies([[scored], [imported('C1')]]), true)
    // 3. An analyzer finding with no confidence and no `critical`
    //    still disables it, import or no import.
    assert.equal(rangeApplies([[scored], [makeFinding('E')]]), false)
    assert.equal(rangeApplies([[scored], [imported('C1')], [makeFinding('E')]]), false)
    // …unless it is flagged critical, which stands in for a score.
    assert.equal(rangeApplies([[scored], [makeFinding('E', { critical: true })]]), true)
    // A set the analyzer only ever flagged critical still has a
    // scale — that flag is the analyzer placing the finding on it.
    assert.equal(rangeApplies([[makeFinding('E', { critical: true })]]), true)
    assert.equal(rangeApplies([]), false)
  })

  // The reported failure, end to end through the opening question: a
  // Claude Security import disabled the range, so the floor stopped
  // running, so a confidence-2 row the pass never reached was on
  // screen, so Confirmed was held off for hiding it.
  it('does not let an import hold a workspace off Confirmed', () => {
    const groups = [
      [makeFinding('4', { confidence: 9, revalidate: 'revalidation' }), makeFinding('1', { confidence: 9 })],
      [makeFinding('2', { confidence: 2 })],
      [imported('C1')],
    ]
    const floor = defaultConfidenceFloor(groups)
    assert.ok(floor > 2, `floor ${floor} has to leave the confidence-2 row off`)
    assert.equal(defaultRevalidateFilter(groups, floor), 'confirmed')
    // And with the outcome in front, the import is on screen with the
    // revalidated row — the range is what would have hidden it.
    state.filterConfMin = floor
    state.filterRevalidate = 'confirmed'
    assert.deepEqual(applyFilters(groups).map((g) => g[0].id).toSorted(), ['4', 'C1'])
  })
})

// Dedup keeps the first copy of a finding it sees, which is a
// load-order accident. A report that has been through the pass and
// the analysis it re-examined hold the SAME finding under the same id
// — a stamp is no part of the fingerprint — so whichever loaded first
// decided whether the workspace had the pass's verdicts at all.
describe('what a dropped duplicate leaves behind', () => {
  beforeEach(reset)

  it('carries the pass\'s answer onto the survivor', () => {
    const survivor = makeFinding('A', { confidence: 9 })
    mergeDuplicateFields(survivor, makeFinding('A', {
      confidence: 9,
      revalidate: 'confirmed',
      revalidateVerdict: 'Still reachable.',
      revalidateRecommendation: 'Fix it.',
    }))
    assert.equal(survivor.revalidate, 'confirmed')
    assert.equal(survivor.revalidateVerdict, 'Still reachable.')
    assert.equal(survivor.revalidateRecommendation, 'Fix it.')
    // Which is what puts it under Confirmed, whichever report loaded
    // first.
    state.filterRevalidate = 'confirmed'
    assert.equal(matchesFilters(survivor), true)
  })

  it('fills gaps only — the survivor keeps what it answered', () => {
    const survivor = makeFinding('A', { confidence: 9, revalidate: 'refuted', priority: 3 })
    mergeDuplicateFields(survivor, makeFinding('A', { confidence: 2, revalidate: 'confirmed', priority: 1 }))
    assert.equal(survivor.revalidate, 'refuted')
    assert.equal(survivor.confidence, 9)
    assert.equal(survivor.priority, 3)
    // `null` is no answer, on either side — a report is JSON, where a
    // written-out null and an absent key say the same thing.
    const nulled = makeFinding('B', { confidence: null, revalidate: null })
    mergeDuplicateFields(nulled, makeFinding('B', { confidence: 7, revalidate: 'partial' }))
    assert.equal(nulled.confidence, 7)
    assert.equal(nulled.revalidate, 'partial')
    const keeper = makeFinding('C', { confidence: 7 })
    mergeDuplicateFields(keeper, makeFinding('C', { confidence: null }))
    assert.equal(keeper.confidence, 7)
  })

  it('generalises past the stamp, and leaves two kinds of field alone', () => {
    const survivor = makeFinding('A', { _reportName: 'mine.json', _source: null })
    mergeDuplicateFields(survivor, makeFinding('A', {
      commitHash: 'abc1234',
      priority: 2,
      // Where the OTHER copy came from — never the survivor's.
      _reportName: 'theirs.md',
      _source: 'claude-security',
      _analyzer: 'claude-security',
      // Has a mechanism of its own (ingest.js recordCorrectedVariant),
      // which keeps both reports' values as variants.
      correctedSeverity: 'low',
      correctedSeverityReason: 'Not exploitable.',
    }))
    assert.equal(survivor.commitHash, 'abc1234')
    assert.equal(survivor.priority, 2)
    assert.equal(survivor._reportName, 'mine.json')
    assert.equal(survivor._source, null)
    assert.equal(survivor._analyzer, undefined)
    assert.equal(survivor.correctedSeverity, undefined)
    assert.equal(survivor.correctedSeverityReason, undefined)
  })

  // Compared as the app READS the stamp, not as the file wrote it.
  it('reads the stamp before calling two copies different', () => {
    const merge = (own, theirs) => {
      const survivor = makeFinding('A', own)
      return { conflicted: mergeDuplicateFields(survivor, makeFinding('A', theirs)), survivor }
    }
    // Same stamp, two spellings — the reader trims and case-folds.
    const spelled = merge({ revalidate: 'confirmed' }, { revalidate: '  CONFIRMED ' })
    assert.equal(spelled.conflicted, false)
    assert.equal(spelled.survivor.revalidate, 'confirmed')
    // A value the app can't read is no answer: it neither lands...
    const unreadable = merge({ revalidate: 'confirmed' }, { revalidate: 'maybe' })
    assert.equal(unreadable.conflicted, false)
    assert.equal(unreadable.survivor.revalidate, 'confirmed')
    // ...nor blocks the other copy's real stamp from landing.
    const overwritten = merge({ revalidate: 'nonsense' }, { revalidate: 'refuted' })
    assert.equal(overwritten.conflicted, false)
    assert.equal(overwritten.survivor.revalidate, 'refuted')
    // The prose either side of the stamp is compared past the
    // whitespace two writers can differ on for the same words.
    assert.equal(merge({ revalidateVerdict: 'Holds.' }, { revalidateVerdict: '  Holds.\n' }).conflicted, false)
  })

  // `source` is provenance like the `_`-prefixed fields, just public:
  // ingest has already derived `_source` / `_analyzer` from it, so
  // filling it would leave the row native to the toolbar and the other
  // producer's to a markdown export.
  it('leaves the public provenance field alone', () => {
    const survivor = makeFinding('A', { confidence: 9 })
    mergeDuplicateFields(survivor, makeFinding('A', { source: 'claude-security', commitHash: 'abc1234' }))
    assert.equal(survivor.source, undefined)
    assert.equal(survivor.commitHash, 'abc1234')
  })

  // A disagreement about the pass isn't settled by load order — it is
  // reported, and ingest.js takes the layer off the whole set for it.
  it('reports a disagreement about the pass rather than settling it', () => {
    const conflict = (own, theirs) => {
      const survivor = makeFinding('A', own)
      return { conflicted: mergeDuplicateFields(survivor, makeFinding('A', theirs)), survivor }
    }
    // Two verdicts, two answers: a conflict, and the survivor keeps
    // its own.
    const stamp = conflict({ revalidate: 'confirmed' }, { revalidate: 'refuted' })
    assert.equal(stamp.conflicted, true)
    assert.equal(stamp.survivor.revalidate, 'confirmed')
    // The pass's prose counts too — same field family.
    assert.equal(conflict({ revalidateVerdict: 'Holds.' }, { revalidateVerdict: 'Does not.' }).conflicted, true)
    assert.equal(conflict({ revalidateRecommendation: 'Fix.' }, { revalidateRecommendation: 'Drop.' }).conflicted, true)
    // Agreement is not a conflict, and neither is a gap.
    assert.equal(conflict({ revalidate: 'confirmed' }, { revalidate: 'confirmed' }).conflicted, false)
    assert.equal(conflict({}, { revalidate: 'confirmed' }).conflicted, false)
    assert.equal(conflict({ revalidate: 'confirmed' }, {}).conflicted, false)
    // Nor is a disagreement about anything else — those are for
    // another day, and the survivor keeps its own either way.
    const other = conflict({ confidence: 9, priority: 1 }, { confidence: 2, priority: 5 })
    assert.equal(other.conflicted, false)
    assert.equal(other.survivor.confidence, 9)
  })

  it('is a no-op without two findings to merge', () => {
    const f = makeFinding('A', { confidence: 9 })
    mergeDuplicateFields(f, f)
    assert.equal(f.confidence, 9)
    mergeDuplicateFields(undefined, makeFinding('A', { revalidate: 'confirmed' }))
    mergeDuplicateFields(f, undefined)
    assert.equal(f.revalidate, undefined)
  })
})

// The toolbar's "App" switch takes the whole revalidation layer off.
// With it on the findings are about the running app — what it reaches,
// re-rated by the second pass. With it off they are about the code as
// written: every issue the analyzer found, including the ones the pass
// ruled out. One switch rather than a filter per consequence, so what
// is pinned here is that the consequences really do all come off.
describe('the revalidation layer switch', () => {
  beforeEach(reset)

  it('reads the field past the switch where it has to', () => {
    // These two gate the switch and drop the pass's own rows, so they
    // answer the same either way — otherwise turning the layer off
    // would hide the control that turns it back on.
    for (const on of [true, false]) {
      configureRevalidation(on)
      assert.equal(hasRevalidateField({ revalidate: 'confirmed' }), true, String(on))
      assert.equal(hasRevalidateField({ revalidate: 'revalidation' }), true, String(on))
      assert.equal(hasRevalidateField({}), false, String(on))
      assert.equal(isRevalidationRow({ revalidate: 'revalidation' }), true, String(on))
      assert.equal(isRevalidationRow({ revalidate: 'confirmed' }), false, String(on))
    }
    // …and an unrecognised value is still no stamp, either way.
    configureRevalidation(false)
    assert.equal(hasRevalidateField({ revalidate: 'maybe' }), false)
  })

  // The switch is offered only where taking the layer off would hand
  // a ruled-out finding back. A report whose every `revalidate` is
  // `revalidation` — the pass's own rows, judging nothing — has none:
  // "off" there would drop those rows and reveal nothing in their
  // place, so the control isn't offered and the layer can't come off.
  it('offers no way off a set the pass only ever rowed', () => {
    for (const kind of ['refuted', 'unreachable', 'confirmed', 'partial', 'unknown']) {
      assert.equal(hasRevalidateStamp({ revalidate: kind }), true, kind)
    }
    assert.equal(hasRevalidateStamp({ revalidate: 'revalidation' }), false)
    assert.equal(hasRevalidateStamp({ revalidate: 'nonsense' }), false)
    assert.equal(hasRevalidateStamp({}), false)
    // …and past the switch, like the two readers above it: a gate
    // that stopped seeing the stamps once the layer was off would
    // take the way back with it.
    configureRevalidation(false)
    assert.equal(hasRevalidateStamp({ revalidate: 'refuted' }), true)
    assert.equal(hasRevalidateStamp({ revalidate: 'revalidation' }), false)
    configureRevalidation(true)

    const report = (...findings) => [{ groups: findings.map((f) => [f]) }]
    const pass = makeFinding('P', { revalidate: 'revalidation' })
    // Nothing but the pass's own rows — no switch, whatever else the
    // set carries.
    assert.equal(canDropRevalidation(report(pass)), false)
    assert.equal(canDropRevalidation(report(pass, makeFinding('A'))), false)
    // One judged row anywhere in the loaded set is enough.
    assert.equal(canDropRevalidation(report(pass, makeFinding('A', { revalidate: 'refuted' }))), true)
    for (const kind of ['refuted', 'unreachable', 'confirmed', 'partial', 'unknown']) {
      assert.equal(canDropRevalidation(report(makeFinding('A', { revalidate: kind }))), true, kind)
    }
    // A set the pass never touched is the code view already.
    assert.equal(canDropRevalidation(report(makeFinding('A'))), false)
    assert.equal(canDropRevalidation([]), false)
    assert.equal(canDropRevalidation([{}]), false)
  })

  it('answers no stamp for every row while off', () => {
    configureRevalidation(false)
    assert.equal(revalidationShown(), false)
    for (const kind of REVALIDATE_KINDS) {
      assert.equal(revalidateKind({ revalidate: kind }), '', kind)
      assert.equal(revalidateStamp({ revalidate: kind }), null, kind)
      assert.equal(isRevalidation({ revalidate: kind }), false, kind)
      assert.equal(voidsConfidence({ revalidate: kind }), false, kind)
    }
  })

  // Each of these is a consequence of the layer, reached through
  // revalidateKind — so all of them come off with the one flag.
  it('stops the pass voiding a confidence', () => {
    const refuted = makeFinding('A', { confidence: 10, revalidate: 'refuted' })
    state.filterConfMin = 8
    assert.equal(matchesFilters(refuted), false, 'reads as 0 while the layer is on')
    configureRevalidation(false)
    assert.equal(matchesFilters(refuted), true, 'reads as its own 10 with the layer off')
  })

  it('stops the pass row leading its group', () => {
    // Detailed, so both rows are on the strip and there is an order
    // to speak of either side of the switch.
    state.revalidationDetailed = true
    const crit = makeFinding('A', { severity: 'critical' })
    const pass = makeFinding('B', { severity: 'low', revalidate: 'revalidation' })
    assert.deepEqual(sortTabs([crit, pass]).map((f) => f.id), ['B', 'A'])
    configureRevalidation(false)
    assert.deepEqual(sortTabs([crit, pass]).map((f) => f.id), ['A', 'B'])
  })

  it('stops the run-meta line naming the pass', () => {
    const run = { type: 'security', model: 'claude-opus-5', revalidate: 'revalidation' }
    assert.equal(formatRunMeta(run), 'security · revalidate · opus 5')
    configureRevalidation(false)
    assert.equal(formatRunMeta(run), 'security · opus 5')
  })

  // Nothing reaches an outcome, so the toolbar drops the dropdown and
  // the block falls back to the plain Confidence range.
  it('leaves the outcome dropdown nothing to offer', () => {
    configureRevalidation(false)
    const kinds = new Set()
    for (const kind of REVALIDATE_KINDS) {
      const k = revalidateKind({ revalidate: kind })
      if (k) kinds.add(k)
    }
    assert.equal(kinds.size, 0)
    assert.deepEqual(reachableRevalidateFilters(kinds), [])
    assert.equal(defaultRevalidateFilter([[makeFinding('A', { revalidate: 'confirmed' })]], 0), '')
  })

  // The rows that ARE the pass go with the layer, and only those:
  // getMergedGroups is the one list every consumer reads, so dropping
  // them there takes them out of the counts, the filters, the tab
  // strips and the deep links at once.
  it('drops the pass rows, and nothing they were judging', () => {
    const reports = state.reports
    const merges = state.workspaceMerges
    try {
      state.workspaceMerges = []
      state.reports = [{ groups: [
        // A row the pass judged, beside the pass's own row.
        [makeFinding('A', { revalidate: 'confirmed' }), makeFinding('B', { revalidate: 'revalidation' })],
        // A group that is nothing BUT the pass.
        [makeFinding('C', { revalidate: 'revalidation' })],
        // Untouched by the pass entirely.
        [makeFinding('D')],
      ] }]
      const ids = () => getMergedGroups().map((g) => g.map((f) => f.id))
      assert.deepEqual(ids(), [['A', 'B'], ['C'], ['D']])
      state.showRevalidation = false
      assert.deepEqual(ids(), [['A'], ['D']])
      // A group nothing came out of keeps its identity, so nothing
      // downstream re-derives for a set that had no pass rows in it.
      const before = getMergedGroups()
      assert.equal(before.at(-1), state.reports[0].groups[2])
    } finally {
      state.reports = reports
      state.workspaceMerges = merges
    }
  })

  // Flipping the switch re-derives the outcome filter instead of
  // carrying one over, because a carried-over selection is wrong both
  // ways: off, nothing can reach it; back on, the cleared one leaves a
  // report that OPENS on Confirmed sitting on plain Confidence. This
  // is the expression events.js runs on the toggle.
  it('comes back to the outcome a reload would show', () => {
    const reports = state.reports
    const merges = state.workspaceMerges
    try {
      state.workspaceMerges = []
      state.reports = [{ groups: [[
        makeFinding('A', { confidence: 9, revalidate: 'revalidation' }),
        makeFinding('B', { confidence: 9, revalidate: 'confirmed' }),
      ]] }]
      // The expression events.js runs on a flip — the same two
      // questions ingest.js asks on a first load.
      const derive = () => {
        configureRevalidation(state.showRevalidation)
        const groups = getMergedGroups()
        state.filterConfMin = defaultConfidenceFloor(groups)
        state.filterConfMax = 10
        return defaultRevalidateFilter(groups, state.filterConfMin)
      }
      assert.equal(derive(), 'confirmed')
      state.showRevalidation = false
      assert.equal(derive(), '', 'nothing to reach with the layer off')
      // A range the user moved is not carried across the flip: the
      // switch changes which findings exist, so the floor it was
      // tuned against is gone with them.
      state.filterConfMin = 0
      state.filterConfMax = 4
      state.showRevalidation = true
      assert.equal(derive(), 'confirmed', 'and back to where a reload would put it')
      assert.equal(state.filterConfMin, defaultConfidenceFloor(getMergedGroups()))
      assert.equal(state.filterConfMax, 10)
    } finally {
      state.reports = reports
      state.workspaceMerges = merges
    }
  })

  it('keeps the layer on by default', () => {
    assert.equal(revalidationShown(), true)
    assert.equal(revalidateKind({ revalidate: 'confirmed' }), 'confirmed')
  })
})

// A product that scores its findings and runs a pass of its own — the
// two halves of this toolbar block, arriving from a producer that is
// not the analyzer. DeepSec is the one, and the block used to answer
// both questions by asking whether a row was an import: no range over
// its numbers, and every row riding Confirmed whatever its report
// concluded. Driven through the real parser, over findings stamped the
// way ingest.js stamps them.
describe('what a DeepSec report opens on', () => {
  beforeEach(reset)

  // A report in the shape DeepSec's own writer emits
  // (packages/deepsec/src/commands/report.ts): `counts` findings per
  // confidence word, each optionally carrying the pass's verdict.
  const report = (counts, verdicts = {}) => {
    const blocks = Object.entries(counts).flatMap(([word, n]) => Array.from({ length: n }, (_, i) => [
      `### ${word} ${i}`, '',
      `- **File:** \`src/${word}-${i}.js\``,
      '- **Lines:** 1',
      `- **Confidence:** ${word}`,
      ...verdicts[word] ? [`- **Revalidation:** ${verdicts[word]}`, '- **Reasoning:** because.'] : [],
      '', '---', '',
    ].join('\n')))
    return `# Vulnerability Scan Report\n\n## Summary\n\n## HIGH (${blocks.length})\n\n${blocks.join('')}`
  }

  // The groups the viewer holds: a row each, carrying the marks
  // ingest.js stamps — its row key, the producer, and whether that
  // producer's own pass judged anything in this document.
  const groupsOf = (counts, verdicts) => {
    const findings = readReport(report(counts, verdicts)).data.findings
    const judged = findings.some(hasRevalidateStamp)
    return findings.map((f, i) => [{ ...f, _id: i, _source: 'deepsec', _sourcePass: judged }])
  }

  // Which confidence words survive the floor a fresh load opens on.
  const wordsOnScreen = (groups) => {
    state.filterConfMin = defaultConfidenceFloor(groups)
    return [...new Set(applyFilters(groups).map((g) => g[0].file.split('/')[1].split('-')[0]))].toSorted()
  }

  it('is a live control over a load of nothing but DeepSec', () => {
    // Every row is an import, and every row carries a number its
    // producer wrote — which is a range, and used to be no range.
    assert.equal(rangeApplies(groupsOf({ high: 2, medium: 2, low: 2 })), true)
  })

  it('keeps the mediums where the set is small enough to hold them', () => {
    const groups = groupsOf({ high: 5, medium: 5, low: 5 })
    assert.equal(defaultConfidenceFloor(groups), 5)
    assert.deepEqual(wordsOnScreen(groups), ['high', 'medium'])
  })

  it('narrows to the highs where it is not', () => {
    const groups = groupsOf({ high: 20, medium: 20, low: 10 })
    assert.equal(defaultConfidenceFloor(groups), 7)
    assert.deepEqual(wordsOnScreen(groups), ['high'])
  })

  it('opens on the lot where nothing sits under the ladder to hide', () => {
    const groups = groupsOf({ high: 5, medium: 5 })
    assert.equal(defaultConfidenceFloor(groups), 0)
    assert.deepEqual(wordsOnScreen(groups), ['high', 'medium'])
  })

  // The other face of the block. A report whose pass answered for
  // every row it kept can lead with the outcome: Confirmed shows what
  // it confirmed, and the rows it refuted are what the reader picked
  // Confirmed to be rid of.
  it('leads with Confirmed where the pass answered for every row', () => {
    const groups = groupsOf({ high: 2, medium: 1 }, { high: 'confirmed', medium: '~~false positive~~' })
    assert.equal(defaultRevalidateFilter(groups, defaultConfidenceFloor(groups)), 'confirmed')
    state.filterRevalidate = 'confirmed'
    assert.deepEqual(applyFilters(groups).map((g) => g[0].file), ['src/high-0.js', 'src/high-1.js'])
  })

  // …and where it didn't, the unjudged rows are a cost Confirmed
  // can't pay: they are not findings the report confirmed, and the
  // stand-in that used to say they were is what made Confirmed
  // meaningless for a report carrying real verdicts.
  it('stays on the range while the pass left rows unjudged', () => {
    const groups = groupsOf({ high: 2, medium: 1 }, { high: 'confirmed' })
    assert.equal(defaultRevalidateFilter(groups, defaultConfidenceFloor(groups)), '')
    state.filterRevalidate = 'confirmed'
    assert.deepEqual(applyFilters(groups).map((g) => g[0].file), ['src/high-0.js', 'src/high-1.js'])
  })
})
