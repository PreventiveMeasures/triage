// `<download-button>` — the export affordance at the right of the findings
// toolbar's first row, beside the app lens. Shown on the findings view with
// a report loaded, except in the graph and the kanban board, which don't
// read on paper. A click emits `download-requested`: events.js confirms the
// selection, then writes the markdown or prints, by the dialog's tab.
import { nothing } from 'lit'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { DOWNLOAD_ICON } from './export-icons.js'
import { emit } from './emit.js'

class DownloadButton extends StateElement {
  createRenderRoot() { return this }

  render() {
    const visible = state.reports.length > 0 && state.currentView === 'findings'
      && state.viewMode !== 'graph' && state.viewMode !== 'kanban'
    if (!visible) return nothing
    return html`<button
      type="button"
      class="toolbar-export-btn"
      aria-label="Download or print report"
      @click=${this._onClick}
    >${DOWNLOAD_ICON}</button>`
  }

  _onClick = () => { emit(this, 'download-requested') }
}

customElements.define('download-button', DownloadButton)
