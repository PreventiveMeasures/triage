// Findings adapter: the shared selector owns presentation; this component
// keeps the existing filter state and repo-change event contract.
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { NO_REPO_SENTINEL } from './filters.js'
import { prettyRepoLabel } from './format.js'
import './repository-selector.js'

class RepoFilter extends StateElement {
  static properties = { options: { attribute: false } }
  createRenderRoot() { return this }
  constructor() { super(); this.options = [] }

  render() {
    const options = [
      { value: '', label: 'All repositories', special: true, reset: true },
      ...this.options.map(repo => ({ value: repo ?? NO_REPO_SENTINEL, label: repo == null ? '(no repo)' : prettyRepoLabel(repo), special: repo == null })),
    ]
    return html`<repository-selector variant="filter" label="Filter by repository"
      .options=${options} .value=${state.filterRepo}
      @repository-change=${event => this.dispatchEvent(new CustomEvent('repo-change', {
        detail: { value: event.detail.value }, bubbles: true, composed: true,
      }))}></repository-selector>`
  }
}

customElements.define('repo-filter', RepoFilter)
