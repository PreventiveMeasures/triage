import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blocksHold, changeBlocks } from '../common/line-diff.js'
import { random } from './_js-programs.js'

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
})

test('what changeBlocks finds holds, for texts made at random, whitespace ignored or not', () => {
  const next = random(7)
  const text = () => Array.from({ length: Math.floor(next() * 12) }, () => ['a', 'b', ' a', 'a ', 'c d', 'cd', ''][Math.floor(next() * 7)]).map(line => `${line}\n`).join('')
  for (let i = 0; i < 400; i++) {
    const [before, after] = [text(), text()]
    for (const ignoreWhitespace of [false, true]) {
      assert.ok(blocksHold(before, after, changeBlocks(before, after, ignoreWhitespace), ignoreWhitespace), JSON.stringify({ before, after, ignoreWhitespace }))
    }
  }
})
