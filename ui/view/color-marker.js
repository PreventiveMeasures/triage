// `<color-marker>` — the four-dot mark-color picker rendered inside
// each finding's action row (and the table-view row). The four dots
// live in their own shadow root with a single shared stylesheet;
// each component just drops a `<color-marker .selected=…>` in.
//
// Colors are oklch so the four hues sit at matched lightness/chroma
// instead of drifting visually (as a hand-tuned hex set tends to).
// Independent of the muted per-component row-tint values
// (`:host(.mark-red) .row { background: #6b1820 }` etc.) that paint
// the marked-row background — same logical mark color, darker
// treatment for that fill role.
//
// Click semantics: a composed-bubbling `mark-color`
// `CustomEvent({ detail: { color } })` lets events.js handle the
// per-tab toggle (set/delete `state.markers[activeKey]`, including
// toggling off the selected dot) without the component knowing about
// findings, groups, or active tabs — it just reports which dot was clicked.
import { LitElement, html, unsafeCSS } from 'lit'
import markerCSS from './color-marker.css'

const COLORS = ['red', 'blue', 'green', 'gray']

class ColorMarker extends LitElement {
  static properties = {
    selected: { type: String },
  }

  static styles = unsafeCSS(markerCSS)

  constructor() {
    super()
    this.selected = null
  }

  render() {
    return html`${COLORS.map((color) => html`<button type="button"
      class=${`color-${color}${this.selected === color ? ' active' : ''}`}
      data-color=${color}
      title=${`mark ${color}`}
      @click=${this._onClick}
    ></button>`)}`
  }

  _onClick = (e) => {
    const color = e.currentTarget.dataset.color
    this.dispatchEvent(new CustomEvent('mark-color', {
      detail: { color },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('color-marker', ColorMarker)
