import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blocksHold, changeBlocks } from '../common/line-diff.js'

// A random number in [0, 1) for each call, from a seed (mulberry32).
function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('change blocks are checked to take one text\'s lines to another\'s, hiding no change', () => {
  const after = 'a\nB\nc\nd\ne\n', before = 'a\nb\nc\nd\n'
  const blocks = changeBlocks(before, after)
  assert.deepEqual(blocks, [{ a0: 1, a1: 2, b0: 1, b1: 2 }, { a0: 4, a1: 4, b0: 4, b1: 5 }])
  assert.equal(blocksHold(before, after, blocks), true)
  for (const [label, wrong] of [
    ['none', []],
    ['one left out', blocks.slice(1)],
    ['moved a line', blocks.map(block => ({ ...block, a0: block.a0 + 1, a1: block.a1 + 1 }))],
    ['out of order', blocks.toReversed()],
    ['past the end', [...blocks, { a0: 4, a1: 5, b0: 5, b1: 6 }]],
    ['changing nothing', [{ a0: 0, a1: 0, b0: 0, b1: 0 }, ...blocks]],
    ['a changed line left between', [{ a0: 2, a1: 3, b0: 2, b1: 3 }, blocks[1]]],
    ['a count no number', [{ ...blocks[0], a0: '1' }, blocks[1]]],
    ['no list', null],
  ]) assert.equal(blocksHold(before, after, wrong), false, label)
  assert.equal(blocksHold('a b\n', 'ab\n', [], true), true, 'whitespace ignored, as diff -w ignores it')
  assert.equal(blocksHold('a b\n', 'ab\n', []), false)
  assert.equal(blocksHold('', '', []), true)
  assert.equal(blocksHold('', 'x\n', [{ a0: 0, a1: 0, b0: 0, b1: 1 }]), true)
  // A newline dropped after the last line changes that line, but for diff -w.
  assert.deepEqual(changeBlocks('a\nx', 'a\nx\n'), [{ a0: 1, a1: 2, b0: 1, b1: 2 }])
  assert.equal(blocksHold('a\nx', 'a\nx\n', changeBlocks('a\nx', 'a\nx\n')), true)
  for (const [old, now] of [['a\nx', 'a\nx\n'], ['x\n', 'x'], ['a\nx', 'b\nx\n']]) {
    assert.equal(blocksHold(old, now, old.startsWith('a') === now.startsWith('a') ? [] : [{ a0: 0, a1: 1, b0: 0, b1: 1 }]), false, `${JSON.stringify(old)} → ${JSON.stringify(now)}: its newline left out`)
  }
  assert.equal(blocksHold('a\nx', 'a\nx\n', [], true), true, 'as diff -w ignores it')
})

test('what changeBlocks finds holds, for texts made at random, whitespace ignored or not', () => {
  const next = random(7)
  // Some with no newline after their last line.
  const text = () => {
    const lines = Array.from({ length: Math.floor(next() * 12) }, () => ['a', 'b', ' a', 'a ', 'c d', 'cd', ''][Math.floor(next() * 7)]).map(line => `${line}\n`).join('')
    return next() < 0.3 ? lines.slice(0, -1) : lines
  }
  for (let i = 0; i < 400; i++) {
    const [before, after] = [text(), text()]
    for (const ignoreWhitespace of [false, true]) {
      assert.ok(blocksHold(before, after, changeBlocks(before, after, ignoreWhitespace), ignoreWhitespace), JSON.stringify({ before, after, ignoreWhitespace }))
    }
  }
})
