// Whether a pair of a comparison's files changed in types alone (type-only.ts),
// told in a worker (type-only-worker.js): each a file a side, `{ path, text }`,
// a side not there null, its path as it is, which says what a file is.
//
// typeOnlyStamped: as @preventive/compare's compareTrees stamps a change
// `typeOnly`. Two paths pair as one change wherever compareTrees takes them
// for a rename at all; where it doesn't, the pair is types only where each of
// its two changes is: the file gone erasing whole, and the one come erasing
// whole or leaving a single bare `export {}`, which nothing loaded before.
//
// typeOnlyRuns: one it doesn't stamp may still hold types alone but for what
// runs on each side, each side there a declaration file proveTypeOnly proves,
// its runtime what changed: a module load added, gone or another, or a file
// added or removed that loads one, as a zod schema's declarations do. Told
// then are the lines that hold what runs on each side (`runs` the base's,
// `otherRuns` the other's, none for a side not there), for the viewer to diff
// those alone with its types set aside: the hashbang, each statement Node's
// type stripping leaves to run (a module load, `export {}`, `export default`
// of a name), each comment it keeps that may be one a tool reads (a
// triple-slash directive, a source map or source URL pragma), told wide of
// the proof's own grammar for them, so none it reads is ever set aside, and
// each enum, whose members compile into what reads them (runLines). A
// line holding any of it is told whole; a range is `[from, to)` of lines
// counted from zero, as the viewer splits a text at `\n`. None are told of
// a pair where a diff of those lines would not show what changed: a
// triple-slash comment that leads one side, where a directive steers, and
// stands below a statement on the other, where it is prose, its line the same
// on both (`moved`). Its diff is drawn whole, as one not proven is.
//
// Each sets aside a file's own source map comment, as tsc writes one with a
// declaration map: its last line exactly `//# sourceMappingURL=` its own name
// `.map`, a newline after it or none (withoutOwnMap). It names the file's own
// map, for a debugger alone, and is taken for one of its types: the file is
// proven, and its lines that run told, without it.
import { stripTypeScriptTypes } from 'node:module'
import { compareTrees, proveTypeOnly } from '@preventive/compare'
import { parseSync } from 'oxc-parser'

// A declaration file as compareTrees takes one: `.d.ts`, `.d.mts`, `.d.cts`,
// and `.d.css.ts` for a `.css` file's.
const DECLARATION = /\.d\.(?:[^./]+\.)?[cm]?ts$/u
// A comment that may be a directive (`/// <reference .../>`) or a pragma
// (`//# sourceMappingURL=`, and its legacy `//@` and block forms).
const STEERING = /^\/(?:\/\/|[/*][#@])/u
const BLANK = /^\s*$/u

const tree = file => (file ? [{ name: file.path, data: file.text }] : [])

// A file without its own source map comment, where its last line is that and
// nothing else: `//# sourceMappingURL=` and its name, `user.d.ts.map` for
// `types/user.d.ts`, ending the file with a newline or without. Any other
// name or spelling, or anything after it, and the file is as it is; so too
// where its own name is not plain (PLAIN_NAME): one holding a line terminator
// would end the comment within it, and what follows would run, so no other
// character than Latin letters, digits, `-`, `_` and `.` is taken in one.
const PLAIN_NAME = /^[A-Za-z0-9._-]+$/u
function withoutOwnMap(file) {
  if (file === null) return null
  const name = file.path.slice(file.path.lastIndexOf('/') + 1)
  if (!PLAIN_NAME.test(name)) return file
  const comment = `//# sourceMappingURL=${name}.map`
  for (const last of [comment, `${comment}\n`]) {
    const before = file.text.endsWith(last) ? file.text.slice(0, -last.length) : null
    if (before !== null && (before === '' || before === '\uFEFF' || before.endsWith('\n'))) return { ...file, text: before }
  }
  return file
}

// Two the same but for their own source map comments changed nothing else:
// in types alone, where each is a declaration file proven to hold types alone.
export function typeOnlyStamped(from, to) {
  const [base, other] = [from, to].map(withoutOwnMap)
  const changes = compareTrees(tree(base), tree(other), { paths: 'keys', lines: false, renames: Number.MIN_VALUE })
  if (changes.length > 0) return changes.every(change => change.typeOnly === true)
  return [base, other].every(file => file !== null && DECLARATION.test(file.path) && proveTypeOnly(file.text).proven)
}

// Each enum a program declares, wherever it stands: exported, or within a
// namespace, a module or `declare global`. Stripping erases one whole, yet its
// members are values: tsc writes a const enum's member into the code that
// reads it (`E.A` emitted as `1`), and a const enum's member may be computed
// from any enum's, so a change to one changes what runs elsewhere, and none is
// folded as types alone. Statements alone hold one, so lists of them alone are
// walked, a work list as namespaces nest.
function enumsOf(program) {
  const found = [], lists = [program.body]
  while (lists.length > 0) {
    for (const statement of lists.pop()) {
      let node = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
      if (node?.type === 'TSEnumDeclaration') found.push(node)
      while (node?.type === 'TSModuleDeclaration') node = node.body
      if (node?.type === 'TSModuleBlock') lists.push(node.body)
    }
  }
  return found
}

// The lines of a text proven to hold types alone but for what runs that hold
// any of that, as merged ranges (`lines`), and its triple-slash comments, by
// whether each leads it (`leading`, `below`). Stripping blanks what it erases
// in place, each character to a blank, so a statement it leaves blank is
// erased and one it leaves anything of runs, as the proof found, and a comment
// it leaves is kept; what it reads starts past a byte order mark, and so do
// the offsets in its tree. An enum, which stripping blanks, is told among them
// all the same (enumsOf), so that no fold sets one aside as types alone.
function runLines(text) {
  const shift = text.startsWith('\uFEFF') ? 1 : 0
  const body = text.slice(shift)
  const code = stripTypeScriptTypes(body, { mode: 'strip' })
  const { program, comments } = parseSync('file.ts', body, { lang: 'ts', sourceType: 'module' })
  const kept = ({ start, end }) => code.slice(start, end)
  const steering = comments.filter(comment => STEERING.test(kept(comment)))
  const spans = [...program.hashbang ? [program.hashbang] : [], ...program.body.filter(statement => !BLANK.test(kept(statement))), ...steering, ...enumsOf(program)]
  const starts = [0]
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1)
  // The line an offset of the text is on: the last whose start is at most it.
  const lineAt = offset => {
    let high = starts.length - 1, low = 0
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (starts[mid] <= offset) low = mid
      else high = mid - 1
    }
    return low
  }
  const ranges = []
  for (const { start, end } of spans.toSorted((a, b) => a.start - b.start)) {
    const from = lineAt(shift + start), to = lineAt(shift + Math.max(start, end - 1)) + 1
    const last = ranges.at(-1)
    if (last && from <= last[1]) last[1] = Math.max(last[1], to)
    else ranges.push([from, to])
  }
  // Its triple-slash comments, by their text: those that lead it, before its
  // first statement, where alone a directive steers, and those below one.
  const first = program.body[0]?.start ?? Infinity
  const slashed = leads => new Set(steering.filter(comment => (comment.start < first) === leads).map(kept).filter(comment => comment.startsWith('///')))
  return { lines: ranges, leading: slashed(true), below: slashed(false) }
}

// Whether a triple-slash comment that leads `one` side stands only below a
// statement on the `other`: a directive that steers on one alone, though its
// line reads the same on both.
const moved = (one, other) => [...one.leading].some(comment => !other.leading.has(comment) && other.below.has(comment))

// `{ runs, otherRuns }` where each side there is a declaration file proven to
// hold types alone but for what runs, and no directive steers on one side
// alone unseen (`moved`); else false, and where the proof throws, as no
// check should. Asked of a pair not stamped, which always runs some.
export function typeOnlyRuns(...pair) {
  const [from, to] = pair.map(withoutOwnMap)
  const sides = [from, to].filter(file => file !== null)
  if (sides.length === 0 || !sides.every(file => DECLARATION.test(file.path))) return false
  try {
    if (!sides.every(file => proveTypeOnly(file.text).proven)) return false
    const [base, other] = [from, to].map(file => (file ? runLines(file.text) : null))
    if (base && other && (moved(base, other) || moved(other, base))) return false
    return { runs: base?.lines ?? [], otherRuns: other?.lines ?? [] }
  } catch {
    return false
  }
}
