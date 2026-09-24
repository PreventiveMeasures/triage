import { css, html, nothing } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { SearchableSelector } from './searchable-selector.js'
import { BUNDLE_ICON_SVG } from './icons.js'
import { sourceMetrics } from '../scan/metrics.js'

// Match the format dispatch in bundle-load.js and the landing page's icons:
// .map files are sourcemaps; the other supported bundle format is Stasis.
export function bundleOptions(bundles) {
  return bundles.map(bundle => {
    const format = bundle.filename.toLowerCase().endsWith('.map') ? 'sourcemap' : 'stasis'
    const detail = format === 'sourcemap' ? 'Sourcemap' : 'Stasis'
    const metadata = []
    if (typeof bundle.size === 'string' && !['', '—'].includes(bundle.size)) metadata.push(bundle.size)
    if (bundle.files) {
      metadata.push(`${bundle.files.length.toLocaleString()} files`)
      const { lines } = sourceMetrics(bundle.files)
      if (lines != null) metadata.push(`${lines.toLocaleString()} LoC`)
    }
    return { value: bundle.id, label: bundle.filename, detail, format, secondary: metadata.join(' · ') }
  })
}

class BundleSelector extends SearchableSelector {
  static properties = { bundles: { attribute: false } }
  static styles = [SearchableSelector.styles, css`
    .bundle-icon { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 1.05rem; width: 1.05rem; height: 1.05rem; color: var(--muted); }
    .bundle-icon img, .bundle-icon svg { display: block; width: 100%; height: 100%; opacity: 1; }
    .option { gap: .5rem; padding-block: .25rem; }
    .option-copy { gap: 0; }
    .option .name { line-height: 1.3; }
    .option .bundle-icon { flex-basis: 1.35rem; width: 1.35rem; height: 1.35rem; margin-right: .15rem; }
    .secondary { line-height: 1.25; font-variant-numeric: tabular-nums; }
  `]

  constructor() { super(); this.bundles = []; this.label = 'Choose bundle'; this.placeholder = 'Choose bundle' }
  get searchLabel() { return 'Search bundles' }
  get optionsLabel() { return 'Bundles' }
  get noMatchesLabel() { return 'No matching bundles' }
  get emptyLabel() { return 'No stored bundles' }
  get changeEvent() { return 'bundle-change' }
  willUpdate(changed) { if (changed.has('bundles')) this.options = bundleOptions(this.bundles) }

  optionIcon(option) {
    return html`<span class="bundle-icon" aria-hidden="true">${option.format === 'sourcemap' ? unsafeHTML(BUNDLE_ICON_SVG) : html`<img src="./stasis.svg" alt="">`}</span>`
  }
  optionTitle(_option) { return nothing }

  choices() {
    const words = this._query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean)
    const options = this.options.filter(option => words.every(word => `${option.label} ${option.detail}`.normalize('NFKC').toLocaleLowerCase().includes(word)))
      .toSorted((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }))
    return { pinned: [], sections: [{ label: null, options }], facets: [], showFacets: false, count: options.length, total: this.options.length }
  }
}

if (!customElements.get('bundle-selector')) customElements.define('bundle-selector', BundleSelector)
