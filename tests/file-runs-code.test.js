import assert from 'node:assert/strict'
import { test } from 'node:test'
import { npmRunsCode, npmRunsCodeFlags } from '../ui/view/file-runs-code.js'

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
  assert.deepEqual(found('a.js', 'Function/* webpack */("return payload")()\nnew Function// note\n("x")\nf(...eval(y))\n'), { eval: [4], function: [1, 2] },
    'a comment before its arguments, and spread')
  assert.deepEqual(found('a.js', 'globalThis /* webpack */ . eval(payload)\nwindow/* note */.Function("x")()\n'), { eval: [1], function: [2] },
    'a comment in the global object\'s access')
  assert.deepEqual(found('a.js', 'require ( \'child_process\' )\n__require("child_process")\nimport \'node:child_process\'\nexport { spawn } from "child_process"\n'),
    { 'child-process': [1, 2, 3, 4] }, 'loaded however a module is')
  assert.deepEqual(found('a.js', 'require?.("child_process")\n__require ?. (\'child_process\')\n'), { 'child-process': [1, 2] }, 'required optionally')
  assert.deepEqual(found('a.ts', 'require/* bundled */(\'child_process\')\nawait import(/* webpackIgnore: true */ \'child_process\')\nimport type from \'child_process\'\nimport type { A } from \'a\'\nimport { spawn } from \'child_process\'\n'),
    { 'child-process': [1, 2, 3, 5] }, 'comments in how it is loaded; a default named type, and a load after a type-only one')
  assert.deepEqual(found('a.mjs', "import { spawn } from 'node:child_process'\nconst cp = require(\"child_process\")\nawait import(`child_process`)\n"),
    { 'child-process': [1, 2, 3] }, 'a module named by the string that names it, required or imported')
  assert.deepEqual([...npmRunsCode('a.ts', 'npm_publish("npm publish")\nsend(JSON.stringify(process.env))\nprocess.env.NPM_TOKEN\nimport cp from "child_process"\nm._compile(s)\nimport vm from "vm"\nFunction(y)\neval(x)\n')],
    [['eval', [8]], ['function', [7]], ['vm', [6]], ['compile', [5]], ['child-process', [4]], ['credentials', [3]], ['env', [2]], ['publish', [1]]], 'in RUNS_CODE\'s order')
  assert.deepEqual(found('a.js', 'eval(a); eval(b)\n\neval(c)\n'), { eval: [1, 3] }, 'a line once')
  assert.deepEqual(found('bin/cli', '#!/usr/bin/env node\nrequire("child_process").execSync("ls")\n'), { 'child-process': [2] },
    'a script node runs by its hashbang, with no extension')
})

test('a file\'s kinds as its flags, a shared tag once, the whole environment and publishing critical', () => {
  assert.deepEqual(npmRunsCodeFlags(npmRunsCode('a.js', 'eval(a)\nFunction(b)\nrequire("vm")\nsend(JSON.stringify(process.env))\nexecSync("npm publish")\nreadFileSync(".npmrc")\n')),
    [{ name: 'eval', severity: 'high' }, { name: 'credentials', severity: 'high' }, { name: 'whole env', severity: 'critical' }, { name: 'publish', severity: 'critical' }])
  assert.deepEqual(npmRunsCodeFlags(null), [], 'none for none')
})

test('vm loaded, and Module\'s _compile called or hooked, run a string as code', () => {
  assert.deepEqual(found('a.js', 'const vm = require(\'vm\')\nimport { runInNewContext } from \'node:vm\'\nmodule._compile(source, filename)\nModule.prototype._compile = function () {}\nm . _compile(s)\n'),
    { vm: [1, 2], compile: [3, 4, 5] })
  assert.equal(found('a.js', 'const name = \'vm\'\nobj.vm\nx._compiled\n// require(\'vm\')\nconst _compile = 1\n'), null, 'a module named, not loaded, and other names')
  assert.deepEqual(found('a.ts', 'type Compile = typeof Module.prototype._compile\nconst original = Module.prototype._compile\nif (m._compile === f) g()\noriginal.call(this, s)\nm._compile.call(m, s, f)\n'),
    { compile: [5] }, 'not named in a type, kept or compared, only called or hooked')
})

test('credentials: a credential file\'s path, a token\'s name; and the environment read out whole', () => {
  assert.deepEqual(found('a.js', 'fs.readFileSync(path.join(os.homedir(), \'.npmrc\'))\nconst key = \'~/.ssh/id_rsa\'\nconst aws = `${home}/.aws/credentials`\n'
    + 'process.env.NPM_TOKEN\nprocess.env[\'GITHUB_TOKEN\']\nconst { NPM_TOKEN } = process.env\n'), { credentials: [1, 2, 3, 4, 5, 6] })
  assert.deepEqual(found('a.js', 'post(JSON.stringify(process.env))\nObject.entries(process.env)\nnew URLSearchParams(process.env)\nObject.values( process . env )\n'),
    { env: [1, 2, 3, 4] }, 'the environment\'s values read out whole, a kind of its own')
  assert.deepEqual(found('a.js', 'fetch(url, { body: JSON.stringify({ ...process.env }) })\nnew URLSearchParams({ ...process.env, host })\n'), { env: [1, 2] },
    'a copy of them read out')
  assert.equal(found('a.js', 'process.env.NODE_ENV\nspawn(c, { env: process.env })\nspawn(c, { env: { ...process.env, X: 1 } })\nif (\'HOME\' in process.env) f()\n'
    + 'JSON.stringify(process.env.X)\nObject.values(process.env[name])\nObject.keys(process.env).filter(key => /^debug_/iu.test(key))\nfor (const name in process.env) f(name)\n'), null,
    'one variable, the environment handed to a program, or its names listed')
  assert.equal(found('a.js', 'const proxy = Object.entries(process.env).reduce((found, [key, value]) => found, {})\n'
    + 'Object.values(process.env).some(value => value === x)\nObject.entries( process.env )\n  .filter(([key]) => key.startsWith(\'APP_\'))\n'), null,
    'its entries or values picked among as they are read, as npm\'s agent finds its proxy\'s')
  assert.deepEqual(found('a.js', 'Object.entries(process.env).map(([k, v]) => `${k}=${v}`)\nfor (const [k, v] of Object.entries(process.env)) send(k, v)\n'),
    { env: [1, 2] }, 'not where they are turned or looped over')
  assert.equal(found('a.js', '// export NPM_TOKEN=…\nconst s = \'project.npmrc s3.amazonaws.com MY_NPM_TOKEN .sshd\'\nconst re = /\\.npmrc$/u\n'), null,
    'in a comment, or a name or path of another')
  assert.equal(found('a.js', 'const x = `${/* NPM_TOKEN */ value}`\nconst y = `a ${/npm publish/.test(s)} b`\n'), null,
    'in a template\'s substitution\'s comment or regular expression, its code read as code')
  assert.deepEqual(found('a.js', 'const p = `${home}/.npmrc`\nconst q = `${f(\'~/.ssh\')} and ${x}`\nconst t = `\n${y}\nnpm publish`\n'), { credentials: [1, 2], publish: [5] },
    'in a template\'s text, and in a string in its substitution, on its own line')
})

test('publishing: npm publish, the registry\'s whoami, libnpmpublish, a PUT where the file names the registry', () => {
  assert.deepEqual(found('a.js', 'execSync(\'npm publish --access public\')\nspawn(\'npm\', [\'publish\'])\nconst c = `pnpm publish ${dir}`\n'
    + 'fetch(\'https://registry.npmjs.org/-/whoami\', { headers })\nconst { publish } = require(\'libnpmpublish\')\n'), { publish: [1, 2, 3, 4, 5] })
  assert.deepEqual(found('a.js', 'const registry = \'https://registry.npmjs.org/\'\nfetch(registry + name, { method: \'PUT\', body })\naxios.put(url, body)\noptions.method = "put"\n'),
    { publish: [2, 3, 4] }, 'a PUT, the registry named in the file')
  assert.deepEqual(found('a.js', 'spawn(\'npm\', [/* explain */ \'publish\'])\nexecFile("pnpm", // why\n  ["publish"])\nspawn(\'npm\', [run, \'publish\'])\n'), { publish: [1, 3] },
    'comments between its program and arguments, not another argument')
  assert.deepEqual(found('a.js', 'execSync(\'npm --silent publish\')\nexecSync(`npm --tag=next --access public publish ${dir}`)\nspawn(\'npm\', [\'--tag\', \'next\', \'publish\'])\nspawn(\'npm\', [\'--silent\', \'publish\'])\n'),
    { publish: [1, 2, 3, 4] }, 'npm\'s options before it, and their values')
  assert.equal(found('a.js', 'spawn(\'npm\', [\'install\', \'publish\'])\nexecSync(\'npm install publish\')\n'), null, 'another command\'s argument named publish')
  assert.equal(found('a.js', 'fetch(url, { method: \'PUT\' })\naxios.put(url, body)\nbus.publish(\'topic\')\nconst commands = [\'publish\']\n'), null,
    'a PUT where the file names no registry, and publish not run by npm')
  assert.equal(found('a.js', 'const methods = [\'GET\', \'PUT\']\nconst registry = \'https://registry.npmjs.org/\'\nfetch(registry + \'-/v1/search\')\n'), null,
    'PUT named, not a request\'s method')
})

test('a template literal\'s substitutions are code, read as their own, its text not', () => {
  assert.deepEqual(found('a.js', 'const t = `${eval(payload)}`\n'), { eval: [1] })
  assert.deepEqual(found('a.js', 'const t = `a ${x} b ${require(\'child_process\').exec(c)}`\n'), { 'child-process': [1] }, 'a module named in one')
  assert.deepEqual(found('a.js', 'const t = `one\n${\n  "}" + Function(y)\n}`\n'), { function: [3] }, 'to the brace that closes it, its line the file\'s')
  for (const substitution of ['/* } */ eval(payload)', ' /* } */ eval(payload)', 'x // }\n eval(payload)', '/}/.test(x) && eval(payload)', "'}' + eval(payload)", '{ a: 1 }.a + eval(payload)']) {
    assert.deepEqual(found('a.js', `const t = \`\${${substitution}}\`\n`), { eval: [substitution.split('\n').length] },
      `braces in a comment, a regular expression, a string or balanced aside: ${substitution}`)
  }
  assert.equal(found('a.js', 'const t = `\\${eval(x)} eval(y) ${f("eval(")} ${/* eval(z) */ w}`\n'), null, 'not an escaped one, nor a string or comment in one')
  assert.deepEqual(found('a.js', 'const t = `\\\\${eval(x)}`\n'), { eval: [1] }, 'after an escaped backslash, live')
  assert.deepEqual(found('a.js', 'const t = `a \\\n${eval(x)}`\n'), { eval: [2] }, 'after a line continuation')
  assert.deepEqual(found('a.js', 'const t = `a \\\r\n${eval(x)}`\r\n'), { eval: [2] }, 'after a CRLF continuation')
})

test('a name read as another or as a property, or in a string, a regular expression or a comment, is none', () => {
  assert.equal(found('a.js', 'vm.eval(x); evaluate(); myeval(); obj.eval\nx.Function(1); Function.prototype.call\n'), null)
  assert.equal(found('a.js', 'vm . eval(payload)\nvm.\neval(p)\nobj . Function("x")\nobj?. Function("y")\nobj./* c */eval(z)\n'), null, 'a property after blanks or a comment too')
  assert.equal(found('a.js', 'const builtin = "child_process"\nconst builtins = [\'fs\', \'child_process\']\n'), null, 'a module named, not loaded')
  assert.equal(found('a.ts', 'import type { ChildProcess } from \'node:child_process\'\nexport type { ChildProcess as CP } from "child_process"\n'
    + 'import /* explanation */ type { ChildProcess } from \'node:child_process\'\nexport /* c */ type { CP } from "child_process"\n'), null,
    'a type-only import or export, erased, comments in it or not')
  assert.deepEqual(found('a.ts', 'import typeX from \'child_process\'\n'), { 'child-process': [1] }, 'a default named typeX')
  assert.equal(found('a.ts', 'import type cp = require(\'child_process\')\n'), null, 'a type-only import-equals, erased')
  assert.deepEqual(found('a.ts', 'import cp = require(\'child_process\')\nimport type = require("child_process")\n'), { 'child-process': [1, 2] },
    'an import-equals, and one named type')
  assert.equal(found('a.js', "const s = 'a \\\r\neval(x)'\r\nconst d = \"b \\\r\nFunction(y)\"\r\n"), null, 'a string continued past a CRLF')
  assert.equal(found('a.js', '// eval(x)\n/* new Function(a) */\nconst s = "eval(" + \'Function(\'\nconst re = /eval\\(/u\n'), null)
  assert.equal(found('a.js', 'const docs = "see child_process"\n// require("child_process")\n'), null, 'a string naming a module only where it is one')
  assert.equal(found('a.js', "const s = 'a \\\neval(x)'\nconst d = \"b \\\nFunction(y)\"\n"), null, 'a string continued on the next line')
})

test('a declaration file is read as node runs it, its types stripped', () => {
  assert.deepEqual(found('index.d.ts', 'export declare const x: number\neval(payload)\nimport { spawn } from \'child_process\'\n'), { eval: [2], 'child-process': [3] })
  assert.equal(found('lib.d.ts', 'declare function eval(x: string): any\nfunction /* c */ eval() {}\nimport type { ChildProcess } from \'child_process\'\n'), null,
    'a function named eval, declared, and a type-only import, both stripped')
  assert.equal(found('lib.dom.d.ts', 'interface I {\n    eval?: Values;\n}\n'), null, 'a property typed optional')
  assert.deepEqual(found('a.js', 'const run = c ? eval : f\n'), { eval: [1] }, 'eval chosen in a ternary')
})

test('what is no script runs nothing: prose, data', () => {
  assert.equal(found('README.md', 'Never call eval(x); use child_process carefully.\n'), null)
  assert.equal(found('data.json', '{"eval(":1}\n'), null)
  assert.equal(found('a.js', undefined), null, 'binary')
  assert.equal(found('a.js', 'module.exports = {}\n'), null)
})

test('a text reads in time as its length, what is left open read to its end', { timeout: 10_000 }, () => {
  // Each took minutes to read when a lookbehind scanned back over each blank
  // run anew, or a comment, a regular expression's class or a string left
  // open was tried again from each later slash or quote.
  for (const [text, runs] of [
    [`x${' '.repeat(1e6)}eval(1)\n`, { eval: [1] }],
    [`vm.${' '.repeat(1e6)}eval(1)\n`, null],
    [`${'Function/*'.repeat(1e5)}\neval(1)\n`, null],
    [`${'[/'.repeat(5e5)}\neval(1)\n`, { eval: [2] }],
    [`"${'\\"'.repeat(5e5)}\neval(1)\n`, { eval: [2] }],
    [`\`${'\\`'.repeat(5e5)}\neval(1)\n`, null],
  ]) assert.deepEqual(found('a.js', text), runs)
  for (const [text, runs] of [
    [`${"'npm', 'publish', ".repeat(1e5)}\n`, { publish: [1] }],
    [`${"{ method: 'PUT' }, ".repeat(1e5)}'registry.npmjs.org'\n`, { publish: [1] }],
    [`${'JSON.stringify( '.repeat(1e5)}process.env)\n`, { env: [1] }],
    [`'npm'${' '.repeat(1e6)}'publish'\n`, { publish: [1] }],
    [`'${'npm --a '.repeat(1e5)}publish'\n`, { publish: [1] }],
  ]) assert.deepEqual(found('a.js', text), runs)
  // A minute, when each hit copied those before it.
  assert.equal(npmRunsCode('a.js', 'eval(x)\n'.repeat(1e5)).get('eval').length, 1e5, 'as many hits as lines')
})
