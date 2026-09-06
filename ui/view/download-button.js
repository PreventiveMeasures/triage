// `<download-button>` — fixed top-right markdown download icon,
// stacks below the print button. Shares the print button's visibility
// predicate (findings view, loaded report, printable view-mode)
// because the user generally wants the markdown export alongside the
// print affordance; each owns its visibility via StateElement.
//
// Click dispatches a `download-requested` CustomEvent (bubbles +
// composed); events.js listens on document, confirms the selection,
// and calls downloadReportsAsMarkdown() (view/markdown-export.js).
import { nothing } from 'lit'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'

const DOWNLOAD_ICON = html`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
  <polyline points="7 10 12 15 17 10"/>
  <line x1="12" x2="12" y1="15" y2="3"/>
</svg>`

class DownloadButton extends StateElement {
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
      title="download this report"
      aria-label="download"
      @click=${this._onClick}
    >${DOWNLOAD_ICON}</button>`
  }

  _onClick = () => {
    this.dispatchEvent(new CustomEvent('download-requested', { bubbles: true, composed: true }))
  }
}

customElements.define('download-button', DownloadButton)
