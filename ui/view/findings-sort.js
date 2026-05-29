// `<findings-sort>` — `Severity ↓ / File ↑ / Confidence ↓ / ... `
// sort dropdown for the findings toolbar.
//
// Kept separate from its sibling `<entity-sort>` (Packages /
// Repositories pages) because the findings dropdown has a CONDITIONAL
// option list driven by parent flags (file sort only when a tree
// exists, confidence/priority only when the dataset surfaces those
// fields) and different CSS — findings shares the
// `& :is(analyzer-select, findings-sort)` chevron rule in toolbar.css
// with the analyzer dropdown, while `<entity-sort>` has its own offset
// in report.css. Folding them would mean threading style + option-shape
// props through one component or two barely-shared template branches;
// instead they stay two thin components paired by the `sort-change`
// dispatch contract.
//
// Reactivity: extends StateElement, reads `state.sortBy`. Native
// `<select>` value bound through `live()` so a stale-filter clear in
// the parent's pipeline (e.g. `state.sortBy` reset when its option
// drops out of view) actually moves the browser-native `value`, not
// just a `?selected=` attribute the browser ignores after interaction.
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
