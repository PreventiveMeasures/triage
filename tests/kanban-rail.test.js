import assert from 'node:assert/strict'
import { test } from 'node:test'
import './_polyfills.js'

const { drawnRange, indexAt, itemTops, nearestTop } = await import('../ui/view/kanban-rail.js')

// A hundred cards of 10px, and three of 10, 20 and 30.
const even = itemTops(100, () => 10)
const uneven = itemTops(3, i => [10, 20, 30][i])

test('tops run each item after the last, ending at the list height', () => {
  assert.deepEqual([...uneven], [0, 10, 30, 60])
  assert.deepEqual([...itemTops(0, () => 10)], [0])
})

test('the item at a height is the first reaching below it, clamped to the list', () => {
  assert.equal(indexAt(uneven, -5), 0)
  assert.equal(indexAt(uneven, 0), 0)
  assert.equal(indexAt(uneven, 9.5), 0)
  assert.equal(indexAt(uneven, 10), 1)
  assert.equal(indexAt(uneven, 59), 2)
  assert.equal(indexAt(uneven, 60), 2)
  assert.equal(indexAt(uneven, 1000), 2)
  assert.equal(indexAt(itemTops(0, () => 10), 0), 0)
})

test('what is drawn is the view and a view either side, clamped to the list', () => {
  assert.deepEqual(drawnRange(even, 500, 100), { from: 40, to: 71 })
  assert.deepEqual(drawnRange(even, 0, 100), { from: 0, to: 21 })
  assert.deepEqual(drawnRange(even, 900, 100), { from: 80, to: 100 })
  assert.deepEqual(drawnRange(itemTops(0, () => 10), 0, 100), { from: 0, to: 0 })
  // A view with no height (the rail hidden) draws the one card at its top.
  assert.deepEqual(drawnRange(even, 0, 0), { from: 0, to: 1 })
})

test('bringing an item into view moves no further than that takes', () => {
  // In view already: stays.
  assert.equal(nearestTop(even, 52, 500, 100), 500)
  // Above: its top at the view's top.
  assert.equal(nearestTop(even, 30, 500, 100), 300)
  // Below: its bottom at the view's bottom.
  assert.equal(nearestTop(even, 70, 500, 100), 610)
  // Partly out at either edge: the same.
  assert.equal(nearestTop(even, 49, 495, 100), 490)
  assert.equal(nearestTop(even, 59, 495, 100), 500)
  // Taller than the view: its top.
  assert.equal(nearestTop(uneven, 2, 0, 20), 30)
})
