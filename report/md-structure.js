// Shared structural-markdown helpers for the report parsers: fence-
// aware heading splitting, table reading, and labelled-field
// extraction. Extracted from parse-piolium.js, which needs all of them;
// parse-md.js and parse-deepsec.js predate this module and, beyond the
// heading-line split, keep their own (subtly different) section and
// label readers — fold those in only with their behavior pinned by
// tests first, since finding ids are derived from parser output and a
// drift in parsing silently re-keys stored triage.

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
export function tableRows(text) {
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
  // A `:60-90` RANGE is kept whole in `line`: the file:line displays
  // print it verbatim, and link anchors parseInt() it down to the
  // start line.
  const colon = /^(.+):(\d+(?:-\d+)?)$/u.exec(file)
  if (colon) {
    if (!line) line = colon[2]
    return { file: colon[1], line, locationLink }
  }
  return { file, line: line || '?', locationLink }
}

export function stripBold(text) { return text.replaceAll('**', '') }

// Markdown backslash escapes — `a/b/\_cc\_cc/index.js` is a report
// escaping the underscores that would otherwise open emphasis, not a
// path with backslashes in it. Undo them wherever a value is a NAME
// rather than prose: a file path, a link's label. Only ASCII
// punctuation can be escaped (CommonMark), so a `\n` or a Windows
// `C:\path` keeps its backslash.
const MD_ESCAPE_RE = /\\([!-/:-@[-`{-~])/gu

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
