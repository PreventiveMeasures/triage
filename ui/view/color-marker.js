// `<color-marker>` — the four-dot mark-color picker rendered inside
// each finding's action row (and the table-view row). Replaces the
// old inline `<button class="mark-dot mark-dot-{red|blue|green|gray}">`
// markup that lived directly inside finding-row.js / finding-card.js
// shadow DOMs and was styled per-component. Now the four dots live
// in their own shadow root with a single shared stylesheet, and
// each component just drops a `<color-marker .selected=…>` in.
//
// Visual: each dot is a colored ring (outline only) by default; the
// currently-selected dot grows an inner filled disc to indicate
// active state. On hover the whole dot scales up slightly. The
// colors are vivid hex values so they stay readable against the
// dark sidebar/card surfaces — distinct from the muted row-tint
// values defined per-component (`:host(.mark-red) .row { background:
// #6b1820 }` etc.) that paint the row when a finding is marked.
//
// Click semantics: dispatching a composed-bubbling `mark-color`
// `CustomEvent({ detail: { color } })` lets events.js handle the
// per-tab toggle (set/delete `state.markers[activeKey]`) without
// the component needing to know about findings, groups, or active
// tabs. Toggling on the currently-selected dot is handled by
// events.js — the component just reports which dot was clicked.
import { LitElement, html, css } from 'lit'

const COLORS = ['red', 'blue', 'green', 'gray']

class ColorMarker extends LitElement {
  static properties = {
    selected: { type: String },
  }

  static styles = css`
    :host {
      display: inline-flex;
      gap: .35rem;
      align-items: center;
    }

    button {
      width: 1.35rem; height: 1.35rem;
      padding: 0;
      background: transparent;
      border: 2px solid currentColor;
      border-radius: 50%;
      cursor: pointer;
      display: grid; place-items: center;
      transition: transform .1s;
    }
    button::before {
      content: '';
      width: 60%; height: 60%;
      border-radius: 50%;
      background: currentColor;
      transform: scale(0);
      transition: transform .1s;
    }
    button.active::before { transform: scale(1); }
    button:hover { transform: scale(1.1); }

    .color-red   { color: #d44e4e; }
    .color-blue  { color: #5180c5; }
    .color-green { color: #4ea060; }
    .color-gray  { color: #888c91; }
  `

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
