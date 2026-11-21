// `<revalidation-switch>` — the toolbar's "App" control: whether the
// findings on screen are about the running APP or about the CODE, and how
// much of the app view's workings it shows. One bordered pill, as one
// decision in two parts:
//
// - The SWITCH is the app/code line. On (the default), a report carrying a
//   revalidation pass shows what the app can reach, re-rated; off, the
//   layer comes away (the pass's rows, stamps, verdicts and the outcome
//   dropdown), leaving every issue the analyzer found in the source.
//   Offered only where off would hand a finding back (`can-drop`, format.js
//   canDropRevalidation), gated by the parent on the RAW field so the
//   control survives being turned off.
// - The DETAIL icon is the line inside the app view: off, a re-examined
//   group shows the pass's row alone, the analyzer's own folded under it
//   (group.js drawnTabs) and the `+ Partial` chip with them; on, both come
//   back. Offered where the SET has something to unfold (`can-detail`,
//   render.js canDetailLayer); with the layer off it goes DISABLED rather
//   than away, so the pill keeps its width under the click.
// - The UPSTREAM lens narrows to upstream dependency findings, whatever the
//   switch says.
//
// Conflicting copies replace the App controls with an inspection button.
// Clicks dispatch `revalidation-change` / `revalidation-detail-change` /
// `upstream-only-change` (detail: { on }) and `revalidation-conflicts-open`;
// events.js writes the state and full-renders.
import { nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { html } from '@rray/frontend/state-element'
import { ToolbarControl } from './toolbar-control.js'
import { state } from '#client/index.js'

// Stacked plates — the pass's row on top, the analyzer's own underneath.
const DETAIL_GLYPH = html`<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
  <path d="M8 1.8 14.4 5 8 8.2 1.6 5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
  <path d="M2.6 8 8 10.7 13.4 8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M2.6 11 8 13.7 13.4 11" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

const DETAIL_LABEL = 'Show underlying code findings'

// One node connected to its upstream dependencies.
const UPSTREAM_GLYPH = html`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M3 5.5v2h10v-2M8 7.5v3"/>
  <rect x="1" y="1.5" width="4" height="4" rx=".6"/>
  <rect x="11" y="1.5" width="4" height="4" rx=".6"/>
  <rect x="6" y="10.5" width="4" height="4" rx=".6"/>
</svg>`

const UPSTREAM_LABEL = 'Show only upstream dependency findings'

class RevalidationSwitch extends ToolbarControl {
  static properties = {
    canDrop: { type: Boolean, attribute: 'can-drop' },
    canDetail: { type: Boolean, attribute: 'can-detail' },
    canUpstream: { type: Boolean, attribute: 'can-upstream' },
    upstreamDisabled: { type: Boolean, attribute: 'upstream-disabled' },
  }

  groupLabel = 'Revalidation layer'

  constructor() {
    super()
    this.canDrop = false
    this.canDetail = false
    this.canUpstream = false
    this.upstreamDisabled = false
  }

  render() {
    const conflicts = state.revalidateConflicts.size
    const conflictButton = conflicts > 0 ? html`<button type="button"
        class="revalidation-toggle revalidation-conflicts"
        aria-haspopup="dialog"
        aria-label=${`View ${conflicts} revalidation conflict${conflicts === 1 ? '' : 's'}`}
        @click=${() => this.emit('revalidation-conflicts-open')}
      >${conflicts} ${conflicts === 1 ? 'conflict' : 'conflicts'}</button>` : nothing
    const on = state.showRevalidation !== false
    // Lit only while the layer is on: off, every row the pass re-rated is
    // already on the strip.
    const detailed = on && state.revalidationDetailed === true
    // The upstream lens bypasses both halves before it (the switch only
    // drops the pass's own rows, never upstream; detail only unfolds under
    // a pass row), so while it is on they go inert, their state kept to be
    // handed back unchanged.
    const upstreamOnly = state.upstreamOnly === true
    const upstreamActive = upstreamOnly && !this.upstreamDisabled
    // The switch is a `<mode-switch>`, not a chip: it changes what the list
    // is about rather than narrowing it. No `title`s: `aria-label` names
    // what is pressed, and the native tooltip isn't this app's.
    return html`${conflictButton}${conflicts === 0 && this.canDrop
      ? html`<mode-switch
          class="revalidation-toggle"
          label="App" borderless
          .checked=${on}
          accessible-label="App view — hide the issues the revalidation pass ruled out"
          .disabled=${upstreamOnly}
          @click=${() => this.emit('revalidation-change', { on: state.showRevalidation === false })}
        ></mode-switch>`
      : nothing}${conflicts === 0 && this.canDrop && this.canDetail
      ? html`<button
          type="button"
          class=${classMap({ 'revalidation-detail': true, on: detailed })}
          aria-pressed=${String(detailed)}
          aria-label=${DETAIL_LABEL}
          data-tooltip=${DETAIL_LABEL}
          ?disabled=${!on || upstreamOnly}
          @click=${() => this.emit('revalidation-detail-change', { on: state.revalidationDetailed !== true })}
        >${DETAIL_GLYPH}</button>`
      : nothing}${this.canUpstream
      ? html`<button
          type="button"
          class=${classMap({ 'revalidation-upstream': true, on: upstreamActive })}
          aria-pressed=${String(upstreamActive)}
          aria-label=${UPSTREAM_LABEL}
          data-tooltip=${UPSTREAM_LABEL}
          ?disabled=${this.upstreamDisabled}
          @click=${() => { if (!this.upstreamDisabled) this.emit('upstream-only-change', { on: state.upstreamOnly !== true }) }}
      >${UPSTREAM_GLYPH}</button>`
      : nothing}`
  }
}

customElements.define('revalidation-switch', RevalidationSwitch)
