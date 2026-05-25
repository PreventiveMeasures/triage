// `ui/view/group.js` — `getMergedGroups` walks `state.reports[*].groups`
// and applies `state.workspaceMerges` (cross-report dedup hints
// recorded by `ingestReport`) so duplicates spanning multiple loaded
// reports collapse into a single super-group in the workspace overall
// view. Per-report `state.reports[*].groups` is left intact — only
// the merged view is affected.
//
// Coverage:
//   - no merges → identity flatten across reports
//   - a single instruction unions two single-finding groups across
//     reports into one super-group, preserving first-seen order
//   - transitive chains (A=B, B=C) collapse all three into one
//     super-group via union-find
//   - an instruction that refers to ids we never saw is silently
//     dropped (no spurious empty group)
//   - `findGroupById` resolves a merged super-group by its first
//     member's key, not just the original sub-group

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// Polyfills for `localStorage` etc. — the client modules pulled in
// transitively through `state.ts` (triage.js, secure-storage.js)
// touch them at module-load time.
import './_polyfills.js'

// `ui/view/group.js` reaches `./format.js` → `./frontend-global.js`,
// which throws at module-load when the `@rray/frontend` slot isn't
// installed (production: view.js installs lit + StateElement at
// boot; lazy bundles read the slot back here). Tests don't run that
// boot path, so install a stub before the import chain evaluates —
// none of the symbols are called by `getMergedGroups` itself, the
// stub just lets the module finish loading.
const slotKey = Symbol.for('@rray/frontend')
if (!globalThis[slotKey]) {
  globalThis[slotKey] = {
    LitElement: class {}, html: () => null, nothing: null, render: () => null,
    unsafeCSS: () => null, StateElement: class {}, classMap: () => null,
    repeat: () => null, styleMap: () => null,
  }
}

const { state } = await import('../client/state.ts')
const { findGroupById, getMergedGroups, groupKey } = await import('../ui/view/group.js')

function reset() {
  state.reports.length = 0
  state.workspaceMerges.length = 0
}

function makeFinding(id) {
  return { id, severity: 'high', file: `${id}.js`, line: 1, description: `finding ${id}` }
}

describe('getMergedGroups', () => {
  it('is identity when there are no merge instructions', () => {
    reset()
    state.reports.push(
      { fileName: 'a.json', groups: [[makeFinding('A')]] },
      { fileName: 'b.json', groups: [[makeFinding('B')]] },
    )
    const merged = getMergedGroups()
    assert.equal(merged.length, 2)
    assert.deepEqual(merged.map((g) => g.map((f) => f.id)), [['A'], ['B']])
  })

  it('unions two single-finding groups from different reports, ordered by the merge instruction', () => {
    reset()
    state.reports.push(
      { fileName: 'b-rpt.json', groups: [[makeFinding('B')]] },
      { fileName: 'a-rpt.json', groups: [[makeFinding('A')]] },
    )
    // Combined entry was [A, B] — A first is the canonical order;
    // load order ([B] first) does NOT impose anything.
    state.workspaceMerges.push(new Set(['A', 'B']))
    const merged = getMergedGroups()
    assert.equal(merged.length, 1)
    assert.deepEqual(merged[0].map((f) => f.id), ['A', 'B'])
  })

  it('preserves first-seen slot for the super-group but orders members by the merge instruction', () => {
    reset()
    state.reports.push(
      { fileName: 'b-rpt.json', groups: [[makeFinding('B')]] },
      { fileName: 'x-rpt.json', groups: [[makeFinding('X')]] },
      { fileName: 'a-rpt.json', groups: [[makeFinding('A')]] },
    )
    state.workspaceMerges.push(new Set(['A', 'B']))
    const merged = getMergedGroups()
    assert.equal(merged.length, 2)
    // Super-group lands at B's slot (the first member encountered)
    // but its members are ordered [A, B] per the merge instruction.
    assert.deepEqual(merged[0].map((f) => f.id), ['A', 'B'])
    assert.deepEqual(merged[1].map((f) => f.id), ['X'])
  })

  it('chains transitive merges via union-find (A=B, B=C → all three together, in instruction order)', () => {
    reset()
    state.reports.push(
      { fileName: 'a.json', groups: [[makeFinding('A')]] },
      { fileName: 'b.json', groups: [[makeFinding('B')]] },
      { fileName: 'c.json', groups: [[makeFinding('C')]] },
    )
    state.workspaceMerges.push(new Set(['A', 'B']))
    state.workspaceMerges.push(new Set(['B', 'C']))
    const merged = getMergedGroups()
    assert.equal(merged.length, 1)
    assert.deepEqual(merged[0].map((f) => f.id), ['A', 'B', 'C'])
  })

  it('appends unmerged members of a multi-finding source group in load order, after the canonical ids', () => {
    reset()
    state.reports.push(
      { fileName: 'rpt.json', groups: [[makeFinding('X'), makeFinding('Y')]] },
      { fileName: 'a.json', groups: [[makeFinding('A')]] },
    )
    // Merge says A and Y are the same — X comes along for the ride
    // because it shares its source group with Y, but no instruction
    // named X so it tail-appends in load order.
    state.workspaceMerges.push(new Set(['A', 'Y']))
    const merged = getMergedGroups()
    assert.equal(merged.length, 1)
    assert.deepEqual(merged[0].map((f) => f.id), ['A', 'Y', 'X'])
  })

  it('silently drops instructions whose ids are not in any loaded group', () => {
    reset()
    state.reports.push({ fileName: 'a.json', groups: [[makeFinding('A')]] })
    state.workspaceMerges.push(new Set(['ghost-1', 'ghost-2']))
    const merged = getMergedGroups()
    assert.equal(merged.length, 1)
    assert.deepEqual(merged[0].map((f) => f.id), ['A'])
  })

  it('leaves per-report state.reports[*].groups untouched', () => {
    reset()
    state.reports.push(
      { fileName: 'a.json', groups: [[makeFinding('A')]] },
      { fileName: 'b.json', groups: [[makeFinding('B')]] },
    )
    state.workspaceMerges.push(new Set(['A', 'B']))
    getMergedGroups()
    assert.equal(state.reports.length, 2)
    assert.deepEqual(state.reports[0].groups.map((g) => g.map((f) => f.id)), [['A']])
    assert.deepEqual(state.reports[1].groups.map((g) => g.map((f) => f.id)), [['B']])
  })
})

// Drive state.reports + state.workspaceMerges through a STRIPPED-DOWN
// version of `ingestReport`'s entry loop — only the partition +
// merge-recording branches, not the per-finding stamping
// (`_id` / `_reportName` / `_bundleHashes` / META_FIELDS) or any of
// the DOM / triage / sync side effects. The point is to exercise the
// merge-recording logic against every load-order permutation of three
// entries `[B]`, `[A]`, `[A, B]` and confirm each one collapses to a
// single super-group ordered `[A, B]` in the workspace overall view
// via the real `getMergedGroups`. The combined entry `[A, B]` is the
// only one that carries an order, so every permutation must converge —
// both the all-dupe case (combined entry arrives after both
// singletons) and the partial-dupe case (combined entry arrives
// between them, when only one of A/B is already seen).
function buildSeenIndex() {
  const seenIds = new Set()
  const idToGroupKey = new Map()
  for (let ri = 0; ri < state.reports.length; ri++) {
    const r = state.reports[ri]
    for (let gi = 0; gi < r.groups.length; gi++) {
      const key = `${ri}:${gi}`
      for (const f of r.groups[gi]) {
        if (f.id) { seenIds.add(f.id); idToGroupKey.set(f.id, key) }
      }
    }
  }
  return { seenIds, idToGroupKey }
}

function ingestSim(entries) {
  state.reports.length = 0
  state.workspaceMerges.length = 0
  for (const memberIds of entries) {
    const { seenIds, idToGroupKey } = buildSeenIndex()
    const groups = []
    const members = memberIds.map(makeFinding)
    const seenMembers = members.filter((f) => f.id && seenIds.has(f.id))
    const newMembers = members.filter((f) => !f.id || !seenIds.has(f.id))
    const matchedGroupKeys = new Set()
    for (const f of seenMembers) {
      const k = idToGroupKey.get(f.id)
      if (k !== undefined) matchedGroupKeys.add(k)
    }
    const entryMergeIds = members.filter((f) => f.id).map((f) => f.id)
    if (newMembers.length === 0) {
      if (matchedGroupKeys.size > 1) {
        state.workspaceMerges.push(new Set(entryMergeIds))
      }
    } else {
      const newGroupKey = `${state.reports.length}:${groups.length}`
      for (const f of newMembers) {
        if (f.id) { seenIds.add(f.id); idToGroupKey.set(f.id, newGroupKey) }
      }
      if (seenMembers.length > 0) {
        state.workspaceMerges.push(new Set(entryMergeIds))
      }
      groups.push(newMembers)
    }
    state.reports.push({ fileName: `r${state.reports.length}.json`, groups })
  }
}

describe('all load orderings of [B], [A], [A,B] merge to [[A, B]]', () => {
  const permutations = [
    [['B'], ['A'], ['A', 'B']],
    [['B'], ['A', 'B'], ['A']],
    [['A', 'B'], ['B'], ['A']],
    [['A', 'B'], ['A'], ['B']],
    [['A'], ['B'], ['A', 'B']],
    [['A'], ['A', 'B'], ['B']],
  ]
  for (const order of permutations) {
    it(`load order ${JSON.stringify(order)} → [[A, B]]`, () => {
      ingestSim(order)
      const merged = getMergedGroups()
      assert.equal(merged.length, 1, 'all three entries must collapse to a single super-group')
      assert.deepEqual(merged[0].map((f) => f.id), ['A', 'B'])
    })
  }
})

describe('findGroupById with workspace merges', () => {
  it('returns the merged super-group when looked up by any member id', () => {
    reset()
    state.reports.push(
      { fileName: 'a.json', groups: [[makeFinding('A')]] },
      { fileName: 'b.json', groups: [[makeFinding('B')]] },
    )
    state.workspaceMerges.push(new Set(['A', 'B']))
    // groupKey of the merged super-group uses the first member —
    // which lands at the first-seen index (A in this fixture).
    const merged = getMergedGroups()
    assert.equal(merged.length, 1)
    const gid = groupKey(merged[0])
    const found = findGroupById(gid)
    assert.ok(found, 'merged super-group must be resolvable via its group key')
    assert.equal(found.length, 2)
    assert.deepEqual(found.map((f) => f.id).toSorted(), ['A', 'B'])
  })
})
