import { LitElement, html, nothing } from 'lit'
import { summarizeReview } from '../../common/dependency-reviews.js'
import { managedRoutePath } from '../../common/managed/routes.js'
import { discardDependencyReview, myDependencyReviews } from './client-managed.js'
import { openDiscardReviewDialog } from './dialogs/discard-review-dialog.js'
import { managedHistory } from './managed-history.js'
import { reviewBadge, reviewDate, reviewNote, reviewTitle, selectReviewOnOpen, verdictLabel, verdictLabels } from './npm-review-presentation.js'

export const dependencyReviewRoute = review => ({ view: 'npm', packageName: review.package, packageSpec: review.version, bundleTab: 'review',
  ...(review.basePackage === null ? {} : { reviewPackage: review.basePackage, reviewSpec: review.baseVersion }) })

export class DependencyReviewList extends LitElement {
  static properties = { session: { attribute: false }, _reviews: { state: true }, _loading: { state: true }, _error: { state: true }, _next: { state: true }, _discarding: { state: true } }
  constructor() { super(); this._reviews = []; this._next = null; this._controller = new AbortController() }
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
  _row(review) {
    const route = dependencyReviewRoute(review)
    const published = review.publishedAt !== null
    const checked = new Set(review.entries.filter(entry => entry.file !== null && entry.status).map(entry => entry.file)).size
    const open = event => {
        if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && managedHistory?.active) {
          event.preventDefault(); selectReviewOnOpen(review); void managedHistory.navigate(route)
        }
    }
    return html`<li class="dependency-review-row"><div class="dependency-review-row-main"><div>
      <a href=${managedRoutePath(route)} @click=${open}>${review.package}</a>
      <p>${review.basePackage === null ? review.version : `${review.basePackage === review.package ? '' : `${review.basePackage} `}${review.baseVersion} → ${review.version}`}</p>
      <p>${reviewDate(review.publishedAt ?? review.time)}</p></div>
      <div>${published ? verdictLabel(review.status) : html`<strong>In progress</strong>`}<p>${published ? `${review.coverage === 'full' ? 'Full' : 'Partial'} · ${review.checkedFiles}/${review.totalFiles} files checked`
        : `${checked} files checked · ${verdictLabels[summarizeReview(review.entries, null).verdictLimit]}`}</p></div>
      <div>${reviewBadge(review)}<p>${published ? review.teams.map(team => team.name).join(', ') : 'Not shared'}</p></div>
      <div class="dependency-review-row-actions"><a href=${managedRoutePath(route)} @click=${open}>${published ? 'View review' : 'Continue'} →</a>
        <review-audit-copy .review=${review}></review-audit-copy>
        ${this._canDiscard(review) ? html`<button type="button" class="npm-review-danger" ?disabled=${this._loading || Boolean(this._discarding)} @click=${() => this._discard(review)}>Discard</button>` : nothing}</div></div>
      <details><summary>${review.entries.length} file reviews and notes${review.comment ? ' · Final note' : ''}</summary>
        ${reviewNote(review.comment)}<ul>${review.entries.map(entry => html`<li><strong>${entry.file ?? 'Whole diff'}</strong> · ${verdictLabels[entry.status] ?? 'Note'}${reviewNote(entry.comment)}</li>`)}</ul>
      </details>
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
