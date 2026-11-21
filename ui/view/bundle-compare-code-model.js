// Pure model behind the Compare slide's Code view — no Lit, no DOM, no
// `state`. Two texts in, what a review needs out: the change blocks
// between them (common/line-diff.js, or the server's with renamed names
// hidden: server-managed/rename-diff.ts), the rows a unified or split
// diff shows with unchanged runs folded down to their context, and the
// words that changed inside a changed line (@preventive/compare's
// wordRanges and pairLines) marked in a line's syntax-highlighted markup.
//
// Lines are numbered the way the diff numbers them: from zero, a final
// newline ending the last line rather than starting an empty one.
import { hidesMixedWhitespace, pairLines, wordRanges } from '@preventive/compare/view.js'
import { blocksHold, changeBlocks, textLines } from '../../common/line-diff.js'
import { JS_STRING_OR_COMMENT } from '../../risk/files/script.js'

export { textLines }

// Unchanged lines kept on each side of a change, as `diff -u` keeps them.
export const DIFF_CONTEXT = 3
// Lines one click on a fold's expand-up / expand-down reveals.
export const EXPAND_STEP = 20
// A fold hides at least this many lines; fewer show as they are, since the
// fold's own row would take nearly the room they do.
const MIN_FOLD = 4

// The change blocks between two texts, each `a[a0..a1)` replaced by
// `b[b0..b1)`, with the lines on each side and the count of each. An
// added file is diffed against '' and a removed one against it, so all
// three kinds of change share one model. `ignoreWhitespace` is diff -b:
// lines differing only in how much whitespace they have pair up as
// unchanged (common/line-diff.js changeBlocks). `changes` are
// blocks found elsewhere: the server's, its old side given the new one's
// names (server-managed/rename-diff.ts). `marks` are the blocks the server
// found to differ in renamed names alone (rename-diff-worker.js): those of
// these blocks that are one of them are `marked`, counted apart from the
// lines added and removed (`renamed`), for a view to draw them apart rather
// than hiding them.
export function lineDiff(before, after, { ignoreWhitespace = false, changes = null, marks = null } = {}) {
  const a = textLines(before), b = textLines(after)
  const blocks = changes?.blocks ?? changeBlocks(before, after, ignoreWhitespace)
  // A last line with no newline after it: shown on a changed row, since a
  // newline added or dropped at the end is a change of that line alone.
  const noEol = { a: before !== '' && !before.endsWith('\n'), b: after !== '' && !after.endsWith('\n') }
  // `words` keeps the marks of each pair a render asks for.
  return { a, b, blocks, ...markedCounts(blocks, marks), noEol, words: new Map() }
}

// The lines `blocks` add and remove, those that are one of `marks` (as many
// lines on either side) counted apart (`renamed`), their indexes `marked`.
export function markedCounts(blocks, marks) {
  const told = new Set((marks ?? []).map(({ a0, a1, b0, b1 }) => `${a0},${a1},${b0},${b1}`))
  const marked = new Set()
  let additions = 0, deletions = 0, renamed = 0
  blocks.forEach(({ a0, a1, b0, b1 }, i) => {
    if (told.has(`${a0},${a1},${b0},${b1}`) && a1 - a0 === b1 - b0) {
      marked.add(i)
      renamed += b1 - b0
    } else {
      additions += b1 - b0
      deletions += a1 - a0
    }
  })
  return { additions, deletions, renamed, marked }
}

// A file that changed in types alone but for what runs, as the server proves
// it (type-only.js typeProof: its module loads, and the like), with its types
// set aside: `before` and `after` the texts of each side's lines that hold
// what runs (`runs`, `otherRuns`, `[from, to)` each), to be diffed in place of
// the files'; `lineOf`, by side, each of their lines' line in its file, and
// `lines` the file's count of them, for diffRows to show where its other
// lines, of types alone, stand between them. Null where setting those aside would hide
// no change (each side's lines of types the same, in order) or leave none to
// show (its lines that run the same): its diff is drawn whole then.
export function typeFolds(before, after, { runs, otherRuns }) {
  const side = (text, ranges) => {
    const lineOf = [], lines = textLines(text)
    for (const [from, to] of ranges) for (let i = from; i < Math.min(to, lines.length); i++) lineOf.push(i)
    const run = lineOf.map(i => lines[i]), shown = new Set(lineOf)
    // A last line with no newline after it stays so where it is shown.
    const open = text !== '' && !text.endsWith('\n') && lineOf.at(-1) === lines.length - 1
    return { text: run.length === 0 ? '' : `${run.join('\n')}${open ? '' : '\n'}`, lineOf, lines: lines.length, run: run.join('\n'),
      types: lines.filter((_, i) => !shown.has(i)).join('\n') }
  }
  const a = side(before, runs), b = side(after, otherRuns)
  if (a.types === b.types || a.run === b.run) return null
  return { before: a.text, after: b.text, lineOf: { a: a.lineOf, b: b.lineOf }, lines: { a: a.lines, b: b.lines } }
}

// Rows of a diff of a file's lines that run (typeFolds), a `types` row before
// each where lines of types alone stand before it on either side, and after
// the last where they end the file: `a` and `b` those lines, `{ from, to }`
// of its file, or null where that side has none there. Unified, a change's
// removed lines come before its added ones: the types that stand before the
// first added are told with those before the first removed, a row for both
// ahead of the change, as split tells them, not one between its two halves.
function withTypes(rows, { lineOf, lines }) {
  const next = { a: 0, b: 0 }, out = []
  const types = to => {
    const [a, b] = ['a', 'b'].map(side => (to[side] > next[side] ? { from: next[side], to: to[side] } : null))
    if (a || b) out.push({ kind: 'types', a, b })
    next.a = Math.max(next.a, to.a)
    next.b = Math.max(next.b, to.b)
  }
  for (const [i, row] of rows.entries()) {
    const at = row.kind === 'change' ? { a: row.left, b: row.right } : row
    // The first added line of the change a run of removed lines starts, where it adds any.
    let added = null
    if (row.kind === 'del' && rows[i - 1]?.kind !== 'del') {
      let after = i + 1
      while (rows[after]?.kind === 'del') after++
      if (rows[after]?.kind === 'add') added = lineOf.b[rows[after].b]
    }
    const line = { a: at.a == null ? next.a : lineOf.a[at.a], b: at.b == null ? added ?? next.b : lineOf.b[at.b] }
    types(line)
    if (at.a != null) next.a = line.a + 1
    if (at.b != null) next.b = line.b + 1
    out.push(row)
  }
  types(lines)
  return out
}

// A file's lines added and removed between its two sides as they are, for a
// tree to list beside it, as an npm dependency review's tree counts them:
// none where a side is not text, nor for a file too large to count while a
// tree draws (counted there as its diff draws, once drawn), an added or
// removed one's lines counted without a diff.
const COUNT_CHARS = 2_000_000
const COUNT_LINES = 20_000
const lineCount = text => {
  let count = Number(text !== '' && !text.endsWith('\n'))
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++
  return count
}
export function fileLineCounts(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') return null
  if (before === after) return { additions: 0, deletions: 0 }
  if (before === '') return { additions: lineCount(after), deletions: 0 }
  if (after === '') return { additions: 0, deletions: lineCount(before) }
  if (before.length + after.length > COUNT_CHARS || lineCount(before) + lineCount(after) > COUNT_LINES) return null
  let additions = 0, deletions = 0
  for (const { a0, a1, b0, b1 } of changeBlocks(before, after)) {
    additions += b1 - b0
    deletions += a1 - a0
  }
  return { additions, deletions }
}

// Whether hiding whitespace changes hides one between two texts: whether the
// blocks a diff of them shows with those hidden, or diff -b's where none are
// given, pair as unchanged lines that differ (blocksHold).
export const hidesWhitespace = (before, after, blocks = changeBlocks(before, after, true)) => !blocksHold(before, after, blocks)

// A stylesheet's strings, as risk reads them (risk/files/script.js): it has no
// `//` comments, so `url(https://…)` is code.
const CSS_STRING = /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|\/\*[\s\S]*?\*\//gu
const STYLESHEET = /\.(?:css|scss|less)$/iu

// A text's literals, line by line: the parts of its strings, templates and
// regular expressions on each line (a template's whole line where one runs on
// past it), NUL apart, as risk sets them apart from code (JS_STRING_OR_COMMENT,
// in one linear pass), a stylesheet's strings by its own reading, a file that
// is neither read as JavaScript is, whose quotes it reads alike. `path` names
// which it is.
function literalLines(path, text) {
  const pattern = STYLESHEET.test(path) ? CSS_STRING : JS_STRING_OR_COMMENT
  const starts = [0]
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1)
  const pieces = starts.map(() => [])
  let line = 0
  for (const match of text.matchAll(pattern)) {
    if (match[1] === undefined) continue
    const from = match.index + match[0].indexOf(match[1]), to = from + match[1].length
    while (line + 1 < starts.length && starts[line + 1] <= from) line++
    for (let at = line; at < starts.length && starts[at] < to; at++) {
      const end = at + 1 < starts.length ? starts[at + 1] - 1 : text.length
      pieces[at].push(text.slice(Math.max(from, starts[at]), Math.min(to, end)))
    }
  }
  return pieces.map(list => list.join('\0'))
}

// Whether diff -b, as `blocks` were found with it, hides blanks changing
// within a literal, whose value they are part of: a line it keeps as
// unchanged though it differs, and its strings, templates or regular
// expressions with it (`"a b"` and `"a  b"`, `/a b/` and `/a  b/`, a
// template's line indented anew), as a file whose whitespace means nothing
// but in its strings (whitespaceInsensitive) has them. `path` says how its
// literals are read (literalLines); each text is read only once a line it
// keeps differs.
export function hidesLiteralWhitespace(path, before, after, blocks) {
  const a = textLines(before), b = textLines(after)
  let ai = 0, bi = 0, news = null, olds = null
  for (let run = 0; run <= blocks.length; run++) {
    const end = run < blocks.length ? blocks[run].a0 : a.length
    for (; ai < end; ai++, bi++) {
      if (a[ai] === b[bi]) continue
      olds ??= literalLines(path, before)
      news ??= literalLines(path, after)
      if (olds[ai] !== news[bi]) return true
    }
    if (run < blocks.length) ({ a1: ai, b1: bi } = blocks[run])
  }
  return false
}

// Why diff -b, as `blocks` were found with it, may not hide what it would
// between two texts, of a file at `path`, or null where it may: blanks of more
// than one kind changing (`mixed`, hidesMixedWhitespace, which also takes
// blocks that are none for it), else blanks within a literal (`literal`,
// hidesLiteralWhitespace). A view shows whitespace changes then.
export const whitespaceKept = (path, before, after, blocks) => (hidesMixedWhitespace(before, after, blocks) ? 'mixed'
  : hidesLiteralWhitespace(path, before, after, blocks) ? 'literal' : null)

// What diff -b would hide between two texts, of a file at `path`: whether it
// hides a change at all (`hides`), and whether one it hides mixes kinds of
// blank (`mixed`), as spaces turned to a tab, or lies within a literal
// (`literal`), neither of which a view hides (whitespaceKept).
export function whitespaceHidden(before, after, path = '') {
  const blocks = changeBlocks(before, after, true)
  const mixed = hidesMixedWhitespace(before, after, blocks)
  return { hides: hidesWhitespace(before, after, blocks), mixed, literal: !mixed && hidesLiteralWhitespace(path, before, after, blocks) }
}

// Files whose whitespace means nothing but in their strings, the only ones in
// which a view hides whitespace changes: JavaScript and TypeScript, JSON, CSS
// and its preprocessors, HTML and XML, and the brace languages (C, C++, Java,
// Kotlin, Go, Rust, C#, Swift, PHP) and shell. Anything else may hold its
// meaning in its whitespace -- Python's, YAML's or Markdown's indentation, a
// Makefile's tabs, a language no one listed -- and shows all of it. Told by
// the format a stasis bundle records for the file, where it records one, of
// the formats stasis knows (its own spelling of a file's language); else by
// extension, or by a script's #! line, one of those known to run Node, Deno,
// Bun or a shell, whole: none is read apart, so no option is taken for one.
const INSENSITIVE_FORMATS = new Set(['module', 'commonjs', 'module-typescript', 'commonjs-typescript', 'json', 'solidity', 'php', 'shell', 'rust',
  'java', 'kotlin', 'gradle', 'objc', 'objcpp', 'swift', 'c', 'cpp', 'c-header', 'cpp-header', 'xml', 'cmake', 'pbxproj'])
const INSENSITIVE = /\.(?:[cm]?js|jsx|[cm]?ts|tsx|json5?|jsonc|css|scss|less|html?|xhtml|xml|svg|c|h|cc|cpp|cxx|hh|hpp|hxx|java|kts?|go|rs|cs|swift|php|sh|bash|zsh)$/u
const INSENSITIVE_SCRIPTS = new Set([
  '#!/usr/bin/env node', '#! /usr/bin/env node', '#!/usr/bin/node', '#!/usr/local/bin/node', '#!/usr/bin/env nodejs', '#!/usr/bin/env deno', '#!/usr/bin/env bun',
  '#!/bin/sh', '#! /bin/sh', '#!/bin/sh -e', '#!/usr/bin/env sh', '#!/bin/bash', '#! /bin/bash', '#!/bin/bash -e', '#!/usr/bin/env bash',
  '#!/bin/zsh', '#!/usr/bin/env zsh', '#!/bin/dash',
])
export function whitespaceInsensitive(path, text = '', format = undefined) {
  if (typeof format === 'string') return INSENSITIVE_FORMATS.has(format)
  return INSENSITIVE.test(path.toLowerCase()) || (typeof text === 'string' && INSENSITIVE_SCRIPTS.has(text.split('\n', 1)[0]))
}

// The rows of a diff: unchanged (`ctx`) lines, `fold` rows standing for the
// unchanged lines between changes that are out of context, and each change
// block's lines. A fold is keyed by the index of the unchanged run it sits
// in; `expansion` maps that key to the lines revealed beyond the context at
// the run's top and bottom, or `all`. Unified, a block is its removed
// (`del`) lines and then its added (`add`) ones, a line paired with its
// counterpart on the other side (see alignBlock) naming it as its `pair`.
// Split, a block is `change` rows of a removed line `left` and an added
// line `right`, either null where that side has run out. A diff of a file's
// lines that run, its types set aside (typeFolds), folds none of them, a few
// as they are, and shows where its types stand between them (withTypes).
export function diffRows(model, expansion = new Map(), { context = model.typeFolds ? Infinity : DIFF_CONTEXT, split = false } = {}) {
  const { a, blocks } = model
  const rows = []
  let ai = 0, bi = 0
  for (let run = 0; run <= blocks.length; run++) {
    const block = blocks[run]
    const length = (block ? block.a0 : a.length) - ai
    const first = run === 0, last = run === blocks.length
    const open = expansion.get(run)
    const head = first ? 0 : context + (open?.top ?? 0)
    const tail = last ? 0 : context + (open?.bottom ?? 0)
    if (open?.all || length - head - tail < MIN_FOLD) {
      for (let i = 0; i < length; i++) rows.push({ kind: 'ctx', a: ai + i, b: bi + i })
    } else {
      for (let i = 0; i < head; i++) rows.push({ kind: 'ctx', a: ai + i, b: bi + i })
      rows.push({ kind: 'fold', run, a: ai + head, b: bi + head, count: length - head - tail, up: !last, down: !first })
      for (let i = length - tail; i < length; i++) rows.push({ kind: 'ctx', a: ai + i, b: bi + i })
    }
    if (!block) break
    const aligned = alignedBlock(model, run)
    if (split) {
      for (const [left, right, paired] of aligned) rows.push({ kind: 'change', change: run, left, right, paired })
    } else {
      const pairOfA = new Map(), pairOfB = new Map()
      for (const [left, right, paired] of aligned) {
        if (paired) { pairOfA.set(left, right); pairOfB.set(right, left) }
      }
      for (let i = block.a0; i < block.a1; i++) rows.push({ kind: 'del', a: i, change: run, pair: pairOfA.get(i) ?? null })
      for (let j = block.b0; j < block.b1; j++) rows.push({ kind: 'add', b: j, change: run, pair: pairOfB.get(j) ?? null })
    }
    ai = block.a1
    bi = block.b1
  }
  return model.typeFolds ? withTypes(rows, model.typeFolds) : rows
}

// A block's lines as rows of [removed line, added line, paired]: each removed
// line paired with the added line it was edited into (pairLines), the lines
// left between pairs sharing rows by position, unpaired.
function alignBlock(model, block) {
  return alignLines(model.a, model.b, block)
}

// How long a line may be for a word view to read it (@preventive/compare's
// words.js), past which it has none, nor does pairLines pair it: a minified
// line, which a change to one token leaves changed whole.
const WORD_REACH = 2000
const pastWords = (x, y) => x.length > WORD_REACH || y.length > WORD_REACH

// What differs between two lines past a word view's reach (pastWords), as
// ranges a view marks, `{ a, b }`, `[from, to)` each: what lies between all
// they share at their start and at their end, one range on each side that
// holds any, so that a change to one token of a minified line is found where
// it is, whatever else of the line is the same. Linear in the lines, its
// ends never splitting a pair of surrogates.
export function affixRanges(x, y) {
  const shorter = Math.min(x.length, y.length)
  let head = 0, tail = 0
  while (head < shorter && x[head] === y[head]) head++
  if (head > 0 && /[\uDC00-\uDFFF]/u.test(x[head] ?? y[head] ?? '')) head--
  while (tail < shorter - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++
  if (tail > 0 && /[\uDC00-\uDFFF]/u.test(x[x.length - tail])) tail--
  const range = line => (head < line.length - tail ? [[head, line.length - tail]] : [])
  return { a: range(x), b: range(y) }
}

// The ranges a view marks of a removed line and the added line it pairs
// with: their changed words (wordRanges), else, where either is past a word
// view's reach, what differs between them (affixRanges); null for none.
export const changedRanges = (x, y) => wordRanges(x, y) ?? (pastWords(x, y) ? affixRanges(x, y) : null)

// The same, of a block between two texts' lines `a` and `b`, as a split diff
// draws its rows (and Compare's code search lists their hits). Two lines
// sharing a row that pairLines leaves apart, where either is past a word
// view's reach, are paired as one line edited (changedRanges marks them),
// as none of their words can pair them, a minified line's.
export function alignLines(a, b, block) {
  const pairs = pairLines(a.slice(block.a0, block.a1), b.slice(block.b0, block.b1)).map(([i, j]) => [block.a0 + i, block.b0 + j])
  const rows = []
  let i = block.a0, j = block.b0
  for (const [pa, pb] of [...pairs, [block.a1, block.b1]]) {
    while (i < pa || j < pb) {
      const left = i < pa ? i++ : null, right = j < pb ? j++ : null
      rows.push([left, right, left !== null && right !== null && pastWords(a[left], b[right])])
    }
    if (pa < block.a1) {
      rows.push([pa, pb, true])
      i = pa + 1
      j = pb + 1
    }
  }
  return rows
}

// Alignments are kept on the model: a fold opening re-lists every row, and
// Compare's code search lists a block's hits in them. `model` any holder of
// lines `a` and `b` and their `blocks`, `run` the block's index there.
export function alignedBlock(model, run) {
  model.aligned ??= new Map()
  if (!model.aligned.has(run)) model.aligned.set(run, alignBlock(model, model.blocks[run]))
  return model.aligned.get(run)
}

// Wrap the characters in `ranges` of one line's highlighted markup in
// `<mark>`, the markup's own tags left as they are: a mark closes before a
// tag and reopens after it, so the two never cross. The markup is Prism's
// (see prism-highlight.js splitHighlightedLines): only tags and `&…;`
// entities, each entity one character of the line.
export function markHighlighted(markup, ranges, open = '<mark class="diff-word">', close = '</mark>') {
  if (!ranges || ranges.length === 0) return markup
  let marked = false, out = '', pos = 0, r = 0
  const settle = () => {
    while (r < ranges.length && pos >= ranges[r][1]) {
      if (marked) { out += close; marked = false }
      r++
    }
  }
  for (let i = 0; i < markup.length;) {
    settle()
    if (markup[i] === '<') {
      const end = markup.indexOf('>', i)
      const tag = end === -1 ? markup.slice(i) : markup.slice(i, end + 1)
      out += marked ? close + tag + open : tag
      i += tag.length
      continue
    }
    if (!marked && r < ranges.length && pos >= ranges[r][0]) { out += open; marked = true }
    const semi = markup[i] === '&' ? markup.indexOf(';', i) : -1
    const unit = semi === -1 || semi - i > 10 ? markup[i] : markup.slice(i, semi + 1)
    out += unit
    i += unit.length
    pos++
  }
  settle()
  return marked ? out + close : out
}

// The same marks over a plain line, as segments a template can render
// without touching markup.
export function markSegments(text, ranges) {
  if (!ranges || ranges.length === 0) return [{ text, marked: false }]
  const segments = []
  let at = 0
  for (const [from, to] of ranges) {
    if (from > at) segments.push({ text: text.slice(at, from), marked: false })
    if (to > from) segments.push({ text: text.slice(from, to), marked: true })
    at = to
  }
  if (at < text.length) segments.push({ text: text.slice(at), marked: false })
  return segments
}
