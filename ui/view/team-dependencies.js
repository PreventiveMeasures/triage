// A team's dependencies to review, its Dependencies tab, where its reader
// reviews them in it (workspace-content.js): of each of its repositories
// whose review is in effect for them, the open pull requests whose versions
// want reviews, those adding fewest first, each version with its review as
// its pull request's is (pull-dependencies.js), one a pull request above
// adds told under it alone, as it is reviewed once whichever adds it; then,
// apart, every version wanting one, each once, by the pull requests adding
// it, and what each repository's default branch locks that wants one. A
// repository's are held for the session a while (KEEP_MS), its pull
// requests' as their tiles hold them; and read again once a repository's or
// a team's review is set anew. As many repositories are read at once as
// READ_AT_ONCE.
import { html, nothing } from 'lit'
import { StateElement } from '@rray/frontend/state-element'
import { state } from '#client/index.js'
import { fetchBranchDependencies, fetchRepositoryIssues } from './client-managed.js'
import { addedVersions, checked, pullDependencies, readsDependencies, reviewFailures, reviewOf, subscribePullDependencies, unreviewedVersions } from './pull-dependencies.js'
import { openRepositoryItemDialog } from './lazy-dialogs.js'
import { PACKAGE_ICON } from './repository-tiles.js'
import { managedRoutePath } from '../../common/managed/routes.js'

const KEEP_MS = 2 * 60_000
const RETRY_MS = 30_000
// Pages of a repository's open pull requests read, and the versions told
// under each pull request, the rest counted.
const PULL_PAGES = 3
const SHOWN_VERSIONS = 8
const READ_AT_ONCE = 3

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
  if (shown === 'wanted') return html`<span class="team-deps-review is-wanted" data-tooltip=${`${plural(pkg.reviews, 'review')} of ${review.required} required`}>${pkg.reviews}/${review.required}</span>`
  return nothing
}

// A version as a row: its name and version, opening its review where its
// reader reviews it and it can be, against the version it was where it was
// one, else its page; its review; and the pull requests adding it besides,
// or, `adders`, all those adding it.
function versionRow(pkg, review, others = [], adders = false) {
  const npm = pkg.source === 'registry' && pkg.version
  const before = pkg.was?.find(prior => prior !== pkg.version)
  const reviewing = review?.canReview && !pkg.patched && reviewOf(pkg, review) !== 'unsupported'
  const href = npm ? managedRoutePath({ view: 'npm', packageName: pkg.name, packageSpec: pkg.version,
    ...reviewing ? { bundleTab: 'review', ...before ? { reviewPackage: pkg.name, reviewSpec: before } : {} } : {} }) : null
  const label = html`${PACKAGE_ICON}<span class="team-deps-name">${pkg.name}${pkg.version ? html`<span class="team-deps-version">@${pkg.version}</span>` : nothing}</span>
    ${reviewBadge(pkg, review)}
    ${others.length > 0 ? html`<span class="team-deps-also" data-tooltip=${`Added by ${others.join(', ')}${adders ? '' : ' too'}`}>${adders
      ? `${others[0]}${others.length > 1 ? ` +${others.length - 1}` : ''}` : `+${others.length}`}</span>` : nothing}`
  return html`<li>${href ? html`<a class="team-deps-row" href=${href} target="_blank" rel="noopener noreferrer">${label}</a>` : html`<span class="team-deps-row">${label}</span>`}</li>`
}

class TeamDependencies extends StateElement {
  static properties = { repositories: { attribute: false } }

  createRenderRoot() { return this }

  constructor() {
    super()
    this.repositories = []
    this._notify = () => this.requestUpdate()
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

  render() {
    const repos = [...new Map((this.repositories ?? []).map(repo => [repo.repoId, repo])).values()]
    const reads = repos.map(repo => ({ repo, read: repositoryRead(repo.repoId) }))
    const reviewed = reads.filter(({ read }) => read.status === 'ready' && read.branch)
    const pulls = reviewed.flatMap(({ repo, read }) => read.pulls.items.filter(readsDependencies)
      .map(item => ({ repo, item, entry: pullDependencies(repo.repoId, item.number, true) })))
    const wanting = pulls.filter(({ entry }) => entry.status === 'ready' && entry.review).map(pull => {
      const wanted = addedVersions(pull.entry).versions.filter(pkg => ['wanted', 'unsupported'].includes(reviewOf(pkg, pull.entry.review)))
      return { ...pull, wanted, failed: reviewFailures(pull.entry), toReview: pull.entry.review.toReview ?? wanted.length }
    }).filter(pull => pull.wanted.length > 0 || pull.failed)
      .toSorted((a, b) => a.wanted.length - b.wanted.length || (a.repo.name < b.repo.name ? -1 : a.repo.name > b.repo.name ? 1 : b.item.number - a.item.number))
    const adding = new Map()
    for (const pull of wanting) for (const pkg of pull.wanted) adding.set(versionKey(pkg), [...adding.get(versionKey(pkg)) ?? [], pull])
    const reading = reads.some(({ read }) => read.status === 'loading') || pulls.some(({ entry }) => entry.status === 'loading')
    const failures = [...reads.filter(({ read }) => read.status === 'error').map(({ repo, read }) => `${repo.name}: ${read.error}`),
      ...pulls.filter(({ entry }) => entry.status === 'error').map(pull => `${pullName(pull)}: ${pull.entry.error}`)]
    return html`<div class="team-deps">
      ${reading ? html`<p class="team-deps-quiet" role="status">Reading their pull requests…</p>` : nothing}
      ${failures.length === 1 ? html`<p class="team-deps-quiet" role="alert">${failures[0]}</p>` : failures.length > 1
        ? html`<p class="team-deps-quiet" role="alert" data-tooltip=${failures.join('\n')}>${plural(failures.length, 'repository or pull request')} couldn’t be read.</p>` : nothing}
      ${!reading && reads.length > 0 && reviewed.length === 0 && failures.length === 0
        ? html`<p class="workspace-content-empty">None of this team’s repositories reviews its dependencies for you.</p>` : nothing}
      ${reviewed.length > 0 ? this.renderPulls(wanting, adding, reading) : nothing}
      ${this.renderVersions(adding)}
      ${reviewed.map(({ repo, read }) => this.renderBranch(repo, read))}
    </div>`
  }

  // The pull requests wanting reviews, fewest first, each version a pull
  // request above adds told by it alone.
  renderPulls(wanting, adding, reading) {
    if (wanting.length === 0) return reading ? nothing : html`<p class="workspace-content-empty">No open pull request wants its dependencies reviewed.</p>`
    const told = new Set()
    return html`<section class="team-deps-section" aria-label="Pull requests wanting reviews"><h2>Pull requests</h2><ol class="team-deps-pulls">${wanting.map(pull => {
      const own = pull.wanted.filter(pkg => !told.has(versionKey(pkg)))
      const above = pull.wanted.filter(pkg => told.has(versionKey(pkg)))
      for (const pkg of own) told.add(versionKey(pkg))
      const href = `https://github.com/${pull.repo.name}/pull/${pull.item.number}`
      return html`<li class="team-deps-pull">
        <a class="team-deps-pull-head" href=${href} target="_blank" rel="noopener noreferrer" @click=${event => this.open(event, pull)}>
          <span class="team-deps-pull-name">${pullName(pull)}</span><span class="team-deps-pull-title">${pull.item.title || '(no title)'}</span>
          <span class=${`team-deps-count${pull.failed ? ' is-failed' : ''}`}>${pull.failed ? 'review fails' : `${plural(pull.toReview, 'version')} to review`}</span>
        </a>
        ${own.length > 0 ? html`<ul class="team-deps-versions">${own.slice(0, SHOWN_VERSIONS).map(pkg => versionRow(pkg, pull.entry.review,
          (adding.get(versionKey(pkg)) ?? []).filter(other => other !== pull).map(pullName)))}</ul>` : nothing}
        ${own.length > SHOWN_VERSIONS ? html`<p class="team-deps-quiet">and ${(own.length - SHOWN_VERSIONS).toLocaleString('en-US')} more</p>` : nothing}
        ${above.length > 0 ? html`<p class="team-deps-quiet" data-tooltip=${above.map(versionKey).join(', ')}>and ${plural(above.length, 'version')} a pull request above adds too</p>` : nothing}
      </li>`
    })}</ol></section>`
  }

  // Every version the pull requests add wanting reviews, each once, by the
  // pull requests adding it, apart.
  renderVersions(adding) {
    if (adding.size === 0) return nothing
    return html`<details class="team-deps-section"><summary>${plural(adding.size, 'version')} to review, each once</summary>
      <ul class="team-deps-versions">${[...adding.entries()].map(([key, pulls]) => versionRow(pulls[0].wanted.find(pkg => versionKey(pkg) === key),
        pulls[0].entry.review, pulls.map(pullName), true))}</ul>
    </details>`
  }

  // What a repository's default branch locks that wants reviews, and what
  // fails it there, apart.
  renderBranch(repo, read) {
    const { versions, count } = unreviewedVersions(read.branch)
    const failed = reviewFailures(read.branch)
    if (count === 0 && !failed) return nothing
    return html`<details class="team-deps-section"><summary>${repo.name}’s default branch: ${plural(count, 'version')} unreviewed${failed?.count
      ? `, ${failed.count.toLocaleString('en-US')} can’t be reviewed` : ''}</summary>
      <ul class="team-deps-versions">${[...versions, ...failed?.versions ?? []].map(pkg => versionRow(pkg, read.branch.review))}</ul>
      ${count > versions.length ? html`<p class="team-deps-quiet">and ${(count - versions.length).toLocaleString('en-US')} more</p>` : nothing}
    </details>`
  }
}

customElements.define('team-dependencies', TeamDependencies)
