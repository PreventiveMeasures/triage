// `<sidebar-delete-current>` — the `Delete current` button in the
// sidebar's actions row. Targets whichever artifact is currently
// active: the selected bundle in the bundles view, otherwise the
// open report. Disabled when neither is in play.
//
// Replaces a static `<button id="delete-current">` in AppSidebar's
// shadow template and the imperative `deleteBtn.disabled = …`
// block in renderSidebar(). The button's disabled state reads
// `state.currentFile` / `state.selectedBundle` / `state.currentView`
// reactively via StateElement's autorun, so it follows any
// mutation in those slots without needing a sidebar repaint.
//
// The native button click bubbles through the host element up to
// sidebar.js's `onSidebarClick` delegate on the shadow root; that
// delegate uses `closest('sidebar-delete-current')` to run the
// bundle-then-report deletion dispatch in one place.
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
