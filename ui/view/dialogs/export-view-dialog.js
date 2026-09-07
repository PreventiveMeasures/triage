// `<export-view-dialog>` — the read-only look at what Download would
// write. Reached from the export confirm dialog's View button, which
// closes and hands off to this: same selection, same Markdown, just
// shown instead of saved.
//
// Read-only on purpose. It is a preview of a file, not an editor: the
// exact bytes `downloadReportsAsMarkdown` would put in the blob, laid
// out a line to a row against a number gutter and Prism-highlighted as
// Markdown, so headings, links and the fenced snippets inside a
// finding's description are legible at a glance.
//
// Lines WRAP here, unlike the source panel in the focus view. That one
// shows code, where a wrapped line is a lie about the file's shape and
// scrolling sideways is the honest answer. This shows prose — findings,
// impacts, recommendations — in paragraphs written to be read, and a
// document you have to drag sideways to finish a sentence is not a
// preview of anything. Wrapping is also what forces a row per line:
// with one logical line spanning several visual ones, a gutter beside a
// single block would drift out of step by the end of the first
// paragraph.
//
// The document is shown in CHUNKS of a few hundred lines
// (export-view-chunks.js decides where one ends), and the chunk is the
// unit of everything expensive. A big report is tens of thousands of
// lines; as one flat grid, with every line coloured up front, it took
// ten seconds to open and stuttered on every scroll. Now each chunk is
// its own box under `content-visibility: auto`, so the ones off screen
// cost no layout and no paint, and a chunk starts as nothing but its
// text — one text node, so the whole document is in the DOM from the
// first paint for find-in-page to read, without the parse of a row per
// line. Its rows — gutter number, line, Prism's colour — are built
// only once it comes within a viewport of being seen, by the same
// observer the finding lists use (view/lazy-render.js), and built
// straight into the element: Lit renders the shells and never looks
// inside them again, so colouring a chunk costs that chunk and nothing
// else. The cuts fall where Markdown allows, so a chunk coloured on its
// own reads as it would in the whole.
//
// Sibling of `<export-confirm-dialog>`: extends `AppDialog` for the
// shared shadow-DOM <dialog> chrome (focus-trap + Esc-to-cancel).
import { html, unsafeCSS } from 'lit'
import { AppDialog } from './app-dialog.js'
import { highlight, splitHighlightedLines } from '../prism-highlight.js'
import { unwatchNearViewport, watchNearViewport } from '../lazy-render.js'
import { chunkLines, escapeHtml, tableLead } from '../export-view-chunks.js'
import codeTokensCSS from '../../styles/code-tokens.css'
import exportViewCSS from './dialog-export-view.css'

// One chunk's rows as HTML — the gutter number and the line, for each
// line of `[start, end)`. `rows` is Prism's markup per line; without
// it the lines go in as they are, escaped. One string per chunk rather
// than a template per line: a template is a parse, and a document of
// forty thousand lines is forty thousand of them.
//
// Each line ends in its own newline, inside the cell. The cells are
// grid items, so a copy of a selection serialises them as blocks, and
// an empty block — a blank line — serialises as nothing: a copied
// paragraph break would vanish. The newline puts it back, and the
// browser's own line break for the block folds into it rather than
// doubling it. It draws nothing: a break at the end of a block ends
// the line, it doesn't open an empty one.
function rowsHtml(lines, start, end, rows = null) {
  let out = ''
  for (let i = start; i < end; i++) {
    const line = rows === null ? escapeHtml(lines[i]) : rows[i - start]
    out += `<span class="evd-lineno" aria-hidden="true">${i + 1}</span><code class="evd-line">${line}\n</code>`
  }
  return out
}

class ExportViewDialog extends AppDialog {
  // The token palette is the same file `<finding-card>` adopts, so a
  // snippet reads identically here and on the card it came from.
  static styles = [...AppDialog.styles, unsafeCSS(codeTokensCSS), unsafeCSS(exportViewCSS)]

  static properties = {
    // The exact text the download would write.
    markdown: { attribute: false },
  }

  // Derived from `markdown` (see willUpdate): its lines, its size in
  // KB for the footer, and one record per chunk — the line range, and
  // whether its rows have been asked for. Plain fields rather than
  // reactive state: nothing here re-renders the template.
  _lines = []
  _kb = '0.0'
  _chunks = []

  constructor() {
    super()
    this.markdown = ''
  }

  // Nothing to type into, so focus the way out. Also what Enter should
  // land on here: the dialog has no committing action.
  focusInitial() {
    this.renderRoot.querySelector('button[data-role="cancel"]')?.focus()
  }

  willUpdate(changed) {
    if (!changed.has('markdown')) return
    const raw = this.markdown.split('\n')
    // A trailing newline terminates the last line rather than opening an
    // empty one — how an editor counts, and one fewer empty row at the
    // bottom of every report (they all end in one).
    const count = raw.length > 1 && raw.at(-1) === '' ? raw.length - 1 : raw.length
    this._lines = raw.slice(0, count)
    this._kb = (new TextEncoder().encode(this.markdown).length / 1024).toFixed(1)
    this._chunks = chunkLines(this._lines, this.markdown).map(([start, end]) => ({ start, end, asked: false }))
  }

  render() {
    const count = this._lines.length
    // The chunks are shells here: `updated` fills them. `--evd-chunk-
    // lines` sizes a chunk's stand-in while it is skipped; `--evd-
    // lineno-width` is the gutter every chunk's rows share (see
    // dialog-export-view.css).
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Report markdown</h3>
      </header>
      <div class="evd-code" tabindex="0">
        <div class="evd-lines" style="--evd-lineno-width: ${String(count).length}ch">
          ${this._chunks.map((chunk, i) => html`<div
            class="evd-chunk evd-pending"
            data-chunk=${i}
            style="--evd-chunk-lines: ${chunk.end - chunk.start}"
          ></div>`)}
        </div>
      </div>
      <footer class="nwd-actions">
        <span class="evd-meta">${count} ${count === 1 ? 'line' : 'lines'} · ${this._kb} KB</span>
        <span class="nwd-spacer"></span>
        <button type="button" class="primary" data-role="cancel" @click=${this._onClose}>Close</button>
      </footer>
    </dialog>`
  }

  // Give each new chunk shell its text and watch it for its approach
  // to the viewport, from here rather than the template because the
  // elements exist only after a render. Each is filled once
  // (`data-watched`), and unwatched the moment it has been near: a
  // chunk gets its rows once and keeps them.
  //
  // Not when the host is already out of the document. `showModal()`
  // failing in `firstUpdated` dispatches `modal-conflict`, whose
  // listener removes the element on the spot — and Lit still runs this
  // hook after it, on a tree that disconnectedCallback has already
  // swept. Registering those chunks would hand the shared observer a
  // detached copy of the whole report that nothing ever unwatches.
  updated() {
    if (!this.isConnected) return
    for (const el of this.renderRoot.querySelectorAll('.evd-chunk:not([data-watched])')) {
      el.dataset.watched = ''
      const index = Number(el.dataset.chunk)
      const chunk = this._chunks[index]
      el.textContent = this._lines.slice(chunk.start, chunk.end).join('\n')
      watchNearViewport(el, (near) => {
        if (!near) return
        unwatchNearViewport(el)
        void this._paint(el, index)
      })
    }
  }

  disconnectedCallback() {
    for (const el of this.renderRoot.querySelectorAll('.evd-chunk[data-watched]')) unwatchNearViewport(el)
    super.disconnectedCallback()
  }

  // One chunk's rows, in Prism's colour where it answers. Prism loads
  // on demand (see prism-highlight.js), so the first chunk asked pays
  // the download and stays as text until it lands; every later one
  // answers in a microtask. A chunk cut out of a table's body goes to
  // Prism with the table's header and delimiter lines put back in
  // front (see `tableLead`), so its rows are coloured as table rows;
  // the two lines are dropped from the answer. Prism's markup is cut
  // back into lines and trusted only when it splits into exactly as
  // many as the chunk has — anything else means the two have drifted,
  // and plain text against correct numbers beats colour against wrong
  // ones. Guarded on `isConnected`: a reader who closes the dialog
  // before the grammar lands would otherwise have a removed element
  // built into.
  async _paint(el, index) {
    const chunk = this._chunks[index]
    if (!chunk || chunk.asked) return
    chunk.asked = true
    const lead = tableLead(this._lines, chunk.start)
    const text = [...(lead ? this._lines.slice(lead[0], lead[1]) : []), ...this._lines.slice(chunk.start, chunk.end)].join('\n')
    const painted = await highlight(text, 'markdown')
    if (!this.isConnected) return
    const rows = painted === null ? null : splitHighlightedLines(painted).slice(lead ? lead[1] - lead[0] : 0)
    el.innerHTML = rowsHtml(this._lines, chunk.start, chunk.end, rows?.length === chunk.end - chunk.start ? rows : null)
    el.classList.remove('evd-pending')
  }
}

customElements.define('export-view-dialog', ExportViewDialog)

// Public entry point. Takes the already-serialized Markdown so this
// module stays a viewer — what to show is the caller's decision, the
// same text it would hand to the download.
//
// Custom open helper rather than the shared `openAppDialog`, for the
// reason `openExportConfirmDialog` documents: the export buttons stay
// clickable behind a modal, so `showModal()` can throw and dispatch
// `modal-conflict` instead of `resolve`, which the shared helper never
// hears — leaving the await hanging and the element leaked.
export function openExportViewDialog(markdown) {
  return new Promise((resolve) => {
    const el = document.createElement('export-view-dialog')
    el.markdown = markdown
    const settle = () => { el.remove(); resolve() }
    el.addEventListener('resolve', settle)
    el.addEventListener('modal-conflict', settle)
    document.body.append(el)
  })
}
