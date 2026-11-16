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
import { typeOnlyRuns, typeOnlyStamped } from '../server-managed/type-only-proof.js'
import { textLines, typeFolds } from '../ui/view/bundle-compare-code-model.js'

const zodDeclarations = "import { z } from 'zod';\nexport declare const UserSchema: z.ZodObject<{\n    id: z.ZodString;\n}>;\nexport type User = z.infer<typeof UserSchema>;\n//# sourceMappingURL=user.d.ts.map\n"
const declared = text => ({ path: 'x.d.ts', text })
// The lines of a text told as running, by their text.
const told = text => {
  const runs = typeOnlyRuns(null, declared(text))
  return runs && runs.otherRuns.flatMap(([from, to]) => textLines(text).slice(from, to))
}

test('a type-only import or export loads nothing and is set aside; one with inline type specifiers loads its module all the same and is told', () => {
  const T = 'export type T = 1;\n'
  for (const form of ["import type { A } from 'a';", "import type D from 'd';", "import type * as N from 'n';", "export type { A } from 'e';", "export type * from 'i';",
    "export type * as N from 'k';", "import type y = require('y');", 'export declare const x: number;', "declare module 'm' {\n  import 'inner';\n}"]) {
    assert.equal(told(`${T}${form}\n${T}`), false, `${form}: set aside`)
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
  assert.equal(told("export type A = `import { a } from 'b'`;\n"), false, 'a type that spells a load, loading nothing')
})

test('what runs is worked out only while there is time left for it, once every pair is stamped, none of whose stamps it costs', async () => {
  const pairs = [[declared('export type A = 1;\n'), declared('export type A = 2;\n')], [null, declared(zodDeclarations)]]
  const answer = async runsUntil => {
    const worker = new Worker(new URL('../server-managed/type-only-worker.js', import.meta.url), { workerData: { pairs, runsUntil }, execArgv: ['--disable-warning=ExperimentalWarning'] })
    const [answered] = await once(worker, 'message')
    await worker.terminate()
    return answered
  }
  assert.deepEqual(await answer(Date.now() + 60_000), [true, { runs: [], otherRuns: [[0, 1], [5, 6]] }])
  assert.deepEqual(await answer(Date.now() - 1), [true, false], 'past its time, told as not stamped, the stamp kept')
  assert.deepEqual(await answer(null), [true, false], 'and where it isn\'t asked for')
})

test('the lines that run are those Node\'s type stripping leaves, the hashbang, and each comment it keeps that may be one a tool reads, whatever the proof\'s grammar for it', () => {
  const text = '#!/usr/bin/env node\n/** A type. */\nexport type A = 1;\nimport {\n  type B,\n  C,\n} from \'./c\';\n/// <REFERENCE types="node" />\n// a note\nexport interface D {\n  /*# sourceURL=x */\n}\n//@ sourceMappingURL=d.ts.map\n'
  assert.deepEqual(typeOnlyRuns(null, { path: 'x.d.ts', text }), { runs: [], otherRuns: [[0, 1], [3, 8], [12, 13]] },
    'a directive below the first statement told, though it steers nothing there; none erased with a declaration, nor its prose')
  assert.deepEqual(typeOnlyRuns(null, { path: 'x.d.ts', text: `\uFEFF${text}` }), { runs: [], otherRuns: [[0, 1], [3, 8], [12, 13]] }, 'past a byte order mark alike')
  assert.equal(typeOnlyRuns(null, { path: 'x.ts', text }), false, 'none of a file not named as a declaration file')
  assert.equal(typeOnlyRuns(null, { path: 'x.d.ts', text: `${text}console.log(1);\n` }), false, 'nor of one that runs code')
})

// Files of a declaration file's statements, picked with a seed: types, loads
// and the like, and comments. `{k}` names a binding apart from the file's
// others, `{n}` a module or value two files may share.
const TYPES = ['export type T{k} = { a: {n} };', 'export interface I{k} {\n  a: string;\n}', 'export declare const c{k}: number;', 'export declare function f{k}(): void;',
  'declare global {\n  interface W{k} {}\n}', "declare module 'm{n}' {\n  import 'inner';\n}", "import type { A{k} } from 'a{n}';", "import type D{k} from 'd{n}';",
  "export type { A{k} } from 'e{n}';", "export type * from 'i{n}';", "import type * as TN{k} from 'tn{n}';", '/** doc {n} */', '// note {n}', '']
const RUNS = ["import { type A{k} } from 'a{n}';", "import { type A{k}, B{k} } from 'b{n}';", "import {\n  type A{k},\n  B{k},\n} from 'c{n}';", "import * as ns{k} from 'ns{n}';",
  "import def{k} from 'd{n}';", "export { type A{k} } from 'f{n}';", "export { B{k} } from 'g{n}';", "export * from 'h{n}';", "export * as nsx{k} from 'j{n}';", 'export {};',
  "export type X{k} = 1; import { b{k} } from 'b{n}';", '//# sourceMappingURL=x{n}.map', '/// <reference types="node{n}" />', "import { q{k} } from 'q{n}' with { type: 'json' };"]

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
  for (const { start, end } of [...running, ...comments.filter(steers)]) {
    for (let line = lineAt(start); line <= lineAt(end - 1); line++) lines.add(line)
  }
  const name = node => node?.name ?? node?.value
  const loads = running.map(statement => JSON.stringify([statement.type, statement.source?.value, statement.attributes?.map(({ key, value }) => [name(key), value.value]),
    statement.specifiers?.filter(spec => spec.importKind !== 'type' && spec.exportKind !== 'type').map(spec => [spec.type, name(spec.imported), name(spec.local), name(spec.exported)]),
    name(statement.exported), statement.type === 'ExportDefaultDeclaration' ? name(statement.declaration) : null]))
  return { lines: [...lines], loads }
}

test('no line that may have a side effect is set aside, nor is a change to one told as a change in types alone, over pairs of files picked at random', () => {
  let seed = 7919
  const pick = n => { seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31; return seed % n }
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
    const folds = typeFolds(a.text, b.text, runs)
    if (!folds) continue
    for (const [effects, side] of [[before, 'a'], [after, 'b']]) assert.deepEqual(effects.lines.filter(line => !folds.lineOf[side].includes(line)), [], `set aside: ${pair}`)
    seen.set++
  }
  assert.ok(seen.stamped > 50 && seen.set > 500, JSON.stringify(seen))
})
