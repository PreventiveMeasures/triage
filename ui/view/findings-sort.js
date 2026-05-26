// `<findings-sort>` — `Severity ↓ / File ↑ / Confidence ↓ / ... `
// sort dropdown for the findings toolbar. Replaces the inline
// `<select id="sort-select">` + `sortOpt` helper that lived in
// render.js's `toolbarTemplate`, plus the last id-keyed branch in
// events.js's generic toolbar `change` listener (which now drops
// away entirely).
//
// Sibling of `<entity-sort>` (which serves the Packages /
// Repositories pages); kept separate because the findings dropdown
// has a CONDITIONAL option list driven by parent flags (file sort
// only when a tree exists, confidence/priority options only when
// the dataset surfaces those fields) and uses different CSS — the
// findings host shares the `& :is(analyzer-select, findings-sort)`
// chevron rule in toolbar.css with the analyzer dropdown, while
// `<entity-sort>` has its own offset in report.css's
// `.packages-toolbar entity-sort` rule. Folding them together
// would require either threading styling and option-shape props
// through one component or splitting the template into two
// branches that don't share much, so they stay as two thin
// components that pair with the same `sort-change` dispatch contract.
//
// Reactivity: extends StateElement, reads `state.sortBy` via the
// autorun. Native `<select>` value bound through Lit's `live()`
// directive so a stale-filter clear in the parent's pipeline
// (e.g. `state.sortBy` reset when its option drops out of view)
// actually moves the browser-native `value` rather than just
// flipping a `?selected=` attribute the browser ignores after user
// interaction.
//
// Dispatches `sort-change(detail: { kind: "findings", value })`
// on native change, matching `<entity-sort>`'s dispatch shape so
// events.js's single `sort-change` listener handles every sort
// dropdown via a switch on `kind`.
//
// Attributes (booleans, present-or-absent):
//   * `show-file`       — emit the `File ↑` option.
//   * `show-confidence` — emit the `Confidence ↓` / `Confidence ↑`
//                         option pair.
//   * `show-priority`   — emit the `Priority ↓` / `Priority ↑`
//                         option pair.
import { nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'

class FindingsSort extends StateElement {
  static properties = {
    showFile:       { type: Boolean, attribute: 'show-file' },
    showConfidence: { type: Boolean, attribute: 'show-confidence' },
    showPriority:   { type: Boolean, attribute: 'show-priority' },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.showFile = false
    this.showConfidence = false
    this.showPriority = false
  }

  render() {
    const opt = (value, label) => html`<option value=${value}>${label}</option>`
    return html`<select
      class="sort-select"
      aria-label="Sort findings"
      .value=${live(state.sortBy)}
      @change=${this._onChange}
    >
      ${opt('severity', 'Severity ↓')}
      ${this.showFile ? opt('file', 'File ↑') : nothing}
      ${this.showConfidence ? html`${opt('confidence-desc', 'Confidence ↓')}${opt('confidence-asc', 'Confidence ↑')}` : nothing}
      ${this.showPriority ? html`${opt('priority-desc', 'Priority ↓')}${opt('priority-asc', 'Priority ↑')}` : nothing}
    </select>`
  }

  _onChange = (e) => {
    this.dispatchEvent(new CustomEvent('sort-change', {
      detail: { kind: 'findings', value: e.target.value },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('findings-sort', FindingsSort)
