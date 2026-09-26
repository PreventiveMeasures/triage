// Managed findings open the full file from the report-scoped memory cache.
// A native dialog also stacks correctly above the Kanban finding dialog.
import { html, unsafeCSS } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import { fetchReportSources, readReportSources } from '../client-managed.js'
import { lineRange } from '../format.js'
import { highlight, langForPath } from '../prism-highlight.js'
import { revealCitedLines } from '../reveal-cited.js'
import sourceCSS from './dialog-finding-source.css'
import codeTokensCSS from '../../styles/code-tokens.css'

class FindingSourceDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(sourceCSS), unsafeCSS(codeTokensCSS)]
  static properties = {
    reportId: { attribute: false }, file: { attribute: false }, line: { attribute: false },
    _path: { state: true }, _content: { state: true }, _highlighted: { state: true }, _loading: { state: true },
  }

  constructor() {
    super()
    this.reportId = ''; this.file = ''; this.line = ''
    this._path = ''; this._content = null; this._highlighted = null; this._loading = true
  }

  beforeOpen() { void this._load() }

  async _load() {
    try {
      const data = await fetchReportSources(this.reportId)
      if (this._settled || !this.isConnected) return
      const entry = readReportSources(this.reportId)
      if (!entry || entry.data !== data || entry.controller?.signal.aborted) { this._finish(null); return }
      // Discard the open file along with its cache on logout, role/mode
      // changes or report reloads. Closing only this dialog keeps the cache.
      this._sourceSignal = entry.controller?.signal
      this._sourceSignal?.addEventListener('abort', this._onClose, { once: true })
      this._path = data?.paths.get(this.file) ?? this.file
      this._content = data?.sources.get(this._path) ?? null
      this._loading = false
      await this.updateComplete
      if (this._settled || !this.isConnected) return
      revealCitedLines(this.renderRoot.querySelector('.source-scroll'), this.renderRoot.querySelectorAll('.cited'))
      const lang = langForPath(this._path)
      if (lang && this._content !== null) {
        const highlighted = await highlight(this._content, lang)
        if (!this._settled && this.isConnected) this._highlighted = highlighted
      }
    } catch (error) {
      if (error.name === 'AbortError') this._finish(null)
      else this._loading = false
    }
  }

  disconnectedCallback() {
    this._sourceSignal?.removeEventListener('abort', this._onClose)
    this._content = null; this._highlighted = null
    super.disconnectedCallback()
  }

  _onKeydown = (event) => {
    // Let the native dialog handle Escape without closing the finding below.
    if (event.key === 'Escape') event.stopPropagation()
  }

  _onBackdrop = (event) => {
    if (event.target !== event.currentTarget) return
    const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect()
    if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) this._finish(null)
  }

  render() {
    const range = lineRange(this.line)
    return html`<dialog aria-labelledby="source-title" @close=${this._onClose} @keydown=${this._onKeydown} @click=${this._onBackdrop}>
      <header>
        <h3 id="source-title">${this._path || this.file}</h3>
        <button type="button" aria-label="Close source viewer" @click=${this._onClose}>×</button>
      </header>
      <div class="source-scroll" tabindex="0" aria-label="Full source code" aria-busy=${String(this._loading)}>
        ${this._content === null
          ? html`<p class="source-status" role="status">${this._loading ? 'Loading source…' : 'Source unavailable'}</p>`
          : html`<div class="source-lines">
              <aside aria-hidden="true">${this._content.split('\n').map((_, index) => html`<div class=${range && index + 1 >= range.start && index + 1 <= range.end ? 'cited' : ''}>${index + 1}</div>`)}</aside>
              <pre><code>${typeof this._highlighted === 'string' ? unsafeHTML(this._highlighted) : this._content}</code></pre>
            </div>`}
      </div>
    </dialog>`
  }
}

customElements.define('finding-source-dialog', FindingSourceDialog)

export function openFindingSourceDialog({ reportId, file, line }) {
  return openAppDialog('finding-source-dialog', { reportId, file, line })
}
