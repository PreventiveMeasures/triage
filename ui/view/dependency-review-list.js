import { LitElement, html, nothing } from 'lit'
import { appMarkup } from './markup.js'
import { managedRoutePath } from '../../common/managed/routes.js'
import { discardDependencyReview, myDependencyReviews, teamDependencyReviews } from './client-managed.js'
import { openDiscardReviewDialog } from './lazy-dialogs.js'
import { managedHistory } from './managed-history.js'
import { NEXT_ICON } from './lit-icons.js'
import { DELETE_ICON_SVG } from './icons.js'
import { sourceFileIcon } from './source-file-icon.js'
import { showToast } from './toast.js'
import { reviewAuthor, reviewBadge, reviewNote, reviewTitle, selectReviewOnOpen, verdictLabel } from './npm-review-presentation.js'

// A review's page: of its version against its base, as patched where it is
// a patched one's, the patch read where it was.
export const dependencyReviewRoute = review => ({ view: 'npm', packageName: review.package, packageSpec: review.version, bundleTab: 'review',
  ...(review.basePackage === null ? {} : { reviewPackage: review.basePackage, reviewSpec: review.baseVersion }),
  ...(review.patchHash && review.patchSource ? { patch: { hash: review.patchHash, ...review.patchSource } } : {}) })

const compactDate = time => {
  const date = new Date(time)
  return html`<time datetime=${date.toISOString()} data-tooltip=${date.toLocaleString()}>${date.toLocaleDateString(undefined,
    { month: 'short', day: 'numeric', ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) })}
    <span>${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span></time>`
}

// The reader's own reviews, drafts and published, as My reviews lists them;
// or, given a team (`team`, its id), those published to it, the latest
// first, by whom, as its Dependencies tab lists them, none to copy: copying
// the comment the server's host formats of a dependency review
// (dependency-review-copy.js) is for one's own.
export class DependencyReviewList extends LitElement {
  static properties = { session: { attribute: false }, team: { attribute: false }, _reviews: { state: true }, _loading: { state: true }, _error: { state: true },
    _next: { state: true }, _discarding: { state: true }, _expanded: { state: true } }
  constructor() { super(); this._reviews = []; this._next = null; this._expanded = new Set(); this._controller = new AbortController() }
  createRenderRoot() { return this }
  disconnectedCallback() { super.disconnectedCallback(); this._controller.abort(); this._dismissLoading?.(); this._key = null }
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
    this._dismissLoading?.()
    const dismiss = this._dismissLoading = showToast('Loading reviews…', { duration: 0 })
    this._loading = true
    this._error = null
    try {
      const cursor = more ? this._next : null
      const { reviews, next } = await (this.team ? teamDependencyReviews(this.team, cursor, this._controller.signal) : myDependencyReviews(cursor, this._controller.signal))
      if (key !== this._key) return
      this._reviews = [...new Map([...(more ? this._reviews : []), ...reviews].map(review => [review.id, review])).values()]
      this._next = next
    } catch (error) { if (key === this._key && error.name !== 'AbortError') this._error = error.message }
    finally { dismiss(); if (key === this._key) this._loading = false }
  }
  _toggleDetails(id) {
    const expanded = new Set(this._expanded)
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id)
    this._expanded = expanded
  }
  _details(review) {
    const entries = review.entries.filter(entry => entry.status)
    return html`<section id=${`review-details-${review.id}`} class="dependency-review-details" aria-label=${`Details for ${reviewTitle(review)}`}>
      ${review.comment ? html`<div class="dependency-review-final-note" role="note" aria-label="Final note">${reviewNote(review.comment)}</div>` : nothing}
      ${entries.length > 0 ? html`<ul class="dependency-review-entries">${entries.map(entry => html`<li>
        <span class="dependency-review-entry-file">${sourceFileIcon(entry.file)}<span>${entry.file}</span></span>
        ${verdictLabel(entry.status)}
        <div>${reviewNote(entry.comment)}</div></li>`)}</ul>` : html`<p class="npm-review-muted">No file reviews yet.</p>`}
    </section>`
  }
  _row(review) {
    const route = dependencyReviewRoute(review)
    const expanded = this._expanded.has(review.id), published = review.publishedAt !== null
    const checked = new Set(review.entries.filter(entry => entry.status).map(entry => entry.file)).size
    const notes = review.entries.filter(entry => entry.status && entry.comment.trim()).length + Number(Boolean(review.comment.trim()))
    const open = event => {
        if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && managedHistory?.active) {
          event.preventDefault(); selectReviewOnOpen(review); void managedHistory.navigate(route)
        }
    }
    return html`<li class=${`dependency-review-row${expanded ? ' is-expanded' : ''}${review.revokedAt === null ? '' : ' is-revoked'}`}><div class="dependency-review-row-main">
      <button type="button" class="dependency-review-expand" aria-expanded=${expanded} aria-controls=${`review-details-${review.id}`}
        aria-label=${`${expanded ? 'Hide' : 'Show'} details for ${reviewTitle(review)}`} @click=${() => this._toggleDetails(review.id)}>${NEXT_ICON}</button>
      <div class="dependency-review-identity"><a class="dependency-review-title" href=${managedRoutePath(route)} @click=${open}>
        ${review.basePackage !== null && review.basePackage !== review.package ? html`<span>${review.basePackage} ${review.baseVersion} → </span>` : nothing}
        <strong>${review.package}</strong> <span>${review.basePackage === review.package ? `${review.baseVersion} → ` : ''}${review.version}${review.patchHash
          ? html` <span class="dependency-review-patched">patched</span>` : nothing}</span></a>
        <div class="dependency-review-meta">${compactDate(review.publishedAt ?? review.time)}
          ${this.team ? html`<span class="dependency-review-author">${reviewAuthor(review)}</span>` : nothing}
          ${published && review.teams.length > 0 ? html`<span class="dependency-review-teams">${review.teams.map(team => team.name).join(', ')}</span>` : nothing}
          ${published && notes > 0 ? html`<span class="dependency-review-note-count">${notes} ${notes === 1 ? 'note' : 'notes'}</span>` : nothing}
          ${review.revokedAt === null ? nothing : reviewBadge(review)}</div></div>
      <div class="dependency-review-result">${published ? verdictLabel(review.status) : html`<span class="dependency-review-checked">${checked} ${checked === 1 ? 'file' : 'files'} checked</span>`}
        <span class="dependency-review-coverage">${published ? html`${review.coverage === 'full' ? 'Full' : html`<span class="dependency-review-partial">Partial</span>`} · ${review.checkedFiles}/${review.totalFiles} files checked`
          : notes ? `${notes} ${notes === 1 ? 'note' : 'notes'}` : 'No notes'}</span></div>
      <div class="dependency-review-row-actions">
        ${this.team ? nothing : html`<dependency-review-copy .text=${review.formatted}></dependency-review-copy>`}
        ${this._canDiscard(review) ? html`<button type="button" class="dependency-review-discard" aria-label="Discard review" ?disabled=${this._loading || Boolean(this._discarding)}
          @click=${() => this._discard(review)}>${appMarkup(DELETE_ICON_SVG)}</button>` : nothing}
        <a class="dependency-review-open" href=${managedRoutePath(route)} @click=${open} aria-label=${`${published ? 'Open' : 'Continue'} review for ${reviewTitle(review)}`}><span aria-hidden="true">→</span></a></div></div>
      ${expanded ? this._details(review) : nothing}
    </li>`
  }
  render() {
    const key = JSON.stringify([this.session?.id, this.session?.role, this.team ?? null])
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
    if (this.team) {
      return html`<section class="dependency-review-list is-team">
        ${this._error ? html`<p role="alert">${this._error}</p>` : nothing}
        ${!this._loading && !this._error && this._reviews.length === 0 ? html`<p class="npm-review-muted">No reviews are published to this team yet.</p>` : nothing}
        <ol>${this._reviews.map(review => this._row(review))}</ol>
        ${this._next ? html`<button type="button" class="npm-review-button" ?disabled=${this._loading} @click=${() => this._load(true)}>Load more</button>` : nothing}
      </section>`
    }
    return html`<section class="dependency-review-list">
      <header><h1>My reviews</h1></header>
      <p>Your private work and the reviews you’ve shared with teams.</p>
      ${this._error ? html`<p role="alert">${this._error}</p>` : nothing}
      ${!this._loading && !this._error && this._reviews.length === 0 ? html`<p>No reviews yet. Open a package’s Review tab to begin.</p>` : nothing}
      ${[['Drafts', false], ['Published reviews', true]].map(([label, published]) => {
        const reviews = this._reviews.filter(review => (review.publishedAt !== null) === published)
        return html`<section class="dependency-review-section"><h2>${label}<span class="npm-review-count">${reviews.length}</span></h2>
          <ol>${reviews.map(review => this._row(review))}</ol>${reviews.length === 0 && !this._loading ? html`<p class="npm-review-muted">${published ? 'No published reviews yet.' : 'No drafts.'}</p>` : nothing}</section>`
      })}
      ${this._next ? html`<button type="button" class="npm-review-button" ?disabled=${this._loading || Boolean(this._discarding)} @click=${() => this._load(true)}>Load more</button>` : nothing}
    </section>`
  }
}
customElements.define('dependency-review-list', DependencyReviewList)
