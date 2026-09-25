import { SearchableSelector } from './searchable-selector.js'

class ReportSelector extends SearchableSelector {
  constructor() { super(); this.label = 'Choose report'; this.placeholder = 'Choose report' }
  get searchLabel() { return 'Search reports' }
  get optionsLabel() { return 'Reports' }
  get noMatchesLabel() { return 'No matching reports' }
  get emptyLabel() { return 'No reports available' }
  get changeEvent() { return 'report-change' }
  choices() {
    const words = this._query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean)
    const reports = this.options.filter(option => !option.reset)
    const options = reports.filter(option => words.every(word => option.label.normalize('NFKC').toLocaleLowerCase().includes(word)))
      .toSorted((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }))
    return { pinned: this.options.filter(option => option.reset), sections: [{ label: null, options }], showFacets: false, count: options.length, total: reports.length }
  }
}

if (!customElements.get('report-selector')) customElements.define('report-selector', ReportSelector)
