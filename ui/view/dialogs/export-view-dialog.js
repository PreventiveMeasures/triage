// A read-only look at what the export confirm dialog's Download would write,
// from its View: the exact Markdown, a line to a row against a number gutter,
// Prism-highlighted. Lines wrap, unlike the code panels: this is prose, and
// wrapping is why there is a row per line (a gutter beside one block would
// drift).
//
// A big report is tens of thousands of lines, so it's shown in CHUNKS
// (export-view-chunks.js picks where they end, where Markdown allows a cut),
// each its own box under `content-visibility: auto`. A chunk starts as one
// text node, so find-in-page sees the whole document from the first paint;
// its rows are built straight into it once it nears the viewport
// (view/lazy-render.js). Lit renders only the shells and never looks inside.
import { html, nothing, unsafeCSS } from 'lit'
import { styleMap } from '../style-map.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import { highlight, splitHighlightedLines } from '../prism-highlight.js'
import { unwatchNearViewport, watchNearViewport } from '../lazy-render.js'
import { chunkLines, escapeHtml, tableLead } from '../export-view-chunks.js'
import { trustedHTML } from '../trusted-types.js'
import codeTokensCSS from '../../styles/code-tokens.css'
import exportViewCSS from './dialog-export-view.css'

// The clipboard glyph the finding card and Code slide copy with.
const COPY_ICON = html`<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
  <rect x="3" y="2.5" width="8" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
  <rect x="5.5" y="5" width="8" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
</svg>`

// The rows of lines [start, end) as one HTML string (a template per line would
// be a parse per line): `rows` is Prism's markup per line, else the lines
// escaped. Each line keeps its newline inside the cell: copied cells serialise
// as blocks, and an empty block (a blank line) would otherwise vanish.
function rowsHtml(lines, start, end, rows = null) {
  let out = ''
  for (let i = start; i < end; i++) {
    const line = rows === null ? escapeHtml(lines[i]) : rows[i - start]
    out += `<span class="evd-lineno" aria-hidden="true">${i + 1}</span><code class="evd-line">${line}\n</code>`
  }
  return out
}

class ExportViewDialog extends AppDialog {
  // The palette `<finding-card>` adopts, so a snippet reads the same here.
  static styles = [...AppDialog.styles, unsafeCSS(codeTokensCSS), unsafeCSS(exportViewCSS)]

  static properties = {
    markdown: { attribute: false },
    // '', or 'done' / 'failed' for a moment after a copy.
    _copied: { state: true },
  }

  // Derived from `markdown` in willUpdate; nothing renders from them reactively.
  _lines = []
  _kb = '0.0'
  _chunks = []
  _copiedTimer = null

  constructor() {
    super()
    this.markdown = ''
    this._copied = ''
  }

  // Nothing to type into or commit: focus the way out.
  focusInitial() {
    this.renderRoot.querySelector('button[data-role="cancel"]')?.focus()
  }

  willUpdate(changed) {
    if (!changed.has('markdown')) return
    const raw = this.markdown.split('\n')
    // A trailing newline ends the last line rather than opening an empty one.
    const count = raw.length > 1 && raw.at(-1) === '' ? raw.length - 1 : raw.length
    this._lines = raw.slice(0, count)
    this._kb = (new TextEncoder().encode(this.markdown).length / 1024).toFixed(1)
    this._chunks = chunkLines(this._lines, this.markdown).map(([start, end]) => ({ start, end, asked: false }))
  }

  render() {
    const count = this._lines.length
    // Only a refused clipboard needs hover text: the way out.
    const copyLabel = this._copied === 'done' ? 'Copied' : this._copied === 'failed' ? 'Copy failed' : 'Copy'
    const copyHint = this._copied === 'failed' ? 'Select the text and copy it by hand' : nothing
    // Close leads the source, pinned in the corner where a reader tabbing in
    // meets it. The chunks are shells `updated` fills; `--evd-chunk-lines`
    // sizes one while skipped (dialog-export-view.css).
    return html`<dialog @close=${this._onClose}>
      <button
        type="button"
        class="evd-close"
        data-role="cancel"
        aria-label="Close"
        @click=${this._onClose}
      >×</button>
      <header>
        <h3>Report markdown</h3>
        <span class="evd-meta">· ${count} ${count === 1 ? 'line' : 'lines'} · ${this._kb} KB</span>
        <button
          type="button"
          class="evd-copy ${this._copied === 'done' ? 'evd-done' : this._copied === 'failed' ? 'evd-failed' : ''}"
          data-role="copy"
          data-tooltip=${copyHint}
          @click=${this._onCopy}
        >${COPY_ICON}${copyLabel}</button>
      </header>
      <div class="evd-code" tabindex="0">
        <div class="evd-lines" style=${styleMap({ '--evd-lineno-width': `${String(count).length}ch` })}>
          ${this._chunks.map((chunk, i) => html`<div
            class="evd-chunk evd-pending"
            data-chunk=${i}
            style=${styleMap({ '--evd-chunk-lines': `${chunk.end - chunk.start}` })}
          ></div>`)}
        </div>
      </div>
    </dialog>`
  }

  // Each new shell gets its text, and is watched until it nears the viewport,
  // once. Not on a host already removed (a `modal-conflict` removes it before
  // Lit runs this), which would hand the shared observer a detached copy of
  // the report nothing unwatches.
  updated() {
    if (!this.isConnected) return
    for (const el of this.renderRoot.querySelectorAll('.evd-chunk:not([data-watched])')) {
      el.dataset.watched = ''
      const index = Number(el.dataset.chunk)
      const chunk = this._chunks[index]
      // Every line terminated, as in rowsHtml, for a select-all of this state.
      el.textContent = `${this._lines.slice(chunk.start, chunk.end).join('\n')}\n`
      watchNearViewport(el, (near) => {
        if (!near) return
        unwatchNearViewport(el)
        void this._paint(el, index)
      })
    }
  }

  disconnectedCallback() {
    for (const el of this.renderRoot.querySelectorAll('.evd-chunk[data-watched]')) unwatchNearViewport(el)
    clearTimeout(this._copiedTimer)
    super.disconnectedCallback()
  }

  // The whole file, not the lines on screen, without a select-all laying out
  // every line. Close may land while the write is pending.
  _onCopy = async () => {
    let state = 'done'
    try {
      await navigator.clipboard.writeText(this.markdown)
    } catch {
      state = 'failed'
    }
    if (!this.isConnected) return
    this._copied = state
    clearTimeout(this._copiedTimer)
    this._copiedTimer = setTimeout(() => {
      this._copied = ''
      this._copiedTimer = null
    }, 1500)
  }

  // One chunk's rows in Prism's colour (Prism loads on demand, so the first
  // chunk stays text until it lands). A chunk cut from a table's body goes to
  // Prism with the table's header and delimiter lines in front (`tableLead`),
  // dropped from the answer. The markup is trusted only when it splits into as
  // many lines as the chunk has: plain text against right numbers beats colour
  // against wrong ones. Not into a removed element.
  async _paint(el, index) {
    const chunk = this._chunks[index]
    if (!chunk || chunk.asked) return
    chunk.asked = true
    const lead = tableLead(this._lines, chunk.start)
    const text = [...(lead ? this._lines.slice(lead[0], lead[1]) : []), ...this._lines.slice(chunk.start, chunk.end)].join('\n')
    const painted = await highlight(text, 'markdown')
    if (!this.isConnected) return
    const rows = painted === null ? null : splitHighlightedLines(painted).slice(lead ? lead[1] - lead[0] : 0)
    el.innerHTML = trustedHTML(rowsHtml(this._lines, chunk.start, chunk.end, rows?.length === chunk.end - chunk.start ? rows : null))
    el.classList.remove('evd-pending')
  }
}

customElements.define('export-view-dialog', ExportViewDialog)

// Takes the serialized Markdown, the text the download would write: what to
// show is the caller's. Resolves, to nothing, on close, or when it can't show.
export function openExportViewDialog(markdown) {
  return openAppDialog('export-view-dialog', { markdown }, { conflict: () => undefined }).then(() => undefined)
}
