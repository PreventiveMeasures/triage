// Base of the toolbar's filter controls: a StateElement rendering to light
// DOM, so toolbar.css styles it directly; its host is the `role="group"`
// where `groupLabel` names one; and its events bubble, composed, to the
// listeners events.js holds on `report`.
import { StateElement } from '@rray/frontend/state-element'
import { ensureHostAria } from './host-aria.js'

export class ToolbarControl extends StateElement {
  createRenderRoot() { return this }

  connectedCallback() {
    super.connectedCallback()
    if (this.groupLabel) ensureHostAria(this, { role: 'group', 'aria-label': this.groupLabel })
  }

  emit(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }))
  }
}
