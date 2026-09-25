import { html, nothing } from 'lit'
import { SearchableSelector } from '../view/searchable-selector.js'

class LocalItemSelector extends SearchableSelector {
  get changeEvent() { return 'local-item-change' }
  get searchLabel() { return 'Search local files' }
  get optionsLabel() { return 'Local files' }
  get noMatchesLabel() { return 'No matching files.' }
  get emptyLabel() { return 'No local files available.' }
  optionTitle() { return nothing }
  choices() {
    const query = this._query.trim().toLocaleLowerCase()
    const options = this.options.filter(option => `${option.label} ${option.secondary ?? ''}`.toLocaleLowerCase().includes(query))
    return { pinned: [], sections: [{ options }], count: options.length, total: this.options.length, showFacets: false }
  }
}
customElements.define('managed-local-item-selector', LocalItemSelector)

// Owns only presentation. The host supplies the main bundle's local storage
// bridge and uses the same upload path as files picked from the computer.
export class ManagedLocalImport {
  constructor(host, kind, upload) {
    this.host = host
    this.kind = kind
    this.upload = upload
    this.source = null
    this.hasData = false
    this.open = false
    this.options = []
    this.value = null
    this.busy = false
    this.loading = false
    this.error = ''
    this.success = ''
    this.generation = 0
    this.readAbort = null
    this.onChange = () => {
      // Cross-document changes arrive through focus/storage, outside the
      // storage module's mutation registries. Invalidate the pending read too.
      if (this.readAbort && !this.readAbort.signal.aborted) {
        this.readAbort.abort()
        this.error = `The local ${this.kind} changed or the list was refreshed. Select it again before importing.`
      }
      this.options = []
      this.value = null
      this.success = ''
      void this.refresh()
    }
    host.addController(this)
  }

  hostConnected() {
    globalThis.addEventListener('focus', this.onChange)
    globalThis.addEventListener('storage', this.onChange)
    this.connectSource()
  }

  hostUpdated() { this.connectSource() }

  connectSource() {
    if (this.source === this.host.localImportSource) return
    this.unsubscribe?.()
    this.abort?.abort()
    this.source = this.host.localImportSource
    this.unsubscribe = this.source?.subscribe(this.onChange)
    this.onChange()
  }

  hostDisconnected() {
    ++this.generation
    this.abort?.abort()
    this.unsubscribe?.()
    this.source = null
    globalThis.removeEventListener('focus', this.onChange)
    globalThis.removeEventListener('storage', this.onChange)
  }

  async refresh() {
    const generation = ++this.generation
    const source = this.source
    this.loading = true
    this.host.requestUpdate()
    try {
      const hasData = source ? await source.hasData(this.kind) : false
      if (generation !== this.generation) return
      this.hasData = hasData
      const options = this.open && !source?.locked ? await source?.list(this.kind) ?? [] : []
      if (generation !== this.generation) return
      this.options = options
      if (!options.some(option => option.value === this.value)) this.value = null
    } catch (err) {
      if (generation === this.generation) this.error = String(err?.message ?? err)
    } finally {
      if (generation === this.generation) { this.loading = false; this.host.requestUpdate() }
    }
  }

  toggle() {
    if (this.busy) return
    this.open = !this.open
    this.error = ''
    this.success = ''
    this.options = []
    this.value = null
    void this.refresh()
  }

  async unlock() {
    if (this.busy) return
    this.busy = true
    this.error = ''
    const abort = this.abort = new AbortController()
    this.host.requestUpdate()
    try {
      if (await this.source.unlock({ signal: abort.signal }) && !abort.signal.aborted) await this.refresh()
    } catch (err) {
      if (!abort.signal.aborted) this.error = String(err?.message ?? err)
    } finally { this.busy = false; this.host.requestUpdate() }
  }

  async importSelected() {
    if (this.busy || this.loading || !this.value || this.source?.locked) return
    this.busy = true
    this.error = ''
    this.success = ''
    const label = this.options.find(option => option.value === this.value)?.label
    const abort = this.abort = new AbortController()
    this.readAbort = abort
    this.host.requestUpdate()
    try {
      await this.source.importItem(this.kind, this.value, file => {
        // Refreshes cannot recall an upload once it has been handed off.
        this.readAbort = null
        return this.upload(file)
      }, { signal: abort.signal })
      if (!abort.signal.aborted && !this.source?.locked) {
        this.success = `Imported ${label}.`
        this.value = null
      }
    } catch (err) {
      if (!abort.signal.aborted) this.error = String(err?.message ?? err)
    } finally {
      if (this.readAbort === abort) this.readAbort = null
      this.busy = false
      this.host.requestUpdate()
    }
  }

  renderAction() {
    return this.hasData || this.open ? html`<button type="button" class="local-import-toggle" aria-expanded=${this.open} aria-controls="local-import-panel" ?disabled=${this.busy} @click=${() => this.toggle()}>Import</button>` : nothing
  }

  renderPanel(disabled) {
    if (!this.open) return nothing
    const locked = this.source?.locked
    return html`<section class="local-import-panel" id="local-import-panel" aria-label=${`Import local ${this.kind}`}>
      <div class="local-import-copy"><strong>Import local ${this.kind}</strong><p>${locked ? 'Unlock local data with your passkey to choose a file.' : 'Copy a file from this browser to the managed workspace. The local copy stays on this device.'}</p></div>
      <div class="local-import-controls">
        ${locked ? html`<button type="button" class="local-import-submit" ?disabled=${this.busy} @click=${() => this.unlock()}>${this.busy ? 'Waiting for passkey…' : 'Unlock with passkey'}</button>` : html`
          <managed-local-item-selector label=${`Choose local ${this.kind}`} placeholder=${this.loading ? 'Loading local files…' : `Choose local ${this.kind}…`} .options=${this.options} .value=${this.value} ?disabled=${this.busy || this.loading} @local-item-change=${event => { this.value = event.detail.value; this.success = ''; this.host.requestUpdate() }}></managed-local-item-selector>
          <button type="button" class="local-import-submit" ?disabled=${disabled || this.busy || this.loading || !this.value} @click=${() => this.importSelected()}>${this.busy ? 'Importing…' : `Import ${this.kind}`}</button>`}
        <button type="button" class="local-import-close" ?disabled=${this.busy} @click=${() => this.toggle()}>Close</button>
      </div>
      ${!locked && !this.loading && this.options.length === 0 ? html`<p class="local-import-message">No local ${this.kind}s available.</p>` : nothing}
      ${this.error ? html`<p class="local-import-message error" role="alert">${this.error} <button type="button" ?disabled=${this.busy} @click=${() => { this.error = ''; void this.refresh() }}>Retry</button></p>` : nothing}
      ${this.success ? html`<p class="local-import-message" role="status">${this.success}</p>` : nothing}
    </section>`
  }
}
