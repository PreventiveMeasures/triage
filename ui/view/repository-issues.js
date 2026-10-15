// The code viewer's Issues and Pull requests tabs (render-bundle.js): the
// repository's issues or pull requests, the most recently updated first, as
// a grid of compact tiles rather than a list, those open or those closed, a
// page at a time as the end of the scroll nears. A tile shows its state,
// number, author and age, its title and labels, and a pull request's
// branches, size, review and checks; it opens on GitHub. The server reads
// them with the reader's own GitHub access (GET
// /api/admin/repositories/issues); what it answered is kept a while, for the
// session that read it.
import { LitElement, html, nothing, svg } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { styleMap } from 'lit/directives/style-map.js'
import { state } from '#client/index.js'
import { fetchRepositoryIssues } from './client-managed.js'
import { unwatchNearViewport, watchNearViewport } from './lazy-render.js'
import { compactTime } from './repository-history.js'

const KEEP_MS = 5 * 60_000
const RETRY_MS = 30_000
const MAX_LABELS = 3

const lists = new Map()
const shownElements = new Set()
let keptFor = null
// Open or closed, as the reader last picked, for each kind.
const shownStates = { issues: 'open', pulls: 'open' }

function sessionLists() {
  const session = state.managedSession ? `${state.managedSession.id}\0${state.managedSession.role}` : null
  if (session !== keptFor) {
    lists.clear()
    keptFor = session
  }
  return lists
}

const repaint = () => { for (const element of shownElements) element.requestUpdate() }

// A server's answer, its items those it names by number.
function checked(answer) {
  if (!Array.isArray(answer?.items)) throw new Error('The server answered with no list.')
  const items = answer.items.filter(item => Number.isSafeInteger(item?.number) && typeof item.title === 'string' && Array.isArray(item.labels))
  return { items, counts: { open: answer.counts?.open ?? 0, closed: answer.counts?.closed ?? 0 }, more: answer.more === true, after: answer.more === true ? answer.after : null }
}

// The list `key` names, as held, else read: `{ status }`, 'loading', then
// 'ready' with its `items`, `counts`, and where more follow, the cursor
// reading them (`after`), or 'error' with its `error`; read again once old,
// or an error's retry is due.
function listRead(key, ask) {
  const data = sessionLists()
  const held = data.get(key)
  if (held && Date.now() < held.until) return held
  const loading = { status: 'loading', until: Number.POSITIVE_INFINITY }
  data.set(key, loading)
  ask(null).then(answer => {
    if (data.get(key) === loading) data.set(key, { status: 'ready', until: Date.now() + KEEP_MS, ...answer, loadingMore: false, moreError: null })
    return null
  }, err => {
    if (data.get(key) !== loading) return null
    if (err?.name === 'AbortError') data.delete(key)
    else data.set(key, { status: 'error', until: Date.now() + RETRY_MS, error: err?.message || 'The list could not be read.' })
    return null
  }).finally(repaint)
  return loading
}

// The next page of a list, after those it holds.
function readMore(key, entry, ask) {
  if (entry.loadingMore || !entry.more) return
  entry.loadingMore = true
  entry.moreError = null
  // Kept while the next page reads, however long it was held already.
  entry.until = Date.now() + KEEP_MS
  repaint()
  ask(entry.after).then(answer => {
    if (sessionLists().get(key) !== entry) return null
    const held = new Set(entry.items.map(item => item.number))
    entry.items = [...entry.items, ...answer.items.filter(item => !held.has(item.number))]
    entry.counts = answer.counts
    entry.more = answer.more
    entry.after = answer.after
    entry.until = Date.now() + KEEP_MS
    return null
  }, err => {
    if (err?.name !== 'AbortError') entry.moreError = err?.message || 'More could not be read.'
    return null
  }).finally(() => {
    entry.loadingMore = false
    repaint()
  })
}

// Those of `items` matching every word of `filter`: in its number, title,
// author, labels or branch.
export function filterIssues(items, filter) {
  const words = filter.trim().toLowerCase().split(/\s+/u).filter(Boolean)
  if (words.length === 0) return items
  return items.filter(item => {
    const text = [`#${item.number}`, item.title, item.author ?? '', item.head ?? '', ...item.labels.map(label => label.name)].join('\n').toLowerCase()
    return words.every(word => text.includes(word))
  })
}

// A tile's state, as its icon and stripe show it, and as its icon is named.
export function issueState(kind, item) {
  if (kind === 'pulls') {
    if (item.state === 'merged') return ['merged', 'Merged']
    if (item.state === 'closed') return ['closed', 'Closed']
    return item.draft ? ['draft', 'Draft'] : ['open', 'Open']
  }
  if (item.state === 'open') return ['open', 'Open']
  return item.reason === 'not-planned' || item.reason === 'duplicate' ? ['not-planned', item.reason === 'duplicate' ? 'Closed as duplicate' : 'Closed as not planned']
    : ['completed', 'Closed']
}

const icon = body => html`<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${body}</svg>`
const ring = svg`<circle cx="8" cy="8" r="6.25"/>`
const pull = svg`<circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><path d="M4.5 5.1v5.8"/><circle cx="11.5" cy="12.5" r="1.6"/>`
const STATE_ICONS = {
  issues: {
    open: icon(svg`${ring}<circle class="fill" cx="8" cy="8" r="1.6"/>`),
    completed: icon(svg`${ring}<path d="M5.4 8.3l1.8 1.8 3.4-3.7"/>`),
    'not-planned': icon(svg`${ring}<path d="M3.9 12.1l8.2-8.2"/>`),
  },
  pulls: {
    open: icon(svg`${pull}<path d="M11.5 10.9V6.5a2 2 0 0 0-2-2H7.4M8.9 3 7.4 4.5 8.9 6"/>`),
    draft: icon(svg`${pull}<path class="dotted" d="M11.5 10.9V4"/>`),
    merged: icon(svg`<circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><path d="M4.5 5.1v5.8M4.5 5.1c0 2.4 2.4 3.4 5.4 3.4"/><circle cx="11.5" cy="8.5" r="1.6"/>`),
    closed: icon(svg`${pull}<path d="M9.6 3.1l3.8 3.8M13.4 3.1 9.6 6.9"/>`),
  },
}
const COMMENT_ICON = icon(svg`<path d="M2.6 3.2h10.8v7.3H8l-3.2 2.6v-2.6H2.6z"/>`)
const CHECKS = {
  success: ['Checks passed', icon(svg`<path d="M3.5 8.4l2.9 2.9 6.1-6.6"/>`)],
  failure: ['Checks failed', icon(svg`<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>`)],
  pending: ['Checks running', icon(svg`<circle class="fill" cx="8" cy="8" r="3"/>`)],
}
const REVIEWS = { approved: 'Approved', changes: 'Changes requested', required: 'Review required' }

// A tile's labels, each by a dot of its color: the first few, then how many
// more.
function labelChips(item) {
  const more = item.labels.length - MAX_LABELS + (item.moreLabels ?? 0)
  return html`${item.labels.slice(0, MAX_LABELS).map(label => html`<span class="issue-label" style=${styleMap(label.color ? { '--label': `#${label.color}` } : {})}>${label.name}</span>`)}${more > 0
    ? html`<span class="issue-label is-more">+${more}</span>` : nothing}`
}

// The tab's body, for the repository a directory shown (`repository`, an
// entry's) is in: its issues, or its pull requests (`kind` 'pulls').
class RepositoryIssues extends LitElement {
  static properties = { repository: { attribute: false }, kind: {}, _filter: { state: true } }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.repository = null
    this.kind = 'issues'
    this._filter = ''
    this._moreButton = null
  }

  connectedCallback() {
    super.connectedCallback()
    shownElements.add(this)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    shownElements.delete(this)
    if (this._moreButton) unwatchNearViewport(this._moreButton)
    this._moreButton = null
  }

  // More read as their button nears the end of the scroll, a screen before
  // it shows, as though clicked, and again after each page while it stays
  // near; not after one failed, which waits for a click, nor while a filter
  // picks among those read, which could read them all. Watched again after
  // every update, so that whether it is near is where it is now.
  updated() {
    const button = this.querySelector('.issues-more > button')
    if (this._moreButton && this._moreButton !== button) unwatchNearViewport(this._moreButton)
    this._moreButton = button
    if (button) watchNearViewport(button, near => { if (near) this.readNear(button) })
  }

  readNear(button) {
    if (button === this._moreButton && button.isConnected && !button.disabled && !this._filter.trim() && !button.parentElement.querySelector('[role=alert]')) button.click()
  }

  list(listState) {
    const { repoId } = this.repository
    const kind = this.kind
    const key = `${repoId}\0${kind}\0${listState}`
    const ask = after => fetchRepositoryIssues(repoId, kind, { state: listState, after }).then(checked)
    const entry = listRead(key, ask)
    return { key, entry, more: () => readMore(key, entry, ask) }
  }

  pick(listState) {
    shownStates[this.kind] = listState
    repaint()
  }

  render() {
    if (!this.repository) return nothing
    const listState = shownStates[this.kind]
    const { key, entry, more } = this.list(listState)
    const ready = entry.status === 'ready'
    const noun = this.kind === 'pulls' ? 'pull requests' : 'issues'
    const counted = which => ready ? html` <span class="issues-count">${entry.counts[which].toLocaleString('en-US')}</span>` : nothing
    const shown = ready ? filterIssues(entry.items, this._filter) : []
    return html`<div class="history-bar issues-bar">
        <div class="history-modes" role="group" aria-label=${this.kind === 'pulls' ? 'Pull requests' : 'Issues'}>
          <button type="button" aria-pressed=${String(listState === 'open')} @click=${() => this.pick('open')}>Open${counted('open')}</button>
          <button type="button" aria-pressed=${String(listState === 'closed')} @click=${() => this.pick('closed')}>Closed${counted('closed')}</button>
        </div>
        <input class="issues-filter" type="search" placeholder="Filter" aria-label=${`Filter the ${noun} read`} .value=${this._filter}
          @input=${event => { this._filter = event.target.value }}>
        ${ready && this._filter.trim() ? html`<span class="history-summary">${shown.length} of ${entry.items.length} read</span>` : nothing}
      </div>
      ${ready ? this.renderTiles(entry, shown, more, `${listState} ${noun}`)
        : entry.status === 'error' ? html`<div class="bundles-slide-placeholder is-error"><p role="alert">${entry.error}</p>
            <button type="button" @click=${() => { sessionLists().delete(key); repaint() }}>Retry</button></div>`
        : html`<div class="bundles-slide-placeholder" role="status">Reading the ${noun}…</div>`}`
  }

  renderTiles(entry, shown, more, what) {
    if (entry.items.length === 0) return html`<div class="bundles-slide-placeholder">No ${what}.</div>`
    const repo = this.repository.repo
    const path = this.kind === 'pulls' ? 'pull' : 'issues'
    return html`<div class="issues-scroll">
      ${shown.length === 0 ? html`<p class="history-note">None of the ${what} read match.</p>` : html`<ol class="issues-grid" aria-label=${what}>${shown.map(item => {
        const [stateClass, stateName] = issueState(this.kind, item)
        const body = this.renderTile(item, stateClass, stateName)
        return html`<li class=${classMap({ 'issue-tile': true, [`is-${stateClass}`]: true })}>${repo
          ? html`<a class="issue-body" href=${`https://github.com/${repo}/${path}/${item.number}`} target="_blank" rel="noopener noreferrer">${body}</a>`
          : html`<div class="issue-body">${body}</div>`}</li>`
      })}</ol>`}
      ${entry.more || entry.moreError ? html`<div class="history-more issues-more">
        ${entry.moreError ? html`<span role="alert">${entry.moreError}</span>` : nothing}
        <button type="button" ?disabled=${entry.loadingMore} @click=${more}>${entry.loadingMore ? 'Reading…' : 'More'}</button>
      </div>` : nothing}
    </div>`
  }

  renderTile(item, stateClass, stateName) {
    const pulls = this.kind === 'pulls'
    const time = item.updatedAt == null ? null : new Date(item.updatedAt)
    const checks = pulls && item.checks ? CHECKS[item.checks] : null
    const review = pulls && item.state === 'open' && item.review ? REVIEWS[item.review] : null
    return html`<span class="issue-title">
        <span class="issue-state" role="img" aria-label=${stateName}>${STATE_ICONS[this.kind][stateClass]}</span>
        <span class="issue-name">${item.title || '(no title)'}</span>
      </span>
      <span class="issue-meta">
        <span class="issue-number">#${item.number}</span>
        <span class="issue-author">${item.author ?? 'ghost'}</span>
        ${time ? html`<time datetime=${time.toISOString()}>${compactTime(item.updatedAt)}</time>` : nothing}
        ${review ? html`<span class=${`issue-review is-${item.review}`}>${review}</span>` : nothing}
        ${labelChips(item)}
        <span class="issue-tail">
          ${checks ? html`<span class=${`issue-checks is-${item.checks}`} role="img" aria-label=${checks[0]}>${checks[1]}</span>` : nothing}
          ${item.comments > 0 ? html`<span class="issue-comments">${COMMENT_ICON}${item.comments}<span class="sr-only"> comment${item.comments === 1 ? '' : 's'}</span></span>` : nothing}
        </span>
      </span>
      ${pulls && item.head ? html`<span class="issue-branch"><code>${item.head}</code>${item.base ? html`<span aria-hidden="true">→</span><code>${item.base}</code>` : nothing}
        <span class="issue-diff"><span class="is-added">+${item.additions.toLocaleString('en-US')}</span> <span class="is-deleted">−${item.deletions.toLocaleString('en-US')}</span></span></span>` : nothing}`
  }
}
if (!customElements.get('repository-issues')) customElements.define('repository-issues', RepositoryIssues)
