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
// Sibling of `<export-confirm-dialog>`: extends `AppDialog` for the
// shared shadow-DOM <dialog> chrome (focus-trap + Esc-to-cancel).
import { html, unsafeCSS } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { AppDialog } from './app-dialog.js'
import { highlight, splitHighlightedLines } from '../prism-highlight.js'
import codeTokensCSS from '../../styles/code-tokens.css'
import exportViewCSS from './dialog-export-view.css'

class ExportViewDialog extends AppDialog {
  // The token palette is the same file `<finding-card>` adopts, so a
  // snippet reads identically here and on the card it came from.
  static styles = [...AppDialog.styles, unsafeCSS(codeTokensCSS), unsafeCSS(exportViewCSS)]

  static properties = {
    // The exact text the download would write.
    markdown: { attribute: false },
    // Prism's HTML for it, once it settles. Null until then (and if the
    // grammar fails to load), which renders the plain text — the
    // preview is legible either way, colour is the bonus.
    highlighted: { state: true },
  }

  constructor() {
    super()
    this.markdown = ''
    this.highlighted = null
  }

  // Nothing to type into, so focus the way out. Also what Enter should
  // land on here: the dialog has no committing action.
  focusInitial() {
    this.renderRoot.querySelector('button[data-role="cancel"]')?.focus()
  }

  firstUpdated() {
    super.firstUpdated()
    // Prism loads on demand (see prism-highlight.js), so the first
    // paint is the plain text and the colour arrives on the next.
    // Guarded on `isConnected`: a reader who closes the dialog before
    // the grammar lands would otherwise set state on a removed element.
    void (async () => {
      const painted = await highlight(this.markdown, 'markdown')
      if (this.isConnected) this.highlighted = painted
    })()
  }

  render() {
    const raw = this.markdown.split('\n')
    // A trailing newline terminates the last line rather than opening an
    // empty one — how an editor counts, and one fewer empty row at the
    // bottom of every report (they all end in one).
    const count = raw.length > 1 && raw.at(-1) === '' ? raw.length - 1 : raw.length
    // Prism's markup, cut at the same line boundaries. Paired by index,
    // so it is only trusted when it splits into exactly as many lines as
    // the text did; anything else means the two have drifted, and plain
    // text against correct numbers beats colour against wrong ones.
    const painted = this.highlighted === null ? null : splitHighlightedLines(this.highlighted)
    const rows = painted?.length === raw.length ? painted : null
    const kb = (new TextEncoder().encode(this.markdown).length / 1024).toFixed(1)
    return html`<dialog @close=${this._onClose}>
      <header>
        <h3>Report markdown</h3>
      </header>
      <div class="evd-code" tabindex="0">
        <div class="evd-lines" style="--evd-lineno-width: ${String(count).length}ch">
          ${raw.slice(0, count).map((text, i) => html`<span class="evd-lineno" aria-hidden="true">${i + 1}</span><code class="evd-line">${rows === null ? text : unsafeHTML(rows[i])}</code>`)}
        </div>
      </div>
      <footer class="nwd-actions">
        <span class="evd-meta">${count} ${count === 1 ? 'line' : 'lines'} · ${kb} KB</span>
        <span class="nwd-spacer"></span>
        <button type="button" class="primary" data-role="cancel" @click=${this._onClose}>Close</button>
      </footer>
    </dialog>`
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
