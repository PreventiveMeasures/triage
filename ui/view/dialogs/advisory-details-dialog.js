import { html, nothing, unsafeCSS } from 'lit'
import { autorun } from '@rray/frontend/state-management'
import { AppDialog, openAppDialog } from './app-dialog.js'
import { severityBadge } from './shared.js'
import { flowText } from '../format.js'
import { renderHighlighted } from '../render-finding.js'
import proseCSS from '../../styles/prose.css'
import codeTokensCSS from '../../styles/code-tokens.css'
import severityCSS from './dialog-severity.css'
import styles from './dialog-advisory-details.css'

class AdvisoryDetailsDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(proseCSS), unsafeCSS(codeTokensCSS), unsafeCSS(severityCSS), unsafeCSS(styles)]
  static properties = { heading: { attribute: false }, severity: { attribute: false }, _body: { state: true } }

  connectedCallback() {
    super.connectedCallback()
    // Reuse finding code highlighting, and discard the popup if its advisory
    // cache loses the current session/team scope while it is open.
    this._dispose = autorun(() => {
      if (!this.isCurrent()) { this._body = nothing; queueMicrotask(this._onClose); return }
      this._body = renderHighlighted(flowText(this.markdown))
    })
  }
  disconnectedCallback() { this._dispose?.(); super.disconnectedCallback() }

  render() {
    return html`<dialog aria-labelledby="advisory-title" @close=${this._onClose}>
      <header>
        <h3 id="advisory-title">${severityBadge(this.severity === 'unknown' ? 'unrated' : this.severity)}<span>${this.heading}</span></h3>
        <button type="button" aria-label="Close advisory details" @click=${this._onClose}>×</button>
      </header>
      <div class="advisory-description" tabindex="0">${this._body}</div>
    </dialog>`
  }
}
customElements.define('advisory-details-dialog', AdvisoryDetailsDialog)

export function openAdvisoryDetailsDialog(props) {
  return openAppDialog('advisory-details-dialog', props)
}
