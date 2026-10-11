import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DIFF_CONTEXT, changeStart, diffRows, lineDiff, markHighlighted, markSegments, textLines, wordRanges } from '../ui/view/bundle-compare-code-model.js'

const lines = n => Array.from({ length: n }, (_, i) => `line ${i + 1}`)
const text = list => list.map(line => `${line}\n`).join('')

test('lines are numbered as the diff numbers them', () => {
  assert.deepEqual(textLines(''), [])
  assert.deepEqual(textLines('a'), ['a'])
  assert.deepEqual(textLines('a\n'), ['a'])
  assert.deepEqual(textLines('a\n\nb'), ['a', '', 'b'])
})

test('a changed file folds unchanged runs down to their context', () => {
  const before = lines(40)
  const after = before.toSpliced(19, 1, 'line 20 changed')
  const model = lineDiff(text(before), text(after))
  assert.deepEqual(model.blocks, [{ a0: 19, a1: 20, b0: 19, b1: 20 }])
  assert.equal(model.additions, 1)
  assert.equal(model.deletions, 1)
  const rows = diffRows(model)
  assert.deepEqual(rows.map(row => row.kind), ['fold', 'ctx', 'ctx', 'ctx', 'del', 'add', 'ctx', 'ctx', 'ctx', 'fold'])
  assert.deepEqual(rows[0], { kind: 'fold', run: 0, a: 0, b: 0, count: 19 - DIFF_CONTEXT, up: true, down: false })
  assert.deepEqual(rows.at(-1), { kind: 'fold', run: 1, a: 23, b: 23, count: 17, up: false, down: true })
  assert.equal(rows[4].pair, 19, 'the removed line pairs with the added one')
  assert.equal(rows[5].pair, 19)

  // Expanding reveals lines next to the change, or the whole run.
  const up = diffRows(model, new Map([[0, { bottom: 5 }]]))
  assert.equal(up[0].count, 19 - DIFF_CONTEXT - 5)
  assert.equal(up.filter(row => row.kind === 'ctx').length, 2 * DIFF_CONTEXT + 5)
  const all = diffRows(model, new Map([[0, { all: true }], [1, { all: true }]]))
  assert.equal(all.filter(row => row.kind === 'fold').length, 0)
  assert.equal(all.length, 41)
})

test('short unchanged runs show in full instead of folding', () => {
  const edges = n => { const before = lines(n); return lineDiff(text(before), text(before.toSpliced(0, 1, 'first').toSpliced(n - 1, 1, 'last'))) }
  const folds = n => diffRows(edges(n)).filter(row => row.kind === 'fold').map(row => row.count)
  assert.deepEqual(folds(11), [], '9 lines between the changes: three on each side leave three, too few to fold')
  assert.deepEqual(folds(12), [4])
})

test('added and removed files are one block of every line', () => {
  const added = lineDiff('', 'a\nb\n')
  assert.deepEqual(diffRows(added).map(row => [row.kind, row.b]), [['add', 0], ['add', 1]])
  const removed = lineDiff('a\nb', '')
  assert.deepEqual(diffRows(removed).map(row => [row.kind, row.a]), [['del', 0], ['del', 1]])
  assert.deepEqual(removed.noEol, { a: true, b: false })
})

test('ignoring whitespace pairs lines that differ only in it', () => {
  assert.equal(lineDiff('a  b\nc\n', 'a b\nc\n', { ignoreWhitespace: true }).blocks.length, 0)
  assert.equal(lineDiff('a  b\nc\n', 'a b\nc\n').blocks.length, 1)
})

test('changed lines pair with the added line they were edited into, in unified and split rows alike', () => {
  const before = 'start\n  const rows = query.all({ limit: 50 })\n  res.json(rows)\nend\n'
  const after = 'start\n  const limit = Math.min(Number(req.query.limit) || 50, 200)\n  const rows = query.all({ limit })\n  res.json(rows)\nend\n'
  const model = lineDiff(before, after)
  assert.deepEqual(model.blocks, [{ a0: 1, a1: 2, b0: 1, b1: 3 }])
  const unified = diffRows(model)
  assert.deepEqual(unified.filter(row => row.kind !== 'ctx').map(row => [row.kind, row.a ?? row.b, row.pair]), [
    ['del', 1, 2], ['add', 1, null], ['add', 2, 1],
  ], 'the removed line pairs with the second added line, not the first')
  const split = diffRows(model, new Map(), { split: true })
  assert.deepEqual(split.map(row => row.kind === 'change' ? [row.left, row.right, row.paired] : row.kind), [
    'ctx', [null, 1, false], [1, 2, true], 'ctx', 'ctx',
  ], 'the added line before the pair runs against a blank')

  const positional = lineDiff('a\nb\nc\nd\n', 'a\nB\nC2\nC3\nd\n')
  assert.deepEqual(diffRows(positional, new Map(), { split: true }).map(row => row.kind === 'change' ? [row.left, row.right] : row.kind), [
    'ctx', [1, 1], [2, 2], [null, 3], 'ctx',
  ], 'unrelated lines share rows by position')
})

test('word ranges mark what changed inside a paired line', () => {
  assert.deepEqual(wordRanges('const total = sum(a, b)', 'const total = sum(a, c)'), { a: [[21, 22]], b: [[21, 22]] })
  assert.deepEqual(wordRanges('return foo bar', 'return baz qux'), { a: [[7, 14]], b: [[7, 14]] }, 'ranges split only by whitespace merge')
  assert.equal(wordRanges('alpha beta gamma', 'one two three'), null, 'a line mostly replaced is not worth marking')
  assert.equal(wordRanges('x'.repeat(5000), 'y'), null)
  assert.equal(wordRanges('same', 'same'), null)
})

test('marks go around the changed characters without crossing highlight tags', () => {
  const markup = '<span class="token keyword">const</span> a <span class="token operator">=</span> &lt;b&gt;'
  // Text: `const a = <b>` — mark `a = <` (6..11).
  assert.equal(markHighlighted(markup, [[6, 11]]),
    '<span class="token keyword">const</span> <mark class="diff-word">a </mark><span class="token operator"><mark class="diff-word">=</mark></span><mark class="diff-word"> &lt;</mark>b&gt;')
  assert.equal(markHighlighted(markup, []), markup)
  assert.deepEqual(markSegments('abcdef', [[1, 3], [4, 5]]), [
    { text: 'a', marked: false }, { text: 'bc', marked: true }, { text: 'd', marked: false }, { text: 'e', marked: true }, { text: 'f', marked: false },
  ])
})

test('changeStart finds the first row of the next change block', () => {
  const before = lines(30)
  const rows = diffRows(lineDiff(text(before), text(before.toSpliced(4, 2, 'x', 'y').toSpliced(20, 1, 'z'))))
  const starts = rows.flatMap((row, i) => changeStart(rows, i) === i ? [i] : [])
  assert.deepEqual(starts.map(i => [rows[i].kind, rows[i].change]), [['del', 0], ['del', 1]])
  assert.equal(changeStart(rows, starts[0] + 1), starts[1], 'a block\'s later rows are not starts')
  assert.equal(changeStart(rows, starts[1] + 1), -1)
})
