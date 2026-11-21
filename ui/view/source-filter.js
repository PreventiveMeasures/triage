// `<source-filter>` — the `Sources` / `Deps` chip pair narrowing the
// findings to own source or node_modules. Single-select with toggle-off:
// clicking the active chip clears the filter. Click dispatches
// `source-toggle(detail: { source })`; events.js applies it to the
// `state.filterSources` Set (a Set keeps filters.js's `size === 1` test).
import { classMap } from 'lit/directives/class-map.js'
import { html } from '@rray/frontend/state-element'
import { ToolbarControl } from './toolbar-control.js'
import { state } from '#client/index.js'

const SOURCES = [
  ['own',     'Sources'],
  ['modules', 'Deps'],
]

class SourceFilter extends ToolbarControl {
  groupLabel = 'Source filter'

  render() {
    return html`${SOURCES.map(([value, label]) => {
      const active = state.filterSources.has(value)
      return html`<button
        type="button"
        class=${classMap({ 'source-chip': true, active })}
        aria-pressed=${String(active)}
        @click=${() => this.emit('source-toggle', { source: value })}
      >${label}</button>`
    })}`
  }
}

customElements.define('source-filter', SourceFilter)
