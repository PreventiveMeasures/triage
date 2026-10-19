// A team's dependencies to review, its Dependencies tab, where its reader
// reviews them in it (workspace-content.js), a sub-tab each (TABS), drawn
// as a dialog's header tabs are (header-tabs.js), the one open
// (`state.teamDependenciesTab`) its address's, /team/<slug>/dependencies
// [/<tab>], and scrolling under them: of each
// of its repositories whose review is in effect for them, the open pull
// requests whose versions want reviews, in the order picked (SORTS), each
// version with its review as its pull request's is (pull-dependencies.js),
// one a pull request above adds dimmed under those after it, naming that
// one, as it is reviewed once whichever adds it; every version they add
// wanting one, each once, by the pull requests adding it; what each
// repository's default branch locks that wants one, where any does; and the
// reviews published to the team
// (dependency-review-list.js). Its repositories not held read in one request
// of the team's (GET /api/teams/:id/dependencies), each as its lines come:
// its default branch and open pull requests, then their dependencies, held
// as pull-dependencies.js holds those a tile or a popup asks for
// (seedPullDependencies), and the lines their versions change where they
// are counted already (npm-delta.js seedNpmDeltas). A repository's are held
// for the session a while (KEEP_MS), each shown as it was while read again;
// those the server's time left asked for again; and read anew once a
// repository's or a team's review is set anew. A pull request is named
// without its repository's owner where every repository reviewed has the
// same one.
import { html, nothing, svg } from 'lit'
import { StateElement } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { fetchTeamDependencies } from './client-managed.js'
import { addedVersions, checked, heldPullDependencies, readsDependencies, reviewFailures, reviewOf, seedPullDependencies, subscribePullDependencies,
  unreviewedVersions } from './pull-dependencies.js'
import { openRepositoryItemDialog } from './lazy-dialogs.js'
import { PACKAGE_ICON, icon } from './repository-tiles.js'
import { dialogTabs } from './header-tabs.js'
import { withCompare } from './compare-load.js'
import { deltaBase, seedNpmDeltas } from './npm-delta.js'
import './dependency-review-copy.js'
import { managedHistory } from './managed-history.js'
import { managedRouteForIds, managedRoutePath } from '../../common/managed/routes.js'

const KEEP_MS = 2 * 60_000
const RETRY_MS = 30_000
// How many times a read the server's time cut short goes on, the
// repositories it left asked for again; and the versions shown of a list,
// under a pull request or a default branch, the rest shown once asked for.
const RESUMES = 3
const SHOWN_VERSIONS = 12
const SHOWN_LISTED = 48
// Its sub-tabs, each at an address of its own, the one last picked
// opened again by the team's Dependencies tab (ingest.js
// switchToWorkspaceContent).
const TABS = [['pulls', 'Pull requests'], ['versions', 'Versions'], ['branch', 'Default branch'], ['reviews', 'Reviews']]
// The orders of its Pull requests sub-tab (`state.teamDependenciesSort`),
// by what each is named in its picker: the newest opened first, the latest
// updated first, or those adding fewest versions to review first, one held by
// others alone after those adding some, then by the fewest those are; each
// one's ties by repository, then the newest by number.
const tied = (a, b) => a.repo.name < b.repo.name ? -1 : a.repo.name > b.repo.name ? 1 : b.item.number - a.item.number
const latest = field => (a, b) => (b.item[field] ?? 0) - (a.item[field] ?? 0) || tied(a, b)
const fewest = (a, b) => Number(a.size === 0) - Number(b.size === 0) || a.size - b.size || a.others - b.others || tied(a, b)
const SORTS = { newest: ['Newest', latest('createdAt')], updated: ['Updated', latest('updatedAt')], fewest: ['Fewest to review', fewest] }
// A pull request whose dependencies are still to be told.
const TELLING = { status: 'loading', until: Number.POSITIVE_INFINITY }

const held = new Map()
const listeners = new Set()
// The reads in flight, by the team each reads, stopped once what they read
// is forgotten, or once no tab shows their team: a read runs minutes, and
// resumes, which a tab left would leave running for none.
const inFlight = new Map()
// The team each tab shows, by its element.
const showing = new Map()
let heldFor = null
let sweeping = false
const changed = () => { for (const notify of listeners) notify() }
function forget() {
  held.clear()
  for (const read of inFlight.keys()) read.abort()
  inFlight.clear()
}
// Reads of teams no tab shows stopped, once those moved meanwhile are back
// in place, what they held read again once drawn (readTeam).
function stopUnshown() {
  if (sweeping) return
  sweeping = true
  queueMicrotask(() => {
    sweeping = false
    const teams = new Set(showing.values())
    for (const [read, team] of inFlight) if (!teams.has(team)) read.abort()
  })
}
globalThis.addEventListener?.('dependency-review-changed', () => {
  forget()
  changed()
})

function sessionHeld() {
  const session = state.managedSession ? `${state.managedSession.id}\0${state.managedSession.role}` : null
  if (session !== heldFor) {
    forget()
    heldFor = session
  }
  return held
}

// Repositories `repoIds` of team `team`, each as held, else asked for, all
// those not held, or grown old, in one read (readTeam): `{ status }`,
// 'loading', then 'ready' with its default branch's dependencies (`branch`,
// none where no review is in effect, nor where its reader may read only
// some of it) and, where they are, its open pull requests (`pulls`), those
// whose dependencies are still to be told by their numbers (`telling`), or
// 'error' with its `error`; one grown old shown as it was while it is read
// again (`refreshing`), lest its pull requests leave the tab meanwhile.
function teamRepositories(team, repoIds) {
  const data = sessionHeld()
  const asked = []
  const entries = repoIds.map(repoId => {
    const entry = data.get(repoId)
    if (entry && Date.now() < entry.until) return entry
    const loading = entry?.status === 'ready' ? { ...entry, until: Number.POSITIVE_INFINITY, telling: null, refreshing: true }
      : { status: 'loading', until: Number.POSITIVE_INFINITY }
    data.set(repoId, loading)
    asked.push(repoId)
    return loading
  })
  if (asked.length > 0) readTeam(team, asked, asked.length === repoIds.length ? null : asked, RESUMES)
  return entries
}

// Repositories `asked` of team `team` read in one request, those
// `repoIds` names alone where it names some, each held as its lines tell
// it; those the server's time left asked for again, as many times as
// `resumes`.
function readTeam(team, asked, repoIds, resumes) {
  const data = held
  // Each one's entry as this read last held it, those it told all of left out.
  const current = new Map(asked.map(repoId => [repoId, data.get(repoId)]))
  const set = (repoId, entry) => {
    if (data.get(repoId) === current.get(repoId)) data.set(repoId, entry)
    if (data.get(repoId) === entry && entry.telling) current.set(repoId, entry)
    else current.delete(repoId)
  }
  const controller = new AbortController()
  inFlight.set(controller, team)
  let unread = null
  fetchTeamDependencies(team, line => {
    if (controller.signal.aborted) return
    if (typeof line.done === 'boolean') unread = line.done ? [] : (Array.isArray(line.unread) ? line.unread : [])
    else if (current.has(line.repoId)) {
      toldLine(line, current.get(line.repoId), entry => set(line.repoId, entry))
      changed()
    }
  }, { repoIds, signal: controller.signal }).then(() => {
    const again = (unread ?? []).filter(repoId => current.has(repoId)), resuming = again.length > 0 && resumes > 0
    for (const [repoId, entry] of [...current]) {
      if (resuming && again.includes(repoId)) continue
      set(repoId, untold(repoId, entry, unread === null ? 'The server’s answer ended short.' : again.includes(repoId) ? 'Reading its pull requests took too long.' : null))
    }
    if (resuming) readTeam(team, again, again, resumes - 1)
    return null
  }, err => {
    for (const [repoId, entry] of [...current]) {
      if (err?.name !== 'AbortError') set(repoId, untold(repoId, entry, err?.message || 'It couldn’t be read.'))
      // One aborted read again once drawn, shown as it was meanwhile.
      else if (data.get(repoId) === entry) {
        if (entry.status === 'ready') data.set(repoId, { ...entry, until: 0, telling: null })
        else data.delete(repoId)
      }
    }
  }).finally(() => {
    inFlight.delete(controller)
    changed()
  })
}

// What repository line `line` tells of one held as `entry`, given to `hold`:
// that no review is in effect for its reader, or why it couldn't be read;
// its default branch's dependencies and its open pull requests; or some of
// their dependencies, seeded (seedPullDependencies), those to be told
// fewer. Each with the lines its versions change, seeded first
// (seedNpmDeltas), lest their rows ask for them.
function toldLine(line, entry, hold) {
  if (Array.isArray(line.deltas)) seedNpmDeltas(line.deltas)
  if (typeof line.error === 'string') hold({ status: 'error', until: Date.now() + RETRY_MS, error: line.error })
  else if (line.branch === null) hold({ status: 'ready', until: Date.now() + KEEP_MS, branch: null })
  else if (line.branch) {
    let branch
    try { branch = checked(line.branch) } catch (err) {
      hold({ status: 'error', until: Date.now() + RETRY_MS, error: err.message })
      return
    }
    const items = (Array.isArray(line.pulls?.items) ? line.pulls.items : []).filter(item => Number.isSafeInteger(item?.number) && item.number > 0)
    hold(telling({ status: 'ready', branch, pulls: { items, more: line.pulls?.more === true } }, new Set(items.filter(readsDependencies).map(item => item.number))))
  } else if (line.dependencies instanceof Map && entry.telling) {
    seedPullDependencies(line.repoId, line.dependencies, true)
    hold(telling(entry, new Set([...entry.telling].filter(number => !line.dependencies.has(number)))))
  }
}
// One held with the pull requests still to be told, till none are.
const telling = (entry, numbers) => numbers.size > 0 ? { ...entry, until: Number.POSITIVE_INFINITY, telling: numbers }
  : { ...entry, until: Date.now() + KEEP_MS, telling: null }

// One a read told no more of, as held: one it told nothing of, as none of
// its team's, so reviewing none for its reader (`failure` none); else
// failed, till it is read again, one whose default branch was told kept,
// its pull requests still to be told failed.
function untold(repoId, entry, failure) {
  if (entry.telling) {
    seedPullDependencies(repoId, new Map([...entry.telling].map(number => [number, new Error(failure ?? 'The server’s answer ended short.')])), true)
    return { ...entry, until: Date.now() + RETRY_MS, telling: null }
  }
  return failure ? { status: 'error', until: Date.now() + RETRY_MS, error: failure } : { status: 'ready', until: Date.now() + KEEP_MS, branch: null }
}

const plural = (count, noun) => `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`
const versionKey = pkg => `${pkg.name}@${pkg.version ?? ''}${pkg.patched ? '+patch' : ''}`
const pullName = ({ repo, item }) => `${repo.name}#${item.number}`

// A version's review: that it can't be reviewed, a reviewer rejects it, a
// patched one wants the server's reviewed dependencies, or how many reviews
// pass it of those it needs; its badge's label, tint, heading and what it
// says, in a line or as rows (`rows`), none where it wants no review.
const WHY = { git: 'From git, which isn’t reviewed', tarball: 'A tarball not npm’s registry’s of its version, which isn’t reviewed',
  integrity: 'Locked with no integrity, which its reviews are held to' }
function reviewState(pkg, review) {
  const shown = reviewOf(pkg, review)
  if (shown === 'unsupported') return { label: 'can’t review', tint: 'is-failed', head: 'Can’t be reviewed', said: WHY[pkg.unsupported] }
  if (pkg.rejected) return { label: 'rejected', tint: 'is-failed', head: 'Rejected', said: 'A reviewer rejects it: it wants their newer accepting review' }
  if (pkg.patched && shown === 'wanted') {
    return { label: 'patched', tint: 'is-wanted', head: 'Patched',
      said: 'Reviews here pass no patch: the server’s reviewed dependencies, or reviews of its patch in the pull request’s comments, pass it' }
  }
  if (shown === 'wanted') {
    return { label: `${pkg.reviews}/${review.required}`, tint: 'is-wanted', head: 'Reviews', said: `${plural(pkg.reviews, 'review')} of ${review.required} required${pkg.commented
      ? `; ${plural(pkg.commented, 'reviewer')} in its comments, which count here alone` : ''}`,
    rows: [['Passing', `${pkg.reviews.toLocaleString('en-US')} of ${review.required} required`],
      ...pkg.commented ? [['In its comments', `${plural(pkg.commented, 'reviewer')}, counting here alone`]] : []] }
  }
  return null
}
// A review's badge, what it says its tooltip, formatted.
function reviewBadge(pkg, review) {
  const stance = reviewState(pkg, review)
  if (!stance) return nothing
  const tip = html`<div class="compare-tip"><div class="compare-tip-head">${stance.head}</div>${stance.rows
    ? html`<div class="compare-tip-rows">${stance.rows.map(([label, value]) => html`<span class="compare-tip-label">${label}</span><span>${value}</span>`)}</div>`
    : html`<div>${stance.said}</div>`}</div>`
  return html`<span class="team-deps-review ${stance.tint}" data-tooltip=${stance.said ?? nothing} .tooltipContent=${stance.said ? tip : null}>${stance.label}</span>`
}

// Each verdict as a reviewer's line of a version's tooltip says it, and
// those of them accepting it.
const VERDICT_SAID = { accept: 'accepts', 'accept-with-nits': 'accepts with nits', 'request-changes': 'requests changes', reject: 'rejects' }
const ACCEPTING = new Set(['accept', 'accept-with-nits'])
// A version's review in a pull request, as its tooltip names it there.
const reviewedThere = (pkg, review) => ({ passed: 'passes', baseline: 'needs none' })[reviewOf(pkg, review)] ?? reviewState(pkg, review)?.label ?? null

// A version's details, its row's tooltip, formatted: its name and version
// whole, as its row may cut them short; the versions of it present before,
// where it is one a pull request adds (`added`); where it is from, other
// than npm's registry; its review; the pull request above it is listed under
// (`above`); the pull requests adding it, or locking it otherwise
// (`involved`, each `{ name, adds, pkg, review }`), each with its review
// there, the one it is listed under (`here`) marked; and who reviews it,
// each once where its teams' reviews count, and by the pull request in whose
// comments they review it, which count there alone: a patched one's those
// of its own pull request alone, as two pull requests may patch it apart.
function versionTip(pkg, review, { added, above, involved, here }) {
  const stance = reviewState(pkg, review)
  const facts = [added ? ['Present', pkg.was?.join(', ') || 'none, new'] : null, pkg.source !== 'registry' && pkg.from ? ['From', pkg.from] : null,
    stance ? ['Review', stance.said ?? stance.label] : null, above ? ['Listed', `under ${above} above`] : null].filter(Boolean)
  const reviewers = new Map()
  for (const { name, pkg: theirs } of [{ name: here, pkg }, ...pkg.patched ? [] : involved]) {
    for (const one of theirs.reviewers ?? []) {
      if (one.comment && !name) continue
      const key = one.comment ? `${one.login}\0${name}` : one.login
      if (!reviewers.has(key)) reviewers.set(key, { ...one, where: one.comment ? name : null })
    }
  }
  return html`<div class="compare-tip">
    <div class="team-deps-tip-name">${pkg.name}${pkg.version ? `@${pkg.version}` : ''}${pkg.patched ? ' (patched)' : ''}</div>
    ${facts.length > 0 ? html`<div class="compare-tip-rows">${facts.map(([label, value]) => html`<span class="compare-tip-label">${label}</span><span>${value}</span>`)}</div>` : nothing}
    ${involved.length > 0 ? html`<div class="compare-tip-head">Pull requests</div>
      <div class="compare-tip-rows">${involved.map(({ name, adds, pkg: theirs, review: theirReview }) => html`<span class=${name === here ? 'team-deps-tip-here' : nothing}>${name}</span>
        <span>${[adds ? 'adds it' : 'locks it', reviewedThere(theirs, theirReview)].filter(Boolean).join(', ')}</span>`)}</div>` : nothing}
    ${reviewers.size > 0 ? html`<div class="compare-tip-head">Reviewed by</div>
      <div class="compare-tip-rows">${[...reviewers.values()].map(one => html`<span>${one.login}</span>
        <span>${VERDICT_SAID[one.status]}${ACCEPTING.has(one.status) && !one.passes ? ', not counted' : ''}${one.where ? `, in ${one.where}’s comments` : ''}</span>`)}</div>`
      : nothing}
  </div>`
}

// A version as a row, its details its tooltip (versionTip): its name and
// version, opening its review where its reader reviews it and it can be,
// against the version it was where it was one, else its page; its review;
// the lines it changes against the version it was, or whole, where it
// wants reviews (npm-delta.js); the pull requests reviewing it in their
// comments (`elsewhere`), which count for them alone; the pull request above
// it is listed under (`above`), where it is one, its tag blue where it
// reviews it so, told by that alone; and the pull requests adding it
// besides, or, `adders`, all those adding it, those reviewing it in their
// comments named by that alone.
function versionRow(pkg, review, { others = [], adders = false, elsewhere = [], above = null, added = false, involved = [], here = null } = {}) {
  const npm = pkg.source === 'registry' && pkg.version
  const before = pkg.was?.find(prior => prior !== pkg.version)
  const reviewing = review?.canReview && !pkg.patched && reviewOf(pkg, review) !== 'unsupported'
  const href = npm ? managedRoutePath({ view: 'npm', packageName: pkg.name, packageSpec: pkg.version,
    ...reviewing ? { bundleTab: 'review', ...before ? { reviewPackage: pkg.name, reviewSpec: before } : {} } : {} }) : null
  const named = `${pkg.name}${pkg.version ? `@${pkg.version}` : ''}`
  const tip = versionTip(pkg, review, { added, above, involved, here })
  const unnamed = adders ? others.filter(name => !elsewhere.includes(name)) : others
  const reviewedAbove = above !== null && elsewhere.includes(above)
  const inReview = reviewedAbove ? elsewhere.filter(name => name !== above) : elsewhere
  const label = html`${PACKAGE_ICON}<span class="team-deps-name">${pkg.name}${pkg.version ? html`<span class="team-deps-version">@${pkg.version}</span>` : nothing}</span>
    ${npm && reviewOf(pkg, review) === 'wanted' ? html`<npm-delta .name=${pkg.name} .version=${pkg.version} .base=${deltaBase(pkg)}></npm-delta>` : nothing}
    ${reviewBadge(pkg, review)}
    ${above ? html`<span class="team-deps-above${reviewedAbove ? ' is-reviewed' : ''}">${above}</span>` : nothing}
    ${inReview.length > 0 ? html`<span class="team-deps-elsewhere">${inReview[0]}${inReview.length > 1 ? ` +${inReview.length - 1}` : ''}</span>` : nothing}
    ${unnamed.length > 0 ? html`<span class="team-deps-also">${adders ? `${unnamed[0]}${unnamed.length > 1 ? ` +${unnamed.length - 1}` : ''}` : `+${others.length}`}</span>` : nothing}`
  return html`<li>${href ? html`<a class="team-deps-row" href=${href} target="_blank" rel="noopener noreferrer" data-tooltip=${named} .tooltipContent=${tip}>${label}</a>`
    : html`<span class="team-deps-row" data-tooltip=${named} .tooltipContent=${tip}>${label}</span>`}</li>`
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
    showing.set(this, this.team)
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    listeners.delete(this._notify)
    this._unsubscribe?.()
    showing.delete(this)
    stopUnshown()
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
    // Another team shown, the one shown before no longer read for it; one
    // drawn once its tab is gone shows none.
    if (this.isConnected && showing.get(this) !== this.team) {
      if (showing.has(this)) stopUnshown()
      showing.set(this, this.team)
    }
    const repos = [...new Map((this.repositories ?? []).map(repo => [repo.repoId, repo])).values()]
    const entries = teamRepositories(this.team, repos.map(repo => repo.repoId))
    const reads = repos.map((repo, at) => ({ repo, read: entries[at] }))
    const reviewed = reads.filter(({ read }) => read.status === 'ready' && read.branch)
    // Each pull request's as the team's read told it, or as it was while it is read again.
    const pulls = reviewed.flatMap(({ repo, read }) => read.pulls.items.filter(readsDependencies)
      .map(item => ({ repo, item, entry: heldPullDependencies(repo.repoId, item.number, true) ?? TELLING })))
    // Each pull request's versions wanting reviews, as many as its answer
    // tells, and how many in all, those past them too (`toReview`), by which
    // it is kept; and the other versions its lockfiles lock that want them
    // (`others`), the default branch's mostly, which hold it too; those
    // adding fewest first, as Versions takes them, then as picked.
    const wanting = pulls.filter(({ entry }) => entry.status === 'ready' && entry.review).map(pull => {
      const wanted = addedVersions(pull.entry).versions.filter(pkg => ['wanted', 'unsupported'].includes(reviewOf(pkg, pull.entry.review)))
      const told = wanted.filter(pkg => reviewOf(pkg, pull.entry.review) === 'wanted').length
      const toReview = Math.max(pull.entry.review.toReview ?? told, told)
      return { ...pull, wanted, failed: reviewFailures(pull.entry), toReview, untold: toReview - told, size: wanted.length + toReview - told,
        others: unreviewedVersions(pull.entry).count }
    }).filter(pull => pull.size > 0 || pull.others > 0 || pull.failed).toSorted(fewest)
    const sort = Object.hasOwn(SORTS, state.teamDependenciesSort) ? state.teamDependenciesSort : 'newest'
    const sorted = sort === 'fewest' ? wanting : wanting.toSorted(SORTS[sort][1])
    // The repositories whose open pull requests are more than are read.
    const unchecked = reviewed.filter(({ read }) => read.pulls.more)
    // Each version wanting reviews, as the first adding it tells it, by the
    // pull requests adding it.
    const adding = new Map()
    for (const pull of wanting) {
      for (const pkg of pull.wanted) {
        const added = adding.get(versionKey(pkg))
        if (added) added.pulls.push(pull)
        else adding.set(versionKey(pkg), { pkg, pulls: [pull] })
      }
    }
    const reading = reads.some(({ read }) => read.status === 'loading') || pulls.some(({ entry }) => entry.status === 'loading')
    const failures = [...reads.filter(({ read }) => read.status === 'error').map(({ repo, read }) => [repo.name, read.error]),
      ...pulls.filter(({ entry }) => entry.status === 'error').map(pull => [pullName(pull), pull.entry.error])]
    // The default branches with versions wanting reviews, or failing them.
    const branches = reviewed.flatMap(({ repo, read }) => {
      const { count } = unreviewedVersions(read.branch), failed = reviewFailures(read.branch)
      return count > 0 || failed ? [{ repo, read, count: count + (failed?.count ?? 0) }] : []
    })
    // The pull requests each version is among the versions of, by its key:
    // each adding it, else locking it otherwise wanting reviews, with it as
    // it is there.
    const involved = new Map()
    for (const pull of pulls.filter(({ entry }) => entry.status === 'ready' && entry.review)) {
      for (const [adds, versions] of [[true, addedVersions(pull.entry).versions], [false, unreviewedVersions(pull.entry).versions]]) {
        for (const pkg of versions) {
          const of = involved.get(versionKey(pkg)) ?? involved.set(versionKey(pkg), new Map()).get(versionKey(pkg))
          if (!of.has(pullName(pull))) of.set(pullName(pull), { pull, pkg, adds })
        }
      }
    }
    // Repositories and pull requests named without their owner where every
    // repository reviewed, or not yet read, has the same one.
    const owners = new Set(reads.filter(({ read }) => read.status !== 'ready' || read.branch).map(({ repo }) => repo.name.split('/')[0]))
    const shorten = owners.size === 1 ? name => name.slice(name.indexOf('/') + 1) : name => name
    const named = pull => shorten(pullName(pull))
    // The pull requests a version is among the versions of, as its tooltip
    // names them (versionTip); and those reviewing it in their comments,
    // which count for them alone, but `pull`; a patched one's never, as two
    // pull requests may patch it apart.
    const among = pkg => [...involved.get(versionKey(pkg))?.values() ?? []]
      .map(({ pull, pkg: theirs, adds }) => ({ name: named(pull), adds, pkg: theirs, review: pull.entry.review }))
    const elsewhere = (pkg, pull = null) => pkg.patched ? []
      : [...involved.get(versionKey(pkg))?.values() ?? []].filter(one => one.pkg.commented > 0 && (!pull || pullName(one.pull) !== pullName(pull))).map(one => named(one.pull))
    const naming = { elsewhere, named, shorten, among }
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
        ? html`<p class="team-deps-quiet" role="alert" data-tooltip=${failed.join('\n')} .tooltipContent=${html`<div class="compare-tip">
          <div class="compare-tip-head">Couldn’t be read</div>
          <div class="compare-tip-rows">${failures.map(([name, error]) => html`<span>${shorten(name)}</span><span>${error}</span>`)}</div></div>`}>${plural(failed.length,
          'repository or pull request')} couldn’t be read.</p>` : nothing}
      ${!reading && reads.length > 0 && reviewed.length === 0 && failures.length === 0
        ? html`<p class="workspace-content-empty">None of this team’s repositories reviews its dependencies for you.</p>` : nothing}
      ${tab === 'branch' ? nothing : unchecked.map(({ repo, read }) => html`<p class="team-deps-quiet" role="alert">Only ${shorten(repo.name)}’s ${plural(read.pulls.items.length, 'open pull request')}
        updated latest are checked; its others aren’t.</p>`)}
      ${reviewed.length === 0 ? nothing : tab === 'pulls' ? this.renderPulls(sorted, sort, adding, reading, unchecked.length > 0, naming)
        : tab === 'versions' ? this.renderVersions(adding, reading, naming) : branches.map(({ repo, read }) => this.renderBranch(repo, read, naming))}`}
      </div>
    </div>`
  }

  // The pull requests wanting reviews, in the order picked (`sort`), which
  // their picker picks where there are more than one; each version a pull
  // request above adds listed after its own, all of them, dimmed, naming the
  // one above it is listed under; each version other pull requests review
  // in their comments told so (`elsewhere`); and the reader's reviews of its
  // versions to copy, where the server's host formats them
  // (dependency-review-copy.js); one wanting none is not listed, its copy in
  // its popup. Each named as `naming` names it, every card a column wide,
  // however many versions it lists or opens.
  renderPulls(wanting, sort, adding, reading, unchecked, { elsewhere, named, among }) {
    if (wanting.length === 0) {
      return reading ? nothing : html`<p class="workspace-content-empty">No open pull request${unchecked ? ' checked' : ''} wants its dependencies reviewed.</p>`
    }
    // The pull request each version is listed under, the first shown adding it.
    const told = new Map()
    const row = pull => pkg => {
      const above = told.get(versionKey(pkg)) === pull ? null : told.get(versionKey(pkg))
      return versionRow(pkg, pull.entry.review, { others: (adding.get(versionKey(pkg))?.pulls ?? []).filter(other => other !== pull && other !== above).map(named),
        elsewhere: elsewhere(pkg, pull), above: above && named(above), added: true, involved: among(pkg), here: named(pull) })
    }
    return html`${wanting.length > 1 ? html`<div class="team-deps-sort"><span class="bundles-overview-sort" role="group" aria-label="Pull request order">${Object.entries(SORTS)
      .map(([value, [label]]) => html`<button type="button" aria-pressed=${String(value === sort)} @click=${() => { state.teamDependenciesSort = value }}>${label}</button>`)}</span></div>`
      : nothing}
    <ol class="team-deps-pulls" aria-label="Pull requests wanting reviews">${wanting.map(pull => {
      const own = pull.wanted.filter(pkg => !told.has(versionKey(pkg)))
      const above = pull.wanted.filter(pkg => told.has(versionKey(pkg)))
      for (const pkg of own) told.set(versionKey(pkg), pull)
      const key = pullName(pull)
      const others = unreviewedVersions(pull.entry)
      const href = `https://github.com/${pull.repo.name}/pull/${pull.item.number}`
      return html`<li class="team-deps-pull">
        <div class="team-deps-pull-top"><a class="team-deps-pull-head" href=${href} target="_blank" rel="noopener noreferrer" @click=${event => this.open(event, pull)}>
          <span class="team-deps-pull-name">${named(pull)}</span><span class="team-deps-pull-title">${pull.item.title || '(no title)'}</span>
          <span class=${`team-deps-count${pull.failed ? ' is-failed' : ''}`}>${pull.failed ? 'review fails' : pull.size > 0 ? `${plural(pull.toReview, 'version')} to review`
            : `${plural(pull.others, 'other version')} unreviewed`}</span>
        </a>${pull.entry.formatted ? html`<dependency-review-copy .text=${pull.entry.formatted} .label=${'Copy your dependency reviews of its versions'}></dependency-review-copy>`
          : nothing}</div>
        ${this.rows(`${key}:own`, own, row(pull))}
        ${pull.untold > 0 ? html`<p class="team-deps-quiet">and ${plural(pull.untold, 'more version')} past those listed</p>` : nothing}
        ${above.length > 0 ? html`<ul class="team-deps-versions is-above">${above.map(row(pull))}</ul>` : nothing}
        ${pull.others > 0 ? this.disclosed(`${key}:others`, pull.size > 0 || pull.failed ? `${plural(pull.others, 'other version')} its lockfiles lock ${pull.others === 1 ? 'wants' : 'want'} reviews`
          : `Its own versions pass; ${plural(pull.others, 'version')} its lockfiles locked before ${pull.others === 1 ? 'wants' : 'want'} reviews`,
        others.versions, pkg => versionRow(pkg, pull.entry.review, { elsewhere: elsewhere(pkg, pull), involved: among(pkg), here: named(pull) }),
        pull.others - others.versions.length) : nothing}
      </li>`
    })}</ol>`
  }

  // Every version the pull requests add wanting reviews, each once, all of
  // them listed, by the pull requests adding it, every one reviewing it in
  // its comments told so, the first adding it, whose count it shows, too.
  renderVersions(adding, reading, { elsewhere, named, among }) {
    if (adding.size === 0) return reading ? nothing : html`<p class="workspace-content-empty">No version an open pull request adds wants a review.</p>`
    return html`<section class="team-deps-section" aria-label="Versions to review">
      ${this.rows('versions', [...adding.values()], ({ pkg, pulls }) => versionRow(pkg, pulls[0].entry.review, { others: pulls.map(named), adders: true,
        elsewhere: elsewhere(pkg), added: true, involved: among(pkg) }), Number.POSITIVE_INFINITY)}
    </section>`
  }

  // What a repository's default branch locks that wants reviews, and what
  // fails it there, its lockfiles left unread too.
  renderBranch(repo, read, { elsewhere, shorten, among }) {
    const { versions, count } = unreviewedVersions(read.branch)
    const failed = reviewFailures(read.branch)
    const unread = failed?.unread.flatMap(dir => dir.paths) ?? []
    const listed = [...versions, ...failed?.versions ?? []]
    return html`<section class="team-deps-section" aria-label=${`${shorten(repo.name)}’s default branch`}><h2>${shorten(repo.name)}</h2>
      <p class="team-deps-quiet">${plural(count, 'version')} unreviewed${failed?.count
      ? `, ${failed.count.toLocaleString('en-US')} can’t be reviewed` : ''}${unread.length > 0 ? `, ${plural(unread.length, 'lockfile')} unread` : ''}</p>
      ${unread.length > 0 ? html`<p class="team-deps-quiet" role="alert">Unread, so what ${unread.length === 1 ? 'it locks isn’t' : 'they lock aren’t'} checked:
        ${unread.map((path, at) => html`${at > 0 ? ', ' : ''}<code>${path}</code>`)}</p>` : nothing}
      ${this.rows(`branch:${repo.repoId}`, listed, pkg => versionRow(pkg, read.branch.review, { elsewhere: elsewhere(pkg), involved: among(pkg) }), SHOWN_LISTED)}
      ${count > versions.length ? html`<p class="team-deps-quiet">and ${(count - versions.length).toLocaleString('en-US')} more, not listed</p>` : nothing}
    </section>`
  }
}

customElements.define('team-dependencies', TeamDependencies)
