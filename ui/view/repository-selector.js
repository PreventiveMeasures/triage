import { SearchableSelector } from './searchable-selector.js'
import { repositoryChoices } from './repository-options.js'

// Shared by Findings and Manage. Values stay opaque: numeric managed IDs,
// local repository URLs, and the no-repository sentinel all round-trip intact.
class RepositorySelector extends SearchableSelector {
  constructor() { super(); this.label = 'Choose repository'; this.placeholder = 'Choose repository' }
  get searchLabel() { return 'Search repositories' }
  get optionsLabel() { return 'Repositories' }
  get facetLabel() { return 'Filter by organization' }
  get allFacetsLabel() { return 'All organizations' }
  get noMatchesLabel() { return 'No matching repositories' }
  get emptyLabel() { return 'No repositories available' }
  get changeEvent() { return 'repository-change' }
  choices() { return repositoryChoices(this.options, this._query, this._facet) }
}

// Both entry points can load this stateless component in the same document.
if (!customElements.get('repository-selector')) customElements.define('repository-selector', RepositorySelector)
