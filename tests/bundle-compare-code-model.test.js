import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DIFF_CONTEXT, diffRows, fileLineCounts, indentationMatters, lineDiff, markHighlighted, markSegments, textLines, whitespaceHidden } from '../ui/view/bundle-compare-code-model.js'

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

test('ignoring whitespace pairs lines that differ only in how much of it they have, as diff -b does', () => {
  assert.equal(lineDiff('a  b\nc\n', 'a b\nc\n', { ignoreWhitespace: true }).blocks.length, 0)
  assert.equal(lineDiff('a  b\nc\n', 'a b\nc\n').blocks.length, 1)
  assert.equal(lineDiff('  a()\n', '    a()\n', { ignoreWhitespace: true }).blocks.length, 0, 're-indented')
  for (const [before, after] of [['exec("rm -rf /tmp/x")\n', 'exec("rm -rf / tmp/x")\n'], ['return x\n', 'returnx\n'], ['c()\n', '    c()\n']]) {
    assert.equal(lineDiff(before, after, { ignoreWhitespace: true }).blocks.length, 1, `${JSON.stringify(before)} → ${JSON.stringify(after)}: blanks put between other characters, or taken from there`)
  }
})

test('what diff -b would hide: whether it hides a change, and one mixing kinds of blank', () => {
  assert.deepEqual(whitespaceHidden('  a()\n', '    a()\n'), { hides: true, mixed: false })
  assert.deepEqual(whitespaceHidden('  a()\n', '\ta()\n'), { hides: true, mixed: true }, 'spaces turned to a tab')
  assert.deepEqual(whitespaceHidden('\t  a()\n', '\t    a()\n'), { hides: true, mixed: true }, 'a run of tabs and spaces made longer')
  assert.deepEqual(whitespaceHidden('a b\n', 'ab\n'), { hides: false, mixed: false }, 'a blank taken from between two characters shows')
})

test('files whose indentation is part of their code are told by name', () => {
  for (const path of ['tools/gen.py', 'stubs/a.PYI', 'ext/a.pyx', 'rules.bzl', '.github/workflows/ci.yml', 'docker-compose.yaml', 'Makefile', 'makefile', 'sub/GNUmakefile', 'Makefile.am',
    'rules.mk', 'SConstruct', 'src/SConscript', 'Snakefile', 'wscript', 'BUILD.bazel', 'views/a.pug', 'styles/a.sass', 'data/a.tsv']) {
    assert.equal(indentationMatters(path), true, path)
  }
  for (const path of ['src/a.js', 'src/a.ts', 'package.json', 'styles/a.css', 'styles/a.scss', 'README.md', 'makefile.js', 'build.js', 'scripts/build', 'pyproject.toml', 'binding.gyp']) {
    assert.equal(indentationMatters(path), false, path)
  }
  // A script told by its #! line.
  assert.equal(indentationMatters('bin/tool', '#!/usr/bin/env python3\nimport sys\n'), true)
  assert.equal(indentationMatters('bin/tool', '#!/usr/bin/env -S pypy3 -u\n'), true)
  assert.equal(indentationMatters('bin/tool', '#!/usr/bin/env node\n// python\n'), false)
  assert.equal(indentationMatters('bin/tool', null), false, 'nor a side that is not text')
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

test('a block the server marks is marked, its lines counted apart, and a mark that is no block of the diff is none', () => {
  const after = 'function q(b) {\n  return b;\n}\nf(2);\n', before = 'function q(a) {\n  return a;\n}\nf(1);\n'
  const { blocks } = lineDiff(before, after)
  assert.deepEqual(blocks, [{ a0: 0, a1: 2, b0: 0, b1: 2 }, { a0: 3, a1: 4, b0: 3, b1: 4 }])
  const marked = lineDiff(before, after, { marks: [blocks[0]] })
  assert.deepEqual([...marked.marked], [0])
  assert.deepEqual([marked.additions, marked.deletions, marked.renamed], [1, 1, 2], 'the renamed lines counted apart')
  assert.equal(lineDiff(before, after, { marks: [{ a0: 0, a1: 1, b0: 0, b1: 1 }] }).marked.size, 0, 'part of a block')
})

test('a file\'s lines added and removed, as the tree lists them', () => {
  assert.deepEqual(fileLineCounts('a\nb\nc\n', 'a\nB\nc\nd\n'), { additions: 2, deletions: 1 })
  assert.deepEqual(fileLineCounts('same\n', 'same\n'), { additions: 0, deletions: 0 }, 'renamed as it was')
  assert.deepEqual(fileLineCounts('', 'a\nb'), { additions: 2, deletions: 0 }, 'added, last line unended')
  assert.deepEqual(fileLineCounts('a\nb\n', ''), { additions: 0, deletions: 2 }, 'removed')
  assert.deepEqual(fileLineCounts('a', 'a\n'), { additions: 1, deletions: 1 }, 'a newline added at the end changes that line')
  // As the diff's head counts them, for the same two sides.
  const before = text(lines(40))
  const after = text(lines(40).map((line, i) => i % 7 === 0 ? `${line} changed` : line))
  const { additions, deletions } = lineDiff(before, after)
  assert.deepEqual(fileLineCounts(before, after), { additions, deletions })
  assert.equal(fileLineCounts(new Uint8Array([1]), ''), null, 'not text')
  assert.equal(fileLineCounts('', new Uint8Array([1])), null)
  assert.equal(fileLineCounts(text(lines(10_001)), text(lines(10_000))), null, 'too large to count while the tree draws')
  assert.deepEqual(fileLineCounts('', text(lines(30_000))), { additions: 30_000, deletions: 0 }, 'an added file is counted however large')
})
