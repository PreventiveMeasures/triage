// `<sidebar-view-button>` — the Packages / Repositories navigation
// buttons right of the sidebar search input.
//
// Reads `state.currentView` in render() so the `.active` highlight
// follows view navigation without a `renderSidebar()` repaint.
//
// `count` (cross-report packages / repositories in the OPFS-wide
// index) is NOT observable — `getPackagesIndex()` /
// `getRepositoriesIndex()` return module-internal Maps the
// observer-util proxy can't see through — so it arrives as a property
// the parent (renderSidebar() call site) assigns. count 0 → `nothing`,
// hiding the button.
//
// The click bubbles through the host to sidebar.js's `onSidebarClick`
// delegate, which routes via `closest('sidebar-view-button')` + the
// host's `kind` attribute to the matching `state.currentView` mutation.
import { nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'

const PACKAGES_ICON = html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M2 6h12v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6Z"/>
  <path d="M2 6l1.6-3.3A1.3 1.3 0 0 1 4.8 2h6.4a1.3 1.3 0 0 1 1.2.7L14 6"/>
  <path d="M8 2v4"/>
</svg>`

const REPOSITORIES_ICON = html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <line x1="4" x2="4" y1="2.5" y2="10"/>
  <circle cx="12" cy="4" r="2"/>
  <circle cx="4" cy="12" r="2"/>
  <path d="M12 6a6 6 0 0 1-6 6"/>
</svg>`

const KIND = {
  packages:     { title: 'Show packages',     icon: PACKAGES_ICON,     view: 'packages' },
  repositories: { title: 'Show repositories', icon: REPOSITORIES_ICON, view: 'repositories' },
}

class SidebarViewButton extends StateElement {
  static properties = {
    kind:  { type: String },
    count: { type: Number },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.kind = ''
    this.count = 0
  }

  render() {
    if (this.count === 0) return nothing
    const config = KIND[this.kind]
    if (!config) {
      console.warn(`<sidebar-view-button>: unknown kind ${JSON.stringify(this.kind)}; ` +
        `expected one of ${Object.keys(KIND).map((k) => JSON.stringify(k)).join(', ')}.`)
      return nothing
    }
    const active = state.currentView === config.view
    return html`<button
      type="button"
      class=${classMap({ 'sidebar-view-btn': true, active })}
      title=${config.title}
      aria-label=${config.title}
    >${config.icon}<span class="view-btn-count">${this.count}</span></button>`
  }
}

customElements.define('sidebar-view-button', SidebarViewButton)
