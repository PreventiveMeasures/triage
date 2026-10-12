// What a file's code can run beyond itself, for a reviewer: a string run as
// code (eval, new Function, Function) and other programs (child_process), as
// the npm Overview's Files list and Compare label a file. A quick read, not a
// parse: a script's code with its strings, regular expressions and comments
// set aside as file-readability.js tells them, a module named by the string
// that names it; a declaration file (.d.ts) runs nothing, and a call written
// not to read as one (`window['ev' + 'al']`) goes unseen.
import { html, nothing } from 'lit'
import { JS_STRING_OR_COMMENT } from './file-readability.js'

// JavaScript or TypeScript, or a script run by node by its hashbang
// (`bin/cli`, with no extension), not a declaration file.
const SCRIPT = /\.[cm]?[jt]sx?$/iu
const DECLARATION = /\.d\.[cm]?ts$/iu
const NODE_HASHBANG = /^#!.*\bnode\b/u
// Told before anything is set aside: most files say none of it at all.
const SAYS_ANY = /eval|Function\s*\(|child_process/u

// A name read as one, not as a property's (`vm.eval`) or part of another's
// (`evaluate`), or as the global object's (`window.eval`).
const BEFORE = String.raw`(?<![\p{ID_Continue}$.#])(?:(?:globalThis|window|global|self)\s*\.\s*)?`
const AFTER = String.raw`(?![\p{ID_Continue}$])`

// Each kind, in the order its tags show: its tag, what it does, and how its
// code reads, or for a module, its name.
export const RUNS_CODE = new Map([
  ['eval', { tag: 'eval', note: 'Runs a string as code (eval)', code: new RegExp(`${BEFORE}eval${AFTER}`, 'gu') }],
  ['new-function', { tag: 'new Function', note: 'Makes a function of a string (new Function)', code: new RegExp(String.raw`(?<![\p{ID_Continue}$.#])new\s+Function\s*\(`, 'gu') }],
  ['function', { tag: 'Function', note: 'Makes a function of a string (Function)', code: new RegExp(String.raw`(?<!\bnew\s+)${BEFORE}Function\s*\(`, 'gu') }],
  ['child-process', { tag: 'child_process', note: 'Runs other programs (child_process)', module: /^(?:node:)?child_process$/u }],
])

// The kinds a file's code holds, each with the lines it is on, in RUNS_CODE's
// order; null for none, or for a file that is no script.
export function npmRunsCode(path, text) {
  if (typeof text !== 'string' || DECLARATION.test(path) || !(SCRIPT.test(path) || NODE_HASHBANG.test(text)) || !SAYS_ANY.test(text)) return null
  // Where each of its strings, regular expressions and comments starts and
  // ends, in order, and where a string names a module; then its code's
  // calls, those in none of them. Spans alone, not a copy of the text with
  // them blanked, which takes four times as long on a large one.
  const found = new Map()
  const at = (kind, offset) => found.set(kind, [...found.get(kind) ?? [], offset])
  const ends = [], starts = []
  for (const { 0: match, 1: string, index } of text.matchAll(JS_STRING_OR_COMMENT)) {
    starts.push(index)
    ends.push(index + match.length)
    if (string === undefined || string.length > 24 || !'"\'`'.includes(string[0])) continue
    for (const [kind, { module }] of RUNS_CODE) if (module?.test(string.slice(1, -1))) at(kind, index)
  }
  const inside = (offset) => {
    const span = below(starts, offset + 1) - 1
    return span >= 0 && offset < ends[span]
  }
  for (const [kind, { code: reads }] of RUNS_CODE) if (reads) for (const { index } of text.matchAll(reads)) if (!inside(index)) at(kind, index)
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
