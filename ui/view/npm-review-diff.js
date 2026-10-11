import { BundleCompareAll } from './bundle-compare-all.js'

export class NpmReviewDiff extends BundleCompareAll {
  static properties = { ...BundleCompareAll.properties, path: {} }
  willUpdate(changed) {
    super.willUpdate(changed)
    if (changed.has('path') || changed.has('files')) {
      const index = [...this._entries.keys()].toSorted((a, b) => a.localeCompare(b)).indexOf(this.path)
      this._fileLimit = Math.max(this._fileLimit, Math.ceil((index + 1) / 40) * 40)
    }
  }
  updated(changed) {
    if (!changed.has('path')) return
    const file = [...this.querySelectorAll('.bundle-compare-all-file')].find(element => element.getAttribute('aria-label') === this.path)
    file?.scrollIntoView({ block: 'start' })
  }
}
customElements.define('npm-review-diff', NpmReviewDiff)
