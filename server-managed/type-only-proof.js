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
// of a name), and each comment it keeps that may be one a tool reads (a
// triple-slash directive, a source map or source URL pragma), told wide of
// the proof's own grammar for them, so none it reads is ever set aside. A
// line holding any of it is told whole; a range is `[from, to)` of lines
// counted from zero, as the viewer splits a text at `\n`.
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

export function typeOnlyStamped(from, to) {
  const changes = compareTrees(tree(from), tree(to), { paths: 'keys', lines: false, renames: Number.MIN_VALUE })
  return changes.length > 0 && changes.every(change => change.typeOnly === true)
}

// The lines of a text proven to hold types alone but for what runs that hold
// any of that, as merged ranges. Stripping blanks what it erases in place,
// each character to a blank, so a statement it leaves blank is erased and one
// it leaves anything of runs, as the proof found, and a comment it leaves is
// kept; what it reads starts past a byte order mark, and so do the offsets in
// its tree.
function runLines(text) {
  const shift = text.startsWith('﻿') ? 1 : 0
  const body = text.slice(shift)
  const code = stripTypeScriptTypes(body, { mode: 'strip' })
  const { program, comments } = parseSync('file.ts', body, { lang: 'ts', sourceType: 'module' })
  const kept = ({ start, end }) => code.slice(start, end)
  const spans = [...program.hashbang ? [program.hashbang] : [], ...program.body.filter(statement => !BLANK.test(kept(statement))),
    ...comments.filter(comment => STEERING.test(kept(comment)))]
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
  return ranges
}

// `{ runs, otherRuns }` where each side there is a declaration file proven to
// hold types alone but for what runs; else false, and where the proof throws,
// as no check should. Asked of a pair not stamped, which always runs some.
export function typeOnlyRuns(from, to) {
  const sides = [from, to].filter(file => file !== null)
  if (sides.length === 0 || !sides.every(file => DECLARATION.test(file.path))) return false
  try {
    if (!sides.every(file => proveTypeOnly(file.text).proven)) return false
    const [runs, otherRuns] = [from, to].map(file => (file ? runLines(file.text) : []))
    return { runs, otherRuns }
  } catch {
    return false
  }
}
