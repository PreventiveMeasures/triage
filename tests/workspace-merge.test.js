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

  it('unions two single-finding groups from different reports when an instruction binds them', () => {
    reset()
    state.reports.push(
      { fileName: 'a.json', groups: [[makeFinding('A')]] },
      { fileName: 'b.json', groups: [[makeFinding('B')]] },
    )
    state.workspaceMerges.push(new Set(['A', 'B']))
    const merged = getMergedGroups()
    assert.equal(merged.length, 1)
    assert.deepEqual(merged[0].map((f) => f.id).toSorted(), ['A', 'B'])
  })

  it('preserves first-seen order — the merged super-group lands at the slot of its earliest member', () => {
    reset()
    state.reports.push(
      { fileName: 'a.json', groups: [[makeFinding('A')]] },
      { fileName: 'x.json', groups: [[makeFinding('X')]] },
      { fileName: 'b.json', groups: [[makeFinding('B')]] },
    )
    state.workspaceMerges.push(new Set(['A', 'B']))
    const merged = getMergedGroups()
    assert.equal(merged.length, 2)
    assert.deepEqual(merged[0].map((f) => f.id).toSorted(), ['A', 'B'])
    assert.deepEqual(merged[1].map((f) => f.id), ['X'])
  })

  it('chains transitive merges via union-find (A=B, B=C → all three together)', () => {
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
    assert.deepEqual(merged[0].map((f) => f.id).toSorted(), ['A', 'B', 'C'])
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
