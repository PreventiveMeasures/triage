import { SearchableSelector } from './searchable-selector.js'

class WorkspaceSelector extends SearchableSelector {
  constructor() { super(); this.label = 'Choose workspace'; this.placeholder = 'Choose workspace' }
  get searchLabel() { return 'Search workspaces' }
  get optionsLabel() { return 'Workspaces' }
  get noMatchesLabel() { return 'No matching workspaces' }
  get emptyLabel() { return 'No workspaces available' }
  get changeEvent() { return 'workspace-change' }
  choices() {
    const words = this._query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean)
    const options = this.options.filter(option => words.every(word => option.label.normalize('NFKC').toLocaleLowerCase().includes(word)))
      .toSorted((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }))
    return { pinned: [], sections: [{ label: null, options }], facets: [], showFacets: false, count: options.length, total: this.options.length }
  }
}

if (!customElements.get('workspace-selector')) customElements.define('workspace-selector', WorkspaceSelector)
