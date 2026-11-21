// The code viewer's Issues and Pull requests tabs (render-bundle.js): the
// repository's open or closed issues or pull requests, the latest updated
// first, as a grid of compact tiles, a page at a time as the end of the
// scroll nears (GET /api/admin/repositories/issues). A tile shows its state,
// number, author, age, title and labels, a pull request's branches, size,
// review and checks, and an open one's package versions new to its lockfiles
// (pull-dependencies.js). Each shows its item as read latest, by its list or
// its popup (repository-items.js), and the counts with it.
import { html, nothing } from 'lit'
import { StateElement } from '@rray/frontend/state-element'
import { classMap } from 'lit/directives/class-map.js'
import { styleMap } from './style-map.js'
import { fetchRepositoryIssues } from './client-managed.js'
import { compactTime } from './repository-history.js'
import { CHECKS, COMMENT_ICON, PACKAGE_ICON, REVIEWS, STATE_ICONS, issueState } from './repository-tiles.js'
import { addedVersions, pullDependencies, readsDependencies, reviewFailures, reviewOf, subscribePullDependencies, unreviewedVersions } from './pull-dependencies.js'
import { activityPicker, activitySubtab, pickActivitySubtab, watchActivitySubtabs } from './repository-activity.js'
import { githubUser, githubUserName } from './github-users.js'
import { reviewLine } from './pull-reviews.js'
import { groupAt, groupOf, knowItems, knownItem, knownItems, readAtOf } from './repository-items.js'
import { filtered, modeButtons, moreButton, number, pagedRead, readingBody, sessionKept, shownElements, withNew } from './activity-reads.js'

export { issueState }

const MAX_LABELS = 8
// The new package versions a tile's tooltip names, those past them counted.
const TOLD_PACKAGES = 20

const sessionLists = sessionKept(new Map())
const { Shown, shown: shownLists, repaint } = shownElements(StateElement)
watchActivitySubtabs(tab => { if (tab === 'issues' || tab === 'pulls') repaint() })
// Each list drawn again as its repository's pull requests have their
// dependencies read, or all may have changed.
subscribePullDependencies(pull => {
  for (const element of shownLists) if (!pull || element.repository?.repoId === pull.repoId) element.requestUpdate()
})

// A server's answer, its items those naming a number, and when it read
// them from GitHub.
function checked(answer) {
  if (!Array.isArray(answer?.items)) throw new TypeError('The server answered with no list.')
  const items = answer.items.filter(item => Number.isSafeInteger(item?.number) && typeof item.title === 'string' && Array.isArray(item.labels))
  return { items, counts: { open: answer.counts?.open ?? 0, closed: answer.counts?.closed ?? 0 }, more: answer.more === true, after: answer.more === true ? answer.after : null,
    readAt: readAtOf(answer) }
}

// A list of `kind` of repository `repoId`, those open or closed (`listState`),
// as now known (repository-items.js): each it lists as read latest, one read
// since in the other state left where it was; where the list reaches them,
// those read since that are now in its state, by when each was updated; and
// its counts, each known item moved between open and closed where it is now
// in the other than they counted it in (`counted`): as recorded when they
// were adopted, unless GitHub closed one now closed, or updated one now open,
// no later than they were read (`countsAt`), which counted it as it is.
function listedNow(repoId, kind, listState, entry) {
  const belongs = item => (item.state === 'open') === (listState === 'open')
  const latest = entry.items.map(item => knownItem(repoId, item.number) ?? { item, readAt: entry.readAt })
  const items = latest.map(({ item }) => item)
  const listed = new Set(items.map(item => item.number))
  const oldest = entry.more ? entry.items.at(-1)?.updatedAt ?? 0 : null
  const arrived = knownItems(repoId, kind).filter(({ item, readAt }) => readAt > entry.readAt && !listed.has(item.number) && belongs(item)
    && (oldest === null || (item.updatedAt ?? 0) >= oldest)).toSorted((a, b) => (b.item.updatedAt ?? 0) - (a.item.updatedAt ?? 0))
  for (const { item } of arrived) {
    const at = items.findIndex(other => (other.updatedAt ?? 0) < (item.updatedAt ?? 0))
    items.splice(at === -1 ? items.length : at, 0, item)
  }
  const countsAt = entry.countsAt ?? entry.readAt
  const counted = held => {
    const now = groupOf(held.item)
    const closedAt = held.item.closedAt ?? held.item.mergedAt ?? null
    if (now === 'closed' ? closedAt !== null && closedAt <= countsAt : (held.item.updatedAt ?? Number.POSITIVE_INFINITY) <= countsAt) return now
    return entry.counted?.get(held.item.number) ?? groupAt(held, countsAt)
  }
  const all = new Map(knownItems(repoId, kind).map(held => [held.item.number, held]))
  for (const held of latest) if (!all.has(held.item.number)) all.set(held.item.number, held)
  let moved = 0
  for (const held of all.values()) {
    const then = counted(held)
    if (then !== groupOf(held.item)) moved += then === listState ? 1 : -1
  }
  const other = listState === 'open' ? 'closed' : 'open'
  const counts = { [listState]: Math.max(0, entry.counts[listState] - moved), [other]: Math.max(0, entry.counts[other] + moved) }
  return { items, counts }
}

// What a list's counts, as it adopts them, counted each known one of its
// repository and kind in, as best known then (groupAt at `countsAt`): one
// moving after, either way, moves them (listedNow).
function rebase(repoId, kind, entry) {
  const counted = new Map(knownItems(repoId, kind).map(held => [held.item.number, groupAt(held, entry.countsAt)]))
  for (const item of entry.items) if (!counted.has(item.number)) counted.set(item.number, groupOf(item))
  entry.counted = counted
  return entry
}

// Those of `items` matching every word of `filter`: in its number, title,
// author (its login, or its user's name), labels or branch.
export const filterIssues = (items, filter) => filtered(items, filter, item => [`#${item.number}`, item.title, item.author ?? '', githubUserName(item.author) ?? '',
  item.head ?? '', ...item.labels.map(label => label.name)])

const compactThousands = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 2 })

// How many comments, as narrow as the rail is: whole below a thousand, else
// two digits at most and their unit ("1.2K", "12K").
export const commentCount = count => count < 1000 ? String(count) : compactThousands.format(count)

// A tile's labels, each by a dot of its color, whole while they fit, the
// last shortened to its dot first: each after the first nested in a run of
// those after it, which gives way before it does (report.css). Eight, else
// seven and how many more.
function labelChips(item) {
  const total = item.labels.length + (item.moreLabels ?? 0)
  const shown = item.labels.slice(0, total > MAX_LABELS ? MAX_LABELS - 1 : MAX_LABELS)
  const chip = label => html`<span class="issue-label" style=${styleMap(label.color ? { '--label': `#${label.color}` } : {})} data-tooltip-truncated data-tooltip=${label.name}>${label.name}</span>`
  const run = labels => html`${chip(labels[0])}${labels.length > 1
    ? html`<span class="issue-labels-rest" style=${styleMap({ '--labels': String(labels.length - 1) })}>${run(labels.slice(1))}</span>` : nothing}`
  return html`${shown.length > 0 ? run(shown) : nothing}${total > shown.length ? html`<span class="issue-label is-more">+${total - shown.length}</span>` : nothing}`
}

// Why a version can't be reviewed, as a tile tells it.
const UNSUPPORTED = { git: 'from git', tarball: 'a tarball not npm’s registry’s', integrity: 'locked with no integrity', unlocked: 'locked by no lockfile read' }
// What fails a pull request's review, as its tile tells it on hover.
function failedTold({ versions, count, unread, unchecked, cut }) {
  const rest = count - Math.min(versions.length, TOLD_PACKAGES)
  return [count > 0 ? `${versions.slice(0, TOLD_PACKAGES).map(pkg => `${pkg.name}${pkg.version ? `@${pkg.version}` : ''} (${UNSUPPORTED[pkg.unsupported]})`).join(', ')}${rest > 0
    ? ` and ${number(rest)} more` : ''} can’t be reviewed` : null,
  unread.length > 0 || unchecked > 0 || cut ? 'not every lockfile it changes was read' : null].filter(Boolean).join('; ')
}

// The package versions new to a pull request's lockfiles, once read: their
// packages' names, how many are new packages and how many new versions ("+"
// where more than were sent), each named on hover, TOLD_PACKAGES at most.
// Where its review is in effect, whether they pass: that it fails (a version
// can't be reviewed or a lockfile couldn't be read, reviewFailures); a check
// where every version passes; else how many of its own, and of the others
// they lock, want reviews; and that Stasis still works out what its
// stasis.config.json reaches (`pending`).
function dependencyLine(entry) {
  if (entry.status !== 'ready') return nothing
  const { versions, fresh, updated, more, toReview } = addedVersions(entry)
  const others = entry.review ? unreviewedVersions(entry).count : 0
  const failed = reviewFailures(entry)
  if (versions.length === 0 && others === 0 && !failed && !entry.pending) return nothing
  const plus = more ? '+' : ''
  const reviewed = pkg => {
    const review = reviewOf(pkg, entry.review)
    return review === 'unsupported' ? `, can’t be reviewed: ${UNSUPPORTED[pkg.unsupported]}` : review === 'baseline' ? ', needs no review'
      : pkg.reviewed ? ', reviewed' : pkg.rejected ? ', rejected'
      : review ? `, ${pkg.reviews}/${entry.review.required} reviews` : ''
  }
  const named = pkg => `${pkg.name}@${pkg.version ?? '?'}${pkg.patch ? ', patched' : ''}${pkg.was ? ` (was ${pkg.was.join(', ')}${reviewed(pkg)})` : ` (new${reviewed(pkg)})`}`
  const rest = versions.length - TOLD_PACKAGES
  const told = [versions.length > 0 ? `New in its lockfiles: ${versions.slice(0, TOLD_PACKAGES).map(named).join(', ')}${rest > 0 ? ` and ${number(rest)}${plus} more` : more ? ' and more' : ''}` : null,
    others > 0 ? `${number(others)} on the base branch unreviewed` : null,
    failed ? `Its review fails: ${failedTold(failed)}` : null,
    entry.pending ? 'Stasis is still working out what its stasis.config.json’s entries reach' : null].filter(Boolean).join('. ')
  const counted = [fresh ? `${number(fresh)} new` : null, updated ? `${number(updated)} updated` : null].filter(Boolean).join(', ')
  const wanted = toReview && others ? `${number(toReview)} + ${number(others)} to review`
    : toReview ? `${number(toReview)} to review` : others ? `${number(others)} unreviewed` : ''
  return html`<span class="issue-deps" data-tooltip=${told}>${PACKAGE_ICON}<span class="issue-deps-names">${[...new Set(versions.map(pkg => pkg.name))].join(', ')}</span>
    ${counted ? html`<span class="issue-deps-count">${counted}${plus}</span>` : nothing}
    ${failed ? html`<span class="issue-deps-review is-failed">${failed.count > 0 ? `${number(failed.count)} can’t be reviewed` : 'lockfiles unread'}</span>`
      : entry.pending ? html`<span class="issue-deps-review is-pending" role="status">${wanted ? `${wanted}, ` : ''}Stasis building…</span>`
      : entry.review ? wanted ? html`<span class="issue-deps-review is-wanted">${wanted}</span>`
      : html`<span class="issue-deps-review is-passed" role="img" aria-label="Every version reviewed">${CHECKS.success[1]}</span>` : nothing}</span>`
}

// The tab's body, for the repository a directory shown (`repository`, an
// entry's) is in, by its full name (`repo`, repository-code.js
// repositoryFullName, once known): its issues, or its pull requests (`kind`
// 'pulls').
class RepositoryIssues extends Shown {
  static properties = { kind: {}, _filter: { state: true } }

  constructor() {
    super()
    this.kind = 'issues'
    this._filter = ''
  }

  // More read as their button nears, but not while a filter picks among
  // those read, which could read them all.
  updated() {
    this.watchMore(() => !this._filter.trim())
  }

  // Those open or closed (`listState`), as held, else read (pagedRead):
  // 'loading', then 'ready' with its `items` and `counts`, or 'error'; on
  // its next page its counts the latest read, a page the server kept from
  // before the one they came with leaving them.
  list(listState) {
    const { repoId } = this.repository
    const kind = this.kind
    const ask = after => fetchRepositoryIssues(repoId, kind, { state: listState, after }).then(checked).then(answer => {
      knowItems(repoId, answer.items, answer.readAt, kind)
      return answer
    })
    return pagedRead(sessionLists, `${repoId}\0${kind}\0${listState}`, { first: () => ask(null), next: ask, message: 'The list could not be read.', repaint,
      ready: entry => rebase(repoId, kind, { ...entry, countsAt: entry.readAt }),
      merge: (entry, answer) => {
        entry.items = withNew(entry.items, answer.items, item => item.number)
        if (answer.readAt >= entry.countsAt) {
          entry.counts = answer.counts
          entry.countsAt = answer.readAt
          rebase(repoId, kind, entry)
        }
      } })
  }

  pick(listState) {
    pickActivitySubtab(this.repository, this.kind, listState)
  }

  render() {
    if (!this.repository) return nothing
    // Open or closed, as its route's sub-tab names them (repository-activity.js),
    // open where it names none.
    const listState = activitySubtab(this.kind) ?? 'open'
    const { key, entry, more } = this.list(listState)
    const ready = entry.status === 'ready'
    const noun = this.kind === 'pulls' ? 'pull requests' : 'issues'
    // How many are open and closed, as the list shown read them, else as the
    // other did, the same repository's: switching keeps them while it reads.
    const otherState = listState === 'open' ? 'closed' : 'open'
    const other = sessionLists().get(`${this.repository.repoId}\0${this.kind}\0${otherState}`)
    const now = ready ? listedNow(this.repository.repoId, this.kind, listState, entry) : null
    const counts = now ? now.counts : other?.status === 'ready' ? listedNow(this.repository.repoId, this.kind, otherState, other).counts : null
    const counted = which => counts ? html`<span class="n">${number(counts[which])}</span>` : nothing
    const shown = now ? filterIssues(now.items, this._filter) : []
    return html`<div class="history-bar issues-bar">
        ${activityPicker(this.kind)}
        ${modeButtons(this.kind === 'pulls' ? 'Pull requests' : 'Issues', [['open', html`Open${counted('open')}`], ['closed', html`Closed${counted('closed')}`]], listState,
          picked => () => this.pick(picked))}
        <input class="issues-filter" type="search" placeholder="Filter" aria-label=${`Filter the ${noun} read`} .value=${this._filter}
          @input=${event => { this._filter = event.target.value }}>
        ${now && this._filter.trim() ? html`<span class="history-summary">${shown.length} of ${now.items.length} read</span>` : nothing}
      </div>
      ${now ? this.renderTiles(entry, now.items, shown, more, `${listState} ${noun}`)
        : readingBody(entry, `Reading the ${noun}…`, () => { sessionLists().delete(key); repaint() })}`
  }

  renderTiles(entry, items, shown, more, what) {
    if (items.length === 0) return html`<div class="bundles-slide-placeholder">No ${what}.</div>`
    const repo = this.repo ?? this.repository.repo
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
      ${moreButton(entry, more, 'More', 'history-more issues-more')}
    </div>`
  }

  openTile(event, item) {
    this.openPopup(event, { number: item.number, preview: { ...item, kind: this.kind } })
  }

  // A tile: its state's icon, and under it a pull request's review and
  // checks and how many comments, as a rail beside its title, number, author
  // and age, labels, a pull request's branches and size, and an open one's
  // reviews (pull-reviews.js) and package versions new to its lockfiles.
  renderTile(item, stateClass, stateName) {
    const pulls = this.kind === 'pulls'
    const dependencies = pulls && item.state === 'open' && readsDependencies(item) ? pullDependencies(this.repository.repoId, item.number, true, { listed: true }) : null
    const time = item.updatedAt == null ? null : new Date(item.updatedAt)
    const checks = pulls && item.checks ? CHECKS[item.checks] : null
    const review = pulls && item.state === 'open' && item.review ? REVIEWS[item.review] : null
    const comments = item.comments > 0 ? `${number(item.comments)} comment${item.comments === 1 ? '' : 's'}` : null
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
          <span class="issue-author">${githubUser(item.author, item.author ?? 'ghost')}</span>
          ${time ? html`<time datetime=${time.toISOString()}>${compactTime(item.updatedAt)}</time>` : nothing}
        </span>
        ${item.labels.length > 0 || item.moreLabels > 0 ? html`<span class="issue-labels">${labelChips(item)}</span>` : nothing}
        ${pulls && item.head ? html`<span class="issue-branch"><code>${item.head}</code>${item.base ? html`<span aria-hidden="true">→</span><code>${item.base}</code>` : nothing}
          <span class="issue-diff"><span class="is-added">+${number(item.additions)}</span> <span class="is-deleted">−${number(item.deletions)}</span></span></span>` : nothing}
        ${pulls && item.state === 'open' ? reviewLine(item.reviews) : nothing}
        ${dependencies ? dependencyLine(dependencies) : nothing}
      </span>`
  }
}
if (!customElements.get('repository-issues')) customElements.define('repository-issues', RepositoryIssues)
