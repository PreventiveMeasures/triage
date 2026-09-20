// Shared structural-markdown helpers for the report parsers: fence-
// aware heading splitting, table reading, and labelled-field
// extraction. parse-piolium.js reads through all of them; parse-md.js
// and parse-deepsec.js share only the heading-line split and keep their
// own (subtly different) section and label readers — fold those in only
// with their behavior pinned by tests first, since finding ids are
// derived from parser output and a drift in parsing silently re-keys
// stored triage.

// Byte ranges of fenced code blocks (``` / ~~~), fences included. The
// closing fence must use the opening marker, so a `~~~` line inside a
// backtick fence stays content. A dangling opening fence runs to end of
// input — the same reading markdown renderers give it. Computed once
// per text and consulted by every structural splitter so a code line
// beginning with `## ` / `### ` / `| ` can't be read as structure.
//
// A fence may be INDENTED, and how far it's allowed to be depends on
// the list around it: three spaces at the top level (markdown's own
// limit, past which a line is indented code rather than a fence), and
// three past the content column of the innermost open list item when
// there is one — which is how a snippet under a numbered step is
// written:
//
//     2. Bar.
//        ```js
//        http.request({}, cb)
//        ```
//
// Tracking that column rather than simply widening the limit is what
// keeps the two readings apart: a block indented FURTHER than its
// item's text is an indented code block inside that item, and its
// ``` lines are content — the same call markdown makes. A step past
// the ninth (`10.`) or a nested bullet pushes the column out, which is
// why it's tracked instead of assumed.
const FENCE_RE = /^( *)(```|~~~)/u
// A list marker and the gap to its text; `m[0].length` is the column
// the item's continuation lines are indented to.
const LIST_MARKER_RE = /^( *)(?:[-*+]|\d{1,9}[.)]) +(?=\S)/u

export function fenceRanges(text) {
  const ranges = []
  let open = -1
  let marker = ''
  let openIndent = 0
  // Content column of the innermost open list item; 0 outside a list.
  let itemIndent = 0
  let pos = 0
  for (const line of text.split('\n')) {
    const start = pos
    pos += line.length + 1
    const fence = FENCE_RE.exec(line)
    if (open !== -1) {
      // A closing fence carries the item's indentation too, and needn't
      // match the opening one's exactly — but the MARKER still has to,
      // so a ``` inside a ~~~ block stays content.
      if (fence && fence[2] === marker && fence[1].length <= openIndent + 3) {
        ranges.push([open, start + line.length])
        open = -1
      }
      continue
    }
    if (fence && fence[1].length <= itemIndent + 3) {
      open = start
      marker = fence[2]
      openIndent = fence[1].length
      continue
    }
    // List bookkeeping. A blank line doesn't end an item (a loose list
    // is still one list); a marker opens or re-opens one at its own
    // column, and any other line that starts LEFT of the open item's
    // text has left it.
    if (!line.trim()) continue
    const item = LIST_MARKER_RE.exec(line)
    const indent = /^ */u.exec(line)[0].length
    if (item && item[1].length <= itemIndent + 3) itemIndent = item[0].length
    else if (indent < itemIndent) itemIndent = 0
  }
  if (open !== -1) ranges.push([open, text.length])
  return ranges
}

export function inFence(ranges, index) {
  return ranges.some(([start, end]) => index >= start && index < end)
}

// A document's own line endings, normalised — what every parser does
// to the text before it reads a line of it, and the writer to a
// report's prose before it puts it on the page.
export function normalizeNewlines(text) {
  return String(text ?? '').replaceAll(/\r\n?/gu, '\n')
}

// The headings the parsers split on. Global and multiline, the heading
// text in capture 1 — the shape splitByHeading and splitLeading below
// take, and shared instances because they only ever reach them through
// `matchAll`, which reads a regex without advancing it.
export const H2_RE = /^## +(.*)$/gmu
export const H3_RE = /^### +(.*)$/gmu
export const H4_RE = /^#### +(.*)$/gmu

// `file:line` — the line a number or a `10-20` RANGE, kept whole: the
// file:line displays print it verbatim, and link anchors parseInt() it
// down to the start line.
export const FILE_LINE_RE = /^(.+):(\d+(?:-\d+)?)$/u

// A git hash as a report writes one: short or full, either case.
export function isCommitHash(s) {
  return /^[0-9a-f]{7,64}$/iu.test(s)
}

// Split `text` at every line matching `re` (global + multiline, heading
// text in capture 1) that sits outside a code fence. Content before the
// first heading (a setext underline, prose) is dropped.
export function splitByHeading(text, re) {
  const ranges = fenceRanges(text)
  const marks = [...text.matchAll(re)].filter((m) => !inFence(ranges, m.index))
  return marks.map((m, i) => ({
    heading: m[1],
    body: text.slice(m.index + m[0].length + 1, marks[i + 1]?.index),
  }))
}

// Like splitByHeading, but keeps the content BEFORE the first heading
// (the enclosing block's own body) as `head`.
export function splitLeading(body, re) {
  const ranges = fenceRanges(body)
  const first = [...body.matchAll(re)].find((m) => !inFence(ranges, m.index))
  if (!first) return { head: body, subs: [] }
  return { head: body.slice(0, first.index), subs: splitByHeading(body, re) }
}

// A block split off its `# ` / `### ` marker: the heading line, trimmed,
// and the body under it.
export function splitHeadingLine(block) {
  const nl = block.indexOf('\n')
  if (nl === -1) return { title: block.trim(), body: '' }
  return { title: block.slice(0, nl).trim(), body: block.slice(nl + 1) }
}

// Rows of a markdown table, as arrays of trimmed cells. Skips the
// header row's `|---|---|` delimiter and any line that isn't a table
// row, so prose around the table is ignored. The delimiter test is a
// single character class — a `[\s:|-]*\|?\s*$` shape would carry two
// overlapping whitespace quantifiers and backtrack quadratically on a
// long space-padded cell.
function tableRows(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    if (/^[\s:|-]+$/u.test(trimmed) && trimmed.includes('-')) continue
    const cells = trimmed.replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((c) => c.trim())
    rows.push(cells)
  }
  return rows
}

// Read a table into `{ <column>: value }` objects keyed by its own
// case-folded header names, so callers match columns by name instead of
// hardcoding an order. A re-stated header row (which is how a
// concatenated duplicate section arrives) is chrome, not data.
export function tableObjects(text) {
  const rows = tableRows(text)
  if (rows.length < 2) return []
  const header = rows[0].map((h) => h.toLowerCase())
  const objects = []
  for (const cells of rows.slice(1)) {
    if (cells.length === header.length && cells.every((c, i) => c.toLowerCase() === header[i])) continue
    const obj = {}
    header.forEach((name, i) => { if (name) obj[name] = cells[i] ?? '' })
    objects.push(obj)
  }
  return objects
}

// `**Field:** value` labels (with or without a leading `- ` bullet
// marker), keyed case-folded with the original label text kept in
// `labels`, first occurrence wins. A single line can carry several
// labels joined by ` · ` (`**Severity:** LOW … · **PoC:** blocked`) —
// each is peeled into its own field. A value runs to the next label,
// heading, table row, horizontal rule, or BLANK LINE — so a wrapped
// one-liner keeps its immediate continuation lines, while the
// paragraph after a label block is body prose, not part of the last
// label (a `**Key code:** …` line must not swallow the summary
// paragraph under it). Fenced code opened under a label (a PoC snippet
// in a Summary / Evidence value) is all content: fence delimiters
// toggle, and nothing inside is structural. Unlabelled body text is
// collected as `prose` so callers can use plain paragraphs as the
// narrative when no label carries it. Null-prototype objects so a
// label like "Constructor" can't alias an inherited key.
export function parseLabelledFields(body) {
  const fields = Object.create(null)
  const labels = Object.create(null)
  const proseLines = []
  let key = null
  let keyLabel = ''
  let buf = []
  let fence = ''
  const setField = (k, label, value) => {
    if (!k || k in fields) return
    fields[k] = value.trim()
    labels[k] = label
  }
  const flush = () => {
    if (key) setField(key, keyLabel, buf.join('\n'))
    key = null
    keyLabel = ''
    buf = []
  }
  // A content line belongs to the open label's value, or to the prose.
  const keep = (line) => { (key ? buf : proseLines).push(line) }
  for (const line of body.split('\n')) {
    // A fence delimiter toggles, and every line up to the closing one
    // (delimiters included) is content, whatever it looks like.
    const fm = /^ {0,3}(```|~~~)/u.exec(line)
    const delimiter = fm !== null && (!fence || fm[1] === fence)
    if (delimiter) fence = fence ? '' : fm[1]
    if (delimiter || fence) {
      keep(line)
      continue
    }
    if (!line.trim()) {
      if (key) flush()
      else proseLines.push(line)
      continue
    }
    const label = /^\s*(?:[-*] +)?\*\*([^:*]+):\*\*\s*(.*)$/u.exec(line)
    if (label) {
      flush()
      let k = label[1].trim()
      let rest = label[2]
      let seg
      while ((seg = /\s+[·•]\s+\*\*([^:*]+):\*\*\s*/u.exec(rest)) !== null) {
        setField(k.toLowerCase(), k, rest.slice(0, seg.index))
        k = seg[1].trim()
        rest = rest.slice(seg.index + seg[0].length)
      }
      key = k.toLowerCase()
      keyLabel = k
      buf = [rest]
      continue
    }
    // Structural line — ends the current value without starting one.
    if (/^\s*(?:#{1,6} |\||[-=*_]{3,}\s*$)/u.test(line)) { flush(); continue }
    keep(line)
  }
  flush()
  return { fields, labels, prose: proseLines.join('\n').trim() }
}

// The code reference is prose-ish: `src/a.js:142 in runHook()`, a
// backticked path, or a markdown link to the line on GitHub. Pull out
// the path, the line number, and (when linked) the URL — which
// finding-id.js uses as the id discriminator when no fileHash is
// available, so two imports of the same report derive the same uuid and
// share triage. The trailing function qualifier (`… in runHook()`) some
// reports append is shed from the path.
export function parseCodeRef(raw) {
  let text = (raw || '').trim()
  let locationLink = ''
  const link = /\[([^\]]+)\]\(([^)]+)\)/u.exec(text)
  if (link) {
    text = link[1].trim()
    locationLink = link[2].trim()
  }

  // A `#L<n>` anchor on the link is the most reliable line source (and
  // reads the start line of a `#L88-L95` range).
  let line = ''
  const anchor = /#L(\d+)/u.exec(locationLink)
  if (anchor) line = anchor[1]

  // The first PATH-SHAPED backtick span is the reference when one
  // exists — values often read "see `src/a.js:42` and `src/b.js:9`" or
  // cite a whole call chain, where the first quoted path is the
  // finding's location and everything else is prose or secondary
  // citations. Path-shaped means a separator or an extension and no
  // call parens, so a quoted function qualifier (`… in \`runHook()\``)
  // never beats a bare path. A chosen span is the WHOLE path — the
  // backticks exist precisely to delimit paths with spaces — while the
  // unquoted fallback takes the first whitespace token of the
  // de-backticked text (the template appends `… in runHook()`, which
  // must not join the path). Either way a trailing `#L42` fragment or
  // `:42` / `:88-95` suffix yields the line; a RANGE keeps its start
  // line and sheds the rest from the path.
  const spans = [...text.matchAll(/`([^`]+)`/gu)].map((m) => m[1].trim())
  const pathish = spans.find((s) => !s.includes('(') && (s.includes('/') || /\.\w/u.test(s)))
  let file = pathish ?? (text.replaceAll('`', '').trim().split(/[\s,]+/u).find(Boolean) || '')
  const frag = /^(.*?)#L(\d+)(?:-L?\d+)?$/u.exec(file)
  if (frag) {
    file = frag[1]
    if (!line) line = frag[2]
  }
  const colon = FILE_LINE_RE.exec(file)
  if (colon) {
    if (!line) line = colon[2]
    return { file: colon[1], line, locationLink }
  }
  return { file, line: line || '?', locationLink }
}

export function stripBold(text) { return text.replaceAll('**', '') }

// An inline link — `[label](destination)` — the first one in `s`, or
// null. Scanned rather than matched with one expression: both halves
// nest, and an expression permissive enough for the nesting can no
// longer tell where a link STARTS — a line reading `[context] see
// [src/a.ts:7](…)` opens on a bracket pair that is not a link.
//
// At each `[`, the label is read two ways, in this order:
//
//   1. up to the FIRST `]`, the reading a path with an UNMATCHED
//      bracket needs: `[`src/[id.ts:7`](…)` is what this library's own
//      writer emits for such a path (write-md-finding.js), and no
//      balanced reading of those brackets exists;
//   2. bracket-BALANCED, markdown's own rule, which is what a path
//      carrying brackets of its own needs —
//      `[app/(main)/[id]/page.ts:12](…)` is one link labelled with
//      that path, and reading (1) stops inside it. A code span is
//      skipped whole here: backticks make their content literal, which
//      is exactly why the writer wraps a path in them, so a stray `]`
//      in a path can't close the label early.
//
// Both readings only count when a `(` follows, so `[context]` — which
// closes with no destination behind it — is not a label at all under
// either, and the scan moves on to the next `[`.
//
// The DESTINATION is `<…>` — what md-text.js `link` writes when a url
// holds a space, a paren or an angle bracket — or, failing that, a bare
// run read the same two ways the label is, and for the same reasons:
// parens BALANCED to any depth first, since a reading that stops at the
// first `)` truncates a url the writer never percent-encoded
// (`…/app/(main)/page.ts` → `…/app/(main`), then up to the first `)`,
// the only reading a url with an UNMATCHED paren has — a
// `src/(legacy/file.ts` path a report left unencoded. Whitespace
// disqualifies a bare destination under either reading, where markdown
// would read a title and nothing here writes one, so that candidate is
// abandoned and the scan carries on.
//
// A backslash hides the character after it from every scan here, which
// is how a report escapes a bracket it means literally.
//
// `index` comes back with it, so a caller that means "the value STARTS
// with a link" can say so (parse-deepview-fields.js readLink, reading
// a document this library wrote) while one reading a foreign document
// takes the first link in the line (parse-md.js).
export function findMdLink(s) {
  const text = String(s ?? '')
  // Where each reading would CLOSE, read off the text once rather than
  // rescanned per candidate. A reference is a short line, but a
  // malformed document's need not be, and every reading here is a scan
  // to the end when nothing closes it — 50k of `[` with no `]`, or a
  // run of `[x](` with no `)`, would cost every bracket the remainder
  // of the line. One pass apiece instead.
  const labels = balancedLabelEnds(text, codeSpanEnds(text))
  const dests = destinationEnds(text)
  let plain = text.indexOf(']')
  for (let open = text.indexOf('['); open !== -1; open = text.indexOf('[', open + 1)) {
    // The first `]` after this `[`. Carried forward, not looked up
    // again: `open` only advances, so this does too.
    while (plain !== -1 && plain <= open) plain = text.indexOf(']', plain + 1)
    for (const close of [plain, labels.get(open) ?? -1]) {
      // An EMPTY label is no label: `![](badge.svg)` ahead of a
      // reference is a badge, and the link wanted is the one behind it.
      if (close === -1 || close === open + 1 || text[close + 1] !== '(') continue
      const url = destination(text, close + 1, dests)
      if (url !== null) return { label: text.slice(open + 1, close), url, index: open }
    }
  }
  return null
}

// Every `[` in `text` paired with the `]` that closes it once its
// brackets balance — one left-to-right pass with a stack. Escapes and
// code spans are passed over whole: neither one's brackets are
// structure, and a code span's are literal wherever it sits, which is
// the reading markdown gives it too.
function balancedLabelEnds(text, spans) {
  const ends = new Map()
  const open = []
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (escapes(text, i)) i++
    else if (c === '`') i = spans.get(i) ?? i
    else if (c === '[') open.push(i)
    else if (c === ']' && open.length > 0) ends.set(open.pop(), i)
  }
  return ends
}

// Every backtick RUN in `text` that opens a code span, paired with the
// last backtick of the run that closes it — the next run of exactly
// the same length, which is how markdown fences one (md-text.js code,
// whose spans these are). A run nothing matches is absent: its
// backticks are ordinary text, the reading markdown gives them too.
//
// Read backwards over the runs, each remembering the nearest one of
// its own length ahead of it, so a line of unmatched runs of growing
// lengths — `` `x``x```x… `` — costs one pass rather than a scan to
// the end of the line per run.
function codeSpanEnds(text) {
  const runs = []
  for (let i = text.indexOf('`'); i !== -1; i = text.indexOf('`', i)) {
    let n = 1
    while (text[i + n] === '`') n++
    runs.push([i, n])
    i += n
  }
  const ends = new Map()
  const nearest = new Map()
  for (let r = runs.length - 1; r >= 0; r--) {
    const [start, length] = runs[r]
    const close = nearest.get(length)
    if (close !== undefined) ends.set(start, close + length - 1)
    nearest.set(length, start)
  }
  return ends
}

// What a bare destination can close on, for every position in `text`:
// the `)` that balances each `(`, and — for the reading that doesn't
// need them balanced — the next `)` and the next whitespace from any
// point. Whitespace ends a bare destination either way, so a run of it
// abandons every `(` still open.
function destinationEnds(text) {
  const n = text.length
  const nextClose = new Int32Array(n + 1).fill(-1)
  const nextSpace = new Int32Array(n + 1).fill(-1)
  // …and what ends an angle-bracket one, for the same reason: looked
  // up per candidate, a line of `[x](<` with no `>` in it would scan
  // to the end once per bracket.
  const nextAngle = new Int32Array(n + 1).fill(-1)
  const nextLine = new Int32Array(n + 1).fill(-1)
  for (let i = n - 1; i >= 0; i--) {
    nextClose[i] = text[i] === ')' ? i : nextClose[i + 1]
    nextSpace[i] = /\s/u.test(text[i]) ? i : nextSpace[i + 1]
    nextAngle[i] = text[i] === '>' ? i : nextAngle[i + 1]
    nextLine[i] = text[i] === '\n' ? i : nextLine[i + 1]
  }
  const balanced = new Map()
  const open = []
  for (let i = 0; i < n; i++) {
    const c = text[i]
    // A backslash hides the character behind it — but only one it can
    // actually escape. `not\ a-url` is a backslash and a SPACE, not an
    // escaped space, and the space ends a bare destination: read as an
    // escape it made `[badge](not\ a-url)` a link, and a reference
    // behind it was never reached.
    if (escapes(text, i)) i++
    else if (nextSpace[i] === i) open.length = 0
    else if (c === '(') open.push(i)
    else if (c === ')' && open.length > 0) balanced.set(open.pop(), i)
  }
  return { balanced, nextClose, nextSpace, nextAngle, nextLine }
}

// The destination opened at `open` (its `(`), as its url, or null when
// nothing reads it: an angle-bracket form, else the bare run its own
// parens close, else the bare run the first `)` closes. An EMPTY
// destination is none of them — `[a]()` is not a link — while an empty
// `<>` falls through to the bare readings, which take the angle
// brackets themselves as the url.
function destination(text, open, dests) {
  const angled = angleDestination(text, open, dests)
  if (angled) return angled
  const balanced = dests.balanced.get(open)
  if (balanced !== undefined) return balanced > open + 1 ? text.slice(open + 1, balanced) : null
  // Failing that, up to the first `)` — the only reading a url with an
  // UNMATCHED paren has. Whitespace before that `)` disqualifies it,
  // where markdown would read a title and nothing here writes one.
  const flat = dests.nextClose[open + 1]
  const space = dests.nextSpace[open + 1]
  if (flat === -1 || flat === open + 1 || (space !== -1 && space < flat)) return null
  return text.slice(open + 1, flat)
}

// The `<…>` form md-text.js `link` writes when a url can't sit bare,
// or '' when this destination isn't one.
function angleDestination(text, open, dests) {
  if (text[open + 1] !== '<') return ''
  const close = dests.nextAngle[open + 2]
  const line = dests.nextLine[open + 2]
  if (close === -1 || (line !== -1 && line < close) || text[close + 1] !== ')') return ''
  return text.slice(open + 2, close)
}

// Markdown backslash escapes — `a/b/\_cc\_cc/index.js` is a report
// escaping the underscores that would otherwise open emphasis, not a
// path with backslashes in it. Undo them wherever a value is a NAME
// rather than prose: a file path, a link's label. Only ASCII
// punctuation can be escaped (CommonMark), so a `\n` or a Windows
// `C:\path` keeps its backslash.
const MD_ESCAPE_RE = /\\([!-/:-@[-`{-~])/gu

// The same rule asked of one position: is the backslash at `i` an
// escape, or just a backslash? Only ASCII punctuation can be escaped,
// so `\ ` is two characters and `\[` is one — which is what keeps a
// scanner from reading a space as hidden (findMdLink) when markdown
// would read it as the whitespace that ends a destination.
const MD_ESCAPABLE = /[!-/:-@[-`{-~]/u

function escapes(text, i) {
  return text[i] === '\\' && MD_ESCAPABLE.test(text[i + 1] ?? '')
}

export function unescapeMd(s) {
  return typeof s === 'string' ? s.replace(MD_ESCAPE_RE, '$1') : s
}

// `[X]` → `X` — for id cells / tokens where the brackets are notation,
// not content. Applied to ids only; a title can legitimately contain
// square brackets.
export function stripBrackets(s) {
  const m = /^\[(.+)\]$/u.exec(s.trim())
  return m ? m[1].trim() : s.trim()
}

// Table cells use `--` / `-` — or a typographic `—` / `–` — for
// "not applicable".
export function cellValue(s) {
  const v = (s || '').trim()
  return /^[-–—]+$/u.test(v) ? '' : v
}
