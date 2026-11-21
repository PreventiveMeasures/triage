// Pure model behind Compare's Code view — no Lit, no DOM, no `state`: the
// change blocks between two texts (common/line-diff.js, or the server's with
// renamed names hidden), the rows a unified or split diff shows with
// unchanged runs folded, and the words changed inside a line marked in its
// highlighted markup. Lines are numbered from zero, a final newline ending
// the last line rather than starting an empty one.
import { hidesMixedWhitespace, pairLines } from '@preventive/compare/view.js'
import { blocksHold, changeBlocks, textLines } from '../../common/line-diff.js'

export { textLines }

// Unchanged lines kept on each side of a change, as `diff -u` keeps them.
export const DIFF_CONTEXT = 3
// Lines one click on a fold's expand-up / expand-down reveals.
export const EXPAND_STEP = 20
// A fold hides at least this many lines; fewer show as they are, since the
// fold's own row would take nearly the room they do.
const MIN_FOLD = 4

// The change blocks between two texts, each `a[a0..a1)` replaced by
// `b[b0..b1)`, with each side's lines and counts; an added or removed file
// is diffed against ''. `ignoreWhitespace` is diff -b. `changes` are blocks
// found elsewhere (the server's, its old side given the new one's names);
// `marks` the blocks the server found to differ in renamed names alone,
// those of these `marked` and counted apart (`renamed`).
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

// A file that changed in types alone but for what runs (type-only.js
// typeProof), its types set aside: `before` and `after` the texts of each
// side's lines that run (`runs`, `otherRuns`, `[from, to)` each), diffed in
// place of the files'; `lineOf` each of their lines' line in its file, and
// `lines` the file's count, for diffRows to show where the types stand. Null
// where that would hide no change or leave none to show.
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

// Rows of a diff of a file's lines that run (typeFolds), with a `types` row
// wherever lines of types alone stand before a row, or end the file: `a` and
// `b` those lines, `{ from, to }`, or null. Unified, the types before a
// change's first added line are told with those before its first removed,
// one row ahead of the change, as split tells them.
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

// A file's lines added and removed as published, for the tree: none where a
// side is not text, nor for a file too large to count while a tree draws.
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

// Whether hiding whitespace hides a change between two texts: whether
// `blocks` (diff -b's by default) pair as unchanged lines that differ.
export const hidesWhitespace = (before, after, blocks = changeBlocks(before, after, true)) => !blocksHold(before, after, blocks)

// What diff -b would hide between two texts: whether it hides a change
// (`hides`), and whether one mixes kinds of blank (`mixed`), which no view hides.
export function whitespaceHidden(before, after) {
  const blocks = changeBlocks(before, after, true)
  return { hides: hidesWhitespace(before, after, blocks), mixed: hidesMixedWhitespace(before, after, blocks) }
}

// Files whose whitespace means nothing but in their strings, the only ones in
// which a view hides whitespace changes: JS/TS, JSON, CSS, HTML/XML, the
// brace languages and shell. Anything else (Python's or YAML's indentation,
// a Makefile's tabs) shows all of it. Told by the format a stasis bundle
// records, else by extension, or by a whole #! line known to run Node, Deno,
// Bun or a shell.
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

// The rows of a diff: unchanged (`ctx`) lines, `fold` rows for unchanged
// lines out of context, and each change block's lines. A fold is keyed by
// its unchanged run's index; `expansion` maps that to the lines revealed at
// the run's top and bottom, or `all`. Unified, a block is its `del` lines
// then its `add` ones, each naming its paired line (alignLines) as `pair`;
// split, `change` rows of a removed `left` and added `right`, null where a
// side ran out. With its types set aside (typeFolds), nothing folds and the
// types show where they stand (withTypes).
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

// A block between two texts' lines `a` and `b` as rows of [removed line,
// added line, paired]: each removed line paired with the added line it was
// edited into (pairLines), the lines between pairs sharing rows by position.
export function alignLines(a, b, block) {
  const pairs = pairLines(a.slice(block.a0, block.a1), b.slice(block.b0, block.b1)).map(([i, j]) => [block.a0 + i, block.b0 + j])
  const rows = []
  let i = block.a0, j = block.b0
  for (const [pa, pb] of [...pairs, [block.a1, block.b1]]) {
    while (i < pa || j < pb) rows.push([i < pa ? i++ : null, j < pb ? j++ : null, false])
    if (pa < block.a1) {
      rows.push([pa, pb, true])
      i = pa + 1
      j = pb + 1
    }
  }
  return rows
}

// Alignments are kept on the model (any holder of `a`, `b` and `blocks`,
// `run` a block's index): a fold opening re-lists every row.
export function alignedBlock(model, run) {
  model.aligned ??= new Map()
  if (!model.aligned.has(run)) model.aligned.set(run, alignLines(model.a, model.b, model.blocks[run]))
  return model.aligned.get(run)
}

// Wrap the characters in `ranges` of one line's highlighted markup in
// `<mark>`: a mark closes before a tag and reopens after it, so the two never
// cross. Prism's markup holds only tags and `&…;` entities, each entity one
// character of the line.
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

// The same marks over a plain line, as segments for a template.
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
