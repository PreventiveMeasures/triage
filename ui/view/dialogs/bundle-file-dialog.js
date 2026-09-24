import { html, nothing, unsafeCSS } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { AppDialog, openAppDialogOrReject } from './app-dialog.js'
import { bundleFileDiff } from '../bundle-file-diff.js'
import { bundleFileByteLength } from '../bundle-sources.js'
import { formatBytes } from '../format.js'
import { highlight, langForPath } from '../prism-highlight.js'
import codeTokensCSS from '../../styles/code-tokens.css'
import styles from './dialog-bundle-file.css'

class BundleFileDialog extends AppDialog {
  static properties = { path: {}, before: { attribute: false }, after: { attribute: false }, baseName: {}, otherName: {}, kind: {}, _lines: { state: true }, _error: { state: true }, _highlighted: { state: true } }
  static styles = [...AppDialog.styles, unsafeCSS(codeTokensCSS), unsafeCSS(styles)]
  constructor() { super(); this._lines = null; this._error = null; this._highlighted = null }
  beforeOpen() {
    if (this.kind === 'changed') {
      try { this._lines = bundleFileDiff(this.before, this.after) }
      catch { this._error = 'Could not calculate this diff.' }
    } else {
      const content = this.kind === 'removed' ? this.before : this.after
      if (typeof content === 'string') this._highlight(content)
    }
  }
  async _highlight(content) {
    const highlighted = await highlight(content, langForPath(this.path))
    if (this.isConnected) this._highlighted = highlighted
  }
  render() {
    const changed = this.kind === 'changed'
    const content = this.kind === 'removed' ? this.before : this.after
    const binary = changed ? this._lines === null : typeof content !== 'string'
    const size = value => formatBytes(bundleFileByteLength(value) ?? 0)
    return html`<dialog aria-labelledby="file-title" @close=${this._onClose}>
      <header><div class="file-heading"><h3 id="file-title">${this.path}</h3><button type="button" aria-label="Close file" @click=${this._onClose}><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg></button></div>
        <div class="file-details">
          <p class="file-context">${changed ? `${this.baseName} → ${this.otherName}` : this.kind === 'removed' ? this.baseName : this.otherName}</p>
          ${changed ? html`<p class="file-legend"><span class="removed">− Before</span><span class="added">+ After</span><span>${size(this.before)} → ${size(this.after)}</span></p>` : nothing}
        </div>
      </header>
      ${this._error ? html`<p class="file-message" role="alert">${this._error}</p>`
        : binary ? html`<p class="file-message">${changed ? 'Binary file changed. A text diff is not available.' : `Binary file · ${size(content)}`}</p>`
        : changed ? html`<pre class="file-code" tabindex="0" aria-label="File diff"><code>${this._lines.map(line => html`<span class=${`diff-line ${line.kind}`}>${line.text}</span>`)}</code></pre>`
        : html`<pre class="file-code" tabindex="0" aria-label="File contents"><code>${this._highlighted ? unsafeHTML(this._highlighted) : content || 'Empty file'}</code></pre>`}
    </dialog>`
  }
}
customElements.define('bundle-file-dialog', BundleFileDialog)
export function openBundleFileDialog(props) {
  return openAppDialogOrReject('bundle-file-dialog', props, el => { el.before = null; el.after = null })
}
