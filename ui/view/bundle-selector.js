import { css, html } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { SearchableSelector } from './searchable-selector.js'
import { BUNDLE_ICON_SVG, NPM_ICON_SVG } from './icons.js'
import { sourceMetrics } from '../scan/metrics.js'

// Match the format dispatch in bundle-load.js and the landing page's icons:
// .map files are sourcemaps; the other supported bundle format is Stasis.
// An npm package version (npm-package.js npmCompareSource) names its
// dist-tags as its detail.
export function bundleOptions(bundles) {
  return bundles.map(bundle => {
    const format = bundle.format === 'npm' ? 'npm'
      : ['sourcemap', 'sourcemaps'].includes(bundle.kind) || bundle.filename.toLowerCase().endsWith('.map') ? 'sourcemap' : 'stasis'
    const detail = format === 'npm' ? bundle.detail ?? '' : format === 'sourcemap' ? 'Sourcemap' : 'Stasis'
    const metadata = []
    if (typeof bundle.size === 'string' && !['', '—'].includes(bundle.size)) metadata.push(bundle.size)
    if (bundle.files) {
      metadata.push(`${bundle.files.length.toLocaleString()} files`)
      const { lines } = sourceMetrics(bundle.files)
      if (lines != null) metadata.push(`${lines.toLocaleString()} LoC`)
    } else if (bundle.summary) {
      if (Number.isSafeInteger(bundle.summary.files) && bundle.summary.files >= 0) metadata.push(`${bundle.summary.files.toLocaleString()} files`)
      if (Number.isSafeInteger(bundle.summary.lines) && bundle.summary.lines >= 0) metadata.push(`${bundle.summary.lines.toLocaleString()} LoC`)
    }
    return { value: bundle.id, label: bundle.filename, detail, format, secondary: metadata.join(' · ') }
  })
}

// `noun` names what it picks ('bundle' unless set); `ordered` keeps the
// options in the order given, as versions newest first, rather than by name.
class BundleSelector extends SearchableSelector {
  static properties = { bundles: { attribute: false }, noun: {}, ordered: { type: Boolean } }
  static styles = [SearchableSelector.styles, css`
    .bundle-icon { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 1.05rem; width: 1.05rem; height: 1.05rem; color: var(--muted); }
    .bundle-icon img, .bundle-icon svg { display: block; width: 100%; height: 100%; opacity: 1; }
    .option { gap: .5rem; padding-block: .25rem; }
    .option-copy { gap: 0; }
    .option .name { line-height: 1.3; }
    .option .bundle-icon { flex-basis: 1.35rem; width: 1.35rem; height: 1.35rem; margin-right: .15rem; }
    .secondary { line-height: 1.25; font-variant-numeric: tabular-nums; }
  `]

  constructor() { super(); this.bundles = []; this.noun = 'bundle'; this.ordered = false; this.label = 'Choose bundle'; this.placeholder = 'Choose bundle' }
  get searchLabel() { return `Search ${this.noun}s` }
  get optionsLabel() { return `${this.noun[0].toUpperCase()}${this.noun.slice(1)}s` }
  get noMatchesLabel() { return `No matching ${this.noun}s` }
  get emptyLabel() { return this.noun === 'bundle' ? 'No stored bundles' : `No other ${this.noun}s` }
  get changeEvent() { return 'bundle-change' }
  willUpdate(changed) { if (changed.has('bundles')) this.options = bundleOptions(this.bundles) }

  optionIcon(option) {
    return html`<span class="bundle-icon" aria-hidden="true">${option.format === 'npm' ? unsafeHTML(NPM_ICON_SVG)
      : option.format === 'sourcemap' ? unsafeHTML(BUNDLE_ICON_SVG) : html`<img src="./stasis.svg" alt="">`}</span>`
  }

  choices() {
    const words = this._query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean)
    const matching = this.options.filter(option => words.every(word => `${option.label} ${option.detail}`.normalize('NFKC').toLocaleLowerCase().includes(word)))
    const options = this.ordered ? matching : matching.toSorted((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }))
    return { pinned: [], sections: [{ label: null, options }], facets: [], showFacets: false, count: options.length, total: this.options.length }
  }
}

if (!customElements.get('bundle-selector')) customElements.define('bundle-selector', BundleSelector)
