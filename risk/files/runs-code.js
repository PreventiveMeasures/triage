// What a file's code can do beyond itself, for a reviewer: run a string as
// code (eval, Function with new or without, node:vm, Module's _compile) or
// other programs (child_process), reach for credentials (a credential file's
// path, a token's name) or the whole environment, and publish to npm (`npm
// publish`, `/-/whoami`, a registry PUT), as a file's stamps say
// (stamps.js) and a version's findings name what is new to a file.
// A quick read, not a parse: a script's code with its strings, regular
// expressions and comments set aside as script.js tells them, its
// strings read for the paths, names and commands they hold, a module by the
// string naming it where it is loaded (`require('child_process')`,
// `import … from 'node:child_process'`); a declaration file (.d.ts) read as
// TypeScript, as node runs it (stripping its types, `declare function
// eval(…)` among them, a function named, not called). A call written not to
// read as one (`window['ev' + 'al']`) goes unseen, as does one in a template
// literal in another's substitution (`${`${eval(x)}`}`), whose backtick ends
// the outer one as the regular expression telling strings reads it.
//
// Labels to assist a reviewer, making the plain cases less likely to be
// missed, not a check to rely on: code can come to eval, Function,
// child_process, credentials or the registry in more ways than any reading of
// its text tells (a name built as it runs, `(…).constructor('…')`, a module
// required by a name computed, a path or URL put together, the
// registry's host read from config), so a file without a label is not one
// without them.
import { JS_STRING_OR_COMMENT, NPM_MAX_FOUND, lineOf, npmIsScript } from './script.js'

// What may come between a call's parts: blanks and comments
// (`Function/* note */(…)`), each comment ending at its first `*/`.
const COMMENT = String.raw`/\*(?:[^*]|\*(?!/)){0,100}\*/|//[^\n]{0,100}\n`
const GAP = String.raw`(?:\s|${COMMENT})*`
// Function called: as it is, optionally (`Function?.(…)`), or by its call or
// apply (`Function.call(null, …)`), each making a function of its last
// argument.
const FUNCTION_CALLED = String.raw`(?:${GAP}\??\.${GAP}(?:call|apply))?${GAP}(?:\?\.${GAP})?\(`
// But not where the function made returns `this` alone
// (`Function('return this')()`, `new Function("return this;")`): the global
// object, as older code finds it where `globalThis` may not be, lodash's and
// core-js's among them, running nothing of its own.
const GLOBAL_FOUND = String.raw`(?!${GAP}(?<quote>["'\u0060])\s*return\s+this\s*;?\s*\k<quote>${GAP}\))`
// The environment, whole: not one variable of it (`process.env.HOME`,
// `process.env[name]`).
const ENV = String.raw`process${GAP}\.${GAP}env(?![\p{ID_Continue}$])(?!${GAP}(?:\??\.|\[))`
// Its values read out whole (`JSON.stringify(process.env)`,
// `Object.entries(process.env)`, `new URLSearchParams(process.env)`), or a
// copy of them (`JSON.stringify({ ...process.env })`), not as a program is
// handed it (`{ env: process.env }`, `{ ...process.env }`), nor its
// names listed (`Object.keys(process.env)`, as debug picks its DEBUG_ ones),
// nor one variable asked for (`'HOME' in process.env`), nor its entries or
// values picked among as they are read (`Object.entries(process.env)
// .reduce(…)`, as npm's agent finds its proxy's, `.filter(…)`, `.find(…)`).
const PICKED = String.raw`${GAP}\)${GAP}\??\.${GAP}(?:filter|find|findLast|some|every|reduce)(?![\p{ID_Continue}$])`
const COPY = String.raw`(?:\{${GAP}\.\.\.${GAP})?`
const ENV_WHOLE = String.raw`(?=JSON|Object|URLSearchParams)(?<![\p{ID_Continue}$.])(?:JSON${GAP}\.${GAP}stringify|URLSearchParams)${GAP}\(${GAP}${COPY}${ENV}`
  + String.raw`|(?=Object)(?<![\p{ID_Continue}$.])Object${GAP}\.${GAP}(?:values|entries)${GAP}\(${GAP}${COPY}${ENV}(?!${PICKED})`
// Any of RUNS_CODE, as a text may say it.
const SAYS_ANY = new RegExp(String.raw`eval|Function${FUNCTION_CALLED}|vm["'\x60]|_compile|child_process|\.(?:npmrc|ssh|aws)|_TOKEN|(?:stringify|values|entries|URLSearchParams)${GAP}\(${GAP}(?:\{${GAP}\.\.\.${GAP})?process${GAP}\.${GAP}env|publish|whoami|registry\.(?:npmjs\.org|yarnpkg\.com)`, 'u')

// A name read as one, not as a property's (`vm.eval`, `vm . eval`, a spread's
// `...eval` aside) or part of another's (`evaluate`), or as the global
// object's (`window.eval`, `globalThis?.eval`); looked back on only where the
// name or the global object's starts, so a long run of blanks reads in one go.
const GLOBAL = 'globalThis|window|global|self'
const named = name => String.raw`(?=${GLOBAL}|${name})(?<![\p{ID_Continue}$#])(?<!(?<!\.)\.${GAP})(?<!\bfunction${GAP})(?:(?:${GLOBAL})${GAP}\??\.${GAP})?${name}`
// A token's name, as its value is read (`process.env.GITHUB_TOKEN || null`,
// `env.NPM_TOKEN`, `||=`), not where its absence is told
// (`!process.env.GITHUB_TOKEN`, `!(process.env.GITHUB_TOKEN)`) or it is
// dropped (`delete process.env.NPM_TOKEN`), the token the whole of what is
// negated or deleted (ABSENT_ENDS: not `!process.env.GITHUB_TOKEN.trim()`,
// `!(process.env.GITHUB_TOKEN === x)`), nor where it is only set
// (`process.env.NPM_TOKEN = token`), but for a default as it is destructured
// (`{ NPM_TOKEN = '' } = process.env`, a line of its own too), nor declared
// (`const NPM_TOKEN = …`, TypeScript's `let GITHUB_TOKEN: string`), nor typed
// (a member, `GITHUB_TOKEN?: string`, `NPM_TOKEN: string | undefined`, or a
// parameter): looked back on, a few names and dots at most, only where the
// name starts.
const TOKEN_VAR = '(?:NPM|GITHUB)_TOKEN'
const SET = String.raw`\s{0,4}=(?![=>])`
// A name typed, not read: optional (`?:`), or a primitive's type after it,
// as no destructuring names what it reads (`{ NPM_TOKEN: token }`); not
// `undefined`, a ternary's choice (`x ? env.NPM_TOKEN : undefined`).
const TYPED = String.raw`\s{0,4}(?:\?:|:\s{0,4}(?:string|number|boolean|unknown|any)(?![\p{ID_Continue}$]))`
// What may follow a token negated or deleted whole: the parentheses around
// it closed, nothing read of what they hold (`!(token).trim()`, `!(token)()`), or else what
// ends an operand (`&&`, `||`, `??`, a ternary's `?`, `;`, `,`, `:`, `}`, `]`,
// the line's end).
const ABSENT_ENDS = String.raw`\s{0,4}(?:(?:\)\s{0,4}){1,4}(?![\s)]{0,8}(?:[.[(]|\?\.))|&&|\|\||\?\?|\?(?!\.)|[;,:}\]]|$)`
const TOKEN_NAME = String.raw`(?=NPM|GITHUB)(?<![\p{ID_Continue}$])(?<!\b(?:const|let|var)\s{1,4})`
  + String.raw`(?:(?<!(?:!|\bdelete\s)[\s(]{0,4}(?:[\p{ID_Continue}$]{1,64}\s{0,4}\??\.\s{0,4}){0,4})|(?!${TOKEN_VAR}${ABSENT_ENDS}))`
  + String.raw`${TOKEN_VAR}(?![\p{ID_Continue}$])(?!${TYPED})(?:(?!${SET})|(?<=[{,]\s{0,64}${TOKEN_VAR}))`
// A script's strings, regular expressions and comments, as script.js
// tells them, each taking its own text, and its code in none of them: eval,
// not a property TypeScript types as optional (`eval?: T`, JavaScript's `?:`
// none of its own), and Function called, but to find the global object;
// Module's _compile, called
// (`module._compile(source, filename)`) or hooked (`Module.prototype._compile
// = …`), not named in a type (`typeof Module.prototype._compile`); a token's
// name, its value read; the environment read out whole; and a PUT request's
// call (`axios.put(…)`).
const READS = new RegExp(String.raw`${JS_STRING_OR_COMMENT.source}|(?<eval>${named('eval')}(?![\p{ID_Continue}$])(?!\s*\?:))|(?<function>${named('Function')}${FUNCTION_CALLED}${GLOBAL_FOUND})`
  + String.raw`|(?<compile>\.${GAP}_compile(?:${FUNCTION_CALLED}|${GAP}=(?![=>])))|(?<tokens>${TOKEN_NAME})|(?<env>${ENV_WHOLE})|(?<put>\.${GAP}put${GAP}\()`, 'gmu')
// What a string holds that a kind is: a credential file's path, npm's, SSH's
// or AWS's (`~/.npmrc`, `.ssh/id_rsa`, `.aws/credentials`, not `x.npmrc` or
// `.sshd`); a token's name where it is read, the string the name alone (a
// key, `process.env['GITHUB_TOKEN']`) or the name expanded (a shell's or
// .npmrc's `$GITHUB_TOKEN`, `${NPM_TOKEN}`, cmd's `%NPM_TOKEN%`), not where
// text names it (`requires a token in GITHUB_TOKEN`); a command publishing (`npm publish`, `pnpm
// publish …`, options before it as npm takes them, `npm --tag next publish`)
// or the registry's who-am-I, a publisher's first step with a token. And the
// registry, where a PUT request is one publishing (REGISTRY_NAMED).
// Told first of a string by what any of them says.
const HOLDS_ANY = /\.(?:npmrc|ssh|aws)|_TOKEN|publish|whoami|registry\./u
// Before a token's name as a key, its absence told or the token dropped, as
// TOKEN_NAME tells of one as a name (`!process.env['GITHUB_TOKEN']`,
// `delete process.env['NPM_TOKEN']`): a few names and dots at most, and
// after it, its key's bracket closed, what may follow it whole (ABSENT_ENDS,
// not `!process.env['NPM_TOKEN'].length`). After it, the token set
// (`process.env['NPM_TOKEN'] = token`).
const KEY_SET = new RegExp(String.raw`^\s{0,4}\]${SET}`, 'u')
const KEY_ENDS = new RegExp(String.raw`^\s{0,4}\]${ABSENT_ENDS}`, 'mu')
const KEY_ABSENT = /(?:!|\bdelete\s)[\s(]{0,4}(?:[\p{ID_Continue}$]{1,64}\s{0,4}\??\.\s{0,4}){0,4}[\p{ID_Continue}$]{1,64}\s{0,4}(?:\?\.\s{0,4})?\[\s{0,4}$/u
// The registry's host, named as a URL's is, however it is spelled: after
// anything but what comes before a word in prose (a blank, a word's own
// characters, a tag's `<` or `>`, a quote, a bracket, `*`, `,`, `;`, a
// subdomain's `-` or `.`), so after a URL's slash, its userinfo's `@`, its
// scheme's `:` or a backslash URLs take for a slash
// (`https://registry.npmjs.org/`, `.npmrc`'s `//registry.npmjs.org/`,
// `https://${token}@registry.npmjs.org/`, `https:\\\\registry.npmjs.org`);
// after one escaped, its last a digit (`\x2f`, `\u002f`, `\x40`, `\x3a`); or
// starting a string, its whole or before its path or port (npm-profile's
// `'registry.npmjs.org'`, a URL joined, `'https://' + 'registry.npmjs.org/'`).
// Not in prose, as a dialog tells where it asks (`registry.npmjs.org</span>`,
// `asks registry.npmjs.org`, `[registry.npmjs.org]`, `'registry.npmjs.org is down'`).
const REGISTRY_HOST = String.raw`registry\.(?:npmjs\.org|yarnpkg\.com)`
const REGISTRY_NAMED = new RegExp(String.raw`(?<![\s<>"'\u0060\p{L}\p{N}_$([{*,;.\-\\])${REGISTRY_HOST}|(?<=\\\\|\\(?:x|u00)(?:2f|40|5c|3a))${REGISTRY_HOST}`
  + String.raw`|^(["'\u0060])${REGISTRY_HOST}(?=\1$|[/:])`, 'giu')
const HOLDS = [
  ['credential-files', /(?<![\w$.-])\.(?:npmrc|ssh|aws)(?![\w-])/gu],
  ['tokens', new RegExp(String.raw`^["'\u0060]${TOKEN_VAR}["'\u0060]$|(?:\$\{?|%)${TOKEN_VAR}(?![\p{ID_Continue}$])`, 'gu')],
  ['publish', /(?<![\w-])(?:npm|pnpm|yarn)(?:\s+-{1,2}\w[\w-]*(?:=\S*|\s+(?!-)\S+)?){0,8}?\s+publish(?![\w-])|\/-\/whoami(?![\w-])/gu],
  ['registry', REGISTRY_NAMED],
]
// A module a kind loads: vm, child_process, and libnpmpublish, npm's own
// publishing.
const MODULES = [
  ['vm', /^(["'\u0060])(?:node:)?vm\1$/u],
  ['child-process', /^(["'\u0060])(?:node:)?child_process\1$/u],
  ['publish', /^(["'\u0060])libnpmpublish\1$/u],
]
// A string a program is run with publishing (`spawn('npm', ['publish'])`),
// after the one naming it, its options and their values between
// (`['--tag', 'next', 'publish']`), and a request's method set to PUT
// (`{ method: 'PUT' }`, `options.method = 'put'`).
const PROGRAM = /^(["'\u0060])(?:npm|pnpm|yarn)\1$/u
const PUBLISH = /^(["'\u0060])publish\1$/u
const OPTION = /^(["'\u0060])-/u
const ARGUMENTS_BETWEEN = new RegExp(String.raw`^(?:[\s,[]|${COMMENT})*$`, 'u')
const PUT = /^(["'\u0060])put\1$/iu
const METHOD = new RegExp(String.raw`\bmethod["']?${GAP}[:=]${GAP}$`, 'u')
// What comes before a module's name where code loads it: `require(` (or
// `require?.(`), a bundler's `__require(` or `__non_webpack_require__(`,
// `import(`, `import` and `from`, comments allowed between
// (`import(/* webpackIgnore: true */ …)`); a name not loaded, as in a list of
// node's modules, is none, nor one a type-only import or export names
// (`import type { … } from`, `import type cp = require(`, comments allowed as
// in a load), which TypeScript erases (`import type from` imports a default
// named type, `import type = require(` one named so).
const LOADS = new RegExp(String.raw`(?:(?:require[\w$]*${GAP}(?:\?\.${GAP})?|\bimport${GAP})\(|\b(?:from|import))${GAP}$`, 'u')
const TYPE_ONLY = new RegExp(String.raw`\b(?:import|export)${GAP}type\b(?!${GAP}(?:from\b|=))[^;'"\x60]*(?:\bfrom|=${GAP}require${GAP}\()${GAP}$`, 'u')

// Each kind, in the order its tags show: its tag, what it does, its name in
// the tag's tooltip, a row of its own where kinds share the tag (a string run
// as code by any way, `eval`'s; a credential file or token, `credentials`'),
// and for one marked as worse than the others' warning, `critical`: the whole
// environment read out, and publishing.
const AS_CODE = { tag: 'eval', note: 'Runs a string as code' }
const CREDENTIALS = { tag: 'credentials', note: 'Reaches for credentials' }
export const RUNS_CODE = new Map([
  ['eval', { ...AS_CODE, name: 'eval' }],
  ['function', { ...AS_CODE, name: 'Function' }],
  ['vm', { ...AS_CODE, name: 'vm' }],
  ['compile', { ...AS_CODE, name: 'Module._compile' }],
  ['child-process', { tag: 'child_process', note: 'Runs other programs', name: 'child_process' }],
  ['credential-files', { ...CREDENTIALS, name: '.npmrc, .ssh or .aws' }],
  ['tokens', { ...CREDENTIALS, name: 'NPM_TOKEN or GITHUB_TOKEN' }],
  ['env', { tag: 'whole env', note: 'Reads out the whole environment', name: 'process.env, by JSON.stringify, Object.entries or values, URLSearchParams', mark: 'critical' }],
  ['publish', { tag: 'publish', note: 'Publishes to npm', name: 'npm publish, /-/whoami or a registry PUT', mark: 'critical' }],
])

// The kinds a file's code holds, each with the lines it is on, of the first
// NPM_MAX_FOUND places it does each, in RUNS_CODE's order; null for none, or
// for a file that is no script.
export function npmRunsCode(path, text) {
  if (!npmIsScript(path, text)) return null
  const found = new Map()
  const at = (kind, offset) => {
    const offsets = found.get(kind)
    if (!offsets) found.set(kind, [offset])
    else if (offsets.length < NPM_MAX_FOUND) offsets.push(offset)
  }
  read(text, 0, at)
  // A PUT request publishing where the file names the registry.
  if (found.has('registry')) for (const offset of found.get('put') ?? []) at('publish', offset)
  if (![...RUNS_CODE.keys()].some(kind => found.has(kind))) return null
  const line = lineOf(text)
  return new Map([...RUNS_CODE.keys()].filter(kind => found.has(kind)).map(kind => [kind, [...new Set(found.get(kind).map(line))].toSorted((a, b) => a - b)]))
}

// Where code (a file's, or a template literal's substitution's, at `base` in
// the file) does a kind, as at(kind, offset), in order: its code's, what its
// strings hold, a string naming a module where it is loaded, and what a
// template literal's substitutions (`${eval(x)}`) do, code again, read as its
// own; a PUT request (`put`) and the registry's host (`registry`) as their
// own, for the file to pair. Most code says none of it at all, told before
// anything is read.
function read(code, base, at) {
  if (!SAYS_ANY.test(code)) return
  // Where the string before ends; whether the strings since a program's name
  // are its arguments, an option or its value each, and whether the last is
  // an option.
  let end = 0, option = false, program = false
  for (const { 0: token, 1: string, groups, index } of code.matchAll(READS)) {
    if (string === undefined) {
      for (const kind of CODE_KINDS) if (groups[kind]) at(kind, base + index)
      continue
    }
    if (string[0] === '/') continue
    const inner = string[0] === '`' && SAYS_ANY.test(string) ? substitutions(string) : []
    for (const [from, to] of inner) read(string.slice(from, to), base + index + from, at)
    // What a string holds, a template's text alone, its substitutions' code
    // read as code, its comments and regular expressions aside.
    const text = inner.length === 0 ? string : textOf(string, inner)
    // A token's name as the string's whole (`within` 0, its quote) is a key,
    // not one where its absence is told, it is dropped or only set.
    const keyed = () => {
      const after = code.slice(index + token.length, index + token.length + 20)
      return !KEY_SET.test(after) && (!KEY_ENDS.test(after) || !KEY_ABSENT.test(code.slice(Math.max(0, index - 300), index)))
    }
    const held = HOLDS_ANY.test(text) ? HOLDS.flatMap(([kind, holds]) => [...text.matchAll(holds)].map(({ index: within }) => [kind, within])) : []
    for (const [kind, within] of held) if (kind !== 'tokens' || within > 0 || keyed()) at(kind, base + index + within)
    for (const [kind, name] of MODULES) if (name.test(string) && loaded(code, index)) at(kind, base + index)
    if (program && ARGUMENTS_BETWEEN.test(code.slice(end, index))) {
      if (PUBLISH.test(string)) at('publish', base + index)
      program = OPTION.test(string) || option
      option = OPTION.test(string)
    } else program = false
    if (PROGRAM.test(string)) [program, option] = [true, false]
    if (PUT.test(string) && METHOD.test(code.slice(Math.max(0, index - 300), index))) at('put', base + index)
    end = index + token.length
  }
}

// The kinds code itself does, by READS' groups.
const CODE_KINDS = ['eval', 'function', 'compile', 'tokens', 'env', 'put']

// Whether the string at `index` in code names a module where it is loaded.
function loaded(code, index) {
  const before = code.slice(Math.max(0, index - 300), index)
  return LOADS.test(before) && !TYPE_ONLY.test(before)
}

// A template literal with its substitutions' code blanked, its text in place.
function textOf(template, inner) {
  const parts = []
  let from = 0
  for (const [start, end] of inner) {
    parts.push(template.slice(from, start), ' '.repeat(end - start))
    from = end
  }
  parts.push(template.slice(from))
  return parts.join('')
}

// Where each of a template literal's substitutions' code starts and ends, in
// it: from its `${` to the `}` that closes it.
function substitutions(template) {
  const found = []
  for (let i = template.indexOf('${'); i !== -1; i = template.indexOf('${', i)) {
    // Escaped by an odd run of backslashes before it (`\${`, not `\\${`).
    let run = 0
    while (template[i - 1 - run] === '\\') run++
    if (run % 2 === 1) {
      i += 2
      continue
    }
    const end = closing(template, i + 2)
    found.push([i + 2, end])
    i = end
  }
  return found
}

// A string, regular expression or comment where it starts, told as
// JS_STRING_OR_COMMENT tells them in a whole text.
const TOKEN = new RegExp(JS_STRING_OR_COMMENT.source, 'muy')

// Where the `}` closing code from `from` in a text is, or the text's end for
// none: the first its braces leave unbalanced, those in its strings, regular
// expressions and comments aside (`${/* } */ x}`, `${/}/.test(x)}`).
function closing(text, from) {
  let depth = 0
  for (let at = from; at < text.length; at++) {
    const char = text[at]
    // Tried where a token can start: a quote, a slash, or a run of blanks, a
    // comment's leading blanks taken from where they start.
    if ('"\'`/ \t'.includes(char)) {
      TOKEN.lastIndex = at
      const token = TOKEN.exec(text)
      if (token) {
        at += token[0].length - 1
        continue
      }
    }
    if (char === '{') depth++
    else if (char === '}' && depth-- === 0) return at
  }
  return text.length
}

// What `found` holds (npmRunsCode's kinds, hosts.js's services) that
// `was` didn't, each with its lines: what is new to a file, as its tags say,
// `was` null for one the version compared with didn't hold, or held none in.
// Null for none.
export function npmFoundAdded(found, was) {
  if (!found) return null
  const added = new Map([...found].filter(([kind]) => !was?.has(kind)))
  return added.size > 0 ? added : null
}

// The kinds any of `founds` holds, as their tags name them, in their order,
// a tag kinds share once: `eval, child_process`.
export const npmRunsCodeKinds = founds => [...new Set([...RUNS_CODE].filter(([kind]) => founds.some(found => found.has(kind))).map(([, { tag }]) => tag))].join(', ')

// What `found` holds (npmRunsCode's) but the kinds whose tags `tags` names,
// each with its lines; null for none.
export function npmRunsCodeWithout(found, tags) {
  const kept = new Map([...found ?? []].filter(([kind]) => !tags.has(RUNS_CODE.get(kind).tag)))
  return kept.size > 0 ? kept : null
}

// Its tags as a file's flags (file-flags.js), in their order, each once: a
// warning's (`high`), or for one marked worse, `critical`; none for none.
export const npmRunsCodeFlags = found => [...new Map([...found?.keys() ?? []].map(kind => RUNS_CODE.get(kind))
  .map(({ tag, mark }) => [tag, { name: tag, severity: mark ?? 'high' }])).values()]

