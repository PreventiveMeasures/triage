import { html, nothing, unsafeCSS } from 'lit'
import { sourceFileIcon } from '../view/source-file-icon.js'
import styles from './styles/create-bundle.css'
import { configEntryPointSuggestions, packageEntryPointSuggestions, solidityEntryPointSuggestions } from './package-entry-points.js'
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
    _configEntryPoints: { state: true }, _packageEntryPoints: { state: true },
    _solidityEntryPoints: { state: true }, _soliditySuggestionsLimited: { state: true },
  }

  constructor() {
    super()
    this._building = false
    this._opening = false
    this._buildError = ''
    this._selected = new Set()
    this._dismissedSuggestions = new Set()
    // The selected entries a directory read selected, which the user has not touched.
    this._suggested = new Set()
    this._bundleConditions = defaultBundleConditions()
    // Each entry a stasis.config.json lists -> its directory: the nearest
    // one's, at or above it, that lists it, as the build takes it.
    this._configs = new Map()
    this._configEntryPoints = []
    this._packageEntryPoints = []
    this._solidityEntryPoints = []
    this._soliditySuggestionsLimited = false
  }

  disconnectedCallback() {
    this._buildRequest?.abort()
    this._opening = false
    this._dismissedSuggestions.clear()
    this._suggested.clear()
    this.showDirectory(null)
    super.disconnectedCallback()
  }

  resetFiles() {
    this._buildError = ''
    super.resetFiles()
    this._selected = new Set()
    this._dismissedSuggestions.clear()
    this._suggested.clear()
    this._configs.clear()
  }

  // A directory's entry point suggestions, none while one loads: those its
  // stasis.config.json lists, else the ones guessed.
  showDirectory(data) {
    this._configEntryPoints = data?.configEntryPoints ?? []
    this._packageEntryPoints = data?.packageEntryPoints ?? []
    this._solidityEntryPoints = data?.solidityEntryPoints ?? []
    this._soliditySuggestionsLimited = data?.soliditySuggestionsLimited ?? false
  }

  // A directory read selects the entry points it suggests, but those dismissed,
  // where they can be built with the ones selected. Those its stasis.config.json
  // lists come first: they take the place of entries selected for the user, but
  // never of ones the user picked.
  useDirectory(data, path) {
    super.useDirectory(data, path)
    for (const entry of this._configEntryPoints) {
      const known = this._configs.get(entry)
      if (known === undefined || known.length < path.length) this._configs.set(entry, path)
    }
    const suggestions = [...this._configEntryPoints, ...this._packageEntryPoints, ...this._solidityEntryPoints]
      .filter(entry => !this._dismissedSuggestions.has(entry))
    const replace = this._configEntryPoints.length > 0 && this.configOf([...this._selected, ...suggestions]) === undefined
    const selected = new Set([...[...this._selected].filter(entry => !replace || !this._suggested.has(entry)), ...suggestions])
    if (this.configOf(selected) === undefined) return
    for (const entry of this._suggested) if (!selected.has(entry)) this._suggested.delete(entry)
    for (const entry of suggestions) if (!this._selected.has(entry)) this._suggested.add(entry)
    this._selected = selected
  }

  // The directory of the stasis.config.json listing each of `paths`, null
  // where it lists none of them, undefined where it lists some, or they are
  // another's: those it lists are built with their options there, alone.
  configOf(paths = this._selected) {
    const directories = new Set([...paths].map(path => this._configs.get(path) ?? null))
    return directories.size > 1 ? undefined : directories.size === 0 ? null : [...directories][0]
  }

  toggleFile(path) {
    this._suggested.delete(path)
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
    this._suggested.clear()
  }

  hasScriptEntryPoints() {
    return [...this._selected].some(path => /\.[cm]?[tj]sx?$/iu.test(path))
  }

  async buildBundle() {
    const config = this.configOf()
    if (this._building || this._opening || !this.createBundle || !this._commit || this._selected.size === 0 || config === undefined) return
    const request = new AbortController()
    this._buildRequest = request
    this._building = true
    this._buildError = ''
    try {
      // Entries stasis.config.json lists take its options, and no conditions.
      const bundle = await this.createBundle({ repoId: this._repoId, commit: this._commit,
        entries: [...this._selected], ...(config === null && { conditions: this._bundleConditions }) }, request.signal)
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
    const config = this.configOf()
    return html`<p class="intro ui-hint">Choose a repository and revision, then select files to use as entry points.</p>
      <div ?inert=${busy}>
      ${this.renderSource()}
      ${this.renderBrowser(entry => html`<label class=${`file-tile ${this._selected.has(entry.path) ? 'selected' : ''} ${entry.type === 'file' ? '' : 'unsupported'}`} data-tooltip=${entry.type === 'file' ? nothing : `${entry.path} (${entry.type})`}><input type="checkbox" aria-label=${`Select ${entry.path} as an entry point`} .checked=${this._selected.has(entry.path)} ?disabled=${entry.type !== 'file'} @change=${() => this.toggleFile(entry.path)}>${sourceFileIcon(entry.name)}<span data-tooltip-truncated data-tooltip=${entry.type === 'file' ? entry.path : nothing}>${entry.name}</span></label>`)}
      ${configEntryPointSuggestions(this._configEntryPoints, this._selected, paths => { this._selected = new Set([...this._selected, ...paths]) })}
      ${packageEntryPointSuggestions(this._packageEntryPoints, this._selected, paths => { this._selected = new Set([...this._selected, ...paths]) })}
      ${solidityEntryPointSuggestions(this._solidityEntryPoints, this._selected, paths => { this._selected = new Set([...this._selected, ...paths]) }, this._soliditySuggestionsLimited)}
      <section class="entry-points" aria-label="Selected entry points"><div class="selection"><div class="selection-head"><h2>Entry points <span aria-live="polite">${this._selected.size}</span></h2>${this._selected.size > 0 ? html`<button type="button" class="btn clear-selection" @click=${this.clearFiles}>Clear all</button>` : nothing}</div>
        ${this._selected.size > 0 ? html`<ul>${[...this._selected].map(path => html`<li>${sourceFileIcon(path)}<span data-tooltip-truncated data-tooltip=${path}>${path}</span><button type="button" aria-label=${`Remove ${path}`} @click=${() => this.toggleFile(path)}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg></button></li>`)}</ul>` : html`<p class="note ui-hint">Select files above. You can choose entry points from multiple directories.</p>`}
        ${config === undefined ? html`<p class="note error" role="alert">Entry points listed in a <code>stasis.config.json</code> are built with its options, alone. Select only those it lists, or only other files.</p>`
          : typeof config === 'string' ? html`<p class="note ui-hint">Built with the options <code>${config ? `${config}/` : ''}stasis.config.json</code> sets for them.</p>` : nothing}
        </div>
      </section>
      <bundle-conditions .showConditions=${this.hasScriptEntryPoints() && typeof config !== 'string'} @conditions-change=${event => { this._bundleConditions = event.detail }}><button type="button" slot="actions" class="btn primary" ?disabled=${busy || !this.createBundle || !this._commit || this._selected.size === 0 || config === undefined || this._loading || this._loadingRefs} @click=${this.buildBundle}>${this._opening ? 'Opening…' : this._building ? 'Creating…' : 'Create a bundle'}</button></bundle-conditions>
      </div>
      ${busy ? html`<p class="message" role="status">${this._opening ? 'Opening bundle…' : 'Building the selected entry points with Stasis…'}</p>` : nothing}
      ${this._buildError ? html`<p class="message error" role="alert">${this._buildError}</p>` : nothing}
    `
  }
}

customElements.define('managed-create-bundle', ManagedCreateBundle)
