import { html } from 'lit'
import { BundleCompareAll } from './bundle-compare-all.js'

export class NpmReviewDiff extends BundleCompareAll {
  static properties = { ...BundleCompareAll.properties, path: {} }
  _layout(_rail, content) { return content }
  _spy() {}
  _fileContent(...args) {
    // Bound the sticky header to the diff, ending before the review actions.
    return html`<div class="npm-review-file-content">${super._fileContent(...args)}</div>`
  }
  willUpdate(changed) {
    super.willUpdate(changed)
    if (changed.has('path') || changed.has('files')) {
      const index = this._railState().order.indexOf(this.path)
      this._fileLimit = Math.max(this._fileLimit, Math.ceil((index + 1) / 40) * 40)
    }
  }
  updated(changed) {
    this._goTo = null
    if (!changed.has('path')) return
    const file = [...this.querySelectorAll('.bundle-compare-all-file')].find(element => element.getAttribute('aria-label') === this.path)
    file?.scrollIntoView({ block: 'start' })
  }
}
customElements.define('npm-review-diff', NpmReviewDiff)
