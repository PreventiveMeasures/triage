// `ui/view/filters.js` — the analyzer + model dimensions of
// `matchesFilters`, behind the toolbar's `<analyzer-select>` dropdown.
// Pins three behaviors the UI depends on:
//   * each dimension filters independently (empty string = no filter,
//     control-character sentinels select the "(none)" / "(no model)"
//     buckets without colliding with literal "null" names);
//   * the model dimension matches on the PRETTY model name
//     (`modelOfFinding`), so vendor-prefixed spellings of one model
//     collapse into a single bucket;
//   * setting BOTH dimensions is a per-finding conjunction — a group
//     survives `applyFilters` only when SOME single finding carries
//     that exact analyzer+model combination, not when the analyzer
//     and the model come from different findings in the group.

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
const {
  matchesFilters, applyFilters, modelOfFinding,
  NULL_ANALYZER_SENTINEL, NULL_MODEL_SENTINEL,
} = await import('../ui/view/filters.js')
const { activeTabFor, groupKey } = await import('../ui/view/group.js')

// Neutralise every other filter so each assertion isolates the
// analyzer / model dimensions. Findings carry no confidence, so the
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
  state.activeTabByGroup = new Map()
}

function makeFinding(id, extra = {}) {
  return { id, severity: 'high', file: `src/${id}.js`, description: `desc for ${id}`, ...extra }
}

describe('matchesFilters — analyzer / model dimensions', () => {
  beforeEach(reset)

  it('analyzer filter matches _analyzer; sentinel selects the no-analyzer bucket', () => {
    const security = makeFinding('A', { _analyzer: 'security' })
    const bare = makeFinding('B', { _analyzer: null })
    state.filterAnalyzer = 'security'
    assert.equal(matchesFilters(security), true)
    assert.equal(matchesFilters(bare), false)
    state.filterAnalyzer = NULL_ANALYZER_SENTINEL
    assert.equal(matchesFilters(security), false)
    assert.equal(matchesFilters(bare), true)
  })

  it('model filter matches the pretty model name', () => {
    const opus = makeFinding('C', { model: 'claude-opus-4-7' })
    const gpt = makeFinding('D', { model: 'gpt-5.5' })
    state.filterModel = 'opus 4 7'
    assert.equal(matchesFilters(opus), true)
    assert.equal(matchesFilters(gpt), false)
    // The raw spelling must NOT match — state.filterModel stores the
    // pretty form the dropdown displays.
    state.filterModel = 'claude-opus-4-7'
    assert.equal(matchesFilters(opus), false)
  })

  it('vendor-prefixed spellings of one model land in the same bucket', () => {
    const prefixed = makeFinding('E', { model: 'anthropic/claude-opus-4-7' })
    const bare = makeFinding('F', { model: 'claude-opus-4-7' })
    assert.equal(modelOfFinding(prefixed), 'opus 4 7')
    assert.equal(modelOfFinding(bare), 'opus 4 7')
    state.filterModel = 'opus 4 7'
    assert.equal(matchesFilters(prefixed), true)
    assert.equal(matchesFilters(bare), true)
  })

  it('model sentinel selects findings with no model (and blank-string models)', () => {
    const withModel = makeFinding('G', { model: 'gpt-5.5' })
    const noModel = makeFinding('H')
    const blankModel = makeFinding('I', { model: '' })
    state.filterModel = NULL_MODEL_SENTINEL
    assert.equal(matchesFilters(withModel), false)
    assert.equal(matchesFilters(noModel), true)
    assert.equal(matchesFilters(blankModel), true)
  })

  it('empty filters pass everything through', () => {
    assert.equal(matchesFilters(makeFinding('J', { _analyzer: 'x', model: 'y' })), true)
    assert.equal(matchesFilters(makeFinding('K')), true)
  })

  it('analyzer+model combination is a per-finding conjunction', () => {
    const f = makeFinding('L', { _analyzer: 'security', model: 'claude-opus-4-7' })
    state.filterAnalyzer = 'security'
    state.filterModel = 'opus 4 7'
    assert.equal(matchesFilters(f), true)
    state.filterModel = 'gpt 5.5'
    assert.equal(matchesFilters(f), false)
  })

  it('a group survives only when one finding carries the whole combination', () => {
    // Two tabs of one dedup group: analyzer `security` ran on opus,
    // analyzer `correctness` on gpt. Filtering security+gpt must NOT
    // resurrect the group from the cross product of its tabs.
    const group = [
      makeFinding('M', { _analyzer: 'security', model: 'claude-opus-4-7' }),
      makeFinding('N', { _analyzer: 'correctness', model: 'gpt-5.5' }),
    ]
    state.filterAnalyzer = 'security'
    state.filterModel = 'opus 4 7'
    assert.equal(applyFilters([group]).length, 1)
    state.filterModel = 'gpt 5.5'
    assert.equal(applyFilters([group]).length, 0)
    // Single dimensions still match group-level via `some()`.
    state.filterAnalyzer = ''
    assert.equal(applyFilters([group]).length, 1)
  })
})

// The default-tab side of the dropdown: a dedup group stays visible
// when ANY tab matches (group-level some()), so without a preference
// the group could open on the very duplicate the user filtered away
// from. activeTabFor narrows its default-tab pool to the tabs
// matching the active analyzer/model filter — explicit user picks
// (state.activeTabByGroup) still win, and the pool falls back to the
// full strip when nothing matches.
describe('activeTabFor — analyzer / model default-tab preference', () => {
  beforeEach(reset)

  // Two duplicates of one finding: tab O from a security/opus run,
  // tab G from a correctness/gpt run. All severities equal, nothing
  // colored, so sortTabs keeps insertion order and the unfiltered
  // default is O.
  const makeGroup = () => [
    makeFinding('O', { _analyzer: 'security', model: 'claude-opus-4-7' }),
    makeFinding('G', { _analyzer: 'correctness', model: 'gpt-5.5' }),
  ]

  it('unfiltered: first sorted tab stays the default', () => {
    assert.equal(activeTabFor(makeGroup()).id, 'O')
  })

  it('analyzer filter flips the default to the first matching tab', () => {
    state.filterAnalyzer = 'correctness'
    assert.equal(activeTabFor(makeGroup()).id, 'G')
  })

  it('model filter flips the default to the first matching tab', () => {
    state.filterModel = 'gpt 5.5'
    assert.equal(activeTabFor(makeGroup()).id, 'G')
  })

  it('combination narrows per-finding (both dimensions on one tab)', () => {
    state.filterAnalyzer = 'correctness'
    state.filterModel = 'gpt 5.5'
    assert.equal(activeTabFor(makeGroup()).id, 'G')
  })

  it('falls back to the full strip when no tab matches the filter', () => {
    // Defensive: every RENDERED group passed applyFilters (which embeds
    // the same predicate), but gid-based event handlers and future
    // surfaces can resolve groups outside that path — they must never
    // strand a group without an active tab.
    state.filterAnalyzer = 'something-else'
    assert.equal(activeTabFor(makeGroup()).id, 'O')
  })

  it('sentinel buckets flip the default like named values', () => {
    state.filterModel = NULL_MODEL_SENTINEL
    const group = [
      makeFinding('O', { _analyzer: 'security', model: 'claude-opus-4-7' }),
      makeFinding('B', { _analyzer: 'security' }),
    ]
    assert.equal(activeTabFor(group).id, 'B')
    state.filterModel = ''
    state.filterAnalyzer = NULL_ANALYZER_SENTINEL
    const group2 = [
      makeFinding('O', { _analyzer: 'security' }),
      makeFinding('N', { _analyzer: null }),
    ]
    assert.equal(activeTabFor(group2).id, 'N')
  })

  it('"first matching" follows display (sortTabs) order, not insertion order', () => {
    // Two correctness tabs where the higher-severity one (B) sorts
    // ahead of the earlier-inserted low one (A) — the default must be
    // the first matching tab the STRIP shows, i.e. B.
    const group = [
      makeFinding('X', { _analyzer: 'security', severity: 'high' }),
      makeFinding('A', { _analyzer: 'correctness', severity: 'low' }),
      makeFinding('B', { _analyzer: 'correctness', severity: 'critical' }),
    ]
    state.filterAnalyzer = 'correctness'
    assert.equal(activeTabFor(group).id, 'B')
  })

  it('an explicit user selection beats the filter preference', () => {
    const group = makeGroup()
    state.activeTabByGroup.set(groupKey(group), 'O')
    state.filterAnalyzer = 'correctness'
    assert.equal(activeTabFor(group).id, 'O')
  })

  it('annotation preference applies within the matching pool only', () => {
    // P matches the filter and carries a comment — it wins over the
    // earlier matching tab G. The comment on non-matching O is
    // irrelevant: the pool already excluded it.
    const group = [
      makeFinding('O', { _analyzer: 'security' }),
      makeFinding('G', { _analyzer: 'correctness' }),
      makeFinding('P', { _analyzer: 'correctness' }),
    ]
    state.triage.set('O', { comment: 'on the non-matching tab' })
    state.triage.set('P', { comment: 'on a matching tab' })
    state.filterAnalyzer = 'correctness'
    assert.equal(activeTabFor(group).id, 'P')
  })
})
