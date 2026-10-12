import { html } from 'lit'
import { BundleCompareCode } from './bundle-compare-code.js'

// Review owns the navigation and editor. Inherit only the existing file/diff
// rendering, including binary files, large-file limits and syntax highlighting.
export class NpmReviewCode extends BundleCompareCode {
  static properties = { ...BundleCompareCode.properties, order: { attribute: false } }
  render() {
    this._order = this.order ?? [...this._entries.keys()]
    this._current = this._entries.has(this.path) ? this.path : this._order[0]
    return this._current ? this._renderFile(this._current, '') : html`<p class="npm-review-empty">No files differ in this comparison.</p>`
  }
}
customElements.define('npm-review-code', NpmReviewCode)
