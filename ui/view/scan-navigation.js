import { LitElement, css, html, nothing } from 'lit'
import { forgetScanAccess, hasSavedScanAccess, onSavedScanAccessChange, readSavedScanAccess, saveScanAccess, state } from '#client/index.js'
import { currentViewGeneration, goHome } from './ingest.js'
import { ensureClientMode, renderSidebar } from './sidebar.js'
import { render } from './render.js'
import { ScanAccess } from '../scan/access.js'
import { detectTokenProvider } from '../scan/provider-token.js'
import { providerIcon } from './provider-icons.js'
import '../scan/page.js'
import { loadLocalReportSources, loadLocalScanBundle, loadLocalScanSource } from './scan-local-source.js'
import { availableScanServer } from '../scan/availability.js'
import { showToast } from './toast.js'

async function withLoadingToast(message, signal, load) {
  const dismiss = showToast(message, { duration: 0 })
  signal.addEventListener('abort', dismiss, { once: true })
  try { return await load() }
  finally { signal.removeEventListener('abort', dismiss); dismiss() }
}

// Navigation and the configured service belong to the local/E2E host, not
// the reusable scan component (which also lives inside Manage).
export function currentScanServer() {
  return availableScanServer({
    hostname: window.location.hostname,
    devServer: document.querySelector('meta[name="deepview-scan-server"]')?.content,
    serverMode: state.serverMode, localMode: state.localMode, deepviewScanServer: state.deepviewScanServer,
  })
}

class LocalScanPage extends LitElement {
  static properties = {
    _source: { state: true }, _error: { state: true },
    _providerToken: { state: true },
    _savedAccess: { state: true }, _savingAccess: { state: true },
  }
  constructor() {
    super()
    this._server = currentScanServer()
    this._access = new ScanAccess(this._server, () => this.requestUpdate())
    this._resetAccess()
    this._source = null
    this._error = null
    this._loadBundle = (bundle, signal) => withLoadingToast('Loading bundle…', signal, () => loadLocalScanBundle(bundle, signal))
  }
  connectedCallback() {
    super.connectedCallback()
    this._restoreAccess()
    this._unsubscribeSavedAccess = onSavedScanAccessChange(() => { this._savedAccess = hasSavedScanAccess() })
    void this._loadSource()
  }
  disconnectedCallback() {
    super.disconnectedCallback()
    this._unsubscribeSavedAccess?.()
    this._controller?.abort()
    this._resetAccess()
  }
  async _loadSource() {
    this._controller?.abort()
    const controller = this._controller = new AbortController()
    this._error = null
    try { this._source = await withLoadingToast('Loading bundles…', controller.signal, () => loadLocalScanSource(controller.signal)) }
    catch (err) { if (!controller.signal.aborted) this._error = String(err?.message ?? err) }
  }
  _resetAccess() {
    this._access.reset(this._server)
    this._providerToken = ''
  }
  _restoreAccess() {
    this._savedAccess = hasSavedScanAccess()
    const saved = readSavedScanAccess(this._server)
    if (!saved) return
    this._access.setKey(saved.deepview)
    void this._access.setProvider(saved.provider)
    this._providerToken = saved.token
    void this._access.connect()
  }
  async _saveOrForgetAccess() {
    if (this._savingAccess) return
    const forget = hasSavedScanAccess()
    if (!forget && !this._access.connected) return
    this._savingAccess = true
    try {
      if (forget) { await forgetScanAccess(); this._resetAccess() }
      else await saveScanAccess({ server: this._server, deepview: this._access.apiKey, provider: this._access.provider, token: this._providerToken })
      this._savedAccess = hasSavedScanAccess()
    } catch {
      showToast(forget ? 'Couldn’t forget scan credentials. Try again.' : 'Couldn’t save scan credentials. Try again.', { kind: 'warning' })
    } finally { this._savingAccess = false }
  }
  _connect(event) {
    event.preventDefault()
    void this._access.connect()
  }
  _setProvider(value) {
    if (this._access.provider === value) return
    void this._access.setProvider(value)
    this._providerToken = ''
  }
  _setProviderToken(value) {
    this._providerToken = value
    const provider = detectTokenProvider(value)
    // Auto-detection must retain the token that caused the switch. Manual
    // provider changes still clear credentials entered for another provider.
    if (provider) void this._access.setProvider(provider)
  }
  setScanServer(server) {
    if (this._server === server) return
    this._server = server
    // A late discovery may replace the loopback fallback. Credentials entered
    // for the previous service must not carry over to the newly advertised one.
    this._resetAccess()
    this._restoreAccess()
  }
  static styles = css`
    :host { display: block; }
    * { box-sizing: border-box; }
    button { display: inline-flex; align-items: center; gap: .35rem; padding: .25rem .5rem; color: var(--muted); background: transparent; border: 1px solid var(--border); border-radius: 5px; font: inherit; font-size: .8rem; cursor: default; }
    button:hover:not(:disabled) { color: var(--text); background: var(--surface); }
    button:disabled { opacity: .5; }
    .access { min-width: 0; border: 1px solid var(--border); border-radius: 9px; background: var(--surface); container: scan-access / inline-size; }
    .access-heading { display: flex; align-items: center; justify-content: space-between; min-height: 2.5rem; padding: .45rem .9rem; border-bottom: 1px solid var(--border); }
    .access h2 { margin: 0; color: var(--text); font-size: .86rem; font-weight: 600; }
    .save-access { min-height: 1.6rem; margin-left: auto; flex-shrink: 0; }
    .access-fields { display: grid; gap: .8rem; padding: .85rem .9rem; }
    .connection-row, .provider-row { display: grid; align-items: end; gap: .65rem; margin: 0; }
    .connection-row { grid-template-columns: minmax(0, 1fr) auto; width: min(42rem, 100%); }
    .provider-row { grid-template-columns: max-content minmax(0, 1fr); width: 100%; }
    .access label { display: grid; gap: .3rem; min-width: 0; color: var(--muted); font-size: .72rem; }
    input { min-width: 0; width: 100%; height: 2rem; padding: .35rem .55rem; border: 1px solid var(--border); border-radius: 5px; background: var(--bg); color: var(--text); font: inherit; font-size: .8rem; }
    .provider-field { min-width: 0; margin: 0; padding: 0; border: 0; }
    .provider-field legend { margin-bottom: .3rem; padding: 0; color: var(--muted); font-size: .72rem; }
    .provider-options { display: flex; width: fit-content; max-width: 100%; border: 1px solid var(--border); border-radius: 5px; background: var(--bg); overflow: hidden; }
    .access .provider-choice { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: .35rem; height: calc(2rem - 2px); padding: .3rem .6rem; color: var(--muted); font-size: .74rem; white-space: nowrap; user-select: none; }
    .provider-choice + .provider-choice { border-left: 1px solid var(--border); }
    .provider-choice:hover { color: var(--text); background: var(--surface); }
    .provider-choice:has(:checked) { color: var(--text); background: var(--surface-active); }
    .provider-choice:has(:focus-visible) { outline: 2px solid var(--accent); outline-offset: -2px; }
    .provider-choice input { position: absolute; inset: 0; margin: 0; width: 100%; height: 100%; opacity: 0; cursor: default; }
    .provider-icon { display: block; width: 1rem; height: 1rem; flex: 0 0 1rem; }
    .provider-icon svg { display: block; width: 100%; height: 100%; }
    .provider-icon.anthropic { color: #d97757; }
    .provider-icon.openai { color: #10a37f; }
    .provider-icon.moonshot { color: #8068d9; }
    .provider-icon.moonshot svg { transform: scale(.8); }
    .provider-icon.openrouter { color: var(--text); }
    .connect { justify-content: center; height: 2rem; padding: .35rem .8rem; color: var(--text); background: var(--surface-active); }
    .connection-status { flex: 1; min-width: 0; margin: 0 .7rem; line-height: 1rem; color: var(--muted); font-size: .7rem; }
    .connection-status.error { color: var(--critical, #e5534b); }
    button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @container scan-access (max-width: 38rem) { .provider-row { grid-template-columns: minmax(0, 1fr); } }
    @container scan-access (max-width: 28rem) {
      .provider-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }
      .provider-choice:nth-child(odd) { border-left: 0; }
      .provider-choice:nth-child(n+3) { border-top: 1px solid var(--border); }
    }
    @container scan-access (max-width: 23rem) { .access .provider-choice { gap: .25rem; padding-inline: .4rem; font-size: .7rem; } }
  `
  _accessPanel() {
    const access = this._access
    const count = access.catalogue?.models.length ?? 0
    const status = access.error ?? (access.loading ? access.connected ? 'Loading provider models…' : 'Connecting…' : access.connected ? access.catalogue ? `Connected · ${count} ${count === 1 ? 'model' : 'models'}` : 'Connected. Choose a provider.' : '')
    return html`<section slot="access" class="access" aria-labelledby="scan-access-heading">
      <div class="access-heading"><h2 id="scan-access-heading">Access</h2><p class=${`connection-status ${access.error ? 'error' : ''}`} role=${access.error ? 'alert' : 'status'}>${status}</p>${this._savedAccess || access.connected ? html`<button class="save-access" type="button" ?disabled=${this._savingAccess} @click=${this._saveOrForgetAccess}>${this._savedAccess ? 'Forget' : 'Save'}</button>` : nothing}</div>
      <div class="access-fields">
        <form class="connection-row" @submit=${this._connect}>
          <label>DeepView API Key<input type="password" name="deepview-api-key" placeholder="Enter API key" autocomplete="off" spellcheck="false" .value=${access.apiKey} @input=${event => access.setKey(event.target.value)}></label>
          <button type="submit" class="connect" ?disabled=${!access.apiKey.trim() || access.loading || (access.connected && !access.error)}>${access.connected && !access.error ? 'Connected' : 'Connect'}</button>
        </form>
        ${access.managed ? nothing : html`<div class="provider-row">
          <fieldset class="provider-field"><legend>Provider</legend><div class="provider-options">${[['anthropic', 'Anthropic'], ['openai', 'OpenAI'], ['moonshot', 'Moonshot'], ['openrouter', 'OpenRouter']].map(([id, name]) => html`<label class="provider-choice"><input type="radio" name="scan-provider" value=${id} .checked=${access.provider === id} @change=${() => this._setProvider(id)}><span class=${`provider-icon ${id}`} aria-hidden="true">${providerIcon(id)}</span><span>${name}</span></label>`)}</div></fieldset>
          <label>Token<input type="password" name="provider-token" placeholder="Enter provider token" autocomplete="off" spellcheck="false" .value=${this._providerToken} @input=${event => this._setProviderToken(event.target.value)}></label>
        </div>`}
      </div>
    </section>`
  }
  render() {
    return html`${this._error ? html`<p role="alert">Couldn’t load saved bundles: ${this._error} <button @click=${() => void this._loadSource()}>Retry</button></p>` : nothing}<deepview-scan-page .source=${this._source} .loadBundle=${this._loadBundle} .loadModels=${this._access.loadModels} .canRun=${this._access.ready} .loadReportSources=${loadLocalReportSources}><button slot="navigation" type="button" @click=${() => void goHome()}><span aria-hidden="true">‹</span> Home</button>${this._accessPanel()}</deepview-scan-page>`
  }
}
if (!customElements.get('local-scan-page')) customElements.define('local-scan-page', LocalScanPage)

export function refreshScanNavigation() {
  const landing = document.querySelector('#drop-zone')
  if (!landing) return
  let button = landing.querySelector('.local-scan-button')
  if (!button) {
    button = document.createElement('button')
    button.type = 'button'
    button.className = 'local-scan-button'
    button.textContent = 'Scan'
    button.addEventListener('click', async () => {
      await ensureClientMode()
      if (!currentScanServer()) return
      const home = goHome()
      const generation = currentViewGeneration()
      await home
      if (!currentScanServer() || generation !== currentViewGeneration()) return
      state.currentView = 'scan'
      render()
      void renderSidebar()
    })
    landing.append(button)
  }
  const server = currentScanServer()
  button.hidden = !server
  document.querySelector('local-scan-page')?.setScanServer(server)
}
