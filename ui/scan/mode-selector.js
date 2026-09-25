import { LitElement, html, nothing, unsafeCSS } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { AGENTIC_ICON_SVG, CODE_ICON_SVG, DEPENDENCIES_ICON_SVG, REPORT_ICON_SVG } from '../view/icons.js'
import styles from './mode-selector.css'

const MODES = [
  { id: 'code', label: 'Code', detail: 'Run a full scan of the codebase', icon: CODE_ICON_SVG },
  { id: 'dependencies', label: 'Dependency alerts', detail: 'Revalidate incoming alerts against actual code', icon: DEPENDENCIES_ICON_SVG },
  { id: 'agentic', label: 'Agentic', detail: 'Free-form analysis with your instructions', icon: AGENTIC_ICON_SVG },
  { id: 'report', label: 'Reports', detail: 'Link saved reports or merge scan results', icon: REPORT_ICON_SVG },
]
const FOCUSES = [
  { id: 'generic', label: 'Generic', detail: 'Free-form code scan: wide-scoped, most results' },
  { id: 'security', label: 'Security', detail: 'Security findings only' },
  { id: 'correctness', label: 'Correctness', detail: 'Guided correctness scan' },
  { id: 'advanced', label: 'Advanced', detail: 'Merge multiple regimes' },
]
const REPORT_MODES = [
  { id: 'link', label: 'Link', detail: 'Link findings across saved reports' },
  { id: 'merge', label: 'Merge', detail: 'Combine scan results for one bundle' },
]

// The host owns scan settings. Native radio groups provide keyboard navigation.
export class ScanModeSelector extends LitElement {
  static properties = { mode: {}, analyzer: {}, reportMode: {} }
  static styles = unsafeCSS(styles)

  constructor() {
    super()
    this.mode = 'code'
    this.analyzer = 'generic'
    this.reportMode = 'link'
  }

  _choose(event, detail) {
    this.dispatchEvent(new CustomEvent(event, { detail, bubbles: true, composed: true }))
  }

  render() {
    const code = this.mode === 'code'
    const report = this.mode === 'report'
    const options = code ? FOCUSES : REPORT_MODES
    const value = code ? this.analyzer : this.reportMode
    return html`<section aria-labelledby="mode-heading">
      <header><h2 id="mode-heading">Scan mode</h2><span>Choose what the server should analyze</span></header>
      <fieldset class="modes"><legend class="sr-only">Scan mode</legend>
        ${MODES.map(option => html`<label class="mode">
          <input type="radio" name="scan-mode" .checked=${this.mode === option.id} aria-label=${option.label}
            @change=${() => this._choose('scan-mode-change', { mode: option.id })}>
          <span class="mode-icon" aria-hidden="true">${unsafeHTML(option.icon)}</span>
          <span class="mode-copy"><strong>${option.label}</strong><span>${option.detail}</span></span>
          <span class="indicator" aria-hidden="true"></span>
        </label>`)}
      </fieldset>
      ${code || report ? html`<div class="subtype-wrap">
        <fieldset class=${`subtype-options ${report ? 'report-subtypes' : ''}`}><legend class="sr-only">${code ? 'Code subtype' : 'Reports submode'}</legend>
          ${options.map(option => html`<label class="subtype-option"><input type="radio" name="scan-focus" .checked=${value === option.id} aria-label=${option.label}
            @change=${() => code ? this._choose('scan-analyzer-change', { analyzer: option.id }) : this._choose('scan-report-mode-change', { mode: option.id })}>
            <strong>${option.label}</strong><span>${option.detail}</span></label>`)}
        </fieldset>
        ${code ? html`<p class="subtype-help">Focusing controls how effort is spent: while Generic can also find security issues, a focused Security scan is likely to find more.</p>` : nothing}
      </div>` : nothing}
    </section>`
  }
}
if (!customElements.get('scan-mode-selector')) customElements.define('scan-mode-selector', ScanModeSelector)
