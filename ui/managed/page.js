import { LitElement, html, nothing } from 'lit'
import { managedAppState } from './state.js'
import { adminIcon, adminNavigation } from './navigation.js'
import { installFileDropZone, pickFiles } from './file-uploads.js'

// The host already knows the session before opening Manage. Pass it across the
// lazy-bundle boundary instead of giving every page its own blocking probe.
// A page names what it loads as `static collection = [key, label, fetch]`,
// each result shown by `_show`; one that loads otherwise overrides `_load`.
export class ManagedPage extends LitElement {
  static properties = { session: { attribute: false }, allowShare: { attribute: false }, _loading: { state: true }, _data: { state: true }, _error: { state: true } }

  constructor() {
    super()
    this.session = null
    this.allowShare = false
    this.appState = managedAppState
    this._loading = false
    this._loadRequest = null
    this._data = null
    this._error = null
  }

  get _role() { return this.session?.role ?? null }
  get _csrf() { return this.session?.csrfToken ?? null }
  get _me() { return this.session?.id ?? null }

  connectedCallback() {
    super.connectedCallback()
    void this._load()
  }

  disconnectedCallback() {
    this._loadRequest?.abort()
    super.disconnectedCallback()
  }

  async _load({ preserveError = false } = {}) {
    const { collection } = this.constructor
    if (!collection) return
    if (!preserveError) this._error = null
    const [key, label, load] = collection
    await this._loadCollection(key, label, load, data => this._show(data))
  }

  _show(data) { this._data = data }

  // Keep the last successful result while refreshing. Late responses from an
  // older load or an unmounted page must never replace newer content.
  async _loadCollection(key, label, load, apply) {
    this._loadRequest?.abort()
    const request = new AbortController()
    this._loadRequest = request
    this._loading = true
    try {
      await this.appState.load(key, label, load, { signal: request.signal, apply })
    } catch (err) {
      // Background errors use the host toast; only a first-load failure needs
      // an inline empty/error state. Keep existing content and layout intact.
      if (!request.signal.aborted && err?.name !== 'AbortError' && this.appState.read(key) === undefined) this._error = String(err?.message ?? err)
    } finally {
      if (this._loadRequest === request) this._loading = false
    }
  }

  // The navigation of the page's `static view`.
  _nav() { return adminNavigation(this.constructor.view, this._role, this.allowShare) }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true })) }

  // A list `render`ed once `loaded`; placeholder rows until then, none after a failed first load.
  _list(loaded, label, render) {
    return html`<div class="manage-list" aria-busy=${this._loading}>${loaded == null ? (this._error ? nothing : loadingRows(label)) : render()}</div>`
  }
}

// Files dropped anywhere on a page are uploaded (`host._upload`) while it
// `accepts` them; `active` while a drag carrying them is over it.
export class FileDrop {
  constructor(host, accepts = () => true) {
    this.host = host
    this.accepts = accepts
    this.active = false
    host.addController(this)
  }

  hostConnected() {
    this.teardown = installFileDropZone(this.host, files => { if (this.accepts()) void this.host._upload(files) },
      active => { this.active = this.accepts() && active; this.host.requestUpdate() })
  }

  hostDisconnected() { this.teardown?.() }

  overlay(text) { return this.active ? html`<div class="dropzone">${text}</div>` : nothing }

  // A drop card's contents: what it takes, and a button browsing for files.
  card(title, copy, disabled, busy = 'Uploading…') {
    return html`<span class="drop-icon" aria-hidden="true">${adminIcon('upload')}</span><span class="drop-copy"><strong>${title}</strong><span>${copy}</span></span><button type="button" class="drop-browse" ?disabled=${disabled} @click=${() => pickFiles(files => void this.host._upload(files))}>${this.host._busy ? busy : 'Browse files'}</button>`
  }
}

export function loadingRows(label) {
  return html`<div class="loading-rows" role="status"><span class="sr-only">${label}</span>
    <div aria-hidden="true">${[0, 1, 2, 3].map(() => html`<div class="loading-row"><span></span><span></span></div>`)}</div>
  </div>`
}

export const errorMessage = text => text ? html`<p class="msg error" role="alert">${text}</p>` : nothing
export const emptyState = (title, text) => html`<div class="empty"><strong>${title}</strong><p>${text}</p></div>`
