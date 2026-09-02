// `ui/view/group.js` — groupState's group-level triage rollup, plus
// the single-tab fast paths on sortTabs / primaryTab / activeTabFor.
//
// groupState was rewritten from a Set-based pass to a single
// allocation-free pass (first-seen + conflict flags); these tables
// pin the rollup semantics the rewrite must preserve, including the
// doc-comment examples on the function itself:
//   - unannotated tabs are neutral (never conflict on their own)
//   - a colored-only tab occupies its own bucket slot, so it
//     conflicts with a bucket-bearing sibling (deleted-vs-not)
//   - two distinct non-null colors conflict; color-only vs no-color
//     does not
//   - ignore behaves as its own bucket: it rolls up to
//     commonTriage 'ignored' but never counts toward anyTriage /
//     allTriaged
//   - empty-annotation groups: no conflict, no color, no bucket
//
// Plus the write side the rollup drives: `triageActionPlan` (what a
// triage-menu click applies, and whether it sets or clears) and
// `syncGroupTriage` (levelling a group whose tabs agree but only some
// carry the bucket).

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import './_polyfills.js'

// `ui/view/group.js` reaches `./format.js` → `./frontend-global.js`,
// which throws at module-load when the `@rray/frontend` slot isn't
// installed (production: view.js installs lit + StateElement at
// boot). Tests don't run that boot path, so install a stub before
// the import chain evaluates — none of the symbols are called by
// the helpers under test, the stub just lets the module load.
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
  activeTabFor, groupState, primaryTab, sortTabs, syncGroupTriage, tabTriage, triageActionPlan,
} = await import('../ui/view/group.js')

const REPORT = 'report-a.json'

let nextId = 0
// One finding (= one tab). `ann` carries the triage-entry fields to
// install in state.triage for it: { color?, triage?, ignored? } —
// `ignored: true` writes the per-report ignoredReports list keyed to
// this finding's `_reportName`.
function tab(ann = null, extra = {}) {
  const f = {
    id: `t${nextId++}`,
    severity: 'high',
    file: 'src/a.js',
    line: '1',
    description: 'finding',
    _reportName: REPORT,
    ...extra,
  }
  if (ann) {
    const entry = {}
    if (ann.color) entry.color = ann.color
    if (ann.triage) entry.triage = ann.triage
    if (ann.ignored) entry.ignoredReports = [REPORT]
    state.triage.set(f.id, entry)
  }
  return f
}

function reset() {
  state.triage.clear()
  state.activeTabByGroup.clear()
  state.filterAnalyzer = ''
  state.filterModel = ''
}

// Each case: name, tab annotations (null = unannotated), expected
// rollup fields. Mirrors + extends the examples in groupState's doc
// comment (A/B/C are tabs in one dedup group).
const CASES = [
  {
    name: 'all tabs unannotated → neutral rollup',
    tabs: [null, null, null],
    expect: { hasConflict: false, commonColor: null, commonTriage: null, anyTriage: false, allTriaged: false },
  },
  {
    name: 'single colored tab → common color, still live',
    tabs: [{ color: 'green' }],
    expect: { hasConflict: false, commonColor: 'green', commonTriage: null, anyTriage: false, allTriaged: false },
  },
  {
    name: 'A(green, deleted), B(), C() → no conflict, deleted',
    tabs: [{ color: 'green', triage: 'deleted' }, null, null],
    expect: { hasConflict: false, commonColor: 'green', commonTriage: 'deleted', anyTriage: true, allTriaged: true },
  },
  {
    name: 'A(green, deleted), B(deleted), C() → no conflict, deleted',
    tabs: [{ color: 'green', triage: 'deleted' }, { triage: 'deleted' }, null],
    expect: { hasConflict: false, commonColor: 'green', commonTriage: 'deleted', anyTriage: true, allTriaged: true },
  },
  {
    name: 'A(green, deleted), B(red) → conflict (colors disagree)',
    tabs: [{ color: 'green', triage: 'deleted' }, { color: 'red' }],
    expect: { hasConflict: true, commonColor: null, commonTriage: null },
  },
  {
    name: 'A(green), B(blue) → conflict (colors disagree)',
    tabs: [{ color: 'green' }, { color: 'blue' }],
    expect: { hasConflict: true, commonColor: null, commonTriage: null },
  },
  {
    name: 'A(green, deleted), B(green) → conflict (deleted vs annotated-undeleted)',
    tabs: [{ color: 'green', triage: 'deleted' }, { color: 'green' }],
    expect: { hasConflict: true, commonColor: null, commonTriage: null },
  },
  {
    name: 'A(green, fixed), B(green, deleted) → conflict (buckets disagree)',
    tabs: [{ color: 'green', triage: 'fixed' }, { color: 'green', triage: 'deleted' }],
    expect: { hasConflict: true, commonColor: null, commonTriage: null },
  },
  {
    name: 'color-only tab never conflicts with an unannotated sibling',
    tabs: [{ color: 'red' }, null],
    expect: { hasConflict: false, commonColor: 'red', commonTriage: null, anyTriage: false, allTriaged: false },
  },
  {
    name: 'bucket-only consensus without colors',
    tabs: [{ triage: 'fixed' }, { triage: 'fixed' }],
    expect: { hasConflict: false, commonColor: null, commonTriage: 'fixed', anyTriage: true, allTriaged: true },
  },
  {
    name: 'ignored tab rolls up as its own bucket (not anyTriage / allTriaged)',
    tabs: [{ ignored: true }],
    expect: { hasConflict: false, commonColor: null, commonTriage: 'ignored', anyTriage: false, allTriaged: false },
  },
  {
    name: 'explicit triage beats the ignore list on the same tab',
    tabs: [{ triage: 'invalid', ignored: true }],
    expect: { hasConflict: false, commonColor: null, commonTriage: 'invalid', anyTriage: true, allTriaged: true },
  },
  {
    name: 'inprogress vs ignored siblings → conflict (buckets disagree)',
    tabs: [{ triage: 'inprogress' }, { ignored: true }],
    expect: { hasConflict: true, commonColor: null, commonTriage: null },
  },
]

describe('groupState rollup', () => {
  for (const c of CASES) {
    it(c.name, () => {
      reset()
      const group = c.tabs.map((ann) => tab(ann))
      const st = groupState(group)
      for (const [k, v] of Object.entries(c.expect)) {
        assert.equal(st[k], v, `${k}: expected ${v}, got ${st[k]}`)
      }
      // Convenience flags must track commonTriage exactly.
      assert.equal(st.isDeleted, st.commonTriage === 'deleted')
      assert.equal(st.isFixed, st.commonTriage === 'fixed')
      assert.equal(st.isInvalid, st.commonTriage === 'invalid')
      assert.equal(st.isInProgress, st.commonTriage === 'inprogress')
      assert.equal(st.isIgnored, st.commonTriage === 'ignored')
    })
  }
})

describe('single-tab fast paths', () => {
  it('sortTabs / primaryTab / activeTabFor resolve to the lone member', () => {
    reset()
    const f = tab({ color: 'blue', triage: 'fixed' })
    const group = [f]
    assert.deepEqual(sortTabs(group), [f])
    assert.equal(primaryTab(group), f)
    assert.equal(activeTabFor(group), f)
  })

  it('multi-tab sortTabs orders colored first, then severity, then confidence', () => {
    reset()
    const low = tab(null, { severity: 'low', confidence: 9 })
    const highA = tab(null, { severity: 'high', confidence: 3 })
    const highB = tab(null, { severity: 'high', confidence: 8 })
    const coloredLow = tab({ color: 'red' }, { severity: 'informational', confidence: 1 })
    const group = [low, highA, highB, coloredLow]
    const sorted = sortTabs(group)
    assert.deepEqual(sorted.map((f) => f.id), [coloredLow.id, highB.id, highA.id, low.id])
    // Input order untouched; primary is the sort head.
    assert.deepEqual(group.map((f) => f.id), [low.id, highA.id, highB.id, coloredLow.id])
    assert.equal(primaryTab(group), coloredLow)
  })

  it('activeTabFor honors a stored pick on multi-tab groups', () => {
    reset()
    const a = tab(null, { severity: 'high', confidence: 9 })
    const b = tab(null, { severity: 'low', confidence: 1 })
    const group = [a, b]
    assert.equal(activeTabFor(group), a)
    state.activeTabByGroup.set(a.id, b.id)
    assert.equal(activeTabFor(group), b)
  })
})

// `triageConflict` is the bucket axis of `hasConflict` on its own —
// the flag the per-tab state glyphs render on, so a group whose tabs
// merely differ in COLOR doesn't sprout `◐` / `✓` / `⊘` on every tab.
describe('groupState triageConflict', () => {
  it('is false while the tabs agree, whatever colors they carry', () => {
    reset()
    assert.equal(groupState([tab({ triage: 'inprogress' }), tab(null)]).triageConflict, false)
    assert.equal(groupState([tab({ triage: 'fixed' }), tab({ triage: 'fixed' })]).triageConflict, false)
    reset()
    const colorsDiffer = [tab({ color: 'green', triage: 'fixed' }), tab({ color: 'red', triage: 'fixed' })]
    const st = groupState(colorsDiffer)
    assert.equal(st.hasConflict, true, 'colors still conflict')
    assert.equal(st.triageConflict, false, 'but the buckets agree')
  })

  it('is true when the buckets disagree', () => {
    reset()
    assert.equal(groupState([tab({ triage: 'inprogress' }), tab({ triage: 'fixed' })]).triageConflict, true)
    // A colored-but-untriaged tab holds its own bucket slot.
    assert.equal(groupState([tab({ triage: 'fixed' }), tab({ color: 'red' })]).triageConflict, true)
    // Ignore is a bucket like any other.
    assert.equal(groupState([tab({ triage: 'fixed' }), tab({ ignored: true })]).triageConflict, true)
  })
})

describe('triageActionPlan', () => {
  it('clears when the group already shows the clicked state — even on one tab', () => {
    // The regression: a group holding 'inprogress' on ONE of four tabs
    // still READS as in progress, so clicking In progress again has to
    // switch the group off. Deciding per tab instead flipped the state
    // onto the other three (0010 → 1101) and back on the next click.
    reset()
    const group = [tab(null), tab(null), tab({ triage: 'inprogress' }), tab(null)]
    const plan = triageActionPlan(group, 'inprogress')
    assert.equal(plan.clearing, true)
    assert.deepEqual(plan.targets, group, 'and it applies to every tab, not just the marked one')
  })

  it('clears when every tab already carries the state', () => {
    reset()
    const group = [tab({ triage: 'fixed' }), tab({ triage: 'fixed' })]
    assert.equal(triageActionPlan(group, 'fixed').clearing, true)
  })

  it('sets when the group carries no state, or a different one', () => {
    reset()
    const bare = [tab(null), tab(null)]
    const barePlan = triageActionPlan(bare, 'inprogress')
    assert.equal(barePlan.clearing, false)
    assert.deepEqual(barePlan.targets, bare)
    reset()
    const fixed = [tab({ triage: 'fixed' }), tab(null)]
    assert.equal(triageActionPlan(fixed, 'inprogress').clearing, false)
  })

  it('treats ignore as a state like any other', () => {
    reset()
    const ignored = [tab({ ignored: true }), tab({ ignored: true })]
    assert.equal(triageActionPlan(ignored, 'ignored').clearing, true, 're-click un-ignores')
    reset()
    const live = [tab(null), tab(null)]
    assert.equal(triageActionPlan(live, 'ignored').clearing, false)
  })

  it('always clears for restore', () => {
    reset()
    assert.equal(triageActionPlan([tab({ triage: 'deleted' }), tab(null)], 'restore').clearing, true)
    assert.equal(triageActionPlan([tab(null), tab(null)], 'restore').clearing, true)
  })

  it('narrows a conflicted group to the active tab and reads its state', () => {
    reset()
    const a = tab({ triage: 'inprogress' }, { severity: 'high', confidence: 9 })
    const b = tab({ triage: 'fixed' }, { severity: 'low', confidence: 1 })
    const group = [a, b]
    const plan = triageActionPlan(group, 'inprogress')
    assert.deepEqual(plan.targets, [activeTabFor(group)], 'scope is the active tab alone')
    assert.equal(plan.clearing, true, 'active tab holds inprogress')
    assert.equal(triageActionPlan(group, 'fixed').clearing, false, 'a different state sets instead')
    // Switching the active tab switches which state a re-click clears.
    state.activeTabByGroup.set(a.id, b.id)
    assert.equal(triageActionPlan(group, 'inprogress').clearing, false)
    assert.equal(triageActionPlan(group, 'fixed').clearing, true)
  })
})

describe('syncGroupTriage', () => {
  it('writes the agreed bucket onto the tabs that carry none', () => {
    reset()
    const group = [tab(null), tab(null), tab({ triage: 'inprogress' }), tab(null)]
    assert.equal(syncGroupTriage(group), true)
    assert.deepEqual(group.map(tabTriage), ['inprogress', 'inprogress', 'inprogress', 'inprogress'])
    assert.equal(groupState(group).commonTriage, 'inprogress', 'rollup unchanged — only the storage levelled')
  })

  it('keeps each tab\'s other annotations', () => {
    reset()
    const marked = tab({ color: 'red' })
    state.triage.set(marked.id, { color: 'red', comment: 'look here' })
    const group = [tab({ triage: 'deleted', color: 'red' }), marked]
    // Colored-but-untriaged is a bucket disagreement, so this group is
    // left alone entirely.
    assert.equal(syncGroupTriage(group), false)
    reset()
    const bare = tab(null)
    state.triage.set(bare.id, { comment: 'keep me' })
    const group2 = [tab({ triage: 'fixed' }), bare]
    assert.equal(syncGroupTriage(group2), true)
    assert.equal(state.triage.get(bare.id).comment, 'keep me')
    assert.equal(state.triage.get(bare.id).triage, 'fixed')
  })

  it('is a no-op for a group that already agrees', () => {
    reset()
    const group = [tab({ triage: 'fixed' }), tab({ triage: 'fixed' })]
    assert.equal(syncGroupTriage(group), false)
  })

  it('leaves a real disagreement for the user to resolve', () => {
    reset()
    const group = [tab({ triage: 'inprogress' }), tab({ triage: 'fixed' }), tab(null)]
    assert.equal(syncGroupTriage(group), false)
    assert.deepEqual(group.map(tabTriage), ['inprogress', 'fixed', undefined])
  })

  it('never propagates the per-report ignore flag', () => {
    // Ignore is a decision about one finding in one report, not a
    // verdict on the group, and it lives in its own store.
    reset()
    const group = [tab({ ignored: true }), tab(null)]
    assert.equal(groupState(group).commonTriage, 'ignored')
    assert.equal(syncGroupTriage(group), false)
    assert.deepEqual(group.map(tabTriage), ['ignored', undefined])
  })

  it('does nothing for an untriaged or single-tab group', () => {
    reset()
    assert.equal(syncGroupTriage([tab(null), tab(null)]), false)
    assert.equal(syncGroupTriage([tab({ triage: 'fixed' })]), false, 'nothing to agree with')
    assert.equal(syncGroupTriage(null), false)
  })
})
