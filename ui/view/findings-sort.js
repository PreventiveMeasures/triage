// `<findings-sort>` — the findings toolbar's sort dropdown. Apart from
// `<entity-sort>` (Packages / Repositories) because its option list is
// conditional on the parent's flags (`show-file`, `show-confidence`,
// `show-priority`) and its chevron rule is the toolbar's, shared with
// `<repo-filter>`; both dispatch the same `sort-change(detail: { kind,
// value })` for events.js's one listener.
//
// The active sort is bound TWICE, each binding load-bearing:
//   * `?selected=` on each `<option>` carries the FIRST paint. Lit commits
//     the `<select>`'s own bindings before its options exist, so `.value`
//     lands on an empty select and the browser falls back to the first
//     option — showing `Severity ↓` over a list really ordered by priority
//     (the opening default derives from the merged set).
//   * `.value=` through `live()` covers every later render (a stale sort
//     reset by the parent), as `?selected=` is ignored on an option the
//     user has interacted with.
import { nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import { html } from '@rray/frontend/state-element'
import { ToolbarControl } from './toolbar-control.js'
import { state } from '#client/index.js'

class FindingsSort extends ToolbarControl {
  static properties = {
    showFile:       { type: Boolean, attribute: 'show-file' },
    showConfidence: { type: Boolean, attribute: 'show-confidence' },
    showPriority:   { type: Boolean, attribute: 'show-priority' },
  }

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
      @change=${(e) => this.emit('sort-change', { kind: 'findings', value: e.target.value })}
    >
      ${opt('severity', 'Severity ↓')}
      ${this.showFile ? opt('file', 'File ↑') : nothing}
      ${this.showConfidence ? html`${opt('confidence-desc', 'Confidence ↓')}${opt('confidence-asc', 'Confidence ↑')}` : nothing}
      ${this.showPriority ? html`${opt('priority-desc', 'Priority ↓')}${opt('priority-asc', 'Priority ↑')}` : nothing}
    </select>`
  }
}

customElements.define('findings-sort', FindingsSort)
