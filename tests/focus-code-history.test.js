// `ui/view/focus-code-history.js` — the focus view's Code panel
// remembers the files it has shown, and this is the algebra of that
// memory: what to draw, what a followed link does to the stack, and
// what Back / Forward do to the index.
//
// It is its own module BECAUSE of this file. The two real callers are
// a render (which may not write state) and a click handler (which
// drags in half the app), and neither is somewhere the truncate-and-
// push rule could be pinned down.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const { historyFor, pushed, stepped } = await import('../ui/view/focus-code-history.js')

const at = (file, start = null, end = start) =>
  ({ integrity: 'sha512-x', file, range: start === null ? null : { start, end } })

const BASE = at('src/proxy.ts', 53, 58)

describe('historyFor', () => {
  it('draws the finding own file, and offers no history, before anything is followed', () => {
    const h = historyFor([], 0, BASE)
    assert.deepEqual(h.pos, BASE)
    assert.equal(h.stack.length, 0, 'an empty stack is what hides the back/forward pair')
  })

  it('draws the entry the index points at', () => {
    const stack = [BASE, at('src/router.ts', 8), at('src/env.ts', 2)]
    assert.deepEqual(historyFor(stack, 0, BASE).pos, stack[0])
    assert.deepEqual(historyFor(stack, 2, BASE).pos, stack[2])
  })

  it('clamps an index the stack no longer reaches', () => {
    const stack = [BASE, at('src/router.ts', 8)]
    assert.equal(historyFor(stack, 9, BASE).at, 1)
    assert.equal(historyFor(stack, -3, BASE).at, 0)
  })

  // The focus change that should clear the stack doesn't reach every
  // way the panel's file can change — a tab switch inside a group is
  // one. Entry 0 not matching the base is how that is caught, from a
  // render, which cannot write the repair.
  it('ignores a stack belonging to some other finding', () => {
    const stale = [at('other/file.ts', 1), at('other/dep.ts', 4)]
    const h = historyFor(stale, 1, BASE)
    assert.deepEqual(h.pos, BASE)
    assert.equal(h.stack.length, 0)
  })

  it('tells the same-file-different-lines case apart', () => {
    const otherLines = at('src/proxy.ts', 100, 110)
    assert.equal(historyFor([otherLines], 0, BASE).stack.length, 0)
  })

  it('has nothing to draw without a base', () => {
    assert.equal(historyFor([BASE], 0, null), null)
  })
})

describe('pushed', () => {
  // The panel was already showing the finding's own file, so the first
  // link followed has to record BOTH — or Back from it goes nowhere.
  it('seeds the base and the target on the first follow', () => {
    const next = pushed([], 0, BASE, at('src/router.ts', 8))
    assert.deepEqual(next.stack, [BASE, at('src/router.ts', 8)])
    assert.equal(next.at, 1)
  })

  it('appends when the reader is at the end', () => {
    const stack = [BASE, at('src/router.ts', 8)]
    const next = pushed(stack, 1, BASE, at('src/env.ts', 2))
    assert.deepEqual(next.stack, [...stack, at('src/env.ts', 2)])
    assert.equal(next.at, 2)
  })

  // [first … history … (current) … truncated]
  //   → [first … history … old current … (pressed)]
  it('drops everything ahead of the reader', () => {
    const stack = [BASE, at('a.ts', 1), at('b.ts', 2), at('c.ts', 3), at('d.ts', 4)]
    const next = pushed(stack, 2, BASE, at('new.ts', 9))
    assert.deepEqual(next.stack, [BASE, at('a.ts', 1), at('b.ts', 2), at('new.ts', 9)])
    assert.equal(next.at, 3)
    assert.equal(next.stack.at(-1).file, 'new.ts', 'the pressed link is where the reader now is')
  })

  it('going back and forward again leaves the branch alone', () => {
    const stack = [BASE, at('a.ts', 1), at('b.ts', 2)]
    // Only a push truncates; stepping does not.
    assert.equal(stepped(stack, 2, -1), 1)
    assert.equal(stepped(stack, 1, 1), 2)
    assert.deepEqual(stack, [BASE, at('a.ts', 1), at('b.ts', 2)])
  })

  // Two rows citing the same place is the normal shape of a report,
  // not an edge case — a duplicate entry would light up a Back button
  // that appears to do nothing.
  it('does not stack a link to where the panel already is', () => {
    const stack = [BASE, at('a.ts', 1)]
    const next = pushed(stack, 1, BASE, at('a.ts', 1))
    assert.deepEqual(next.stack, stack)
    assert.equal(next.at, 1)
  })

  it('counts a different line in the same file as somewhere else', () => {
    const stack = [BASE, at('a.ts', 1)]
    const next = pushed(stack, 1, BASE, at('a.ts', 40))
    assert.equal(next.stack.length, 3)
    assert.equal(next.at, 2)
  })

  it('re-following the file the finding is on lands back at the base', () => {
    const stack = [BASE, at('a.ts', 1)]
    const next = pushed(stack, 1, BASE, BASE)
    assert.deepEqual(next.stack, [BASE, at('a.ts', 1), BASE])
    assert.equal(next.at, 2, 'and Back still returns to a.ts')
  })
})

describe('stepped', () => {
  const stack = [BASE, at('a.ts', 1), at('b.ts', 2)]

  it('walks one entry at a time', () => {
    assert.equal(stepped(stack, 0, 1), 1)
    assert.equal(stepped(stack, 2, -1), 1)
  })

  // Clamped, never wrapped: a Back that teleports to the newest file
  // is not what anyone means by Back.
  it('stops at the ends', () => {
    assert.equal(stepped(stack, 0, -1), 0)
    assert.equal(stepped(stack, 2, 1), 2)
  })

  it('has nowhere to go with no history', () => {
    assert.equal(stepped([], 0, 1), 0)
    assert.equal(stepped([], 0, -1), 0)
  })
})
