import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lineDiff as viewDiff } from '../ui/view/bundle-compare-code-model.js'
import { renameMap } from '../server-managed/rename-map.js'

const text = list => list.map(line => `${line}\n`).join('')
// A module's text, its top level its own: a script's names declared there are
// globals, never hidden.
const asModule = code => `${code}${code.endsWith('\n') || code === '' ? '' : '\n'}export {}\n`
// The diff Compare shows: with `ignoreRenames`, the old side given the new
// side's names (renameMap) diffed as it is, as the server diffs it; its
// formatting again changes only layout, and these are formatted already.
const lineDiff = (before, after, { ignoreRenames = false, ignoreWhitespace = false } = {}) =>
  viewDiff(ignoreRenames ? renameMap(before, after).text ?? before : before, after, { ignoreWhitespace })

test('names a minifier renamed alike throughout are given the new side\'s, and only those', () => {
  const ignoring = (before, after) => lineDiff(asModule(text(before)), asModule(text(after)), { ignoreRenames: true })
  // A new function shifts every name after it: each still stands for one.
  const before = ['var Y = 1;', 'function q(n) {', '  return Y + n;', '}', 'q(Y);']
  const after = ['var X = 1;', 'function Z(n) {', '  return X + n;', '}', 'Z(X);']
  const model = ignoring(before, after)
  assert.deepEqual(model.blocks, [])
  assert.deepEqual(model.a, model.b, 'the old side reads with the new names')
  assert.equal(lineDiff(text(before), text(after)).blocks.length, 2, 'off, they all show')
  const inserted = ignoring(before, ['function H(n) {', '  return n;', '}', ...after])
  assert.deepEqual(inserted.blocks, [{ a0: 0, a1: 0, b0: 0, b1: 3 }], 'what is new shows, the names it moved do not')
  assert.equal(inserted.additions, 3)
  // A collision anywhere keeps a line: `a` → `b` beside lines that keep both.
  const edited = ignoring(['var a = 1, b = 2;', 'f(a);', 'return a;'], ['var a = 1, b = 2;', 'f(a);', 'return b;'])
  assert.deepEqual(edited.blocks, [{ a0: 2, a1: 3, b0: 2, b1: 3 }])
  assert.deepEqual(edited.a, edited.b.with(2, 'return a;'), 'and keeps its own')
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
    ['let x\n++a', 'let y\n++b'], ['let x\n+a()', 'let y\n+b()'], ['let a, b;\n<!-- a', 'let b, a;\n<!-- b'], ['let a, b;\n--> a', 'let b, a;\n--> b'], ['let a = 1; f(`${eval("a")}`);', 'let b = 1; f(`${eval("a")}`);'], ['let a = 1; f(`${`${eval("a")}`}`);', 'let b = 1; f(`${`${eval("a")}`}`);'], ['let a = 1; f(`${x / \\u0065val("a") / y}`);', 'let b = 1; f(`${x / \\u0065val("a") / y}`);'], ['let a = 1; const z = function(){} / \\u0065val("a") / y;', 'let b = 1; const z = function(){} / \\u0065val("a") / y;'], ['let a = 1; x++ / eval("a") / y;', 'let b = 1; x++ / eval("a") / y;'], ['let a = 1; x-- /* c */ / \\u0065val("a") / y;', 'let b = 1; x-- /* c */ / \\u0065val("a") / y;'], ['let a = 1; f(`${x++ / eval("a") / y}`);', 'let b = 1; f(`${x++ / eval("a") / y}`);'], ['let a = 1; f(`${function(){} / \\u0065val("a") / y}`);', 'let b = 1; f(`${function(){} / \\u0065val("a") / y}`);'], ['class C { #a = 1; #b = 2; m() { let a; return this.#a } }', 'class C { #a = 1; #b = 2; m() { let b; return this.#b } }'], ['let a; class C { #a; static has(o) { return #a in o } }', 'let b; class C { #b; static has(o) { return #b in o } }'], ['let a = 1; const z = 0 > { a, valueOf() { return 0 } };', 'let b = 1; const z = 0 > { b, valueOf() { return 0 } };'], ['let a = 1; const z = 1. / eval("a") / y;', 'let b = 1; const z = 1. / eval("a") / y;'], ['let a = 1; f(`${a}`);', 'let b = 1; f(`${a}`);'], ['let a = 1; of / eval("a") / y;', 'let b = 1; of / eval("a") / y;'], ['const x = class a {}; a();', 'const x = class b {}; b();'], ['function f() { if (x) { var a = 1 } return a }', 'function f() { if (x) { var b = 1 } return a }'], ['for (let a of xs) if (x) f(); else a();', 'for (let b of xs) if (x) f(); else a();'], ['const f = a => fn\n(a);', 'const f = b => fn\n(a);'], ['for (let a of xs) do f(); while (a);', 'for (let b of xs) do f(); while (a);'], ['for (let a of xs) try { f() } catch (e) { a() }', 'for (let b of xs) try { f() } catch (e) { a() }'], ['for (let a of xs) f(); while (a) g();', 'for (let b of xs) f(); while (b) g();'], ['class C { static { var a = 1 } } a();', 'class C { static { var b = 1 } } b();'], ['for (let a of xs) if (x) do f(); while (a);', 'for (let b of xs) if (x) do f(); while (a);'], ['let a = 1; out({a});', 'let b = 1; out({a});'], ['class C { static /* c */ { var a = 1 } } a();', 'class C { static /* c */ { var b = 1 } } b();'], ['let a = 1; export { a };', 'let b = 1; export { a };'], ['let a = {}; out({...a});', 'let b = {}; out({...a});'], ['const f = a => typeof\n a; out(f(1));', 'const f = b => typeof\n a; out(f(1));'], ['class C { [k]() { var a = 1 } } a();', 'class C { [k]() { var b = 1 } } b();'], ['class C { "m"() { var a = 1 } } a();', 'class C { "m"() { var b = 1 } } b();'], ['class C { 1() { var a = 1 } } a();', 'class C { 1() { var b = 1 } } b();'], ['function f() /*c*/ { var a = 1 } a();', 'function f() /*c*/ { var b = 1 } b();'], ['let a = 1; out(c?a:x);', 'let b = 1; out(c?a:x);'], ['const f = a => of\n a();', 'const f = b => of\n b();'], ['const f = a => x\n/a/g;', 'const f = b => x\n/a/g;'], ['const f = a => x\ninstanceof a;', 'const f = b => x\ninstanceof a;'], ['const f = a => x\nin a;', 'const f = b => x\nin a;'], ['for (const a of xs) x = 1\n/a/g;', 'for (const b of xs) x = 1\n/a/g;'], ['let a = 1; switch (x) { case a: f() }', 'let b = 1; switch (x) { case a: f() }'], ['class C { #m() { var a = 1 } } a();', 'class C { #m() { var b = 1 } } b();'], ['class C { static #m() { var a = 1 } } a();', 'class C { static #m() { var b = 1 } } b();'], ['class C { *#m() { var a = 1 } } a();', 'class C { *#m() { var b = 1 } } b();'], ['class C { x = 1\n #m() { var a = 1 } } a();', 'class C { x = 1\n #m() { var b = 1 } } b();'], ['let b = 1; out({a});', 'let a = 1; out({a});'], ['let a; ({ a } = o);', 'let b; ({ a } = o);'], ['let a = 1; out({ a });', 'let b = 1; out({ a: b });'], ['switch (x) { case 1: { let a = 1; a() } case 2: a() }', 'switch (x) { case 1: { let b = 1; b() } case 2: b() }'], ['const x = class a extends a {};', 'const x = class b extends a {};'], ['function f(a = b) { var b = 1; return a }', 'function f(a = c) { var c = 1; return a }'], ['for (let a of xs) if (x) { f() } else a();', 'for (let b of xs) if (x) { f() } else a();'], ['if (x) for (let a of xs) {} else a();', 'if (x) for (let b of xs) {} else b();'], ['const f = (a, b = a) => b;', 'const f = (c, d = a) => d;'], ['function f() { let a = 2; return {valueOf() { return 8 }}/a/y }', 'function f() { let b = 2; return {valueOf() { return 8 }}/a/y }'], ['function f() { let a = 1; return await/a/y }', 'function f() { let b = 1; return await/a/y }'], ['function f() { let a = 1; return yield/a/y }', 'function f() { let b = 1; return yield/a/y }'], ['const { a : x, b : y } = obj; a();', 'const { a : x, b : y } = obj; b();'], ['const { a /* k */ : x } = obj; a();', 'const { a /* k */ : x } = obj; b();'], ['let a = 1; f(`x${`${a}`}`);', 'let b = 1; f(`x${`${a}`}`);'], ['let a; class C extends class {} { a() {} }', 'let b; class C extends class {} { b() {} }'], ['let a; class C extends function () {} { a() {} }', 'let b; class C extends function () {} { b() {} }'], ['let a; class C extends class extends B {} { a() {} }', 'let b; class C extends class extends B {} { b() {} }'], ['let a = 1; f(`${1. / \\u0065val("a") / y}`);', 'let b = 1; f(`${1. / \\u0065val("a") / y}`);'], ['let a = 1; f(`${"}"; eval("a")}`);', 'let b = 1; f(`${"}"; eval("a")}`);'], ['let a = 1; f(`${/* } */ eval("a")}`);', 'let b = 1; f(`${/* } */ eval("a")}`);'], ['let b; obj.a\u200Cb();', 'let c; obj.a\u200Cc();'], ['let a; class C { accessor a = 1 }', 'let b; class C { accessor b = 1 }'], ['for (let a of []) continue\n+a()', 'for (let b of []) continue\n+b()'], ['function f() { for (let a of []) return\n-a() }', 'function f() { for (let b of []) return\n-b() }'], ['let a; const x = <>1<a/></>;', 'let b; const x = <>1<b/></>;'], ['let a; const x = <>-<a/></>;', 'let b; const x = <>-<b/></>;'], ['let amp; const x = <>&amp;</>;', 'let gt; const x = <>&gt;</>;'], ['let a; class X { f = x++\n a() {} }', 'let b; class X { f = x++\n b() {} }'], ['const f = x ? a => a : a();', 'const g = x ? b => b : b();'], ['let x /*\n*/ foo()', 'let y /*\n*/ bar()'], ['let a; class X { @dec a() {} }', 'let b; class X { @dec b() {} }'], ['let a\n/a/.test(x)', 'let b\n/b/.test(x)'], ['let(a); a();', 'let(b); b();'], ['let a; class X extends <a /> {}', 'let b; class X extends <b /> {}'], ['let a; import "x"\n/a/.test(y)', 'let b; import "x"\n/b/.test(y)'], ['let aé; render(<aé />)', 'let bø; render(<bø />)'], ['let a = 1; \\u0065val("a");', 'let b = 1; \\u0065val("a");'], ['let a; x < <a />;', 'let b; x < <b />;'], ['#!/usr/bin/a\nlet a, b;', '#!/usr/bin/b\nlet b, a;'], ['let a; const x = {...<a/>};', 'let b; const x = {...<b/>};'],
    ['let a; class X extends m(class Y extends Z {}) { a() {} }', 'let b; class X extends m(class Y extends Z {}) { b() {} }'], ['let a; class C extends /a/.constructor {}', 'let b; class C extends /b/.constructor {}'], ['let a; o: while (x) { if (y) break o\n/a/.test(z) && f(); break }', 'let b; o: while (x) { if (y) break o\n/b/.test(z) && f(); break }'], ['let x\n-a', 'let y\n-b'], ['let a, b; a: { b: { break a; } f(); }', 'let b, a; a: { b: { break b; } f(); }']]) {
    assert.equal(lineDiff(asModule(`${global}\n`), asModule(`${other}\n`), { ignoreRenames: true }).blocks.length, 1, `${global} → ${other}`)
  }
  assert.deepEqual(lineDiff(asModule('let a;\na();\n'), asModule('let b;\nb();\n'), { ignoreRenames: true }).blocks, [], 'declared, it is')
  assert.deepEqual(lineDiff(asModule('let a;\nif (x) {}\n/[+-]/.test(c) && a();\n'), asModule('let b;\nif (x) {}\n/[+-]/.test(c) && b();\n'), { ignoreRenames: true }).blocks, [],
    'a regular expression after a block, with no name in it')
  assert.deepEqual(lineDiff(asModule('let a;\nn = x+++/\\//.test(s);\na();\n'), asModule('let b;\nn = x+++/\\//.test(s);\nb();\n'), { ignoreRenames: true }).blocks, [],
    'a regular expression after a postfix `++` and a `+`')
  assert.deepEqual(lineDiff(asModule('let a;\nf(`${g(() => { if (c) {} /[+-]/.test(s) })}`);\na();\n'), asModule('let b;\nf(`${g(() => { if (c) {} /[+-]/.test(s) })}`);\nb();\n'), { ignoreRenames: true }).blocks, [],
    'a regular expression after a block in a substitution, with no name in it')
  assert.deepEqual(lineDiff(asModule('class C { #x = 1; m() { let a = this.#x; return a } }\n'), asModule('class C { #x = 1; m() { let b = this.#x; return b } }\n'), { ignoreRenames: true }).blocks, [],
    'a private name kept, a binding beside it renamed')
  assert.deepEqual(lineDiff(asModule('const f = x => /* c */ { let a = x; return a };\n'), asModule('const f = x => /* c */ { let b = x; return b };\n'), { ignoreRenames: true }).blocks, [],
    'an arrow\'s body a block, a comment before it')
  assert.deepEqual(lineDiff(asModule('class C extends class extends function () {} {} { m() { let a = 1; return a } }\nif (x) { let a = 2; f(a) }\n'),
    asModule('class C extends class extends function () {} {} { m() { let b = 1; return b } }\nif (x) { let b = 2; f(b) }\n'), { ignoreRenames: true }).blocks, [],
    'classes and a function in an `extends`, each with its body, the blocks after them blocks')
  // A template's substitutions are code: their names are renamed as any.
  assert.deepEqual(lineDiff(asModule('let a = 1;\nf(`x${a}y`);\n'), asModule('let b = 1;\nf(`x${b}y`);\n'), { ignoreRenames: true }).blocks, [], 'a name in a substitution')
  assert.deepEqual(lineDiff(asModule('let a;\nf(`${xs.map(e => e + a)}`);\n'), asModule('let b;\nf(`${xs.map(t => t + b)}`);\n'), { ignoreRenames: true }).blocks, [],
    'an arrow\'s in one, its parameter its own')
  const spanning = lineDiff(asModule('let a;\nf(`x\n${a}\ny`);\ng();\n'), asModule('let b;\nf(`x\n${b}\ny`);\ng();\n'), { ignoreRenames: true })
  assert.deepEqual([spanning.blocks, spanning.a], [[], spanning.b], 'on its own line of a template spanning lines')
  assert.deepEqual(lineDiff(asModule('let a;\nf(`${s.replace(/[\\u0300-\\u036f]/g, "") / 2}`);\na();\n'), asModule('let b;\nf(`${s.replace(/[\\u0300-\\u036f]/g, "") / 2}`);\nb();\n'),
    { ignoreRenames: true }).blocks, [], 'a regular expression\'s escapes in a substitution turn nothing off')
  assert.deepEqual(lineDiff(asModule('let a;\nf(`x${c ? `y${z}` : `w`}v`, { a: 1 });\na();\n'), asModule('let b;\nf(`x${c ? `y${z}` : `w`}v`, { a: 1 });\nb();\n'), { ignoreRenames: true }).blocks, [],
    'a template nested in a substitution read whole')
  assert.deepEqual(lineDiff(asModule('let a;\nf("</a><select id=\'" + x);\ng(`<div>${x}</div>`);\na();\n'), asModule('let b;\nf("</a><select id=\'" + x);\ng(`<div>${x}</div>`);\nb();\n'),
    { ignoreRenames: true }).blocks, [], 'HTML in a string or a template is no JSX')
  assert.deepEqual(lineDiff(asModule('let a;\nf(`${x.replace(/[^\\w]/g, "@")}`);\na();\n'), asModule('let b;\nf(`${x.replace(/[^\\w]/g, "@")}`);\nb();\n'), { ignoreRenames: true }).blocks, [],
    'nor does a regular expression\'s `\\` or a string\'s `@` in a substitution turn renames off')
  assert.deepEqual(lineDiff(asModule('let a;\na(`Failed with \\n ${x} @user`);\n'), asModule('let b;\nb(`Failed with \\n ${x} @user`);\n'), { ignoreRenames: true }).blocks, [], 'a template\'s text turns nothing off')
  assert.deepEqual(lineDiff(asModule('let e\u0301;\nf(e\u0301);\n'), asModule('let o\u0301;\nf(o\u0301);\n'), { ignoreRenames: true }).blocks, [], 'a name with a combining mark, whole')
  assert.deepEqual(lineDiff(asModule('let f = c ? x => x : y => y;\nf();\n'), asModule('let g = c ? z => z : w => w;\ng();\n'), { ignoreRenames: true }).blocks, [], 'arrows either side of a `:`')
  assert.deepEqual(lineDiff(asModule('let a; // C:\\@x\na();\n'), asModule('let b; // C:\\@x\nb();\n'), { ignoreRenames: true }).blocks, [], 'a comment\'s `\\` or `@` turns nothing off')
  assert.deepEqual(lineDiff(asModule('#!/usr/bin/env node\nlet a;\na();\n'), asModule('#!/usr/bin/env node\nlet b;\nb();\n'), { ignoreRenames: true }).blocks, [], 'under a hashbang too')
  assert.deepEqual(lineDiff(asModule('let a,\nc\n= 1\nf(a, c)\n'), asModule('let b,\nd\n= 1\nf(b, d)\n'), { ignoreRenames: true }).blocks, [], 'a declaration going on past a line break')
  assert.deepEqual(lineDiff(asModule('x: { let a = 1; f(a); break x; }\n'), asModule('x: { let b = 1; f(b); break x; }\n'), { ignoreRenames: true }).blocks, [], 'a labeled block is a block')
})

test('a script\'s top level is every script\'s, its names globals never left out; a module\'s or a CommonJS one\'s is its own', () => {
  const hidden = (before, after) => lineDiff(before, after, { ignoreRenames: true }).blocks
  assert.deepEqual(hidden('let a;\na();\n', 'let b;\nb();\n'), [{ a0: 0, a1: 2, b0: 0, b1: 2 }], 'a script\'s, another script may read')
  assert.deepEqual(hidden('function a() {}\na();\n', 'function b() {}\nb();\n'), [{ a0: 0, a1: 2, b0: 0, b1: 2 }], 'a function\'s name there too')
  assert.deepEqual(hidden('!function () {\n  let a;\n  a();\n}();\n', '!function () {\n  let b;\n  b();\n}();\n'), [], 'a function\'s own, in a script')
  for (const [before, after, why] of [
    ['import x from "m";\nlet a;\na(x);\n', 'import x from "m";\nlet b;\nb(x);\n', 'a module\'s, by its `import`'],
    ['let a;\na();\nexport default 1;\n', 'let b;\nb();\nexport default 1;\n', 'by its `export`'],
    ['const a = require("m");\na();\n', 'const b = require("m");\nb();\n', 'a CommonJS module\'s, by its `require`'],
    ['let a = 1;\nmodule.exports = a;\n', 'let b = 1;\nmodule.exports = b;\n', 'by its `module.exports`'],
    ['let a = 1;\nexports.k = a;\n', 'let b = 1;\nexports.k = b;\n', 'by its `exports`'],
    ['let a;\nf(import.meta);\na();\n', 'let b;\nf(import.meta);\nb();\n', 'by its `import.meta`'],
  ]) assert.deepEqual(hidden(before, after), [], why)
  for (const [before, after, why] of [
    ['let a;\nimport("m").then(a);\n', 'let b;\nimport("m").then(b);\n', 'an `import(…)` is no module\'s'],
    ['let a;\nf("require(m)");\na();\n', 'let b;\nf("require(m)");\nb();\n', 'nor a string\'s `require(`'],
    ['let a;\nx.require(m);\na();\n', 'let b;\nx.require(m);\nb();\n', 'nor a property\'s'],
    ['let a;\nimport/*c*/("m");\na();\n', 'let b;\nimport/*c*/("m");\nb();\n', 'nor an `import(…)` past a comment'],
    ['let a = 1;\nfunction f(require) { require("x") }\nout(a);\n', 'let b = 1;\nfunction f(require) { require("x") }\nout(b);\n', 'nor a parameter\'s'],
    ['var require = g();\nlet a;\nrequire("x");\na();\n', 'var require = g();\nlet b;\nrequire("x");\nb();\n', 'nor the script\'s own'],
  ]) assert.notDeepEqual(hidden(before, after), [], why)
  // Outside a module, `await` is a name but in an `async` function, unknown here: a line break after it ends
  // its statement or not.
  assert.notDeepEqual(hidden('const f = a => await\n  a();\nmodule.exports = f;\n', 'const f = b => await\n  b();\nmodule.exports = f;\n'), [],
    'a line break after `await`, outside a module')
  // A function declared in a block outside strict code sets its function's variable of that name
  // too: no names are given then; in strict code it is its block's alone.
  assert.equal(hidden('function f() { if (x) { function a() {} } return a }\nmodule.exports = f;\n', 'function f() { if (x) { function b() {} } return a }\nmodule.exports = f;\n').length, 1,
    'a function declared in a block, read past it')
  assert.notDeepEqual(hidden('function f() { if (x) { function a() {} a() } }\nmodule.exports = f;\n', 'function f() { if (x) { function b() {} b() } }\nmodule.exports = f;\n'), [],
    'read in its block alone, outside strict code')
  assert.deepEqual(hidden('"use strict";\nfunction f() { if (x) { function a() {} a() } }\nmodule.exports = f;\n', '"use strict";\nfunction f() { if (x) { function b() {} b() } }\nmodule.exports = f;\n'), [],
    'in strict code')
  // One declared after `else`, no expression's own name, is one in a block: outside strict code, no names given.
  assert.equal(hidden('function f(x) { if (x) g(); else function a() {} return a }\nmodule.exports = f;\n', 'function f(x) { if (x) g(); else function b() {} return a }\nmodule.exports = f;\n').length, 1,
    'a function declared after `else`, read past it')
  assert.notDeepEqual(hidden('function f(x) { if (x) g(); else function a() {} return a }\nmodule.exports = f;\n', 'function f(x) { if (x) g(); else function b() {} return b }\nmodule.exports = f;\n'), [],
    'renamed alike, outside strict code')
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
  ]) assert.equal(lineDiff(asModule(`let a, foo; ${before}\n`), asModule(`let b, bar; ${after}\n`), { ignoreRenames: true }).blocks.length, 1, `${before} → ${after}`)
  // Read as a whole: every line of a comment or a template spanning lines is kept.
  for (const [before, after] of [[['/*', ' * foo', ' */', 'f(a);'], ['/*', ' * bar', ' */', 'f(a);']], [['f(`', '  foo', '`);'], ['f(`', '  bar', '`);']]]) {
    assert.deepEqual(lineDiff(asModule(text(['let foo;', ...before])), asModule(text(['let bar;', ...after])), { ignoreRenames: true }).blocks, [{ a0: 2, a1: 3, b0: 2, b1: 3 }], before.join('⏎'))
  }
  // Where a statement is, names are bindings still: a block's, an arrow's, and divided.
  for (const [before, after] of [
    ['function f() { a(c); }', 'function f() { b(c); }'], ['if (x) { a, c; }', 'if (x) { b, c; }'], ['f(() => { a(c); });', 'f(() => { b(c); });'],
    ['x = { k: v => { a(c); } };', 'x = { k: v => { b(c); } };'], ['x = a / 2 / c;', 'x = b / 2 / c;'], ['x = { k: a, [c]: 1 };', 'x = { k: b, [c]: 1 };'],
    ['export const k = f(a, c);', 'export const k = f(b, c);'], ['export function f(a) { return a; }', 'export function f(b) { return b; }'],
    ['if (a) x = c / 2;', 'if (b) x = c / 2;'], ['x = /[&<>"\']/g.test(a);', 'x = /[&<>"\']/g.test(b);'],
    ['for (const x of /\\w/.exec(c)) a(x);', 'for (const x of /\\w/.exec(c)) b(x);'],
  ]) assert.equal(lineDiff(asModule(`let a; ${before}\n`), asModule(`let b; ${after}\n`), { ignoreRenames: true }).blocks.length, 0, `${before} → ${after}`)
  // Declared by a function's parameters, an arrow's, a `catch`'s, an import.
  for (const [before, after] of [
    ['function f(a, c = 1) { a(c); }', 'function f(b, c = 1) { b(c); }'], ['f((a) => a(c));', 'f((b) => b(c));'], ['f(a => a(c));', 'f(b => b(c));'],
    ['try {} catch (a) { a(c); }', 'try {} catch (b) { b(c); }'], ['import a from "m"; a(c);', 'import b from "m"; b(c);'],
    ['import { k as a } from "m"; a(c);', 'import { k as b } from "m"; b(c);'], ['x = { k(a) { a(c); } };', 'x = { k(b) { b(c); } };'],
    ['f(function a() { a(c); });', 'f(function b() { b(c); });'], ['class X { m(a) { a(c); } }', 'class X { m(b) { b(c); } }'],
    ['x = { async *m(a) { a(c); } };', 'x = { async *m(b) { b(c); } };'], ['f(function* (a) { a(c); });', 'f(function* (b) { b(c); });'], ['f(a => a(c), 1);', 'f(b => b(c), 1);'], ['for (let a of c) a(c);', 'for (let b of c) b(c);'],
    ['for (let a = 0; a < c; a++) { f(a); }', 'for (let b = 0; b < c; b++) { f(b); }'], ['function a() {} a(c);', 'function b() {} b(c);'],
    // A concise arrow's own conditional, its `:` ending none of it; an outer one's, the arrows begun in it.
    ['f(a => c ? a : a);', 'f(b => c ? b : b);'], ['f(a => a ? 1 : a?.k ?? a);', 'f(b => b ? 1 : b?.k ?? b);'], ['f(a => c ? d => d : a);', 'f(b => c ? e => e : b);'],
    ['f(a => x ? d => d : a);', 'f(b => x ? e => e : b);'],
    // A pattern's key, spaces before its `:`.
    ['const { k : a } = c; a();', 'const { k : b } = c; b();'],
    // A `catch` with no binding, its body a block; a class expression's name, its body's.
    ['try {} catch { let a = 1; a(c); }', 'try {} catch { let b = 1; b(c); }'], ['x = class a { m() { return a } };', 'x = class b { m() { return b } };'],
    ['x = class a extends c { m() { return a } };', 'x = class b extends c { m() { return b } };'],
    ['x = class a extends class {} { m() { return a } };', 'x = class b extends class {} { m() { return b } };'],
    // A `var`, its function's past its block, a `catch`'s body's too; a parameter, read in a later one's default.
    ['function f() { if (x) { var a = 1 } return a(c) }', 'function f() { if (x) { var b = 1 } return b(c) }'],
    ['function f() { try {} catch (e) { var a = 1 } return a(c) }', 'function f() { try {} catch (e) { var b = 1 } return b(c) }'],
    ['f((a, d = a) => d(c));', 'f((b, d = b) => d(c));'], ['f((a, d = () => a) => d(c));', 'f((b, d = () => b) => d(c));'], ['f(function (a, d = a) { d(c) });', 'f(function (b, d = b) { d(c) });'],
    // A `for`'s unbraced body, an `if` with its `else`; a braced one, ending at its `}`.
    ['for (let a of c) if (x) f(); else a();', 'for (let b of c) if (x) f(); else b();'], ['for (let a of c) if (x) { f() } else a();', 'for (let b of c) if (x) { f() } else b();'],
    ['for (let a of c) for (let d of a) if (x) f(); else d(a);', 'for (let b of c) for (let e of b) if (x) f(); else e(b);'], ['if (x) for (let a of c) { a() } else d();', 'if (x) for (let b of c) { b() } else d();'],
    // A `try`'s, a `do`'s; a concise arrow's body going on a line beginning with `(` or `[`.
    ['for (let a of c) try { f() } catch (e) { a() }', 'for (let b of c) try { f() } catch (e) { b() }'], ['for (let a of c) try { f() } finally { a() }', 'for (let b of c) try { f() } finally { b() }'],
    ['for (let a of c) do f(); while (a);', 'for (let b of c) do f(); while (b);'], ['for (let a of c) do { f() } while (a);', 'for (let b of c) do { f() } while (b);'],
    ['const g = a => fn\n(a);', 'const g = b => fn\n(b);'], ['const g = a => fn\n[a];', 'const g = b => fn\n[b];'],
    ['for (let a of c) if (x) do f(); while (a);', 'for (let b of c) if (x) do f(); while (b);'], ['function f(a, d = a) { var e = d; return e(c) }', 'function f(b, d = b) { var e = d; return e(c) }'],
    // A shorthand property's name read, a class's field's not; a block after a `case` or a `default`; a class in an `extends`, its body found.
    ['class X { a }\nlet a; f(a);', 'class X { a }\nlet b; f(b);'],
    ['switch (x) { case 1: { let a = 1; a(c) } }', 'switch (x) { case 1: { let b = 1; b(c) } }'], ['switch (x) { default: { let a = 1; a(c) } }', 'switch (x) { default: { let b = 1; b(c) } }'],
    ['x = class extends class {} { a() {} }; let a; a(c);', 'x = class extends class {} { a() {} }; let b; b(c);'],
    // A `static` block after a comment; an `export`'s local name renamed `as` another, a re-export's the other module's; a spread's and a rest's names.
    ['class X { static /* c */ { var a = 1; a(c) } }', 'class X { static /* c */ { var b = 1; b(c) } }'], ['let a = 1; export { a as k };', 'let b = 1; export { b as k };'],
    ['let a; a(c); export { a as k } from "m";', 'let b; b(c); export { a as k } from "m";'], ['f(a => ({ ...a }));', 'f(b => ({ ...b }));'], ['f((...a) => a(c));', 'f((...b) => b(c));'],
    ['const [k, ...a] = c; a();', 'const [k, ...b] = c; b();'],
    // A concise arrow's body going on past a word a value must follow.
    ['const g = a => typeof\n a;', 'const g = b => typeof\n b;'], ['const g = a => void\n a;', 'const g = b => void\n b;'],
    // A method's body after a computed, a string or a number key; a function's or an arrow's after a comment.
    ['class X { [k]() { var a = 1; a(c) } }', 'class X { [k]() { var b = 1; b(c) } }'], ['class X { #m() { var a = 1; a(c) } }', 'class X { #m() { var b = 1; b(c) } }'],
    ['let a = 1; out(c?a:x, { a: a });', 'let b = 1; out(c?b:x, { a: b });'], ['let a = 1; switch (x) { case a: f() }', 'let b = 1; switch (x) { case b: f() }'],
    ['x : { let a = 1; f(a); break x }', 'x : { let b = 1; f(b); break x }'], ['for (const a of\n xs) f(a);', 'for (const b of\n xs) f(b);'], ['const f = a => x\n/a/g;', 'const f = b => x\n/b/g;'], ['const f = a => x\ninstanceof a;', 'const f = b => x\ninstanceof b;'],
    ['const f = async a => await\n a();', 'const f = async b => await\n b();'], ['const f = a => x\ninput(a);', 'const f = b => x\ninput(a);'],
    ['for (const a of xs) x = 1\n/a/g;', 'for (const b of xs) x = 1\n/b/g;'], ['const f = a => { return\n/a/g };', 'const f = b => { return\n/a/g };'],
    ['const x = function a(p = f()) { return a };', 'const x = function b(p = f()) { return b };'],
    ['const x = function a(p = function c(q) { return c }) { return a };', 'const x = function b(p = function d(q) { return d }) { return b };'], ['class X { "m"() { var a = 1; a(c) } }', 'class X { "m"() { var b = 1; b(c) } }'],
    ['f(function () /*c*/ { var a = 1; a(c) });', 'f(function () /*c*/ { var b = 1; b(c) });'], ['f((a) /*c*/ => a(c));', 'f((b) /*c*/ => b(c));'],
    // A class's `static` block, its `var`s its own.
    ['class X { static { var a = 1; a(c) } }', 'class X { static { var b = 1; b(c) } }'], ['class X { y = 1\n static { let a = 1; a(c) } }', 'class X { y = 1\n static { let b = 1; b(c) } }'],
  ]) assert.equal(lineDiff(asModule(`${before}\n`), asModule(`${after}\n`), { ignoreRenames: true }).blocks.length, 0, `${before} → ${after}`)
  assert.equal(lineDiff('f(a)', 'f(a)\n', { ignoreRenames: true }).blocks.length, 1, 'a newline added at the end is a change')
  assert.equal(lineDiff(asModule('function f(a,  b) {}\n'), asModule('function f(c, d) {}\n'), { ignoreRenames: true, ignoreWhitespace: true }).blocks.length, 0, 'with whitespace too')
})

test('a rename is all or nothing: every line it is on reads with the new name, removed ones too', () => {
  const ignoring = (before, after) => lineDiff(asModule(text(before)), asModule(text(after)), { ignoreRenames: true })
  // A minifier's shift (`_e` → `$e`, `$e` → `ke`) beside an unchanged local `r`
  // in one function, while another function's own `r` became `i`.
  const before = ['var _e = globalThis,', '  $e = _e.ShadowRoot;', 'function s(e) {', '  let r = _e.litNonce;', '  return r + e;', '}',
    'function u(t) {', '  let r = t * 2;', '  return $e(r);', '}', 'function w() {', '  return _e.gone;', '}']
  const after = ['var $e = globalThis,', '  ke = $e.ShadowRoot;', 'function s(e) {', '  let r = $e.litNonce;', '  return r + e;', '}',
    'function u(t) {', '  let i = t * 3;', '  return ke(i);', '}']
  const model = ignoring(before, after)
  assert.deepEqual(model.blocks, [{ a0: 7, a1: 8, b0: 7, b1: 8 }, { a0: 9, a1: 12, b0: 9, b1: 9 }], 'what changed alone, the renamed lines all alike')
  assert.equal(model.a[7], '  let i = t * 2;', 'a changed line reads with the new names')
  assert.equal(model.a[11], '  return $e.gone;', 'so does a removed one')
})

test('an old variable no new one stands for reads apart, never as the new one of its name', () => {
  const ignoring = (before, after) => lineDiff(asModule(text(before)), asModule(text(after)), { ignoreRenames: true })
  // `abc` and `x` swapped their values: `f(abc)` reads the other one now.
  const swapped = ignoring(['var abc = 1,', '  x = 2;', 'f(abc);'], ['var x = 1,', '  abc = 2;', 'f(abc);'])
  assert.deepEqual(swapped.blocks, [{ a0: 0, a1: 3, b0: 0, b1: 3 }], 'the same text reading another variable is a change')
  assert.deepEqual(swapped.a.slice(0, 3), ['var abc_old = 1,', '  x_old = 2;', 'f(abc_old);'])
  // One removed, a new one of its name added: no line reads the old as the new.
  const replaced = ignoring(['let n = f();', 'g(n);', 'h(1);'], ['h(1);', 'let n = k();', 'g(n);'])
  assert.ok(replaced.a.includes('g(n_old);'))
})

test('names are given only where the old side then reads as it did', () => {
  // `a` → `$` would read the global `$` in `f` as `a`.
  const captured = renameMap(asModule('let a = 1;\nfunction f() {\n  return $(a);\n}\n'), asModule('let $ = 1;\nfunction f() {\n  return $($);\n}\n'))
  assert.match(captured.text, /^let a = 1;$/mu)
  assert.match(captured.text, /return \$\(a\);/u)
  // Names part of what a file says keep theirs: an import by its name, a shorthand property.
  const imported = renameMap(asModule('import { x } from "m";\nf(x);\n'), asModule('import { y } from "m";\nf(y);\n'))
  assert.match(imported.text, /import \{ x \} from "m";\nf\(x\);/u)
  const shorthand = renameMap(asModule('let a = 1;\nf({ a });\n'), asModule('let b = 1;\nf({ b });\n'))
  assert.match(shorthand.text, /f\(\{ a \}\)/u)
  for (const [before, reason] of [['let a = (;', 'unparsed'], ['let a = 1;\neval("a");', 'dynamic'], ['let a = <b />;', 'jsx'],
    ['function f() {\n  if (x) {\n    function a() {}\n  }\n  return a;\n}\nmodule.exports = f;\n', 'block-function']]) {
    assert.equal(renameMap(before, before.replaceAll('a', 'b')).reason, reason, reason)
  }
})

test('a variable on changed lines alone keeps its counterpart where those lines pair in order', () => {
  const ignoring = (before, after) => lineDiff(asModule(text(before)), asModule(text(after)), { ignoreRenames: true })
  const model = ignoring(['let x = 1;', 'f(xs.map(n => n * 2));'], ['let y = 1;', 'f(xs.map(n => n * 3));'])
  assert.equal(model.a[1], 'f(xs.map(n => n * 2));', 'no name apart where the change is the number alone')
  // What unchanged lines say wins: `a` → `b` there, a changed line's `a` → `a` says nothing.
  const said = ignoring(['let a = 1;', 'f(a);', 'g(a, 1);'], ['let b = 1;', 'f(b);', 'g(a, 2);'])
  assert.deepEqual(said.a.slice(0, 3), ['let b = 1;', 'f(b);', 'g(b, 1);'])
})

test('variables pair each with the one it most stands for, a stray line outweighed and a tie pairing neither', () => {
  const ignoring = (before, after) => lineDiff(asModule(text(before)), asModule(text(after)), { ignoreRenames: true })
  // `a` with `c` first; `b`, left `d`, with it: what changed is what `g` reads.
  const two = ignoring(['var a, b;', 'f(a);', 'g(b);'], ['var c, d;', 'f(c);', 'g(c);'])
  assert.deepEqual(two.a.slice(0, 3), ['var c, d;', 'f(c);', 'g(d);'])
  assert.deepEqual(two.blocks, [{ a0: 2, a1: 3, b0: 2, b1: 3 }])
  // Four lines say `v` is `w`, one stray pair of lines says it is `n`.
  const stray = ignoring(['var v = {};', 'h(v);', 'k(v);', 'm(v);', 'function f(n) {', '  e = v;', '}'],
    ['var w = {};', 'h(w);', 'k(w);', 'm(w);', 'function f(n) {', '  e = n;', '}'])
  assert.deepEqual(stray.a.slice(0, 4), ['var w = {};', 'h(w);', 'k(w);', 'm(w);'])
  assert.deepEqual(stray.blocks, [{ a0: 5, a1: 6, b0: 5, b1: 6 }], 'the one line that reads another variable')
  // Two old variables each told once for one new one: neither paired.
  const tie = ignoring(['let a = 1, b = 2;', 'f(a);', 'f(b);'], ['let c = 1;', 'f(c);', 'f(c);'])
  assert.deepEqual(tie.a.slice(1, 3), ['f(a);', 'f(b);'])
})

test('a file is parsed as its extension has it: an .mjs one a module, a .cjs one CommonJS, its top level its own', () => {
  const [before, after] = ['let a = 1;\nf(a);\n', 'let b = 1;\nf(b);\n']
  assert.equal(renameMap(before, after).text, before, 'a script\'s top level is every script\'s')
  assert.equal(renameMap(before, after, { extension: 'mjs' }).text, after, 'a module\'s with no import or export')
  assert.equal(renameMap(before, after, { extension: 'cjs' }).text, after, 'a CommonJS module\'s reading none of its own names')
  assert.equal(renameMap('if (x) return;\nlet a = 1;\nf(a);\n', 'if (x) return;\nlet b = 1;\nf(b);\n', { extension: 'cjs' }).text.endsWith('f(b);\n'), true,
    'its top level a function\'s, `return` there too')
})

test('a line alike another place\'s with names set aside, paired between changes alone, does not undo what runs of unchanged lines say', () => {
  const ignoring = (before, after) => lineDiff(asModule(text(before)), asModule(text(after)), { ignoreRenames: true })
  // `function Ht(t, e) {` added before `function K(t, e) {`: alike with names set
  // aside, the first may pair with K's, its body's lines saying otherwise.
  const before = ['function K(t, e) {', '  let n = f(t);', '  if (n) return n;', '  return g(t, e);', '}', 'K(1, 2);']
  const after = ['function Ht(t, e) {', '  return h(t, e);', '}', 'function K(t, e) {', '  let n = f(t);', '  if (n) return n;', '  return g(t, e);', '}', 'K(1, 2);', 'Ht(3, 4);']
  const model = ignoring(before, after)
  assert.deepEqual(model.a.slice(0, 6), before, 'K and its own names as they were')
  assert.deepEqual(model.blocks, [{ a0: 0, a1: 0, b0: 0, b1: 3 }, { a0: 6, a1: 6, b0: 9, b1: 10 }], 'what was added alone')
})

test('a function body\'s var named as a parameter is that parameter', () => {
  const ignoring = (before, after) => lineDiff(asModule(text(before)), asModule(text(after)), { ignoreRenames: true })
  // The old function returns its argument, the new one `undefined`.
  const split = ignoring(['function f(a) {', '  var a;', '  return a;', '}', 'f(1);'], ['function f(b) {', '  var c;', '  return c;', '}', 'f(1);'])
  assert.notDeepEqual(split.blocks, [], 'one binding renamed two ways is a change')
  const alike = ignoring(['function f(a) {', '  var a = a || 1;', '  return a;', '}', 'f(1);'], ['function f(b) {', '  var b = b || 1;', '  return b;', '}', 'f(1);'])
  assert.deepEqual(alike.blocks, [], 'renamed as one, it hides')
})

test('each side is parsed as its own extension has it, a file renamed from one type to another', () => {
  const mapped = renameMap('let a = 1;\nf(a);\nexport {};\n', 'if (x) return;\nlet b = 1;\nf(b);\n', { extension: 'mjs', otherExtension: 'cjs' })
  assert.equal(mapped.reason, undefined, 'a .cjs file\'s top-level `return` parses')
})

test('a var named as the catch parameter it is in keeps one name with it', () => {
  const ignoring = (before, after) => lineDiff(asModule(text(before)), asModule(text(after)), { ignoreRenames: true })
  const lines = (caught, declared, read, returned) => ['function f() {', '  try {', '    throw 1;', `  } catch (${caught}) {`, `    var ${declared} = 2;`, `    out(${read});`,
    '  }', `  return ${returned};`, '}', 'f();']
  // The first calls out(2) and returns undefined, the second out(1) and returns 2.
  assert.notDeepEqual(ignoring(lines('a', 'a', 'a', 'a'), lines('b', 'c', 'b', 'c')).blocks, [], 'renamed apart, it is a change')
  assert.deepEqual(ignoring(lines('a', 'a', 'a', 'a'), lines('b', 'b', 'b', 'b')).blocks, [], 'renamed as one, it hides')
})

test('a switch\'s discriminant reads the scope around its cases', () => {
  const ignoring = (before, after) => lineDiff(asModule(text(before)), asModule(text(after)), { ignoreRenames: true })
  const lines = (outer, read, inner) => ['function f() {', `  let ${outer} = 1;`, `  switch (${read}) {`, '    case 1:', `      let ${inner} = 2;`, `      return ${inner};`, '  }', '}', 'f();']
  // The first switches on the outer `a`, the second reads an undeclared `c`.
  assert.notDeepEqual(ignoring(lines('a', 'a', 'a'), lines('b', 'c', 'c')).blocks, [], 'read as the case\'s, it is a change')
  assert.deepEqual(ignoring(lines('a', 'a', 'a'), lines('b', 'b', 'c')).blocks, [], 'read as the outer one, it hides')
})

test('a var joins the nearest catch parameter of its name alone, nested catches of that name left whole', () => {
  const nested = asModule(text(['function f() {', '  try {', '    g();', '  } catch (a) {', '    try {', '      h();', '    } catch (a) {', '      var a;', '      out({ a });', '    }', '  }', '}', 'f();']))
  assert.equal(renameMap(nested, nested).text, nested, 'the same file reads as it is')
})

test('outside strict code a function declared in a block gives no names, as it sets its function\'s variable too', () => {
  // Renaming the block's `a` to `b` would have it set the function's `var b`: `f(true)` returning a function.
  const sloppy = ['function f(x) {', '  var b = 1;', '  if (x) {', '    function a() {}', '  }', '  return b;', '}', 'module.exports = f;']
  const renamed = sloppy.map(line => line.replace('function a()', 'function b()'))
  assert.equal(renameMap(text(sloppy), text(renamed)).reason, 'block-function')
  assert.equal(renameMap('if (x) function a() {}\nmodule.exports = 1;\n', 'if (x) function b() {}\nmodule.exports = 1;\n').reason, 'block-function', 'one an `if` holds')
  for (const strict of [['"use strict";', ...sloppy], sloppy.map(line => line.replace('function f(x) {', 'function f(x) {\n  "use strict";'))]) {
    assert.equal(renameMap(text(strict), text(strict)).reason, undefined, 'strict code\'s are their blocks\' alone')
  }
  for (const late of [['0;', '"use strict";', ...sloppy], sloppy.map(line => line.replace('function f(x) {', 'function f(x) {\n  g();\n  "use strict";'))]) {
    assert.equal(renameMap(text(late), text(late)).reason, 'block-function', '"use strict" past a statement says nothing')
  }
  assert.equal(renameMap(asModule(text(sloppy.slice(0, 7))), asModule(text(sloppy.slice(0, 7)))).reason, undefined, 'a module is strict')
  assert.equal(renameMap('class C { m() { if (x) { function a() {} } } }\nmodule.exports = C;\n', 'class C { m() { if (x) { function a() {} } } }\nmodule.exports = C;\n').reason, undefined,
    'so is a class')
})
