// `<download-button>` — the export affordance, in the findings
// toolbar at the right of the first row, immediately left of the app
// lens (`<revalidation-switch>`) and separate from it. It used to be a
// fixed icon in the top-right corner, stacked under a print button of
// its own; both exports now start here, and which one runs is a tab in
// the dialog (dialogs/export-confirm-dialog.js).
//
// Visible on the findings view with a report loaded, and not in the
// two view-modes that have nothing to give either export: the graph
// and the kanban board don't read on paper, and the dialog's Print tab
// is half of what this button is for.
//
// Click dispatches a `download-requested` CustomEvent (bubbles +
// composed); events.js listens on document, confirms the selection,
// and either writes the markdown (view/markdown-export.js) or runs the
// print pipeline, depending on the tab the reader confirmed under.
import { nothing } from 'lit'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { DOWNLOAD_ICON } from './export-icons.js'

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
      class="toolbar-export-btn"
      aria-label="Download or print report"
      @click=${this._onClick}
    >${DOWNLOAD_ICON}</button>`
  }

  _onClick = () => {
    this.dispatchEvent(new CustomEvent('download-requested', { bubbles: true, composed: true }))
  }
}

customElements.define('download-button', DownloadButton)
