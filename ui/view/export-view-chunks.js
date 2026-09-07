// Cutting a Markdown document into chunks the export preview can lay
// out and colour one at a time (dialogs/export-view-dialog.js).
//
// The preview shows a report of tens of thousands of lines, and both
// the layout and the syntax colouring have to stay proportional to
// what is on screen rather than to the file: a chunk is the unit that
// `content-visibility: auto` skips while it is off screen and that
// Prism highlights when it comes near.
//
// Highlighting a chunk on its own is only exact if no construct runs
// across the cut, so a cut is never made inside a fenced block (the
// pass's own snippets — a fence opened in one chunk and closed in the
// next would have its second half coloured as prose), never between a
// line and the `===` / `---` that would make it a setext heading, and
// never between a table's header row and the `|---|---|` under it,
// which is the pair Prism recognises a table by. Between a table's
// BODY rows a cut is fine, because the chunk that starts there can be
// coloured with the table's header put back in front of it
// (`tableLead`) and reads exactly as it would in the whole — which is
// what keeps the report's summary table, one row per finding, from
// being a single chunk the size of the report. Within those rules a
// cut lands where a paragraph ends — a blank line, or a heading
// opening the next section — and only somewhere else once a chunk has
// run well past its target, so a long list or a long paragraph stays
// whole where it can.
//
// Pure: lines in, `[start, end)` pairs out, covering every line exactly
// once. Nothing here knows about the DOM.
import { fenceRanges } from '../../report/md-structure.js'

// Lines a chunk aims for, and the point past which any safe cut is
// taken rather than waiting for a paragraph end. A chunk is what gets
// laid out and coloured in one go when it comes into view, so smaller
// is smoother — but every chunk is one more box for the browser to
// track on every scrolled frame, and halving the target costs more per
// frame than it saves per chunk. The maximum is what cuts the report's
// summary table, whose rows never offer a paragraph end: those rows
// are long and wrap, so a table chunk is held to half the length a
// run of prose may reach.
export const CHUNK_TARGET = 160
export const CHUNK_MAX = 320

const HEADING_RE = /^ {0,3}#{1,6}(?: |$)/u
const SETEXT_UNDERLINE_RE = /^ {0,3}(?:=+|-+) *$/u
// A table row and the delimiter line under a header row, as Prism's
// markdown grammar sees them (its `tableRow` / `tableLine`): at least
// two cells, no indentation. Prism's table is a row followed by a
// delimiter line followed by any run of rows, so these two are what
// decide where a table starts and how far it reaches.
const TABLE_ROW_RE = /^\|?[^|\n]+(?:\|[^|\n]+)+\|?$/u
const TABLE_DELIM_RE = /^\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?$/u

// Chunk `lines` (the document split on `\n`) into `[start, end)`
// ranges. `text` is the same document joined back, for the fence scan
// — the caller has both and joining again here would only cost the
// copy.
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

// The two lines — header row, delimiter — of the table that the chunk
// starting at `start` cuts into, as `[from, to)`, or null when it
// starts outside a table body. Prepended to the chunk's text before it
// goes to Prism, they make the chunk's rows the body of a table again,
// coloured as they are in the whole document; the caller drops the two
// lines from what comes back. Prism takes the FIRST row-then-delimiter
// pair in a run of rows as the table's start, so this walks back to
// the top of the run and forward again to that pair.
export function tableLead(lines, start) {
  if (start < 2 || !TABLE_ROW_RE.test(lines[start]) || !TABLE_ROW_RE.test(lines[start - 1])) return null
  let top = start - 1
  while (top > 0 && TABLE_ROW_RE.test(lines[top - 1])) top--
  for (let i = top + 1; i < start; i++) {
    if (TABLE_DELIM_RE.test(lines[i])) return [i - 1, i + 1]
  }
  return null
}

// The three characters that mean something to an HTML parser in text
// content. Prism escapes its own output the same way; this is for the
// lines shown before (or without) its colour.
export function escapeHtml(s) {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
