// `<color-marker>` — the four-dot mark-color picker rendered inside
// each finding's action row (and the table-view row). Replaces the
// old inline `<button class="mark-dot mark-dot-{red|blue|green|gray}">`
// markup that lived directly inside finding-row.js / finding-card.js
// shadow DOMs and was styled per-component. Now the four dots live
// in their own shadow root with a single shared stylesheet, and
// each component just drops a `<color-marker .selected=…>` in.
//
// Visual ported from the `design/prototypes/DeepView.0.html` mockup
// (the `.dot` rules at the top of the file). Each dot is a 14px
// colored ring (outline only) dimmed to `opacity: .55` by default;
// hovering brings it to full opacity and scales it up by 1.12. The
// active dot fills with `currentColor` and stacks two box-shadows
// to draw a 1px surface-colored gap plus a 1px outer color ring,
// which gives the "floating filled disc" look the mockup uses to
// indicate selection. Colors are oklch values so the four hues sit
// at matched lightness / chroma instead of drifting visually
// (which a hand-tuned hex set tends to). Independent of the muted
// row-tint values defined per-component (`:host(.mark-red) .row {
// background: #6b1820 }` etc.) that paint the row background when
// a finding is marked — those represent the same logical mark
// color but use a darker treatment for their fill role.
//
// Click semantics: dispatching a composed-bubbling `mark-color`
// `CustomEvent({ detail: { color } })` lets events.js handle the
// per-tab toggle (set/delete `state.markers[activeKey]`) without
// the component needing to know about findings, groups, or active
// tabs. Toggling on the currently-selected dot is handled by
// events.js — the component just reports which dot was clicked.
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
