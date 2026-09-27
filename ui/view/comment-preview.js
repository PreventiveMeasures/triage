import { css, html, nothing, unsafeCSS } from 'lit'
import { isManagedUiMode } from '#client/index.js'
import { HoverPreviewElement } from './hover-preview.js'
import { managedCommentsFor, subscribeManagedComments } from './managed-comments.js'
import { managedCommentTemplate } from './managed-comment.js'
import { renderCommentText } from './comment-text.js'
import managedCommentCss from './managed-comment.css'

class CommentPreview extends HoverPreviewElement {
  static properties = { finding: { attribute: false }, comment: { type: String } }
  static styles = [HoverPreviewElement.styles, unsafeCSS(managedCommentCss), css`
    :host { display: inline-flex; }
    button { border: 0; padding: 0; background: none; color: inherit; font: inherit; cursor: default; }
    .preview-trigger { display: inline-flex; align-items: center; justify-content: center; line-height: 0; }
    .preview-trigger:hover { color: var(--accent); }
    .managed-comment + .managed-comment { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
    .comment-body { white-space: pre-wrap; }
    .comment-body a { color: var(--accent); text-decoration: none; }
    .comment-body a:hover { text-decoration: underline; }
    .preview-footer { display: flex; justify-content: flex-end; margin-top: 8px; }
    .edit-hint { color: var(--muted); font-size: 12px; }
    .edit-hint:hover { color: var(--accent); }
  `]

  constructor() {
    super()
    this.finding = null
    this.comment = ''
    this.unsubscribe = null
  }

  connectedCallback() {
    super.connectedCallback()
    this._subscribe()
    document.addEventListener('managed-comments-reset', this._resetComments)
    if (this.hasUpdated) this.requestUpdate()
  }

  disconnectedCallback() {
    this.unsubscribe?.()
    this.unsubscribe = null
    document.removeEventListener('managed-comments-reset', this._resetComments)
    super.disconnectedCallback()
  }

  updated(changed) {
    if (changed.has('finding')) {
      this._hidePreview()
      this._subscribe()
    }
    super.updated(changed)
  }

  _subscribe() {
    this.unsubscribe?.()
    this.unsubscribe = this.finding?.id
      ? subscribeManagedComments(this.finding.id, () => this.requestUpdate()) : null
  }

  _resetComments = () => {
    this._hidePreview()
    this.requestUpdate()
  }

  _previewClick(event) {
    // Let links reach the finding-navigation delegate and buttons open the
    // existing comments dialog. The host's kanban-action class keeps both
    // from also opening the card's detail popover.
    if (event.target.closest('a, button')) this._hidePreview()
  }

  render() {
    const managed = isManagedUiMode()
    const comments = managed ? managedCommentsFor(this.finding) : []
    const hasComments = managed ? comments.length > 0 : Boolean(this.comment)
    const bodies = managed ? comments.map(comment => comment.body) : [this.comment]
    const wide = bodies.some(body => body.split(/[\r\n]/u).some(line => line.length > 100))
    return html`<button type="button" class="preview-trigger mark-comment" aria-label=${managed ? 'View comments' : 'Edit comment'}
      aria-details=${hasComments ? 'comment-preview' : nothing}
      @mouseenter=${this._schedulePreview} @mouseleave=${this._leavePreview}
      @focus=${this._schedulePreview} @blur=${this._leavePreview} @click=${this._hidePreview}>
      <slot></slot>
    </button>${hasComments ? html`<div class=${wide ? 'preview wide' : 'preview'} id="comment-preview" popover="manual"
      role="region" aria-label=${managed ? 'Comments' : 'Comment'}
      @mouseenter=${this._keepPreview} @mouseleave=${this._leavePreview}
      @focusin=${this._keepPreview} @focusout=${this._leavePreview} @click=${this._previewClick}>
      ${managed ? comments.map(comment => managedCommentTemplate(comment, renderCommentText(comment.body)))
        : html`<div class="comment-body">${renderCommentText(this.comment)}</div>
          <div class="preview-footer"><button type="button" class="mark-comment edit-hint">Edit</button></div>`}
    </div>` : nothing}`
  }
}

customElements.define('comment-preview', CommentPreview)
