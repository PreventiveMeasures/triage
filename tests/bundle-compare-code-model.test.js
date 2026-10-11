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

test('names a minifier renamed alike throughout are left out, and only those', () => {
  const ignoring = (before, after) => lineDiff(text(before), text(after), { ignoreRenames: true })
  // A new function shifts every name after it: each still stands for one.
  const before = ['var Y = 1;', 'function q(n) {', '  return Y + n;', '}', 'q(Y);']
  const after = ['var X = 1;', 'function Z(n) {', '  return X + n;', '}', 'Z(X);']
  const model = ignoring(before, after)
  assert.deepEqual(model.blocks, [])
  assert.deepEqual([...model.renamed], [0, 1, 2, 4])
  assert.equal(lineDiff(text(before), text(after)).blocks.length, 2, 'off, they all show')
  const inserted = ignoring(before, ['function H(n) {', '  return n;', '}', ...after])
  assert.deepEqual(inserted.blocks, [{ a0: 0, a1: 0, b0: 0, b1: 3 }], 'what is new shows, the names it moved do not')
  assert.equal(inserted.additions, 3)
  // A collision anywhere keeps a line: `a` → `b` beside lines that keep both.
  const edited = ignoring(['var a = 1, b = 2;', 'f(a);', 'return a;'], ['var a = 1, b = 2;', 'f(a);', 'return b;'])
  assert.deepEqual(edited.blocks, [{ a0: 2, a1: 3, b0: 2, b1: 3 }])
  assert.equal(edited.renamed.size, 0)
  assert.equal(ignoring(['var a, b;', 'f(a);', 'g(b);'], ['var c, d;', 'f(c);', 'g(c);']).blocks.length, 1, 'two names renamed to one')
  assert.equal(ignoring(['let a, d;', 'f(a);', 'g(a);'], ['let b, c;', 'f(b);', 'g(c);']).blocks.length, 1, 'one name renamed two ways')
  assert.deepEqual(ignoring(['var a, b;', 'f(a);', 'g(b);'], ['var b, a;', 'f(b);', 'g(a);']).blocks, [], 'two names swapped each stand for one')
  // Only what the file declares: a global it doesn't is no minifier's to rename.
  for (const [global, other] of [['new Map();', 'new Set();'], ['$(x);', '_(x);'], ['a();', 'b();'], ['const { x = a } = o;', 'const { x = b } = o;'],
    ['function f({ x = a }) {}', 'function f({ x = b }) {}'], ['let a; f(<a />);', 'let b; f(<b />);'], ['let a; throw <a />;', 'let b; throw <b />;'],
    ['const { [a]: x } = o;', 'const { [b]: x } = o;'], ['let x = 1\nf(), a()', 'let y = 1\nf(), b()'], ['let a; f(<>a</>);', 'let b; f(<>b</>);'],
    ['const { a: x, b: y } = o; a();', 'const { a: x, b: y } = o; b();'], ['function f({ a: x, b: y }) {} a();', 'function f({ a: x, b: y }) {} b();'],
    ['let x\nfoo()', 'let y\nbar()'], ['let a; typeof <a />;', 'let b; typeof <b />;'], ['let a; if (x) <a />;', 'let b; if (x) <b />;'],
    ['function f(a) {}\na();', 'function f(b) {}\nb();'], ['{ let a; }\na();', '{ let b; }\nb();'],
    ['const f = function a() {};\na();', 'const g = function b() {};\nb();'], ['const f = a => a;\na();', 'const g = b => b;\nb();'],
    ['for (let a of x) {}\na();', 'for (let b of x) {}\nb();'], ['({ const: a }); a();', '({ const: b }); b();'],
    ['({ function: a }); a();', '({ function: b }); b();'], ['x.var = a; a();', 'x.var = b; b();'],
    ['let a = 1; eval("a");', 'let b = 1; eval("a");'], ['let a; with (o) { a; }', 'let b; with (o) { b; }'], ['let a; x + <a />;', 'let b; x + <b />;'],
    ['let a; debugger\n/a/.test(x)', 'let b; debugger\n/b/.test(x)'], ['foo(a)\n{ a(); }', 'foo(b)\n{ b(); }'],
    ['let a = 1; eval/* c */("a");', 'let b = 1; eval/* c */("a");'], ['let a = 1; (eval)("a");', 'let b = 1; (eval)("a");'],
    ['let x\n++a', 'let y\n++b'], ['let x\n+a()', 'let y\n+b()'], ['for (let a of []) continue\n+a()', 'for (let b of []) continue\n+b()'], ['function f() { for (let a of []) return\n-a() }', 'function f() { for (let b of []) return\n-b() }'], ['let a; const x = <>1<a/></>;', 'let b; const x = <>1<b/></>;'], ['let a; const x = <>-<a/></>;', 'let b; const x = <>-<b/></>;'], ['let amp; const x = <>&amp;</>;', 'let gt; const x = <>&gt;</>;'], ['let a; class X { f = x++\n a() {} }', 'let b; class X { f = x++\n b() {} }'], ['const f = x ? a => a : a();', 'const g = x ? b => b : b();'], ['let x /*\n*/ foo()', 'let y /*\n*/ bar()'], ['let a; class X { @dec a() {} }', 'let b; class X { @dec b() {} }'], ['let a\n/a/.test(x)', 'let b\n/b/.test(x)'], ['let(a); a();', 'let(b); b();'], ['let a; class X extends <a /> {}', 'let b; class X extends <b /> {}'], ['let a; import "x"\n/a/.test(y)', 'let b; import "x"\n/b/.test(y)'], ['let aé; render(<aé />)', 'let bø; render(<bø />)'], ['let a = 1; \\u0065val("a");', 'let b = 1; \\u0065val("a");'], ['let a; x < <a />;', 'let b; x < <b />;'], ['#!/usr/bin/a\nlet a, b;', '#!/usr/bin/b\nlet b, a;'], ['let a; const x = {...<a/>};', 'let b; const x = {...<b/>};'],
    ['let a; class X extends m(class Y extends Z {}) { a() {} }', 'let b; class X extends m(class Y extends Z {}) { b() {} }'], ['let a; class C extends /a/.constructor {}', 'let b; class C extends /b/.constructor {}'], ['let a; o: while (x) { if (y) break o\n/a/.test(z) && f(); break }', 'let b; o: while (x) { if (y) break o\n/b/.test(z) && f(); break }'], ['let x\n-a', 'let y\n-b'], ['let a, b; a: { b: { break a; } f(); }', 'let b, a; a: { b: { break b; } f(); }']]) {
    assert.equal(lineDiff(`${global}\n`, `${other}\n`, { ignoreRenames: true }).blocks.length, 1, `${global} → ${other}`)
  }
  assert.deepEqual(lineDiff('let a;\na();\n', 'let b;\nb();\n', { ignoreRenames: true }).blocks, [], 'declared, it is')
  assert.deepEqual(lineDiff('let f = c ? x => x : y => y;\nf();\n', 'let g = c ? z => z : w => w;\ng();\n', { ignoreRenames: true }).blocks, [], 'arrows either side of a `:`')
  assert.deepEqual(lineDiff('let a; // C:\\@x\na();\n', 'let b; // C:\\@x\nb();\n', { ignoreRenames: true }).blocks, [], 'a comment\'s `\\` or `@` turns nothing off')
  assert.deepEqual(lineDiff('#!/usr/bin/env node\nlet a;\na();\n', '#!/usr/bin/env node\nlet b;\nb();\n', { ignoreRenames: true }).blocks, [], 'under a hashbang too')
  assert.deepEqual(lineDiff('let a,\nc\n= 1\nf(a, c)\n', 'let b,\nd\n= 1\nf(b, d)\n', { ignoreRenames: true }).blocks, [], 'a declaration going on past a line break')
  assert.deepEqual(lineDiff('x: { let a = 1; f(a); break x; }\n', 'x: { let b = 1; f(b); break x; }\n', { ignoreRenames: true }).blocks, [], 'a labeled block is a block')
})

test('names left out are short bindings: never keywords, properties or keys, strings, templates, regular expressions, comments or longer names', () => {
  for (const [before, after] of [
    ['var a = 1;', 'let a = 1;'], ['f(x.foo);', 'f(x.bar);'], ['f({ foo: a });', 'f({ bar: a });'], ['f("a");', 'f("b");'],
    ['f(value);', 'f(other);'], ['f(/\\s/);', 'f(/\\d/);'], ['f(/foo/.test(a));', 'f(/bar/.test(a));'], ['f(/[/]x/);', 'f(/[/]y/);'],
    ['f(a); // foo', 'f(a); // bar'], ['f(a); /* foo */ g(b);', 'f(a); /* bar */ g(b);'],
    // Keys, though no `:` follows them: a method's, a shorthand one's, a pattern's, a class member's.
    ['x = { a() { return 1 } };', 'x = { b() { return 1 } };'], ['x = { c, a };', 'x = { c, b };'], ['x = { *a() {} };', 'x = { *b() {} };'],
    ['x = { get a() {} };', 'x = { get b() {} };'], ['const { a = 1 } = x;', 'const { b = 1 } = x;'], ['class X { a() {} }', 'class X { b() {} }'],
    ['class X { f() {} a = 1; }', 'class X { f() {} b = 1; }'],
    // Names a module exports, and a regular expression where a statement starts.
    ['export { value as a };', 'export { value as b };'], ['export const c = 1, a = 2;', 'export const c = 1, b = 2;'],
    ['export const [c, a] = x;', 'export const [c, b] = x;'], ['export const { k: a } = x;', 'export const { k: b } = x;'],
    ['export function a() {}', 'export function b() {}'], ['export class a {}', 'export class b {}'], ['export * as a from "m";', 'export * as b from "m";'],
    ['if (x) /foo/.test(a);', 'if (x) /bar/.test(a);'], ['for await (const x of a) /foo/.test(x);', 'for await (const x of a) /bar/.test(x);'],
    ['x . foo();', 'x . bar();'], ['x./* c */foo();', 'x./* c */bar();'], ['export default /foo/;', 'export default /bar/;'],
    ['class X extends m(B) { a() {} }', 'class X extends m(B) { b() {} }'], ['class X { f = 1\n a = 2 }', 'class X { f = 1\n b = 2 }'],
    // Each name renamed declared, so that only what keeps it can show it.
  ]) assert.equal(lineDiff(`let a, foo; ${before}\n`, `let b, bar; ${after}\n`, { ignoreRenames: true }).blocks.length, 1, `${before} → ${after}`)
  // Read as a whole: every line of a comment or a template spanning lines is kept.
  for (const [before, after] of [[['/*', ' * foo', ' */', 'f(a);'], ['/*', ' * bar', ' */', 'f(a);']], [['f(`', '  foo', '`);'], ['f(`', '  bar', '`);']]]) {
    assert.deepEqual(lineDiff(text(['let foo;', ...before]), text(['let bar;', ...after]), { ignoreRenames: true }).blocks, [{ a0: 2, a1: 3, b0: 2, b1: 3 }], before.join('⏎'))
  }
  // Where a statement is, names are bindings still: a block's, an arrow's, and divided.
  for (const [before, after] of [
    ['function f() { a(c); }', 'function f() { b(c); }'], ['if (x) { a, c; }', 'if (x) { b, c; }'], ['f(() => { a(c); });', 'f(() => { b(c); });'],
    ['x = { k: v => { a(c); } };', 'x = { k: v => { b(c); } };'], ['x = a / 2 / c;', 'x = b / 2 / c;'], ['x = { k: a, [c]: 1 };', 'x = { k: b, [c]: 1 };'],
    ['export const k = f(a, c);', 'export const k = f(b, c);'], ['export function f(a) { return a; }', 'export function f(b) { return b; }'],
    ['if (a) x = c / 2;', 'if (b) x = c / 2;'], ['x = /[&<>"\']/g.test(a);', 'x = /[&<>"\']/g.test(b);'],
  ]) assert.equal(lineDiff(`let a; ${before}\n`, `let b; ${after}\n`, { ignoreRenames: true }).blocks.length, 0, `${before} → ${after}`)
  // Declared by a function's parameters, an arrow's, a `catch`'s, an import.
  for (const [before, after] of [
    ['function f(a, c = 1) { a(c); }', 'function f(b, c = 1) { b(c); }'], ['f((a) => a(c));', 'f((b) => b(c));'], ['f(a => a(c));', 'f(b => b(c));'],
    ['try {} catch (a) { a(c); }', 'try {} catch (b) { b(c); }'], ['import a from "m"; a(c);', 'import b from "m"; b(c);'],
    ['import { k as a } from "m"; a(c);', 'import { k as b } from "m"; b(c);'], ['x = { k(a) { a(c); } };', 'x = { k(b) { b(c); } };'],
    ['f(function a() { a(c); });', 'f(function b() { b(c); });'], ['class X { m(a) { a(c); } }', 'class X { m(b) { b(c); } }'],
    ['x = { async *m(a) { a(c); } };', 'x = { async *m(b) { b(c); } };'], ['f(function* (a) { a(c); });', 'f(function* (b) { b(c); });'], ['f(a => a(c), 1);', 'f(b => b(c), 1);'], ['for (let a of c) a(c);', 'for (let b of c) b(c);'],
    ['for (let a = 0; a < c; a++) { f(a); }', 'for (let b = 0; b < c; b++) { f(b); }'], ['function a() {} a(c);', 'function b() {} b(c);'],
  ]) assert.equal(lineDiff(`${before}\n`, `${after}\n`, { ignoreRenames: true }).blocks.length, 0, `${before} → ${after}`)
  assert.equal(lineDiff('f(a)', 'f(a)\n', { ignoreRenames: true }).blocks.length, 1, 'a newline added at the end is a change')
  assert.equal(lineDiff('function f(a,  b) {}\n', 'function f(c, d) {}\n', { ignoreRenames: true, ignoreWhitespace: true }).blocks.length, 0, 'with whitespace too')
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
