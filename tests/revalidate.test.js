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
const { applyFilters, defaultRevalidateFilter, matchesFilters } = await import('../ui/view/filters.js')
const { getMergedGroups, sortTabs } = await import('../ui/view/group.js')
const {
  PARTIAL_MODES, REVALIDATE_FILTERS, REVALIDATE_KINDS, activeRevalidateKinds,
  configureRevalidation, formatRunMeta, hasRevalidateField, isRevalidation,
  isRevalidationRow, reachableRevalidateFilters, revalidateKind, revalidateStamp,
  revalidationShown, voidsConfidence,
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
  // confidence floor, then asks this whether the set is a revalidation
  // report — every group that floor leaves on screen carrying a row
  // the pass stamped — in which case the pass's own answer leads
  // instead of a range about how sure the original analyzer was.
  describe('the outcome a first load opens on', () => {
    const stamped = (id, extra) => makeFinding(id, { revalidate: 'confirmed', ...extra })

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
      // A refuted set with one surviving finding does open on it.
      const mixed = [
        [makeFinding('A', { confidence: 9, revalidate: 'refuted' })],
        [makeFinding('B', { confidence: 9, revalidate: 'confirmed' })],
      ]
      assert.equal(defaultRevalidateFilter(mixed, 0), 'confirmed')
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

  it('keeps the layer on by default', () => {
    assert.equal(revalidationShown(), true)
    assert.equal(revalidateKind({ revalidate: 'confirmed' }), 'confirmed')
  })
})
