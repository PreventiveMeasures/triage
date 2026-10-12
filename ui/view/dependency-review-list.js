import { LitElement, html, nothing } from 'lit'
import { managedRoutePath } from '../../common/managed/routes.js'
import { discardDependencyReview, myDependencyReviews } from './client-managed.js'
import { openDiscardReviewDialog } from './dialogs/discard-review-dialog.js'
import { managedHistory } from './managed-history.js'
import { NEXT_ICON } from './lit-icons.js'
import { reviewBadge, reviewNote, reviewTitle, selectReviewOnOpen, verdictLabel } from './npm-review-presentation.js'

export const dependencyReviewRoute = review => ({ view: 'npm', packageName: review.package, packageSpec: review.version, bundleTab: 'review',
  ...(review.basePackage === null ? {} : { reviewPackage: review.basePackage, reviewSpec: review.baseVersion }) })

const compactDate = time => {
  const date = new Date(time)
  return html`<time datetime=${date.toISOString()} data-tooltip=${date.toLocaleString()}>${date.toLocaleDateString(undefined,
    { month: 'short', day: 'numeric', ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) })}
    <span>${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span></time>`
}

export class DependencyReviewList extends LitElement {
  static properties = { session: { attribute: false }, _reviews: { state: true }, _loading: { state: true }, _error: { state: true },
    _next: { state: true }, _discarding: { state: true }, _expanded: { state: true } }
  constructor() { super(); this._reviews = []; this._next = null; this._expanded = new Set(); this._controller = new AbortController() }
  createRenderRoot() { return this }
  disconnectedCallback() { super.disconnectedCallback(); this._controller.abort(); this._key = null }
  _canDiscard(review) { return review.publishedAt === null && review.user === this.session?.id && ['triage', 'manage', 'admin'].includes(this.session?.role) }
  async _discard(review) {
    if (!this._canDiscard(review) || this._discarding || this._loading) return
    const key = this._key, signal = this._controller.signal
    this._discarding = review.id
    this._error = null
    try {
      const { confirmed } = await openDiscardReviewDialog({ reviewTitle: reviewTitle(review), signal })
      if (!confirmed || signal.aborted || key !== this._key || !this._canDiscard(review)) return
      await discardDependencyReview(review.id, review.revision, this.session.csrfToken, signal)
      if (key !== this._key || signal.aborted) return
      this._reviews = this._reviews.filter(row => row.id !== review.id)
    } catch (error) { if (key === this._key && error.name !== 'AbortError') this._error = error.message }
    finally { if (key === this._key) this._discarding = null }
  }
  async _load(more = false) {
    const key = this._key
    this._loading = true
    this._error = null
    try {
      const { reviews, next } = await myDependencyReviews(more ? this._next : null, this._controller.signal)
      if (key !== this._key) return
      this._reviews = [...new Map([...(more ? this._reviews : []), ...reviews].map(review => [review.id, review])).values()]
      this._next = next
    } catch (error) { if (key === this._key && error.name !== 'AbortError') this._error = error.message }
    finally { if (key === this._key) this._loading = false }
  }
  _toggleDetails(id) {
    const expanded = new Set(this._expanded)
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id)
    this._expanded = expanded
  }
  _details(review) {
    return html`<section id=${`review-details-${review.id}`} class="dependency-review-details" aria-label=${`Details for ${reviewTitle(review)}`}>
      ${review.teams.length > 0 ? html`<p class="dependency-review-recipients">Published to ${review.teams.map(team => team.name).join(', ')}</p>` : nothing}
      ${review.comment ? html`<div class="dependency-review-final-note"><strong>Final note</strong>${reviewNote(review.comment)}</div>` : nothing}
      ${review.entries.length > 0 ? html`<ul class="dependency-review-entries">${review.entries.map(entry => html`<li>
        <div class="dependency-review-entry-head"><span>${entry.file ?? 'Review note'}</span>${entry.status ? verdictLabel(entry.status) : nothing}</div>
        ${reviewNote(entry.comment)}</li>`)}</ul>` : html`<p class="npm-review-muted">No file reviews yet.</p>`}
    </section>`
  }
  _row(review) {
    const route = dependencyReviewRoute(review)
    const expanded = this._expanded.has(review.id), published = review.publishedAt !== null
    const checked = new Set(review.entries.filter(entry => entry.file !== null && entry.status).map(entry => entry.file)).size
    const notes = review.entries.filter(entry => entry.comment.trim()).length + Number(Boolean(review.comment.trim()))
    const open = event => {
        if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && managedHistory?.active) {
          event.preventDefault(); selectReviewOnOpen(review); void managedHistory.navigate(route)
        }
    }
    return html`<li class=${`dependency-review-row${expanded ? ' is-expanded' : ''}`}><div class="dependency-review-row-main">
      <button type="button" class="dependency-review-expand" aria-expanded=${expanded} aria-controls=${`review-details-${review.id}`}
        aria-label=${`${expanded ? 'Hide' : 'Show'} details for ${reviewTitle(review)}`} @click=${() => this._toggleDetails(review.id)}>${NEXT_ICON}</button>
      <div class="dependency-review-identity"><a class="dependency-review-title" href=${managedRoutePath(route)} @click=${open}>
        ${review.basePackage !== null && review.basePackage !== review.package ? html`<span>${review.basePackage} ${review.baseVersion} → </span>` : nothing}
        <strong>${review.package}</strong> <span>${review.basePackage === review.package ? `${review.baseVersion} → ` : ''}${review.version}</span></a>
        <div class="dependency-review-meta">${compactDate(review.publishedAt ?? review.time)}
          ${published && review.teams.length > 0 ? html`<span class="dependency-review-teams">${review.teams.map(team => team.name).join(', ')}</span>` : nothing}
          ${published && notes > 0 ? html`<span class="dependency-review-note-count">${notes} ${notes === 1 ? 'note' : 'notes'}</span>` : nothing}
          ${review.revokedAt === null ? nothing : reviewBadge(review)}</div></div>
      <div class="dependency-review-result">${published ? verdictLabel(review.status) : html`<span class="dependency-review-checked">${checked} ${checked === 1 ? 'file' : 'files'} checked</span>`}
        <span class="dependency-review-coverage">${published ? `${review.coverage === 'full' ? 'Full' : 'Partial'} · ${review.checkedFiles}/${review.totalFiles} files checked`
          : notes ? `${notes} ${notes === 1 ? 'note' : 'notes'}` : 'No notes'}</span></div>
      <div class="dependency-review-row-actions">
        <review-audit-copy .review=${review}></review-audit-copy>
        ${this._canDiscard(review) ? html`<button type="button" class="dependency-review-discard" ?disabled=${this._loading || Boolean(this._discarding)} @click=${() => this._discard(review)}>Discard</button>` : nothing}
        <a class="dependency-review-open" href=${managedRoutePath(route)} @click=${open} aria-label=${`${published ? 'Open' : 'Continue'} review for ${reviewTitle(review)}`}
          data-tooltip=${published ? 'Open review' : 'Continue review'}><span aria-hidden="true">→</span></a></div></div>
      ${expanded ? this._details(review) : nothing}
    </li>`
  }
  render() {
    const key = JSON.stringify([this.session?.id, this.session?.role])
    if (key !== this._key) {
      this._controller.abort()
      this._controller = new AbortController()
      this._key = key
      this._reviews = []
      this._next = null
      this._discarding = null
      this._expanded = new Set()
      void this._load()
    }
    return html`<section class="dependency-review-list">
      <header><h1>My reviews</h1></header>
      <p>Your private work and the reviews you’ve shared with teams.</p>
      ${this._error ? html`<p role="alert">${this._error}</p>` : nothing}
      ${this._loading ? html`<p role="status">Loading reviews…</p>` : nothing}
      ${!this._loading && !this._error && this._reviews.length === 0 ? html`<p>No reviews yet. Open a package’s Review tab to begin.</p>` : nothing}
      ${[['In progress', false], ['Published reviews', true]].map(([label, published]) => {
        const reviews = this._reviews.filter(review => (review.publishedAt !== null) === published)
        return html`<section class="dependency-review-section"><h2>${label}<span class="npm-review-count">${reviews.length}</span></h2>
          <ol>${reviews.map(review => this._row(review))}</ol>${reviews.length === 0 && !this._loading ? html`<p class="npm-review-muted">${published ? 'No published reviews yet.' : 'No reviews in progress.'}</p>` : nothing}</section>`
      })}
      ${this._next ? html`<button type="button" ?disabled=${this._loading || Boolean(this._discarding)} @click=${() => this._load(true)}>Load more</button>` : nothing}
    </section>`
  }
}
customElements.define('dependency-review-list', DependencyReviewList)
