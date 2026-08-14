// `<findings-sort>` — `Severity ↓ / File ↑ / Confidence ↓ / ... `
// sort dropdown for the findings toolbar.
//
// Kept separate from its sibling `<entity-sort>` (Packages /
// Repositories pages) because the findings dropdown has a CONDITIONAL
// option list driven by parent flags (file sort only when a tree
// exists, confidence/priority options only when the dataset surfaces
// those fields) and uses different CSS — the findings host shares the
// `& :is(repo-filter, findings-sort)` chevron rule in toolbar.css
// with the repo dropdown, while `<entity-sort>` has its own offset
// in report.css. Folding them would require either threading styling
// and option-shape props through one component or splitting the
// template into two barely-shared branches, so they stay as two thin
// components paired by the same `sort-change` dispatch contract.
//
// Reactivity: extends StateElement, reads `state.sortBy` via the
// autorun. The active sort is bound TWICE — both bindings are load-
// bearing, at opposite ends of the element's life:
//
//   * `?selected=` on each `<option>` carries the FIRST paint. Lit
//     commits an element's own bindings before the child parts
//     nested inside it (parts run in document order), so the
//     `.value=` below lands on a `<select>` that has no options
//     yet; the browser drops a value it can't match and then, once
//     the options do arrive with none of them marked selected,
//     falls back to the first one. That silently showed `Severity ↓`
//     over a list really ordered by priority — the ingest default
//     whenever findings carry `priority` (see resetFilters in
//     filters.js), which every view inherits and the kanban board
//     makes most visible. The attribute rides along with the option
//     itself, so it is in place before the browser picks.
//   * `.value=` through Lit's `live()` directive covers every later
//     render — a stale-filter clear in the parent's pipeline
//     (e.g. `state.sortBy` reset when its option drops out of view)
//     has to move the browser-native `value`, because the
//     `?selected=` attribute above is ignored on an option the user
//     has already interacted with.
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
    const opt = (value, label) =>
      html`<option value=${value} ?selected=${state.sortBy === value}>${label}</option>`
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
