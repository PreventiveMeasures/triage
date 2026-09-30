import { html, nothing, unsafeCSS } from 'lit'
import { managedFetch } from '../../../client/managed/request.js'
import { managedAppState } from '../../managed/state.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import { findingHistoryChanges } from '../finding-history-changes.js'
import { managedCommentAvatar } from '../managed-comment.js'
import avatarCSS from '../managed-comment.css'
import detailCSS from '../../styles/detail-action.css'
import styles from './finding-history-dialog.css'

class FindingHistoryDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(detailCSS), unsafeCSS(avatarCSS), unsafeCSS(styles)]
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

  _renderEvent(event, index) {
    const older = this._events[index + 1]
    const changes = findingHistoryChanges(event.entry, older?.entry)
    const date = new Date(event.at)
    const login = event.actorLogin ? `@${event.actorLogin}` : ''
    return html`<li class="event">
      ${event.actorId ? managedCommentAvatar(event.actorId, event.actorName || event.actorLogin)
        : html`<span class="managed-comment-avatar" aria-hidden="true">${(event.actorLogin?.[0] || '?').toUpperCase()}</span>`}
      <div class="event-content">
        <div class="event-meta">
          <div class="event-user"><strong>${event.actorName || login || 'Unknown user'}</strong>
            ${event.actorName && login ? html`<span class="username">${login}</span>` : nothing}
          </div>
          <time datetime=${date.toISOString()} data-tooltip=${date.toLocaleString()}>
            ${date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
          </time>
        </div>
        <p class="event-action">${event.entry === null ? 'Cleared triage' : older ? 'Updated triage' : 'Recorded triage state'}</p>
        ${changes.length > 0 ? html`<dl class="changes">${changes.map(change => html`<div class="change">
          <dt>${change.label}</dt>
          <dd class=${change.before === undefined ? 'snapshot' : ''}>
            ${change.before === undefined ? nothing : html`<span class="before"><span class="sr-only">Previously: </span>${change.before}</span>
              <span class="change-arrow" aria-hidden="true">→</span>`}
            <span class="after"><span class="sr-only">${change.before === undefined ? 'Recorded: ' : 'Changed to: '}</span>${change.after}</span>
          </dd>
        </div>`)}</dl>` : nothing}
      </div>
    </li>`
  }

  render() {
    const f = this.finding ?? {}
    return html`<dialog aria-labelledby="history-title" @close=${this._onClose} @keydown=${this._onKeydown}>
      <header>
        <div class="history-heading"><h3 id="history-title">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 11a9 9 0 1 1 2.5 7M3 5v6h6M12 7v5l3 2"/>
          </svg>Issue history</h3>
          <p class="location">${f.file}${f.line ? `:${f.line}` : ''}</p>
        </div>
        <button type="button" class="detail-action" aria-label="Close issue history" @click=${this._onClose}>×</button>
      </header>
      ${!this._loading && !this._error && this._events.length > 0 ? html`<div class="history-summary">
        <span>${this._events.length} ${this._events.length === 1 ? 'record' : 'records'}</span><span>Newest first</span>
      </div>` : nothing}
      <div class="history-body" aria-busy=${String(this._loading)}>
        ${this._loading ? html`<p class="history-state" role="status">Loading history…</p>`
          : this._error ? html`<div class="history-state" role="alert"><strong>Couldn’t load issue history</strong>
            <p>Close and reopen to try again.</p></div>`
          : this._events.length === 0 ? html`<div class="history-state" role="status"><strong>No triage changes yet</strong>
            <p>Changes to status, labels, flags, and fixes will appear here.</p></div>`
          : html`<ol class="timeline">${this._events.map((event, index) => this._renderEvent(event, index))}</ol>`}
      </div>
    </dialog>`
  }
}

customElements.define('finding-history-dialog', FindingHistoryDialog)
export function openFindingHistoryDialog(props) {
  if (!props.isCurrent()) return Promise.resolve(null)
  return openAppDialog('finding-history-dialog', props)
}
