// Manage custom elements, registered by the lazy client-managed.js entry.
// Manage data stays in the lazy bundle; the host supplies session updates and
// renders composed navigation and notification events.
import { getPreviewRole, managedFetch } from '../../client/managed/request.js'
import { html, nothing, unsafeCSS } from 'lit'
import { keyed } from 'lit/directives/keyed.js'
import { reportRepoGithub } from '@preventive/report'
import { FileDrop, ManagedPage, emptyState, errorMessage, loadingRows } from './page.js'
import { appMarkup } from '../view/markup.js'
import { ROLES, roleAtLeast } from '../../common/managed/roles.ts'
import { VISIBILITY_PERMISSION_LABELS } from '../../common/managed/permissions.ts'
import { normalizeNpmScope } from '../../common/managed/npm-packages.js'
import { isStasisConfig } from '../../common/managed/stasis-config.ts'
import { REPORT_LOGOS } from '../view/report-logos.js'
import { displayName } from '../../common/report-display-name.js'
import { DELETE_ICON_SVG, EDIT_ICON_SVG } from '../view/icons.js'
import { formatBytes } from '../scan/metrics.js'
import { adminIcon, openAdminPage } from './navigation.js'
import { ManagedLocalImport } from './local-import.js'
import { fetchBundleOrigin } from './bundle-data.js'
import { addPublicRepository, connectRepositoryApp, createBundle, deleteBundle, deleteReport, fetchBundleUsage, fetchBundles, fetchHistory, fetchReportLocation, fetchReports, fetchRepositories, fetchRepositoryImpact, fetchRepositoryLockfiles, fetchTeams, fetchUsers, postTeam, removeRepository, selectRepository, setBundleRepo, setBundleVisible, setReportRepo, setReportVisible, setRepositoryDependencyReview, setRole, uploadBundle, uploadReport } from './admin-api.js'
import { uploadFiles, uploadLocalFile } from './file-uploads.js'
import { viewAs } from '../../client/managed/session.js'
import localImportStyles from './styles/local-import.css'
import commonStyles from './styles/common.css'
import homeStyles from './styles/home.css'
import historyStyles from './styles/history.css'
import usersStyles from './styles/users.css'
import reposStyles from './styles/repos.css'
import reportsStyles from './styles/reports.css'
import bundlesStyles from './styles/bundles.css'
import locationStyles from './styles/location.css'
import teamsStyles from './styles/teams.css'
import { loadScanPage } from '../view/scan-load.js'
import './create-bundle.js'
import '../view/mode-switch.js'
import { loadManagedScanBundle, managedScanSource } from './scan-source.js'
import { managedRoutePath } from '../../common/managed/routes.js'
import { managedReportSources } from '../scan/report-source.js'
import { fetchScanModels } from '../view/scan-models.js'
import { repositoryChoices } from '../view/repository-options.js'
import '../view/repository-selector.js'
import '../view/user-selector.js'
import './repository-aliases.js'

function adminAvatar(id, login) {
  return html`<span class="avatar" aria-hidden="true">
    <span>${(login?.[0] ?? '?').toUpperCase()}</span>
    ${getPreviewRole() ? nothing : html`<img alt="" src=${`/api/avatar/${encodeURIComponent(id)}`} @error=${(e) => e.currentTarget.classList.add('broken')}>`}
  </span>`
}

// Who acted on a history row: their avatar (`id`), over the letter of what
// they show as (`shown`); a legacy login, no user's, by its letter alone.
function actorAvatar(id, shown) {
  return html`<span class="avatar" aria-hidden="true"><span>${(shown?.[0] ?? '?').toUpperCase()}</span>${!id || getPreviewRole() ? nothing : keyed(id, html`
    <img alt="" loading="lazy" decoding="async" src=${`/api/avatar/${encodeURIComponent(id)}`} @error=${event => { event.currentTarget.hidden = true }}>`)}</span>`
}

// The kinds of history, each shown by its chip in the rows and the filter;
// capitalized here, as an option's plain text is not styled.
const HISTORY_KINDS = ['triage', 'visibility', 'upload', 'repository', 'access', 'delete']
const kindChip = kind => {
  const text = kind ?? 'activity'
  return html`<span class=${`kind ${kind ?? ''}`}>${text[0].toUpperCase()}${text.slice(1)}</span>`
}

const ADMIN_EDIT_ICON = appMarkup(EDIT_ICON_SVG)
const ADMIN_DELETE_ICON = appMarkup(DELETE_ICON_SVG)
const ADMIN_REMOVE_ICON = html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg>`
const ADMIN_PLUS_ICON = html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>`
const REPO_ICON = adminIcon('repo')
// Each role's label and description.
const ROLE_TEXT = {
  admin: ['Admin', 'Manage workspace access and teams'],
  manage: ['Manager', 'Manage content and triage within team access'],
  triage: ['Triage', 'Review and triage findings'],
  view: ['Viewer', 'Read-only access'],
  none: ['No access', 'No workspace access'],
}

// Manage › `label` › `title`, `label` going `back`.
function breadcrumb(label, backLabel, back, title) {
  return html`<div class="breadcrumb">
    <button type="button" class="breadcrumb-manage" @click=${() => openAdminPage('manage')}>Manage</button>
    <span class="breadcrumb-separator" aria-hidden="true">›</span>
    <button type="button" class="breadcrumb-manage" aria-label=${backLabel} @click=${back}>${label}</button>
    <span class="breadcrumb-separator" aria-hidden="true">›</span>
    ${title ? html`<h1 class="breadcrumb-current">${title}</h1>` : nothing}
  </div>`
}

const HOME_CONTENT = [
  ['manage-bundles', 'Bundles', 'Keep source archives ready for review.', 'bundle'],
  ['manage-scans', 'Scans', 'Run and monitor scans from stored bundles.', 'scan'],
  ['manage-reports', 'Reports', 'Review, publish, and organize findings.', 'report'],
]
const HOME_WORKSPACE = [
  ['manage-repos', 'Repositories', 'Connect sources and manage repository settings.', 'repo'],
  ['admin-users', 'Users', 'Manage accounts, roles, and workspace access.', 'users'],
  ['manage-teams', 'Teams', 'Bring people and repositories together.', 'team'],
]

function homePage([view, title, description, icon]) {
  return html`<button type="button" class=${`page page-${icon}`} @click=${() => openAdminPage(view)}>
    <span class="page-top"><span class="page-icon" aria-hidden="true">${adminIcon(icon)}</span><strong class="page-title">${title}</strong><span class="arrow" aria-hidden="true">${adminIcon('arrow')}</span></span>
    <span class="page-copy"><span>${description}</span></span>
  </button>`
}

class ManagedAdminHome extends ManagedPage {
  static view = 'manage'
  static styles = [unsafeCSS(homeStyles), unsafeCSS(commonStyles)]

  render() {
    return html`<div class="wrap">${this._nav()}
      <h1 class="sr-only">Manage</h1>
      ${this._role == null ? html`<p class="msg" role="status">Loading management pages…</p>` : html`
        <section class="home-section" aria-labelledby="content-heading">
          <div class="section-heading"><h2 id="content-heading">Content & activity</h2><span>From source to findings</span></div>
          <div class="pages">${HOME_CONTENT.filter(([view]) => view !== 'manage-scans' || ['admin', 'manage'].includes(this._role)).map(homePage)}</div>
        </section>
        ${this._role === 'admin' ? html`<section class="home-section" aria-labelledby="workspace-heading">
          <div class="section-heading"><h2 id="workspace-heading">Workspace & access</h2><span>Sources, people, and permissions</span></div>
          <div class="pages workspace-pages">${HOME_WORKSPACE.map(homePage)}</div>
        </section>` : nothing}
        <button type="button" class="history-link" @click=${() => openAdminPage('manage-history')}>
          <span class="page-icon" aria-hidden="true">${adminIcon('history')}</span>
          <span class="page-copy"><strong>Workspace history</strong><span>Follow activity and triage changes across your workspace.</span></span>
          <span class="history-cta">View history ${adminIcon('arrow')}</span>
        </button>`}
    </div>`
  }
}
customElements.define('managed-admin-home', ManagedAdminHome)

class ManagedAdminHistory extends ManagedPage {
  static view = 'manage-history'
  static properties = { _page: { state: true }, _history: { state: true }, _total: { state: true }, _filter: { state: true }, _query: { state: true }, _repo: { state: true }, _actor: { state: true }, _options: { state: true } }
  static styles = [unsafeCSS(historyStyles), unsafeCSS(commonStyles)]

  constructor() {
    super()
    Object.assign(this, { _history: null, _total: 0, _page: 1, _filter: 'all', _query: '', _repo: '', _actor: '', _options: { repos: [], users: [] } })
    this._searchTimer = null
    this._onActorFilter = (event) => {
      const actor = event.detail?.actor
      if (typeof actor !== 'string') return
      const exact = actor.startsWith('user:') || actor.startsWith('legacy:')
      this._query = exact ? '' : actor // Keep existing login-based links working.
      this._filter = 'all'
      this._repo = ''
      this._actor = exact ? actor : ''
      void this._load()
    }
  }

  connectedCallback() {
    super.connectedCallback()
    document.addEventListener('managed-history-filter', this._onActorFilter)
  }

  disconnectedCallback() {
    clearTimeout(this._searchTimer)
    document.removeEventListener('managed-history-filter', this._onActorFilter)
    super.disconnectedCallback()
  }

  async _load(page = 1) {
    clearTimeout(this._searchTimer)
    this._error = null
    const kind = this._filter
    const query = this._query.trim()
    const actor = this._actor, repo = this._repo
    const key = `history:${JSON.stringify([page, kind, query, repo, actor])}`
    await this._loadCollection(key, 'history', signal => fetchHistory(signal, page, kind, query, repo, actor), (result) => {
      this._history = result.history
      this._total = result.total
      this._page = result.page
      this._options = result.filters ?? { repos: [], users: [] }
    })
  }

  _search(query) {
    this._query = query
    clearTimeout(this._searchTimer)
    this._loadRequest?.abort()
    this._loadRequest = null
    this._loading = true
    this._searchTimer = setTimeout(() => { void this._load() }, 250)
  }

  _setRepo(repo) { this._repo = repo; return this._load() }
  _setActor(actor) { this._actor = actor; return this._load() }
  _clearContext() { this._repo = ''; this._actor = ''; return this._load() }

  _contextFilters() {
    const repos = this._options.repos
    const users = this._options.users ?? []
    const repositoryOptions = [
      { value: '', label: 'All repositories', special: true, reset: true },
      ...this._repo && !repos.includes(this._repo) ? [{ value: this._repo, label: this._repo }] : [],
      ...repos.map(repo => ({ value: repo, label: repo })),
    ]
    return html`
      <repository-selector label="Filter history by repository" .options=${repositoryOptions} .value=${this._repo}
        @repository-change=${event => void this._setRepo(event.detail.value)}></repository-selector>
      <user-selector label="Filter history by user" reset-label="All users" placeholder=${this._actor ? 'Selected user' : 'All users'}
        .users=${users} .value=${this._actor} @user-change=${event => void this._setActor(event.detail.value)}></user-selector>
      <button type="button" class="btn" aria-label="Clear repository and user filters" ?disabled=${!this._repo && !this._actor} @click=${() => void this._clearContext()}>Clear selection</button>
    `
  }

  render() {
    const history = this._history ?? []
    const page = this._page
    const start = (page - 1) * 100
    return html`<div class="wrap">${this._nav()}
      <h1 class="sr-only">History</h1>
      <div class="page-intro"><p class="intro">${this._role === 'admin' ? 'Uploads, builds, access changes, repository changes, deletions, and triage.' : 'Bundle, report, and triage history within your team access.'}</p><span class="result-count">${this._history ? this._total : '…'} entries</span></div>
      <div class="toolbar" role="search">
        <input type="search" maxlength="500" aria-label="Search history" placeholder="Search history…" .value=${this._query} @input=${(event) => this._search(event.target.value)}>
        ${this._kindFilter()}
        ${this._contextFilters()}
        <button type="button" class="btn" ?disabled=${this._loading} @click=${() => this._load(page)}>Refresh</button>
      </div>
      ${this._error ? html`<p class="msg error" role="alert">Couldn’t load history: ${this._error} <button type="button" class="btn" @click=${() => this._load()}>Retry</button></p>` : nothing}
      ${this._list(this._history, 'Loading history…', () => history.length === 0 ? html`<div class="history"><p class="empty">${this._query.trim() || this._filter !== 'all' || this._repo || this._actor ? 'No activity matches your filters.' : 'No history available yet.'}</p></div>` : html`<div class="history" aria-label="Workspace history"><div class="history-head" aria-hidden="true"><span>Type</span><span>Activity</span><span>Repository / report / finding</span><span>Time</span></div>${history.map((entry) => this._row(entry))}</div>`)}
      ${this._total > 100 ? html`<nav class="pagination" aria-label="History pages"><span role="status">${start + 1}–${Math.min(start + 100, this._total)} of ${this._total} entries</span><button type="button" class="btn" ?disabled=${this._loading || page === 1} @click=${() => this._changePage(page - 1)}>Previous</button><span>Page ${page} of ${Math.ceil(this._total / 100)}</span><button type="button" class="btn" ?disabled=${this._loading || start + 100 >= this._total} @click=${() => this._changePage(page + 1)}>Next</button></nav>` : nothing}
    </div>`
  }

  // A select whose options show the kinds' chips, as the rows do (a
  // customizable select; a browser without one reads their names). Each
  // option is its own template, as an older parser would drop a chip's
  // element, and with it its binding, from a select's.
  _kindFilter() {
    const kinds = HISTORY_KINDS.filter(kind => kind !== 'access' || this._role === 'admin')
    return html`<select class="kind-filter" aria-label="Filter history by type" .value=${this._filter}
      @change=${(event) => { this._filter = event.target.value; void this._load() }}>
      <button type="button"><selectedcontent></selectedcontent><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>
      <option value="all" ?selected=${this._filter === 'all'}>All activity</option>
      ${kinds.map(kind => html`<option value=${kind} ?selected=${this._filter === kind}>${kindChip(kind)}</option>`)}
    </select>`
  }

  async _changePage(page) {
    await this._load(page)
    await this.updateComplete
    this.renderRoot.querySelector('.manage-list')?.scrollTo({ top: 0 })
  }

  // Who acted shows by the name they chose, their login in its tooltip, and
  // by their login where they have none, as a comment's author does.
  _row(entry) {
    const detail = [entry.repo ?? entry.repository, entry.report, entry.finding].filter(Boolean).join(' · ')
    const login = entry.actor ?? entry.user ?? null
    const actor = entry.actorName?.trim() || login || 'Unknown user'
    const action = entry.action ?? 'updated workspace data'
    return html`<div class="row">${kindChip(entry.kind)}<span class="activity">${actorAvatar(entry.actorId, actor)}<span class="activity-description" data-tooltip-truncated data-tooltip=${`${actor} ${action}`}><strong class="actor" data-tooltip=${login && login !== actor ? `@${login} on GitHub` : nothing}>${actor}</strong> <span class="action">${action}</span></span></span><span class="detail" data-tooltip-truncated data-tooltip=${detail}>${detail || '—'}</span><span class="history-time">${userTime(entry.at)}</span></div>`
  }
}
customElements.define('managed-admin-history', ManagedAdminHistory)

const userDate = value => {
  if (value == null || value === '') return null
  const date = new Date(Number(value))
  return Number.isNaN(date.getTime()) ? null : date
}

function userTime(value) {
  const date = userDate(value)
  if (!date) return html`<span>Unknown</span>`
  return html`<time datetime=${date.toISOString()}>${date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</time><span>${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>`
}

const userActivityAt = user => user?.lastActivityAt ?? user?.lastActivity ?? user?.lastWriteAt ?? user?.lastActiveAt

class ManagedAdminUsers extends ManagedPage {
  static view = 'admin-users'
  static properties = { _query: { state: true }, _users: { state: true }, _teams: { state: true } }
  static styles = [unsafeCSS(usersStyles), unsafeCSS(commonStyles)]
  static collection = ['users', 'users', signal => Promise.all([fetchUsers(signal), fetchTeams(signal)])]

  constructor() {
    super()
    Object.assign(this, { _users: null, _query: '', _teams: null })
  }

  _show([users, teamData]) {
    this._users = users
    this._teams = Array.isArray(teamData?.teams) ? teamData.teams : []
  }

  // The teams a user is a member of, each with their membership.
  _memberships(user) {
    return (this._teams ?? []).flatMap(team => {
      const member = team.members?.find(candidate => candidate.userId === user.id)
      return member == null ? [] : [{ team, member }]
    })
  }

  _filteredUsers() {
    const query = this._query.trim().toLocaleLowerCase()
    return (this._users ?? []).filter(user => [user.name, user.login, user.role, ...this._memberships(user).map(({ team }) => team.name)].filter(Boolean).join(' ').toLocaleLowerCase().includes(query))
  }

  render() {
    const users = this._filteredUsers()
    return html`<div class="wrap">${this._nav()}
      <h1 class="sr-only">Users</h1>
      <div class="page-intro"><p class="intro">Manage workspace access and roles.</p></div>
      <div class="collection-toolbar" role="search"><input type="search" aria-label="Search users" placeholder="Search by name, username, or team…" .value=${this._query} @input=${e => { this._query = e.target.value }}><span class="result-count" role="status">${this._users && this._query.trim() ? `${users.length} matching out of ` : ''}${this._users?.length ?? '…'} users</span></div>
      ${errorMessage(this._error && `Couldn't load users: ${this._error}`)}
      ${this._list(this._users, 'Loading users…', () => this._directory(users))}
    </div>`
  }

  _directory(users) {
    if (this._users.length === 0) return html`<p class="msg">No users yet.</p>`
    if (users.length === 0) return emptyState('No matching users', 'Try another name, username, or team.')
    return html`<div class="directory">
      <div class="list-head" aria-hidden="true"><span>Account</span><span>Team access</span><span>Last seen</span><span>Last activity</span><span>Role</span><span></span></div>
      <ul class="users">${users.map((u) => this._row(u))}</ul>
    </div>${this._users.some((u) => u.id === this._me) ? html`<p class="self-note ui-hint">Your own role can only be changed by another admin.</p>` : nothing}`
  }

  _row(u) {
    const isSelf = u.id === this._me
    const memberships = this._memberships(u)
    const active = userDate(userActivityAt(u)), seen = userDate(u.lastSeenAt)
    return html`<li>
      <span class="person">
        ${adminAvatar(u.id, u.login)}
        <span class="who">
          <span class="name"><span class="name-text">${u.name || u.login}</span>${isSelf ? html`<span class="you">You</span>` : nothing}</span>
          <span class="login">@${u.login}</span>
        </span>
      </span>
      <span class="memberships">
        ${roleAtLeast(u.role, 'manage') ? html`<span class="team-access"><strong class="team-access-role">${u.role === 'admin' ? 'All reports' : 'Owned and team reports'}</strong><span class="team-perms"><span class="permission-granted">+ Deps</span><span class="permission-granted">+ Security</span></span></span>` : memberships.length === 0 ? html`<span class="no-team">No team access</span>` : memberships.map(({ team, member }) => {
          return html`<span class="team-access"><strong>${adminIcon('team')}<span>${team.name}</span></strong><span class="team-perms">${['dependencies', 'security'].map((permission) => html`<span class=${member[permission] === true ? 'permission-granted' : 'permission-denied'}>${member[permission] === true ? '+' : '−'} ${permission === 'dependencies' ? 'Deps' : 'Security'}</span>`)}</span></span>`
        })}
      </span>
      <span class="last-seen" aria-label=${seen ? `Last seen ${seen.toLocaleString()}` : 'Unknown'}>${userTime(u.lastSeenAt)}</span>
      <button type="button" class="activity-link" aria-label=${`Show activity by ${u.login}`} @click=${() => openAdminPage('manage-history', { actor: `user:${u.id}` })}><span class="last-activity" aria-label=${`Last activity ${active ? active.toLocaleString() : 'Unknown'}`}>${userTime(userActivityAt(u))}</span></button>
      <span class="access">
      <select class="role" ?disabled=${isSelf}
        aria-label=${`Change ${u.login}’s role`}
        aria-description=${ROLE_TEXT[u.role]?.[1] ?? ''}
        @change=${(e) => this._changeRole(u, e.target.value, e.target)}>
        ${ROLES.map((r) => html`<option value=${r} ?selected=${r === u.role}>${ROLE_TEXT[r][0]}</option>`)}
      </select>
      </span>
      <span class="view-as">${isSelf ? nothing : html`<button type="button" class="icon-btn"
        aria-label=${`View as ${u.login}`} data-tooltip="See the app as this user"
        @click=${(e) => void this._viewAs(u, e.currentTarget)}>${adminIcon('show')}</button>`}</span>
    </li>`
  }

  // The page reloads into the view; a failure leaves this page as it was.
  async _viewAs(u, button) {
    button.disabled = true
    try { await viewAs(u.id, this._csrf) } catch (err) {
      button.disabled = false
      this.appState.notify(`Couldn't view as @${u.login}: ${err?.message ?? err}`)
    }
  }

  async _changeRole(u, role, selectEl) {
    const prev = u.role
    if (role === prev) return
    try {
      await this.appState.mutate(() => setRole(u.id, role, this._csrf), ['users', 'teams', 'reports', 'history'])
      u.role = role
      await this._load()
    } catch (err) {
      console.warn('admin: set role failed:', err)
      selectEl.value = prev
    }
    this.requestUpdate()
  }
}
customElements.define('managed-admin-users', ManagedAdminUsers)

// The lockfiles a repository's dependency review holds to as its settings
// edit them: every one (`all`), all but those named, or those alone; and as
// they are saved, every one as naming none to leave out.
const draftScope = lockfiles => !lockfiles || (lockfiles.mode === 'exclude' && lockfiles.paths.length === 0) ? { mode: 'all', paths: [] }
  : { mode: lockfiles.mode, paths: [...lockfiles.paths].toSorted() }
const scopeSent = scope => scope.mode === 'all' ? { mode: 'exclude', paths: [] } : { mode: scope.mode, paths: scope.paths }

const ACCESS_ICONS = {
  private: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>`,
  public: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M2.5 8h11M8 2c1.5 1.7 2.2 3.7 2.2 6S9.5 12.3 8 14c-1.5-1.7-2.2-3.7-2.2-6S6.5 3.7 8 2Z"/></svg>`,
}

// Only the connected set loads on entry. Private/public discovery is opt-in,
// and each connected repository has its own page for configuration.
class ManagedAdminRepos extends ManagedPage {
  static view = 'manage-repos'
  static properties = {
    _publicRepoOpen: { state: true }, _publicRepository: { state: true }, _publicRepoError: { state: true }, _addingPublic: { state: true },
    _actionError: { state: true }, _scope: { state: true }, _showAll: { state: true }, _query: { state: true }, _organization: { state: true },
    _busy: { state: true }, _connectingApp: { state: true }, _detail: { state: true }, _aliases: { state: true },
    _impact: { state: true }, _impactLoading: { state: true }, _removeOpen: { state: true }, _acknowledge: { state: true },
    _deleteTriage: { state: true }, _confirmName: { state: true }, _reviewDraft: { state: true },
  }
  static styles = [unsafeCSS(reposStyles), unsafeCSS(commonStyles)]

  constructor() {
    super()
    Object.assign(this, { _publicRepoOpen: false, _publicRepository: '', _publicRepoError: null, _addingPublic: false, _actionError: null,
      _scope: 'connected', _showAll: false, _query: '', _organization: null, _loading: true, _busy: null, _connectingApp: false,
      _detail: null, _aliases: false, _impact: null, _impactLoading: false, _impactFresh: false, _impactRequest: null })
    this._resetRemoval()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._impactRequest?.abort()
  }

  _resetRemoval(open = false) {
    Object.assign(this, { _removeOpen: open, _acknowledge: false, _deleteTriage: false, _confirmName: '' })
  }

  async _load(refresh = false) {
    this._error = null
    const { _scope: scope, _showAll: showAll } = this
    await this._loadCollection(`repos:${JSON.stringify([scope, showAll])}`, 'repositories', signal => fetchRepositories(scope, showAll, refresh, signal), data => {
      this._data = data
      this._organization = this._repositoryChoices().activeFacet
    })
  }

  _open(scope) {
    this._impactRequest?.abort()
    Object.assign(this, { _publicRepoOpen: false, _scope: scope, _showAll: false, _query: '', _organization: null, _detail: null, _aliases: false,
      _impact: null, _data: null, _actionError: null })
    this._resetRemoval()
    void this._load()
  }

  _setShowAll(value) {
    Object.assign(this, { _showAll: value, _organization: null, _data: null })
    void this._load()
  }

  _search(value) { this._query = value }

  _repositoryChoices() {
    const options = (this._data?.repositories ?? []).map(repo => ({ value: repo.id, label: repo.fullName, repo }))
    return repositoryChoices(options, this._query, this._organization, { includeSingletonOrganizations: true })
  }

  _back(title = null) {
    return breadcrumb('Repositories', 'Back to repositories', () => {
      if (this._detail) { this._impactRequest?.abort(); this._detail = null; this._actionError = null }
      else if (this._aliases) this._aliases = false
      else this._open('connected')
    }, title)
  }

  _openDetail(repo) {
    const key = `repo-impact:${repo.id}`
    Object.assign(this, { _detail: repo, _reviewDraft: null, _actionError: null, _impact: this.appState.read(key) ?? null, _impactFresh: false, _impactLoading: true })
    this._resetRemoval()
    this._impactRequest?.abort()
    const request = new AbortController()
    this._impactRequest = request
    void this.appState.load(key, 'repository data', signal => fetchRepositoryImpact(repo.id, signal), {
      signal: request.signal, apply: impact => { this._impact = impact },
    }).then(impact => { if (!request.signal.aborted) this._impactFresh = true; return impact }).catch((err) => {
      if (!request.signal.aborted && err?.name !== 'AbortError' && !this._impact) this._actionError = `Couldn't load repository data: ${err?.message ?? err}`
    }).finally(() => {
      if (this._impactRequest === request) this._impactLoading = false
    })
  }

  render() {
    if (this._detail) return this._detailPage(this._detail)
    if (this._aliases) return this._aliasesPage()
    const connected = this._scope === 'connected'
    const title = connected ? 'Repositories' : `Add ${this._scope} repository`
    const choices = this._repositoryChoices()
    return html`<div class="wrap">${this._nav()}
      ${connected ? html`<h1 class="sr-only">${title}</h1>` : this._back(title)}
      <div class="page-intro"><p class="intro">${connected
        ? 'Manage connected repositories and their settings.'
        : this._scope === 'installed'
          ? this._showAll ? 'Showing all repositories the GitHub App can read.' : 'Showing installed repositories you can access on GitHub.'
          : 'Choose a public repository your GitHub account is involved with.'}</p>${connected ? html`<div class="repository-actions">
          <button type="button" class="btn" @click=${() => this._open('installed')}>${ACCESS_ICONS.private} Add installed repository</button>
          <button type="button" class="btn" @click=${() => this._open('public')}>${ACCESS_ICONS.public} Add your public repository</button>
          ${this._role === 'admin' && this._data?.canAddAnyPublicRepository ? html`<button type="button" class="btn" aria-expanded=${this._publicRepoOpen} @click=${() => this._openPublicRepository()}>${ACCESS_ICONS.public} Add a public repository</button>` : nothing}
        </div>` : nothing}</div>
      ${!connected && this._scope === 'installed' ? html`<div class="access-note">
        <p class="ui-hint">Installed repositories are readable through the GitHub App. Install it on a repository or organization to make it available here.</p>
        <span class="access-action">${this._data?.installUrl ? html`<a class="btn" href=${this._data.installUrl} target="_blank" rel="noopener noreferrer">Configure GitHub access</a>` : html`<button type="button" class="btn" disabled>Configure GitHub access</button>`}</span>
      </div>` : nothing}
      <div class="toolbar">
        <label class="search"><input type="search" aria-label=${connected ? 'Search connected repositories' : `Search ${this._scope} repositories`} placeholder="Search by repository or owner…" .value=${this._query} @input=${(e) => this._search(e.target.value)}></label>
        ${this._scope === 'installed' ? html`<label class="show-all"><input type="checkbox" role="switch" .checked=${this._showAll} @change=${(event) => this._setShowAll(event.target.checked)}><span>Show all</span></label><label class="show-all-paper"><input type="checkbox" .checked=${this._showAll} @change=${(event) => this._setShowAll(event.target.checked)}><span>Show all</span></label>` : nothing}
        ${connected ? html`<span class="result-count" role="status">${this._data && (this._query.trim() || choices.activeFacet != null) ? `${choices.count} ${choices.count === 1 ? 'repository' : 'repositories'} out of ` : ''}${this._data?.connectedCount ?? '…'} connected</span>`
          : html`<button type="button" class="btn" ?disabled=${this._loading} @click=${() => { void this._load(true) }}>Refresh</button>`}
      </div>
      ${connected && this._publicRepoOpen && this._role === 'admin' && this._data?.canAddAnyPublicRepository ? this._publicRepositoryForm() : nothing}
      ${errorMessage(this._actionError)}
      ${this._error ? html`<p class="msg error" role="alert">Couldn't load repositories: ${this._error}</p><button type="button" class="btn" @click=${() => { void this._load() }}>Try again</button>` : nothing}
      ${!connected && this._data ? html`<p class="repository-count" role="status">${choices.count}${choices.count === choices.total ? '' : ` of ${choices.total}`} ${choices.total === 1 ? 'repository' : 'repositories'}</p>` : nothing}
      <div class="manage-list"><div aria-busy=${this._loading}>${this._body(choices)}</div>
        ${connected && this._role === 'admin' ? html`<div class="repository-pages">
          <button type="button" class="btn" @click=${() => { this._publicRepoOpen = false; this._actionError = null; this._aliases = true }}>Aliases</button>
          <button type="button" class="btn" @click=${() => openAdminPage('manage-repo-risk')}>Risk</button>
        </div>` : nothing}
      </div>
    </div>`
  }

  // Aliases open in place of the repository list; the breadcrumb returns to it.
  _aliasesPage() {
    return html`<div class="wrap">${this._nav()}
      ${this._back('Aliases')}
      <div class="manage-list has-intro"><managed-repository-aliases .session=${this.session} .repositories=${this._data?.repositories}></managed-repository-aliases></div>
    </div>`
  }

  _body(choices) {
    if (!this._data) return this._error ? nothing : loadingRows('Loading repositories…')
    const scope = this._scope
    return html`
      ${this._data.tokenMissing && !this._showAll && scope !== 'connected' ? html`<p class="msg">Log out and back in to refresh your GitHub membership access.</p>` : nothing}
      <div class="repository-browser">
        ${choices.showFacets ? html`<nav class="organization-list" aria-label="Filter by organization">
          <button type="button" class="organization" aria-pressed=${choices.activeFacet == null} @click=${() => { this._organization = null }}><span class="organization-name">All organizations</span><span class="organization-count">${choices.total}</span></button>
          ${choices.facets.map(org => html`<button type="button" class="organization" aria-pressed=${choices.activeFacet === org.value} @click=${() => { this._organization = org.value }}><span class="organization-name" data-tooltip-truncated data-tooltip=${org.name}>${org.name}</span><span class="organization-count">${org.count}</span></button>`)}
        </nav>` : nothing}
        <div class="repo-results">
          ${choices.sections.map(section => html`<section class="repo-group" aria-label=${section.label ?? 'Repositories'}>
            ${section.label ? html`<h2 class="owner-head"><span class="owner-icon" aria-hidden="true">${section.label[0] ?? '?'}</span>${section.label}</h2>` : nothing}
            <ul class="repos">${section.options.map(option => this._row(option.repo, section.organization ? option.name : option.label))}</ul>
          </section>`)}
          ${choices.count ? nothing : emptyState(choices.total ? 'No matching repositories' : scope === 'connected' ? 'No connected repositories yet' : `No ${scope} repositories available`,
            choices.total ? 'Try a different search or organization.' : scope === 'connected' ? 'Add an installed or public repository to get started.' : scope === 'installed' ? this._showAll ? 'Install the GitHub App, then refresh this list.' : 'No installed repositories match your GitHub access. Turn on Show all to browse every installation.' : 'Public repositories associated with your GitHub account will appear here.')}
        </div>
      </div>
    `
  }

  _openPublicRepository() {
    this._publicRepoOpen = true
    this._publicRepoError = null
    void this.updateComplete.then(() => this.renderRoot?.querySelector('#public-repository')?.focus())
  }

  _publicRepositoryForm() {
    return html`<form class="public-repository-form" aria-label="Add a public repository" @submit=${event => { event.preventDefault(); void this._addPublicRepository() }}>
      <label class="confirm-field" for="public-repository"><span>Public GitHub repository</span>
        <input id="public-repository" class="confirm-name" type="text" placeholder="owner/repo or https://github.com/owner/repo" autocomplete="off" required .value=${this._publicRepository} ?disabled=${this._addingPublic} @input=${event => { this._publicRepository = event.target.value }}>
      </label>
      <div class="dialog-actions"><button type="button" class="btn" ?disabled=${this._addingPublic} @click=${() => { this._publicRepoOpen = false }}>Cancel</button><button type="submit" class="btn" ?disabled=${this._addingPublic || !this._publicRepository.trim()}>${this._addingPublic ? 'Adding…' : 'Add repository'}</button></div>
      ${errorMessage(this._publicRepoError)}
    </form>`
  }

  async _addPublicRepository() {
    if (this._addingPublic || !this._publicRepository.trim()) return
    this._addingPublic = true
    this._publicRepoError = null
    try {
      await this.appState.mutate(() => addPublicRepository(this._publicRepository.trim(), this._csrf), ['repos', 'reports', 'bundles', 'teams', 'users', 'history', 'scan-sources'])
      this._publicRepoOpen = false
      this._publicRepository = ''
      await this._load()
    } catch (err) {
      this._publicRepoError = err?.message ?? String(err)
    } finally {
      this._addingPublic = false
    }
  }

  _row(repo, label) {
    const access = `${this._accessLabel(repo)}${this._scope === 'connected' && repo.active === false ? ' · Deactivated' : ''}`
    const copy = html`${REPO_ICON}<span class="repo-copy"><span class="repo-name">${label}</span><span class="repo-meta">${access}</span></span>`
    if (this._scope === 'connected') {
      // Its code opens from beside the row's arrow, in the same place on every
      // row, but a deactivated one's, which no one reads.
      return html`<li class="repo-item"><button type="button" class="repo-row" aria-label=${`Manage ${repo.fullName}`} @click=${() => this._openDetail(repo)}>
        ${copy}<span class="repo-code-slot" aria-hidden="true"></span><svg class="arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>
      </button>${repo.active === false ? nothing : html`<a class="repo-code" href=${managedRoutePath({ view: 'repository-code', repoId: repo.id })}
        aria-label=${`Open ${repo.fullName}'s code`} @click=${event => this._openCode(event, repo)}>${adminIcon('code')}</a>`}</li>`
    }
    return html`<li class="repo-row">${copy}
      ${repo.selected ? html`<span class="connected"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>Connected</span>`
        : repo.private && !repo.installed
          ? html`<span class="repo-meta">Needs App access</span>`
          : html`<button type="button" class="btn" aria-label=${`Add ${repo.fullName}`} ?disabled=${this._busy != null} @click=${() => { void this._setActive(repo, true) }}>${this._busy === repo.id ? 'Adding…' : 'Add'}</button>`}
    </li>`
  }

  // In the code viewer, at its default branch; a new tab's or window's opens
  // there from its link.
  _openCode(event, repo) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    this._emit('managed-repository-code-open', { repoId: repo.id })
  }

  _accessLabel(repo) {
    const visibility = repo.visibility === 'public' ? 'Public' : repo.visibility === 'internal' ? 'Internal' : repo.private ? 'Private' : null
    const source = repo.installed ? 'GitHub App' : 'GitHub'
    return visibility ? `${visibility} · ${source}` : source
  }

  // One repository's change at a time (`_busy`), its failure shown as `Couldn't ${failure}: …`.
  async _act(repo, failure, work) {
    this._busy = repo.id
    this._actionError = null
    try { await work() } catch (err) {
      this._actionError = `Couldn't ${failure}: ${err?.message ?? err}`
    } finally {
      this._busy = null
    }
  }

  // A repository changed in both its page and the list.
  _patchRepo(id, fields) {
    if (this._detail?.id === id) this._detail = { ...this._detail, ...fields }
    if (this._data) this._data = { ...this._data, repositories: this._data.repositories.map(entry => entry.id === id ? { ...entry, ...fields } : entry) }
  }

  async _connectApp(repo) {
    if (this._busy != null || repo.installed) return
    this._connectingApp = true
    await this._act(repo, `connect ${repo.fullName}`, async () => {
      const result = await this.appState.mutate(() => connectRepositoryApp(repo.id, this._csrf), ['repos', 'history', 'scan-sources'])
      if (!this.isConnected) return
      if (!result.connected) { globalThis.location.assign(result.installUrl); return }
      this._patchRepo(repo.id, { installed: true })
      await this._load()
    })
    this._connectingApp = false
  }

  _detailPage(repo) {
    const active = repo.active !== false
    const reports = this._impact?.reports ?? []
    const bundles = this._impact?.bundles ?? []
    return html`<div class="wrap">${this._nav()}
      <div class="head">${this._back()}<h1>${repo.fullName}</h1></div>
      <p class="intro ui-hint">Repository settings and stored data.</p>
      ${errorMessage(this._actionError)}
      <div class="manage-list repository-detail">
        <section class="section" aria-label="Repository connection">
          <h2>Connection</h2>
          <div class="settings-row"><div class="settings-copy"><strong>${this._accessLabel(repo)}</strong><p>${active ? 'Active for new scans and uploads.' : 'Deactivated. Stored reports and bundles are retained.'}</p></div>
            <span class=${`status-line ${active ? '' : 'inactive'}`}>${active ? 'Active' : 'Deactivated'}</span>
            ${repo.installed ? nothing : html`<button type="button" class="btn connect-app" aria-label=${`Connect GitHub App to ${repo.fullName}`} ?disabled=${this._busy != null} @click=${() => { void this._connectApp(repo) }}>${this._connectingApp && this._busy === repo.id ? 'Connecting…' : 'Connect GitHub App'}</button>`}
            ${repo.htmlUrl ? html`<a class="btn" href=${repo.htmlUrl} target="_blank" rel="noopener noreferrer">View on GitHub</a>` : nothing}
          </div>
          <div class="settings-row"><div class="settings-copy"><strong>${active ? 'Deactivate repository' : 'Reactivate repository'}</strong><p>${active ? 'Pause new scans while preserving all stored data and attachments.' : 'Make this repository available for new scans and bundle attachments again.'}</p></div>
            <button type="button" class="btn" ?disabled=${this._busy != null} @click=${() => { void this._setActive(repo, !active) }}>${this._busy === repo.id && !this._connectingApp ? (active ? 'Deactivating…' : 'Reactivating…') : (active ? 'Deactivate' : 'Reactivate')}</button>
          </div>
        </section>
        ${this._dependencyReviewSection(repo)}
        <section class="data-section" aria-label="Stored repository data">
          <h2>Stored data</h2>
          <div class="dialog-data" aria-busy=${this._impactLoading}>
            ${[['Reports', reports], ['Bundles', bundles]].map(([label, items]) => html`<section>
              <h3>${label} (${this._impact == null ? '…' : items.length})</h3>
              ${this._impactLoading && this._impact == null ? html`<p class="data-empty" role="status">Loading ${label.toLowerCase()}…</p>` : this._impact == null
                ? html`<p class="data-empty">Attached data could not be loaded.</p><button type="button" class="btn" @click=${() => this._openDetail(repo)}>Try again</button>`
                : items.length > 0 ? html`<ul>${items.map(item => html`<li>${item.filename}${item.repoDirectory ? ` · ${item.repoDirectory}` : nothing}</li>`)}</ul>` : html`<p class="data-empty">No ${label.toLowerCase()} attached.</p>`}
            </section>`)}
          </div>
        </section>
        <section class="section" aria-label="Permanent repository removal">
          <h2>Permanent removal</h2>
          <div class="settings-row"><div class="settings-copy"><strong>Delete repository and stored data</strong><p>Deactivation is reversible. Permanent removal deletes this repository’s attached reports and bundles; it cannot be undone.</p></div>
            <button type="button" class="btn danger" ?disabled=${this._busy != null || this._impactLoading || !this._impactFresh || this._impact == null} @click=${() => this._resetRemoval(true)}>Remove permanently</button>
          </div>
        </section>
      </div>
      ${this._removeOpen && this._impact != null && !this._impactLoading ? this._removeDialog(repo, reports, bundles) : nothing}
    </div>`
  }

  // Its dependency review: on or off at once, by its header's switch; the
  // reviews each version needs, the commit whose lockfiles' versions need
  // none and the lockfiles it holds to, saved together (_reviewSetting). On,
  // where no team that reviews dependencies has it, which its pull requests
  // then show no review for, it says so.
  _dependencyReviewSection(repo) {
    const registered = this._data?.reviewedDependencies === true
    const saved = repo.dependencyReview ?? { enabled: false, required: 1, since: null }
    const savedScope = draftScope(saved.lockfiles)
    const draft = { required: String(saved.required), since: saved.since ?? '', scope: savedScope, adding: '', ...this._reviewDraft }
    const changed = draft.required !== String(saved.required) || (!registered && draft.since.trim() !== (saved.since ?? ''))
      || JSON.stringify(draft.scope) !== JSON.stringify(savedScope)
    const busy = this._busy != null
    return html`<section class="section" aria-label="Dependency review">
      <div class="section-head"><h2>Dependency review</h2>
        <mode-switch label=${saved.enabled ? 'On' : 'Off'} accessible-label="Review dependencies" .checked=${saved.enabled} .disabled=${busy}
          @click=${() => { if (!busy) void this._saveDependencyReview(repo, this._reviewSetting(!saved.enabled, saved.required, saved.since)) }}></mode-switch>
      </div>
      ${saved.enabled ? html`<form class="settings-row dependency-review-settings" aria-label="Dependency review settings"
        @submit=${event => { event.preventDefault(); void this._saveDependencyReview(repo, this._reviewSetting(true, Number(draft.required), draft.since.trim().toLowerCase() || null, scopeSent(draft.scope))) }}>
        <label><span>Reviews each version needs</span><input type="number" min="1" max="10" required .value=${draft.required} ?disabled=${busy}
          @input=${event => { this._reviewDraft = { ...draft, required: event.target.value } }}></label>
        ${registered ? nothing : html`<label class="dependency-review-since"><span>Reviewed since commit (optional)</span><input type="text" placeholder="Full commit id"
          autocomplete="off" spellcheck="false" pattern="[0-9a-fA-F]{40}" .value=${draft.since} ?disabled=${busy}
          @input=${event => { this._reviewDraft = { ...draft, since: event.target.value } }}></label>`}
        ${this._lockfileScope(repo, draft, busy)}
        <button type="submit" class="btn" ?disabled=${busy || !changed}>Save</button>
        ${Array.isArray(repo.reviewTeams) && repo.reviewTeams.length === 0 ? html`<p class="dependency-review-hint is-warning" role="status">No team that reviews
          dependencies has this repository, so its pull requests show no review. Add it to such a team, or turn dependency review on for a team that has it.</p>`
          : registered || draft.since.trim() ? html`<p class="dependency-review-hint">${registered
            ? 'Versions this server’s reviewed dependencies pass need no reviews here.'
            : 'Versions the repository’s lockfiles locked at this commit need no review.'}</p>` : nothing}
      </form>` : nothing}
    </section>`
  }

  // The lockfiles its review holds to (`draft.scope`): every one, all but
  // those selected, or those selected alone, of the default branch's, read for
  // it, those named before though no longer there, and another path, or a
  // directory ending in /, typed in. Among those selected alone, its
  // stasis.config.json files too, each holding it to what its entries reach.
  _lockfileScope(repo, draft, busy) {
    const { mode, paths } = draft.scope
    const read = mode === 'all' ? { status: 'ready', paths: [], configs: [] } : this._lockfilesFor(repo)
    const set = scope => { this._reviewDraft = { ...draft, scope } }
    const configs = mode === 'include' ? read.configs : []
    const listedThere = new Set([...read.paths, ...configs])
    const listed = [...new Set([...listedThere, ...paths])].toSorted()
    // Those named as `next` names them: a stasis.config.json among those reviewed alone only.
    const named = next => next === 'include' ? paths : paths.filter(path => !isStasisConfig(path))
    const add = () => {
      const path = draft.adding.trim().replace(/^\.?\/+/u, '')
      if (path) this._reviewDraft = { ...draft, adding: '', scope: { mode, paths: [...new Set([...paths, path])].toSorted() } }
    }
    return html`<fieldset class="dependency-review-lockfiles" ?disabled=${busy}><legend>Lockfiles reviewed</legend>
      <select aria-label="Lockfiles reviewed" .value=${mode} @change=${event => set({ mode: event.target.value, paths: named(event.target.value) })}>
        <option value="all">Every lockfile</option><option value="exclude">All but those selected</option><option value="include">Only those selected</option>
      </select>
      ${mode === 'all' ? nothing : html`
        ${read.status === 'loading' ? html`<p class="dependency-review-hint" role="status">Reading the default branch’s lockfiles…</p>`
          : read.status === 'error' ? html`<p class="dependency-review-hint is-warning" role="alert">Its lockfiles couldn’t be read (${read.error}); name them below.</p>` : nothing}
        ${listed.length > 0 ? html`<ul class="dependency-review-lockfile-list">${listed.map(path => html`<li><label>
          <input type="checkbox" .checked=${paths.includes(path)} @change=${event => set({ mode, paths: event.target.checked ? [...paths, path].toSorted() : paths.filter(one => one !== path) })}>
          <code>${path}</code>${read.status === 'ready' && !listedThere.has(path) ? html`<span>${path.endsWith('/') ? 'every lockfile under it' : 'not on the default branch'}</span>` : nothing}
        </label></li>`)}</ul>` : read.status === 'ready' ? html`<p class="dependency-review-hint">Its default branch has no lockfile its review reads.</p>` : nothing}
        ${paths.some(isStasisConfig) ? html`<p class="dependency-review-hint">A <code>stasis.config.json</code> holds the review to the versions its entries reach, in place of
          all a lockfile locks. Stasis builds them for each commit as it is first asked for, which can take minutes; until then they show as being worked out.</p>` : nothing}
        <label class="dependency-review-lockfile-add"><span>${mode === 'include' ? 'Another lockfile, a directory ending in /, or a stasis.config.json' : 'Another lockfile, or a directory ending in /'}</span>
          <input type="text" placeholder="examples/" autocomplete="off" spellcheck="false" .value=${draft.adding}
            @input=${event => { this._reviewDraft = { ...draft, adding: event.target.value } }}
            @keydown=${event => { if (event.key === 'Enter') { event.preventDefault(); add() } }}></label>
        <button type="button" class="btn" ?disabled=${!draft.adding.trim()} @click=${add}>Add</button>`}
    </fieldset>`
  }

  // The default branch's lockfiles its review reads, and its
  // stasis.config.json files, read once as its settings show, the page
  // updated as they arrive.
  _lockfilesFor(repo) {
    if (this._lockfileRead?.repoId !== repo.id) {
      const read = { repoId: repo.id, status: 'loading', paths: [], configs: [] }
      this._lockfileRead = read
      fetchRepositoryLockfiles(repo.id).then(({ paths, configs }) => Object.assign(read, { status: 'ready', paths, configs }),
        err => Object.assign(read, { status: 'error', error: err?.message ?? String(err) }))
        .finally(() => { if (this._lockfileRead === read) this.requestUpdate() })
    }
    return this._lockfileRead
  }

  // A review's setting as it is saved: without its commit where the server
  // registers reviewed dependencies, which replace it, the one stored kept;
  // with the lockfiles it holds to where they are given.
  _reviewSetting(enabled, required, since, lockfiles) {
    return { ...this._data?.reviewedDependencies === true ? { enabled, required } : { enabled, required, since }, ...lockfiles ? { lockfiles } : {} }
  }

  async _saveDependencyReview(repo, setting) {
    if (this._busy != null) return
    await this._act(repo, `save ${repo.fullName}'s dependency review`, async () => {
      const dependencyReview = await this.appState.mutate(() => setRepositoryDependencyReview(repo.id, setting, this._csrf), ['repos'])
      // Pull requests' dependencies read with their review before are read
      // again, whether or not the page was left meanwhile.
      globalThis.dispatchEvent?.(new Event('dependency-review-changed'))
      if (!this.isConnected) return
      this._patchRepo(repo.id, { dependencyReview })
      this._reviewDraft = null
    })
  }

  _removeDialog(repo, reports, bundles) {
    const hasAttached = reports.length > 0 || bundles.length > 0
    const ready = this._canRemove(repo)
    return html`<div class="dialog-backdrop" role="presentation" @click=${(event) => { if (event.target === event.currentTarget) this._removeOpen = false }}>
      <section class=${`dialog ${hasAttached ? '' : 'small'}`} role="dialog" aria-modal="true" aria-labelledby="remove-repo-title">
        <h2 id="remove-repo-title">Remove ${repo.fullName} permanently?</h2>
        <p class="dialog-copy">${hasAttached ? 'This destructive action will remove the repository and the stored data listed below. Deactivation keeps all of it.' : 'This repository has no attached reports or bundles. Permanent removal deletes its connection record.'}</p>
        ${hasAttached ? html`<div class="dialog-data">
          <section><h3>Reports to delete (${reports.length})</h3><ul>${reports.map((report) => html`<li>${displayName(report.filename)}${report.repoDirectory ? ` · ${report.repoDirectory}` : nothing}</li>`)}</ul></section>
          <section><h3>Bundles to delete (${bundles.length})</h3><ul>${bundles.map((bundle) => html`<li>${bundle.filename}</li>`)}</ul></section>
        </div>` : nothing}
        <label class="confirm-line"><input type="checkbox" .checked=${this._acknowledge} @change=${(event) => { this._acknowledge = event.target.checked }}><span>I understand this permanently deletes the repository connection${hasAttached ? ', reports, and bundles' : ''}.</span></label>
        ${(this._impact?.triageCount ?? 0) > 0 ? html`<label class="confirm-line"><input type="checkbox" .checked=${this._deleteTriage} @change=${(event) => { this._deleteTriage = event.target.checked }}><span>Also delete ${this._impact.triageCount} triage entr${this._impact.triageCount === 1 ? 'y' : 'ies'} belonging only to this repository.</span></label>` : nothing}
        ${hasAttached ? html`<label class="confirm-field"><span>Type <strong>${repo.fullName}</strong> to confirm.</span><input class="confirm-name" type="text" autocomplete="off" .value=${this._confirmName} @input=${(event) => { this._confirmName = event.target.value }}></label>` : nothing}
        <div class="dialog-actions"><button type="button" class="btn" @click=${() => { this._removeOpen = false }}>Cancel</button><button type="button" class="btn danger" ?disabled=${!ready} @click=${() => { void this._remove(repo) }}>${this._busy === repo.id ? 'Removing…' : 'Remove permanently'}</button></div>
      </section>
    </div>`
  }

  async _setActive(repo, active) {
    if (this._busy != null) return
    const verb = active ? (repo.active === false ? 'reactivate' : 'add') : 'deactivate'
    await this._act(repo, `${verb} ${repo.fullName}`, async () => {
      await this.appState.mutate(() => selectRepository(repo.id, active, this._csrf), ['repos', 'reports', 'bundles', 'teams', 'users', 'history'])
      if (!this.isConnected) return
      this._patchRepo(repo.id, { active })
      await this._load()
    })
  }

  _canRemove(repo) {
    if (this._busy != null || this._impactLoading || !this._impactFresh || this._impact?.repoId !== repo.id || !this._acknowledge) return false
    const hasAttached = this._impact.reports.length > 0 || this._impact.bundles.length > 0
    return !hasAttached || this._confirmName === repo.fullName
  }

  async _remove(repo) {
    if (!this._canRemove(repo)) return
    await this._act(repo, `remove ${repo.fullName}`, async () => {
      await this.appState.mutate(() => removeRepository(repo.id, repo.fullName, this._deleteTriage, this._csrf), ['repos', 'repo-impact', 'reports', 'report-preview', 'bundles', 'teams', 'users', 'history', 'scan-sources'])
      this._removeOpen = false
      this._detail = null
      this._impact = null
      await this._load()
    })
  }
}
customElements.define('managed-admin-repos', ManagedAdminRepos)

// Keep managed numeric repository IDs and null (unattached) intact.
function repoOptions(repos) {
  return [{ value: null, label: 'No repository', special: true }, ...repos.map(repo => ({ value: repo.repoId, label: repo.fullName }))]
}

// A location editor's suggested value, named by its source. Only a connected
// destination can be applied, and only Save changes the assignment.
function locationHint(source, value, field, apply, disabled) {
  const content = html`<span class="ui-hint">${source}: </span><span class="location-metadata-value" data-tooltip-truncated data-tooltip=${value}>${value}</span>`
  return apply
    ? html`<button type="button" class="location-metadata" aria-label=${`Use ${field} from ${source}: ${value}`} ?disabled=${disabled} @click=${apply}>${content}</button>`
    : html`<span class="location-metadata">${content}</span>`
}

const uploadedOn = item => Number.isFinite(item.uploadedAt) ? new Date(item.uploadedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''
const locationOf = item => item.repoFullName ? `${item.repoFullName}${item.repoDirectory ? `/${item.repoDirectory}` : ''}` : 'No repository assigned'

// Reports' and bundles' pages: files uploaded (by drop, picker or local
// import), searched and filtered by visibility, each assigned a repository
// location in an editor that suggests the one the file itself names. A
// subclass names its `kind` and API; `_suggestion` reads what its origin
// request answers.
class ManagedUploadsPage extends ManagedPage {
  static properties = {
    localImportSource: { attribute: false }, _query: { state: true }, _visibility: { state: true }, _busy: { state: true },
    _locationId: { state: true }, _locationOrigin: { state: true }, _locationOriginError: { state: true },
    _locationRepo: { state: true }, _locationDirectory: { state: true }, _locationBusy: { state: true },
  }

  constructor() {
    super()
    const { kind, upload, importFamilies, uploadFamilies } = this.constructor
    Object.assign(this, { _query: '', _visibility: 'all', _busy: false, _locationId: null, _locationOrigin: null, _locationOriginError: null,
      _locationRepo: null, _locationDirectory: '', _locationBusy: false })
    this._locationOriginRequest = null
    this._queue = [] // files awaiting upload; a drop during an in-flight upload joins it
    this._localImport = new ManagedLocalImport(this, kind, file => uploadLocalFile(this, file,
      selected => upload(selected, this._csrf), importFamilies ?? uploadFamilies))
    this._drop = new FileDrop(this, () => this._acceptsDrop())
  }

  _acceptsDrop() { return true }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._closeLocation()
  }

  _show(data) {
    this._data = data
    if (this._locationId && !data[`${this.constructor.kind}s`]?.some(item => item.id === this._locationId)) this._closeLocation()
  }

  _upload(files) {
    const { upload, uploadFamilies } = this.constructor
    return uploadFiles(this, files, file => upload(file, this._csrf), uploadFamilies)
  }

  // Those searched for of the visibility chosen, and how many of how many.
  _filtered() {
    const { kind } = this.constructor
    const items = Array.isArray(this._data?.[`${kind}s`]) ? this._data[`${kind}s`] : []
    const query = this._query.trim().toLocaleLowerCase()
    const filtered = items.filter(item => this._searchText(item).filter(Boolean).join(' ').toLocaleLowerCase().includes(query)
      && (this._visibility === 'all' || this._visible(item) === (this._visibility === 'visible')))
    const count = `${query || this._visibility !== 'all' ? `${filtered.length} of ` : ''}${items.length} ${items.length === 1 ? kind : `${kind}s`}`
    return { items, filtered, count }
  }

  _toolbar(count) {
    const { kind } = this.constructor
    return html`<div class="collection-toolbar" role="search">
      <input type="search" aria-label=${`Search ${kind}s`} placeholder=${`Search ${kind}s or repositories…`} .value=${this._query} @input=${e => { this._query = e.target.value }}>
      <select aria-label=${`${kind[0].toUpperCase()}${kind.slice(1)} visibility`} .value=${this._visibility} @change=${e => { this._visibility = e.target.value }}><option value="all">${`All ${kind}s`}</option><option value="visible">Visible to teams</option><option value="hidden">${`Hidden ${kind}s`}</option></select>
      ${count}
    </div>`
  }

  // `work`, its failure shown as `${failure}: …`.
  async _attempt(failure, work) {
    this._error = null
    try { await work() } catch (err) { this._error = `${failure}: ${String(err?.message ?? err)}` }
  }

  _setVisible(item, visible) {
    const { kind, setVisible, visibleFamilies } = this.constructor
    return this._attempt(`Couldn't change ${kind} visibility`, async () => {
      await this.appState.mutate(() => setVisible(item.id, visible, this._csrf), visibleFamilies)
      item.visible = visible
      this.requestUpdate()
      await this._load()
    })
  }

  _openLocation(item) {
    if (item.canChangeRepo === false) return
    this._closeLocation()
    Object.assign(this, { _locationId: item.id, _locationRepo: item.repoId ?? null, _locationDirectory: item.repoDirectory ?? '', _error: null })
    if (this._suggests(item)) void this._loadLocationOrigin(item)
  }

  _suggests() { return true }

  _closeLocation() {
    this._locationOriginRequest?.abort()
    this._locationOriginRequest = null
    Object.assign(this, { _locationId: null, _locationOrigin: null, _locationOriginError: null })
  }

  // The location the file names, as the server resolves it through current
  // connections and aliases. It never replaces the editor's values.
  async _loadLocationOrigin(item) {
    this._locationOriginRequest?.abort()
    const request = new AbortController()
    this._locationOriginRequest = request
    this._locationOrigin = undefined
    this._locationOriginError = null
    try {
      const origin = await this._fetchOrigin(item.id, request.signal)
      if (this._locationOriginRequest !== request) return
      // A repository may have been connected after this catalogue was loaded.
      if (origin?.repoId != null && this._data) {
        this._data = { ...this._data, repos: [...(this._data.repos ?? []).filter(repo => repo.repoId !== origin.repoId), { repoId: origin.repoId, fullName: origin.github }] }
      }
      this._locationOrigin = typeof origin?.github === 'string' && origin.github ? this._suggestion(origin) : null
    } catch (err) {
      if (this._locationOriginRequest !== request) return
      this._locationOrigin = null
      if (err?.name !== 'AbortError') this._locationOriginError = `Couldn't load the ${this.constructor.kind}’s suggested location.`
    }
  }

  _locationEditor(item) {
    const { kind, hintSource } = this.constructor
    const repos = Array.isArray(this._data?.repos) ? this._data.repos : []
    const origin = this._locationOrigin
    const originRepo = origin && this._originRepo(origin, repos)
    const hint = (value, field, apply) => locationHint(hintSource, value, field, apply, this._locationBusy)
    return html`<div class="location-editor">
      <div class="location-field">
        <div class="location-field-header"><span class="ui-hint">Repository</span>${origin ? hint(origin.github, 'repository', originRepo ? () => {
          this._locationRepo = originRepo.repoId
          if (origin.directory != null) this._locationDirectory = origin.directory
        } : null) : nothing}</div>
        <repository-selector label=${`Repository for ${kind}`} .options=${repoOptions(repos)} .value=${this._locationRepo} ?disabled=${this._locationBusy} @repository-change=${event => { this._locationRepo = event.detail.value }}></repository-selector>
      </div>
      <div class="location-field">
        <div class="location-field-header"><label for=${`${kind}-dir-${item.id}`}>Directory (optional)</label>${origin ? hint(origin.directory ?? 'Directory not specified', 'directory', origin.directory == null ? null : () => { this._locationDirectory = origin.directory }) : nothing}</div>
        <input id=${`${kind}-dir-${item.id}`} type="text" placeholder="Repository root" .value=${this._locationDirectory} ?disabled=${this._locationBusy} @input=${event => { this._locationDirectory = event.target.value }}>
      </div>
      <div class="location-actions"><button type="button" class="action" ?disabled=${this._locationBusy} @click=${() => this._closeLocation()}>Cancel</button><button type="button" class="action" ?disabled=${this._locationBusy} @click=${() => void this._saveLocation(item)}>Save</button></div>
      ${this._locationOriginError ? html`<p class="location-origin" role="status">${this._locationOriginError} <button type="button" class="origin-retry" @click=${() => void this._loadLocationOrigin(item)}>Retry</button></p>` : nothing}
    </div>`
  }

  async _saveLocation(item) {
    if (this._locationBusy) return
    this._locationBusy = true
    const { kind, setRepo, locationFamilies } = this.constructor
    try {
      await this._attempt(`Couldn't set ${kind} location`, async () => {
        await this.appState.mutate(() => setRepo(item.id, this._locationRepo, this._locationDirectory.trim(), this._csrf), locationFamilies)
        this._closeLocation()
        await this._load({ preserveError: true })
      })
    } finally { this._locationBusy = false }
  }
}

// Reports are uploaded with their own repository metadata, or assigned to the
// connected repository their findings name. New reports remain hidden until an
// admin previews and publishes them; the list never asks the uploader to repeat
// a repo or directory already present in the report header.
class ManagedAdminReports extends ManagedUploadsPage {
  static kind = 'report'
  static view = 'manage-reports'
  static collection = ['reports', 'reports', fetchReports]
  static upload = uploadReport
  static uploadFamilies = ['reports', 'repo-impact', 'history', 'scan-sources']
  static setVisible = setReportVisible
  static visibleFamilies = ['reports', 'history', 'scan-sources']
  static setRepo = setReportRepo
  static locationFamilies = ['reports', 'repo-impact', 'history', 'scan-sources']
  static hintSource = 'report'
  static properties = { _preview: { state: true }, _previewLoading: { state: true } }
  static styles = [unsafeCSS(reportsStyles), unsafeCSS(locationStyles), unsafeCSS(commonStyles), unsafeCSS(localImportStyles)]

  constructor() {
    super()
    this._preview = null
    this._previewLoading = null
    this._previewRequest = null
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._cancelPreview()
  }

  _show(data) {
    if (this._preview && !data.reports?.some(report => report.id === this._preview)) this._cancelPreview()
    super._show(data)
  }

  _searchText(report) { return [report.filename, displayName(report.filename), report.repoFullName, report.repoDirectory, report.uploadedByLogin] }
  _visible(report) { return Boolean(report.visible) }
  _fetchOrigin(id, signal) { return fetchReportLocation(id, AbortSignal.any([signal, this.appState.sessionController.signal])) }
  _suggestion(origin) { return { github: origin.github, repoId: origin.repoId ?? null, directory: typeof origin.directory === 'string' ? origin.directory || '/' : null } }
  _originRepo(origin, repos) { return origin.repoId != null && repos.find(repo => repo.repoId === origin.repoId) }

  render() {
    return html`
      ${this._drop.overlay('Drop reports to upload')}
      <div class="wrap">${this._nav()}
        <h1 class="sr-only">Reports</h1>
        <div class="page-intro"><p class="intro">Upload reports. New reports stay hidden until you make them visible.</p>${this._localImport.renderAction()}</div>
        ${this._localImport.renderPanel(this._busy || !this._csrf)}
        <div class="drop-card">${this._drop.card('Upload reports', 'Drop files anywhere on this page.', this._busy)}</div>
        ${this._data?.repoScopes?.length ? html`<p class="intro">Team paths: ${this._data.repoScopes.map(scope => `${this._data.repos.find(repo => repo.repoId === scope.repoId)?.fullName ?? scope.repoId}/${scope.path ?? ''}`).join(', ')}</p>` : nothing}
        ${this._body()}
      </div>`
  }

  _body() {
    const { items: reports, filtered, count } = this._filtered()
    return html`${this._toolbar(html`<span class="result-count" role="status">${this._data == null ? '… reports' : count}</span>`)}
      ${errorMessage(this._error)}
      ${this._list(this._data, 'Loading reports…', () => filtered.length > 0 ? html`<div class="report-list"><div class="report-list-head" aria-hidden="true"><span class="report-heading">Report</span><span>Repository</span><span>Uploaded by</span><span>Date</span><span class="size-heading">Size</span><span>Visibility</span><span class="actions-heading">Actions</span></div><ul class="reports">${filtered.map(report => this._row(report))}</ul></div>`
        : reports.length === 0 ? emptyState('No reports uploaded yet', 'Drop a report here or browse files above.') : emptyState('No matching reports', 'Try a different search or visibility filter.'))}`
  }

  _row(report) {
    const name = displayName(report.filename)
    const analyzer = report.analyzer ?? report.source ?? report.producer ?? 'default'
    const logo = REPORT_LOGOS[analyzer] ?? REPORT_LOGOS.default
    const canAssignLocation = report.repoEmbedded !== true && report.canChangeRepo !== false
    const canMakeVisible = report.repoEmbedded === true || report.repoId != null
    const location = locationOf(report)
    return html`<li class=${`report${report.visible === false ? ' content-hidden' : ''}`}>
      <div class="report-main">
        <span class="report-mark" aria-hidden="true">${appMarkup(logo)}</span>
        <span class="report-name" data-tooltip-truncated data-tooltip=${name}>${name}</span>
        <span class="report-location" data-tooltip-truncated data-tooltip=${location}>${location}</span>
        <span class="report-meta report-uploader" data-tooltip-truncated data-tooltip=${report.uploadedByLogin ?? 'Uploader removed'}>${report.uploadedByLogin ?? 'Uploader removed'}</span>
        <span class="report-meta report-date">${uploadedOn(report)}</span>
        <span class="report-meta report-size">${formatBytes(report.byteSize)}</span>
        <span class=${`status ${report.visible ? 'visible' : 'hidden'}`}>${report.visible ? 'Visible' : 'Hidden'}</span>
        <span class="report-actions">
          ${canAssignLocation ? html`<button type="button" class="action" data-tooltip="Set repository location" aria-label=${`Set location for ${name}`} @click=${() => this._openLocation(report)}>${adminIcon('repo')}</button>` : html`<span class="action-spacer"></span>`}
          <button type="button" class="action" aria-label=${`Preview ${name}`} aria-expanded=${this._preview === report.id} @click=${() => void this._togglePreview(report)}>${adminIcon('preview')}</button>
          <button type="button" class="action" data-tooltip=${report.visible ? 'Hide from teams' : canMakeVisible ? 'Make visible to teams' : 'Assign a repository before publishing'} aria-label=${`${report.visible ? 'Hide' : 'Make visible'} ${name}`} ?disabled=${report.canChangeRepo === false || (!canMakeVisible && !report.visible)} @click=${() => void this._setVisible(report, !report.visible)}>${adminIcon(report.visible ? 'hide' : 'show')}</button>
          <a class="action" aria-label=${`Download ${name}`} href=${`/api/admin/reports/${encodeURIComponent(report.id)}`}>${adminIcon('download')}</a>
          <button type="button" class="action danger" aria-label=${`Delete ${name}`} ?disabled=${report.canChangeRepo === false} @click=${() => this._delete(report)}>${ADMIN_DELETE_ICON}</button>
        </span>
      </div>
      ${this._preview === report.id ? html`<div class="preview">${this._previewLoading === report.id ? html`<span class="preview-loading">Loading preview…</span>` : html`<pre>${this._previewText ?? ''}</pre>`}</div>` : nothing}
      ${this._locationId === report.id ? this._locationEditor(report) : nothing}
    </li>`
  }

  _cancelPreview() {
    this._previewRequest?.abort()
    this._previewRequest = null
    this._preview = null
    this._previewLoading = null
    this._previewText = ''
  }

  async _togglePreview(report) {
    const wasOpen = this._preview === report.id
    this._cancelPreview()
    if (wasOpen) return
    const request = new AbortController()
    this._previewRequest = request
    const isCurrent = () => this._previewRequest === request && !request.signal.aborted
    const key = `report-preview:${report.id}`
    this._preview = report.id
    this._previewText = this.appState.read(key) ?? ''
    this._previewLoading = this.appState.read(key) === undefined ? report.id : null
    try {
      await this.appState.load(key, 'report preview', async signal => {
        const res = await managedFetch(`/api/admin/reports/${encodeURIComponent(report.id)}`, { credentials: 'same-origin', signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const text = await res.text()
        return text.slice(0, 4000) + (text.length > 4000 ? '\n…' : '')
      }, { signal: request.signal, apply: text => { this._previewText = text } })
    } catch (err) { if (isCurrent() && err?.name !== 'AbortError' && !this._previewText) this._previewText = `Preview unavailable: ${err?.message ?? err}` }
    finally { if (isCurrent()) this._previewLoading = null }
  }

  async _delete(report) {
    if (!globalThis.confirm?.(`Delete “${displayName(report.filename)}”? This can't be undone.`)) return
    await this._attempt('Delete failed', () => this.appState.mutate(() => deleteReport(report.id, this._csrf), ['reports', `report-preview:${report.id}`, 'repo-impact', 'history', 'scan-sources']))
    await this._load({ preserveError: true })
  }
}
customElements.define('managed-admin-reports', ManagedAdminReports)

// Package/box glyph, tinted via currentColor.
const BUNDLE_ICON = html`<svg class="report-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
  <path d="M8.878.392a1.75 1.75 0 0 0-1.756 0l-5.25 3.045A1.75 1.75 0 0 0 1 4.951v6.098c0 .624.332 1.2.872 1.514l5.25 3.045a1.75 1.75 0 0 0 1.756 0l5.25-3.045c.54-.313.872-.89.872-1.514V4.951c0-.624-.332-1.2-.872-1.514ZM7.875 1.69a.25.25 0 0 1 .25 0l4.63 2.685L8 7.133 3.245 4.375Zm-5.125 4.4 4.5 2.61v5.317l-4.375-2.537a.25.25 0 0 1-.125-.216Zm6 7.927V8.7l4.5-2.61v3.96a.25.25 0 0 1-.125.216Z"/>
</svg>`

// A bundle's delete confirmation, naming the reports that use it (linked to
// it, or declaring it in their bundleHashes), as many as fit, and counting
// those the reader can't access. Their link waits for the same bytes again.
const BUNDLE_DELETION_NAMES = 5
function bundleDeletion(bundle, { reports, otherReports }) {
  const count = reports.length + otherReports
  if (count === 0) return `Delete “${bundle.filename}”? No reports use it.`
  const lines = reports.slice(0, BUNDLE_DELETION_NAMES).map(report => `• ${displayName(report.filename)}`)
  const more = reports.length - lines.length
  const others = `${otherReports} ${otherReports === 1 ? 'report' : 'reports'} you can't access`
  if (more > 0) lines.push(`• ${more} more${otherReports > 0 ? `, and ${others}` : ''}`)
  else if (otherReports > 0) lines.push(`• ${others}`)
  return [`Delete “${bundle.filename}”?`, '', `${count === 1 ? '1 report uses' : `${count} reports use`} this bundle:`, ...lines, '',
    `${count === 1 ? 'Its' : 'Their'} findings will show no code from it until the same bundle is uploaded again.`].join('\n')
}

// Source bundles (sourcemaps or Stasis archives, content-addressed so
// duplicates collapse), uploaded or built from a repository, with their
// uploader and repository.
class ManagedAdminBundles extends ManagedUploadsPage {
  static kind = 'bundle'
  static view = 'manage-bundles'
  static collection = ['bundles', 'bundles', fetchBundles]
  static upload = uploadBundle
  static uploadFamilies = ['bundles', 'bundle-metadata', 'reports', 'repo-impact', 'history', 'scan-sources']
  static importFamilies = ['bundles', 'reports', 'repo-impact', 'history', 'scan-sources']
  static setVisible = setBundleVisible
  static visibleFamilies = ['bundles', 'teams', 'history', 'scan-sources']
  static setRepo = setBundleRepo
  static locationFamilies = ['bundles', 'teams', 'repo-impact', 'history', 'scan-sources']
  static hintSource = 'metadata'
  static properties = {
    createRepoId: { attribute: false }, installTooltips: { attribute: false },
    _visibilityBusy: { state: true }, _deleting: { state: true }, _creating: { state: true },
  }
  static styles = [unsafeCSS(bundlesStyles), unsafeCSS(locationStyles), unsafeCSS(commonStyles), unsafeCSS(localImportStyles)]

  constructor() {
    super()
    Object.assign(this, { _visibilityBusy: null, _deleting: null, _creating: false })
  }

  _acceptsDrop() { return !this._creating }
  _searchText(bundle) { return [bundle.filename, bundle.repoFullName, bundle.repoDirectory, bundle.kind, bundle.provenance === 'build' ? 'built' : null, bundle.uploadedByLogin] }
  _visible(bundle) { return bundle.visible !== false }
  _suggests(bundle) { return bundle.kind === 'stasis' }
  _fetchOrigin(id, signal) { return fetchBundleOrigin(id, { signal }) }
  _suggestion(repo) { return { github: repo.github, directory: typeof repo.directory === 'string' ? repo.directory : repo.root === true ? '/' : null } }

  _originRepo(origin, repos) {
    const github = reportRepoGithub({ repo: origin })?.toLowerCase()
    return github && repos.find(repo => repo.fullName.toLowerCase() === github)
  }

  _showCreate(open) {
    if (!open && this.createRepoId != null) {
      openAdminPage('manage-bundles')
      return
    }
    this._creating = open
    this._drop.active = false
    if (!open) void this.updateComplete.then(() => this.renderRoot.querySelector('.create-bundle-action')?.focus())
  }

  willUpdate(changed) {
    if (changed.has('createRepoId')) this._creating = this.createRepoId != null
  }

  render() {
    if (this._creating) {
      return html`<div class="wrap">${this._nav()}
      ${breadcrumb('Bundles', 'Back to bundles', () => this._showCreate(false), 'Create a bundle')}
      <managed-create-bundle .initialRepoId=${this.createRepoId ?? null} .installTooltips=${this.installTooltips}
        .createBundle=${this._csrf ? (input, signal) => this.appState.mutate(() => createBundle(input, this._csrf, signal), ['bundles', 'bundle-metadata', 'reports', 'repo-impact', 'history', 'scan-sources']) : undefined}
        @bundle-created=${event => this._emit('managed-bundle-open', event.detail)}></managed-create-bundle>
    </div>`
    }
    return html`
      ${this._drop.overlay('Drop bundles to upload')}
      <div class="wrap">${this._nav()}
        <h1 class="sr-only">Bundles</h1>
        <div class="page-intro"><p class="intro">Source bundles for your repositories.</p><div class="bundle-actions">${this._localImport.renderAction()}<button type="button" class="local-import-toggle create-bundle-action" ?disabled=${!this._data} @click=${() => this._showCreate(true)}>Create</button></div></div>
        ${this._localImport.renderPanel(this._busy || !this._csrf)}
        <section class="drop-card" aria-label="Upload bundles">${this._drop.card('Upload source bundles', 'Drop source archives anywhere on this page.', this._busy)}</section>
        ${this._body()}
      </div>`
  }

  _body() {
    const { items: bundles, filtered, count } = this._filtered()
    const loaded = this._data != null
    const unassigned = filtered.filter(bundle => bundle.repoId == null).length
    const bytes = filtered.reduce((sum, bundle) => sum + (Number.isFinite(bundle.byteSize) ? bundle.byteSize : 0), 0)
    const groups = [...Map.groupBy(filtered, (bundle) => bundle.repoFullName || 'Unattached')].toSorted(([a], [b]) => a === 'Unattached' ? -1 : b === 'Unattached' ? 1 : a.localeCompare(b))
    return html`${this._toolbar(html`<span class="summary result-count" role="status"><span>${loaded ? count : '… bundles'}</span><span>${loaded ? formatBytes(bytes) : '…'}</span>
        ${!loaded || unassigned ? html`<span class="unassigned">${loaded ? `${unassigned} unattached` : '… unattached'}</span>` : nothing}
      </span>`)}
      ${errorMessage(this._error)}
      ${this._list(this._data, 'Loading bundles…', () => filtered.length > 0 ? html`<div class="bundle-groups">${groups.map(([name, items]) => html`<section class="bundle-group"><div class="bundle-group-head"><strong>${name}</strong><span>${items.length} ${items.length === 1 ? 'bundle' : 'bundles'}</span></div><ul class="bundles">${items.map((b) => this._row(b))}</ul></section>`)}</div>`
        : bundles.length > 0 ? emptyState('No matching bundles', 'Try a different search or visibility filter.') : emptyState('No bundles uploaded yet', 'Drop source archives here or browse files above.'))}`
  }

  _row(b) {
    const visible = b.visible !== false
    const location = locationOf(b)
    return html`<li class=${`bundle-row${visible ? '' : ' content-hidden'}`}>
      <span class="identity"><span class="bundle-icon" aria-hidden="true">${b.kind === 'stasis' ? html`<img src="./stasis.svg" width="16" height="16" alt="">` : BUNDLE_ICON}</span>
        <button type="button" class="filename bundle-open" data-tooltip-truncated data-tooltip=${b.filename} @click=${() => this._emit('managed-bundle-open', b)}>${b.filename}</button>
        ${b.provenance === 'build' ? html`<span class="bundle-provenance" data-tooltip="Generated on this server from the repository">Built</span>` : nothing}
      </span>
      <span class="meta bundle-uploader" data-tooltip-truncated data-tooltip=${b.uploadedByLogin ? `@${b.uploadedByLogin}` : ''}>${b.uploadedByLogin ? `@${b.uploadedByLogin}` : ''}</span>
      <span class="meta bundle-date">${uploadedOn(b)}</span>
      <span class="meta bundle-size">${formatBytes(b.byteSize)}</span>
      <span class="bundle-location" data-tooltip-truncated data-tooltip=${location}>${location}</span>
      <span class=${`status ${visible ? 'visible' : 'hidden'}`}>${visible ? 'Visible' : 'Hidden'}</span>
      <span class="actions">
        ${b.canChangeRepo === false ? nothing : html`<button type="button" class="action" aria-label=${`Set location for ${b.filename}`} data-tooltip="Set repository location" ?disabled=${this._locationBusy} @click=${() => this._openLocation(b)}>${adminIcon('repo')}</button>`}
        <button type="button" class="action" aria-label=${`${visible ? 'Hide' : 'Make visible'} ${b.filename}`} data-tooltip=${visible ? 'Hide from teams' : b.repoId == null ? 'Assign a repository before publishing' : 'Make visible to teams'} ?disabled=${this._visibilityBusy != null || b.canChangeRepo === false || (!visible && b.repoId == null)} @click=${() => void this._setVisible(b, !visible)}>${adminIcon(visible ? 'hide' : 'show')}</button>
        <a class="action" aria-label=${`Download ${b.filename}`} href=${`/api/admin/bundles/${encodeURIComponent(b.id)}`}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8m-3-3 3 3 3-3M3 11v3h10v-3"/></svg></a>
        <button type="button" class="action danger" aria-label=${`Delete ${b.filename}`} ?disabled=${b.canChangeRepo === false || this._deleting != null} data-tooltip=${b.canChangeRepo === false ? 'Repository access is required to detach or delete this bundle' : nothing} @click=${() => this._delete(b)}>${ADMIN_DELETE_ICON}</button>
      </span>
      ${this._locationId === b.id ? this._locationEditor(b) : nothing}
    </li>`
  }

  async _setVisible(bundle, visible) {
    if (this._visibilityBusy != null || bundle.canChangeRepo === false) return
    this._visibilityBusy = bundle.id
    try { await super._setVisible(bundle, visible) } finally { this._visibilityBusy = null }
  }

  _openLocation(bundle) {
    if (!this._locationBusy) super._openLocation(bundle)
  }

  _saveLocation(bundle) {
    return bundle.canChangeRepo === false ? Promise.resolve() : super._saveLocation(bundle)
  }

  // Asks which reports use the bundle first, and says so in the confirmation;
  // without that answer nothing is deleted.
  async _delete(b) {
    if (this._deleting != null || b.canChangeRepo === false) return
    this._deleting = b.id
    this._error = null
    try {
      let usage
      try { usage = await fetchBundleUsage(b.id) } catch (err) {
        this._error = `Couldn't check which reports use “${b.filename}”: ${String(err?.message ?? err)}`
        return
      }
      if (!globalThis.confirm?.(bundleDeletion(b, usage))) return
      await this._attempt('Delete failed', () => this.appState.mutate(() => deleteBundle(b.id, this._csrf), ['bundles', 'bundle-metadata', 'reports', 'repo-impact', 'history', 'scan-sources']))
      await this._load({ preserveError: true })
    } finally { this._deleting = null }
  }
}
customElements.define('managed-admin-bundles', ManagedAdminBundles)

// Manage supplies its own navigation and authenticated model transport.
class ManagedAdminScans extends ManagedPage {
  static view = 'manage-scans'
  static properties = { selection: { attribute: false }, _source: { state: true } }
  static styles = unsafeCSS(commonStyles)
  static collection = ['bundles', 'bundles', fetchBundles]

  constructor() {
    super()
    this._source = null
    this._loadModels = (signal, apply) => this.appState.load('models', 'scan models', requestSignal => fetchScanModels(requestSignal, managedFetch), { signal, apply })
    this._loadReportSources = (consumerSignal, apply) => this.appState.load('scan-sources', 'scan report inputs', async signal => {
      const [catalogue, results] = await Promise.all([
        managedFetch('/api/admin/reports', { signal, credentials: 'same-origin' }),
        managedFetch('/api/admin/scan-results', { signal, credentials: 'same-origin' }),
      ])
      if (!catalogue.ok) throw new Error(`Reports: HTTP ${catalogue.status}`)
      // Scan-server result discovery is not implemented by the real service yet.
      if (!results.ok && results.status !== 404) throw new Error(`Scan results: HTTP ${results.status}`)
      const data = await catalogue.json()
      // Read visible reports to apply the report library's application-layer
      // filter. The administration catalogue alone does not carry findings.
      data.reports = await Promise.all((data.reports ?? []).filter(report => report.visible && report.repoId != null).map(async report => {
        const response = await managedFetch(`/api/admin/reports/${encodeURIComponent(report.id)}`, { signal, credentials: 'same-origin' })
        if (!response.ok) throw new Error(`Report ${displayName(report.filename)}: HTTP ${response.status}`)
        return { ...report, content: await response.text() }
      }))
      return managedReportSources(data, results.ok ? await results.json() : { bundles: [], results: [] })
    }, { signal: consumerSignal, apply })
  }

  // `<deepview-scan-page>` comes with Scans' own bundle and upgrades once it
  // arrives, keeping the properties already set on it.
  _load() {
    loadScanPage().catch(err => { this._error = String(err?.message ?? err) })
    return super._load()
  }

  _show(data) { this._source = managedScanSource(data) }

  render() {
    return html`<div class="wrap">${this._nav()}
      ${this._error ? html`<p class="msg error" role="alert">Couldn’t load scan sources: ${this._error} <button type="button" class="btn" @click=${() => void this._load()}>Retry</button></p>` : nothing}
      <deepview-scan-page hide-heading .selection=${this.selection} .source=${this._source} .sourceLoading=${this._loading && this._source == null} .loadBundle=${loadManagedScanBundle} .loadModels=${this._loadModels} .loadReportSources=${this._loadReportSources} .createBundleHref=${repoId => Number.isSafeInteger(repoId) && repoId > 0 ? managedRoutePath({ view: 'manage-bundles', createRepoId: repoId }) : null}></deepview-scan-page>
    </div>`
  }
}
customElements.define('managed-admin-scans', ManagedAdminScans)

const withoutKey = (map, key) => new Map([...map].filter(([id]) => id !== key))

// Teams: their repositories (each with an optional path) and members (each
// with the dependencies and security permissions, both off by default).
class ManagedAdminTeams extends ManagedPage {
  static view = 'manage-teams'
  static properties = { _busy: { state: true }, _renamingId: { state: true }, _repoChoices: { state: true }, _memberChoices: { state: true } }
  static styles = [unsafeCSS(teamsStyles), unsafeCSS(commonStyles)]
  static collection = ['teams', 'teams', fetchTeams]

  constructor() {
    super()
    Object.assign(this, { _busy: false, _renamingId: null, _repoChoices: new Map(), _memberChoices: new Map() })
  }

  // Run a mutation then reload; surfaces failures on the page. A team's
  // repositories, visibility and dependency review decide which teams'
  // reviews count for a repository (its page's `reviewTeams`), and whether
  // its pull requests' reviews are in effect: those read before are read
  // again.
  async _do(fn) {
    if (this._busy) return
    this._busy = true
    this._error = null
    try {
      await this.appState.mutate(fn, ['teams', 'users', 'reports', 'history', 'repos'])
      globalThis.dispatchEvent?.(new Event('dependency-review-changed'))
    } catch (err) { this._error = String(err?.message ?? err) }
    finally { this._busy = false; await this._load({ preserveError: true }) }
  }

  // A team change POSTed (_do), then `done`.
  _post(path, body, done = () => {}) {
    return this._do(async () => { await postTeam(path, this._csrf, body); done() })
  }

  render() {
    return html`<div class="wrap">${this._nav()}
      <h1 class="sr-only">Teams</h1>
      <div class="page-intro"><p class="intro">Manage repository and finding access for each team.</p><span class="result-count">${this._data?.teams?.length ?? '…'} teams</span></div>
      <div class="create-team">
        <label class="sr-only" for="new-team-name">New team</label>
        <input id="new-team-name" class="new-name" type="text" placeholder="Team name" maxlength="100" ?disabled=${this._busy}
          @keydown=${(e) => { if (e.key === 'Enter') this._create() }}>
        <button class="btn primary" ?disabled=${this._busy} @click=${() => this._create()}>${ADMIN_PLUS_ICON} Create team</button>
        <p class="access-note ui-hint">All members can view standard findings. Set dependencies and security access per member.</p>
      </div>
      <div class="manage-list" aria-busy=${this._loading}>${this._body()}</div>
    </div>`
  }

  _body() {
    if (this._error != null && this._data == null) return html`<p class="msg error">Couldn't load teams: ${this._error}</p>`
    if (this._data == null) return loadingRows('Loading teams…')
    const teams = Array.isArray(this._data.teams) ? this._data.teams : []
    return html`
      ${this._error == null ? nothing : html`<p class="msg error">${this._error}</p>`}
      ${teams.length === 0 ? html`<p class="msg">No teams yet. Create one above.</p>` : teams.map((t) => this._team(t))}`
  }

  _team(team) {
    return html`<section class="team" aria-label=${team.name}>
      <div class="team-head">
        <span class="team-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2.5"/><path d="M1.5 13v-1c0-2 1.8-3.5 4.5-3.5s4.5 1.5 4.5 3.5v1M11 2.5a2.5 2.5 0 0 1 0 5M12 9c1.7.5 2.5 1.5 2.5 3v1"/></svg></span>
        ${this._renamingId === team.id
          ? html`<input class="rename-input" type="text" .value=${team.name} maxlength="100"
              aria-label="Team name"
              @keydown=${(e) => this._renameKey(e, team)}>
            <button class="btn" ?disabled=${this._busy} @click=${(e) => this._saveRename(team, e)}>Save</button>
            <button class="btn" @click=${() => { this._renamingId = null }}>Cancel</button>`
          : html`<h2 class="team-name">${team.name}</h2>
            ${team.hidden ? html`<span class="muted ui-hint">Disabled</span>` : nothing}
            <span class="team-actions">
              <button class="icon-btn" aria-label=${`${team.hidden ? 'Restore' : 'Hide'} ${team.name}`} ?disabled=${this._busy}
                @click=${() => this._post('/set-hidden', { teamId: team.id, hidden: !team.hidden })}>${adminIcon(team.hidden ? 'show' : 'hide')}</button>
              <button class="icon-btn" aria-label=${`Rename ${team.name}`} ?disabled=${this._busy} @click=${() => { this._renamingId = team.id }}>${ADMIN_EDIT_ICON}</button>
              <button class="icon-btn danger" aria-label=${`Delete ${team.name}`} ?disabled=${this._busy} @click=${() => this._deleteTeam(team)}>${ADMIN_DELETE_ICON}</button>
            </span>`}
      </div>
      <div class="team-body">
      <div class="sub">
        <h3 class="sub-title">Repositories <span class="count">${team.repos.length}</span></h3>
        ${team.repos.length === 0 ? html`<p class="muted ui-hint">No repositories linked.</p>`
          : html`<ul class="links">${team.repos.map((r) => this._repoRow(team, r))}</ul>`}
        ${this._addRepoRow(team)}
      </div>
      <div class="sub">
        <h3 class="sub-title">Members <span class="count">${team.members.length}</span></h3>
        ${team.members.length === 0 ? html`<p class="muted ui-hint">No members.</p>`
          : html`<ul class="links">${team.members.map((m) => this._memberRow(team, m))}</ul>`}
        ${this._addMemberRow(team)}
      </div>
      ${this._npmScopes(team)}
      </div>
    </section>`
  }

  // Scopes whose private packages members open in the npm viewer, as admins
  // and managers open any the server's token can read.
  _npmScopes(team) {
    const scopes = Array.isArray(team.npmScopes) ? team.npmScopes : []
    return html`<div class="sub npm-scopes">
      <div class="sub-head">
        <h3 class="sub-title">npm scopes <span class="count">${scopes.length}</span>
          <mode-switch class="npm-review-toggle" label="Enable dependency review" .checked=${Boolean(team.dependencyReview)} .disabled=${this._busy}
            @click=${() => { if (!this._busy) void this._post('/set-dependency-review', { teamId: team.id, enabled: !team.dependencyReview }) }}></mode-switch>
        </h3>
        <p class="muted ui-hint">Members can open private packages in these scopes. Everyone can open public packages.</p>
      </div>
      <div class="add-row npm-scope-row">
        <input class="add-npm-scope" type="text" placeholder="@scope" aria-label=${`npm scope to add to ${team.name}`} maxlength="215" ?disabled=${this._busy}
          @keydown=${(e) => { if (e.key === 'Enter') this._addNpmScope(team, e) }}>
        <button class="btn" aria-label=${`Add npm scope to ${team.name}`} ?disabled=${this._busy} @click=${(e) => this._addNpmScope(team, e)}>${ADMIN_PLUS_ICON} Add</button>
        ${scopes.length === 0 ? nothing : html`<ul class="npm-scope-list">${scopes.map(scope => html`<li class="npm-scope">
          <span>${scope}</span>
          <button class="icon-btn danger" aria-label=${`Remove ${scope} from ${team.name}`} ?disabled=${this._busy}
            @click=${() => this._post('/set-npm-scopes', { teamId: team.id, scopes: scopes.filter(other => other !== scope) })}>${ADMIN_REMOVE_ICON}</button>
        </li>`)}</ul>`}
      </div>
    </div>`
  }

  _addNpmScope(team, e) {
    const input = e.target.closest('.add-row')?.querySelector('.add-npm-scope')
    if (!input?.value.trim()) return
    const scope = normalizeNpmScope(input.value)
    if (scope === null) { this._error = `“${input.value.trim()}” is not an npm scope. Scopes look like @example.`; return }
    const scopes = Array.isArray(team.npmScopes) ? team.npmScopes : []
    if (scopes.includes(scope)) { input.value = ''; return }
    void this._post('/set-npm-scopes', { teamId: team.id, scopes: [...scopes, scope] }, () => { input.value = '' })
  }

  _repoRow(team, r) {
    return html`<li class="repo-row">
      ${REPO_ICON}
      <span class="repo-copy"><span class="ln">${r.fullName}</span>${r.path ? html`<span class="path">/${r.path.replace(/^\/+/u, '')}</span>` : nothing}</span>
      <button class="icon-btn danger" aria-label=${`Remove ${r.fullName}${r.path ? `/${r.path}` : ''} from ${team.name}`} ?disabled=${this._busy} @click=${() => this._post('/remove-repo', { teamId: team.id, repoId: r.repoId, path: r.path ?? null })}>${ADMIN_REMOVE_ICON}</button>
    </li>`
  }

  _addRepoRow(team) {
    const repos = Array.isArray(this._data.repos) ? this._data.repos : []
    if (repos.length === 0) return html`<p class="muted ui-hint">No selected repositories to link — pick some on “Manage repositories”.</p>`
    return html`<div class="add-row">
      <repository-selector class="add-repo-sel" label=${`Repository to add to ${team.name}`} placeholder="Add repository…" ?disabled=${this._busy}
        .options=${repos.map(repo => ({ value: repo.repoId, label: repo.fullName }))} .value=${this._repoChoices.get(team.id) ?? null}
        @repository-change=${event => { this._repoChoices = new Map(this._repoChoices).set(team.id, event.detail.value) }}></repository-selector>
      <input class="add-repo-path" type="text" placeholder="Path (optional)" aria-label=${`Repository path in ${team.name} (optional)`} maxlength="500" ?disabled=${this._busy}>
      <button class="btn" aria-label=${`Add repository to ${team.name}`} ?disabled=${this._busy || !this._repoChoices.has(team.id)} @click=${(e) => this._addRepo(team, e)}>${ADMIN_PLUS_ICON} Add</button>
    </div>`
  }

  // Admins and managers see all content, whatever a team grants them.
  _fullAccess(member) {
    return this._data.users?.some(user => user.id === member.userId && roleAtLeast(user.role, 'manage'))
  }

  _memberRow(team, m) {
    const perms = Array.isArray(this._data.permissions) ? this._data.permissions : []
    const fullContentAccess = this._fullAccess(m)
    return html`<li class="member-row">
      <span class="member">${adminAvatar(m.userId, m.login)}<span class="ln">${m.login}</span></span>
      <span class="perms">
        ${perms.map((p) => html`<label class="perm">
          <input type="checkbox" .checked=${fullContentAccess || m[p] === true} ?disabled=${this._busy || fullContentAccess}
            aria-label=${`${VISIBILITY_PERMISSION_LABELS[p] ?? p} access for ${m.login} in ${team.name}`}
            @change=${(e) => this._togglePerm(team, m, p, e.target.checked)}>
          ${VISIBILITY_PERMISSION_LABELS[p] ?? p}
        </label>`)}
      </span>
      <button class="icon-btn danger" aria-label=${`Remove ${m.login} from ${team.name}`} ?disabled=${this._busy} @click=${() => this._post('/remove-member', { teamId: team.id, userId: m.userId })}>${ADMIN_REMOVE_ICON}</button>
    </li>`
  }

  _addMemberRow(team) {
    const users = Array.isArray(this._data.users) ? this._data.users : []
    const member = new Set(team.members.map((m) => m.userId))
    return html`<div class="add-row">
      <user-selector class="add-member-sel" label=${`Member to add to ${team.name}`} placeholder="Add member…" ?disabled=${this._busy}
        .users=${users.map(user => ({ ...user, disabled: member.has(user.id), detail: member.has(user.id) ? 'Member' : '' }))} .value=${this._memberChoices.get(team.id) ?? null}
        @user-change=${event => { this._memberChoices = new Map(this._memberChoices).set(team.id, event.detail.value) }}></user-selector>
      <button class="btn" aria-label=${`Add member to ${team.name}`} ?disabled=${this._busy || !this._memberChoices.has(team.id) || member.has(this._memberChoices.get(team.id))} @click=${() => this._addMember(team)}>${ADMIN_PLUS_ICON} Add</button>
    </div>`
  }

  _create() {
    const input = this.renderRoot.querySelector('.new-name')
    const name = input?.value.trim()
    if (!name) return
    void this._post('', { name }, () => { if (input) input.value = '' })
  }

  _deleteTeam(team) {
    if (!globalThis.confirm?.(`Delete team “${team.name}”? Its repo + member links are removed.`)) return
    void this._post('/delete', { teamId: team.id })
  }

  _renameKey(e, team) {
    if (e.key === 'Enter') this._saveRename(team, e)
    else if (e.key === 'Escape') this._renamingId = null
  }

  // Commit an inline rename: read the input, exit edit mode, and (when the name
  // actually changed) POST it. A blank or unchanged name just cancels.
  _saveRename(team, e) {
    if (this._busy) return // another mutation is in flight — keep the edit box open (Enter isn't gated by the disabled button)
    const name = e.target.closest('.team-head')?.querySelector('.rename-input')?.value.trim() ?? ''
    this._renamingId = null
    if (name === '' || name === team.name) return
    void this._post('/rename', { teamId: team.id, name })
  }

  _addRepo(team, e) {
    const row = e.target.closest('.add-row')
    const repoId = this._repoChoices.get(team.id)
    if (!Number.isSafeInteger(repoId) || repoId <= 0) return
    const path = row?.querySelector('.add-repo-path')?.value ?? ''
    void this._post('/set-repo', { teamId: team.id, repoId, path }, () => {
      this._repoChoices = withoutKey(this._repoChoices, team.id)
      const input = row?.querySelector('.add-repo-path')
      if (input) input.value = ''
    })
  }

  _addMember(team) {
    const userId = this._memberChoices.get(team.id)
    if (!userId || team.members.some(member => member.userId === userId)) return
    void this._post('/set-member', { teamId: team.id, userId }, () => { this._memberChoices = withoutKey(this._memberChoices, team.id) })
  }

  _togglePerm(team, m, perm, checked) {
    if (this._fullAccess(m)) return
    const perms = { ...Object.fromEntries((this._data.permissions ?? []).map(p => [p, m[p] === true])), [perm]: checked }
    void this._post('/set-member', { teamId: team.id, userId: m.userId, ...perms })
  }
}
customElements.define('managed-admin-teams', ManagedAdminTeams)
