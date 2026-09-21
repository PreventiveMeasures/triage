// Shared switch for display modes in toolbars, graphs, and bundle views.
// Owners control `checked` and handle the native composed click event; the
// shadow root keeps every instance styled by the same rules in any view.
import { LitElement, html, unsafeCSS } from './frontend-global.js'
import switchCSS from './mode-switch.css'

class ModeSwitch extends LitElement {
  static properties = {
    checked: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    label: { type: String },
    accessibleLabel: { type: String, attribute: 'accessible-label' },
  }

  static styles = unsafeCSS(switchCSS)

  constructor() {
    super()
    this.checked = false
    this.disabled = false
    this.label = ''
    this.accessibleLabel = ''
  }

  render() {
    return html`<button type="button" part="button" aria-pressed=${String(this.checked)}
      aria-label=${this.accessibleLabel || this.label} ?disabled=${this.disabled}
    ><span>${this.label}</span><span class="track" part="track" aria-hidden="true"></span></button>`
  }
}

if (!customElements.get('mode-switch')) customElements.define('mode-switch', ModeSwitch)
