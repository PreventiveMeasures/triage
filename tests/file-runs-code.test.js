import assert from 'node:assert/strict'
import { test } from 'node:test'
import { npmRunsCode } from '../ui/view/file-runs-code.js'

const found = (path, text) => {
  const runs = npmRunsCode(path, text)
  return runs && Object.fromEntries(runs)
}

test('a script is read for eval, Function and child_process, each with the lines it is on', () => {
  assert.deepEqual(found('a.js', 'const y = (0, eval)(code)\nwindow.eval(a)\nglobalThis . eval(b)\n'), { eval: [1, 2, 3] })
  assert.deepEqual(found('a.js', 'new Function("return this")()\nconst f = Function("a", "b")\nnew window.Function(c)\n'),
    { function: [1, 2, 3] }, 'with new or without, as the global object\'s too')
  assert.deepEqual(found('a.mjs', "import { spawn } from 'node:child_process'\nconst cp = require(\"child_process\")\nawait import(`child_process`)\n"),
    { 'child-process': [1, 2, 3] }, 'a module named by the string that names it, required or imported')
  assert.deepEqual(found('a.ts', 'eval(x)\nimport cp from "child_process"\n'), { eval: [1], 'child-process': [2] }, 'in RUNS_CODE\'s order')
  assert.deepEqual(found('a.js', 'eval(a); eval(b)\n\neval(c)\n'), { eval: [1, 3] }, 'a line once')
  assert.deepEqual(found('bin/cli', '#!/usr/bin/env node\nrequire("child_process").execSync("ls")\n'), { 'child-process': [2] },
    'a script node runs by its hashbang, with no extension')
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
