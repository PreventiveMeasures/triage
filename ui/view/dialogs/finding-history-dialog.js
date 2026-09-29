import { html, nothing, unsafeCSS } from 'lit'
import { managedFetch } from '../../../client/managed/request.js'
import { managedAppState } from '../../managed/state.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import { findingHistoryChanges } from '../finding-history-changes.js'
import detailCSS from '../../styles/detail-action.css'
import styles from './finding-history-dialog.css'

class FindingHistoryDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(detailCSS), unsafeCSS(styles)]
  static properties = { finding: { attribute: false }, teamId: { attribute: false },
    _events: { state: true }, _loading: { state: true }, _error: { state: true } }

  constructor() {
    super()
    this._events = []; this._loading = true; this._error = false
  }

  beforeOpen() { void this._load() }

  async _load() {
    if (!this.isCurrent()) { this._finish(null); return }
    this._loading = true; this._error = false
    const { _managedReportId: reportId, id } = this.finding
    this._key = `finding-history:${this.teamId ?? ''}:${reportId}:${id}`
    // Refresh on every open; keep history only for the lifetime of this dialog.
    managedAppState.invalidate([this._key])
    const loading = managedAppState.load(this._key, 'issue history', async signal => {
      const query = new URLSearchParams({ finding: id })
      if (this.teamId) query.set('team', this.teamId)
      const response = await managedFetch(`/api/reports/${encodeURIComponent(reportId)}/triage/history?${query}`, { credentials: 'same-origin', signal })
      if (!response.ok) throw new Error(`History request failed (${response.status})`)
      const data = await response.json()
      if (data.finding !== id || !Array.isArray(data.events)) throw new Error('Invalid history response')
      return data.events
    })
    this._owner = managedAppState.resources.get(this._key)
    this._signal = this._owner.controller.signal
    this._signal.addEventListener('abort', this._onClose, { once: true })
    try {
      const events = await loading
      if (this._settled || !this.isConnected) return
      if (!this.isCurrent()) { this._finish(null); return }
      this._events = events
    } catch (error) {
      if (this._settled || !this.isConnected) return
      if (error.name === 'AbortError' || !this.isCurrent()) this._finish(null)
      else this._error = true
    } finally {
      this._loading = false
    }
  }

  disconnectedCallback() {
    this._signal?.removeEventListener('abort', this._onClose)
    if (this._owner && managedAppState.resources.get(this._key) === this._owner) managedAppState.invalidate([this._key])
    this._events = []
    super.disconnectedCallback()
  }

  _onKeydown = event => { if (event.key === 'Escape') event.stopPropagation() }

  render() {
    const f = this.finding ?? {}
    return html`<dialog aria-labelledby="history-title" @close=${this._onClose} @keydown=${this._onKeydown}>
      <header><h3 id="history-title">Issue history</h3>
        <button type="button" class="detail-action" aria-label="Close issue history" @click=${this._onClose}>×</button>
      </header>
      <p class="location">${f.file}${f.line ? `:${f.line}` : ''}</p>
      <div class="history-body" aria-busy=${String(this._loading)}>
        ${this._loading ? html`<p role="status">Loading history…</p>`
          : this._error ? html`<p role="alert">Couldn’t load issue history. Close and reopen to try again.</p>`
          : this._events.length === 0 ? html`<p role="status">No triage changes recorded.</p>`
          : html`<p class="note">Triage changes · newest first</p><ol>${this._events.map((event, index) => {
              const changes = findingHistoryChanges(event.entry, this._events[index + 1]?.entry)
              const date = new Date(event.at)
              return html`<li>
                <div class="event-meta"><strong>${event.actorLogin || 'Unknown user'}</strong>
                  <time datetime=${date.toISOString()}>${date.toLocaleString()}</time></div>
                ${event.entry === null ? html`<p>Cleared triage</p>` : nothing}
                ${changes.length > 0 ? html`<dl>${changes.map(change => html`<div><dt>${change.label}</dt>
                  <dd>${change.before === undefined ? nothing : html`<span class="before">${change.before}</span> → `}${change.after}</dd>
                </div>`)}</dl>` : event.entry === null ? nothing : html`<p>Triage updated</p>`}
              </li>`
            })}</ol>`}
      </div>
    </dialog>`
  }
}

customElements.define('finding-history-dialog', FindingHistoryDialog)
export function openFindingHistoryDialog(props) {
  if (!props.isCurrent()) return Promise.resolve(null)
  return openAppDialog('finding-history-dialog', props)
}
