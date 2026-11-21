// Cutting a Markdown document into chunks the export preview
// (dialogs/export-view-dialog.js) lays out and colours one at a time, so
// both stay proportional to the screen, not to a file of tens of thousands
// of lines: a chunk is what `content-visibility: auto` skips off screen and
// Prism highlights when it comes near.
//
// A chunk highlights exactly only if no construct runs across its cut, so
// none falls inside a fence, between a line and the `===` / `---` making it
// a setext heading, or between a table's header row and the `|---|---|`
// under it (the pair Prism recognises a table by). Between BODY rows a cut
// is fine — `tableLead` puts the header back in front for colouring — which
// keeps the summary table, a row per finding, from being one huge chunk.
// Within those rules a cut lands where a paragraph ends (a blank line, or a
// heading), elsewhere only once a chunk runs well past its target.
//
// Pure: lines in, `[start, end)` pairs out, covering every line once.
import { fenceRanges } from '@preventive/report'

// Lines a chunk aims for, and past which any safe cut is taken. Smaller
// is smoother per chunk, but every chunk is one more box to track on each
// scrolled frame, and halving the target costs more than it saves. The
// maximum cuts the summary table, whose long, wrapping rows offer no
// paragraph end.
export const CHUNK_TARGET = 160
export const CHUNK_MAX = 320

const HEADING_RE = /^ {0,3}#{1,6}(?: |$)/u
const SETEXT_UNDERLINE_RE = /^ {0,3}(?:=+|-+) *$/u
// A table row and the delimiter under a header row as Prism's markdown
// grammar sees them (`tableRow` / `tableLine`): two cells at least, no
// indent. Its table is a row, a delimiter, then any run of rows.
const TABLE_ROW_RE = /^\|?[^|\n]+(?:\|[^|\n]+)+\|?$/u
const TABLE_DELIM_RE = /^\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?$/u

// Chunk `lines` (the document split on `\n`) into `[start, end)` ranges;
// `text` is the document whole, for the fence scan (the caller has it).
export function chunkLines(lines, text = lines.join('\n'), { target = CHUNK_TARGET, max = CHUNK_MAX } = {}) {
  const n = lines.length
  if (n === 0) return []
  // A cut before line `i` falls inside a fence when the newline that
  // ends line `i - 1` does. Fences and lines both run forward, so one
  // cursor into the (sorted, disjoint) ranges answers every line.
  const fences = fenceRanges(text)
  let fence = 0
  let offset = 0 // of line `i`
  const fenced = () => {
    while (fence < fences.length && fences[fence][1] <= offset - 1) fence++
    return fence < fences.length && offset - 1 >= fences[fence][0]
  }
  const blank = (i) => lines[i].trim() === ''
  const row = (i) => TABLE_ROW_RE.test(lines[i])
  // A chunk may start at line `i` when nothing spans the cut before it.
  const safe = (i) => !fenced()
    && !(TABLE_DELIM_RE.test(lines[i]) && row(i - 1))
    && !(SETEXT_UNDERLINE_RE.test(lines[i]) && !blank(i - 1))
  // …and preferably where a paragraph has just ended or a section opens.
  const preferred = (i) => blank(i - 1) || HEADING_RE.test(lines[i])
  const chunks = []
  let start = 0
  for (let i = 1; i < n; i++) {
    offset += lines[i - 1].length + 1
    const length = i - start
    if (length < target || !safe(i)) continue
    if (length >= max || preferred(i)) {
      chunks.push([start, i])
      start = i
    }
  }
  chunks.push([start, n])
  return chunks
}

// The header row and delimiter (`[from, to)`) of the table the chunk at
// `start` cuts into, or null outside a table body: prepended for Prism,
// they make the chunk's rows a table body again (the caller drops them
// from the result). Prism starts a table at the FIRST row-then-delimiter
// pair of a run of rows, so this walks back to the run's top and forward.
export function tableLead(lines, start) {
  if (start < 2 || !TABLE_ROW_RE.test(lines[start]) || !TABLE_ROW_RE.test(lines[start - 1])) return null
  let top = start - 1
  while (top > 0 && TABLE_ROW_RE.test(lines[top - 1])) top--
  for (let i = top + 1; i < start; i++) {
    if (TABLE_DELIM_RE.test(lines[i])) return [i - 1, i + 1]
  }
  return null
}

// The three characters an HTML parser reads in text content, for lines
// shown before (or without) Prism's colour, which escapes the same way.
export function escapeHtml(s) {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
