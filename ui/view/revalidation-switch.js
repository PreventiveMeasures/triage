// `<revalidation-switch>` — the toolbar's "App" toggle, which decides
// whether the findings on screen are about the running APP or about
// the CODE.
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
// Offered only where a report carries the `revalidate` field at all —
// a set without one is already the code view, so there is nothing to
// switch. The parent gates that on the RAW field (format.js
// hasRevalidateField), which is why the control survives being turned
// off: gating it on the layer's own reader would make it vanish the
// moment it was used, with no way back.
//
// Reactivity: extends StateElement, so the pressed state follows
// `state.showRevalidation` on its own. Light DOM, so the
// `revalidation-switch` rules in toolbar.css apply directly.
//
// Click dispatches a composed `revalidation-change(detail: { on })`;
// events.js writes the state and full-renders — the switch changes
// which rows exist, which filters are offered, and what every card
// draws, so nothing here is a local repaint.
import { classMap } from 'lit/directives/class-map.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { ensureHostAria } from './host-aria.js'

class RevalidationSwitch extends StateElement {
  createRenderRoot() { return this }

  connectedCallback() {
    super.connectedCallback()
    ensureHostAria(this, { role: 'group', 'aria-label': 'Revalidation layer' })
  }

  render() {
    const on = state.showRevalidation !== false
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
    return html`<button
      type="button"
      class=${classMap({ 'revalidation-toggle': true, on })}
      aria-pressed=${String(on)}
      aria-label="App view — hide the issues the revalidation pass ruled out"
      @click=${this._toggle}
    ><span>App</span><span class="revalidation-switch"></span></button>`
  }

  _toggle = () => {
    this.dispatchEvent(new CustomEvent('revalidation-change', {
      detail: { on: state.showRevalidation === false },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('revalidation-switch', RevalidationSwitch)
