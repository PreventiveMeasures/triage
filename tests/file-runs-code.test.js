import assert from 'node:assert/strict'
import { test } from 'node:test'
import { npmRunsCode } from '../ui/view/file-runs-code.js'

const found = (path, text) => {
  const runs = npmRunsCode(path, text)
  return runs && Object.fromEntries(runs)
}

test('a script is read for eval, Function and child_process, each with the lines it is on', () => {
  assert.deepEqual(found('a.js', 'const y = (0, eval)(code)\nwindow.eval(a)\nglobalThis . eval(b)\nglobalThis?.eval(c)\n'), { eval: [1, 2, 3, 4] })
  assert.deepEqual(found('a.js', 'new Function("return this")()\nconst f = Function("a", "b")\nnew window.Function(c)\n'),
    { function: [1, 2, 3] }, 'with new or without, as the global object\'s too')
  assert.deepEqual(found('a.js', 'Function?.("return payload")()\nglobalThis.Function?.("x")()\nFunction.call(null, "y")\nFunction.apply(null, ["z"])\neval?.(w)\n'),
    { eval: [5], function: [1, 2, 3, 4] }, 'called optionally, or by its call or apply')
  assert.deepEqual(found('a.js', 'window?.Function("x")()\nself?.Function?.("y")()\n'), { function: [1, 2] }, 'the global object\'s, reached optionally')
  assert.deepEqual(found('a.mjs', "import { spawn } from 'node:child_process'\nconst cp = require(\"child_process\")\nawait import(`child_process`)\n"),
    { 'child-process': [1, 2, 3] }, 'a module named by the string that names it, required or imported')
  assert.deepEqual(found('a.ts', 'eval(x)\nimport cp from "child_process"\n'), { eval: [1], 'child-process': [2] }, 'in RUNS_CODE\'s order')
  assert.deepEqual(found('a.js', 'eval(a); eval(b)\n\neval(c)\n'), { eval: [1, 3] }, 'a line once')
  assert.deepEqual(found('bin/cli', '#!/usr/bin/env node\nrequire("child_process").execSync("ls")\n'), { 'child-process': [2] },
    'a script node runs by its hashbang, with no extension')
})

test('a template literal\'s substitutions are code, read as their own, its text not', () => {
  assert.deepEqual(found('a.js', 'const t = `${eval(payload)}`\n'), { eval: [1] })
  assert.deepEqual(found('a.js', 'const t = `a ${x} b ${require(\'child_process\').exec(c)}`\n'), { 'child-process': [1] }, 'a module named in one')
  assert.deepEqual(found('a.js', 'const t = `one\n${\n  "}" + Function(y)\n}`\n'), { function: [3] }, 'to the brace that closes it, its line the file\'s')
  for (const substitution of ['/* } */ eval(payload)', '/}/.test(x) && eval(payload)', "'}' + eval(payload)", '{ a: 1 }.a + eval(payload)']) {
    assert.deepEqual(found('a.js', `const t = \`\${${substitution}}\`\n`), { eval: [1] }, `braces in a comment, a regular expression, a string or balanced aside: ${substitution}`)
  }
  assert.equal(found('a.js', 'const t = `\\${eval(x)} eval(y) ${f("eval(")} ${/* eval(z) */ w}`\n'), null, 'not an escaped one, nor a string or comment in one')
})

test('a name read as another or as a property, or in a string, a regular expression or a comment, is none', () => {
  assert.equal(found('a.js', 'vm.eval(x); evaluate(); myeval(); obj.eval\nx.Function(1); Function.prototype.call\n'), null)
  assert.equal(found('a.js', '// eval(x)\n/* new Function(a) */\nconst s = "eval(" + \'Function(\'\nconst re = /eval\\(/u\n'), null)
  assert.equal(found('a.js', 'const docs = "see child_process"\n// require("child_process")\n'), null, 'a string naming a module only where it is one')
})

test('what is no script runs nothing: a declaration file, prose, data', () => {
  assert.equal(found('lib.d.ts', 'declare function eval(x: string): any\n'), null)
  assert.equal(found('README.md', 'Never call eval(x); use child_process carefully.\n'), null)
  assert.equal(found('data.json', '{"eval(":1}\n'), null)
  assert.equal(found('a.js', undefined), null, 'binary')
  assert.equal(found('a.js', 'module.exports = {}\n'), null)
})
