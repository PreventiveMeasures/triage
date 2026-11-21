// A tile of the code viewer's Issues, Pull requests or Agents tab
// (repository-issues.js, repository-agents.js) in a popup, as a kanban card
// opens: an issue or pull request, read as it opens (GET
// /api/admin/repositories/item), with the package versions new to a pull
// request's lockfiles (pull-dependencies.js); or an agent's session. An issue
// or pull request it names opens in its place, Back returning.
import { html, nothing, unsafeCSS } from 'lit'
import { autorun } from '@rray/frontend/state-management'
import { state as clientState } from '#client/index.js'
import { styleMap } from '../style-map.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import { fetchRepositoryItem } from '../client-managed.js'
import { flowText } from '../format.js'
import { renderHighlighted } from '../render-finding.js'
import { CHECKS, COMMENT_ICON, PACKAGE_ICON, REVIEWS, STATE_ICONS, agentIcon, agentName, branchOnGithub, issueState, sessionOnGithub, sessionRan } from '../repository-tiles.js'
import { UNSUPPORTED_WHY, isPending, pullDependencies, readsDependencies, reviewFailures, reviewOf, subscribePullDependencies, unreviewedVersions } from '../pull-dependencies.js'
import { reviewBase } from '../npm-delta.js'
import '../dependency-review-copy.js'
import { managedRoutePath } from '../../../common/managed/routes.js'
import { githubUser, githubUsers } from '../github-users.js'
import { reviewSections } from '../pull-reviews.js'
import { knowItems, knownChanges, knownItem, readAtOf } from '../repository-items.js'
import proseCSS from '../../styles/prose.css'
import quoteCSS from '../../styles/md-quote.css'
import codeTokensCSS from '../../styles/code-tokens.css'
import styles from './dialog-repository-item.css'
import appUserCSS from '../../styles/app-user.css'

const SESSION_STATES = { open: ['open', 'Open'], merged: ['merged', 'Merged'], closed: ['closed', 'Closed'], branch: ['draft', 'A branch alone'] }
const date = at => at == null ? '' : new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const plural = (count, noun) => `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`
const external = (href, label, primary = false) => href
  ? html`<a class=${primary ? 'primary' : ''} href=${href} target="_blank" rel="noopener noreferrer">${label}</a>` : nothing
const codes = paths => paths.map((path, at) => html`${at > 0 ? ', ' : ''}<code>${path}</code>`)
const andMore = n => n > 0 ? html`<p class="repo-item-quiet">and ${n.toLocaleString('en-US')} more</p>` : nothing
// Where a version is from, but npm's registry; why lockfiles couldn't be read.
const SOURCES = { mirror: 'mirror', git: 'git', tarball: 'tarball', file: 'file' }
const LOCKFILE_ERRORS = { 'lockfile-unreadable': 'A lockfile here couldn’t be read', 'lockfile-unsupported': 'Bun’s lockfile here isn’t read', 'github-not-found': 'GitHub has none of a lockfile here at a commit compared' }

// What popups read, `{ item, at }` by session, repository and number: one read
// less than ITEM_FRESH_MS ago isn't read again; older ones are let go.
const ITEM_FRESH_MS = 60_000
const readItems = new Map()
const itemKey = (repoId, number) => `${clientState.managedSession?.id}\0${clientState.managedSession?.role}\0${repoId}\0${number}`

class RepositoryItemDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(proseCSS), unsafeCSS(quoteCSS), unsafeCSS(codeTokensCSS), unsafeCSS(appUserCSS), unsafeCSS(styles)]
  static properties = { repository: { attribute: false }, target: { attribute: false }, _trail: { state: true }, _items: { state: true } }

  constructor() {
    super()
    this._trail = []
    this._items = new Map()
    this._controller = new AbortController()
  }

  // Redrawn as the shown pull request's dependencies are read, and as what is
  // known of the repository's items changes (repository-items.js). The
  // helper's target is opened here, so the first render shows it.
  connectedCallback() {
    super.connectedCallback()
    this._unsubscribe = subscribePullDependencies(pull => {
      if (!pull || (pull.repoId === this.repository?.repoId && pull.number === this._trail.at(-1)?.number)) this.requestUpdate()
    })
    this._unobserve = autorun(first => {
      knownChanges()
      if (!first) this.requestUpdate()
    })
    if (this._trail.length === 0 && this.target) this.open(this.target)
  }
  disconnectedCallback() { this._controller.abort(); this._unsubscribe?.(); this._unobserve?.(); super.disconnectedCallback() }
  focusInitial() { this.renderRoot.querySelector('.repo-item-body')?.focus() }

  // Shows `target` over the one shown: an issue or pull request
  // (`{ number, preview }`, what its tile knew), read if not yet, or a
  // session (`{ session }`).
  open(target) {
    this._trail = [...this._trail, target]
    if (target.number == null || this._items.has(target.number)) return
    const number = target.number
    const { repoId } = this.repository
    const read = readItems.get(itemKey(repoId, number))
    if (read && Date.now() - read.at < ITEM_FRESH_MS) {
      this._items = new Map(this._items).set(number, { status: 'ready', item: read.item })
      return
    }
    this._items = new Map(this._items).set(number, { status: 'loading' })
    fetchRepositoryItem(repoId, number, { signal: this._controller.signal }).then(
      item => {
        // Its tile learns it too, unless a later read is known.
        knowItems(repoId, [item], readAtOf(item))
        for (const [key, { at }] of readItems) if (Date.now() - at >= ITEM_FRESH_MS) readItems.delete(key)
        readItems.set(itemKey(repoId, number), { item, at: Date.now() })
        return { status: 'ready', item }
      },
      err => err?.name === 'AbortError' ? null : { status: 'error', error: err?.message || 'It could not be read.' },
    ).then(held => {
      if (held) this._items = new Map(this._items).set(number, held)
      return null
    })
  }

  back() { this._trail = this._trail.slice(0, -1) }

  render() {
    const target = this._trail.at(-1)
    if (!target) return nothing
    const [heading, body, links] = target.session ? this.renderSession(target.session) : this.renderItem(target)
    return html`<dialog aria-labelledby="repo-item-title" @close=${this._onClose} @click=${this._onBackdrop}>
      <header>
        ${this._trail.length > 1 ? html`<button type="button" class="back" aria-label="Back" @click=${() => this.back()}>←</button>` : nothing}
        <h3 id="repo-item-title">${heading}</h3>
        <button type="button" aria-label="Close" @click=${this._onClose}>×</button>
      </header>
      <div class="repo-item-body" tabindex="-1">${body}</div>
      <div class="nwd-actions"><span class="nwd-spacer"></span>${links}</div>
    </dialog>`
  }

  renderItem({ number, preview }) {
    const held = this._items.get(number)
    // The latest read, by a popup or a list (repository-items.js), over what
    // only the popup reads (whether it changes a lockfile, a closed one's).
    const known = knownItem(this.repository.repoId, number)?.item
    const item = known ? { ...preview, ...held?.item, ...known } : held?.item ?? preview ?? null
    const kind = item?.kind ?? 'issues'
    const repo = this.repository.repo
    const href = repo ? `https://github.com/${repo}/${kind === 'pulls' ? 'pull' : 'issues'}/${number}` : null
    const [stateClass, stateName] = item ? issueState(kind, item) : ['open', '']
    const heading = html`${item ? html`<span class=${`repo-item-state is-${stateClass}`} role="img" aria-label=${stateName}>${STATE_ICONS[kind][stateClass]}</span>` : nothing}
      <span>${item?.title || '(no title)'} <span class="repo-item-number">#${number}</span></span>`
    const full = held?.status === 'ready' ? held.item : null
    const pulls = kind === 'pulls'
    const marked = ([name, glyph], mark) => html`<span class=${`repo-item-mark is-${mark}`}>${glyph}${name}</span>`
    const body = html`
      <p class="repo-item-meta">
        ${item ? html`<span class=${`repo-item-badge is-${stateClass}`}>${stateName}</span>` : nothing}
        ${item?.author ? html`<span><strong>${githubUser(item.author)}</strong> opened ${date(item.createdAt)}</span>` : item?.createdAt ? html`<span>Opened ${date(item.createdAt)}</span>` : nothing}
        ${item?.state === 'merged' ? html`<span>merged${full?.mergedBy ? html` by <strong>${githubUser(full.mergedBy)}</strong>` : nothing} ${date(item.mergedAt ?? item.closedAt)}</span>`
          : item?.closedAt && item.state !== 'open' ? html`<span>closed ${date(item.closedAt)}</span>` : nothing}
        ${item?.comments > 0 ? html`<span class="repo-item-mark">${COMMENT_ICON}${plural(item.comments, 'comment')}</span>` : nothing}
      </p>
      ${item?.labels?.length > 0 ? html`<p class="repo-item-labels">${item.labels.map(label => html`<span class="repo-item-label"
        style=${styleMap(label.color ? { '--label': `#${label.color}` } : {})}>${label.name}</span>`)}${item.moreLabels > 0 ? html`<span class="repo-item-label">+${item.moreLabels}</span>` : nothing}</p>` : nothing}
      ${pulls && item?.head ? html`<p class="repo-item-meta">
        <span><code>${item.head}</code>${item.base ? html` → <code>${item.base}</code>` : nothing}</span>
        <span><span class="is-added">+${item.additions.toLocaleString('en-US')}</span> <span class="is-deleted">−${item.deletions.toLocaleString('en-US')}</span></span>
        ${full ? html`<span>${plural(full.commits, 'commit')}</span><span>${plural(full.files, 'file')} changed</span>` : nothing}
        ${REVIEWS[item.review] && item.state === 'open' ? marked(REVIEWS[item.review], item.review) : nothing}
        ${CHECKS[item.checks] ? marked(CHECKS[item.checks], item.checks) : nothing}
      </p>` : nothing}
      ${pulls && full ? reviewSections(full.reviews, repo) : nothing}
      ${full ? this.renderLinked(pulls ? 'Closes' : 'Closed by', pulls ? 'issues' : 'pulls', pulls ? full.closes : full.closedBy, full.moreLinked) : nothing}
      ${pulls && readsDependencies(item) ? this.renderDependencies(number, item.state === 'open') : nothing}
      ${full ? html`<div class="repo-item-description">${full.body ? renderHighlighted(flowText(full.body)) : html`<p class="repo-item-quiet">No description.</p>`}</div>
        ${full.bodyShortened ? html`<p class="repo-item-quiet">Shortened here; the rest of it is on GitHub.</p>` : nothing}`
        : held?.status === 'error' ? html`<p class="repo-item-quiet" role="alert">${held.error}</p>`
        : html`<p class="repo-item-quiet" role="status">Reading it…</p>`}`
    return [heading, body, external(href, 'Open on GitHub', true)]
  }

  // Nothing where it changes no lockfile after all. An open one's come with
  // their review, where its repository's is in effect, and the reader's
  // reviews to copy, where the server's host formats them.
  renderDependencies(number, open) {
    const entry = pullDependencies(this.repository.repoId, number, open)
    if (entry.status === 'ready' && entry.lockfiles.length === 0 && !entry.cut) return nothing
    const body = entry.status === 'loading' ? html`<p class="repo-item-quiet" role="status">Reading its lockfiles…</p>`
      : entry.status === 'error' ? html`<p class="repo-item-quiet" role="alert">${entry.error}</p>`
      : this.renderAdded(entry)
    return html`<section class="repo-item-section"><h4 class="repo-item-deps-heading">New dependency versions${entry.formatted
      ? html`<dependency-review-copy .text=${entry.formatted} .label=${'Copy your dependency reviews'}></dependency-review-copy>` : nothing}</h4>${body}</section>`
  }

  // Per directory, the versions new to its lockfiles (new packages first) or
  // why they couldn't tell; a stasis.config.json the review holds to counts
  // as one, of what its entries reach. A review's terms and failures lead,
  // and the other versions wanting reviews come last, apart.
  renderAdded(entry) {
    const { lockfiles, cut, review } = entry
    const told = lockfiles.filter(dir => dir.error || dir.added.length > 0)
    const others = review ? unreviewedVersions(entry) : null
    return html`${review ? html`${this.renderReviewTerms(review)}${this.renderFailures(reviewFailures(entry), review)}` : nothing}
      ${told.length === 0 && lockfiles.length > 0 ? html`<p class="repo-item-quiet">None: every version its lockfiles lock, they locked before.</p>` : nothing}
      ${told.map(dir => html`<div class="repo-item-lockfiles">
        <p>${codes(dir.paths)}</p>
        ${isPending(dir) ? html`<p class="repo-item-quiet" role="status">Stasis is still working out what its entries reach, which can take a few minutes. It is asked again as it does.</p>`
          : dir.error === 'stasis-failed' ? html`<p class="repo-item-quiet" role="alert">Stasis couldn’t work out what its entries reach (${dir.detail ?? 'build-failed'}).</p>`
          : dir.error ? html`<p class="repo-item-quiet" role="alert">${LOCKFILE_ERRORS[dir.error] ?? 'These lockfiles couldn’t be read'}${dir.detail ? `: ${dir.detail}` : '.'}</p>`
          : html`<ul>${dir.added.toSorted((a, b) => Number(Boolean(a.was)) - Number(Boolean(b.was))).map(pkg => html`<li>${this.renderPackage(pkg, review, false, entry.head)}</li>`)}</ul>
            ${andMore(dir.more)}`}
      </div>`)}
      ${others?.count > 0 ? html`<details class="repo-item-unreviewed"><summary>${others.count.toLocaleString('en-US')} on the base branch</summary>
        <ul>${others.versions.map(pkg => html`<li>${this.renderPackage(pkg, review, true, entry.head)}</li>`)}</ul>
        ${andMore(others.count - others.versions.length)}
      </details>` : nothing}
      ${cut ? html`<p class="repo-item-quiet">It changes more files, or lockfiles in more directories, than are read; those past them aren’t told.</p>` : nothing}`
  }

  // What leaves versions wanting reviews: an unread baseline commit (or some
  // of its lockfiles, the first few named), versions the server's reviewed
  // dependencies didn't answer for. Comment reviews are noted only where
  // reviews count otherwise too (`byComments` not).
  renderReviewTerms({ unasked, baselineError, baselineUnread = [], commentReviews, commentsFailed, byComments, lockfiles }) {
    const named = baselineUnread.slice(0, 5)
    return html`${baselineError ? html`<p class="repo-item-quiet" role="alert">The versions its lockfiles locked at that commit couldn’t be read (${baselineError}), so every version wants its reviews.</p>` : nothing}
      ${named.length > 0 ? html`<p class="repo-item-quiet" role="alert">At that commit, ${codes(named)}${baselineUnread.length > named.length
        ? ` and ${(baselineUnread.length - named.length).toLocaleString('en-US')} more` : ''} couldn’t be read, so the versions ${baselineUnread.length === 1 ? 'it' : 'they'} locked want reviews.</p>` : nothing}
      ${unasked ? html`<p class="repo-item-quiet" role="alert">The server’s reviewed dependencies didn’t answer for ${plural(unasked, 'version')}, so ${unasked === 1 ? 'it wants' : 'they want'} reviews.</p>` : nothing}
      ${commentReviews && !byComments ? html`<p class="repo-item-quiet">Reviews in its comments by ${plural(commentReviews, 'reviewer')} count too while it is open.</p>` : nothing}
      ${commentsFailed ? html`<p class="repo-item-quiet" role="alert">Its comments couldn’t be read for reviews, so none of theirs count.</p>` : nothing}
      ${lockfiles ? html`<p class="repo-item-quiet">${lockfiles.mode === 'include' ? 'Only these lockfiles are reviewed: ' : 'These lockfiles aren’t reviewed: '}${lockfiles.paths.length === 0 ? 'none'
        : codes(lockfiles.paths)}.</p>` : nothing}`
  }

  // reviewFailures: versions that can't be reviewed, and lockfiles left unread.
  renderFailures(failed, review) {
    if (!failed) return nothing
    const { versions, count, unread, unchecked, cut } = failed
    return html`<div class="repo-item-failed" role="alert">
      ${count > 0 ? html`<p>Its review fails: ${plural(count, 'version')} its lockfiles lock can’t be reviewed, as only npm’s registry’s, locked with an integrity, are.</p>
        <ul>${versions.map(pkg => html`<li>${this.renderPackage(pkg, review, true)}</li>`)}</ul>
        ${andMore(count - versions.length)}` : nothing}
      ${unread.length > 0 || unchecked > 0 || cut ? html`<p>Its review fails: not every lockfile it changes was read${unchecked > 0
        ? `, and they lock ${plural(unchecked, 'version')} past those checked` : ''}.</p>` : nothing}
    </div>`
  }

  // A version new to a lockfile, opening in the app's npm viewer where it is
  // npm's: reviewed where the review is in effect and the reader reviews,
  // against its base (npm-delta.js reviewBase: the version it was, or one the
  // host names), a patched one as patched, its patch read at `head`, the
  // commit its lockfiles were read at; else compared with the version it was.
  // One wanting reviews shows the lines it changes (npm-delta.js). `other`:
  // another version its lockfiles lock, by its version alone, reviewed whole.
  renderPackage(pkg, review = null, other = false, head = null) {
    const { name, version, source, from, dev, was } = pkg
    const npm = (source === 'registry' || source === 'mirror') && version
    const base = other ? null : reviewBase(pkg, review), before = base?.name === name && base.version !== version ? base.version : undefined
    const patch = pkg.patch?.path && head ? { hash: pkg.patch.hash, repoId: this.repository.repoId, commit: head, path: pkg.patch.path } : null
    const reviewed = npm && (!pkg.patch || patch) && review?.canReview && reviewOf(pkg, review) !== 'unsupported' ? managedRoutePath({ view: 'npm', packageName: name, packageSpec: version,
      bundleTab: 'review', ...base ? { reviewPackage: base.name, reviewSpec: base.version } : {}, ...patch ? { patch } : {} }) : null
    const href = npm ? reviewed || (before && managedRoutePath({ view: 'npm', packageName: name, packageSpec: version, bundleTab: 'compare', compareSpec: before }))
      || managedRoutePath({ view: 'npm', packageName: name, packageSpec: version }) : null
    const label = html`${PACKAGE_ICON}<span class="repo-item-title">${name}${version ? html`<span class="repo-item-version">@${version}</span>` : nothing}</span>
      ${!other && was ? html`<span class="repo-item-was" data-tooltip-truncated data-tooltip=${`Was ${was.join(', ')}`}>from ${was.join(', ')}</span>` : nothing}
      ${this.renderReview(pkg, review)}
      ${source === 'registry' && version && (!pkg.patch || patch) && reviewOf(pkg, review) === 'wanted'
        ? html`<npm-delta .name=${name} .version=${version} .base=${base?.version ?? '(empty)'} .baseName=${base?.name ?? name} .patch=${patch}></npm-delta>` : nothing}
      ${dev ? html`<span class="repo-item-tag" data-tooltip="Only devDependencies need it">dev</span>` : nothing}
      ${pkg.patch ? html`<span class="repo-item-tag" data-tooltip=${pkg.patch.path ? `pnpm patches it as it installs it, by ${pkg.patch.path}, which its reviews are of`
        : 'pnpm patches it as it installs it, by a patch whose file isn’t known, which reviews here can’t read'}>patched</span>` : nothing}
      ${SOURCES[source] ? html`<span class="repo-item-tag" data-tooltip=${from ?? nothing}>${SOURCES[source]}</span>` : nothing}`
    return href ? html`<a class="repo-item-row" href=${href} target="_blank" rel="noopener noreferrer">${label}</a>` : html`<span class="repo-item-row">${label}</span>`
  }

  // A version's review, where its pull request's is in effect.
  renderReview(pkg, review) {
    const state = reviewOf(pkg, review)
    if (state === 'unsupported') return html`<span class="repo-item-review is-failed" data-tooltip=${UNSUPPORTED_WHY[pkg.unsupported]}>can’t review</span>`
    if (pkg.reviewed && state === 'passed') {
      return html`<span class="repo-item-review is-passed" data-tooltip="The server’s reviewed dependencies pass it">${CHECKS.success[1]}reviewed</span>`
    }
    if (pkg.rejected) {
      return html`<span class="repo-item-review is-failed" data-tooltip="A reviewer rejects it: it wants their newer accepting review">rejected</span>`
    }
    if (state === 'baseline') return html`<span class="repo-item-tag" data-tooltip="Locked at the commit reviews are counted since: it needs none">baseline</span>`
    if (!state) return nothing
    const told = `${plural(pkg.reviews, 'full, accepting review')} of ${review.required} required`
    return html`<span class=${`repo-item-review is-${state}`} data-tooltip=${told}>${state === 'passed' ? CHECKS.success[1] : nothing}${pkg.reviews}/${review.required}</span>`
  }

  // The issues or pull requests (`kind`) named, and how many more GitHub has.
  renderLinked(title, kind, items, more = 0) {
    if (!items?.length && !more) return nothing
    return html`<section class="repo-item-section"><h4>${title}</h4>${items?.length ? html`<ul>${items.map(linked => {
      const preview = { ...linked, kind, labels: [], comments: 0 }
      const [stateClass, stateName] = issueState(kind, preview)
      return html`<li><button type="button" class="repo-item-row" @click=${() => this.open({ number: linked.number, preview })}>
        <span class=${`repo-item-state is-${stateClass}`} role="img" aria-label=${stateName}>${STATE_ICONS[kind][stateClass]}</span>
        <span class="repo-item-number">#${linked.number}</span><span class="repo-item-title">${linked.title || '(no title)'}</span>
      </button></li>`
    })}</ul>` : nothing}${more > 0 ? html`<p class="repo-item-quiet">${items?.length ? 'and ' : ''}${more.toLocaleString('en-US')} more, on GitHub</p>` : nothing}</section>`
  }

  renderSession(session) {
    const repo = this.repository.repo
    const [stateClass, stateName] = SESSION_STATES[session.state] ?? SESSION_STATES.branch
    const tasks = session.pulls.length + session.commits.length
    const heading = html`<span class="repo-item-agents">${session.agents.map(agent => html`<span class=${`agent-mark is-${agent}`} role="img"
      aria-label=${agentName(agent)}>${agentIcon(agent)}</span>`)}</span><span>${session.title || '(no title)'}</span>`
    const ran = sessionRan(session)
    const body = html`
      <p class="repo-item-meta">
        <span class=${`repo-item-badge is-${stateClass}`}>${stateName}</span>
        ${session.authors.length > 0 ? html`<span><strong>${githubUsers(session.authors).map((login, at) => html`${at > 0 ? ', ' : ''}${githubUser(login)}`)}</strong></span>` : nothing}
        ${session.startedAt == null ? nothing : html`<span>${date(session.startedAt)}${session.updatedAt != null && date(session.updatedAt) !== date(session.startedAt)
          ? ` – ${date(session.updatedAt)}` : ''}</span>`}
        <span>${tasks > 0 ? plural(tasks, 'task') : 'no pull request'}</span>
        ${session.additions || session.deletions ? html`<span><span class="is-added">+${session.additions.toLocaleString('en-US')}</span>
          <span class="is-deleted">−${session.deletions.toLocaleString('en-US')}</span></span>` : nothing}
      </p>
      ${this.renderLinked('Pull requests', 'pulls', session.pulls)}
      ${session.commits.length > 0 ? html`<section class="repo-item-section"><h4>Commits to the default branch</h4><ul>${session.commits.map(commit => html`<li>
        <a class="repo-item-row" href=${repo ? `https://github.com/${repo}/commit/${commit.oid}` : nothing} target="_blank" rel="noopener noreferrer">
          <code>${commit.oid.slice(0, 7)}</code><span class="repo-item-title">${commit.title || '(no message)'}</span></a></li>`)}</ul></section>` : nothing}
      ${this.renderLinked('Issues', 'issues', session.issues.map(issue => ({ ...issue, reason: null })))}
      ${session.branches.length > 0 ? html`<section class="repo-item-section"><h4>${session.branches.length === 1 ? 'Branch' : 'Branches'}</h4><ul>${session.branches.map(branch => html`<li>
        <a class="repo-item-row" href=${repo ? branchOnGithub(repo, branch) : nothing} target="_blank" rel="noopener noreferrer"><code>${branch}</code></a></li>`)}</ul></section>` : nothing}`
    const links = html`${external(ran, session.sessions[0] ? 'Open in Claude Code' : 'Open the Codex task')}${external(sessionOnGithub(session, repo), 'Open on GitHub', true)}`
    return [heading, body, links]
  }
}
customElements.define('repository-item-dialog', RepositoryItemDialog)

// Opens `target` of `repository` (`{ repoId, repo }`): an issue or pull
// request (`{ number, preview }`) or an agent's session (`{ session }`).
export function openRepositoryItemDialog(props) {
  return openAppDialog('repository-item-dialog', props)
}
