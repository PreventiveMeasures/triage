import { SearchableSelector } from './searchable-selector.js'
import { userChoices, userOptions } from './user-options.js'

class UserSelector extends SearchableSelector {
  static properties = { users: { attribute: false } }
  constructor() { super(); this.users = []; this.label = 'Choose user'; this.placeholder = 'Choose user' }
  get searchLabel() { return 'Search users' }
  get optionsLabel() { return 'Users' }
  get noMatchesLabel() { return 'No matching users' }
  get emptyLabel() { return 'No users available' }
  get changeEvent() { return 'user-change' }
  willUpdate(changed) { if (changed.has('users')) this.options = userOptions(this.users) }
  choices() { return userChoices(this.options, this._query) }
}

if (!customElements.get('user-selector')) customElements.define('user-selector', UserSelector)
