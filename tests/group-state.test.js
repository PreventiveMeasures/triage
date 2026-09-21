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
// triage-menu click applies, and whether it sets or clears),
// `syncGroupTriage` (levelling a group whose tabs agree but only some
// carry the bucket), and `canApplyFixToGroup` / `fixApplies` (whether
// a fix link edited on one tab may be offered to — and written to —
// the rest).

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
  activeTabFor, canApplyFixToGroup, canTriageFinding, fixApplies, getMergedGroups, groupState, groupTabsByLevel, groupWithPassRows, isIgnored,
  primaryTab, scopedTriage, sortTabs, syncGroupTriage, tabHasMarks, tabTriage, triageActionPlan, triageEntry, triageScope, triageTabs,
} = await import('../ui/view/group.js')

const REPORT = 'report-a.json'

describe('tab levels', () => {
  it('groups external producers and DeepView revalidations ahead of source findings', () => {
    const source = { id: 'source', isApp: false }
    const codex = { id: 'codex', isApp: true }
    const confirmed = { id: 'confirmed', isApp: false }
    const pass = { id: 'pass', isApp: true }
    const claude = { id: 'claude', isApp: true }
    const tabs = [source, codex, confirmed, pass, claude]
    assert.deepEqual(groupTabsByLevel(tabs), { app: [codex, pass, claude], source: [source, confirmed] })
    assert.deepEqual(tabs, [source, codex, confirmed, pass, claude])
  })

  it('leaves one level empty when only app or source findings are present', () => {
    const app = [{ isApp: true }, { isApp: true }, { isApp: true }]
    const source = [{ isApp: false }, { isApp: false }, { isApp: false }]
    assert.deepEqual(groupTabsByLevel(app), { app, source: [] })
    assert.deepEqual(groupTabsByLevel(source), { app: [], source })
  })
})

let nextId = 0
// One finding (= one tab). `ann` carries the triage-entry fields to
// install in state.triage for it: { color?, triage?, fix?, ignored? }
// — `ignored: true` writes the per-report ignoredReports list keyed to
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
    if (ann.fix) entry.fix = ann.fix
    if (ann.comment) entry.comment = ann.comment
    if (ann.flagged) entry.flagged = ann.flagged
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
  state.reports = []
  state.workspaceMerges = []
  // The App lens defaults on, i.e. the pass's own rows are part of
  // every group (see withoutPassRows).
  state.showRevalidation = true
  // …and the upstream lens defaults off, i.e. groups arrive whole.
  state.upstreamOnly = false
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

// The tab strip shows a tab's own state only when the group can't
// speak for it. `commonTriage` is that test — null exactly when the
// card has nothing to display (buckets disagree, or a color conflict
// suppressed the rollup) — and `allIgnored` is the stricter one the
// per-report ignore glyph needs, since levelling never touches ignore.
describe('groupState — what the tab glyphs key off', () => {
  it('speaks for the group while the tabs agree, even partially', () => {
    reset()
    assert.equal(groupState([tab({ triage: 'inprogress' }), tab(null)]).commonTriage, 'inprogress')
    assert.equal(groupState([tab({ triage: 'fixed' }), tab({ triage: 'fixed' })]).commonTriage, 'fixed')
  })

  it('speaks for nothing when a color conflict suppresses the rollup', () => {
    // The card files this group with the untriaged ones and stamps no
    // state class, so the tabs are the only place its Fixed can show.
    reset()
    const st = groupState([tab({ color: 'green', triage: 'fixed' }), tab({ color: 'red', triage: 'fixed' })])
    assert.equal(st.hasConflict, true)
    assert.equal(st.commonTriage, null, 'nothing for the card to display')
  })

  it('marks allIgnored only when every tab is ignored', () => {
    reset()
    assert.equal(groupState([tab({ ignored: true }), tab({ ignored: true })]).allIgnored, true)
    reset()
    // Rolls up to 'ignored' off one tab while its sibling is live in
    // its own report — the case the 👁 has to keep pointing at.
    const partial = groupState([tab({ ignored: true }), tab(null)])
    assert.equal(partial.commonTriage, 'ignored')
    assert.equal(partial.allIgnored, false)
    reset()
    assert.equal(groupState([tab({ triage: 'fixed' }), tab({ triage: 'fixed' })]).allIgnored, false)
  })
})

describe('scopedTriage', () => {
  it('is the rollup for an agreeing group, the active tab for a conflicted one', () => {
    reset()
    assert.equal(scopedTriage([tab({ triage: 'fixed' }), tab(null)]), 'fixed')
    reset()
    const a = tab({ triage: 'inprogress' }, { severity: 'high', confidence: 9 })
    const b = tab({ triage: 'fixed' }, { severity: 'low', confidence: 1 })
    assert.equal(scopedTriage([a, b]), 'inprogress', 'active tab wins under conflict')
    state.activeTabByGroup.set(a.id, b.id)
    assert.equal(scopedTriage([a, b]), 'fixed')
  })

  it('normalises "no state" to null from either branch', () => {
    reset()
    assert.equal(scopedTriage([tab(null), tab(null)]), null)
    reset()
    // Conflicted on color, active tab untriaged — the branch that
    // reads through tabTriage, which answers undefined.
    const a = tab({ color: 'red' }, { severity: 'high', confidence: 9 })
    const b = tab({ color: 'green' }, { severity: 'low', confidence: 1 })
    assert.equal(scopedTriage([a, b]), null)
  })
})

// A group can hold the app's own finding and the upstream code under
// it (`isUpstream`, stamped per finding). The two are different
// claims, so a group-level verdict is decided by — and lands on — the
// app's own members alone.
describe('upstream members keep out of the group verdict', () => {
  const upstream = (ann = null) => tab(ann, { isUpstream: true })

  it('leaves them out of the set a group speaks for', () => {
    reset()
    const dep = upstream(), own = tab(null)
    assert.deepEqual(triageTabs([own, dep]), [own])
  })

  it('keeps the group itself when there is nothing to drop', () => {
    reset()
    const plain = [tab(null), tab(null)]
    assert.equal(triageTabs(plain), plain, 'no upstream members — same array back')
    const allDeps = [upstream(), upstream()]
    assert.equal(triageTabs(allDeps), allDeps, 'nothing but upstream — they are what the card is')
    assert.deepEqual(triageTabs(null), [])
  })

  it('does not extend a group write to them', () => {
    reset()
    const dep = upstream(), own = tab(null)
    // The scope a menu click and a kanban drop both apply to.
    assert.deepEqual(triageScope([own, dep]), [own])
    assert.deepEqual(triageActionPlan([own, dep], 'fixed').targets, [own])
  })

  it('writes to an upstream finding when it is the whole group in upstream view', () => {
    reset()
    state.upstreamOnly = true
    const deps = [upstream(), upstream()]
    assert.deepEqual(triageScope(deps), deps, 'otherwise they could never be triaged at all')
  })

  it('only reads and writes upstream status outside App view or inside upstream view', () => {
    for (const appOn of [true, false]) {
      for (const upstreamOn of [true, false]) {
        for (const status of ['inprogress', 'fixed', 'invalid', 'deleted', 'ignored']) {
          reset()
          state.showRevalidation = appOn
          state.upstreamOnly = upstreamOn
          const allowed = !appOn || upstreamOn
          const dep = upstream(status === 'ignored' ? { ignored: true } : { triage: status })
          const saved = { ...state.triage.get(dep.id) }
          assert.equal(canTriageFinding(dep), allowed)
          assert.equal(tabTriage(dep), allowed ? status : undefined)
          assert.equal(isIgnored(dep), allowed && status === 'ignored')
          assert.equal(groupState([dep]).commonTriage, allowed ? status : null)
          assert.equal(scopedTriage([dep]), allowed ? status : null)
          assert.equal(groupState([dep]).anyTriage, allowed && status !== 'ignored')
          for (const action of ['inprogress', 'fixed', 'invalid', 'deleted', 'ignored', 'restore']) {
            assert.deepEqual(triageActionPlan([dep], action).targets, allowed ? [dep] : [])
          }
          assert.deepEqual(state.triage.get(dep.id), saved, 'mode changes preserve the saved status')
        }
      }
    }
  })

  it('allows dependency triage when the loaded report has no App layer', () => {
    reset()
    const dep = upstream({ triage: 'fixed' })
    state.reports = [{ groups: [[dep]] }]
    state.showRevalidation = true
    assert.equal(canTriageFinding(dep), true)
    assert.equal(tabTriage(dep), 'fixed')
    assert.deepEqual(triageScope([dep]), [dep])
  })

  it('keeps dependency triage restricted when the App layer is available', () => {
    reset()
    const dep = tab({ triage: 'fixed' }, { isUpstream: true, revalidate: 'confirmed' })
    state.reports = [{ groups: [[dep]] }]
    state.showRevalidation = true
    assert.equal(canTriageFinding(dep), false)
    assert.equal(tabTriage(dep), undefined)
    assert.deepEqual(triageScope([dep]), [])
  })

  it('cannot bypass the App guard through a conflicted row or automatic levelling', () => {
    reset()
    const dep = upstream({ triage: 'fixed' })
    const blank = upstream()
    const ownA = tab({ color: 'red' }), ownB = tab({ color: 'blue' })
    const group = [ownA, ownB, dep]
    state.activeTabByGroup.set(ownA.id, dep.id)
    assert.equal(groupState(group).hasConflict, true)
    assert.deepEqual(triageScope(group), [], 'an active upstream tab cannot receive a conflict action')
    assert.equal(syncGroupTriage([dep, blank]), false)
    assert.equal(state.triage.has(blank.id), false)
    state.upstreamOnly = true
    assert.equal(syncGroupTriage([dep, blank]), true)
    assert.equal(tabTriage(blank), 'fixed')
  })

  it('ignores all upstream annotations in App view and restores them in the other lenses', () => {
    reset()
    const dep = upstream({ color: 'red', comment: 'Upstream note', fix: 'upstream fix', flagged: true })
    const own = tab(null)
    const saved = { ...state.triage.get(dep.id) }
    const group = [own, dep]
    for (const [appOn, upstreamOn] of [[true, false], [true, true], [false, false], [false, true], [true, false]]) {
      state.showRevalidation = appOn
      state.upstreamOnly = upstreamOn
      const allowed = !appOn || upstreamOn
      assert.deepEqual(triageEntry(dep), allowed ? saved : undefined)
      assert.equal(groupState([dep]).commonColor, allowed ? 'red' : null)
      assert.equal(tabHasMarks(dep), allowed)
      assert.equal(sortTabs(group)[0], allowed ? dep : own)
      assert.equal(activeTabFor(group), allowed ? dep : own)
      assert.deepEqual(state.triage.get(dep.id), saved)
    }
  })

  it('offers group fix links only for eligible siblings and never targets a restricted dependency', () => {
    reset()
    const app = tab({ fix: 'app fix' }, { isApp: true })
    const own = tab(null)
    const dep = upstream({ fix: 'different upstream fix' })
    assert.equal(canApplyFixToGroup([app, dep], 'app fix'), false)
    assert.equal(canApplyFixToGroup([app, own, dep], 'app fix'), true)
    assert.deepEqual([app, own, dep].filter((f) => fixApplies(f, 'app fix')), [app, own])
    assert.equal(fixApplies(dep, 'different upstream fix'), false)
    state.upstreamOnly = true
    assert.equal(fixApplies(dep, 'different upstream fix'), true)
    assert.equal(canApplyFixToGroup([app, own, dep], 'app fix'), false, 'eligible siblings keep their distinct links')
  })

  it('reads the verdict off the app-side members only', () => {
    reset()
    // The dependency was marked fixed on its own; the app's finding is
    // still live, and the card is still live with it.
    const group = [tab(null), upstream({ triage: 'fixed' })]
    assert.equal(groupState(group).commonTriage, null)
    assert.equal(groupState(group).anyTriage, false)
    reset()
    // …and the other way: the app's answer stands whatever the
    // dependency underneath says, with no conflict between them.
    const mixed = [tab({ triage: 'fixed' }), upstream({ triage: 'inprogress' })]
    const st = groupState(mixed)
    assert.equal(st.hasConflict, false)
    assert.equal(st.commonTriage, 'fixed')
  })

  it('ignores their colors in the rollup too', () => {
    reset()
    const group = [tab({ color: 'green' }), upstream({ color: 'blue' })]
    const st = groupState(group)
    assert.equal(st.hasConflict, false, 'a dependency\u2019s mark is not a disagreement')
    assert.equal(st.commonColor, 'green')
  })

  it('does not level the agreed bucket onto them', () => {
    reset()
    const bare = tab(null), dep = upstream(), own = tab({ triage: 'fixed' })
    assert.equal(syncGroupTriage([own, bare, dep]), true)
    assert.equal(tabTriage(bare), 'fixed')
    assert.equal(tabTriage(dep), undefined, 'the dependency was never party to the verdict')
  })

  it('has nothing to level when the app side is a single finding', () => {
    reset()
    const group = [tab({ triage: 'fixed' }), upstream(), upstream()]
    assert.equal(syncGroupTriage(group), false)
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
    assert.deepEqual(group.map((f) => tabTriage(f)), ['inprogress', 'inprogress', 'inprogress', 'inprogress'])
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
    assert.deepEqual(group.map((f) => tabTriage(f)), ['inprogress', 'fixed', undefined])
  })

  it('never propagates the per-report ignore flag', () => {
    // Ignore is a decision about one finding in one report, not a
    // verdict on the group, and it lives in its own store.
    reset()
    const group = [tab({ ignored: true }), tab(null)]
    assert.equal(groupState(group).commonTriage, 'ignored')
    assert.equal(syncGroupTriage(group), false)
    assert.deepEqual(group.map((f) => tabTriage(f)), ['ignored', undefined])
  })

  it('leaves a tab holding an ignore for another report alone', () => {
    // Its entry reads as unannotated here (isIgnored is per-report),
    // but triage and ignoredReports are mutually exclusive on an entry
    // and the load path resolves a violation by dropping the ignore —
    // so levelling this tab would destroy an ignore set elsewhere.
    reset()
    const elsewhere = tab(null)
    state.triage.set(elsewhere.id, { ignoredReports: ['other-report.json'] })
    const group = [tab({ triage: 'fixed' }), elsewhere]
    assert.equal(syncGroupTriage(group), false, 'nothing written')
    assert.equal(state.triage.get(elsewhere.id).triage, undefined)
    assert.deepEqual(state.triage.get(elsewhere.id).ignoredReports, ['other-report.json'])
  })

  it('levels the tabs it can even when a sibling holds a foreign ignore', () => {
    reset()
    const elsewhere = tab(null)
    state.triage.set(elsewhere.id, { ignoredReports: ['other-report.json'] })
    const group = [tab({ triage: 'fixed' }), tab(null), elsewhere]
    assert.equal(syncGroupTriage(group), true)
    assert.deepEqual(group.map((f) => state.triage.get(f.id)?.triage), ['fixed', 'fixed', undefined])
  })

  it('does not persist — the caller owns that', () => {
    // saveTriage serializes the whole map; callers defer it past the
    // render so opening a finding can't stall on it.
    reset()
    const group = [tab({ triage: 'fixed' }), tab(null)]
    assert.equal(syncGroupTriage(group), true)
    assert.equal(localStorage.getItem('deepview.triage'), null, 'no storage write')
    assert.equal(localStorage.getItem('deepview.triage.pending'), null)
  })

  it('does nothing for an untriaged or single-tab group', () => {
    reset()
    assert.equal(syncGroupTriage([tab(null), tab(null)]), false)
    assert.equal(syncGroupTriage([tab({ triage: 'fixed' })]), false, 'nothing to agree with')
    assert.equal(syncGroupTriage(null), false)
  })
})

// The fix-link dialog offers "Apply to whole group" on this test. A
// fix link names one specific PR or commit, so the offer is only safe
// where no sibling holds a different one.
describe('canApplyFixToGroup', () => {
  const PR = 'https://github.com/o/r/pull/1'

  it('offers the group when the siblings carry nothing yet', () => {
    reset()
    assert.equal(canApplyFixToGroup([tab(null), tab(null)], ''), true)
  })

  it('offers it when every tab already carries the link being edited', () => {
    reset()
    assert.equal(canApplyFixToGroup([tab({ fix: PR }), tab({ fix: PR })], PR), true)
    reset()
    assert.equal(canApplyFixToGroup([tab({ fix: PR }), tab(null), tab(null)], PR), true,
      'a mix of carriers and bare siblings still agrees')
  })

  it('withholds it when a sibling holds a different link', () => {
    reset()
    const other = 'https://github.com/o/r/pull/2'
    assert.equal(canApplyFixToGroup([tab({ fix: PR }), tab({ fix: other })], PR), false)
  })

  it('reads through surrounding whitespace on either side', () => {
    // The dialog writes trimmed values, but sync peers and imports
    // store whatever they were handed — a stray space must not read as
    // a different link and withhold the offer from an agreeing group.
    reset()
    assert.equal(canApplyFixToGroup([tab({ fix: `${PR} ` }), tab({ fix: PR })], PR), true)
    reset()
    assert.equal(canApplyFixToGroup([tab({ fix: PR }), tab(null)], `  ${PR}  `), true)
  })

  it('never offers it for a single-tab group', () => {
    reset()
    assert.equal(canApplyFixToGroup([tab(null)], ''), false)
    assert.equal(canApplyFixToGroup([], ''), false)
    assert.equal(canApplyFixToGroup(null, ''), false)
  })

  it('ignores the other annotations on a tab', () => {
    // Colors, triage and comments say nothing about where the fix
    // lives — only a differing fix link withholds the offer.
    reset()
    const group = [tab({ fix: PR, triage: 'fixed', color: 'green' }), tab({ color: 'red' })]
    assert.equal(canApplyFixToGroup(group, PR), true)
  })

  it('re-asks per tab, for the write that happens after the dialog', () => {
    // The offer is granted before the dialog opens; a sync peer or
    // another browser tab can land a link on a sibling while it is up,
    // and that sibling must then be left alone.
    reset()
    const bare = tab(null)
    const landed = tab({ fix: 'https://github.com/o/r/pull/9' })
    assert.equal(fixApplies(bare, PR), true)
    assert.equal(fixApplies(landed, PR), false, 'a link that arrived meanwhile is not ours to move')
    assert.equal(fixApplies(tab({ fix: `${PR} ` }), PR), true, 'trimmed on both sides here too')
  })
})

// The upstream lens (`state.upstreamOnly`) — the one control that
// reaches INSIDE a group rather than choosing between groups. With it
// on, the list is the dependencies' own code: a group keeps only its
// upstream members, one holding none is gone, and the verdict is then
// read off and written to the rows that are left.
describe('the upstream lens', () => {
  const upstream = (ann = null) => tab(ann, { isUpstream: true })
  const load = (...groups) => { state.reports = [{ fileName: 'r.json', groups }] }

  it('keeps only the upstream members of a group', () => {
    reset()
    const app = tab(null), dep0 = upstream(), dep1 = upstream(), own = tab(null)
    load([app, own, dep0, dep1])
    assert.deepEqual(getMergedGroups()[0].map((f) => f.id), [app.id, own.id, dep0.id, dep1.id])
    state.upstreamOnly = true
    assert.deepEqual(getMergedGroups()[0].map((f) => f.id), [dep0.id, dep1.id])
  })

  it('drops a group with nothing upstream in it', () => {
    reset()
    const dep = upstream()
    load([tab(null), tab(null)], [tab(null), dep])
    state.upstreamOnly = true
    const shown = getMergedGroups()
    assert.equal(shown.length, 1)
    assert.deepEqual(shown[0].map((f) => f.id), [dep.id])
  })

  it('hands back the group itself when every member is upstream', () => {
    reset()
    const deps = [upstream(), upstream()]
    load(deps)
    state.upstreamOnly = true
    assert.equal(getMergedGroups()[0], deps, 'nothing dropped — same array')
  })

  it('reads the verdict off the rows it left, and writes back to them', () => {
    reset()
    // The app side is fixed; the dependency underneath is not.
    const app = tab({ triage: 'fixed' }), dep = upstream()
    load([app, dep])
    assert.equal(groupState(getMergedGroups()[0]).commonTriage, 'fixed')
    state.upstreamOnly = true
    const shown = getMergedGroups()[0]
    assert.equal(groupState(shown).commonTriage, null, 'the dependency is still live')
    assert.deepEqual(triageScope(shown), shown, 'and a drop here lands on it')
  })

  it('can turn a settled row into a conflicted one', () => {
    reset()
    // The app side agrees. The two upstream rows under it do not — a
    // disagreement the app-side verdict was speaking over.
    const app = tab({ triage: 'fixed' }), own = tab({ triage: 'fixed' })
    const dep0 = upstream({ triage: 'fixed' }), dep1 = upstream({ triage: 'invalid' })
    load([app, own, dep0, dep1])
    assert.equal(groupState(getMergedGroups()[0]).hasConflict, false)
    state.upstreamOnly = true
    const shown = getMergedGroups()[0]
    const st = groupState(shown)
    assert.equal(st.hasConflict, true)
    assert.equal(st.commonTriage, null)
    // Resolvable the usual way: narrowed to the active tab, which under
    // this lens is one of the upstream rows.
    assert.deepEqual(triageScope(shown, st), [activeTabFor(shown)])
    assert.equal(shown.includes(activeTabFor(shown)), true)
  })

  it('is off by default and leaves the list alone', () => {
    reset()
    const group = [tab(null), upstream()]
    load(group)
    assert.equal(state.upstreamOnly, false)
    assert.equal(getMergedGroups()[0], group)
  })
})

// The App switch (`state.showRevalidation`) takes the revalidation
// layer off, and `getMergedGroups` drops the rows that ARE the pass
// from every group the UI renders. They are still the same issue,
// re-rated — the PR that fixes the base finding fixes them too — so a
// whole-group annotation has to keep seeing them.
describe('groupWithPassRows', () => {
  const PR = 'https://github.com/o/r/pull/1'

  // Seed a group as a loaded report, which is where getMergedGroups
  // reads from; the returned array is the group as the data has it.
  function loadGroup(...members) {
    state.reports = [{ fileName: 'r.json', groups: [members] }]
    return members
  }

  it('is the group itself while the lens is on', () => {
    reset()
    const group = loadGroup(tab(null), tab(null, { revalidate: 'revalidation' }))
    assert.equal(groupWithPassRows(group), group)
    assert.equal(getMergedGroups()[0].length, 2, 'and the pass row is rendered')
  })

  it('adds back the pass rows the lens dropped', () => {
    reset()
    const base = tab(null)
    const pass = tab(null, { revalidate: 'revalidation' })
    loadGroup(base, pass)
    state.showRevalidation = false
    const rendered = getMergedGroups()[0]
    assert.deepEqual(rendered.map((f) => f.id), [base.id], 'the pass row is off screen')
    assert.deepEqual(groupWithPassRows(rendered).map((f) => f.id), [base.id, pass.id])
  })

  it('withholds the offer when a hidden pass row holds a different link', () => {
    reset()
    const base = tab({ fix: PR })
    const pass = tab({ fix: 'https://github.com/o/r/pull/2' }, { revalidate: 'revalidation' })
    loadGroup(base, pass)
    state.showRevalidation = false
    const rendered = getMergedGroups()[0]
    // The rendered group is down to one tab, so it could never have
    // offered anything; the group as the data has it is what must
    // withhold, and it does — the pass row points somewhere else.
    assert.equal(canApplyFixToGroup(groupWithPassRows(rendered), PR), false)
  })

  it('offers — and reaches — a hidden pass row that agrees', () => {
    reset()
    const base = tab({ fix: PR })
    const pass = tab(null, { revalidate: 'revalidation' })
    loadGroup(base, pass)
    state.showRevalidation = false
    const whole = groupWithPassRows(getMergedGroups()[0])
    assert.equal(canApplyFixToGroup(whole, PR), true)
    assert.deepEqual(whole.filter((f) => fixApplies(f, PR)).map((f) => f.id), [base.id, pass.id],
      'the write reaches the row the lens hides')
  })

  it('leaves a group alone when nothing was dropped from it', () => {
    reset()
    loadGroup(tab(null), tab(null))
    state.showRevalidation = false
    const rendered = getMergedGroups()[0]
    assert.equal(groupWithPassRows(rendered), rendered, 'same array, no rebuild')
  })

  it('falls back to the given group when it is not a loaded one', () => {
    // Defensive: a caller holding a group the reports no longer carry
    // (a stale gid, a synthetic list) gets its argument back.
    reset()
    state.showRevalidation = false
    const orphan = [tab(null), tab(null)]
    assert.equal(groupWithPassRows(orphan), orphan)
  })
})
