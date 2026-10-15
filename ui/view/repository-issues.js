// The code viewer's Issues and Pull requests tabs (render-bundle.js): the
// repository's issues or pull requests, the most recently updated first, as
// a grid of compact tiles rather than a list, those open or those closed, a
// page at a time as the end of the scroll nears. A tile shows its state,
// number, author and age, its title and labels, and a pull request's
// branches, size, review and checks; it opens on GitHub. The server reads
// them with the reader's own GitHub access (GET
// /api/admin/repositories/issues); what it answered is kept a while, for the
// session that read it.
import { LitElement, html, nothing } from 'lit'
import { classMap } from 'lit/directives/class-map.js'
import { styleMap } from 'lit/directives/style-map.js'
import { state } from '#client/index.js'
import { fetchRepositoryIssues } from './client-managed.js'
import { unwatchNearViewport, watchNearViewport } from './lazy-render.js'
import { compactTime } from './repository-history.js'
import { openRepositoryItemDialog } from './lazy-dialogs.js'
import { CHECKS, COMMENT_ICON, REVIEWS, STATE_ICONS, issueState, plainClick } from './repository-tiles.js'

export { issueState }

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

const compactThousands = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 2 })

// How many comments, as narrow as the rail is: whole below a thousand, else
// two digits at most and their unit ("1.2K", "12K").
export const commentCount = count => count < 1000 ? String(count) : compactThousands.format(count)

// A tile's labels, each by a dot of its color: the first few, then how many
// more.
function labelChips(item) {
  const more = item.labels.length - MAX_LABELS + (item.moreLabels ?? 0)
  return html`${item.labels.slice(0, MAX_LABELS).map(label => html`<span class="issue-label" style=${styleMap(label.color ? { '--label': `#${label.color}` } : {})} data-tooltip-truncated data-tooltip=${label.name}>${label.name}</span>`)}${more > 0
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
    // How many are open and closed, as the list shown read them, else as the
    // other did, the same repository's: switching keeps them while it reads.
    const other = sessionLists().get(`${this.repository.repoId}\0${this.kind}\0${listState === 'open' ? 'closed' : 'open'}`)
    const counts = ready ? entry.counts : other?.status === 'ready' ? other.counts : null
    const counted = which => counts ? html` <span class="issues-count">${counts[which].toLocaleString('en-US')}</span>` : nothing
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
          ? html`<a class="issue-body" href=${`https://github.com/${repo}/${path}/${item.number}`} target="_blank" rel="noopener noreferrer"
              @click=${event => this.openTile(event, item)}>${body}</a>`
          : html`<div class="issue-body" @click=${event => this.openTile(event, item)}>${body}</div>`}</li>`
      })}</ol>`}
      ${entry.more || entry.moreError ? html`<div class="history-more issues-more">
        ${entry.moreError ? html`<span role="alert">${entry.moreError}</span>` : nothing}
        <button type="button" ?disabled=${entry.loadingMore} @click=${more}>${entry.loadingMore ? 'Reading…' : 'More'}</button>
      </div>` : nothing}
    </div>`
  }

  // A tile clicked opens its popup, its link on GitHub in it; held with a
  // key, or another button, it opens on GitHub as a link does.
  openTile(event, item) {
    if (!plainClick(event)) return
    event.preventDefault()
    openRepositoryItemDialog({ repository: this.repository, target: { number: item.number, preview: { ...item, kind: this.kind } } })
  }

  // A tile: its state's icon, and under it a pull request's review and
  // checks and how many comments, as a rail beside its title, number, author
  // and age, labels, and a pull request's branches and size.
  renderTile(item, stateClass, stateName) {
    const pulls = this.kind === 'pulls'
    const time = item.updatedAt == null ? null : new Date(item.updatedAt)
    const checks = pulls && item.checks ? CHECKS[item.checks] : null
    const review = pulls && item.state === 'open' && item.review ? REVIEWS[item.review] : null
    const comments = item.comments > 0 ? `${item.comments.toLocaleString('en-US')} comment${item.comments === 1 ? '' : 's'}` : null
    const marked = (kind, [name, glyph]) => html`<span class=${`issue-${kind} is-${item[kind]}`} role="img" aria-label=${name} data-tooltip=${name}>${glyph}</span>`
    return html`<span class="issue-rail">
        <span class="issue-state" role="img" aria-label=${stateName}>${STATE_ICONS[this.kind][stateClass]}</span>
        ${pulls ? html`<span class="issue-marks">${review ? marked('review', review) : nothing}${checks ? marked('checks', checks) : nothing}</span>` : nothing}
        ${comments ? html`<span class="issue-comments" role="img" aria-label=${comments} data-tooltip=${comments}>${COMMENT_ICON}<span>${commentCount(item.comments)}</span></span>` : nothing}
      </span>
      <span class="issue-lines">
        <span class="issue-name">${item.title || '(no title)'}</span>
        <span class="issue-meta">
          <span class="issue-number">#${item.number}</span>
          <span class="issue-author">${item.author ?? 'ghost'}</span>
          ${time ? html`<time datetime=${time.toISOString()}>${compactTime(item.updatedAt)}</time>` : nothing}
        </span>
        ${item.labels.length > 0 || item.moreLabels > 0 ? html`<span class="issue-labels">${labelChips(item)}</span>` : nothing}
        ${pulls && item.head ? html`<span class="issue-branch"><code>${item.head}</code>${item.base ? html`<span aria-hidden="true">→</span><code>${item.base}</code>` : nothing}
          <span class="issue-diff"><span class="is-added">+${item.additions.toLocaleString('en-US')}</span> <span class="is-deleted">−${item.deletions.toLocaleString('en-US')}</span></span></span>` : nothing}
      </span>`
  }
}
if (!customElements.get('repository-issues')) customElements.define('repository-issues', RepositoryIssues)
