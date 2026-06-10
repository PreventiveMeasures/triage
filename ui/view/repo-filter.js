// `<repo-filter>` — toolbar dropdown that filters findings to a
// single repository. Only meaningful in workspace view (merged
// findings across multiple reports tend to span multiple repos);
// the parent gates rendering on `state.currentWorkspace` and on
// the option list having more than one repo to choose between.
//
// Native single-select dropdown with an implicit "All repositories"
// entry, plus an explicit `(no repo)` bucket for findings whose repo
// can't be derived (no `repo.github` and no `_repoFallback` URL). The
// `(no repo)` value rides `NO_REPO_SENTINEL` (a control character) so
// it can't collide with a legitimate repo slug. (`<analyzer-select>`
// used to share this exact shape before it grew the two-dimension
// popover panel; this component remains the reference for the plain
// native-select pattern.)
//
// Reactivity: extends StateElement, so reads of `state.filterRepo`
// during render() are tracked. `live()` binds the native select's
// value so a stale-filter clear in the parent (workspace switch
// drops the previously-selected repo) reflects on the actual
// select.value, not just the `?selected` attribute.
//
// Dispatches `repo-change(detail.value)` on native change.
import { live } from 'lit/directives/live.js'
import { StateElement, html } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { NO_REPO_SENTINEL } from './filters.js'

function prettyRepoLabel(s) {
  if (!s) return ''
  const m = s.match(/github\.com\/([^/?#]+\/[^/?#]+?)(?:\.git)?(?:[/?#]|$)/iu)
  return m ? m[1] : s
}

class RepoFilter extends StateElement {
  static properties = {
    options: { attribute: false },
  }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.options = []
  }

  render() {
    return html`<select
      class="sort-select"
      aria-label="Filter by repository"
      .value=${live(state.filterRepo)}
      @change=${this._onChange}
    >
      <option value="">All repositories</option>
      ${this.options.map((r) => {
        const value = r == null ? NO_REPO_SENTINEL : r
        const label = r == null ? '(no repo)' : prettyRepoLabel(r)
        return html`<option value=${value}>${label}</option>`
      })}
    </select>`
  }

  _onChange = (e) => {
    this.dispatchEvent(new CustomEvent('repo-change', {
      detail: { value: e.target.value },
      bubbles: true,
      composed: true,
    }))
  }
}

customElements.define('repo-filter', RepoFilter)
