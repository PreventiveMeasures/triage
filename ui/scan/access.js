import { scanModelCatalogue } from '../view/scan-models.js'
import { defaultScanModels } from './default-models.js'
import { scanServerRequest } from './request.js'

// One in-memory connection owns discovery and model requests. Model pickers
// share its catalogue, so adding Advanced rows never sends more requests.
export class ScanAccess {
  constructor(server, onChange = () => {}, request = fetch) {
    this.onChange = onChange
    this.request = request
    this.reset(server)
  }
  reset(server = this.server) {
    this.server = server
    this.apiKey = ''
    this.provider = null
    this._remoteModels = false
    this._disconnect()
  }
  _previewModels() {
    const catalogue = defaultScanModels(this.provider)
    this.loadModels = () => Promise.resolve(catalogue)
  }
  _disconnect() {
    this._controller?.abort()
    this.connected = false
    this.managed = false
    this.loading = false
    this.error = null
    this.catalogue = null
    if (!this._remoteModels) this._previewModels()
    this.onChange()
  }
  get ready() { return this.connected && !this.loading && this.catalogue != null }
  setKey(value) {
    if (this.apiKey === value) return
    this.apiKey = value
    this._disconnect()
  }
  setProvider(value) {
    if (this.provider === value || this.managed) return
    this.provider = value
    if (this.connected && value) return this._load(value)
    if (this.connected) {
      this._controller?.abort()
      this.loading = false
      this.error = null
      this.catalogue = null
    }
    if (!this._remoteModels) this._previewModels()
    this.onChange()
  }
  connect() {
    this._disconnect()
    if (!this.server || !this.apiKey.trim()) return
    // Always discover the key type first, even if a provider is already chosen.
    return this._load(null)
  }
  async _fetch(provider, signal) {
    const request = scanServerRequest(this.server, this.request, this.apiKey.trim())
    const query = provider ? `?${new URLSearchParams({ provider })}` : ''
    const res = await request(`api/models${query}`, { headers: { accept: 'application/json' }, cache: 'no-store', signal })
    if (res.status === 401) throw Object.assign(new Error('DeepView API key not recognized.'), { status: 401 })
    if (!res.ok) throw new Error(`Scan server returned HTTP ${res.status}.`)
    const body = await res.json()
    if (body?.valid !== true || typeof body.managed !== 'boolean') throw new Error('Invalid response from scan server.')
    return { managed: body.managed, catalogue: body.managed || provider ? scanModelCatalogue(body) : null }
  }
  async _load(provider) {
    this._controller?.abort()
    const controller = this._controller = new AbortController()
    this.loading = true
    this.error = null
    this.catalogue = null
    const result = this._fetch(provider, controller.signal)
    // Keep a synchronous catalogue snapshot available to every picker while
    // fetching. Only a successful response replaces the previous choices.
    this.onChange()
    try {
      const data = await result
      if (controller.signal.aborted) return
      this.connected = true
      this.managed = data.managed
      this.catalogue = data.catalogue
      // The provider may have changed while key discovery was in flight.
      if (!data.managed && !provider && this.provider) return this._load(this.provider)
      if (data.catalogue) {
        const catalogue = data.catalogue
        this._remoteModels = true
        this.loadModels = () => Promise.resolve(catalogue)
      } else if (!this._remoteModels) this._previewModels()
      this.loading = false
      this.onChange()
    } catch (err) {
      if (controller.signal.aborted) return
      if (!provider || err.status === 401) this._disconnect()
      this.loading = false
      this.error = err instanceof TypeError ? 'Couldn’t reach the scan server. Check your connection and try again.' : String(err?.message ?? err)
      this.onChange()
    }
  }
}
