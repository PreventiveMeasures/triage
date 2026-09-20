// Markdown text helpers for the writer (write-md.js): the escaping a
// value needs for the position it lands in, GitHub-style heading
// anchors, tables, and the formatters the document header uses. The
// writing-side sibling of md-structure.js, which reads. Pure string
// work; nothing here knows what a finding is.

import { fenceRanges, inFence, normalizeNewlines } from './md-structure.js'

// Parseable http:// / https:// only. What gets linked comes from reports
// and from the user's own notes, where a fix reference can be "internal
// ticket #42", and the other schemes are useless (file:) or a footgun
// (javascript:, data:). The viewer's `<a>` gates read this too.
export function isHttpUrl(s) {
  if (typeof s !== 'string' || s.length === 0) return false
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch { return false }
}

// One line of a table cell: newlines collapse to spaces, and the `|`
// that would end the cell is escaped — inside a code span too, which is
// where GitHub still reads it as a column break.
export function cell(text) {
  return String(text ?? '').replaceAll(/\s*\n\s*/gu, ' ').replaceAll('|', '\\|').trim()
}

// Inline code — a path, a hash, a package name. Fenced with one more
// backtick than the longest run inside it, which is how markdown quotes
// a backtick; padded when the content itself starts or ends on one, so
// the content can't merge with its fence.
export function code(text) {
  const s = String(text ?? '')
  if (s === '') return ''
  const longest = Math.max(0, ...[...s.matchAll(/`+/gu)].map((m) => m[0].length))
  const fence = '`'.repeat(longest + 1)
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${s}${pad}${fence}`
}

// Square brackets in a link's TEXT would open a nested link; escape
// them. Code spans inside the text need no escaping — they bind tighter
// than the brackets — so this is for plain-text labels only.
export function escapeBrackets(text) {
  return String(text ?? '').replaceAll(/[[\]]/gu, '\\$&')
}

// `[label](url)`. The URL goes in angle brackets when it carries a
// character that would end the destination early.
export function link(label, url) {
  const target = /[\s()<>]/u.test(url) ? `<${url.replaceAll('>', '%3E')}>` : url
  return `[${label}](${target})`
}

// A bare URL as an autolink (`<url>`), which every renderer links;
// anything else — a ticket number, a note — as the text it is.
export function autolink(s) {
  return isHttpUrl(s) ? `<${s}>` : String(s ?? '')
}

// GitHub's heading anchor: lower-cased, punctuation dropped, spaces to
// hyphens, `-N` on a repeat — what GitHub, GitLab and most editors read.
// `taken` is the document's registry of anchors handed out.
export function anchorSlug(text, taken) {
  const base = String(text ?? '').toLowerCase()
    .replaceAll(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replaceAll(/\s/gu, '-')
  let slug = base
  for (let n = 1; taken.has(slug); n++) slug = `${base}-${n}`
  taken.add(slug)
  return slug
}

// A heading at `depth`, clamped to markdown's six levels.
export function heading(depth, text) {
  return `${'#'.repeat(Math.min(6, Math.max(1, depth)))} ${text}`
}

// A table from a header row and rows, every cell already escaped by the
// caller. `align[i]` is 'right' for a numeric column; the delimiter row
// carries it.
export function table(headers, rows, align = []) {
  const delim = headers.map((_, i) => (align[i] === 'right' ? '---:' : '---'))
  return [headers, delim, ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n')
}

// `2026-09-05 14:02 UTC` — a moment a reader can compare with the
// report's own dates without knowing the exporting machine's zone.
export function formatTimestamp(date) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}

export function plural(n, noun, many = `${noun}s`) {
  return `${n} ${n === 1 ? noun : many}`
}

// Blocks joined by one blank line — the paragraph break — with empty
// blocks dropped and each block's trailing whitespace trimmed, so no
// block can add a second break of its own.
export function joinBlocks(blocks) {
  return blocks.filter((b) => typeof b === 'string' && b.trim()).map((b) => b.replace(/\s+$/u, '')).join('\n\n')
}

// A run of a report's own markdown as it lands in the document: line
// endings normalised, edges trimmed, an open fence closed, a line that
// would read as a heading escaped.
//
// A dangling fence runs to the end of the FINDING for every parser — a
// card's reader sees the snippet, not a problem — but in a document it
// would swallow every finding after it, so it is closed with the marker
// that opened it.
//
// A `## Internal detail` line in an analyzer's prose is text the card
// shows, not a section: written bare, a renderer and the document's own
// reader (parse-deepview-md.js) would both end the finding there. It
// goes on the page as `\## Internal detail` and is stripped back
// (unescapeHeadings), with a line already opening on a backslash getting
// one more, so that strip is exact whatever the prose held. Fenced code
// is left alone — a `#` there is code.
const FENCE_OPEN_RE = /^ *(`{3,}|~{3,})/u
const HEADING_LINE_RE = /^( {0,3})(\\*#)/u

export function prose(text) {
  const s = closeFence(normalizeNewlines(text).trim())
  return s ? escapeHeadings(s) : ''
}

function closeFence(s) {
  if (!s) return ''
  const last = fenceRanges(s).at(-1)
  if (!last || last[1] < s.length) return s
  const lines = s.slice(last[0]).split('\n')
  const marker = FENCE_OPEN_RE.exec(lines[0])?.[1] ?? '```'
  const closed = lines.length > 1 && FENCE_OPEN_RE.exec(lines.at(-1))?.[1]?.startsWith(marker.slice(0, 3))
  return closed ? s : `${s}\n${marker}`
}

// `fn` over every line of `s` outside a fence, in place.
function mapProseLines(s, fn) {
  const ranges = fenceRanges(s)
  let pos = 0
  return s.split('\n').map((line) => {
    const start = pos
    pos += line.length + 1
    return inFence(ranges, start) ? line : fn(line)
  }).join('\n')
}

function escapeHeadings(s) {
  return mapProseLines(s, (line) => line.replace(HEADING_LINE_RE, '$1\\$2'))
}

// The inverse, for the reader: one backslash off a line that opens on
// backslashes before a `#`.
export function unescapeHeadings(s) {
  return mapProseLines(String(s ?? ''), (line) => line.replace(/^( {0,3})\\(\\*#)/u, '$1$2'))
}

// Continuation lines indented to a list item's content column, so
// markdown reads them as the item's own. Blank lines stay empty.
export function indentUnder(marker, text) {
  const pad = ' '.repeat(marker.length)
  return text.split('\n').map((l) => (l ? pad + l : '')).join('\n')
}
