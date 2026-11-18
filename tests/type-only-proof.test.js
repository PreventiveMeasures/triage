// What a declaration file runs, as the server tells it of a change in types
// alone (server-managed/type-only-proof.js) and as Compare's Code view shows
// it, its types set aside (ui/view/bundle-compare-code-model.js typeFolds):
// no line that may have a side effect -- a load of a module, an `export {}`
// or `export default`, a hashbang, a directive or a pragma -- is ever set
// aside, nor is a file whose such lines changed told as changed in types
// alone.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import { parseSync } from 'oxc-parser'
import { proofsSoFar } from '../server-managed/type-only.ts'
import { typeOnlyRuns, typeOnlyStamped } from '../server-managed/type-only-proof.js'
import { textLines, typeFolds } from '../ui/view/bundle-compare-code-model.js'

const zodDeclarations = "import { z } from 'zod';\nexport declare const UserSchema: z.ZodObject<{\n    id: z.ZodString;\n}>;\nexport type User = z.infer<typeof UserSchema>;\n//# sourceMappingURL=user.d.ts.map\n"
const declared = text => ({ path: 'x.d.ts', text })
// The lines of a text told as running, by their text; false where it isn't proven.
const told = text => {
  const runs = typeOnlyRuns(null, declared(text))
  return runs && runs.otherRuns.flatMap(([from, to]) => textLines(text).slice(from, to))
}

test('a type-only import or export loads nothing and is set aside; one with inline type specifiers loads its module all the same and is told', () => {
  const T = 'export type T = 1;\n'
  for (const form of ["import type { A } from 'a';", "import type D from 'd';", "import type * as N from 'n';", "export type { A } from 'e';", "export type * from 'i';",
    "export type * as N from 'k';", "import type y = require('y');", 'export declare const x: number;', "declare module 'm' {\n  import 'inner';\n}"]) {
    assert.deepEqual(told(`${T}${form}\n${T}`), [], `${form}: set aside`)
    assert.equal(typeOnlyStamped(declared(`${T}${T}`), declared(`${T}${form}\n${T}`)), true, `${form}: added, a change in types alone`)
  }
  for (const form of ["import { type A } from 'a';", "import { type A, B } from 'b';", "export { type A } from 'f';", "import * as ns from 'ns';", "import d from 'd';",
    "export { B } from 'g';", "export * from 'h';", "export * as ns from 'j';", 'export {};', "import { a } from 'q' with { type: 'json' };"]) {
    assert.deepEqual(told(`${T}${form}\n${T}`), [form], `${form}: told`)
    assert.equal(typeOnlyStamped(declared(T), declared(`${T}${form}\n`)), false, `${form}: added, no change in types alone`)
  }
  const [inline, typeOnly] = ["import { type A } from 'a';\nexport declare const x: A;\n", "import type { A } from 'a';\nexport declare const x: A;\n"]
  assert.equal(typeOnlyStamped(declared(typeOnly), declared(inline)), false, 'a type-only import made one with an inline type specifier loads its module, no change in types alone')
  assert.equal(typeOnlyStamped(declared(inline), declared(typeOnly)), false, 'nor one made type-only, which no longer loads it')
  assert.deepEqual(typeOnlyRuns(declared(typeOnly), declared(inline)), { runs: [], otherRuns: [[0, 1]] })
  assert.equal(typeOnlyStamped(declared(inline), declared(inline.replace('type A', 'type B').replace(': A', ': B'))), true, 'its inline type renamed, it loads what it did')
  for (const code of ["import x = require('x');", "import 'side';", "import {} from 'e';", "export {} from 'e';", 'export = z;', 'export as namespace U;', 'export enum E { A }',
    'interface A {}\nexport { A };']) {
    assert.equal(told(`${T}${code}\n`), false, `${code}: not proven, its file's diff drawn whole`)
  }
})

test('a line holding anything that runs is told whole, however lines are broken and whatever else it holds', () => {
  const cases = [
    ["export type A = 1; import { b } from 'b';\nexport type C = 2;\n", ["export type A = 1; import { b } from 'b';"], 'a load past a line separator, on its line as the view splits it'],
    ["export type A = 1;\r\nimport { b } from 'b';\r\nexport type C = 2;\r\n", ["import { b } from 'b';\r"], 'CRLF'],
    ["export type A = {\n  a: 1;\n}; import { b } from 'b';\nexport type C = 2;\n", ["}; import { b } from 'b';"], 'a load after a type, on its last line'],
    ["import {\n  // why\n  type A,\n  /* and */ b,\n} from\n  'q';\nexport type C = 2;\n", ['import {', '  // why', '  type A,', '  /* and */ b,', '} from', "  'q';"], 'a load across lines'],
    ["﻿#!/usr/bin/env node\nexport type A = 1;\nimport { b } from 'b';", ['﻿#!/usr/bin/env node', "import { b } from 'b';"], 'a hashbang past a byte order mark, and no newline at the end'],
    ["export type A = 1; /*# sourceMappingURL=x.map */\nexport type C = 2;\n", ['export type A = 1; /*# sourceMappingURL=x.map */'], 'a pragma ending a line'],
  ]
  for (const [text, lines, said] of cases) assert.deepEqual(told(text), lines, said)
  assert.deepEqual(told("export type A = 1;\rimport { b } from 'b';\r"), ["export type A = 1;\rimport { b } from 'b';\r"], 'lines broken by CR alone, one line as the view splits them')
  assert.deepEqual(told("export type A = `import { a } from 'b'`;\n"), [], 'a type that spells a load, loading nothing')
})

// All a worker of `pairs` tells, in order, until it is gone.
async function workerTold(pairs, runsUntil) {
  const worker = new Worker(new URL('../server-managed/type-only-worker.js', import.meta.url), { workerData: { pairs, runsUntil }, execArgv: ['--disable-warning=ExperimentalWarning'] })
  const messages = []
  worker.on('message', message => messages.push(message))
  await once(worker, 'exit')
  return messages
}

test('every pair is stamped and its stamp told before what runs is worked out, of a pair at a time while there is time left, the smallest files first', async () => {
  const zod = { runs: [], otherRuns: [[0, 1], [5, 6]] }
  const pairs = [[declared('export type A = 1;\n'), declared('export type A = 2;\n')], [null, declared(zodDeclarations)]]
  assert.deepEqual(await workerTold(pairs, Date.now() + 60_000), [{ stamped: [true, false] }, { at: 1, ...zod }, [true, zod]], 'its stamps, then what runs of each not stamped, then its answer')
  assert.deepEqual(await workerTold(pairs, Date.now() - 1), [{ stamped: [true, false] }, [true, false]], 'past its time, told as not stamped, the stamp kept')
  assert.deepEqual(await workerTold(pairs, null), [{ stamped: [true, false] }, [true, false]], 'and where it isn\'t asked for')
  const [large, small] = [`import { a } from 'a';\n${'export type T = 1;\n'.repeat(50)}`, "import { b } from 'b';\nexport type T = 1;\n"]
  const sized = await workerTold([[null, declared(large)], [null, declared('console.log(1);\n')], [null, declared(small)]], Date.now() + 60_000)
  assert.deepEqual(sized.slice(1, -1).map(({ at }) => at), [2, 0], 'the smaller file\'s first, none told of one that runs code')
  assert.deepEqual(sized.at(-1), [{ runs: [], otherRuns: [[0, 1]] }, false, { runs: [], otherRuns: [[0, 1]] }], 'its answer by pair all the same')
})

test('a worker gone before its answer is answered for as far as it told: every stamp, and what runs of each pair it came to', async () => {
  const zod = { runs: [], otherRuns: [[0, 1], [5, 6]] }
  const pairs = [[declared('export type A = 1;\n'), declared('export type A = 2;\n')], [null, declared(zodDeclarations)], [null, declared(`${zodDeclarations}export type More = 1;\n`)]]
  const messages = await workerTold(pairs, Date.now() + 60_000)
  const early = proofsSoFar(pairs.length)
  assert.deepEqual(early(messages[0]), [true, false, false], 'its stamps alone, should what runs of the first file take past its deadline')
  assert.deepEqual(early(messages[1]), [true, zod, false], 'and what runs of each pair as it comes')
  assert.deepEqual(early(messages[2]), [true, zod, zod])
  assert.equal(early(messages.at(-1)), null, 'its answer is not one to settle for: taken as its answer')
  assert.deepEqual(messages.at(-1), [true, zod, zod])
  // Nothing is taken that does not read as what a worker of these pairs tells.
  for (const [said, why] of [[{ at: 1, ...zod }, 'what runs before any stamp'], [{ stamped: [true] }, 'stamps of other pairs'], [{ stamped: [true, 1, false] }, 'a stamp that is none'], [null, 'nothing'],
    ['stamped', 'a word']]) assert.equal(proofsSoFar(3)(said), null, why)
  const taken = proofsSoFar(3)
  assert.deepEqual(taken({ stamped: [true, false, false] }), [true, false, false])
  for (const [said, why] of [[{ stamped: [false, false, false] }, 'stamps told again'], [{ at: 0, ...zod }, 'what runs of a pair stamped'], [{ at: 3, ...zod }, 'of a pair not there'],
    [{ at: 1.5, ...zod }, 'of no pair'], [{ at: 1, runs: [[1, 0]], otherRuns: [] }, 'lines that are none'], [{ at: 1, runs: [] }, 'one side\'s alone']]) assert.equal(taken(said), null, why)
  assert.deepEqual(taken({ at: 1, ...zod }), [true, zod, false])
  assert.equal(taken({ at: 1, runs: [], otherRuns: [[0, 2]] }), null, 'nor what runs of a pair told twice')
})

// tsc ends a declaration file with a comment naming its own map: set aside with its types, and no other.
test('a declaration file\'s own source map comment, its last line, is set aside with its types; any other is told', () => {
  const own = '//# sourceMappingURL=user.d.ts.map', types = 'export type A = 1;\n'
  const at = text => ({ path: 'dist/user.d.ts', text })
  for (const text of [`${types}${own}\n`, `${types}${own}`, `﻿${own}\n`]) assert.equal(typeOnlyStamped(null, at(text)), true, JSON.stringify(text))
  assert.equal(typeOnlyStamped(at(`${types}${own}\n`), at(`${types}${own}`)), true, 'the newline after it gone alone')
  assert.equal(typeOnlyStamped(at(types), at(`${types}${own}\n`)), true, 'it added alone')
  assert.deepEqual(typeOnlyRuns(null, at(`import { z } from 'zod';\n${types}${own}\n`)), { runs: [], otherRuns: [[0, 1]] }, 'its line among the types')
  for (const text of [`${types}//# sourceMappingURL=other.d.ts.map\n`, `${types}//@ sourceMappingURL=user.d.ts.map\n`, `${types}/*# sourceMappingURL=user.d.ts.map */\n`,
    `${types}//# sourceMappingURL= user.d.ts.map\n`, `${types}${own}\r\n`, `${types}${own}\n\n`, `${types}${own} \n`, `${types}${own}\nexport type B = 2;\n`]) {
    assert.equal(typeOnlyStamped(null, at(text)), false, JSON.stringify(text))
    assert.ok(typeOnlyRuns(null, at(text)).otherRuns.length > 0, `told: ${JSON.stringify(text)}`)
  }
  assert.equal(typeOnlyStamped(at(`let x = 1;\n${own}\n`), at(`let x = 1;\n${own}`)), false, 'nor is a file that runs code, its comment changed alone')
})

test('the lines that run are those Node\'s type stripping leaves, the hashbang, and each comment it keeps that may be one a tool reads, whatever the proof\'s grammar for it', () => {
  const text = '#!/usr/bin/env node\n/** A type. */\nexport type A = 1;\nimport {\n  type B,\n  C,\n} from \'./c\';\n/// <REFERENCE types="node" />\n// a note\nexport interface D {\n  /*# sourceURL=x */\n}\n//@ sourceMappingURL=d.ts.map\n'
  assert.deepEqual(typeOnlyRuns(null, { path: 'x.d.ts', text }), { runs: [], otherRuns: [[0, 1], [3, 8], [12, 13]] },
    'a directive below the first statement told, though it steers nothing there; none erased with a declaration, nor its prose')
  assert.deepEqual(typeOnlyRuns(null, { path: 'x.d.ts', text: `\uFEFF${text}` }), { runs: [], otherRuns: [[0, 1], [3, 8], [12, 13]] }, 'past a byte order mark alike')
  assert.equal(typeOnlyRuns(null, { path: 'x.ts', text }), false, 'none of a file not named as a declaration file')
  assert.equal(typeOnlyRuns(null, { path: 'x.d.ts', text: `${text}console.log(1);\n` }), false, 'nor of one that runs code')
})

test('none are told where a triple-slash directive steers on one side alone though its line reads the same on both', () => {
  const directive = '/// <reference path="./more.d.ts" />'
  const [load, loads] = ["import { a } from 'a';\n", "import { a } from 'a';\nimport { b } from 'b';\n"]
  const below = `export type X = 1;\n${directive}\n${load}export type Y = 1;\n`
  const leading = `${directive}\n${loads}export type Y = 2;\n`
  // Its line would show unchanged between an import added and types set aside, the statement that kept it from steering among them.
  assert.equal(typeOnlyStamped(declared(below), declared(leading)), false, 'no change in types alone: it steers now')
  assert.equal(typeOnlyRuns(declared(below), declared(leading)), false, 'come to lead the file: drawn whole')
  assert.equal(typeOnlyRuns(declared(leading), declared(below)), false, 'and gone below a statement')
  assert.equal(typeOnlyRuns(declared(`import {\n  ${directive}\n  a } from 'a';\n`), declared(leading)), false, 'or within one')
  assert.deepEqual(typeOnlyRuns(declared(`${directive}\n${load}export type Y = 1;\n`), declared(leading)), { runs: [[0, 2]], otherRuns: [[0, 3]] }, 'leading both, told')
  assert.deepEqual(typeOnlyRuns(declared(below), declared(`export type Z = 1;\n${directive}\n${loads}`)), { runs: [[1, 3]], otherRuns: [[1, 4]] }, 'below a statement on both, prose on both, told')
  assert.deepEqual(typeOnlyRuns(declared(`${directive}\n${below}`), declared(leading)), { runs: [[0, 1], [2, 4]], otherRuns: [[0, 3]] }, 'said again below a statement where it leads both, told')
  assert.deepEqual(typeOnlyRuns(declared(`export type X = 1;\n${load}`), declared(leading)), { runs: [[1, 2]], otherRuns: [[0, 3]] }, 'added, its line shows as added')
  assert.deepEqual(typeOnlyRuns(null, declared(below)), { runs: [], otherRuns: [[1, 3]] }, 'a side not there has none to differ from')
})

// Files of a declaration file's statements, picked with a seed: types, loads
// and the like, and comments. `{k}` names a binding apart from the file's
// others, `{n}` a module or value two files may share.
const TYPES = ['export type T{k} = { a: {n} };', 'export interface I{k} {\n  a: string;\n}', 'export declare const c{k}: number;', 'export declare function f{k}(): void;',
  'declare global {\n  interface W{k} {}\n}', "declare module 'm{n}' {\n  import 'inner';\n}", "import type { A{k} } from 'a{n}';", "import type D{k} from 'd{n}';",
  "export type { A{k} } from 'e{n}';", "export type * from 'i{n}';", "import type * as TN{k} from 'tn{n}';", '/** doc {n} */', '// note {n}', '']
const RUNS = ["import { type A{k} } from 'a{n}';", "import { type A{k}, B{k} } from 'b{n}';", "import {\n  type A{k},\n  B{k},\n} from 'c{n}';", "import * as ns{k} from 'ns{n}';",
  "import def{k} from 'd{n}';", "export { type A{k} } from 'f{n}';", "export { B{k} } from 'g{n}';", "export * from 'h{n}';", "export * as nsx{k} from 'j{n}';", 'export {};',
  "export type X{k} = 1; import { b{k} } from 'b{n}';", '//# sourceMappingURL=x{n}.map', '//# sourceMappingURL=x.d.ts.map', '/// <reference types="node{n}" />', "import { q{k} } from 'q{n}' with { type: 'json' };"]

// What may have a side effect in a text, read from oxc's tree alone, apart
// from Node's stripping: each statement but one that is plainly a type, and
// each directive and pragma, by its lines; and, in order, those statements as
// what they load and bind, inline type specifiers left out.
const DIRECTIVE = /^\/\/\/\s*<(?:reference|amd-module|amd-dependency)\s/iu
const PRAGMA = /^\/[/*][#@]\s+source(?:Mapping)?URL=\s*\S/u
function plainlyType(statement) {
  switch (statement.type) {
    case 'TSInterfaceDeclaration': case 'TSTypeAliasDeclaration': case 'TSDeclareFunction': return true
    case 'VariableDeclaration': case 'ClassDeclaration': case 'TSEnumDeclaration': case 'TSModuleDeclaration': return statement.declare === true
    case 'ImportDeclaration': case 'TSImportEqualsDeclaration': return statement.importKind === 'type'
    case 'ExportAllDeclaration': return statement.exportKind === 'type'
    case 'ExportNamedDeclaration': return statement.declaration ? plainlyType(statement.declaration) : statement.exportKind === 'type'
    default: return false
  }
}
function sideEffects(text) {
  const { program, comments } = parseSync('x.ts', text, { lang: 'ts', sourceType: 'module' })
  const lineAt = offset => text.slice(0, offset).split('\n').length - 1
  const running = program.body.filter(statement => !plainlyType(statement))
  const lines = new Set()
  const steers = comment => DIRECTIVE.test(text.slice(comment.start, comment.end)) || PRAGMA.test(text.slice(comment.start, comment.end))
  // The file's own source map comment, `x.d.ts`'s, ending it: set aside with its types.
  const ownMap = ({ start, end }) => text.slice(start, end) === '//# sourceMappingURL=x.d.ts.map' && (start === 0 || text[start - 1] === '\n') && /^\n?$/u.test(text.slice(end))
  for (const { start, end } of [...running, ...comments.filter(comment => steers(comment) && !ownMap(comment))]) {
    for (let line = lineAt(start); line <= lineAt(end - 1); line++) lines.add(line)
  }
  // Its directives by whether each leads it, before its first statement, where alone it steers.
  const first = program.body[0]?.start ?? Infinity
  const directives = leads => comments.filter(comment => (comment.start < first) === leads).map(comment => text.slice(comment.start, comment.end)).filter(comment => DIRECTIVE.test(comment))
  const name = node => node?.name ?? node?.value
  const loads = running.map(statement => JSON.stringify([statement.type, statement.source?.value, statement.attributes?.map(({ key, value }) => [name(key), value.value]),
    statement.specifiers?.filter(spec => spec.importKind !== 'type' && spec.exportKind !== 'type').map(spec => [spec.type, name(spec.imported), name(spec.local), name(spec.exported)]),
    name(statement.exported), statement.type === 'ExportDefaultDeclaration' ? name(statement.declaration) : null]))
  return { lines: [...lines], loads, steering: directives(true), prose: directives(false) }
}

test('no line that may have a side effect is set aside, nor is a change to one told as a change in types alone or left to read as no change, over pairs of files picked at random', () => {
  let seed = 7919
  const pick = n => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return Math.floor(seed / 2 ** 31 * n) }
  const file = () => {
    const parts = []
    for (let count = pick(9), k = 0; k < count; k++) {
      const pool = pick(3) === 0 ? RUNS : TYPES
      parts.push(pool[pick(pool.length)].replaceAll('{k}', k).replaceAll('{n}', pick(3)))
    }
    return declared(parts.map(part => `${part}\n`).join(''))
  }
  const inRanges = (ranges, line) => ranges.some(([from, to]) => line >= from && line < to)
  const seen = { stamped: 0, set: 0 }
  for (let round = 0; round < 1500; round++) {
    const [a, b] = [file(), file()]
    if (a.text === b.text) continue
    const [before, after] = [sideEffects(a.text), sideEffects(b.text)]
    const pair = JSON.stringify([a.text, b.text])
    if (typeOnlyStamped(a, b)) {
      assert.deepEqual(after.loads, before.loads, `told as a change in types alone: ${pair}`)
      seen.stamped++
      continue
    }
    const runs = typeOnlyRuns(a, b)
    if (!runs) continue
    for (const [effects, ranges] of [[before, runs.runs], [after, runs.otherRuns]]) {
      assert.deepEqual(effects.lines.filter(line => !inRanges(ranges, line)), [], `not told: ${pair}`)
    }
    // A directive that steers on one side alone is there on that side alone: its line is none that reads the same on both.
    for (const [one, other] of [[before, after], [after, before]]) {
      assert.deepEqual(one.steering.filter(directive => !other.steering.includes(directive) && other.prose.includes(directive)), [], `a directive steering on one side alone, its line on both: ${pair}`)
    }
    const folds = typeFolds(a.text, b.text, runs)
    if (!folds) continue
    for (const [effects, side] of [[before, 'a'], [after, 'b']]) assert.deepEqual(effects.lines.filter(line => !folds.lineOf[side].includes(line)), [], `set aside: ${pair}`)
    seen.set++
  }
  assert.ok(seen.stamped > 50 && seen.set > 500, JSON.stringify(seen))
})
