import { css, html, nothing } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { SearchableSelector } from './searchable-selector.js'
import { BUNDLE_ICON_SVG, NPM_ICON_SVG } from './icons.js'
import { sourceMetrics } from '../scan/metrics.js'

// Match the format dispatch in bundle-load.js and the landing page's icons:
// .map files are sourcemaps; the other supported bundle format is Stasis.
// An npm package version (npm-package.js npmCompareSource) names its
// dist-tags as its detail, and its number alone as `displayLabel`, how the
// list names it.
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
    return { value: bundle.id, label: bundle.filename, displayLabel: bundle.displayLabel, detail, format, secondary: metadata.join(' · ') }
  })
}

// What the list names an option.
const shownLabel = option => option.displayLabel ?? option.label

// `noun` names what it picks ('bundle' unless set). With `versions`, the
// options keep the order given (newest first) and sit several to a row, a
// version's tags beside it, or under it where they don't fit. Options come
// from `bundles` (bundleOptions) or as `options`; one with no format has no icon.
class BundleSelector extends SearchableSelector {
  static properties = { bundles: { attribute: false }, noun: {}, versions: { type: Boolean, reflect: true } }
  static styles = [SearchableSelector.styles, css`
    .bundle-icon { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 1.05rem; width: 1.05rem; height: 1.05rem; color: var(--muted); }
    /* The icon keeps its muted color in the list: the base selector colors an
       option's svg, its check mark, with the accent. */
    .bundle-icon img, .bundle-icon svg { display: block; width: 100%; height: 100%; opacity: 1; color: inherit; }
    .option { gap: .5rem; padding-block: .25rem; }
    .option-copy { gap: 0; }
    .option .name { line-height: 1.3; }
    .option .bundle-icon { flex-basis: 1.35rem; width: 1.35rem; height: 1.35rem; margin-right: .15rem; }
    .secondary { line-height: 1.25; font-variant-numeric: tabular-nums; }
    :host([versions]) .group {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, calc(var(--option-width, 6ch) + 1rem)), 1fr)); gap: .1rem;
      font-size: .76rem;
    }
    :host([versions]) .option { flex-wrap: wrap; align-content: start; gap: 0 .4rem; padding: .3rem .45rem; font-variant-numeric: tabular-nums; }
    :host([versions]) .option > svg, :host([versions]) .option .bundle-icon { display: none; }
    :host([versions]) .option-copy { flex: 0 1 auto; }
    :host([versions]) .option .detail { font-size: .62rem; line-height: 1.6; }
  `]

  constructor() {
    super()
    this.bundles = null; this.noun = 'bundle'; this.versions = false; this.label = 'Choose bundle'; this.placeholder = 'Choose bundle'
  }

  get searchLabel() { return `Search ${this.noun}s` }
  get optionsLabel() { return `${this.noun[0].toUpperCase()}${this.noun.slice(1)}s` }
  get noMatchesLabel() { return `No matching ${this.noun}s` }
  get emptyLabel() { return this.noun === 'bundle' ? 'No stored bundles' : `No other ${this.noun}s` }
  get changeEvent() { return 'bundle-change' }
  get menuWidth() { return this.versions ? 500 : super.menuWidth }
  willUpdate(changed) {
    if (changed.has('bundles') && this.bundles) this.options = bundleOptions(this.bundles)
    if (changed.has('options') && this.versions) {
      const longest = this.options.reduce((most, option) => Math.max(most, shownLabel(option).length), 0)
      this.style.setProperty('--option-width', `${Math.min(longest, 28)}ch`)
    }
  }

  optionTooltip(option) { return shownLabel(option) }

  optionIcon(option) {
    if (!option.format) return nothing
    return html`<span class="bundle-icon" aria-hidden="true">${option.format === 'npm' ? unsafeHTML(NPM_ICON_SVG)
      : option.format === 'sourcemap' ? unsafeHTML(BUNDLE_ICON_SVG) : html`<img src="./stasis.svg" alt="">`}</span>`
  }

  choices() {
    const words = this._query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean)
    const matching = this.options.filter(option => words.every(word => `${option.label} ${option.detail}`.normalize('NFKC').toLocaleLowerCase().includes(word)))
    const options = this.versions ? matching : matching.toSorted((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }))
    return { pinned: [], sections: [{ label: null, options }], facets: [], showFacets: false, count: options.length, total: this.options.length }
  }
}

if (!customElements.get('bundle-selector')) customElements.define('bundle-selector', BundleSelector)
