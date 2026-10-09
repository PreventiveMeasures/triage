// Pure model behind the Compare slide's Code view — no Lit, no DOM, no
// `state`. Two texts in, what a review needs out: the change blocks
// between them (found by @preventive/diff), the rows a unified or split
// diff shows with unchanged runs folded down to their context, the
// words that changed inside a changed line, and those words marked in a
// line's syntax-highlighted markup.
//
// Lines are numbered the way the diff numbers them: from zero, a final
// newline ending the last line rather than starting an empty one.
import { diff, parseDiff } from '@preventive/diff'

// Unchanged lines kept on each side of a change, as `diff -u` keeps them.
export const DIFF_CONTEXT = 3
// Lines one click on a fold's expand-up / expand-down reveals.
export const EXPAND_STEP = 20
// A fold hides at least this many lines; fewer show as they are, since the
// fold's own row would take nearly the room they do.
const MIN_FOLD = 4

export function textLines(text) {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

// The change blocks between two texts, each `a[a0..a1)` replaced by
// `b[b0..b1)`, with the lines on each side and the count of each. An
// added file is diffed against '' and a removed one against it, so all
// three kinds of change share one model. `ignoreWhitespace` is diff -w:
// lines differing only in whitespace pair up as unchanged.
export function lineDiff(before, after, { ignoreWhitespace = false } = {}) {
  const a = textLines(before), b = textLines(after)
  const text = diff(before, after, { format: 'unified', context: 0, whitespace: ignoreWhitespace ? 'all' : 'none' })
  const blocks = text ? (parseDiff(text)[0]?.blocks ?? []).map(({ a0, a1, b0, b1 }) => ({ a0, a1, b0, b1 })) : []
  let additions = 0, deletions = 0
  for (const block of blocks) {
    additions += block.b1 - block.b0
    deletions += block.a1 - block.a0
  }
  // A last line with no newline after it: shown on a changed row, since a
  // newline added or dropped at the end is a change of that line alone.
  const noEol = { a: before !== '' && !before.endsWith('\n'), b: after !== '' && !after.endsWith('\n') }
  // `words` keeps the marks of each pair a render asks for.
  return { a, b, blocks, additions, deletions, noEol, words: new Map() }
}

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

// Words, runs of whitespace, and single symbols: the units a changed line
// is compared by, so `foo(a)` → `foo(b)` marks `a` and `b` alone.
const TOKEN = /[\p{L}\p{N}_$]+|\s+|[^\p{L}\p{N}_$\s]/gu
// Past these a word diff is noise (minified lines) or too slow to be worth
// it; the line keeps its whole-line color alone.
const WORD_DIFF_MAX_CHARS = 2000
const WORD_DIFF_MAX_TOKENS = 800
// Lines whose words are mostly replaced are not the same line edited: they
// don't pair, and their words aren't marked.
const WORD_DIFF_MAX_CHANGED = .6
// A removed line looks this many added lines ahead for its counterpart; a
// block longer than PAIR_MAX_LINES on either side lines up by position.
const PAIR_LOOKAHEAD = 6
const PAIR_MAX_LINES = 200

// How two lines differ word by word: the character ranges `[from, to)`
// that changed on each side (ranges split only by whitespace merged) and
// the smaller share of either line they cover. Null past the size limits.
function compareWords(left, right) {
  if (left.length > WORD_DIFF_MAX_CHARS || right.length > WORD_DIFF_MAX_CHARS) return null
  const lt = left.match(TOKEN) ?? [], rt = right.match(TOKEN) ?? []
  if (lt.length > WORD_DIFF_MAX_TOKENS || rt.length > WORD_DIFF_MAX_TOKENS) return null
  // Each distinct token becomes one line naming it, so the line diff runs
  // over tokens without a token's own characters (a `\r`) meaning anything.
  const ids = new Map()
  const encode = tokens => tokens.map(token => {
    if (!ids.has(token)) ids.set(token, String(ids.size))
    return `${ids.get(token)}\n`
  }).join('')
  const tokenDiff = diff(encode(lt), encode(rt), { format: 'unified', context: 0 })
  const blocks = tokenDiff ? parseDiff(tokenDiff)[0]?.blocks ?? [] : []
  const offsets = tokens => tokens.reduce((list, token) => { list.push(list.at(-1) + token.length); return list }, [0])
  const lo = offsets(lt), ro = offsets(rt)
  const ranges = (side, at, line) => mergeRanges(blocks.filter(block => block[`${side}1`] > block[`${side}0`])
    .map(block => [at[block[`${side}0`]], at[block[`${side}1`]]]), line)
  const a = ranges('a', lo, left), b = ranges('b', ro, right)
  const share = (list, line) => list.reduce((sum, [from, to]) => sum + to - from, 0) / Math.max(1, line.length)
  return { a, b, share: Math.min(share(a, left), share(b, right)) }
}

// The ranges to mark in a removed line and the added line it pairs with,
// or null when marking them would not help.
export function wordRanges(left, right) {
  if (left === right) return null
  const words = compareWords(left, right)
  return words && words.share <= WORD_DIFF_MAX_CHANGED ? { a: words.a, b: words.b } : null
}

// A block's lines as rows of [removed line, added line, paired]. Each
// removed line pairs with the most alike added line among the next few,
// in order, when they are alike enough to be one line edited; the lines
// left between pairs share rows by position, unpaired.
function alignBlock(model, block) {
  const { a, b } = model
  const pairs = []
  if (block.a1 - block.a0 <= PAIR_MAX_LINES && block.b1 - block.b0 <= PAIR_MAX_LINES) {
    let next = block.b0
    for (let i = block.a0; i < block.a1 && next < block.b1; i++) {
      let best = null, bestShare = Infinity
      for (let j = next; j < Math.min(block.b1, next + PAIR_LOOKAHEAD) && bestShare > 0; j++) {
        const words = a[i] === b[j] ? { share: 0 } : compareWords(a[i], b[j])
        if (words && words.share <= WORD_DIFF_MAX_CHANGED && words.share < bestShare) { best = j; bestShare = words.share }
      }
      if (best !== null) { pairs.push([i, best]); next = best + 1 }
    }
  }
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

function mergeRanges(ranges, text) {
  const merged = []
  for (const [from, to] of ranges) {
    const last = merged.at(-1)
    if (last && /^\s*$/u.test(text.slice(last[1], from))) last[1] = to
    else merged.push([from, to])
  }
  return merged
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
