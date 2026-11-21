import { SearchableSelector } from './searchable-selector.js'

class WorkspaceSelector extends SearchableSelector {
  constructor() { super(); this.label = 'Choose workspace'; this.placeholder = 'Choose workspace' }
  get searchLabel() { return 'Search workspaces' }
  get optionsLabel() { return 'Workspaces' }
  get noMatchesLabel() { return 'No matching workspaces' }
  get emptyLabel() { return 'No workspaces available' }
  get changeEvent() { return 'workspace-change' }
}

if (!customElements.get('workspace-selector')) customElements.define('workspace-selector', WorkspaceSelector)
