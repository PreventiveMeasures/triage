import { html, nothing, unsafeCSS } from 'lit'
import { sourceFileIcon } from '../view/source-file-icon.js'
import styles from './styles/create-bundle.css'
import { packageEntryPointSuggestions, solidityEntryPointSuggestions } from './package-entry-points.js'
import { defaultBundleConditions } from './bundle-conditions.js'
import { RepositoryBrowser } from './repository-browser.js'

// Create a bundle: files of a repository's directories at a revision, picked
// as entry points (RepositoryBrowser), built with Stasis.
export class ManagedCreateBundle extends RepositoryBrowser {
  static styles = [...RepositoryBrowser.styles, unsafeCSS(styles)]
  static properties = {
    ...RepositoryBrowser.properties,
    createBundle: { attribute: false }, _building: { state: true }, _opening: { state: true }, _buildError: { state: true },
    _selected: { state: true },
    _packageEntryPoints: { state: true },
    _solidityEntryPoints: { state: true }, _soliditySuggestionsLimited: { state: true },
  }

  constructor() {
    super()
    this._building = false
    this._opening = false
    this._buildError = ''
    this._selected = new Set()
    this._dismissedSuggestions = new Set()
    this._bundleConditions = defaultBundleConditions()
    this._packageEntryPoints = []
    this._solidityEntryPoints = []
    this._soliditySuggestionsLimited = false
  }

  disconnectedCallback() {
    this._buildRequest?.abort()
    this._opening = false
    this._dismissedSuggestions.clear()
    this.showDirectory(null)
    super.disconnectedCallback()
  }

  resetFiles() {
    this._buildError = ''
    super.resetFiles()
    this._selected = new Set()
    this._dismissedSuggestions.clear()
  }

  // A directory's entry point suggestions, none while one loads.
  showDirectory(data) {
    this._packageEntryPoints = data?.packageEntryPoints ?? []
    this._solidityEntryPoints = data?.solidityEntryPoints ?? []
    this._soliditySuggestionsLimited = data?.soliditySuggestionsLimited ?? false
  }

  // A directory read selects the entry points it suggests, but those dismissed.
  useDirectory(data, path) {
    super.useDirectory(data, path)
    const suggestions = [...this._packageEntryPoints, ...this._solidityEntryPoints]
      .filter(entry => !this._dismissedSuggestions.has(entry))
    this._selected = new Set([...this._selected, ...suggestions])
  }

  toggleFile(path) {
    const next = new Set(this._selected)
    if (next.has(path)) {
      next.delete(path)
      this._dismissedSuggestions.add(path)
    } else {
      next.add(path)
      this._dismissedSuggestions.delete(path)
    }
    this._selected = next
  }

  clearFiles() {
    for (const path of this._selected) this._dismissedSuggestions.add(path)
    this._selected = new Set()
  }

  hasScriptEntryPoints() {
    return [...this._selected].some(path => /\.[cm]?[tj]sx?$/iu.test(path))
  }

  async buildBundle() {
    if (this._building || this._opening || !this.createBundle || !this._commit || this._selected.size === 0) return
    const request = new AbortController()
    this._buildRequest = request
    this._building = true
    this._buildError = ''
    try {
      const bundle = await this.createBundle({ repoId: this._repoId, commit: this._commit,
        entries: [...this._selected], conditions: this._bundleConditions }, request.signal)
      if (!request.signal.aborted) {
        // Navigation replaces this form with the bundle as it opens it.
        this._opening = true
        this.dispatchEvent(new CustomEvent('bundle-created', { detail: bundle, bubbles: true, composed: true }))
      }
    } catch (error) {
      if (!request.signal.aborted) this._buildError = error.message
    } finally { this._building = false }
  }

  render() {
    const busy = this._building || this._opening
    return html`<p class="intro ui-hint">Choose a repository and revision, then select files to use as entry points.</p>
      <div ?inert=${busy}>
      ${this.renderSource()}
      ${this.renderBrowser(entry => html`<label class=${`file-tile ${this._selected.has(entry.path) ? 'selected' : ''} ${entry.type === 'file' ? '' : 'unsupported'}`} data-tooltip=${entry.type === 'file' ? nothing : `${entry.path} (${entry.type})`}><input type="checkbox" aria-label=${`Select ${entry.path} as an entry point`} .checked=${this._selected.has(entry.path)} ?disabled=${entry.type !== 'file'} @change=${() => this.toggleFile(entry.path)}>${sourceFileIcon(entry.name)}<span data-tooltip-truncated data-tooltip=${entry.type === 'file' ? entry.path : nothing}>${entry.name}</span></label>`)}
      ${packageEntryPointSuggestions(this._packageEntryPoints, this._selected, paths => { this._selected = new Set([...this._selected, ...paths]) })}
      ${solidityEntryPointSuggestions(this._solidityEntryPoints, this._selected, paths => { this._selected = new Set([...this._selected, ...paths]) }, this._soliditySuggestionsLimited)}
      <section class="entry-points" aria-label="Selected entry points"><div class="selection"><div class="selection-head"><h2>Entry points <span aria-live="polite">${this._selected.size}</span></h2>${this._selected.size > 0 ? html`<button type="button" class="btn clear-selection" @click=${this.clearFiles}>Clear all</button>` : nothing}</div>
        ${this._selected.size > 0 ? html`<ul>${[...this._selected].map(path => html`<li>${sourceFileIcon(path)}<span data-tooltip-truncated data-tooltip=${path}>${path}</span><button type="button" aria-label=${`Remove ${path}`} @click=${() => this.toggleFile(path)}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg></button></li>`)}</ul>` : html`<p class="note ui-hint">Select files above. You can choose entry points from multiple directories.</p>`}
        </div>
      </section>
      <bundle-conditions .showConditions=${this.hasScriptEntryPoints()} @conditions-change=${event => { this._bundleConditions = event.detail }}><button type="button" slot="actions" class="btn primary" ?disabled=${busy || !this.createBundle || !this._commit || this._selected.size === 0 || this._loading || this._loadingRefs} @click=${this.buildBundle}>${this._opening ? 'Opening…' : this._building ? 'Creating…' : 'Create a bundle'}</button></bundle-conditions>
      </div>
      ${busy ? html`<p class="message" role="status">${this._opening ? 'Opening bundle…' : 'Building the selected entry points with Stasis…'}</p>` : nothing}
      ${this._buildError ? html`<p class="message error" role="alert">${this._buildError}</p>` : nothing}
    `
  }
}

customElements.define('managed-create-bundle', ManagedCreateBundle)
