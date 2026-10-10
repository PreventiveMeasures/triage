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

function changeBlocks(before, after, ignoreWhitespace) {
  const text = diff(before, after, { format: 'unified', context: 0, whitespace: ignoreWhitespace ? 'all' : 'none' })
  return text ? (parseDiff(text)[0]?.blocks ?? []).map(({ a0, a1, b0, b1 }) => ({ a0, a1, b0, b1 })) : []
}

// Words a minifier never renames, kept as they are when names are set aside.
const KEYWORDS = new Set(['arguments', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'eval', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get',
  'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'of', 'package', 'private', 'protected',
  'public', 'return', 'set', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void',
  'while', 'with', 'yield', 'Infinity', 'NaN'])
// Names a minifier gives: longer ones are an API's or a person's, and one
// changed is a change.
const RENAMED_MAX_LENGTH = 3
// What a text is read in, from where it is: a string, a template, a
// comment, a regular expression (where a value starts: `/` after one
// divides), a name, a bracket, or what lies between, operators and numbers.
const READ = /"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*'|`(?:[^`\\]|\\[\s\S])*`|\/\/.*|\/\*[\s\S]*?(?:\*\/|$)|\/(?:[^/\\[\n]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[a-z]*|(?<![\p{L}\p{N}_$.\\])[\p{L}_$][\p{L}\p{N}_$]*|[()[\]{}]/gu
// Words after which a value starts, so a `/` begins a regular expression.
const BEFORE_VALUE = new Set(['await', 'case', 'default', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'of', 'return', 'throw',
  'typeof', 'void', 'yield'])
// Words a `{` after which opens a block, as do `)`, `;`, `{`, `}`, `=>` and
// the start; any other opens an object, a pattern or a class body.
const BEFORE_BLOCK = new Set(['do', 'else', 'finally', 'try'])
// Words between a key's place and its key: `{ async a() {} }`.
const MODIFIERS = new Set(['async', 'get', 'set', 'static'])
// Words whose `(…)` a statement follows (`if (a) /b/.test(c)`), declaring
// nothing as a function's `(…)` does.
const CONTROL = new Set(['for', 'if', 'switch', 'while', 'with'])
// Words between `export` and the name it exports: `export async function a`,
// `export * as a`.
const DECLARES = new Set(['as', 'async', 'class', 'function'])
// Words the name after which a file declares: `function a`, `import b`.
const NAMING = new Set(['as', 'class', 'function', 'import'])
// After a function's `(…)`: its names were its parameters.
const PARAMETERS = /\s*(?:=>|\{)/uy
const ARROW = /\s*=>/uy
// What a set-aside name leaves in its line.
const NAMELESS = ''

// A text with its short names set aside (`key`, its lines where the text's
// are), and each line's names in order (`names`). Read as a whole, so a
// comment or a template spanning lines keeps all of them. Set aside only
// where the file declares them (`var`, `let`, `const`, `function`, `class`,
// `import`, `catch` and parameters), a global it doesn't (`Map`, `$`) being
// no minifier's to rename. Kept as they are: strings, templates, comments,
// regular expressions, keywords, names longer than a minifier gives,
// properties: after `.`, before `:`, or in an object's, a pattern's or a
// class's key place (`{ a, b() {}, c = 1 }`), and what a module exports
// (`export { a as b }`, `export const c = 1`), since renaming one changes
// what reads it.
function nameless(text) {
  const declared = new Set(), key = [], names = [[]], setAside = []
  const opens = []
  // Each `var`, `let` or `const` under way: the depth of its declarators,
  // whether in their names (before `=`, patterns too) rather than what they
  // are set to, whether exported. Each `(…)` under way but a statement's,
  // and the names in it: parameters, if `=>` or `{` follows. The depths
  // whose `=` began a default (`{ x = a }`), until their next `,`: no
  // names declared there.
  const declarations = [], defaulted = new Set(), groups = []
  const inDefault = (from, to = opens.length) => [...defaulted].some(depth => depth >= from && depth <= to)
  // `exporting` between `export` and its name; `naming` before a name
  // declared as `function a` is; `extending` the depth of an `extends`
  // whose class body is the next `{` there.
  let at = 0, exporting = false, extending = -1, keyPlace = false, last = null, naming = false
  const keep = segment => {
    key.push(segment)
    for (let i = segment.indexOf('\n'); i !== -1; i = segment.indexOf('\n', i + 1)) names.push([])
  }
  const between = segment => {
    keep(segment)
    let end = segment.length
    while (end > 0 && segment.codePointAt(end - 1) <= 32) end--
    if (end === 0) return
    last = segment[end - 1]
    // A line break no operator spans may end a statement, as `;` does, or a class field.
    const line = segment.lastIndexOf('\n')
    const ends = line !== -1 && !/[,=+\-*/%&|^<>?:!~.]$/u.test(segment.slice(0, line).trimEnd()) && !/^[,=+\-*/%&|^<>?:.)\]}]/u.test(segment.slice(line + 1).trimStart())
    if (ends && declarations.at(-1)?.depth === opens.length) declarations.pop()
    const declaration = declarations.at(-1)
    const next = segment.lastIndexOf(','), set = segment.search(/(?<![=!<>])=(?![=>])[^=]*$/u)
    if (declaration?.depth === opens.length && set !== next) declaration.binding = next > set
    else if (set > next) defaulted.add(opens.length)
    else if (next > set || segment.includes(';')) defaulted.delete(opens.length)
    if (segment.includes(';')) while (declarations.length > 0 && opens.length <= declarations.at(-1).depth) declarations.pop()
    // A generator's `*` leaves its name in its key place, or to be declared.
    if (last === '*' && segment.slice(0, end - 1).trim() === '') return
    exporting = naming = false
    const place = last === '*' ? segment.slice(0, end - 1).trimEnd().at(-1) : last
    keyPlace = (place === ',' || place === ';') && opens.at(-1) === 'object'
  }
  // Ending its line, a value ends its class field: the next name is a key.
  const lineEnd = segment => {
    const line = segment.lastIndexOf('\n')
    if (line !== -1 && opens.at(-1) === 'object' && segment.slice(line + 1).trim() === '' && !/[,=+\-*/%&|^<>?:!~.]$/u.test(segment.slice(0, line).trimEnd())) keyPlace = true
  }
  for (READ.lastIndex = 0; ;) {
    const match = READ.exec(text)
    const gap = text.slice(at, match?.index ?? text.length)
    between(gap)
    lineEnd(gap)
    if (!match) break
    const [token] = match
    const first = token[0]
    if (first === '/' && token[1] !== '/' && token[1] !== '*' && (/^[\p{L}\p{N}_$)\]"]$/u.test(last) || (last?.length > 1 && !BEFORE_VALUE.has(last)))) {
      // A division: the `/` is an operator, and what follows is read again.
      at = match.index
      READ.lastIndex = at + 1
      between('/')
      at++
      continue
    }
    at = READ.lastIndex
    if (first === '/' && (token[1] === '/' || token[1] === '*')) keep(token)
    else if (first === '"' || first === "'" || first === '`' || first === '/') {
      keep(token)
      last = '"'
      exporting = keyPlace = naming = false
    } else if (first === '(' || first === '[' || first === '{') {
      key.push(token)
      // A class's body after its `extends`, whatever that ends with: `extends mixin(Base) {`.
      const block = first === '{' && extending !== opens.length && (last === null || ');{}>'.includes(last) || BEFORE_BLOCK.has(last))
      if (first === '{' && extending === opens.length) extending = -1
      // A `[…]` in a key's place is a computed key, its names references: `{ [a]: x }`.
      const open = first === '{' ? last === 'export' ? 'export' : block ? 'block' : 'object'
        : first === '(' && CONTROL.has(last) ? 'control' : first === '[' && keyPlace ? 'computed' : first
      opens.push(open)
      if (open === '(') groups.push({ depth: opens.length, names: [] })
      last = first
      keyPlace = first === '{' && !block
      exporting = naming = false
    } else if (first === ')' || first === ']' || first === '}') {
      key.push(token)
      const open = opens.pop()
      if (open === '(') {
        const group = groups.pop()
        PARAMETERS.lastIndex = at
        if (PARAMETERS.test(text)) for (const name of group.names) declared.add(name)
      }
      // After a statement's condition, as after `;`, a statement starts.
      last = open === 'control' ? ';' : first
      keyPlace = first === '}' && opens.at(-1) === 'object'
      exporting = naming = false
      for (const depth of defaulted) if (depth > opens.length) defaulted.delete(depth)
      while (declarations.length > 0 && opens.length < declarations.at(-1).depth) declarations.pop()
    } else {
      const declaration = declarations.at(-1), group = groups.at(-1)
      const binding = declaration?.binding && opens.length >= declaration.depth && !inDefault(declaration.depth + 1)
        && !opens.slice(declaration.depth).includes('computed')
      const exported = opens.at(-1) === 'export' || (exporting && !KEYWORDS.has(token)) || (binding && declaration.exported)
      // A property: `.` before it, spaces or a comment between (`a . b`), or `:` after it.
      const property = last === '.' || text[at] === ':'
      if (token.length > RENAMED_MAX_LENGTH || KEYWORDS.has(token) || keyPlace || exported || property) key.push(token)
      else {
        setAside.push([key.length, names.length - 1, token])
        key.push(NAMELESS)
      }
      ARROW.lastIndex = at
      // A pattern's key (`{ a: x }`) names what is read, not what is bound.
      const read = text[at] === ':' || last === '.'
      if (!read && (naming || binding || ARROW.test(text))) declared.add(token)
      if (!read && group && !inDefault(group.depth) && !opens.slice(group.depth).includes('computed')) group.names.push(token)
      if (token === 'extends') extending = opens.length
      if (binding && (token === 'in' || token === 'of')) declaration.binding = false
      if (token === 'const' || token === 'let' || token === 'var') declarations.push({ binding: true, depth: opens.length, exported: exporting })
      if (token === 'export') exporting = true
      else if (!DECLARES.has(token)) exporting = false
      naming = NAMING.has(token) || (naming && token === 'async')
      // `for await (` is a `for`'s condition still.
      if (!(keyPlace && MODIFIERS.has(token)) && !(token === 'await' && last === 'for')) {
        last = token
        keyPlace = false
      }
    }
  }
  // A name the file never declares is a global's, kept.
  for (const [piece, line, name] of setAside) {
    if (declared.has(name)) names[line].push(name)
    else key[piece] = name
  }
  return { key: key.join(''), names }
}

// The change blocks between two texts' lines with names renamed alike left
// out, and the removed lines so left out. Lines pair up as they are with
// their names set aside, then every pair, unchanged ones too, tells which
// name became which; a pair whose names differ is left out only when each
// of its names stands for the one other throughout, neither side's ever
// standing for a second. Any other (a name renamed two ways, or two names
// renamed to one, as a line's `a` → `b` beside unchanged lines naming both)
// is a change.
function renameBlocks(before, after, a, b, ignoreWhitespace) {
  const na = nameless(before), nb = nameless(after)
  const found = changeBlocks(na.key, nb.key, ignoreWhitespace)
  const pairs = []
  let i = 0, j = 0
  for (const block of [...found, { a0: a.length, a1: a.length, b0: b.length, b1: b.length }]) {
    while (i < block.a0) pairs.push([i++, j++])
    i = block.a1
    j = block.b1
  }
  const backward = new Map(), forward = new Map()
  const link = (map, from, to) => { if (!map.has(from)) map.set(from, new Set()); map.get(from).add(to) }
  for (const [pa, pb] of pairs) na.names[pa].forEach((name, k) => { link(forward, name, nb.names[pb][k]); link(backward, nb.names[pb][k], name) })
  const sole = (from, to) => forward.get(from).size === 1 && backward.get(to).size === 1
  const blocks = [], renamed = new Set()
  const add = block => {
    const last = blocks.at(-1)
    if (last && last.a1 === block.a0 && last.b1 === block.b0) { last.a1 = block.a1; last.b1 = block.b1 } else blocks.push({ ...block })
  }
  let next = 0
  for (const [pa, pb] of pairs) {
    while (next < found.length && found[next].a0 <= pa) add(found[next++])
    const names = na.names[pa], others = nb.names[pb]
    if (names.every((name, k) => name === others[k])) continue
    if (names.every((name, k) => sole(name, others[k]))) renamed.add(pa)
    else add({ a0: pa, a1: pa + 1, b0: pb, b1: pb + 1 })
  }
  while (next < found.length) add(found[next++])
  return { blocks, renamed }
}

// A tag where a value starts (`(<a />`, `=> <b>`, `return <i>`, `yield <p>`, a
// fragment's `<>` before what it holds, not `[&<>"']`'s): JSX, whose
// tags are no bindings, so its file's names are not set aside.
const JSX = /(?:^|[(=,:?&|!{};>[]|\b(?:await|case|default|do|else|return|throw|yield))[ \t]*<(?:\/?[A-Za-z][\w.:-]*(?:\s|\/?>)|>(?=[\s<{\p{L}]))/mu

// The change blocks between two texts, each `a[a0..a1)` replaced by
// `b[b0..b1)`, with the lines on each side and the count of each. An
// added file is diffed against '' and a removed one against it, so all
// three kinds of change share one model. `ignoreWhitespace` is diff -w:
// lines differing only in whitespace pair up as unchanged. With
// `ignoreRenames`, so do lines differing only in short names renamed alike
// throughout (renameBlocks), as a minifier renames them from one build to
// the next; `renamed` holds such removed lines.
export function lineDiff(before, after, { ignoreWhitespace = false, ignoreRenames = false } = {}) {
  const a = textLines(before), b = textLines(after)
  const { blocks, renamed } = ignoreRenames && !JSX.test(before) && !JSX.test(after) ? renameBlocks(before, after, a, b, ignoreWhitespace) : { blocks: changeBlocks(before, after, ignoreWhitespace), renamed: new Set() }
  let additions = 0, deletions = 0
  for (const block of blocks) {
    additions += block.b1 - block.b0
    deletions += block.a1 - block.a0
  }
  // A last line with no newline after it: shown on a changed row, since a
  // newline added or dropped at the end is a change of that line alone.
  const noEol = { a: before !== '' && !before.endsWith('\n'), b: after !== '' && !after.endsWith('\n') }
  // `words` keeps the marks of each pair a render asks for.
  return { a, b, blocks, renamed, additions, deletions, noEol, words: new Map() }
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

// The index of the first row at or after `from` that starts a change
// block, or -1 when none does.
export function changeStart(rows, from) {
  for (let i = Math.max(from, 0); i < rows.length; i++) {
    const { change } = rows[i]
    if (change !== undefined && rows[i - 1]?.change !== change) return i
  }
  return -1
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
