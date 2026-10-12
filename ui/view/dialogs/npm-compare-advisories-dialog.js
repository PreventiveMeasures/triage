// Compare's advisories between two npm versions (npm-overview.js
// npmCompareBadges): `groups` of rows as the Overview's Advisories column
// draws them, each `{ status, heading, rows }`, the status `new`, `kept` or
// `fixed`. Discarded, as the advisory details dialog is, if the session the
// advisories were read in changes while it is open (`isCurrent`).
import { html, nothing, unsafeCSS } from 'lit'
import { autorun } from '@rray/frontend/state-management'
import { AppDialog, openAppDialog } from './app-dialog.js'
import advisoryRowsCSS from '../../styles/advisory-rows.css'
import detailsCSS from './dialog-advisory-details.css'
import styles from './dialog-compare-advisories.css'

class NpmCompareAdvisoriesDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(advisoryRowsCSS), unsafeCSS(detailsCSS), unsafeCSS(styles)]
  static properties = { heading: { attribute: false }, groups: { attribute: false }, _current: { state: true } }

  connectedCallback() {
    super.connectedCallback()
    this._dispose = autorun(() => {
      this._current = this.isCurrent()
      if (!this._current) queueMicrotask(this._onClose)
    })
  }
  disconnectedCallback() { this._dispose?.(); super.disconnectedCallback() }

  render() {
    return html`<dialog aria-labelledby="compare-advisories-title" @close=${this._onClose}>
      <header>
        <h3 id="compare-advisories-title"><span>${this.heading}</span></h3>
        <button type="button" aria-label="Close advisories" @click=${this._onClose}>×</button>
      </header>
      <div class="compare-advisories" tabindex="0">${this._current ? this.groups.map(group => html`<section class=${`compare-advisory-group is-${group.status}`}>
        <h4>${group.heading} <span class="compare-advisory-count">${group.rows.length}</span></h4>
        <ul class="bundle-advisories-rows">${group.rows}</ul>
      </section>`) : nothing}</div>
    </dialog>`
  }
}
customElements.define('npm-compare-advisories-dialog', NpmCompareAdvisoriesDialog)

export function openNpmCompareAdvisoriesDialog(props) {
  return openAppDialog('npm-compare-advisories-dialog', props)
}
