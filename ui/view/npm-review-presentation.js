import { html, nothing } from 'lit'
import { REVIEW_VERDICTS, parseReviewNotes } from '../../common/dependency-reviews.js'

export const verdictLabels = { ...REVIEW_VERDICTS, 'accept-with-nits': 'Accept with nits' }
export const reviewState = review => review.revokedAt === null ? review.publishedAt === null ? 'Draft' : 'Published' : 'Revoked'
const symbols = { accept: '✓', 'accept-with-nits': '·', 'request-changes': '!', reject: '×' }
export const verdictIcon = status => html`<span class=${`npm-review-verdict-icon ${status ?? 'unchecked'}`} aria-hidden="true">${symbols[status] ?? ''}</span>`
export const verdictLabel = status => html`<span class="npm-review-verdict">${verdictIcon(status)}${verdictLabels[status] ?? 'Not reviewed'}</span>`
export const reviewBadge = review => html`<span class=${`npm-review-badge ${review.revokedAt === null ? review.publishedAt === null ? '' : 'published' : 'revoked'}`}>${reviewState(review)}</span>`
export const reviewDate = time => html`<time datetime=${new Date(time).toISOString()}>${new Date(time).toLocaleString()}</time>`
export const reviewProgress = (checked, total) => html`<div class="npm-review-progress" role="progressbar" aria-label="Files checked"
  aria-valuemin="0" aria-valuemax=${total || 1} aria-valuenow=${checked}><span style=${`width:${total ? checked / total * 100 : 0}%`}></span></div>`

export function reviewFileStates(entries = [], nonTextFiles = []) {
  const nonText = new Set(nonTextFiles)
  return new Map(entries.map(entry =>
    [entry.file, { status: nonText.has(entry.file) ? null : entry.status, notes: Number(Boolean(entry.comment.trim())) }]))
}

export function reviewNote(comment) {
  const notes = parseReviewNotes(comment)
  if (notes.length === 0) return nothing
  const bullets = notes.filter(note => note.bullet)
  return html`${notes.filter(note => !note.bullet).map(note => html`<p class="npm-review-note">${note.text}</p>`)}
    ${bullets.length > 0 ? html`<ul class="npm-review-note npm-review-note-list">${bullets.map(note => html`<li>${note.text}</li>`)}</ul>` : nothing}`
}

// A list row opens that exact snapshot, even when a newer private set exists.
// Keep this handoff inside review components, without changing app routing.
let selection = null
export const sameReviewContext = (a, b) => ['ecosystem', 'package', 'version', 'integrity', 'basePackage', 'baseVersion', 'baseIntegrity'].every(key => a[key] === b[key])
export function selectReviewOnOpen(review, continueReview = false) { selection = { review, continueReview } }
export function takeReviewSelection(context) {
  if (!selection || !sameReviewContext(selection.review, context)) return null
  const next = selection
  selection = null
  return next
}


export function reviewTitle(context) {
  const target = `${context.package} ${context.version}`
  if (!context.basePackage) return target
  return context.basePackage === context.package
    ? `${context.package} ${context.baseVersion} -> ${context.version}`
    : `${context.basePackage} ${context.baseVersion} -> ${target}`
}
