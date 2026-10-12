// What a file's code can run beyond itself, for a reviewer: a string run as
// code (eval, and Function with new or without) and other programs
// (child_process), as the npm Overview's Files list and Compare label a file.
// A quick read, not a parse: a script's code with its strings, regular
// expressions and comments set aside as file-readability.js tells them, a
// module by the string naming it where it is loaded (`require('child_process')`,
// `import … from 'node:child_process'`); a declaration file (.d.ts) read as
// TypeScript, as node runs it (stripping its types, `declare function
// eval(…)` among them, a function named, not called). A call written not to
// read as one (`window['ev' + 'al']`) goes unseen, as does one in a template
// literal in another's substitution (`${`${eval(x)}`}`), whose backtick ends
// the outer one as the regular expression telling strings reads it.
//
// Labels to assist a reviewer, making the plain cases less likely to be
// missed, not a check to rely on: code can come to eval, Function or
// child_process in more ways than any reading of its text tells (a name built
// as it runs, `(…).constructor('…')`, node:vm, a module required by a name
// computed), so a file without a label is not one without them.
import { html, nothing } from 'lit'
import { JS_STRING_OR_COMMENT } from './file-readability.js'

// JavaScript or TypeScript (a declaration file too, which node runs as any
// other), or a script run by node by its hashbang (`bin/cli`, with no
// extension).
const SCRIPT = /\.[cm]?[jt]sx?$/iu
const NODE_HASHBANG = /^#!.*\bnode\b/u
// What may come between a call's parts: blanks and comments
// (`Function/* note */(…)`), each comment ending at its first `*/`.
const GAP = String.raw`(?:\s|/\*(?:[^*]|\*(?!/)){0,100}\*/|//[^\n]{0,100}\n)*`
// Function called: as it is, optionally (`Function?.(…)`), or by its call or
// apply (`Function.call(null, …)`), each making a function of its last
// argument.
const FUNCTION_CALLED = String.raw`(?:${GAP}\??\.${GAP}(?:call|apply))?${GAP}(?:\?\.${GAP})?\(`
// Any of RUNS_CODE, as a text may say it.
const SAYS_ANY = new RegExp(`eval|Function${FUNCTION_CALLED}|child_process`, 'u')

// A name read as one, not as a property's (`vm.eval`, `vm . eval`, a spread's
// `...eval` aside) or part of another's (`evaluate`), or as the global
// object's (`window.eval`, `globalThis?.eval`); looked back on only where the
// name or the global object's starts, so a long run of blanks reads in one go.
const GLOBAL = 'globalThis|window|global|self'
const named = name => String.raw`(?=${GLOBAL}|${name})(?<![\p{ID_Continue}$#])(?<!(?<!\.)\.${GAP})(?<!\bfunction${GAP})(?:(?:${GLOBAL})${GAP}\??\.${GAP})?${name}`
// A script's strings, regular expressions and comments, as file-readability.js
// tells them, each taking its own text, and its calls in none of them: eval,
// not a property TypeScript types as optional (`eval?: T`, JavaScript's `?:`
// none of its own), and Function.
const READS = new RegExp(String.raw`${JS_STRING_OR_COMMENT.source}|(?<eval>${named('eval')}(?![\p{ID_Continue}$])(?!\s*\?:))|(?<function>${named('Function')}${FUNCTION_CALLED})`, 'gmu')
// A string naming child_process.
const CHILD_PROCESS = /^(["'\u0060])(?:node:)?child_process\1$/u
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
  ['child-process', { tag: 'child_process', note: 'Runs other programs (child_process)' }],
])

// The kinds a file's code holds, each with the lines it is on, in RUNS_CODE's
// order; null for none, or for a file that is no script.
export function npmRunsCode(path, text) {
  if (typeof text !== 'string' || !(SCRIPT.test(path) || NODE_HASHBANG.test(text))) return null
  const found = new Map()
  read(text, 0, (kind, offset) => found.get(kind)?.push(offset) ?? found.set(kind, [offset]))
  if (found.size === 0) return null
  // Each offset's line, one more than the line breaks before it.
  const breaks = [...text.matchAll(/\n/gu)].map(({ index }) => index)
  return new Map([...RUNS_CODE.keys()].filter(kind => found.has(kind)).map(kind => [kind, [...new Set(found.get(kind).map(offset => below(breaks, offset) + 1))].toSorted((a, b) => a - b)]))
}

// npmRunsCode of a bundle's file, by bundle and path, read once for the npm
// Overview's Files list and Compare.
const readFiles = new WeakMap()
export function npmFileRunsCode(details, path, text) {
  let files = readFiles.get(details)
  if (!files) readFiles.set(details, files = new Map())
  if (!files.has(path)) files.set(path, npmRunsCode(path, text))
  return files.get(path)
}

// Where code (a file's, or a template literal's substitution's, at `base` in
// the file) runs a kind, as at(kind, offset), in order: its calls, a string
// naming a module where it is loaded, and what a template literal's
// substitutions (`${eval(x)}`) run, code again, read as its own. Most code
// says none of it at all, told before anything is read.
function read(code, base, at) {
  if (!SAYS_ANY.test(code)) return
  for (const { 1: string, groups, index } of code.matchAll(READS)) {
    if (groups.eval || groups.function) at(groups.eval ? 'eval' : 'function', base + index)
    if (string?.[0] === '`' && SAYS_ANY.test(string)) for (const [from, to] of substitutions(string)) read(string.slice(from, to), base + index + from, at)
    if (CHILD_PROCESS.test(string)) {
      const before = code.slice(Math.max(0, index - 300), index)
      if (LOADS.test(before) && !TYPE_ONLY.test(before)) at('child-process', base + index)
    }
  }
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

// How many of a sorted list's numbers are below a value.
function below(sorted, value) {
  let high = sorted.length, low = 0
  while (low < high) {
    const middle = (low + high) >> 1
    if (sorted[middle] < value) low = middle + 1
    else high = middle
  }
  return low
}

const linesNote = lines => lines.length === 1 ? `line ${lines[0]}`
  : `lines ${lines.slice(0, 5).join(', ')}${lines.length > 5 ? ` and ${(lines.length - 5).toLocaleString('en')} more` : ''}`

// The kinds `found` holds (npmRunsCode's) that `was` didn't, each with its
// lines: those new to a file, as its tags say (npmRunsCodeTags), `was` null
// for one the version compared with didn't hold, or held none in. Null for
// none.
export function npmRunsCodeAdded(found, was) {
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
