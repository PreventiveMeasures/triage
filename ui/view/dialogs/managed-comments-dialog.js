import { html, nothing, unsafeCSS } from 'lit'
import { state } from '#client/index.js'
import { MAX_COMMENT_TEXT } from '../../../common/managed/comments.ts'
import { canWriteManagedComments, deleteManagedComment, loadManagedReportComments, managedCommentScope, managedCommentsFor, writeManagedComment } from '../managed-comments.js'
import { renderCommentText } from '../render-finding.js'
import { managedCommentAvatar, managedCommentTemplate } from '../managed-comment.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import commentCSS from './dialog-comment.css'
import managedCommentCSS from '../managed-comment.css'
import threadCSS from './dialog-managed-comments.css'

class ManagedCommentsDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(commentCSS), unsafeCSS(managedCommentCSS), unsafeCSS(threadCSS)]
  static properties = {
    finding: { attribute: false }, changed: { attribute: false },
    _comments: { state: true }, _value: { state: true }, _editing: { state: true },
    _busy: { state: true }, _error: { state: true }, _deleting: { state: true },
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
    this._deleting = null
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
    void this._refresh({ scroll: true })
  }
  _close = () => this._finish(null)
  _scrollToLatest = async () => {
    await this.updateComplete
    const thread = this.renderRoot.querySelector('.discussion-log')
    if (thread) thread.scrollTop = thread.scrollHeight
  }
  _refresh = async ({ scroll = false } = {}) => {
    if (!this._current()) { this._close(); return }
    const thread = this.renderRoot.querySelector('.discussion-log')
    const atBottom = thread && thread.scrollHeight - thread.scrollTop - thread.clientHeight < 32
    this._busy = true
    this._error = ''
    const ok = await loadManagedReportComments(this.finding._managedReportId)
    if (!this.isConnected) return
    if (!this._current()) { this._close(); return }
    this._busy = false
    if (!ok) { this._error = 'Could not load comments. Please retry.'; return }
    this._comments = managedCommentsFor(this.finding)
    this.changed?.()
    if (scroll || atBottom) void this._scrollToLatest()
  }
  _edit(comment) {
    this._deleting = null
    this._editing = comment
    this._value = comment.body
    this._error = ''
    void this.updateComplete.then(() => this.renderRoot.querySelector('textarea')?.focus())
  }
  _cancelEdit = () => { this._editing = null; this._value = ''; this._error = '' }
  _delete = async (comment) => {
    if (this._busy || !this._current()) return
    this._busy = true
    this._error = ''
    const status = await deleteManagedComment(this.finding, comment)
    if (!this.isConnected) { if (status === 204 && this._current()) this.changed?.(); return }
    if (!this._current()) { this._close(); return }
    this._busy = false
    this._deleting = null
    if (status === 409) {
      await this._refresh()
      if (this.isConnected) this._error = 'This comment changed elsewhere. Review the latest version before deleting it.'
      return
    }
    if (status !== 204) {
      this._error = status === 403 || status === 404
        ? 'This comment is unavailable or you no longer have permission to delete it.' : 'Could not delete the comment. Please retry.'
      return
    }
    this._comments = managedCommentsFor(this.finding)
    if (this._editing?.id === comment.id) this._cancelEdit()
    this.changed?.()
  }
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
    const wasEditing = this._editing != null
    this._comments = managedCommentsFor(this.finding)
    this._cancelEdit()
    this.changed?.()
    if (!wasEditing) await this._scrollToLatest()
    await this.updateComplete
    this.renderRoot.querySelector('textarea')?.focus()
  }
  _keydown = (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void this._save() }
  }

  _commentActions(comment, canWrite) {
    if (!canWrite || comment.authorId !== state.managedSession?.id) return nothing
    return this._deleting === comment.id
      ? html`<span>Delete comment?</span>
        <button type="button" ?disabled=${this._busy} @click=${() => { this._deleting = null }}>Cancel</button>
        <button type="button" class="danger" ?disabled=${this._busy} @click=${() => this._delete(comment)}>Delete</button>`
      : html`<button type="button" ?disabled=${this._busy} @click=${() => this._edit(comment)}>Edit</button>
        <button type="button" ?disabled=${this._busy} @click=${() => { this._deleting = comment.id }}>Delete</button>`
  }

  render() {
    const canWrite = canWriteManagedComments()
    return html`<dialog aria-labelledby="comments-title" @close=${this._onClose}>
      <header class="discussion-header">
        <div class="discussion-heading"><h3 id="comments-title">Discussion <span class="comment-count">${this._comments.length}</span></h3>
          ${this.finding?.title ? html`<p class="discussion-finding">${this.finding.title}</p>` : nothing}
          <p class="loc">${this.finding?.file ?? ''}</p></div>
        <div class="header-actions">
          <button type="button" ?disabled=${this._busy} @click=${() => this._refresh()}>Refresh</button>
          <button type="button" class="close" aria-label="Close discussion" @click=${this._close}>×</button>
        </div>
      </header>
      <section class="discussion-log" role="log" aria-label="Discussion" aria-relevant="additions text" aria-busy=${this._busy}>
        <ol class="comments">${this._comments.map(comment => html`<li class=${`comment${this._editing?.id === comment.id ? ' editing' : ''}`}>
          ${managedCommentTemplate(comment, renderCommentText(comment.body), this._commentActions(comment, canWrite))}
        </li>`)}</ol>
        ${this._comments.length === 0 ? html`<p class="empty-discussion">${this._busy ? 'Loading discussion…' : canWrite ? 'No comments yet. Start the discussion below.' : 'No comments yet.'}</p>` : nothing}
      </section>
      ${this._error ? html`<p class="error" role="alert">${this._error}</p>` : nothing}
      ${canWrite ? html`<form class="composer" @submit=${event => { event.preventDefault(); void this._save() }}>
        <label class="composer-label" for="comment-body">${managedCommentAvatar(state.managedSession.id, state.managedSession.login)}
          ${this._editing ? 'Edit your comment' : html`Reply as <strong>${state.managedSession.login}</strong>`}</label>
        <textarea id="comment-body" rows="3" maxlength=${MAX_COMMENT_TEXT} .value=${this._value} placeholder="Write a comment…"
          aria-describedby="comment-shortcut" ?disabled=${this._busy} @input=${event => { this._value = event.target.value }} @keydown=${this._keydown}></textarea>
        <footer class="nwd-actions">
          <span id="comment-shortcut" class="shortcut">Ctrl / ⌘ + Enter to send</span><span class="nwd-spacer"></span>
          ${this._editing ? html`<button type="button" class="quiet" ?disabled=${this._busy} @click=${this._cancelEdit}>Cancel edit</button>` : nothing}
          <button type="submit" class="primary" ?disabled=${this._busy || !this._value.trim()}>
            ${this._editing ? 'Save changes' : 'Comment'}</button>
        </footer>
      </form>` : html`<p class="read-only">You have read-only access to this discussion.</p>`}
    </dialog>`
  }
}
customElements.define('managed-comments-dialog', ManagedCommentsDialog)

export function openManagedCommentsDialog(finding, changed) {
  return openAppDialog('managed-comments-dialog', { finding, changed })
}
