import { LitElement, html } from 'lit'

// The host already knows the session before opening Manage. Pass it across the
// lazy-bundle boundary instead of giving every page its own blocking probe.
export class ManagedPage extends LitElement {
  static properties = { session: { attribute: false }, _loading: { state: true } }

  constructor() {
    super()
    this.session = null
    this._loading = false
    this._loadRequest = null
  }

  get _role() { return this.session?.role ?? null }
  get _csrf() { return this.session?.csrfToken ?? null }
  get _me() { return this.session?.id ?? null }

  disconnectedCallback() {
    this._loadRequest?.abort()
    super.disconnectedCallback()
  }

  // Keep the last successful result while refreshing. Late responses from an
  // older load or an unmounted page must never replace newer content.
  async _loadCollection(load, apply) {
    this._loadRequest?.abort()
    const request = new AbortController()
    this._loadRequest = request
    this._loading = true
    try {
      const data = await load(request.signal)
      if (!request.signal.aborted && this._loadRequest === request) apply(data)
    } catch (err) {
      if (!request.signal.aborted && this._loadRequest === request) this._error = String(err?.message ?? err)
    } finally {
      if (this._loadRequest === request) this._loading = false
    }
  }
}

export function loadingRows(label) {
  return html`<div class="loading-rows" role="status"><span class="sr-only">${label}</span>
    <div aria-hidden="true">${[0, 1, 2, 3].map(() => html`<div class="loading-row"><span></span><span></span></div>`)}</div>
  </div>`
}
