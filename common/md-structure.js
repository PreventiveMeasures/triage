// Shared structural-markdown helpers for the report parsers: fence-
// aware heading splitting, table reading, and labelled-field
// extraction. Extracted from parse-piolium.js, which needs all of them;
// parse-md.js and parse-deepsec.js predate this module and keep their
// own (subtly different) readers — fold those in only with their
// behavior pinned by tests first, since finding ids are derived from
// parser output and a drift in parsing silently re-keys stored triage.

// Byte ranges of fenced code blocks (``` / ~~~), fences included. The
// closing fence must use the opening marker, so a `~~~` line inside a
// backtick fence stays content. A dangling opening fence runs to end of
// input — the same reading markdown renderers give it. Computed once
// per text and consulted by every structural splitter so a code line
// beginning with `## ` / `### ` / `| ` can't be read as structure.
export function fenceRanges(text) {
  const ranges = []
  let open = -1
  let marker = ''
  for (const m of text.matchAll(/^ {0,3}(```|~~~).*$/gmu)) {
    if (open === -1) { open = m.index; marker = m[1] }
    else if (m[1] === marker) { ranges.push([open, m.index + m[0].length]); open = -1 }
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
    body: text.slice(m.index + m[0].length + 1, i + 1 < marks.length ? marks[i + 1].index : text.length),
  }))
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
// marker), case-folded, first occurrence wins. A value runs to the next
// label, heading, table row, horizontal rule, or BLANK LINE — so a
// wrapped one-liner keeps its immediate continuation lines, while the
// paragraph after a label block is body prose, not part of the last
// label (a `**Key code:** …` line must not swallow the summary
// paragraph under it). Fenced code opened under a label (a PoC snippet
// in a Summary / Evidence value) is all content: fence delimiters
// toggle, and nothing inside is structural. Unlabelled body text is
// collected as `prose` so callers can use plain paragraphs as the
// narrative when no label carries it. Null-prototype object so a label
// like "Constructor" can't alias an inherited key.
export function parseLabelledFields(body) {
  const fields = Object.create(null)
  const proseLines = []
  let key = null
  let buf = []
  let fence = ''
  const flush = () => {
    if (key && !(key in fields)) fields[key] = buf.join('\n').trim()
    key = null
    buf = []
  }
  for (const line of body.split('\n')) {
    const fm = /^ {0,3}(```|~~~)/u.exec(line)
    if (fm && (!fence || fm[1] === fence)) {
      fence = fence ? '' : fm[1]
      ;(key ? buf : proseLines).push(line)
      continue
    }
    if (fence) {
      ;(key ? buf : proseLines).push(line)
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
      key = label[1].trim().toLowerCase()
      buf = [label[2]]
      continue
    }
    // Structural line — ends the current value without starting one.
    if (/^\s*(?:#{1,6} |\||[-=*_]{3,}\s*$)/u.test(line)) { flush(); continue }
    if (key) buf.push(line)
    else proseLines.push(line)
  }
  flush()
  return { fields, prose: proseLines.join('\n').trim() }
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
  // exists — values often read "see `src/a.js:42` and `src/b.js:9`",
  // where the first quoted path is the finding's location and
  // everything else is prose or secondary citations. Path-shaped means
  // a separator or an extension and no call parens, so a quoted
  // function qualifier (`… in \`runHook()\``) never beats a bare path.
  // Without a qualifying span, fall back to the first whitespace token
  // of the de-backticked text (the template appends `… in runHook()`,
  // which must not join the path). Either way a trailing `#L42`
  // fragment or `:42` / `:88-95` suffix yields the line; a RANGE keeps
  // its start line and sheds the rest from the path.
  const spans = [...text.matchAll(/`([^`]+)`/gu)].map((m) => m[1].trim())
  const pathish = spans.find((s) => !s.includes('(') && (s.includes('/') || /\.\w/u.test(s)))
  const candidate = pathish ?? text.replaceAll('`', '')
  let file = candidate.trim().split(/[\s,]+/u).find(Boolean) || ''
  const frag = /^(.*?)#L(\d+)(?:-L?\d+)?$/u.exec(file)
  if (frag) {
    file = frag[1]
    if (!line) line = frag[2]
  }
  const colon = /^(.+):(\d+)(?:-\d+)?$/u.exec(file)
  if (colon) {
    if (!line) line = colon[2]
    return { file: colon[1], line, locationLink }
  }
  return { file, line: line || '?', locationLink }
}

export function stripBold(text) { return text.replaceAll('**', '') }

// `[X]` → `X` — for id cells / tokens where the brackets are notation,
// not content. Applied to ids only; a title can legitimately contain
// square brackets.
export function stripBrackets(s) {
  const m = /^\[(.+)\]$/u.exec(s.trim())
  return m ? m[1].trim() : s.trim()
}

// Table cells use `--` (or `-`) for "not applicable".
export function cellValue(s) {
  const v = (s || '').trim()
  return /^-+$/u.test(v) ? '' : v
}
