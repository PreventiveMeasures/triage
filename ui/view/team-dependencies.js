// A team's dependencies to review, its Dependencies tab, where its reader
// reviews them in it (workspace-content.js), a sub-tab each (TABS), drawn
// as a dialog's header tabs are (header-tabs.js), the one open
// (`state.teamDependenciesTab`) its address's, /team/<slug>/dependencies
// [/<tab>], and scrolling under them: of each
// of its repositories whose review is in effect for them, the open pull
// requests whose versions want reviews, those adding fewest first, each
// version with its review as its pull request's is (pull-dependencies.js),
// one a pull request above adds told under it alone, as it is reviewed once
// whichever adds it; every version they add wanting one, each once, by the
// pull requests adding it; what each repository's default branch locks that
// wants one, where any does; and the reviews published to the team
// (dependency-review-list.js). A repository's are held for the session a
// while (KEEP_MS), its pull requests' as their tiles hold them; and read again
// once a repository's or a team's review is set anew. As many repositories
// are read at once as READ_AT_ONCE. A pull request is named without its
// repository's owner where every repository reviewed has the same one.
import { html, nothing, svg } from 'lit'
import { StateElement } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { fetchBranchDependencies, fetchRepositoryIssues } from './client-managed.js'
import { addedVersions, checked, pullDependencies, readsDependencies, reviewFailures, reviewOf, subscribePullDependencies, unreviewedVersions } from './pull-dependencies.js'
import { openRepositoryItemDialog } from './lazy-dialogs.js'
import { PACKAGE_ICON, icon } from './repository-tiles.js'
import { dialogTabs } from './header-tabs.js'
import { withCompare } from './compare-load.js'
import { deltaBase } from './npm-delta.js'
import './dependency-review-copy.js'
import { managedHistory } from './managed-history.js'
import { managedRouteForIds, managedRoutePath } from '../../common/managed/routes.js'

const KEEP_MS = 2 * 60_000
const RETRY_MS = 30_000
// Pages of a repository's open pull requests read, fifty each, a thousand
// at most, its list cheap, those touching no lockfile read no further; and
// the versions shown of a list, under a pull request or a default branch,
// the rest shown once asked for.
const PULL_PAGES = 20
const SHOWN_VERSIONS = 12
const SHOWN_LISTED = 48
// A pull request's card by how many versions it lists: a column's, two
// columns', else every column's.
const CARD_SPANS = ['', '', ' is-span-2']
const READ_AT_ONCE = 3
// Its sub-tabs, each at an address of its own, the one last picked
// opened again by the team's Dependencies tab (ingest.js
// switchToWorkspaceContent).
const TABS = [['pulls', 'Pull requests'], ['versions', 'Versions'], ['branch', 'Default branch'], ['reviews', 'Reviews']]

const held = new Map()
const listeners = new Set()
const waiting = []
let heldFor = null
let inFlight = 0
const changed = () => { for (const notify of listeners) notify() }
globalThis.addEventListener?.('dependency-review-changed', () => {
  held.clear()
  waiting.length = 0
  changed()
})

function sessionHeld() {
  const session = state.managedSession ? `${state.managedSession.id}\0${state.managedSession.role}` : null
  if (session !== heldFor) {
    held.clear()
    waiting.length = 0
    heldFor = session
  }
  return held
}

// The next asked read as one is, as many at once as READ_AT_ONCE.
function readNext() {
  while (inFlight < READ_AT_ONCE && waiting.length > 0) {
    inFlight++
    waiting.shift()().finally(readDone)
  }
}
function readDone() {
  inFlight--
  changed()
  readNext()
}

// A repository's open pull requests, as many pages as PULL_PAGES, and
// whether it has more.
async function openPulls(repoId) {
  const items = []
  let after = null
  for (let page = 0; page < PULL_PAGES; page++) {
    const answer = await fetchRepositoryIssues(repoId, 'pulls', { state: 'open', ...after ? { after } : {} })
    items.push(...(Array.isArray(answer?.items) ? answer.items : []).filter(item => Number.isSafeInteger(item?.number) && item.number > 0))
    if (answer?.more !== true || typeof answer.after !== 'string') return { items, more: false }
    after = answer.after
  }
  return { items, more: true }
}

// Repository `repoId`'s, as held, else asked: its default branch's
// dependencies (`branch`, none where no review is in effect, nor where its
// reader may read only some of it), and, where they are, its open pull
// requests (`pulls`).
const PARTIAL = new Set(['no-directory', 'no-repository'])
async function readRepository(repoId) {
  try {
    const branch = await fetchBranchDependencies(repoId)
    return branch?.review ? { branch: checked(branch), pulls: await openPulls(repoId) } : { branch: null }
  } catch (err) {
    if (PARTIAL.has(err?.code)) return { branch: null }
    throw err
  }
}
function repositoryRead(repoId) {
  const data = sessionHeld()
  const entry = data.get(repoId)
  if (entry && Date.now() < entry.until) return entry
  const loading = { status: 'loading', until: Number.POSITIVE_INFINITY }
  data.set(repoId, loading)
  waiting.push(() => readRepository(repoId).then(read => {
    if (data.get(repoId) === loading) data.set(repoId, { status: 'ready', until: Date.now() + KEEP_MS, ...read })
    return null
  }, err => {
    if (data.get(repoId) !== loading) return null
    if (err?.name === 'AbortError') data.delete(repoId)
    else data.set(repoId, { status: 'error', until: Date.now() + RETRY_MS, error: err?.message || 'It couldn’t be read.' })
    return null
  }))
  readNext()
  return loading
}

const plural = (count, noun) => `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`
const versionKey = pkg => `${pkg.name}@${pkg.version ?? ''}${pkg.patched ? '+patch' : ''}`
const pullName = ({ repo, item }) => `${repo.name}#${item.number}`

// A version's review: that it can't be reviewed, a reviewer rejects it, a
// patched one wants the server's reviewed dependencies, or how many reviews
// pass it of those it needs.
const WHY = { git: 'From git, which isn’t reviewed', tarball: 'A tarball not npm’s registry’s of its version, which isn’t reviewed',
  integrity: 'Locked with no integrity, which its reviews are held to' }
function reviewBadge(pkg, review) {
  const shown = reviewOf(pkg, review)
  if (shown === 'unsupported') return html`<span class="team-deps-review is-failed" data-tooltip=${WHY[pkg.unsupported] ?? nothing}>can’t review</span>`
  if (pkg.rejected) return html`<span class="team-deps-review is-failed" data-tooltip="A reviewer rejects it: it wants their newer accepting review">rejected</span>`
  if (pkg.patched && shown === 'wanted') {
    return html`<span class="team-deps-review is-wanted" data-tooltip="Reviews here pass no patch: the server’s reviewed dependencies, or reviews of its patch in the pull request’s comments, pass it">patched</span>`
  }
  if (shown === 'wanted') {
    return html`<span class="team-deps-review is-wanted" data-tooltip=${`${plural(pkg.reviews, 'review')} of ${review.required} required${pkg.commented
      ? `; ${plural(pkg.commented, 'reviewer')} in its comments, which count here alone` : ''}`}>${pkg.reviews}/${review.required}</span>`
  }
  return nothing
}

// A version as a row: its name and version, opening its review where its
// reader reviews it and it can be, against the version it was where it was
// one, else its page; its review; the lines it changes against the version
// it was, or whole, where it wants reviews (npm-delta.js); that other pull
// requests review it in their comments (`elsewhere`), which count for them
// alone; and the pull requests adding it besides, or, `adders`, all those
// adding it.
function versionRow(pkg, review, { others = [], adders = false, elsewhere = [] } = {}) {
  const npm = pkg.source === 'registry' && pkg.version
  const before = pkg.was?.find(prior => prior !== pkg.version)
  const reviewing = review?.canReview && !pkg.patched && reviewOf(pkg, review) !== 'unsupported'
  const href = npm ? managedRoutePath({ view: 'npm', packageName: pkg.name, packageSpec: pkg.version,
    ...reviewing ? { bundleTab: 'review', ...before ? { reviewPackage: pkg.name, reviewSpec: before } : {} } : {} }) : null
  const label = html`${PACKAGE_ICON}<span class="team-deps-name">${pkg.name}${pkg.version ? html`<span class="team-deps-version">@${pkg.version}</span>` : nothing}</span>
    ${npm && reviewOf(pkg, review) === 'wanted' ? html`<npm-delta .name=${pkg.name} .version=${pkg.version} .base=${deltaBase(pkg)}></npm-delta>` : nothing}
    ${reviewBadge(pkg, review)}
    ${elsewhere.length > 0 ? html`<span class="team-deps-elsewhere" data-tooltip=${`Reviewed in the comments of ${elsewhere.join(', ')}, which count there alone`}>in review in
      ${elsewhere[0]}${elsewhere.length > 1 ? ` +${elsewhere.length - 1}` : ''}</span>` : nothing}
    ${others.length > 0 ? html`<span class="team-deps-also" data-tooltip=${`Added by ${others.join(', ')}${adders ? '' : ' too'}`}>${adders
      ? `${others[0]}${others.length > 1 ? ` +${others.length - 1}` : ''}` : `+${others.length}`}</span>` : nothing}`
  return html`<li>${href ? html`<a class="team-deps-row" href=${href} target="_blank" rel="noopener noreferrer">${label}</a>` : html`<span class="team-deps-row">${label}</span>`}</li>`
}

// A list's toggle: its chevron turned while it is open.
const CHEVRON = icon(svg`<path d="m6 4 4 4-4 4"/>`)

class TeamDependencies extends StateElement {
  static properties = { repositories: { attribute: false }, team: { attribute: false }, _open: { state: true } }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.repositories = []
    this.team = null
    // The lists opened past those shown, by their keys.
    this._open = new Set()
    this._notify = () => this.requestUpdate()
  }

  // Sub-tab `tab` shown, at its address, an entry of its own where it is
  // picked (`push`), else the one shown's replaced.
  pick(tab, { push = true } = {}) {
    state.teamDependenciesTab = tab
    const route = managedRouteForIds({ view: 'workspace-dependencies', teamId: this.team, dependencyTab: tab }, state.managedTeams)
    if (push) managedHistory?.pushRoute(route)
    else managedHistory?.replaceRoute(route)
  }

  // The sub-tab its address names, the default branch's, which isn't shown
  // where none wants reviews once all is read, giving way to the first.
  updated() {
    if (this._shown && this._shown !== state.teamDependenciesTab) this.pick(this._shown, { push: false })
  }

  toggle(key) {
    const open = new Set(this._open)
    if (!open.delete(key)) open.add(key)
    this._open = open
  }

  connectedCallback() {
    super.connectedCallback()
    listeners.add(this._notify)
    this._unsubscribe = subscribePullDependencies(this._notify)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    listeners.delete(this._notify)
    this._unsubscribe?.()
  }

  open(event, { repo, item }) {
    event.preventDefault()
    openRepositoryItemDialog({ repository: { repoId: repo.repoId, repo: repo.name }, target: { number: item.number, preview: { ...item, kind: 'pulls' } } })
  }

  // Rows of `items`, as many as `shown` till the rest are asked for, under
  // `key`, as one list, filling as many columns as fit.
  rows(key, items, row, shown = SHOWN_VERSIONS) {
    if (items.length === 0) return nothing
    const open = this._open.has(key)
    return html`<ul class="team-deps-versions">${(open ? items : items.slice(0, shown)).map(row)}</ul>
      ${items.length > shown ? html`<button type="button" class="team-deps-more" aria-expanded=${String(open)} @click=${() => this.toggle(key)}>${CHEVRON}${open
        ? 'Show fewer' : `and ${(items.length - shown).toLocaleString('en-US')} more`}</button>` : nothing}`
  }

  // A list told by `label` alone till it is opened, under `key`, and how
  // many past those it lists (`unlisted`).
  disclosed(key, label, items, row, unlisted = 0) {
    const open = this._open.has(key)
    return html`<div class="team-deps-disclosed">
      <button type="button" class="team-deps-more" aria-expanded=${String(open)} @click=${() => this.toggle(key)}>${CHEVRON}${label}</button>
      ${open ? html`${this.rows(key, items, row, SHOWN_LISTED)}${unlisted > 0
        ? html`<p class="team-deps-quiet">and ${unlisted.toLocaleString('en-US')} more, not listed</p>` : nothing}` : nothing}
    </div>`
  }

  render() {
    const repos = [...new Map((this.repositories ?? []).map(repo => [repo.repoId, repo])).values()]
    const reads = repos.map(repo => ({ repo, read: repositoryRead(repo.repoId) }))
    const reviewed = reads.filter(({ read }) => read.status === 'ready' && read.branch)
    const pulls = reviewed.flatMap(({ repo, read }) => read.pulls.items.filter(readsDependencies)
      .map(item => ({ repo, item, entry: pullDependencies(repo.repoId, item.number, true) })))
    // Each pull request's versions wanting reviews, as many as its answer
    // tells, and how many in all, those past them too (`toReview`), by which
    // it is kept and ordered; and the other versions its lockfiles lock that
    // want them (`others`), the default branch's mostly, which hold it too:
    // one held by those alone after those adding some.
    const wanting = pulls.filter(({ entry }) => entry.status === 'ready' && entry.review).map(pull => {
      const wanted = addedVersions(pull.entry).versions.filter(pkg => ['wanted', 'unsupported'].includes(reviewOf(pkg, pull.entry.review)))
      const told = wanted.filter(pkg => reviewOf(pkg, pull.entry.review) === 'wanted').length
      const toReview = Math.max(pull.entry.review.toReview ?? told, told)
      return { ...pull, wanted, failed: reviewFailures(pull.entry), toReview, untold: toReview - told, size: wanted.length + toReview - told,
        others: unreviewedVersions(pull.entry).count }
    }).filter(pull => pull.size > 0 || pull.others > 0 || pull.failed)
      .toSorted((a, b) => Number(a.size === 0) - Number(b.size === 0) || a.size - b.size || a.others - b.others
        || (a.repo.name < b.repo.name ? -1 : a.repo.name > b.repo.name ? 1 : b.item.number - a.item.number))
    // The repositories whose open pull requests are more than are read.
    const unchecked = reviewed.filter(({ read }) => read.pulls.more)
    const adding = new Map()
    for (const pull of wanting) for (const pkg of pull.wanted) adding.set(versionKey(pkg), [...adding.get(versionKey(pkg)) ?? [], pull])
    const reading = reads.some(({ read }) => read.status === 'loading') || pulls.some(({ entry }) => entry.status === 'loading')
    const failures = [...reads.filter(({ read }) => read.status === 'error').map(({ repo, read }) => [repo.name, read.error]),
      ...pulls.filter(({ entry }) => entry.status === 'error').map(pull => [pullName(pull), pull.entry.error])]
    // The default branches with versions wanting reviews, or failing them.
    const branches = reviewed.flatMap(({ repo, read }) => {
      const { count } = unreviewedVersions(read.branch), failed = reviewFailures(read.branch)
      return count > 0 || failed ? [{ repo, read, count: count + (failed?.count ?? 0) }] : []
    })
    // The pull requests reviewing each version in their comments, which
    // count for them alone, and those but `pull` reviewing `pkg` so; a
    // patched one's never, as two pull requests may patch it apart.
    const commentedIn = new Map()
    for (const pull of pulls.filter(({ entry }) => entry.status === 'ready' && entry.review)) {
      for (const pkg of [...addedVersions(pull.entry).versions, ...unreviewedVersions(pull.entry).versions]) {
        if (pkg.commented > 0 && !pkg.patched) commentedIn.set(versionKey(pkg), new Set([...commentedIn.get(versionKey(pkg)) ?? [], pullName(pull)]))
      }
    }
    // Repositories and pull requests named without their owner where every
    // repository reviewed, or not yet read, has the same one.
    const owners = new Set(reads.filter(({ read }) => read.status !== 'ready' || read.branch).map(({ repo }) => repo.name.split('/')[0]))
    const shorten = owners.size === 1 ? name => name.slice(name.indexOf('/') + 1) : name => name
    const named = pull => shorten(pullName(pull))
    const elsewhere = (pkg, pull = null) => pkg.patched ? []
      : [...commentedIn.get(versionKey(pkg)) ?? []].filter(name => !pull || name !== pullName(pull)).map(shorten)
    const naming = { elsewhere, named, shorten }
    const failed = failures.map(([name, error]) => `${shorten(name)}: ${error}`)
    // The default branch's sub-tab where it wants reviews, or, picked, while
    // its repositories are read.
    const picked = state.teamDependenciesTab
    const tabs = TABS.filter(([kind]) => kind !== 'branch' || branches.length > 0 || reading && picked === 'branch')
    const tab = tabs.some(([kind]) => kind === picked) ? picked : 'pulls'
    this._shown = tab
    const counts = { pulls: wanting.length, versions: adding.size, branch: branches.reduce((sum, { count }) => sum + count, 0) }
    return html`<div class="team-deps">
      ${dialogTabs({ tabs: tabs.map(([id, label]) => ({ id, label: html`${label}${counts[id] == null || reading && counts[id] === 0 ? nothing
        : html`<span class="team-deps-tab-n">${counts[id].toLocaleString('en-US')}</span>`}` })), current: tab, prefix: 'team-deps', select: kind => this.pick(kind) })}
      <div class="team-deps-panel" role="tabpanel" id=${`team-deps-panel-${tab}`} aria-labelledby=${`team-deps-tab-${tab}`}>
      ${tab === 'reviews' ? withCompare(() => html`<dependency-review-list .session=${state.managedSession} .team=${this.team}></dependency-review-list>`) : html`
      ${reading ? html`<p class="team-deps-quiet" role="status">Reading their pull requests…</p>` : nothing}
      ${failed.length === 1 ? html`<p class="team-deps-quiet" role="alert">${failed[0]}</p>` : failed.length > 1
        ? html`<p class="team-deps-quiet" role="alert" data-tooltip=${failed.join('\n')}>${plural(failed.length, 'repository or pull request')} couldn’t be read.</p>` : nothing}
      ${!reading && reads.length > 0 && reviewed.length === 0 && failures.length === 0
        ? html`<p class="workspace-content-empty">None of this team’s repositories reviews its dependencies for you.</p>` : nothing}
      ${tab === 'branch' ? nothing : unchecked.map(({ repo, read }) => html`<p class="team-deps-quiet" role="alert">Only ${shorten(repo.name)}’s ${plural(read.pulls.items.length, 'open pull request')}
        updated latest are checked; its others aren’t.</p>`)}
      ${reviewed.length === 0 ? nothing : tab === 'pulls' ? this.renderPulls(wanting, adding, reading, unchecked.length > 0, naming)
        : tab === 'versions' ? this.renderVersions(adding, reading, naming) : branches.map(({ repo, read }) => this.renderBranch(repo, read, naming))}`}
      </div>
    </div>`
  }

  // The pull requests wanting reviews, fewest first, each version a pull
  // request above adds told by it alone, those listed apart; each version
  // other pull requests review in their comments told so (`elsewhere`); and
  // the reader's reviews of its versions to copy, where the server's host
  // formats them (dependency-review-copy.js); one wanting none is not
  // listed, its copy in its popup. Each named as `naming` names it, a card
  // as wide as its versions want (CARD_SPANS): one column of them for one,
  // two for two, else, or a list of it opened, every column.
  renderPulls(wanting, adding, reading, unchecked, { elsewhere, named }) {
    if (wanting.length === 0) {
      return reading ? nothing : html`<p class="workspace-content-empty">No open pull request${unchecked ? ' checked' : ''} wants its dependencies reviewed.</p>`
    }
    const told = new Set()
    const row = pull => pkg => versionRow(pkg, pull.entry.review, { others: (adding.get(versionKey(pkg)) ?? []).filter(other => other !== pull).map(named),
      elsewhere: elsewhere(pkg, pull) })
    return html`<ol class="team-deps-pulls" aria-label="Pull requests wanting reviews">${wanting.map(pull => {
      const own = pull.wanted.filter(pkg => !told.has(versionKey(pkg)))
      const above = pull.wanted.filter(pkg => told.has(versionKey(pkg)))
      for (const pkg of own) told.add(versionKey(pkg))
      const key = pullName(pull)
      const others = unreviewedVersions(pull.entry)
      const href = `https://github.com/${pull.repo.name}/pull/${pull.item.number}`
      const opened = ['own', 'above', 'others'].some(list => this._open.has(`${key}:${list}`))
      return html`<li class=${`team-deps-pull${opened ? ' is-wide' : CARD_SPANS[own.length] ?? ' is-wide'}`}>
        <div class="team-deps-pull-top"><a class="team-deps-pull-head" href=${href} target="_blank" rel="noopener noreferrer" @click=${event => this.open(event, pull)}>
          <span class="team-deps-pull-name">${named(pull)}</span><span class="team-deps-pull-title">${pull.item.title || '(no title)'}</span>
          <span class=${`team-deps-count${pull.failed ? ' is-failed' : ''}`}>${pull.failed ? 'review fails' : pull.size > 0 ? `${plural(pull.toReview, 'version')} to review`
            : `${plural(pull.others, 'other version')} unreviewed`}</span>
        </a>${pull.entry.formatted ? html`<dependency-review-copy .text=${pull.entry.formatted} .label=${'Copy your dependency reviews of its versions'}></dependency-review-copy>`
          : nothing}</div>
        ${this.rows(`${key}:own`, own, row(pull))}
        ${pull.untold > 0 ? html`<p class="team-deps-quiet">and ${plural(pull.untold, 'more version')} past those listed</p>` : nothing}
        ${above.length > 0 ? this.disclosed(`${key}:above`, `${plural(above.length, 'version')} a pull request above adds too`, above, row(pull)) : nothing}
        ${pull.others > 0 ? this.disclosed(`${key}:others`, pull.size > 0 || pull.failed ? `${plural(pull.others, 'other version')} its lockfiles lock ${pull.others === 1 ? 'wants' : 'want'} reviews`
          : `Its own versions pass; ${plural(pull.others, 'version')} its lockfiles locked before ${pull.others === 1 ? 'wants' : 'want'} reviews`,
        others.versions, pkg => versionRow(pkg, pull.entry.review, { elsewhere: elsewhere(pkg, pull) }), pull.others - others.versions.length) : nothing}
      </li>`
    })}</ol>`
  }

  // Every version the pull requests add wanting reviews, each once, all of
  // them listed, by the pull requests adding it, every one reviewing it in
  // its comments told so, the first adding it, whose count it shows, too.
  renderVersions(adding, reading, { elsewhere, named }) {
    if (adding.size === 0) return reading ? nothing : html`<p class="workspace-content-empty">No version an open pull request adds wants a review.</p>`
    return html`<section class="team-deps-section" aria-label="Versions to review"><p class="team-deps-quiet">${plural(adding.size, 'version')} to review, each once,
      by the pull requests adding it.</p>
      ${this.rows('versions', [...adding.entries()], ([key, pulls]) => {
        const pkg = pulls[0].wanted.find(one => versionKey(one) === key)
        return versionRow(pkg, pulls[0].entry.review, { others: pulls.map(named), adders: true, elsewhere: elsewhere(pkg) })
      }, Number.POSITIVE_INFINITY)}
    </section>`
  }

  // What a repository's default branch locks that wants reviews, and what
  // fails it there, its lockfiles left unread too.
  renderBranch(repo, read, { elsewhere, shorten }) {
    const { versions, count } = unreviewedVersions(read.branch)
    const failed = reviewFailures(read.branch)
    const unread = failed?.unread.flatMap(dir => dir.paths) ?? []
    const listed = [...versions, ...failed?.versions ?? []]
    return html`<section class="team-deps-section" aria-label=${`${shorten(repo.name)}’s default branch`}><h2>${shorten(repo.name)}</h2>
      <p class="team-deps-quiet">${plural(count, 'version')} unreviewed${failed?.count
      ? `, ${failed.count.toLocaleString('en-US')} can’t be reviewed` : ''}${unread.length > 0 ? `, ${plural(unread.length, 'lockfile')} unread` : ''}</p>
      ${unread.length > 0 ? html`<p class="team-deps-quiet" role="alert">Unread, so what ${unread.length === 1 ? 'it locks isn’t' : 'they lock aren’t'} checked:
        ${unread.map((path, at) => html`${at > 0 ? ', ' : ''}<code>${path}</code>`)}</p>` : nothing}
      ${this.rows(`branch:${repo.repoId}`, listed, pkg => versionRow(pkg, read.branch.review, { elsewhere: elsewhere(pkg) }), SHOWN_LISTED)}
      ${count > versions.length ? html`<p class="team-deps-quiet">and ${(count - versions.length).toLocaleString('en-US')} more, not listed</p>` : nothing}
    </section>`
  }
}

customElements.define('team-dependencies', TeamDependencies)
