// `<print-button>` — fixed top-right print icon. Shown only on the
// findings view with a loaded report AND a printable view-mode
// (table / list / grouped / focus): graph and kanban don't read on
// paper, and the Files / Packages / Repositories tabs aren't findings.
// render() returns `nothing` when the predicate is false.
//
// The click flow stays in view/events.js (it owns the shared
// prepareForPrint / restoreAfterPrint state and beforeprint /
// afterprint listeners): the click dispatches a `print-requested`
// CustomEvent (bubbles + composed), events.js listens on document and
// runs the print pipeline.
import { nothing } from 'lit'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'

const PRINT_ICON = html`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
  <path d="M6 9V2h12v7"/>
  <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/>
  <rect x="6" y="14" width="12" height="8"/>
</svg>`

class PrintButton extends StateElement {
  createRenderRoot() { return this }

  render() {
    const visible = (
      state.reports.length > 0 &&
      state.currentView === 'findings' &&
      state.viewMode !== 'graph' &&
      state.viewMode !== 'kanban'
    )
    if (!visible) return nothing
    return html`<button
      type="button"
      title="print this report"
      aria-label="print"
      @click=${this._onClick}
    >${PRINT_ICON}</button>`
  }

  _onClick = () => {
    this.dispatchEvent(new CustomEvent('print-requested', { bubbles: true, composed: true }))
  }
}

customElements.define('print-button', PrintButton)
