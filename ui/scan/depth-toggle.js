import { LitElement, css, html, nothing } from 'lit'

const LIST_ICON = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4h7M6 8h7M6 12h7M3 4h.01M3 8h.01M3 12h.01"/></svg>`
const ISOLATE_ICON = html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3M7 5v4M5 7h4"/></svg>`

export class ScanDepthToggle extends LitElement {
  static properties = { isolate: { type: Boolean }, vertical: { type: Boolean, reflect: true } }
  constructor() { super(); this.isolate = false; this.vertical = false }
  _select(isolate) {
    if (this.isolate === isolate) return
    this.isolate = isolate
    this.dispatchEvent(new CustomEvent('depth-change', { detail: { isolate }, bubbles: true, composed: true }))
  }
  render() {
    return html`<div class="scan-depth">
      <div class="depth-options" role="radiogroup" aria-label="Scan depth" aria-orientation=${this.vertical ? 'vertical' : 'horizontal'} aria-describedby=${this.vertical ? nothing : 'scan-depth-description'}>
        ${[[false, 'List', LIST_ICON], [true, 'Isolate', ISOLATE_ICON]].map(([value, label, icon]) => html`<label class="depth-choice"><input type="radio" name="scan-depth" value=${value ? 'isolate' : 'list'} .checked=${this.isolate === value} @change=${() => this._select(value)}><span>${icon}${label}</span></label>`)}
      </div>
      ${this.vertical ? nothing : html`<div class="depth-description" id="scan-depth-description" aria-live="polite"><span class=${this.isolate ? 'inactive' : ''} aria-hidden=${this.isolate}>Regular scan depth</span><span class=${this.isolate ? '' : 'inactive'} aria-hidden=${!this.isolate}>Deeper search at ~10x the tokens spent</span></div>`}
    </div>`
  }
  static styles = css`
    :host { display: block; width: 19rem; max-width: 100%; min-width: 0; }
    * { box-sizing: border-box; }
  .scan-depth { display: grid; gap: .4rem; width: 100%; min-width: 0; user-select: none; }
  .depth-options { display: flex; position: relative; padding: .2rem; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); }
  .depth-options::before { content: ''; position: absolute; inset: .2rem auto .2rem .2rem; width: calc((100% - .4rem) / 2); border-radius: 5px; background: var(--surface-active); box-shadow: 0 1px 3px rgb(0 0 0 / .12), inset 0 0 0 1px rgb(from var(--accent) r g b / .18); transition: transform .16s ease-out; }
  .depth-options:has(input[value=isolate]:checked)::before { transform: translateX(100%); }
  .depth-choice { position: relative; flex: 1; min-width: 0; }
  .depth-choice input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .depth-choice span { display: flex; align-items: center; justify-content: center; gap: .4rem; height: 1.9rem; padding: .3rem .65rem; border-radius: 5px; color: var(--muted); font-size: .76rem; font-weight: 500; transition: color .12s; }
  .depth-choice svg { width: .95rem; height: .95rem; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
  .depth-choice:hover span { color: var(--text); }
  .depth-choice input:checked + span { color: var(--accent); }
  .depth-choice input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: -2px; }
  .depth-description { display: grid; color: var(--muted); font-size: .68rem; line-height: 1.4; }
  .depth-description span { grid-area: 1 / 1; }
  .depth-description .inactive { visibility: hidden; }
  @media (prefers-reduced-motion: reduce) { .depth-options::before, .depth-choice span { transition: none; } }
    :host([vertical]) { width: 5.8rem; }
    :host([vertical]) .depth-options { flex-direction: column; }
    :host([vertical]) .depth-options::before { inset: .2rem .2rem auto; width: auto; height: calc((100% - .4rem) / 2); }
    :host([vertical]) .depth-options:has(input[value=isolate]:checked)::before { transform: translateY(100%); }
    :host([vertical]) .depth-choice span { justify-content: flex-start; height: 1.7rem; padding: .25rem .5rem; font-size: .72rem; }
  `
}
if (!customElements.get('scan-depth-toggle')) customElements.define('scan-depth-toggle', ScanDepthToggle)
