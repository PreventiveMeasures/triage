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
import { hidesMixedWhitespace, pairLines } from '@preventive/compare'
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
  const told = new Set((marks ?? []).map(({ a0, a1, b0, b1 }) => `${a0},${a1},${b0},${b1}`))
  const marked = new Set()
  blocks.forEach(({ a0, a1, b0, b1 }, i) => {
    if (told.has(`${a0},${a1},${b0},${b1}`) && a1 - a0 === b1 - b0) marked.add(i)
  })
  let additions = 0, deletions = 0, renamed = 0
  blocks.forEach((block, i) => {
    if (marked.has(i)) renamed += block.b1 - block.b0
    else {
      additions += block.b1 - block.b0
      deletions += block.a1 - block.a0
    }
  })
  // A last line with no newline after it: shown on a changed row, since a
  // newline added or dropped at the end is a change of that line alone.
  const noEol = { a: before !== '' && !before.endsWith('\n'), b: after !== '' && !after.endsWith('\n') }
  // `words` keeps the marks of each pair a render asks for.
  return { a, b, blocks, additions, deletions, renamed, marked, noEol, words: new Map() }
}

// A file's lines added and removed between its two sides as they are, for a
// tree to list beside it, as an npm dependency review's tree counts them:
// none where a side is not text, nor for a file too large to count while a
// tree draws (its diff can still be asked for), an added or removed one's
// lines counted without a diff.
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

// What diff -b would hide between two texts: whether it hides a change at all
// (`hides`), and whether one it hides mixes kinds of blank (`mixed`), as spaces
// turned to a tab, which no view hides (hidesMixedWhitespace).
export function whitespaceHidden(before, after) {
  const blocks = changeBlocks(before, after, true)
  return { hides: hidesWhitespace(before, after, blocks), mixed: hidesMixedWhitespace(before, after, blocks) }
}

// Files whose indentation is part of what they say, in which no view hides a
// whitespace change: Python's and YAML's nesting (Cython's, Starlark's, and
// the build files written in them), a Makefile's recipes, the indented
// template and style languages; and TSV, whose tabs part its fields. Told by
// name, or by a script's #! line naming Python or CoffeeScript.
const INDENTED = /\.(?:py[iwx]?|pxd|pxi|bzl|star|ya?ml|mk|mak|make|coffee|litcoffee|cson|pug|jade|haml|slim|sass|styl|nim|hs|lhs|elm|tsv)$/u
const INDENTED_NAMES = /(?:^|\/)(?:(?:GNU|BSD)?[Mm]akefile(?:\.(?:am|in))?|SConstruct|SConscript|Snakefile|wscript|(?:BUILD|WORKSPACE)(?:\.bazel)?)$/u
const INDENTED_SCRIPT = /^#![^\n]*\b(?:python|pypy|coffee)/u
export const indentationMatters = (path, text = '') => INDENTED.test(path.toLowerCase()) || INDENTED_NAMES.test(path)
  || (typeof text === 'string' && INDENTED_SCRIPT.test(text))

// The rows of a diff: unchanged (`ctx`) lines, `fold` rows standing for the
// unchanged lines between changes that are out of context, and each change
// block's lines. A fold is keyed by the index of the unchanged run it sits
// in; `expansion` maps that key to the lines revealed beyond the context at
// the run's top and bottom, or `all`. Unified, a block is its removed
// (`del`) lines and then its added (`add`) ones, a line paired with its
// counterpart on the other side (see alignBlock) naming it as its `pair`.
// Split, a block is `change` rows of a removed line `left` and an added
// line `right`, either null where that side has run out.
export function diffRows(model, expansion = new Map(), { context = DIFF_CONTEXT, split = false } = {}) {
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
  return rows
}

// A block's lines as rows of [removed line, added line, paired]: each removed
// line paired with the added line it was edited into (pairLines), the lines
// left between pairs sharing rows by position, unpaired.
function alignBlock(model, block) {
  const { a, b } = model
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

// Alignments are kept on the model: a fold opening re-lists every row.
function alignedBlock(model, run) {
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
