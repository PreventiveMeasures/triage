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
// during render() are tracked. The selection is bound twice, same
// split as `<findings-sort>` (see the comment there for the full
// reasoning): `?selected=` on the options so the FIRST paint of a
// freshly-built element shows the repo actually being filtered on —
// Lit commits the `<select>`'s own bindings before its options
// exist, so `.value=` alone leaves the browser falling back to
// "All repositories" while the filter is live, which a cross-view
// round trip (the findings chrome is rebuilt from `report.innerHTML`
// on re-entry) hits with any repo picked. `.value=` through `live()`
// covers every later render: a stale-filter clear in the parent (a
// workspace switch dropping the previously-selected repo) has to
// reach the native select.value, since the attribute is ignored on
// an option the user has already interacted with.
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
      <option value="" ?selected=${state.filterRepo === ''}>All repositories</option>
      ${this.options.map((r) => {
        const value = r == null ? NO_REPO_SENTINEL : r
        const label = r == null ? '(no repo)' : prettyRepoLabel(r)
        return html`<option value=${value} ?selected=${state.filterRepo === value}>${label}</option>`
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
