import { html, nothing } from 'lit'
import { keyed } from 'lit/directives/keyed.js'

export function managedCommentAvatar(id, login) {
  if (!id) return nothing
  return keyed(id, html`<span class="managed-comment-avatar" aria-hidden="true">
    <span>${(login?.[0] ?? '?').toUpperCase()}</span>
    <img alt="" src=${`/api/avatar/${encodeURIComponent(id)}`} loading="lazy"
      @error=${event => { event.currentTarget.hidden = true }}>
  </span>`)
}

function commentTime(comment) {
  const edited = comment.version > 1 && comment.updatedAt != null
  const timestamp = comment.createdAt ?? (edited ? comment.updatedAt : null)
  if (timestamp == null) return nothing
  const date = new Date(timestamp)
  const title = [
    comment.createdAt == null ? '' : `Posted ${new Date(comment.createdAt).toLocaleString()}`,
    edited ? `Edited ${new Date(comment.updatedAt).toLocaleString()}` : '',
  ].filter(Boolean).join('\n')
  return html`<time class="managed-comment-time" datetime=${date.toISOString()} title=${title}>
    ${comment.createdAt == null ? 'edited ' : ''}${date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}${edited && comment.createdAt != null ? ' (edited)' : ''}
  </time>`
}

// Shared by finding cards and the discussion dialog. The caller supplies the
// linkified body and any author-only actions, keeping their event handlers local.
export function managedCommentTemplate(comment, body, actions = nothing) {
  return html`<div class="managed-comment"><div class="managed-comment-row">
    ${comment.authorId || comment.authorLogin ? html`<span class="managed-comment-author">
      ${managedCommentAvatar(comment.authorId, comment.authorLogin)}
      ${comment.authorLogin ? html`<strong title=${comment.authorLogin}>${comment.authorLogin}</strong>` : nothing}
    </span>` : nothing}
    <div class="managed-comment-body">${body}</div>
    ${commentTime(comment)}
    ${actions === nothing ? nothing : html`<div class="managed-comment-actions">${actions}</div>`}
  </div></div>`
}
