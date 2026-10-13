import { LitElement, html, nothing } from 'lit'
import { auditMarkdown } from '../../common/dependency-reviews.js'
import { COPY_ICON } from './lit-icons.js'

export class ReviewAuditCopy extends LitElement {
  static properties = { review: { attribute: false }, _copied: { state: true }, _error: { state: true } }
  createRenderRoot() { return this }
  disconnectedCallback() { super.disconnectedCallback(); clearTimeout(this._timer) }
  async _copy() {
    const text = auditMarkdown(this.review)
    if (text === null) return
    this._error = false
    try {
      await navigator.clipboard.writeText(text)
      this._copied = true
      clearTimeout(this._timer)
      this._timer = setTimeout(() => { this._copied = false }, 2000)
    } catch { this._error = true }
  }
  render() {
    if (!this.review || auditMarkdown(this.review) === null) return nothing
    return html`<button type="button" class=${`bundle-code-copy-path${this._copied ? ' copied' : ''}`} aria-label="Copy audit Markdown"
      @click=${() => this._copy()}>${COPY_ICON}</button>
      ${this._error ? html`<span role="alert">Could not copy to the clipboard.</span>` : nothing}`
  }
}
customElements.define('review-audit-copy', ReviewAuditCopy)
