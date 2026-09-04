// `client/state.js` — the focus view's finding-card | Code split.
//
// The split is a percentage the user drags around (see
// ui/view/focus-splitter.js), so unlike viewMode / severityMode it
// can't be validated against an allow-list: every entry point —
// pointer drag, keyboard nudge, the value read back from
// localStorage — runs through `clampFocusSplit` instead. It ends up
// inside a `grid-template-columns` calc(), so the one thing it must
// never yield is `NaN` or an out-of-range percentage that collapses
// a pane the user can no longer grab.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

function installLocalStorage(seed = {}) {
  const store = new Map(Object.entries(seed))
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    clear: () => { store.clear() },
    get length() { return store.size },
    key: (i) => Array.from(store.keys())[i] ?? null,
  }
}

// Every import below is a fresh module instance (the `?boot=` cache
// buster), so each one re-runs the boot-time read against whatever
// localStorage holds at that moment — the only way to exercise a
// module-init read more than once in a single test file.
let boot = 0
async function bootWith(stored) {
  installLocalStorage(stored === null ? {} : { 'deepview.focusSplit': stored })
  return await import(`../client/state.ts?boot=${boot++}`)
}

const { FOCUS_SPLIT_DEFAULT, FOCUS_SPLIT_MAX, FOCUS_SPLIT_MIN, clampFocusSplit } = await bootWith(null)

describe('clampFocusSplit', () => {
  it('defaults to an even 1:1 split', () => {
    assert.equal(FOCUS_SPLIT_DEFAULT, 50)
  })

  it('passes an in-range percentage through', () => {
    assert.equal(clampFocusSplit(50), 50)
    assert.equal(clampFocusSplit(37.5), 37.5)
  })

  it('clamps to the pane minimums either side', () => {
    assert.equal(clampFocusSplit(0), FOCUS_SPLIT_MIN)
    assert.equal(clampFocusSplit(-40), FOCUS_SPLIT_MIN)
    assert.equal(clampFocusSplit(100), FOCUS_SPLIT_MAX)
    assert.equal(clampFocusSplit(1e6), FOCUS_SPLIT_MAX)
  })

  it('rounds a drag position to a tenth of a percent', () => {
    assert.equal(clampFocusSplit(42.4444), 42.4)
    assert.equal(clampFocusSplit(42.4567), 42.5)
  })

  // A zero-width pane (`getBoundingClientRect` before layout) or a
  // parsed-out storage value must not reach the grid as NaN.
  it('falls back to the default for non-numbers', () => {
    assert.equal(clampFocusSplit(Number.NaN), FOCUS_SPLIT_DEFAULT)
    assert.equal(clampFocusSplit(Number.POSITIVE_INFINITY), FOCUS_SPLIT_DEFAULT)
    assert.equal(clampFocusSplit(undefined), FOCUS_SPLIT_DEFAULT)
  })
})

describe('state.focusSplit boot read', () => {
  it('restores a persisted split', async () => {
    const { state } = await bootWith('63.5')
    assert.equal(state.focusSplit, 63.5)
  })

  it('defaults when nothing is stored', async () => {
    const { state } = await bootWith(null)
    assert.equal(state.focusSplit, FOCUS_SPLIT_DEFAULT)
  })

  // An empty entry parses as `Number('') === 0`, which is finite —
  // without an explicit miss it would clamp to the minimum and open
  // the app on a pane the user never chose.
  it('defaults on an empty entry', async () => {
    const { state } = await bootWith('')
    assert.equal(state.focusSplit, FOCUS_SPLIT_DEFAULT)
  })

  it('defaults on a non-numeric entry', async () => {
    const { state } = await bootWith('wide-ish')
    assert.equal(state.focusSplit, FOCUS_SPLIT_DEFAULT)
  })

  // A split written by a build with different bounds (or edited by
  // hand) is pulled back into range rather than dropped.
  it('clamps an out-of-range entry', async () => {
    const { state } = await bootWith('99')
    assert.equal(state.focusSplit, FOCUS_SPLIT_MAX)
  })
})
