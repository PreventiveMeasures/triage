// A button copying the comment a server's host formats of one's own
// dependency reviews (server-managed/dependency-review-comments.ts), given it
// as `text`: of a review, or of those of a pull request's versions; none
// where there is none, as where the host formats none, or they aren't one's
// own, which the server never asks it to format.
import { LitElement, html, nothing } from 'lit'
import { COPY_ICON } from './lit-icons.js'

export class DependencyReviewCopy extends LitElement {
  static properties = { text: { attribute: false }, label: { attribute: false }, _copied: { state: true }, _error: { state: true } }
  createRenderRoot() { return this }
  constructor() {
    super()
    this.text = null
    this.label = 'Copy dependency review'
  }
  disconnectedCallback() { super.disconnectedCallback(); clearTimeout(this._timer) }
  async _copy() {
    if (!this._copyable()) return
    this._error = false
    try {
      await navigator.clipboard.writeText(this.text)
      this._copied = true
      clearTimeout(this._timer)
      this._timer = setTimeout(() => { this._copied = false }, 2000)
    } catch { this._error = true }
  }
  _copyable() { return typeof this.text === 'string' && this.text.trim() !== '' }
  render() {
    if (!this._copyable()) return nothing
    return html`<button type="button" class=${`bundle-code-copy-path dependency-review-copy-button${this._copied ? ' copied' : ''}`} aria-label=${this.label}
      data-tooltip=${this.label} @click=${() => this._copy()}>${COPY_ICON}</button>
      ${this._error ? html`<span role="alert">Could not copy to the clipboard.</span>` : nothing}`
  }
}
customElements.define('dependency-review-copy', DependencyReviewCopy)
