import { html, nothing } from 'lit'
import { REVIEW_VERDICTS } from '../../common/dependency-reviews.js'

export const verdictLabels = { ...REVIEW_VERDICTS, 'accept-with-nits': 'Accept with nits' }
export const reviewState = review => review.revokedAt === null ? review.publishedAt === null ? 'Private to you' : 'Published' : 'Revoked'
const symbols = { accept: '✓', 'accept-with-nits': '·', 'request-changes': '!', reject: '×' }
export const verdictIcon = status => html`<span class=${`npm-review-verdict-icon ${status ?? 'unchecked'}`} aria-hidden="true">${symbols[status] ?? ''}</span>`
export const verdictLabel = status => html`<span class="npm-review-verdict">${verdictIcon(status)}${verdictLabels[status] ?? 'Not reviewed'}</span>`
export const reviewBadge = review => html`<span class=${`npm-review-badge ${review.revokedAt === null ? review.publishedAt === null ? '' : 'published' : 'revoked'}`}>${reviewState(review)}</span>`
export const reviewDate = time => html`<time datetime=${new Date(time).toISOString()}>${new Date(time).toLocaleString()}</time>`
export const reviewProgress = (checked, total) => html`<div class="npm-review-progress" role="progressbar" aria-label="Files checked"
  aria-valuemin="0" aria-valuemax=${total || 1} aria-valuenow=${checked}><span style=${`width:${total ? checked / total * 100 : 0}%`}></span></div>`

// Older sets can contain several notes/verdicts for a file. Keep all of them:
// its least favorable verdict is the same constraint publication uses.
export function reviewFileStates(entries = []) {
  const order = Object.keys(REVIEW_VERDICTS), states = new Map()
  for (const entry of entries) {
    if (entry.file === null) continue
    const current = states.get(entry.file) ?? { status: null, notes: 0 }
    if (order.indexOf(entry.status) > order.indexOf(current.status)) current.status = entry.status
    if (entry.comment.trim()) current.notes++
    states.set(entry.file, current)
  }
  return states
}

export const reviewNote = comment => comment ? html`<p class="npm-review-note">${comment}</p>` : nothing

// A list row opens that exact snapshot, even when a newer private set exists.
// Keep this handoff inside review components, without changing app routing.
let selection = null
export function selectReviewOnOpen(review) { selection = review }
export function takeReviewSelection(context) {
  if (!selection || !['ecosystem', 'package', 'version', 'integrity', 'basePackage', 'baseVersion', 'baseIntegrity'].every(key => selection[key] === context[key])) return null
  const { id } = selection
  selection = null
  return id
}


export function reviewTitle(context) {
  const target = `${context.package} ${context.version}`
  if (!context.basePackage) return target
  return context.basePackage === context.package
    ? `${context.package} ${context.baseVersion} -> ${context.version}`
    : `${context.basePackage} ${context.baseVersion} -> ${target}`
}
