// What a file's code can do beyond itself, for a reviewer: run a string as
// code (eval, Function with new or without, node:vm, Module's _compile) or
// other programs (child_process), reach for credentials (a credential file's path, a
// token's name, the environment read whole) and publish to npm (`npm
// publish`, `/-/whoami`, a registry PUT), as the npm Overview's Files list and
// Compare label a file.
// A quick read, not a parse: a script's code with its strings, regular
// expressions and comments set aside as file-readability.js tells them, its
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
import { html, nothing } from 'lit'
import { JS_STRING_OR_COMMENT } from './file-readability.js'

// JavaScript or TypeScript (a declaration file too, which node runs as any
// other), or a script run by node by its hashbang (`bin/cli`, with no
// extension).
const SCRIPT = /\.[cm]?[jt]sx?$/iu
const NODE_HASHBANG = /^#!.*\bnode\b/u
// Whether a file (its path and text) is a script, as SCRIPT and NODE_HASHBANG tell.
export const npmIsScript = (path, text) => typeof text === 'string' && (SCRIPT.test(path) || NODE_HASHBANG.test(text))
// What may come between a call's parts: blanks and comments
// (`Function/* note */(…)`), each comment ending at its first `*/`.
const GAP = String.raw`(?:\s|/\*(?:[^*]|\*(?!/)){0,100}\*/|//[^\n]{0,100}\n)*`
// Function called: as it is, optionally (`Function?.(…)`), or by its call or
// apply (`Function.call(null, …)`), each making a function of its last
// argument.
const FUNCTION_CALLED = String.raw`(?:${GAP}\??\.${GAP}(?:call|apply))?${GAP}(?:\?\.${GAP})?\(`
// The environment, whole: not one variable of it (`process.env.HOME`,
// `process.env[name]`).
const ENV = String.raw`process${GAP}\.${GAP}env(?![\p{ID_Continue}$])(?!${GAP}(?:\??\.|\[))`
// Its values read out whole (`JSON.stringify(process.env)`,
// `Object.entries(process.env)`, `new URLSearchParams(process.env)`), not as a
// program is handed it (`{ env: process.env }`, `{ ...process.env }`), nor its
// names listed (`Object.keys(process.env)`, as debug picks its DEBUG_ ones),
// nor one variable asked for (`'HOME' in process.env`).
const ENV_WHOLE = String.raw`(?=JSON|Object|URLSearchParams)(?<![\p{ID_Continue}$.])(?:JSON${GAP}\.${GAP}stringify|Object${GAP}\.${GAP}(?:values|entries)|URLSearchParams)${GAP}\(${GAP}${ENV}`
// Any of RUNS_CODE, as a text may say it.
const SAYS_ANY = new RegExp(String.raw`eval|Function${FUNCTION_CALLED}|vm["'\x60]|_compile|child_process|\.(?:npmrc|ssh|aws)|_TOKEN|(?:stringify|values|entries|URLSearchParams)${GAP}\(${GAP}process${GAP}\.${GAP}env|publish|whoami|registry\.(?:npmjs\.org|yarnpkg\.com)`, 'u')

// A name read as one, not as a property's (`vm.eval`, `vm . eval`, a spread's
// `...eval` aside) or part of another's (`evaluate`), or as the global
// object's (`window.eval`, `globalThis?.eval`); looked back on only where the
// name or the global object's starts, so a long run of blanks reads in one go.
const GLOBAL = 'globalThis|window|global|self'
const named = name => String.raw`(?=${GLOBAL}|${name})(?<![\p{ID_Continue}$#])(?<!(?<!\.)\.${GAP})(?<!\bfunction${GAP})(?:(?:${GLOBAL})${GAP}\??\.${GAP})?${name}`
// A token's name, as a name or in a string (`process.env.NPM_TOKEN`,
// `process.env['GITHUB_TOKEN']`).
const TOKEN_NAME = String.raw`(?=NPM|GITHUB)(?<![\p{ID_Continue}$])(?:NPM|GITHUB)_TOKEN(?![\p{ID_Continue}$])`
// A script's strings, regular expressions and comments, as file-readability.js
// tells them, each taking its own text, and its code in none of them: eval,
// not a property TypeScript types as optional (`eval?: T`, JavaScript's `?:`
// none of its own), and Function called; Module's _compile, called
// (`module._compile(source, filename)`) or hooked (`Module.prototype._compile
// = …`); a token's name and the environment read out whole; and a PUT
// request's call (`axios.put(…)`).
const READS = new RegExp(String.raw`${JS_STRING_OR_COMMENT.source}|(?<eval>${named('eval')}(?![\p{ID_Continue}$])(?!\s*\?:))|(?<function>${named('Function')}${FUNCTION_CALLED})`
  + String.raw`|(?<compile>\.${GAP}_compile(?![\p{ID_Continue}$]))|(?<credentials>${TOKEN_NAME}|${ENV_WHOLE})|(?<put>\.${GAP}put${GAP}\()`, 'gmu')
// What a string holds that a kind is: a credential file's path, npm's, SSH's
// or AWS's (`~/.npmrc`, `.ssh/id_rsa`, `.aws/credentials`, not `x.npmrc` or
// `.sshd`), or a token's name; a command publishing (`npm publish`, `pnpm
// publish …`) or the registry's who-am-I, a publisher's first step with a
// token. And the registry's host, where a PUT request is one publishing.
// Told first of a string by what any of them says.
const HOLDS_ANY = /\.(?:npmrc|ssh|aws)|_TOKEN|publish|whoami|registry\./u
const HOLDS = [
  ['credentials', new RegExp(String.raw`(?<![\w$.-])\.(?:npmrc|ssh|aws)(?![\w-])|${TOKEN_NAME}`, 'gu')],
  ['publish', /(?<![\w-])(?:npm|pnpm|yarn)\s+publish(?![\w-])|\/-\/whoami(?![\w-])/gu],
  ['registry', /registry\.(?:npmjs\.org|yarnpkg\.com)/gu],
]
// A module a kind loads: vm, child_process, and libnpmpublish, npm's own
// publishing.
const MODULES = [
  ['vm', /^(["'\u0060])(?:node:)?vm\1$/u],
  ['child-process', /^(["'\u0060])(?:node:)?child_process\1$/u],
  ['publish', /^(["'\u0060])libnpmpublish\1$/u],
]
// A string a program is run with publishing (`spawn('npm', ['publish'])`),
// after the one naming it, and a request's method set to PUT (`{ method:
// 'PUT' }`, `options.method = 'put'`).
const PROGRAM = /^(["'\u0060])(?:npm|pnpm|yarn)\1$/u
const PUBLISH = /^(["'\u0060])publish\1$/u
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

// Each kind, in the order its tags show: its tag and what it does.
const RUNS_CODE = new Map([
  ['eval', { tag: 'eval', note: 'Runs a string as code (eval)' }],
  ['function', { tag: 'Function', note: 'Makes a function of a string (Function)' }],
  ['vm', { tag: 'vm', note: 'Runs a string as code (vm)' }],
  ['compile', { tag: '_compile', note: 'Compiles a string as a module (Module._compile)' }],
  ['child-process', { tag: 'child_process', note: 'Runs other programs (child_process)' }],
  ['credentials', { tag: 'credentials', note: 'Reaches for credentials (.npmrc, .ssh, .aws, NPM_TOKEN, GITHUB_TOKEN, process.env whole)' }],
  ['publish', { tag: 'publish', note: 'Publishes to npm (npm publish, /-/whoami, a registry PUT)' }],
])

// The kinds a file's code holds, each with the lines it is on, in RUNS_CODE's
// order; null for none, or for a file that is no script.
export function npmRunsCode(path, text) {
  if (!npmIsScript(path, text)) return null
  const found = new Map()
  const at = (kind, offset) => found.get(kind)?.push(offset) ?? found.set(kind, [offset])
  read(text, 0, at)
  // A PUT request publishing where the file names the registry.
  if (found.has('registry')) for (const offset of found.get('put') ?? []) at('publish', offset)
  if (![...RUNS_CODE.keys()].some(kind => found.has(kind))) return null
  const line = lineOf(text)
  return new Map([...RUNS_CODE.keys()].filter(kind => found.has(kind)).map(kind => [kind, [...new Set(found.get(kind).map(line))].toSorted((a, b) => a - b)]))
}

// `scan` (path, text) of a bundle's file, by bundle and path, read once for
// the npm Overview's Files list and Compare.
export function cachedPerFile(scan) {
  const byDetails = new WeakMap()
  return (details, path, text) => {
    let files = byDetails.get(details)
    if (!files) byDetails.set(details, files = new Map())
    if (!files.has(path)) files.set(path, scan(path, text))
    return files.get(path)
  }
}
export const npmFileRunsCode = cachedPerFile(npmRunsCode)

// Where code (a file's, or a template literal's substitution's, at `base` in
// the file) does a kind, as at(kind, offset), in order: its code's, what its
// strings hold, a string naming a module where it is loaded, and what a
// template literal's substitutions (`${eval(x)}`) do, code again, read as its
// own; a PUT request (`put`) and the registry's host (`registry`) as their
// own, for the file to pair. Most code says none of it at all, told before
// anything is read.
function read(code, base, at) {
  if (!SAYS_ANY.test(code)) return
  // The string before, and where it ends.
  let end = 0, previous = ''
  for (const { 0: token, 1: string, groups, index } of code.matchAll(READS)) {
    if (string === undefined) {
      for (const kind of CODE_KINDS) if (groups[kind]) at(kind, base + index)
      continue
    }
    if (string[0] === '/') continue
    if (string[0] === '`' && SAYS_ANY.test(string)) for (const [from, to] of substitutions(string)) read(string.slice(from, to), base + index + from, at)
    if (HOLDS_ANY.test(string)) for (const [kind, holds] of HOLDS) for (const { index: within } of string.matchAll(holds)) at(kind, base + index + within)
    for (const [kind, name] of MODULES) if (name.test(string) && loaded(code, index)) at(kind, base + index)
    if (PUBLISH.test(string) && PROGRAM.test(previous) && /^[\s,[]*$/u.test(code.slice(end, index))) at('publish', base + index)
    if (PUT.test(string) && METHOD.test(code.slice(Math.max(0, index - 300), index))) at('put', base + index)
    end = index + token.length
    previous = string
  }
}

// The kinds code itself does, by READS' groups.
const CODE_KINDS = ['eval', 'function', 'compile', 'credentials', 'put']

// Whether the string at `index` in code names a module where it is loaded.
function loaded(code, index) {
  const before = code.slice(Math.max(0, index - 300), index)
  return LOADS.test(before) && !TYPE_ONLY.test(before)
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

// Each offset in a text as its line: one more than the line breaks before it.
export function lineOf(text) {
  let breaks = null
  return offset => {
    breaks ??= [...text.matchAll(/\n/gu)].map(({ index }) => index)
    let high = breaks.length, low = 0
    while (low < high) {
      const middle = (low + high) >> 1
      if (breaks[middle] < offset) low = middle + 1
      else high = middle
    }
    return low + 1
  }
}

export const linesNote = lines => lines.length === 1 ? `line ${lines[0]}`
  : `lines ${lines.slice(0, 5).join(', ')}${lines.length > 5 ? ` and ${(lines.length - 5).toLocaleString('en')} more` : ''}`

// What `found` holds (npmRunsCode's kinds, file-hosts.js's services) that
// `was` didn't, each with its lines: what is new to a file, as its tags say,
// `was` null for one the version compared with didn't hold, or held none in.
// Null for none.
export function npmFoundAdded(found, was) {
  if (!found) return null
  const added = new Map([...found].filter(([kind]) => !was?.has(kind)))
  return added.size > 0 ? added : null
}

// The kinds any of `founds` holds, as their tags name them, in their order:
// `eval, child_process`.
export const npmRunsCodeKinds = founds => [...RUNS_CODE].filter(([kind]) => founds.some(found => found.has(kind))).map(([, { tag }]) => tag).join(', ')

// The kinds a file holds, each named with its lines: `eval (line 3)`.
export const npmRunsCodeSaid = found => [...found].map(([kind, lines]) => `${RUNS_CODE.get(kind).tag} (${linesNote(lines)})`).join(', ')

// A file's tags, one a kind it holds (npmRunsCode), its lines in its tooltip;
// with `was`, the kinds the file held as the version compared with has it
// (null for none), one it didn't hold saying so.
// Their tags' texts, in their order: none for none.
export const npmRunsCodeNames = found => found ? [...found.keys()].map(kind => RUNS_CODE.get(kind).tag) : []

export function npmRunsCodeTags(found, was) {
  if (!found) return nothing
  return [...found].map(([kind, lines]) => {
    const { tag, note } = RUNS_CODE.get(kind)
    const fresh = was !== undefined && !was?.has(kind)
    return html`<span class="npm-runs-code" data-tooltip=${`${note}: ${linesNote(lines)}${fresh ? ', new' : ''}`}>${tag}</span>`
  })
}
