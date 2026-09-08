// `<revalidation-switch>` — the toolbar's "App" control, which decides
// whether the findings on screen are about the running APP or about
// the CODE, and how much of the app view's workings it shows.
//
// Two halves, ONE pill. The SWITCH is the app/code line. The DETAIL
// icon flush against it is the line inside the app view: off (the
// default, and off again for every new reader), a group the pass
// re-examined shows the pass's row and nothing else — the analyzer's
// own rows are folded under it (group.js drawnTabs) and the `+ Partial`
// chip inside the Confirmed outcome goes with them, since the stamps
// it sorts by ride rows no longer on screen. On, both come back: the
// app view with its workings, which is what the switch alone used to
// mean.
//
// They share one bordered shell because they are one decision in two
// parts — how much of the pass's account of the code the reader wants
// — and two floating pills at the end of the row read as two unrelated
// controls. The divider between them is the same one `source-filter`
// and the severity lens draw between their chips.
//
// A switch and an icon rather than a three-stop switch: the switch
// answers what the list is ABOUT, and detail doesn't change that
// answer — it says how much of the pass's working the same view
// shows. It is also the only one of the two that is purely a display
// choice, so it stays a lit-or-not glyph rather than a control that
// looks like it filters.
//
// A report that carries a revalidation pass has been through a second
// look: what the app can actually reach, re-rated. On (the default),
// that is what the list shows. Off, the layer comes away — the pass's
// own rows, its stamps and verdicts, and the outcome dropdown that
// filtered by them — and what is left is every issue the analyzer
// found in the source, including the ones this app happens not to
// expose. Those are still real, and someone auditing the code wants
// them back; one switch is a better answer than undoing each
// consequence of the pass by hand.
//
// The SWITCH half is offered only where taking the layer off would
// actually hand a finding back — where the pass stamped something it
// JUDGED, not just its own `revalidation` rows (format.js
// canDropRevalidation). A set without a `revalidate` anywhere is
// already the code view; one whose only stamps are the pass's own rows
// has nothing the pass ruled out to give back, so "off" there would
// just take those rows away and call the result the code, which is
// worse than not offering the switch. The parent gates on the RAW
// field, which is why the control survives being turned off: gating it
// on the layer's own reader would make it vanish the moment it was
// used, with no way back.
//
// The DETAIL half is offered where the app view is folding rows or
// holding the partial line back (render.js canDetailLayer) — asked of
// the loaded SET, not of the view currently drawn. With the layer off
// it has nothing to unfold, and it goes DISABLED rather than away: a
// control that disappears under the click that made it useless takes
// the width of the row with it, and everything to the left of it
// jumps. Both flags are properties of the set, so the pill keeps its
// shape for as long as the reader is looking at one.
//
// Reactivity: extends StateElement, so both halves follow
// `state.showRevalidation` / `state.revalidationDetailed` on their own.
// Light DOM, so the `revalidation-switch` rules in toolbar.css apply
// directly.
//
// Clicks dispatch composed `revalidation-change(detail: { on })` /
// `revalidation-detail-change(detail: { on })`; events.js writes the
// state and full-renders — either one changes which rows the cards
// draw and which filters the toolbar offers, so nothing here is a
// local repaint.
import { nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { ensureHostAria } from './host-aria.js'

// Stacked plates — the pass's row on top, the analyzer's own rows
// underneath it. Lit, they are on the strip; unlit, the top plate
// speaks for them. Inlined like the annotation-filter glyphs so this
// toolbar control stays a light StateElement.
const DETAIL_GLYPH = html`<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
  <path d="M8 1.8 14.4 5 8 8.2 1.6 5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
  <path d="M2.6 8 8 10.7 13.4 8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M2.6 11 8 13.7 13.4 11" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

const DETAIL_LABEL = 'Show underlying code findings'

class RevalidationSwitch extends StateElement {
  static properties = {
    canDrop: { type: Boolean, attribute: 'can-drop' },
    canDetail: { type: Boolean, attribute: 'can-detail' },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.canDrop = false
    this.canDetail = false
  }

  connectedCallback() {
    super.connectedCallback()
    ensureHostAria(this, { role: 'group', 'aria-label': 'Revalidation layer' })
  }

  render() {
    const on = state.showRevalidation !== false
    // Lit only while the layer is on: with it off, every row the pass
    // re-rated is already on the strip, and a lit glyph would claim
    // credit for a view the switch beside it is drawing.
    const detailed = on && state.revalidationDetailed === true
    // A SWITCH, not a chip: this doesn't narrow the list the way the
    // filters beside it do, it changes what the list is about — and a
    // switch is the control that says a thing is either on or off,
    // rather than one more pill that happens to be lit. Same shape as
    // the Graph tab's "All files" and the bundle search's "Context"
    // (toolbar.css has the rules and the note on why each place keeps
    // its own copy).
    //
    // `aria-pressed` carries the state, and the label says what is
    // being pressed — no `title`, which would only repeat the word
    // under the cursor and never reaches a keyboard or a touch.
    return html`${this.canDrop
      ? html`<button
          type="button"
          class=${classMap({ 'revalidation-toggle': true, on })}
          aria-pressed=${String(on)}
          aria-label="App view — hide the issues the revalidation pass ruled out"
          @click=${this._toggle}
        ><span>App</span><span class="revalidation-switch"></span></button>`
      : nothing}${this.canDetail
      ? html`<button
          type="button"
          class=${classMap({ 'revalidation-detail': true, on: detailed })}
          aria-pressed=${String(detailed)}
          aria-label=${DETAIL_LABEL}
          data-tooltip=${DETAIL_LABEL}
          ?disabled=${!on}
          @click=${this._toggleDetail}
        >${DETAIL_GLYPH}</button>`
      : nothing}`
  }

  _toggle = () => {
    this.dispatchEvent(new CustomEvent('revalidation-change', {
      detail: { on: state.showRevalidation === false },
      bubbles: true,
      composed: true,
    }))
  }

  _toggleDetail = () => {
    this.dispatchEvent(new CustomEvent('revalidation-detail-change', {
      detail: { on: state.revalidationDetailed !== true },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('revalidation-switch', RevalidationSwitch)
