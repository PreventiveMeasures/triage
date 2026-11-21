// Findings adapter: the shared selector owns presentation; this component
// keeps the existing filter state and repo-change event contract.
import { html } from '@rray/frontend/state-element'
import { ToolbarControl } from './toolbar-control.js'
import { state } from '#client/index.js'
import { NO_REPO_SENTINEL } from './filters.js'
import { prettyRepoLabel } from './format.js'
import './repository-selector.js'

class RepoFilter extends ToolbarControl {
  static properties = { options: { attribute: false } }
  constructor() { super(); this.options = [] }

  render() {
    const options = [
      { value: '', label: 'All repositories', special: true, reset: true },
      ...this.options.map(repo => ({ value: repo ?? NO_REPO_SENTINEL, label: repo == null ? '(no repo)' : prettyRepoLabel(repo), special: repo == null })),
    ]
    return html`<repository-selector variant="filter" label="Filter by repository"
      .options=${options} .value=${state.filterRepo}
      @repository-change=${event => this.emit('repo-change', { value: event.detail.value })}></repository-selector>`
  }
}

customElements.define('repo-filter', RepoFilter)
