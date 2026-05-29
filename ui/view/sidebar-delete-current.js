// `<sidebar-delete-current>` — the `Delete current` button. Targets
// whichever artifact is active: the selected bundle in the bundles
// view, otherwise the open report. Disabled when neither is in play.
//
// Reads `state.currentFile` / `state.selectedBundle` /
// `state.currentView` reactively via StateElement's autorun, so the
// disabled state follows mutations in those slots without a sidebar
// repaint.
//
// The click bubbles through the host to sidebar.js's `onSidebarClick`
// delegate, which matches via `closest('sidebar-delete-current')` and
// runs the bundle-then-report deletion dispatch.
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'

const TRASH_ICON = html`<svg class="trash-icon" viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M3 4h10M6.5 4V2.5h3V4M5 4l.7 9h4.6L11 4"/>
</svg>`

class SidebarDeleteCurrent extends StateElement {
  createRenderRoot() { return this }

  render() {
    const bundleActive = state.currentView === 'bundles' && state.selectedBundle
    const disabled = !state.currentFile && !bundleActive
    return html`<button
      type="button"
      class="danger"
      ?disabled=${disabled}
    >${TRASH_ICON}<span>Delete current</span></button>`
  }
}

customElements.define('sidebar-delete-current', SidebarDeleteCurrent)
