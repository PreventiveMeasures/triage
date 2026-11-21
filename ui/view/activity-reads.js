// What the code viewer's repository views (repository-*.js) share in how they
// read and show what they read: kept for the session that read it, drawn
// again as it changes, a list read on a page at a time, and the body shown
// while a read is pending or failed.
import { html, nothing } from 'lit'
import { state } from '#client/index.js'
import { heldRead } from './held-read.js'
import { openRepositoryItemDialog } from './lazy-dialogs.js'
import { unwatchNearViewport, watchNearViewport } from './lazy-render.js'

// How long a read is kept, and how long after one failed it is read again.
export const KEEP_MS = 5 * 60_000
export const RETRY_MS = 30_000

// A count as the views write it.
export const number = value => value.toLocaleString('en-US')

// The session, and its role, a read is kept for.
export const sessionOf = () => state.managedSession ? `${state.managedSession.id}\0${state.managedSession.role}` : null

// `collections`, each emptied as another session asks for them; answers the first.
export function sessionKept(...collections) {
  let keptFor = null
  return () => {
    const session = sessionOf()
    if (session !== keptFor) {
      for (const collection of collections) collection.clear()
      keptFor = session
    }
    return collections[0]
  }
}

// A read's failure as held-read.js holds it, read again RETRY_MS after; none for an abort.
export const failedRead = (err, message) => err?.name === 'AbortError' ? null
  : { status: 'error', until: Date.now() + RETRY_MS, error: err?.message || message }

// What `key` names in `data`, as held, else read by `ask` (held-read.js):
// `ready`'s entry of its answer, kept KEEP_MS; a failure as `failed` holds
// it, failedRead's by `message` but where given, read again RETRY_MS after.
export const keptRead = (data, key, ask, { ready, message, failed = err => failedRead(err, message), settled, repaint }) => heldRead(data, key, ask, {
  ready: answer => ({ status: 'ready', until: Date.now() + KEEP_MS, ...ready(answer) }), failed, settled, retryMs: RETRY_MS, repaint,
})

// A list the session keeps in `kept()`, read a page at a time (keptRead):
// its first by `first`, `ready`'s entry of it; the next (`more`) by
// `next(entry.after)`, its cursor and whether more follow taken and the
// rest added by `merge` while it is still the one held (readMore).
export function pagedRead(kept, key, { first, next, ready, merge, message, repaint }) {
  const entry = keptRead(kept(), key, first, { ready: answer => ready({ ...answer, loadingMore: false, moreError: null }), message, repaint })
  return { key, entry, more: () => readMore(entry, { held: () => kept().get(key) === entry, ask: () => next(entry.after), error: 'More could not be read.', repaint,
    merge: answer => {
      entry.more = answer.more
      entry.after = answer.after
      merge(entry, answer)
    } }) }
}

// `list` and those of `more` it lacks, by `key`.
export function withNew(list, more, key) {
  const held = new Set(list.map(key))
  return [...list, ...more.filter(item => !held.has(key(item)))]
}

// Those of `items` whose words (`words`) hold every one of `filter`'s, in any case.
export function filtered(items, filter, words) {
  const wanted = filter.trim().toLowerCase().split(/\s+/u).filter(Boolean)
  return wanted.length === 0 ? items : items.filter(item => {
    const text = words(item).join('\n').toLowerCase()
    return wanted.every(word => text.includes(word))
  })
}

// A click to open a tile's popup: the main button's, none held with it, which
// would open its link in a new tab or window instead.
const plainClick = event => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

// A subclass of `Base` whose connected elements are `shown`, all drawn again
// by `repaint`: each a view, drawn in itself, of the directory shown
// (`repository`, an entry's) in the repository it names, by its full name
// (`repo`, repository-code.js repositoryFullName, once known).
export function shownElements(Base) {
  const shown = new Set()
  const repaint = () => { for (const element of shown) element.requestUpdate() }
  class Shown extends Base {
    static properties = { repository: { attribute: false }, repo: { attribute: false } }

    createRenderRoot() { return this }

    constructor() {
      super()
      this.repository = null
      this.repo = null
    }

    connectedCallback() {
      super.connectedCallback()
      shown.add(this)
    }

    disconnectedCallback() {
      super.disconnectedCallback()
      shown.delete(this)
      if (this._moreButton) unwatchNearViewport(this._moreButton)
      this._moreButton = null
    }

    // The next page read as its button nears the end of the scroll, a screen
    // before it shows, as though clicked, and again after each page while it
    // stays near; not after one failed, which waits for a click, nor while
    // `reads()` says not. Watched again after every update, so whether it is
    // near is where it is now, below what that update added.
    watchMore(reads) {
      const button = this.querySelector('.history-more > button')
      if (this._moreButton && this._moreButton !== button) unwatchNearViewport(this._moreButton)
      this._moreButton = button
      if (!button) return
      watchNearViewport(button, near => {
        if (near && button === this._moreButton && button.isConnected && !button.disabled && !button.parentElement.querySelector('[role=alert]') && reads()) button.click()
      })
    }

    // A tile clicked opens its popup (dialogs/repository-item-dialog.js) on
    // `target`; held with a key, or another button, its link opens as one does.
    openPopup(event, target) {
      if (!plainClick(event)) return false
      event.preventDefault()
      openRepositoryItemDialog({ repository: { ...this.repository, repo: this.repo ?? this.repository.repo }, target })
      return true
    }
  }
  return { Shown, shown, repaint }
}

// The next page of a list `entry` holds, read by `ask` and added by `merge`
// while `held()` says it is still the one held: kept while it reads, however
// long it was held already, and from when it is read. A failure but an
// abort's is said (`moreError`, else `error`) for a click to read on.
export function readMore(entry, { held, ask, merge, error, repaint }) {
  if (entry.loadingMore || !entry.more) return
  entry.loadingMore = true
  entry.moreError = null
  entry.until = Date.now() + KEEP_MS
  repaint()
  ask().then(answer => {
    if (!held()) return null
    merge(answer)
    entry.until = Date.now() + KEEP_MS
    return null
  }, err => {
    if (err?.name !== 'AbortError') entry.moreError = err?.message || error
    return null
  }).finally(() => {
    entry.loadingMore = false
    repaint()
  })
}

// A group of buttons (`label`) picking one of `options` (each its value and
// content), `picked`'s pressed; `click(value)` a button's click, `kindOf(value)`
// its class.
export const modeButtons = (label, options, picked, click, kindOf = () => nothing) => html`<div class="history-modes" role="group" aria-label=${label}>${options.map(([value,
  content]) => html`<button type="button" class=${kindOf(value)} aria-pressed=${String(value === picked)} @click=${click(value)}>${content}</button>`)}</div>`

// A list's button reading its next page (`more`), and why the last failed.
export const moreButton = (entry, more, label, kind = 'history-more') => entry.more || entry.moreError ? html`<div class=${kind}>
    ${entry.moreError ? html`<span role="alert">${entry.moreError}</span>` : nothing}
    <button type="button" ?disabled=${entry.loadingMore} @click=${more}>${entry.loadingMore ? 'Reading…' : label}</button>
  </div>` : nothing

// A view's body while what it shows reads (`reading`), or failed to: why,
// and a button to read it again (`retry`).
export const readingBody = (entry, reading, retry) => entry.status === 'error'
  ? html`<div class="bundles-slide-placeholder is-error"><p role="alert">${entry.error}</p>
    <button type="button" @click=${retry}>Retry</button></div>`
  : html`<div class="bundles-slide-placeholder" role="status">${reading}</div>`
