// `<color-marker>` — the four-dot mark-color picker in each finding's action
// row. Its oklch dots sit at matched lightness/chroma; the marked row's
// darker tint is the components' own. A click reports which dot as a
// `mark-color` event, which events.js applies to the active tab (the marked
// color again clears it), so the component knows nothing of findings.
import { LitElement, html, unsafeCSS } from 'lit'
import markerCSS from './color-marker.css'
import { emit } from './emit.js'

const COLORS = ['red', 'blue', 'green', 'gray']

class ColorMarker extends LitElement {
  static properties = {
    selected: { type: String },
    disabled: { type: Boolean },
  }

  static styles = unsafeCSS(markerCSS)

  constructor() {
    super()
    this.selected = null
    this.disabled = false
  }

  render() {
    return html`${COLORS.map((color) => html`<button type="button"
      class=${`color-${color}${this.selected === color ? ' active' : ''}`}
      data-color=${color}
      aria-label=${`mark ${color}`}
      ?disabled=${this.disabled}
      @click=${this._onClick}
    ></button>`)}`
  }

  _onClick = (e) => {
    if (this.disabled) return
    emit(this, 'mark-color', { color: e.currentTarget.dataset.color })
  }
}

customElements.define('color-marker', ColorMarker)
