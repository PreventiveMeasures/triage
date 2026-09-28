import { css, html, nothing } from 'lit'
import { keyed } from 'lit/directives/keyed.js'
import { getPreviewRole } from '../../client/managed/request.js'
import { SearchableSelector } from './searchable-selector.js'
import { userChoices, userOptions } from './user-options.js'

class UserSelector extends SearchableSelector {
  static properties = { users: { attribute: false }, resetLabel: { type: String, attribute: 'reset-label' } }
  static styles = [SearchableSelector.styles, css`
    .avatar { position: relative; overflow: hidden; }
    .avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  `]
  constructor() { super(); this.users = []; this.resetLabel = ''; this.label = 'Choose user'; this.placeholder = 'Choose user' }
  get searchLabel() { return 'Search users' }
  get optionsLabel() { return 'Users' }
  get noMatchesLabel() { return 'No matching users' }
  get emptyLabel() { return 'No users available' }
  get changeEvent() { return 'user-change' }
  willUpdate(changed) {
    if (changed.has('users') || changed.has('resetLabel')) {
      this.options = [
        ...this.resetLabel ? [{ value: '', label: this.resetLabel, reset: true }] : [],
        ...userOptions(this.users),
      ]
    }
  }
  choices() { return userChoices(this.options, this._query) }
  optionIcon(option) {
    if (!option.initials) return nothing
    return html`<span class="avatar" aria-hidden="true">${option.initials}${getPreviewRole() ? nothing : keyed(option.value, html`
      <img alt="" loading="lazy" decoding="async" src=${`/api/avatar/${encodeURIComponent(option.value)}`}
        @error=${event => { event.currentTarget.hidden = true }}>
    `)}</span>`
  }
}

if (!customElements.get('user-selector')) customElements.define('user-selector', UserSelector)
