import { html, nothing, unsafeCSS } from 'lit'
import { state } from '#client/index.js'
import { MAX_COMMENT_TEXT } from '../../../common/managed/comments.ts'
import { canWriteManagedComments, loadManagedReportComments, managedCommentScope, managedCommentsFor, writeManagedComment } from '../managed-comments.js'
import { renderCommentText } from '../render-finding.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import commentCSS from './dialog-comment.css'
import threadCSS from './dialog-managed-comments.css'

class ManagedCommentsDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(commentCSS), unsafeCSS(threadCSS)]
  static properties = {
    finding: { attribute: false }, changed: { attribute: false },
    _comments: { state: true }, _value: { state: true }, _editing: { state: true },
    _busy: { state: true }, _error: { state: true },
  }

  constructor() {
    super()
    this.finding = null
    this.changed = null
    this._comments = []
    this._value = ''
    this._editing = null
    this._busy = false
    this._error = ''
  }

  connectedCallback() {
    super.connectedCallback()
    document.addEventListener('managed-comments-reset', this._close)
  }
  disconnectedCallback() {
    document.removeEventListener('managed-comments-reset', this._close)
    super.disconnectedCallback()
  }
  beforeOpen() {
    this._current = managedCommentScope(this.finding?._managedReportId)
    this._comments = managedCommentsFor(this.finding)
    void this._refresh()
  }
  _close = () => this._finish(null)
  _refresh = async () => {
    if (!this._current()) { this._close(); return }
    this._busy = true
    this._error = ''
    const ok = await loadManagedReportComments(this.finding._managedReportId)
    if (!this.isConnected) return
    if (!this._current()) { this._close(); return }
    this._busy = false
    if (!ok) { this._error = 'Could not load comments. Please retry.'; return }
    this._comments = managedCommentsFor(this.finding)
    this.changed?.()
  }
  _edit(comment) {
    this._editing = comment
    this._value = comment.body
    this._error = ''
    void this.updateComplete.then(() => this.renderRoot.querySelector('textarea')?.focus())
  }
  _cancelEdit = () => { this._editing = null; this._value = ''; this._error = '' }
  _save = async () => {
    const body = this._value.trim()
    if (this._busy || !body || body.length > MAX_COMMENT_TEXT || !this._current()) return
    this._busy = true
    this._error = ''
    const result = await writeManagedComment(this.finding, body, this._editing)
    if (!this.isConnected) return
    if (!this._current()) { this._close(); return }
    this._busy = false
    if (result.status === 409) {
      await this._refresh()
      if (!this.isConnected) return
      this._editing = this._comments.find(comment => comment.id === this._editing?.id) ?? this._editing
      this._error = 'This comment changed elsewhere. Your draft is kept. Review the latest version above before saving again.'
      return
    }
    if (!result.comment) {
      this._error = result.status === 403 || result.status === 404
        ? 'You no longer have permission to save this comment.' : 'Could not save the comment. Your draft is kept; please retry.'
      return
    }
    this._comments = managedCommentsFor(this.finding)
    this._cancelEdit()
    this.changed?.()
  }
  _keydown = (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void this._save() }
  }

  render() {
    const canWrite = canWriteManagedComments()
    return html`<dialog aria-labelledby="comments-title" @close=${this._onClose}>
      <header><h3 id="comments-title">Comments</h3><p class="loc">${this.finding?.file ?? ''}</p></header>
      <section class="comments" aria-label="Comments">
        ${this._comments.map(comment => html`<article class="comment">
          <div class="byline"><strong>${comment.authorLogin ?? 'Unattributed'}</strong>
            <time datetime=${new Date(comment.createdAt).toISOString()}>${new Date(comment.createdAt).toLocaleString()}</time>
            ${comment.version > 1 ? html`<span>edited ${new Date(comment.updatedAt).toLocaleString()}</span>` : nothing}
            ${canWrite && comment.authorId === state.managedSession?.id
              ? html`<button type="button" ?disabled=${this._busy} @click=${() => this._edit(comment)}>Edit</button>` : nothing}
          </div><div class="body">${renderCommentText(comment.body)}</div>
        </article>`)}
        ${this._comments.length === 0 ? html`<p>${this._busy ? 'Loading comments…' : 'No comments yet.'}</p>` : nothing}
      </section>
      ${this._error ? html`<p class="error" role="alert">${this._error}</p>` : nothing}
      ${canWrite ? html`<label for="comment-body">${this._editing ? 'Edit your comment' : `Comment as ${state.managedSession.login}`}</label>
        <textarea id="comment-body" rows="4" maxlength=${MAX_COMMENT_TEXT} .value=${this._value}
          ?disabled=${this._busy} @input=${event => { this._value = event.target.value }} @keydown=${this._keydown}></textarea>` : nothing}
      <footer class="nwd-actions">
        <button type="button" ?disabled=${this._busy} @click=${this._refresh}>Refresh</button>
        <span class="nwd-spacer"></span>
        ${this._editing ? html`<button type="button" ?disabled=${this._busy} @click=${this._cancelEdit}>Cancel edit</button>` : nothing}
        <button type="button" @click=${this._close}>Close</button>
        ${canWrite ? html`<button type="button" class="primary" ?disabled=${this._busy || !this._value.trim()}
          @click=${this._save}>${this._editing ? 'Save changes' : 'Post comment'}</button>` : nothing}
      </footer>
    </dialog>`
  }
}
customElements.define('managed-comments-dialog', ManagedCommentsDialog)

export function openManagedCommentsDialog(finding, changed) {
  return openAppDialog('managed-comments-dialog', { finding, changed })
}
