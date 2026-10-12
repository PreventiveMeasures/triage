// What a file's code can run beyond itself, for a reviewer: a string run as
// code (eval, and Function with new or without) and other programs
// (child_process), as the npm Overview's Files list and Compare label a file.
// A quick read, not a parse: a script's code with its strings, regular
// expressions and comments set aside as file-readability.js tells them, a
// module named by the string that names it; a declaration file (.d.ts) runs
// nothing, and a call written not to read as one (`window['ev' + 'al']`)
// goes unseen, as does one in a template literal in another's substitution
// (`${`${eval(x)}`}`), whose backtick ends the outer one as the regular
// expression telling strings reads it.
//
// Labels to assist a reviewer, making the plain cases less likely to be
// missed, not a check to rely on: code can come to eval, Function or
// child_process in more ways than any reading of its text tells (a name built
// as it runs, `(…).constructor('…')`, node:vm, a module required by a name
// computed), so a file without a label is not one without them.
import { html, nothing } from 'lit'
import { JS_STRING_OR_COMMENT } from './file-readability.js'

// JavaScript or TypeScript, or a script run by node by its hashbang
// (`bin/cli`, with no extension), not a declaration file.
const SCRIPT = /\.[cm]?[jt]sx?$/iu
const DECLARATION = /\.d\.[cm]?ts$/iu
const NODE_HASHBANG = /^#!.*\bnode\b/u
// Function called: as it is, optionally (`Function?.(…)`), or by its call or
// apply (`Function.call(null, …)`), each making a function of its last
// argument.
const FUNCTION_CALL = String.raw`Function(?:\s*\??\.\s*(?:call|apply))?\s*(?:\?\.\s*)?\(`
// Told before anything is set aside: most files say none of it at all.
const SAYS_ANY = new RegExp(`eval|${FUNCTION_CALL}|child_process`, 'u')

// A name read as one, not as a property's (`vm.eval`) or part of another's
// (`evaluate`), or as the global object's (`window.eval`, `globalThis?.eval`).
const BEFORE = String.raw`(?<![\p{ID_Continue}$.#])(?:(?:globalThis|window|global|self)\s*\??\.\s*)?`
const AFTER = String.raw`(?![\p{ID_Continue}$])`

// Each kind, in the order its tags show: its tag, what it does, and how its
// code reads, or for a module, its name.
export const RUNS_CODE = new Map([
  ['eval', { tag: 'eval', note: 'Runs a string as code (eval)', code: new RegExp(`${BEFORE}eval${AFTER}`, 'gu') }],
  ['function', { tag: 'Function', note: 'Makes a function of a string (Function)', code: new RegExp(`${BEFORE}${FUNCTION_CALL}`, 'gu') }],
  ['child-process', { tag: 'child_process', note: 'Runs other programs (child_process)', module: /^(?:node:)?child_process$/u }],
])

// The kinds a file's code holds, each with the lines it is on, in RUNS_CODE's
// order; null for none, or for a file that is no script.
export function npmRunsCode(path, text) {
  if (typeof text !== 'string' || DECLARATION.test(path) || !(SCRIPT.test(path) || NODE_HASHBANG.test(text)) || !SAYS_ANY.test(text)) return null
  const found = new Map()
  read(text, 0, (kind, offset) => found.set(kind, [...found.get(kind) ?? [], offset]))
  if (found.size === 0) return null
  // Each offset's line, its line breaks counted up to the last.
  const lines = new Map()
  let from = 0, line = 1
  for (const offset of [...new Set([...found.values()].flat())].toSorted((a, b) => a - b)) {
    for (let next = text.indexOf('\n', from); next !== -1 && next < offset; next = text.indexOf('\n', from)) {
      line++
      from = next + 1
    }
    lines.set(offset, line)
  }
  return new Map([...RUNS_CODE.keys()].filter(kind => found.has(kind)).map(kind => [kind, [...new Set(found.get(kind).map(offset => lines.get(offset)))].toSorted((a, b) => a - b)]))
}

// Where code (a file's, or a template literal's substitution's, at `base` in
// the file) runs a kind, as at(kind, offset): where each of its strings,
// regular expressions and comments starts and ends, in order, and where a
// string names a module; then its calls, those in none of them, and those in
// a template literal's substitutions (`${eval(x)}`), code again, read as its
// own. Spans alone, not a copy of the text with them blanked, which takes
// four times as long on a large one.
function read(code, base, at) {
  const ends = [], starts = []
  for (const { 0: match, 1: string, index } of code.matchAll(JS_STRING_OR_COMMENT)) {
    starts.push(index)
    ends.push(index + match.length)
    if (string?.[0] === '`' && SAYS_ANY.test(string)) for (const [from, to] of substitutions(string)) read(string.slice(from, to), base + index + from, at)
    if (string === undefined || string.length > 24 || !'"\'`'.includes(string[0])) continue
    for (const [kind, { module }] of RUNS_CODE) if (module?.test(string.slice(1, -1))) at(kind, base + index)
  }
  const inside = (offset) => {
    const span = below(starts, offset + 1) - 1
    return span >= 0 && offset < ends[span]
  }
  for (const [kind, { code: reads }] of RUNS_CODE) if (reads) for (const { index } of code.matchAll(reads)) if (!inside(index)) at(kind, base + index)
}

// Where each of a template literal's substitutions' code starts and ends, in
// it, for those that say any of RUNS_CODE: from its `${` to the `}` that
// closes it.
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
    if (SAYS_ANY.test(template.slice(i + 2, end))) found.push([i + 2, end])
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
    if ('"\'`/'.includes(char)) {
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

// A file's tags, one a kind it holds (npmRunsCode), its lines in its tooltip;
// with `was`, the kinds the file held as the version compared with has it
// (null for none), one it didn't hold saying so.
export function npmRunsCodeTags(found, was) {
  if (!found) return nothing
  return [...found].map(([kind, lines]) => {
    const { tag, note } = RUNS_CODE.get(kind)
    const fresh = was !== undefined && !was?.has(kind)
    return html`<span class="npm-runs-code" data-tooltip=${`${note}: ${linesNote(lines)}${fresh ? ', new' : ''}`}>${tag}</span>`
  })
}
