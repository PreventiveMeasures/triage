import { getPreviewRole, managedFetch } from '../../client/managed/request.js'
// Manage custom elements, registered by the lazy client-managed.js entry.
// Manage data stays in the lazy bundle; the host supplies session updates and
// renders composed navigation and notification events.
import { html, nothing, unsafeCSS } from 'lit'
import { ManagedPage, loadingRows } from './page.js'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { ROLES } from '../../common/managed/roles.ts'
import { VISIBILITY_PERMISSION_LABELS } from '../../common/managed/permissions.ts'
import { REPORT_LOGOS } from '../view/report-logos.js'
import { DELETE_ICON_SVG, EDIT_ICON_SVG } from '../view/icons.js'
import { adminIcon, adminNavigation } from './navigation.js'
import { ManagedLocalImport } from './local-import.js'
import localImportStyles from './styles/local-import.css'
import commonStyles from './styles/common.css'
import homeStyles from './styles/home.css'
import historyStyles from './styles/history.css'
import usersStyles from './styles/users.css'
import reposStyles from './styles/repos.css'
import reportsStyles from './styles/reports.css'
import bundlesStyles from './styles/bundles.css'
import teamsStyles from './styles/teams.css'
import '../scan/page.js'
import { loadManagedScanBundle, managedScanSource } from './scan-source.js'
import { managedReportSources } from '../scan/report-source.js'
import { fetchScanModels } from '../view/scan-models.js'
import { repositoryChoices } from '../view/repository-options.js'
import '../view/repository-selector.js'
import '../view/user-selector.js'

function openAdminPage(view) {
  document.dispatchEvent(new CustomEvent('managed-admin-navigate', {
    detail: { view }, bubbles: true, composed: true,
  }))
}

function adminAvatar(id, login) {
  return html`<span class="avatar" aria-hidden="true">
    <span>${(login?.[0] ?? '?').toUpperCase()}</span>
    ${getPreviewRole() ? nothing : html`<img alt="" src=${`/api/avatar/${encodeURIComponent(id)}`} @error=${(e) => e.currentTarget.classList.add('broken')}>`}
  </span>`
}

const ADMIN_EDIT_ICON = unsafeHTML(EDIT_ICON_SVG)
const ADMIN_DELETE_ICON = unsafeHTML(DELETE_ICON_SVG)
const ADMIN_REMOVE_ICON = html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg>`
const ADMIN_PLUS_ICON = html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>`
const ADMIN_ROLE_LABELS = { admin: 'Admin', manage: 'Manager', triage: 'Triage', view: 'Viewer', none: 'No access' }
const ADMIN_ROLE_DESCRIPTIONS = {
  admin: 'Manage workspace access and teams',
  manage: 'Manage content and triage within team access',
  triage: 'Review and triage findings',
  view: 'Read-only access',
  none: 'No workspace access',
}

class ManagedAdminHome extends ManagedPage {

  static styles = [unsafeCSS(homeStyles), unsafeCSS(commonStyles)]

  render() {
    const content = [
      ['manage-bundles', 'Bundles', 'Keep source archives ready for review.', 'bundle'],
      ['manage-scans', 'Scans', 'Run and monitor scans from stored bundles.', 'scan'],
      ['manage-reports', 'Reports', 'Review, publish, and organize findings.', 'report'],
    ]
    const workspace = [
      ['manage-repos', 'Repositories', 'Connect sources and manage repository settings.', 'repo'],
      ['admin-users', 'Users', 'Manage accounts, roles, and workspace access.', 'users'],
      ['manage-teams', 'Teams', 'Bring people and repositories together.', 'team'],
    ]
    return html`<div class="wrap">${adminNavigation('manage', this._role)}
      <h1 class="sr-only">Manage</h1>
      ${this._role == null ? html`<p class="msg" role="status">Loading management pages…</p>` : html`
        <section class="home-section" aria-labelledby="content-heading">
          <div class="section-heading"><h2 id="content-heading">Content & activity</h2><span>From source to findings</span></div>
          <div class="pages">${content.filter(([view]) => view !== 'manage-scans' || ['admin', 'manage'].includes(this._role)).map(page => this._page(page))}</div>
        </section>
        ${this._role === 'admin' ? html`<section class="home-section" aria-labelledby="workspace-heading">
          <div class="section-heading"><h2 id="workspace-heading">Workspace & access</h2><span>Sources, people, and permissions</span></div>
          <div class="pages workspace-pages">${workspace.map(page => this._page(page))}</div>
        </section>` : nothing}
        <button type="button" class="history-link" @click=${() => openAdminPage('manage-history')}>
          <span class="page-icon" aria-hidden="true">${adminIcon('history')}</span>
          <span class="page-copy"><strong>Workspace history</strong><span>Follow activity and triage changes across your workspace.</span></span>
          <span class="history-cta">View history ${adminIcon('arrow')}</span>
        </button>`}
    </div>`
  }

  _page([view, title, description, icon]) {
    return html`<button type="button" class=${`page page-${icon}`} @click=${() => openAdminPage(view)}>
      <span class="page-top"><span class="page-icon" aria-hidden="true">${adminIcon(icon)}</span><strong class="page-title">${title}</strong><span class="arrow" aria-hidden="true">${adminIcon('arrow')}</span></span>
      <span class="page-copy"><span>${description}</span></span>
    </button>`
  }

}
customElements.define('managed-admin-home', ManagedAdminHome)

async function fetchHistory(signal, page, kind, query, repo, actor) {
  const params = new URLSearchParams({ page: String(page), limit: '100', kind, q: query.trim() })
  if (repo) params.set('repo', repo)
  if (actor) params.set('actor', actor)
  const res = await managedFetch(`/api/admin/history?${params}`, { signal, credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  if (!Array.isArray(body?.history) || !Number.isSafeInteger(body.total) || body.total < 0
    || !Number.isSafeInteger(body.page) || body.page < 1) throw new Error('No history returned')
  return body
}

class ManagedAdminHistory extends ManagedPage {
  static properties = { _page: { state: true }, _history: { state: true }, _total: { state: true }, _error: { state: true }, _filter: { state: true }, _query: { state: true }, _repo: { state: true }, _actor: { state: true }, _options: { state: true } }

  static styles = [unsafeCSS(historyStyles), unsafeCSS(commonStyles)]

  constructor() {
    super()
    this._history = null
    this._total = 0
    this._searchTimer = null
    this._error = null
    this._page = 1
    this._filter = 'all'
    this._query = ''
    this._repo = ''
    this._actor = ''
    this._options = { repos: [], users: [] }
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
    void this._load()
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

  _setRepo(repo) {
    this._repo = repo
    return this._load()
  }

  _setActor(actor) {
    this._actor = actor
    return this._load()
  }

  _clearContext() {
    this._repo = ''
    this._actor = ''
    return this._load()
  }

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
    return html`<div class="wrap">${adminNavigation('manage-history', this._role)}
      <h1 class="sr-only">History</h1>
      <div class="page-intro"><p class="intro">${this._role === 'admin' ? 'Uploads, access changes, repository changes, deletions, and triage.' : 'Bundle, report, and triage history within your team access.'}</p><span class="result-count">${this._history ? this._total : '…'} entries</span></div>
      <div class="toolbar" role="search">
        <input type="search" maxlength="500" aria-label="Search history" placeholder="Search history…" .value=${this._query} @input=${(event) => this._search(event.target.value)}>
        <select aria-label="Filter history by type" .value=${this._filter} @change=${(event) => { this._filter = event.target.value; void this._load() }}><option value="all">All activity</option><option value="triage">Triage</option><option value="visibility">Visibility</option><option value="upload">Uploads</option><option value="repository">${this._role === 'admin' ? 'Repositories' : 'Assignments'}</option>${this._role === 'admin' ? html`<option value="access">Access</option>` : nothing}<option value="delete">Deletions</option></select>
        ${this._contextFilters()}
        <button type="button" class="btn" ?disabled=${this._loading} @click=${() => this._load(page)}>Refresh</button>
      </div>
      ${this._error ? html`<p class="msg error" role="alert">Couldn’t load history: ${this._error} <button type="button" class="btn" @click=${() => this._load()}>Retry</button></p>` : nothing}
      <div aria-busy=${this._loading}>${this._history == null ? (this._error ? nothing : loadingRows('Loading history…')) : history.length === 0 ? html`<div class="history"><p class="empty">${this._query.trim() || this._filter !== 'all' || this._repo || this._actor ? 'No activity matches your filters.' : 'No history available yet.'}</p></div>` : html`<div class="history" aria-label="Workspace history"><div class="history-head" aria-hidden="true"><span>Type</span><span>Activity</span><span>Repository / report / finding</span><span>Time</span></div>${history.map((entry) => this._row(entry))}</div>`}</div>
      ${this._total > 100 ? html`<nav class="pagination" aria-label="History pages"><span role="status">${start + 1}–${Math.min(start + 100, this._total)} of ${this._total} entries</span><button type="button" class="btn" ?disabled=${this._loading || page === 1} @click=${() => this._changePage(page - 1)}>Previous</button><span>Page ${page} of ${Math.ceil(this._total / 100)}</span><button type="button" class="btn" ?disabled=${this._loading || start + 100 >= this._total} @click=${() => this._changePage(page + 1)}>Next</button></nav>` : nothing}
    </div>`
  }

  async _changePage(page) {
    await this._load(page)
    await this.updateComplete
    this.renderRoot.querySelector('.history')?.scrollIntoView({ block: 'start' })
  }

  _row(entry) {
    const detail = [entry.repo ?? entry.repository, entry.report, entry.finding].filter(Boolean).join(' · ')
    const actor = entry.actor ?? entry.user ?? 'Unknown user'
    const action = entry.action ?? 'updated workspace data'
    return html`<div class="row"><span class=${`kind ${entry.kind ?? ''}`}>${entry.kind ?? 'activity'}</span><span class="activity-description" data-tooltip-truncated data-tooltip=${`${actor} ${action}`}><strong class="actor">${actor}</strong> <span class="action">${action}</span></span><span class="detail" data-tooltip-truncated data-tooltip=${detail}>${detail || '—'}</span><span class="history-time">${userTime(entry.at)}</span></div>`
  }
}
customElements.define('managed-admin-history', ManagedAdminHistory)

async function fetchUsers(signal) {
  const res = await managedFetch('/api/admin/users', { signal, credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  return Array.isArray(body?.users) ? body.users : []
}

function userTime(value) {
  if (value == null || value === '') return html`<span>Unknown</span>`
  const timestamp = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(timestamp)) return html`<span>Unknown</span>`
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return html`<span>Unknown</span>`
  return html`<time datetime=${date.toISOString()}>${date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</time><span>${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>`
}

function userTimeLabel(value) {
  if (value == null || value === '') return 'Unknown'
  const timestamp = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(timestamp) && !Number.isNaN(new Date(timestamp).getTime()) ? `Last seen ${new Date(timestamp).toLocaleString()}` : 'Unknown'
}

function userActivityAt(user) {
  return user?.lastActivityAt ?? user?.lastActivity ?? user?.lastWriteAt ?? user?.lastActiveAt
}

async function setRole(userId, role, csrfToken) {
  const headers = { 'content-type': 'application/json' }
  if (csrfToken) headers['x-csrf-token'] = csrfToken
  const res = await managedFetch('/api/admin/set-role', {
    method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ userId, role }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

class ManagedAdminUsers extends ManagedPage {
  static properties = {
    _query: { state: true },
    _users: { state: true },
    _teams: { state: true },
    _error: { state: true },
  }

  static styles = [unsafeCSS(usersStyles), unsafeCSS(commonStyles)]

  constructor() {
    super()
    this._users = null
    this._query = ''
    this._teams = null
    this._error = null
  }

  connectedCallback() {
    super.connectedCallback()
    void this._load()
  }

  async _load() {
    this._error = null
    await this._loadCollection('users', 'users', signal => Promise.all([fetchUsers(signal), fetchTeams(signal)]), ([users, teamData]) => {
      this._users = users
      this._teams = Array.isArray(teamData?.teams) ? teamData.teams : []
    })
  }

  render() {
    return html`<div class="wrap">${adminNavigation('admin-users', this._role)}
      <h1 class="sr-only">Users</h1>
      <div class="page-intro"><p class="intro">Manage workspace access and roles.</p><span class="result-count">${this._users?.length ?? '…'} users</span></div>
      <div class="collection-toolbar" role="search"><input type="search" aria-label="Search users" placeholder="Search by name, username, or team…" .value=${this._query} @input=${e => { this._query = e.target.value }}></div>
      ${this._error ? html`<p class="msg error" role="alert">Couldn't load users: ${this._error}</p>` : nothing}
      <div aria-busy=${this._loading}>${this._users == null ? (this._error ? nothing : loadingRows('Loading users…')) : this._list()}</div>
    </div>`
  }

  _list() {
    if (this._users.length === 0) return html`<p class="msg">No users yet.</p>`
    const query = this._query.trim().toLocaleLowerCase()
    const users = this._users.filter(user => [user.name, user.login, user.role, ...(this._teams ?? []).filter(team => team.members?.some(member => member.userId === user.id)).map(team => team.name)].filter(Boolean).join(' ').toLocaleLowerCase().includes(query))
    if (users.length === 0) return html`<div class="empty"><strong>No matching users</strong><p>Try another name, username, or team.</p></div>`
    return html`<div class="directory">
      <div class="list-head" aria-hidden="true"><span>Account</span><span>Team access</span><span>Last seen</span><span>Last activity</span><span>Role</span></div>
      <ul class="users">${users.map((u) => this._row(u))}</ul>
    </div>${this._users.some((u) => u.id === this._me) ? html`<p class="self-note">Your own role can only be changed by another admin.</p>` : nothing}`
  }

  _row(u) {
    const isSelf = u.id === this._me
    const memberships = (this._teams ?? []).flatMap((team) => {
      const member = team.members?.find((candidate) => candidate.userId === u.id)
      return member == null ? [] : [{ team, member }]
    })
    return html`<li>
      <span class="person">
        ${adminAvatar(u.id, u.login)}
        <span class="who">
          <span class="name"><span class="name-text">${u.name || u.login}</span>${isSelf ? html`<span class="you">You</span>` : nothing}</span>
          <span class="login">@${u.login}</span>
        </span>
      </span>
      <span class="memberships">
        ${memberships.length === 0 ? html`<span class="no-team">No team access</span>` : memberships.map(({ team, member }) => {
          return html`<span class="team-access"><strong>${adminIcon('team')}<span>${team.name}</span></strong><span class="team-perms">${['dependencies', 'security'].map((permission) => html`<span class=${member[permission] === true ? 'permission-granted' : 'permission-denied'}>${member[permission] === true ? '+' : '−'} ${permission === 'dependencies' ? 'Deps' : 'Security'}</span>`)}</span></span>`
        })}
      </span>
      <span class="last-seen" aria-label=${userTimeLabel(u.lastSeenAt)}>${userTime(u.lastSeenAt)}</span>
      <button type="button" class="activity-link" aria-label=${`Show activity by ${u.login}`} @click=${() => this._showActivity(u.id)}><span class="last-activity" aria-label=${`Last activity ${userTimeLabel(userActivityAt(u)).replace(/^Last seen /u, '')}`}>${userTime(userActivityAt(u))}</span></button>
      <span class="access">
      <select class="role" ?disabled=${isSelf}
        aria-label=${`Change ${u.login}’s role`}
        aria-description=${ADMIN_ROLE_DESCRIPTIONS[u.role] ?? ''}
        @change=${(e) => this._changeRole(u, e.target.value, e.target)}>
        ${ROLES.map((r) => html`<option value=${r} ?selected=${r === u.role}>${ADMIN_ROLE_LABELS[r]}</option>`)}
      </select>
      </span>
    </li>`
  }

  async _changeRole(u, role, selectEl) {
    const prev = u.role
    if (role === prev) return
    try {
      await this.appState.mutate(() => setRole(u.id, role, this._csrf), ['users', 'teams', 'history'])
      u.role = role
      await this._load()
    } catch (err) {
      console.warn('admin: set role failed:', err)
      selectEl.value = prev
    }
    this.requestUpdate()
  }

  _showActivity(userId) {
    document.dispatchEvent(new CustomEvent('managed-admin-navigate', {
      detail: { view: 'manage-history', actor: `user:${userId}` }, bubbles: true, composed: true,
    }))
  }
}
customElements.define('managed-admin-users', ManagedAdminUsers)

// The connected list is served from stored configuration; discovery runs only
// for the installed/public pickers. Search and organization filters use the full catalogue.
async function fetchRepositories(scope, showAll, refresh, signal) {
  const params = new URLSearchParams({ scope })
  if (scope === 'installed') params.set('showAll', String(showAll))
  if (refresh) params.set('refresh', 'true')
  const res = await managedFetch(`/api/admin/repositories?${params}`, { credentials: 'same-origin', headers: { accept: 'application/json' }, signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// Toggle whether a repo is active (the server verifies access + records the read
// context when activating, and deactivates without deleting stored data).
async function selectRepository(repoId, selected, csrfToken) {
  const headers = { 'content-type': 'application/json' }
  if (csrfToken) headers['x-csrf-token'] = csrfToken
  const res = await managedFetch('/api/admin/repositories/select', {
    method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ repoId, selected }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

async function fetchRepositoryImpact(repoId, signal) {
  const res = await managedFetch(`/api/admin/repositories/impact?repoId=${encodeURIComponent(repoId)}`, {
    credentials: 'same-origin', headers: { accept: 'application/json' }, signal,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const impact = await res.json()
  if (impact?.repoId !== repoId || !Array.isArray(impact.reports) || !Array.isArray(impact.bundles)
      || !Number.isSafeInteger(impact.triageCount) || impact.triageCount < 0) throw new Error('Invalid repository data')
  return impact
}

async function removeRepository(repoId, fullName, deleteTriage, csrfToken) {
  const headers = { 'content-type': 'application/json' }
  if (csrfToken) headers['x-csrf-token'] = csrfToken
  const res = await managedFetch('/api/admin/repositories/remove', {
    method: 'POST', credentials: 'same-origin', headers,
    body: JSON.stringify({ repoId, fullName, acknowledge: true, deleteTriage }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

const REPO_ICON = adminIcon('repo')

// Only the connected set loads on entry. Private/public discovery is opt-in,
// and each connected repository has its own page for configuration.
class ManagedAdminRepos extends ManagedPage {
  static properties = {
    _data: { state: true },
    _error: { state: true },
    _actionError: { state: true },
    _scope: { state: true },
    _showAll: { state: true },
    _query: { state: true },
    _organization: { state: true },
    _loading: { state: true },
    _busy: { state: true },
    _detail: { state: true },
    _impact: { state: true },
    _impactLoading: { state: true },
    _removeOpen: { state: true },
    _acknowledge: { state: true },
    _deleteTriage: { state: true },
    _confirmName: { state: true },
  }

  static styles = [unsafeCSS(reposStyles), unsafeCSS(commonStyles)]

  constructor() {
    super()
    this._data = null
    this._error = null
    this._actionError = null
    this._scope = 'connected'
    this._showAll = false
    this._query = ''
    this._organization = null
    this._loading = true
    this._busy = null
    this._detail = null
    this._impact = null
    this._impactLoading = false
    this._impactFresh = false
    this._removeOpen = false
    this._acknowledge = false
    this._deleteTriage = false
    this._confirmName = ''
    this._impactRequest = null
  }

  connectedCallback() {
    super.connectedCallback()
    void this._load()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._impactRequest?.abort()
  }

  _repositoryKey() { return `repos:${JSON.stringify([this._scope, this._showAll])}` }

  async _load(refresh = false) {
    this._error = null
    const { _scope: scope, _showAll: showAll } = this
    await this._loadCollection(this._repositoryKey(), 'repositories', signal => fetchRepositories(scope, showAll, refresh, signal), data => {
      this._data = data
      this._organization = this._repositoryChoices().activeFacet
    })
  }

  _open(scope) {
    this._impactRequest?.abort()
    this._scope = scope
    this._showAll = false
    this._query = ''
    this._organization = null
    this._detail = null
    this._impact = null
    this._removeOpen = false
    this._acknowledge = false
    this._deleteTriage = false
    this._confirmName = ''
    this._data = null
    this._actionError = null
    void this._load()
  }

  _setShowAll(value) {
    this._showAll = value
    this._organization = null
    this._data = null
    void this._load()
  }

  _search(value) { this._query = value }

  _repositoryChoices() {
    const options = (this._data?.repositories ?? []).map(repo => ({ value: repo.id, label: repo.fullName, repo }))
    return repositoryChoices(options, this._query, this._organization, { includeSingletonOrganizations: true })
  }

  _back() {
    return html`<span class="breadcrumb">
      <button type="button" class="breadcrumb-manage" @click=${() => {
        document.dispatchEvent(new CustomEvent('managed-admin-navigate', {
          detail: { view: 'manage' }, bubbles: true, composed: true,
        }))
      }}>Manage</button>
      <span class="breadcrumb-separator" aria-hidden="true">›</span>
      <button type="button" class="breadcrumb-manage" aria-label="Back to repositories" @click=${() => {
        if (this._detail) { this._impactRequest?.abort(); this._detail = null; this._actionError = null }
        else this._open('connected')
      }}>Repositories</button>
      <span class="breadcrumb-separator" aria-hidden="true">›</span>
    </span>`
  }

  _openDetail(repo) {
    this._detail = repo
    this._actionError = null
    this._impact = this.appState.read(`repo-impact:${repo.id}`) ?? null
    this._impactFresh = false
    this._removeOpen = false
    this._acknowledge = false
    this._deleteTriage = false
    this._confirmName = ''
    this._impactLoading = true
    this._impactRequest?.abort()
    const request = new AbortController()
    this._impactRequest = request
    void this.appState.load(`repo-impact:${repo.id}`, 'repository data', signal => fetchRepositoryImpact(repo.id, signal), {
      signal: request.signal, apply: impact => { this._impact = impact },
    }).then(impact => { if (!request.signal.aborted) this._impactFresh = true; return impact }).catch((err) => {
      if (!request.signal.aborted && err?.name !== 'AbortError' && !this._impact) this._actionError = `Couldn't load repository data: ${err?.message ?? err}`
    }).finally(() => {
      if (this._impactRequest === request) this._impactLoading = false
    })
  }

  render() {
    if (this._detail) return this._detailPage(this._detail)
    const connected = this._scope === 'connected'
    const title = connected ? 'Repositories' : `Add ${this._scope} repository`
    const choices = this._repositoryChoices()
    return html`<div class="wrap">${adminNavigation('manage-repos', this._role)}
      ${connected ? html`<h1 class="sr-only">${title}</h1>` : html`<div class="head">${this._back()}<h1>${title}</h1></div>`}
      <div class="page-intro"><p class="intro">${connected
        ? 'Manage connected repositories and their settings.'
        : this._scope === 'installed'
          ? this._showAll ? 'Showing all repositories the GitHub App can read.' : 'Showing installed repositories you can access on GitHub.'
          : 'Choose a public repository your GitHub account is involved with.'}</p>${connected ? html`<span class="result-count">${this._data?.connectedCount ?? '…'} connected</span>` : nothing}</div>
      ${!connected && this._scope === 'installed' ? html`<div class="access-note">
        <p>Installed repositories are readable through the GitHub App. Install it on a repository or organization to make it available here.</p>
        <span class="access-action">${this._data?.installUrl ? html`<a class="btn" href=${this._data.installUrl} target="_blank" rel="noopener noreferrer">Configure GitHub access</a>` : html`<button type="button" class="btn" disabled>Configure GitHub access</button>`}</span>
      </div>` : nothing}
      <div class="toolbar">
        <label class="search"><input type="search" aria-label=${connected ? 'Search connected repositories' : `Search ${this._scope} repositories`} placeholder="Search by repository or owner…" .value=${this._query} @input=${(e) => this._search(e.target.value)}></label>
        ${this._scope === 'installed' ? html`<label class="show-all"><input type="checkbox" role="switch" .checked=${this._showAll} @change=${(event) => this._setShowAll(event.target.checked)}><span>Show all</span></label>` : nothing}
        ${connected ? html`
          <button type="button" class="btn" @click=${() => this._open('installed')}>${this._accessIcon('private')} Add installed repository</button>
          <button type="button" class="btn" @click=${() => this._open('public')}>${this._accessIcon('public')} Add your public repository</button>
        ` : html`<button type="button" class="btn" ?disabled=${this._loading} @click=${() => { void this._load(true) }}>Refresh</button>`}
      </div>
      ${this._actionError ? html`<p class="msg error" role="alert">${this._actionError}</p>` : nothing}
      ${this._error ? html`<p class="msg error" role="alert">Couldn't load repositories: ${this._error}</p><button type="button" class="btn" @click=${() => { void this._load() }}>Try again</button>` : nothing}
      ${this._data ? html`<p class="repository-count" role="status">${choices.count}${choices.count === choices.total ? '' : ` of ${choices.total}`} ${choices.total === 1 ? 'repository' : 'repositories'}</p>` : nothing}
      <div aria-busy=${this._loading}>${this._body(choices)}</div>
    </div>`
  }

  _body(choices) {
    if (!this._data) return this._error ? nothing : loadingRows('Loading repositories…')
    return html`
      ${this._data.tokenMissing && !this._showAll && this._scope !== 'connected' ? html`<p class="msg">Log out and back in to refresh your GitHub membership access.</p>` : nothing}
      <div class="repository-browser">
        ${choices.showFacets ? html`<nav class="organization-list" aria-label="Filter by organization">
          <button type="button" class="organization" aria-pressed=${choices.activeFacet == null} @click=${() => { this._organization = null }}><span class="organization-name">All organizations</span><span class="organization-count">${choices.total}</span></button>
          ${choices.facets.map(org => html`<button type="button" class="organization" title=${org.name} aria-pressed=${choices.activeFacet === org.value} @click=${() => { this._organization = org.value }}><span class="organization-name">${org.name}</span><span class="organization-count">${org.count}</span></button>`)}
        </nav>` : nothing}
        <div class="repo-results">
          ${choices.sections.map(section => html`<section class="repo-group" aria-label=${section.label ?? 'Repositories'}>
            ${section.label ? html`<h2 class="owner-head"><span class="owner-icon" aria-hidden="true">${section.label[0] ?? '?'}</span>${section.label}</h2>` : nothing}
            <ul class="repos">${section.options.map(option => this._row(option.repo, section.organization ? option.name : option.label))}</ul>
          </section>`)}
          ${choices.count ? nothing : html`<div class="empty">
            <strong>${choices.total ? 'No matching repositories' : this._scope === 'connected' ? 'No connected repositories yet' : `No ${this._scope} repositories available`}</strong>
            <p>${choices.total ? 'Try a different search or organization.' : this._scope === 'connected' ? 'Add an installed or public repository to get started.' : this._scope === 'installed' ? this._showAll ? 'Install the GitHub App, then refresh this list.' : 'No installed repositories match your GitHub access. Turn on Show all to browse every installation.' : 'Public repositories associated with your GitHub account will appear here.'}</p>
          </div>`}
        </div>
      </div>
    `
  }

  _row(repo, label) {
    const access = `${this._accessLabel(repo)}${this._scope === 'connected' && repo.active === false ? ' · Deactivated' : ''}`
    const copy = html`${REPO_ICON}<span class="repo-copy"><span class="repo-name">${label}</span><span class="repo-meta">${access}</span></span>`
    if (this._scope === 'connected') {
      return html`<li><button type="button" class="repo-row" aria-label=${`Manage ${repo.fullName}`} @click=${() => this._openDetail(repo)}>
        ${copy}<svg class="arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>
      </button></li>`
    }
    return html`<li class="repo-row">${copy}
      ${repo.selected ? html`<span class="connected"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>Connected</span>`
        : repo.private && !repo.installed
          ? html`<span class="repo-meta">Needs App access</span>`
          : html`<button type="button" class="btn" aria-label=${`Add ${repo.fullName}`} ?disabled=${this._busy != null} @click=${() => { void this._setActive(repo, true) }}>${this._busy === repo.id ? 'Adding…' : 'Add'}</button>`}
    </li>`
  }

  _accessLabel(repo) {
    const visibility = repo.visibility === 'public' ? 'Public' : repo.visibility === 'internal' ? 'Internal' : repo.private ? 'Private' : null
    const source = repo.installed ? 'GitHub App' : 'GitHub membership'
    return visibility ? `${visibility} · ${source}` : source
  }

  _detailPage(repo) {
    const active = repo.active !== false
    const reports = this._impact?.reports ?? []
    const bundles = this._impact?.bundles ?? []
    return html`<div class="wrap">${adminNavigation('manage-repos', this._role)}
      <div class="head">${this._back()}<h1>${repo.fullName}</h1></div>
      <p class="intro">Repository settings and stored data.</p>
      ${this._actionError ? html`<p class="msg error" role="alert">${this._actionError}</p>` : nothing}
      <section class="section" aria-label="Repository connection">
        <h2>Connection</h2>
        <div class="settings-row"><div class="settings-copy"><strong>${this._accessLabel(repo)}</strong><p>${active ? 'Active for new scans and uploads.' : 'Deactivated. Stored reports and bundles are retained.'}</p></div>
          <span class=${`status-line ${active ? '' : 'inactive'}`}>${active ? 'Active' : 'Deactivated'}</span>
          ${repo.htmlUrl ? html`<a class="btn" href=${repo.htmlUrl} target="_blank" rel="noopener noreferrer">View on GitHub</a>` : nothing}
        </div>
        <div class="settings-row"><div class="settings-copy"><strong>${active ? 'Deactivate repository' : 'Reactivate repository'}</strong><p>${active ? 'Pause new scans while preserving all stored data and attachments.' : 'Make this repository available for new scans and bundle attachments again.'}</p></div>
          <button type="button" class="btn" ?disabled=${this._busy != null} @click=${() => { void this._setActive(repo, !active) }}>${this._busy === repo.id ? (active ? 'Deactivating…' : 'Reactivating…') : (active ? 'Deactivate' : 'Reactivate')}</button>
        </div>
      </section>
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
          <button type="button" class="btn danger" ?disabled=${this._busy != null || this._impactLoading || !this._impactFresh || this._impact == null} @click=${() => { this._removeOpen = true; this._acknowledge = false; this._deleteTriage = false; this._confirmName = '' }}>Remove permanently</button>
        </div>
      </section>
      ${this._removeOpen && this._impact != null && !this._impactLoading ? this._removeDialog(repo, reports, bundles) : nothing}
    </div>`
  }

  _removeDialog(repo, reports, bundles) {
    const hasAttached = reports.length > 0 || bundles.length > 0
    const ready = this._canRemove(repo)
    return html`<div class="dialog-backdrop" role="presentation" @click=${(event) => { if (event.target === event.currentTarget) this._removeOpen = false }}>
      <section class=${`dialog ${hasAttached ? '' : 'small'}`} role="dialog" aria-modal="true" aria-labelledby="remove-repo-title">
        <h2 id="remove-repo-title">Remove ${repo.fullName} permanently?</h2>
        <p class="dialog-copy">${hasAttached ? 'This destructive action will remove the repository and the stored data listed below. Deactivation keeps all of it.' : 'This repository has no attached reports or bundles. Permanent removal deletes its connection record.'}</p>
        ${hasAttached ? html`<div class="dialog-data">
          <section><h3>Reports to delete (${reports.length})</h3><ul>${reports.map((report) => html`<li>${report.filename}${report.repoDirectory ? ` · ${report.repoDirectory}` : nothing}</li>`)}</ul></section>
          <section><h3>Bundles to delete (${bundles.length})</h3><ul>${bundles.map((bundle) => html`<li>${bundle.filename}</li>`)}</ul></section>
        </div>` : nothing}
        <label class="confirm-line"><input type="checkbox" .checked=${this._acknowledge} @change=${(event) => { this._acknowledge = event.target.checked }}><span>I understand this permanently deletes the repository connection${hasAttached ? ', reports, and bundles' : ''}.</span></label>
        ${(this._impact?.triageCount ?? 0) > 0 ? html`<label class="confirm-line"><input type="checkbox" .checked=${this._deleteTriage} @change=${(event) => { this._deleteTriage = event.target.checked }}><span>Also delete ${this._impact.triageCount} triage entr${this._impact.triageCount === 1 ? 'y' : 'ies'} belonging only to this repository.</span></label>` : nothing}
        ${hasAttached ? html`<label class="confirm-field"><span>Type <strong>${repo.fullName}</strong> to confirm.</span><input class="confirm-name" type="text" autocomplete="off" .value=${this._confirmName} @input=${(event) => { this._confirmName = event.target.value }}></label>` : nothing}
        <div class="dialog-actions"><button type="button" class="btn" @click=${() => { this._removeOpen = false }}>Cancel</button><button type="button" class="btn danger" ?disabled=${!ready} @click=${() => { void this._remove(repo) }}>${this._busy === repo.id ? 'Removing…' : 'Remove permanently'}</button></div>
      </section>
    </div>`
  }

  _accessIcon(kind) {
    return kind === 'private' ? html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/></svg>` : html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"/><path d="M2.5 8h11M8 2c1.5 1.7 2.2 3.7 2.2 6S9.5 12.3 8 14c-1.5-1.7-2.2-3.7-2.2-6S6.5 3.7 8 2Z"/></svg>`
  }

  async _setActive(repo, active) {
    if (this._busy != null) return
    this._busy = repo.id
    this._actionError = null
    try {
      await this.appState.mutate(() => selectRepository(repo.id, active, this._csrf), ['repos', 'reports', 'bundles', 'teams', 'users', 'history'])
      if (!this.isConnected) return
      if (this._detail?.id === repo.id) this._detail = { ...this._detail, active }
      if (this._data) {
        this._data = { ...this._data, repositories: this._data.repositories.map((entry) => entry.id === repo.id ? { ...entry, active } : entry) }
      }
      await this._load()
    } catch (err) {
      const verb = active ? (repo.active === false ? 'reactivate' : 'add') : 'deactivate'
      this._actionError = `Couldn't ${verb} ${repo.fullName}: ${err?.message ?? err}`
    } finally {
      this._busy = null
    }
  }

  _canRemove(repo) {
    if (this._busy != null || this._impactLoading || !this._impactFresh || this._impact?.repoId !== repo.id || !this._acknowledge) return false
    const hasAttached = this._impact.reports.length > 0 || this._impact.bundles.length > 0
    return !hasAttached || this._confirmName === repo.fullName
  }

  async _remove(repo) {
    if (!this._canRemove(repo)) return
    this._busy = repo.id
    this._actionError = null
    try {
      await this.appState.mutate(() => removeRepository(repo.id, repo.fullName, this._deleteTriage, this._csrf), ['repos', 'repo-impact', 'reports', 'report-preview', 'bundles', 'teams', 'users', 'history', 'scan-sources'])
      this._removeOpen = false
      this._detail = null
      this._impact = null
      await this._load()
    } catch (err) {
      this._actionError = `Couldn't remove ${repo.fullName}: ${err?.message ?? err}`
    } finally {
      this._busy = null
    }
  }
}
customElements.define('managed-admin-repos', ManagedAdminRepos)

async function fetchReports(signal) {
  const res = await managedFetch('/api/admin/reports', { signal, credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// Upload one report file: the raw bytes as the body and the display name in the
// X-Report-Filename header. Repository, directory, and analyzer metadata come
// from the report header; CSRF rides the double-submit token. The server stores
// the bytes + records the metadata/attribution + auto-links the bundle. Throws
// with the status word the row surfaces (e.g. 413 → too large).
async function uploadReport(file, csrfToken, repoId = null, directory = '') {
  const headers = { 'content-type': file.type || 'application/json', 'x-report-filename': encodeURIComponent(file.name) }
  if (csrfToken) headers['x-csrf-token'] = csrfToken
  if (repoId != null) headers['x-repo-id'] = String(repoId)
  if (directory !== '') headers['x-repo-directory'] = encodeURIComponent(directory)
  const res = await managedFetch('/api/admin/reports', { method: 'POST', credentials: 'same-origin', headers, body: file })
  if (!res.ok) {
    if (res.status === 413) throw new Error('too large')
    if (res.status === 403) throw new Error('choose a repository and directory within your team access')
    let detail = ''
    try {
      const body = await res.json()
      if (body?.error === 'repo-not-connected' && typeof body.repo === 'string') detail = `: ${body.repo} is not connected`
    } catch {}
    throw new Error(`HTTP ${res.status}${detail}`)
  }
  return res.json()
}

async function setReportVisible(id, visible, csrfToken) {
  const headers = { 'content-type': 'application/json' }
  if (csrfToken) headers['x-csrf-token'] = csrfToken
  const res = await managedFetch('/api/admin/reports/set-visible', {
    method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ reportId: id, visible }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

async function setReportRepo(id, repoId, directory, csrfToken) {
  const headers = { 'content-type': 'application/json' }
  if (csrfToken) headers['x-csrf-token'] = csrfToken
  const res = await managedFetch('/api/admin/reports/set-repo', {
    method: 'POST', credentials: 'same-origin', headers,
    body: JSON.stringify({ reportId: id, repoId, directory }),
  })
  if (!res.ok) {
    if (res.status === 409) throw new Error('this report already defines its repository')
    if (res.status === 403) throw new Error('choose a repository and directory within your team access')
    throw new Error(res.status === 400 ? 'invalid repository or directory' : `HTTP ${res.status}`)
  }
  return res.json()
}

async function deleteReport(id, csrfToken) {
  const headers = csrfToken ? { 'x-csrf-token': csrfToken } : {}
  const res = await managedFetch(`/api/admin/reports/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin', headers })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

// Human byte size (B / KB / MB) for the report / bundle rows.
function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return ''
  if (n < 1024) return `${n} B`
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1_048_576).toFixed(1)} MB`
}

// Keep managed numeric repository IDs and null (unattached) intact.
function repoOptions(repos, allowUnassigned = true) {
  return [...(allowUnassigned ? [{ value: null, label: 'No repository', special: true }] : []), ...repos.map(repo => ({ value: repo.repoId, label: repo.fullName }))]
}

function repoPickerTemplate(repos, selected, onChange, label = 'Repository for new bundles', allowUnassigned = true) {
  const loading = !Array.isArray(repos)
  return html`<div class="repo-picker"><span class="repo-picker-label">${label}</span>
    <repository-selector class="repo-select" .options=${loading ? [{ value: null, label: 'Loading repositories…' }] : repoOptions(repos, allowUnassigned)} .value=${selected} label=${label} ?disabled=${loading || repos.length === 0}
      @repository-change=${event => onChange(event.detail.value)}></repository-selector>
  </div>`
}

function repoRowSelect(repos, current, onPick, allowUnassigned = true) {
  if (!Array.isArray(repos) || repos.length === 0) return nothing
  return html`<repository-selector class="repo-attach" label="Attach to a repository"
    .options=${repoOptions(repos, allowUnassigned)} .value=${current ?? null}
    @repository-change=${event => onPick(event.detail.value)}></repository-selector>`
}

// Open a file picker (hidden input, created on demand) and hand the chosen files
// to `onFiles`. `multiple` allows batch uploads.
function pickFiles(onFiles, multiple = true) {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = multiple
  input.addEventListener('change', () => { onFiles([...input.files]) }, { once: true })
  input.click()
}

// Wire file drag&drop onto a host element: `onFiles(File[])` fires on drop, and
// `onState(active)` toggles as a file drag enters / leaves (drives the drop
// overlay). Enter/leave are tracked with a depth counter so moving over child
// nodes doesn't flicker the overlay, and only drags that actually carry files
// are handled (so dragging text / a link is ignored). Returns a teardown.
function installFileDropZone(host, onFiles, onState) {
  let depth = 0
  const hasFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  const onEnter = (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth += 1; onState(true) }
  const onOver = (e) => { if (hasFiles(e)) e.preventDefault() } // preventDefault marks us a drop target
  const onLeave = (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (depth === 0) onState(false) }
  const onDrop = (e) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.stopPropagation() // this page owns the drop — don't let the app's global drop handler also see it
    depth = 0
    onState(false)
    onFiles([...e.dataTransfer.files])
  }
  host.addEventListener('dragenter', onEnter)
  host.addEventListener('dragover', onOver)
  host.addEventListener('dragleave', onLeave)
  host.addEventListener('drop', onDrop)
  return () => {
    host.removeEventListener('dragenter', onEnter)
    host.removeEventListener('dragover', onOver)
    host.removeEventListener('dragleave', onLeave)
    host.removeEventListener('drop', onDrop)
  }
}

// A local import owns exactly one upload result. Drops that arrive meanwhile
// wait in the regular queue, then run separately so their failures cannot turn
// a successful import into a retry (and duplicate the managed report).
async function uploadLocalFile(host, file, upload, families) {
  if (host._busy || !host._csrf) throw new Error('Wait for the current operation to finish, then try again.')
  host._busy = true
  try { await host.appState.mutate(() => upload(file), families) }
  finally {
    await host._load()
    host._busy = false
    const queued = host._queue.splice(0)
    if (queued.length > 0) void host._upload(queued)
  }
}

// Reports are uploaded with their own repository metadata. New reports remain
// hidden until an admin previews and publishes them; the list never asks the
// uploader to repeat a repo or directory already present in the report header.
class ManagedAdminReports extends ManagedPage {
  static properties = {
    localImportSource: { attribute: false },
    _query: { state: true },
    _visibility: { state: true },
    _data: { state: true },
    _error: { state: true },
    _busy: { state: true },
    _dragOver: { state: true },
    _preview: { state: true },
    _previewLoading: { state: true },
    _locationReport: { state: true },
    _locationRepo: { state: true },
    _locationDirectory: { state: true },
    _locationBusy: { state: true },
    _repoId: { state: true },
    _repoDirectory: { state: true },
  }

  static styles = [unsafeCSS(reportsStyles), unsafeCSS(commonStyles), unsafeCSS(localImportStyles)]

  constructor() {
    super()
    this._query = ''
    this._visibility = 'all'
    this._data = null
    this._error = null
    this._busy = false
    this._dragOver = false
    this._preview = null
    this._previewLoading = null
    this._previewRequest = null
    this._locationReport = null
    this._locationRepo = null
    this._locationDirectory = ''
    this._locationBusy = false
    this._repoId = null
    this._repoDirectory = ''
    this._teardownDrop = null
    this._queue = []
    this._localImport = new ManagedLocalImport(this, 'report', file => uploadLocalFile(this, file,
      selected => uploadReport(selected, this._csrf, this._repoId, this._repoDirectory.trim()), ['reports', 'repo-impact', 'history', 'scan-sources']))
  }

  connectedCallback() {
    super.connectedCallback()
    void this._load()
    this._teardownDrop = installFileDropZone(this, (files) => void this._upload(files), (active) => { this._dragOver = active })
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._teardownDrop?.()
    this._cancelPreview()
  }

  async _load({ preserveError = false } = {}) {
    if (!preserveError) this._error = null
    await this._loadCollection('reports', 'reports', fetchReports, data => {
      this._data = data
      if (this._preview && !data.reports?.some(report => report.id === this._preview)) this._cancelPreview()
    })
  }

  render() {
    return html`
      ${this._dragOver ? html`<div class="dropzone">Drop reports to upload</div>` : nothing}
      <div class="wrap">${adminNavigation('manage-reports', this._role)}
        <h1 class="sr-only">Reports</h1>
        <div class="page-intro"><p class="intro">Upload reports. New reports stay hidden until you make them visible.</p>${this._localImport.renderAction()}</div>
        ${this._localImport.renderPanel(this._busy || !this._csrf)}
        <div class="drop-card"><span class="drop-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10V2m0 0L5 5m3-3 3 3M3 9v3.5A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V9"/></svg></span><span class="drop-copy"><strong>Upload reports</strong><span>Drop files anywhere on this page, or browse your computer.</span></span><button type="button" class="drop-browse" ?disabled=${this._busy} @click=${() => pickFiles((files) => void this._upload(files))}>${this._busy ? 'Uploading…' : 'Browse files'}</button></div>
        <div class="location-editor" aria-label="Location for reports without repository metadata"><div class="location-field"><span>Repository (when absent from report)</span><repository-selector label="Repository for new reports" .options=${repoOptions(this._data?.repos ?? [])} .value=${this._repoId} ?disabled=${!this._data?.repos?.length} @repository-change=${event => { this._repoId = event.detail.value }}></repository-selector></div><div class="location-field"><label for="report-upload-directory">Directory</label><input id="report-upload-directory" placeholder="Repository root" .value=${this._repoDirectory} @input=${event => { this._repoDirectory = event.target.value }}></div></div>
        ${this._data?.repoScopes?.length ? html`<p class="intro">Team paths: ${this._data.repoScopes.map(scope => `${this._data.repos.find(repo => repo.repoId === scope.repoId)?.fullName ?? scope.repoId}/${scope.path ?? ''}`).join(', ')}</p>` : nothing}
        ${this._body()}
      </div>`
  }

  _body() {
    const reports = Array.isArray(this._data?.reports) ? this._data.reports : []
    const query = this._query.trim().toLocaleLowerCase()
    const filtered = reports.filter(report => [report.filename, report.repoFullName, report.repoDirectory, report.uploadedByLogin].filter(Boolean).join(' ').toLocaleLowerCase().includes(query)
      && (this._visibility === 'all' || Boolean(report.visible) === (this._visibility === 'visible')))
    return html`<div class="collection-toolbar" role="search"><input type="search" aria-label="Search reports" placeholder="Search reports or repositories…" .value=${this._query} @input=${e => { this._query = e.target.value }}><select aria-label="Report visibility" .value=${this._visibility} @change=${e => { this._visibility = e.target.value }}><option value="all">All reports</option><option value="visible">Visible to teams</option><option value="hidden">Hidden reports</option></select><span class="result-count" role="status">${this._data == null ? '… reports' : `${filtered.length} of ${reports.length} reports`}</span></div>
      ${this._error ? html`<p class="msg error" role="alert">${this._error}</p>` : nothing}
      <div aria-busy=${this._loading}>${this._data == null ? (this._error ? nothing : loadingRows('Loading reports…')) : filtered.length > 0 ? html`<div class="report-list"><div class="report-list-head" aria-hidden="true"><span class="report-heading">Report / repository</span><span>Uploaded by</span><span>Visibility</span><span class="actions-heading">Actions</span></div><ul class="reports">${filtered.map(report => this._row(report))}</ul></div>` : html`<div class="empty"><strong>${reports.length === 0 ? 'No reports uploaded yet' : 'No matching reports'}</strong><p>${reports.length === 0 ? 'Drop a report here or browse files above.' : 'Try a different search or visibility filter.'}</p></div>`}</div>`
  }

  _row(report) {
    const analyzer = report.analyzer ?? report.source ?? report.producer ?? 'default'
    const logo = REPORT_LOGOS[analyzer] ?? REPORT_LOGOS.default
    const canAssignLocation = report.repoEmbedded !== true && report.canChangeRepo !== false
    const canMakeVisible = report.repoEmbedded === true || report.repoId != null
    const location = report.repoFullName ? `${report.repoFullName}${report.repoDirectory ? `/${report.repoDirectory}` : ''}` : 'No repository assigned'
    const when = Number.isFinite(report.uploadedAt) ? new Date(report.uploadedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''
    return html`<li class="report">
      <div class="report-main">
        <span class="report-mark" aria-hidden="true">${unsafeHTML(logo)}</span>
        <span class="report-copy"><span class="report-name" data-tooltip-truncated data-tooltip=${report.filename}>${report.filename}</span><span class="report-location" data-tooltip-truncated data-tooltip=${location}>${location}</span></span>
        <span class="report-meta"><span data-tooltip-truncated data-tooltip=${report.uploadedByLogin ?? ''}>${report.uploadedByLogin ?? 'Uploader removed'}</span><span>${when} · ${formatBytes(report.byteSize)}</span></span>
        <span class=${`status ${report.visible ? 'visible' : 'hidden'}`}>${report.visible ? 'Visible' : 'Hidden'}</span>
        <span class="report-actions">
          ${canAssignLocation ? html`<button type="button" class="action" data-tooltip="Set repository location" aria-label=${`Set location for ${report.filename}`} @click=${() => this._openLocation(report)}>${adminIcon('repo')}</button>` : html`<span class="action-spacer"></span>`}
          <button type="button" class="action" data-tooltip=${this._preview === report.id ? 'Close preview' : 'Preview report'} aria-label=${`Preview ${report.filename}`} aria-expanded=${this._preview === report.id} @click=${() => void this._togglePreview(report)}>${adminIcon('preview')}</button>
          <button type="button" class="action" data-tooltip=${report.visible ? 'Hide from teams' : canMakeVisible ? 'Make visible to teams' : 'Assign a repository before publishing'} aria-label=${`${report.visible ? 'Hide' : 'Make visible'} ${report.filename}`} ?disabled=${report.canChangeRepo === false || (!canMakeVisible && !report.visible)} @click=${() => void this._setVisible(report, !report.visible)}>${adminIcon(report.visible ? 'hide' : 'show')}</button>
          <a class="action" aria-label=${`Download ${report.filename}`} href=${`/api/admin/reports/${encodeURIComponent(report.id)}`}>${adminIcon('download')}</a>
          <button type="button" class="action danger" aria-label=${`Delete ${report.filename}`} ?disabled=${report.canChangeRepo === false} @click=${() => this._delete(report)}>${ADMIN_DELETE_ICON}</button>
        </span>
      </div>
      ${this._preview === report.id ? html`<div class="preview">${this._previewLoading === report.id ? html`<span class="preview-loading">Loading preview…</span>` : html`<pre>${this._previewText ?? ''}</pre>`}</div>` : nothing}
      ${this._locationReport === report.id ? this._locationEditor(report) : nothing}
    </li>`
  }

  _openLocation(report) {
    if (report.canChangeRepo === false) return
    this._locationReport = report.id
    this._locationRepo = report.repoId ?? null
    this._locationDirectory = report.repoDirectory ?? ''
    this._error = null
  }

  _locationEditor(report) {
    const repos = Array.isArray(this._data?.repos) ? this._data.repos : []
    return html`<div class="location-editor"><div class="location-field"><span>Repository</span><repository-selector label="Repository for report" .options=${repoOptions(repos)} .value=${this._locationRepo} ?disabled=${this._locationBusy} @repository-change=${event => { this._locationRepo = event.detail.value }}></repository-selector></div><div class="location-field"><label for=${`report-dir-${report.id}`}>Directory (optional)</label><input id=${`report-dir-${report.id}`} type="text" placeholder="Repository root" .value=${this._locationDirectory} @input=${(e) => { this._locationDirectory = e.target.value }}></div><div class="location-actions"><button type="button" class="action" @click=${() => { this._locationReport = null }}>Cancel</button><button type="button" class="action" ?disabled=${this._locationBusy} @click=${() => void this._saveLocation(report)}>Save</button></div></div>`
  }

  async _saveLocation(report) {
    if (this._locationBusy) return
    this._locationBusy = true
    this._error = null
    try {
      await this.appState.mutate(() => setReportRepo(report.id, this._locationRepo, this._locationDirectory.trim(), this._csrf), ['reports', 'repo-impact', 'history', 'scan-sources'])
      this._locationReport = null
      await this._load({ preserveError: true })
    } catch (err) { this._error = `Couldn't set report location: ${String(err?.message ?? err)}` }
    finally { this._locationBusy = false }
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
    this._preview = report.id
    this._previewText = this.appState.read(`report-preview:${report.id}`) ?? ''
    this._previewLoading = this.appState.read(`report-preview:${report.id}`) === undefined ? report.id : null
    try {
      await this.appState.load(`report-preview:${report.id}`, 'report preview', async signal => {
        const res = await managedFetch(`/api/admin/reports/${encodeURIComponent(report.id)}`, { credentials: 'same-origin', signal })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const text = await res.text()
        return text.slice(0, 4000) + (text.length > 4000 ? '\n…' : '')
      }, { signal: request.signal, apply: text => { this._previewText = text } })
    } catch (err) { if (isCurrent() && err?.name !== 'AbortError' && !this._previewText) this._previewText = `Preview unavailable: ${err?.message ?? err}` }
    finally { if (isCurrent()) this._previewLoading = null }
  }

  async _setVisible(report, visible) {
    this._error = null
    try {
      await this.appState.mutate(() => setReportVisible(report.id, visible, this._csrf), ['reports', 'history', 'scan-sources'])
      report.visible = visible
      this.requestUpdate()
      await this._load()
    } catch (err) { this._error = `Couldn't change report visibility: ${String(err?.message ?? err)}` }
  }

  async _upload(files) {
    if (files.length === 0) return
    this._queue.push(...files)
    if (this._busy) return
    this._busy = true
    this._error = null
    try {
      while (this._queue.length > 0) await this.appState.mutate(() => uploadReport(this._queue.shift(), this._csrf, this._repoId, this._repoDirectory.trim()), ['reports', 'repo-impact', 'history', 'scan-sources'])
    } catch (err) { this._queue = []; this._error = `Upload failed: ${String(err?.message ?? err)}` }
    finally { this._busy = false; await this._load({ preserveError: true }) }
  }

  async _delete(report) {
    if (!globalThis.confirm?.(`Delete “${report.filename}”? This can't be undone.`)) return
    this._error = null
    try { await this.appState.mutate(() => deleteReport(report.id, this._csrf), ['reports', `report-preview:${report.id}`, 'repo-impact', 'history', 'scan-sources']) }
    catch (err) { this._error = `Delete failed: ${String(err?.message ?? err)}` }
    await this._load({ preserveError: true })
  }
}
customElements.define('managed-admin-reports', ManagedAdminReports)

async function fetchBundles(signal) {
  const res = await managedFetch('/api/admin/bundles', { signal, credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// Upload one bundle file: raw bytes as the body, name in X-Bundle-Filename, an
// optional repo link in X-Repo-Id, CSRF token. The server content-addresses it
// (sha512) — re-uploading identical bytes dedupes — and auto-links any reports
// that declared its integrity.
async function uploadBundle(file, csrfToken, repoId) {
  const headers = { 'content-type': 'application/octet-stream', 'x-bundle-filename': encodeURIComponent(file.name) }
  if (csrfToken) headers['x-csrf-token'] = csrfToken
  if (repoId != null) headers['x-repo-id'] = String(repoId)
  const res = await managedFetch('/api/admin/bundles', { method: 'POST', credentials: 'same-origin', headers, body: file })
  if (!res.ok) throw new Error(res.status === 413 ? 'too large' : res.status === 403 ? 'choose a repository within your team access' : `HTTP ${res.status}`)
  return res.json()
}

async function deleteBundle(id, csrfToken) {
  const headers = csrfToken ? { 'x-csrf-token': csrfToken } : {}
  const res = await managedFetch(`/api/admin/bundles/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin', headers })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

// Attach a stored bundle to a repo (repoId) or detach it (null). CSRF token.
async function setBundleRepo(id, repoId, csrfToken) {
  const headers = { 'content-type': 'application/json' }
  if (csrfToken) headers['x-csrf-token'] = csrfToken
  const res = await managedFetch('/api/admin/bundles/set-repo', {
    method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ bundleId: id, repoId }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

// Package/box glyph, tinted via currentColor.
const BUNDLE_ICON = html`<svg class="report-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
  <path d="M8.878.392a1.75 1.75 0 0 0-1.756 0l-5.25 3.045A1.75 1.75 0 0 0 1 4.951v6.098c0 .624.332 1.2.872 1.514l5.25 3.045a1.75 1.75 0 0 0 1.756 0l5.25-3.045c.54-.313.872-.89.872-1.514V4.951c0-.624-.332-1.2-.872-1.514ZM7.875 1.69a.25.25 0 0 1 .25 0l4.63 2.685L8 7.133 3.245 4.375Zm-5.125 4.4 4.5 2.61v5.317l-4.375-2.537a.25.25 0 0 1-.125-.216Zm6 7.927V8.7l4.5-2.61v3.96a.25.25 0 0 1-.125.216Z"/>
</svg>`

// Bundles — full-view page for admin/manage. Uploads a bundle (sourcemap /
// stasis archive, content-addressed by sha512 so dupes collapse) and lists what's
// stored, with download + delete, uploader/repo attribution, and the kind. Own
// chunk, fetches its own data; no main-bundle state.
class ManagedAdminBundles extends ManagedPage {
  static properties = {
    localImportSource: { attribute: false },
    _query: { state: true },
    _data: { state: true },
    _repoId: { state: true },
    _error: { state: true },
    _busy: { state: true },
    _dragOver: { state: true },
  }

  static styles = [unsafeCSS(bundlesStyles), unsafeCSS(commonStyles), unsafeCSS(localImportStyles)]

  constructor() {
    super()
    this._query = ''
    this._data = null
    this._error = null
    this._busy = false
    this._repoId = null // null = no repo link; otherwise a selected repo id (for new uploads)
    this._dragOver = false
    this._teardownDrop = null
    this._queue = [] // files awaiting upload; a drop during an in-flight upload joins it
    this._localImport = new ManagedLocalImport(this, 'bundle', file => uploadLocalFile(this, file,
      selected => uploadBundle(selected, this._csrf, this._repoId), ['bundles', 'reports', 'repo-impact', 'history', 'scan-sources']))
  }

  connectedCallback() {
    super.connectedCallback()
    void this._load()
    this._teardownDrop = installFileDropZone(this, (files) => void this._upload(files), (active) => { this._dragOver = active })
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._teardownDrop?.()
  }

  async _load({ preserveError = false } = {}) {
    if (!preserveError) this._error = null
    await this._loadCollection('bundles', 'bundles', fetchBundles, data => {
      this._data = data
    })
  }

  render() {
    return html`
      ${this._dragOver ? html`<div class="dropzone">Drop bundles to upload</div>` : nothing}
      <div class="wrap">${adminNavigation('manage-bundles', this._role)}
        <h1 class="sr-only">Bundles</h1>
        <div class="page-intro"><p class="intro">Source bundles for your repositories.</p>${this._localImport.renderAction()}</div>
        ${this._localImport.renderPanel(this._busy || !this._csrf)}
        <section class="upload-panel" aria-label="Upload bundles">
          <div class="upload-copy"><span class="drop-icon" aria-hidden="true">${adminIcon('upload')}</span><span><strong>Upload source bundles</strong><span class="upload-description">Drop source archives anywhere on this page.</span></span></div>
          <div class="upload-controls">${repoPickerTemplate(this._data?.repos, this._repoId, (v) => { this._repoId = v }, 'Repository')}<button type="button" class="drop-browse" ?disabled=${this._busy} @click=${() => pickFiles((files) => void this._upload(files))}>${this._busy ? 'Uploading…' : 'Browse files'}</button></div>
        </section>
        ${this._body()}
      </div>`
  }

  _body() {
    const bundles = Array.isArray(this._data?.bundles) ? this._data.bundles : []
    const unassigned = bundles.filter((bundle) => bundle.repoId == null).length
    const bytes = bundles.reduce((sum, bundle) => sum + (Number.isFinite(bundle.byteSize) ? bundle.byteSize : 0), 0)
    const query = this._query.trim().toLocaleLowerCase()
    const filtered = bundles.filter(bundle => [bundle.filename, bundle.repoFullName, bundle.kind, bundle.uploadedByLogin].filter(Boolean).join(' ').toLocaleLowerCase().includes(query))
    const groups = Map.groupBy(filtered, (bundle) => bundle.repoFullName || 'Unattached')
    return html`<div class="collection-toolbar" role="search"><input type="search" aria-label="Search bundles" placeholder="Search bundles or repositories…" .value=${this._query} @input=${e => { this._query = e.target.value }}></div><div class="section-head"><h2>Stored bundles</h2><span class="summary"><span>${this._data == null ? '… bundles' : `${bundles.length} ${bundles.length === 1 ? 'bundle' : 'bundles'}`}</span><span>${this._data == null ? '…' : formatBytes(bytes)}</span><span class="unassigned">${this._data == null ? '… unattached' : unassigned ? `${unassigned} unattached` : ''}</span></span></div>
      ${this._error ? html`<p class="msg error" role="alert">${this._error}</p>` : nothing}
      <div aria-busy=${this._loading}>${this._data == null ? (this._error ? nothing : loadingRows('Loading bundles…')) : filtered.length > 0 ? html`<div class="bundle-groups">${[...groups].toSorted(([a], [b]) => a === 'Unattached' ? -1 : b === 'Unattached' ? 1 : a.localeCompare(b)).map(([name, items]) => html`<section class="bundle-group"><div class="bundle-group-head"><strong>${name}</strong><span>${items.length} ${items.length === 1 ? 'bundle' : 'bundles'}</span></div><ul class="bundles">${items.map((b) => this._row(b))}</ul></section>`)}</div>` : html`<div class="empty"><strong>${query ? 'No matching bundles' : 'No bundles uploaded yet'}</strong><p>${query ? 'Try another filename or repository.' : 'Drop source archives here or browse files above.'}</p></div>`}</div>`
  }

  _row(b) {
    const when = Number.isFinite(b.uploadedAt) ? new Date(b.uploadedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''
    return html`<li class="bundle-row">
      <span class="identity"><span class="bundle-icon" aria-hidden="true">${BUNDLE_ICON}</span><span class="who">
        <button type="button" class="filename bundle-open" @click=${() => this.dispatchEvent(new CustomEvent('managed-bundle-open', { detail: { id: b.id }, bubbles: true, composed: true }))}>${b.filename}</button>
        <span class="meta"><span class="kind">${b.kind === 'stasis' ? 'Stasis' : 'Sourcemaps'}</span><span>${formatBytes(b.byteSize)}</span><span>${when}</span>${b.uploadedByLogin ? html`<span>@${b.uploadedByLogin}</span>` : nothing}</span>
      </span></span>
      <span class="bundle-location">${b.canChangeRepo === false ? html`<span data-tooltip="Your teams do not grant access to change this repository link">${b.repoFullName ?? 'Attached repository'}</span>` : repoRowSelect(this._data?.repos, b.repoId, (repoId) => this._setRepo(b, repoId))}</span>
      <span class="actions">
        <a class="action" aria-label=${`Download ${b.filename}`} href=${`/api/admin/bundles/${encodeURIComponent(b.id)}`}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8m-3-3 3 3 3-3M3 11v3h10v-3"/></svg></a>
        <button type="button" class="action danger" aria-label=${`Delete ${b.filename}`} ?disabled=${b.canChangeRepo === false} data-tooltip=${b.canChangeRepo === false ? 'Repository access is required to detach or delete this bundle' : 'Delete bundle'} @click=${() => this._delete(b)}>${ADMIN_DELETE_ICON}</button>
      </span>
    </li>`
  }

  async _setRepo(b, repoId) {
    this._error = null
    try {
      await this.appState.mutate(() => setBundleRepo(b.id, repoId, this._csrf), ['bundles', 'repo-impact', 'history', 'scan-sources'])
    } catch (err) {
      this._error = `Couldn't change repo: ${String(err?.message ?? err)}`
    }
    await this._load({ preserveError: true })
  }

  async _upload(files) {
    if (files.length === 0) return
    this._queue.push(...files) // queue first so a drop mid-upload isn't silently lost
    if (this._busy) return // the running drain will pick these up
    this._busy = true
    this._error = null
    try {
      while (this._queue.length > 0) {
        const file = this._queue.shift()
        await this.appState.mutate(() => uploadBundle(file, this._csrf, this._repoId), ['bundles', 'bundle-metadata', 'reports', 'repo-impact', 'history', 'scan-sources'])
      }
    } catch (err) {
      this._queue = [] // fail-fast: drop the rest of the batch (matches the old behaviour)
      this._error = `Upload failed: ${String(err?.message ?? err)}`
    } finally {
      this._busy = false
      await this._load({ preserveError: true })
    }
  }

  async _delete(b) {
    if (!globalThis.confirm?.(`Delete “${b.filename}”? Linked reports will keep their pending link.`)) return
    this._error = null
    try {
      await this.appState.mutate(() => deleteBundle(b.id, this._csrf), ['bundles', 'bundle-metadata', 'reports', 'repo-impact', 'history', 'scan-sources'])
    } catch (err) {
      this._error = `Delete failed: ${String(err?.message ?? err)}`
    }
    await this._load({ preserveError: true })
  }
}
customElements.define('managed-admin-bundles', ManagedAdminBundles)

// Manage supplies its own navigation and authenticated model transport.
class ManagedAdminScans extends ManagedPage {
  static properties = { _source: { state: true }, _error: { state: true } }
  static styles = unsafeCSS(commonStyles)
  constructor() {
    super()
    this._loadModels = (signal, apply) => this.appState.load('models', 'scan models', requestSignal => fetchScanModels(requestSignal, managedFetch), { signal, apply })
    this._source = null
    this._error = null
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
        if (!response.ok) throw new Error(`Report ${report.filename}: HTTP ${response.status}`)
        return { ...report, content: await response.text() }
      }))
      return managedReportSources(data, results.ok ? await results.json() : { bundles: [], results: [] })
    }, { signal: consumerSignal, apply })
  }

  connectedCallback() {
    super.connectedCallback()
    void this._load()
  }

  async _load() {
    this._error = null
    await this._loadCollection('bundles', 'bundles', fetchBundles, data => {
      this._source = managedScanSource(data)
    })
  }

  render() {
    return html`<div class="wrap">${adminNavigation('manage-scans', this._role)}
      ${this._error ? html`<p class="msg error" role="alert">Couldn’t load scan sources: ${this._error} <button type="button" class="btn" @click=${() => void this._load()}>Retry</button></p>` : nothing}
      <deepview-scan-page hide-heading .source=${this._source} .sourceLoading=${this._loading && this._source == null} .loadBundle=${loadManagedScanBundle} .loadModels=${this._loadModels} .loadReportSources=${this._loadReportSources}></deepview-scan-page>
    </div>`
  }
}
customElements.define('managed-admin-scans', ManagedAdminScans)

async function fetchTeams(signal) {
  const res = await managedFetch('/api/admin/teams', { signal, credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// POST a team mutation (create / delete / link / unlink). CSRF via the
// double-submit token. Surfaces 409 (duplicate name) as a friendly word.
async function postTeam(path, csrfToken, body) {
  const headers = { 'content-type': 'application/json' }
  if (csrfToken) headers['x-csrf-token'] = csrfToken
  const res = await managedFetch(path, { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(res.status === 409 ? 'name already taken' : `HTTP ${res.status}`)
}

// Teams — full-view page for admin/manage. Create teams; per team, link repos
// (with an optional subpath) and members (with per-member visibility
// permissions — dependencies / security, both off by default). Own chunk,
// fetches its own teams payload; the host supplies the session.
class ManagedAdminTeams extends ManagedPage {
  static properties = {
    _data: { state: true },
    _error: { state: true },
    _busy: { state: true },
    _renamingId: { state: true },
    _repoChoices: { state: true },
    _memberChoices: { state: true },
  }

  static styles = [unsafeCSS(teamsStyles), unsafeCSS(commonStyles)]

  constructor() {
    super()
    this._data = null
    this._error = null
    this._busy = false
    this._renamingId = null
    this._repoChoices = new Map()
    this._memberChoices = new Map()
  }

  connectedCallback() {
    super.connectedCallback()
    void this._load()
  }

  async _load({ preserveError = false } = {}) {
    if (!preserveError) this._error = null
    await this._loadCollection('teams', 'teams', fetchTeams, data => {
      this._data = data
    })
  }

  // Run a mutation then reload; surfaces failures on the page.
  async _do(fn) {
    if (this._busy) return
    this._busy = true
    this._error = null
    try { await this.appState.mutate(fn, ['teams', 'users', 'history']) } catch (err) { this._error = String(err?.message ?? err) }
    finally { this._busy = false; await this._load({ preserveError: true }) }
  }

  render() {
    return html`<div class="wrap">${adminNavigation('manage-teams', this._role)}
      <h1 class="sr-only">Teams</h1>
      <div class="page-intro"><p class="intro">Group repositories and give members access to the findings they need.</p><span class="result-count">${this._data?.teams?.length ?? '…'} teams</span></div>
      <div class="create-team">
        <div class="create-copy"><strong>Create a team</strong><span>Share the right findings with the right people.</span></div>
        <label class="sr-only" for="new-team-name">New team</label>
        <input id="new-team-name" class="new-name" type="text" placeholder="Team name" maxlength="100" ?disabled=${this._busy}
          @keydown=${(e) => { if (e.key === 'Enter') this._create() }}>
        <button class="btn primary" ?disabled=${this._busy} @click=${() => this._create()}>${ADMIN_PLUS_ICON} Create team</button>
      </div>
      <div aria-busy=${this._loading}>${this._body()}</div>
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
            <span class="team-actions">
              <button class="icon-btn" aria-label=${`Rename ${team.name}`} ?disabled=${this._busy} @click=${() => { this._renamingId = team.id }}>${ADMIN_EDIT_ICON}</button>
              <button class="icon-btn danger" aria-label=${`Delete ${team.name}`} ?disabled=${this._busy} @click=${() => this._deleteTeam(team)}>${ADMIN_DELETE_ICON}</button>
            </span>`}
      </div>
      <div class="team-body">
      <div class="sub">
        <h3 class="sub-title">Repositories <span class="count">${team.repos.length}</span></h3>
        <p class="sub-description">Source repositories included in this team.</p>
        ${team.repos.length === 0 ? html`<p class="muted">No repositories linked.</p>`
          : html`<ul class="links">${team.repos.map((r) => this._repoRow(team, r))}</ul>`}
        ${this._addRepoRow(team)}
      </div>
      <div class="sub">
        <h3 class="sub-title">Members <span class="count">${team.members.length}</span></h3>
        <p class="sub-description"><span>All members can view standard findings.</span><span>Choose who can also view dependencies and security findings.</span></p>
        ${team.members.length === 0 ? html`<p class="muted">No members.</p>`
          : html`<ul class="links">${team.members.map((m) => this._memberRow(team, m))}</ul>`}
        ${this._addMemberRow(team)}
      </div>
      </div>
    </section>`
  }

  _repoRow(team, r) {
    return html`<li class="repo-row">
      ${REPO_ICON}
      <span class="repo-copy"><span class="ln">${r.fullName}</span>${r.path ? html`<span class="path">/${r.path.replace(/^\/+/u, '')}</span>` : nothing}</span>
      <button class="icon-btn danger" aria-label=${`Remove ${r.fullName}${r.path ? `/${r.path}` : ''} from ${team.name}`} ?disabled=${this._busy} @click=${() => this._do(() => postTeam('/api/admin/teams/remove-repo', this._csrf, { teamId: team.id, repoId: r.repoId, path: r.path ?? null }))}>${ADMIN_REMOVE_ICON}</button>
    </li>`
  }

  _addRepoRow(team) {
    const repos = Array.isArray(this._data.repos) ? this._data.repos : []
    if (repos.length === 0) return html`<p class="muted">No selected repositories to link — pick some on “Manage repositories”.</p>`
    return html`<div class="add-row">
      <repository-selector class="add-repo-sel" label=${`Repository to add to ${team.name}`} placeholder="Add repository…" ?disabled=${this._busy}
        .options=${repos.map(repo => ({ value: repo.repoId, label: repo.fullName }))} .value=${this._repoChoices.get(team.id) ?? null}
        @repository-change=${event => { this._repoChoices = new Map(this._repoChoices).set(team.id, event.detail.value) }}></repository-selector>
      <input class="add-repo-path" type="text" placeholder="Path (optional)" aria-label=${`Repository path in ${team.name} (optional)`} maxlength="500" ?disabled=${this._busy}>
      <button class="btn" aria-label=${`Add repository to ${team.name}`} ?disabled=${this._busy || !this._repoChoices.has(team.id)} @click=${(e) => this._addRepo(team, e)}>${ADMIN_PLUS_ICON} Add</button>
    </div>`
  }

  _memberRow(team, m) {
    const perms = Array.isArray(this._data.permissions) ? this._data.permissions : []
    return html`<li class="member-row">
      <span class="member">${adminAvatar(m.userId, m.login)}<span class="ln">${m.login}</span></span>
      <span class="perms">
        ${perms.map((p) => html`<label class="perm">
          <input type="checkbox" .checked=${m[p] === true} ?disabled=${this._busy}
            aria-label=${`${VISIBILITY_PERMISSION_LABELS[p] ?? p} access for ${m.login} in ${team.name}`}
            @change=${(e) => this._togglePerm(team, m, p, e.target.checked)}>
          ${VISIBILITY_PERMISSION_LABELS[p] ?? p}
        </label>`)}
      </span>
      <button class="icon-btn danger" aria-label=${`Remove ${m.login} from ${team.name}`} ?disabled=${this._busy} @click=${() => this._do(() => postTeam('/api/admin/teams/remove-member', this._csrf, { teamId: team.id, userId: m.userId }))}>${ADMIN_REMOVE_ICON}</button>
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
    void this._do(async () => { await postTeam('/api/admin/teams', this._csrf, { name }); if (input) input.value = '' })
  }

  _deleteTeam(team) {
    if (!globalThis.confirm?.(`Delete team “${team.name}”? Its repo + member links are removed.`)) return
    void this._do(() => postTeam('/api/admin/teams/delete', this._csrf, { teamId: team.id }))
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
    void this._do(() => postTeam('/api/admin/teams/rename', this._csrf, { teamId: team.id, name }))
  }

  _addRepo(team, e) {
    const row = e.target.closest('.add-row')
    const repoId = this._repoChoices.get(team.id)
    if (!Number.isSafeInteger(repoId) || repoId <= 0) return
    const path = row?.querySelector('.add-repo-path')?.value ?? ''
    void this._do(async () => {
      await postTeam('/api/admin/teams/set-repo', this._csrf, { teamId: team.id, repoId, path })
      const next = new Map(this._repoChoices)
      next.delete(team.id)
      this._repoChoices = next
      const input = row?.querySelector('.add-repo-path')
      if (input) input.value = ''
    })
  }

  _addMember(team) {
    const userId = this._memberChoices.get(team.id)
    if (!userId || team.members.some(member => member.userId === userId)) return
    void this._do(async () => {
      await postTeam('/api/admin/teams/set-member', this._csrf, { teamId: team.id, userId })
      const next = new Map(this._memberChoices)
      next.delete(team.id)
      this._memberChoices = next
    })
  }

  _togglePerm(team, m, perm, checked) {
    const perms = {}
    for (const p of (this._data.permissions ?? [])) perms[p] = m[p] === true
    perms[perm] = checked
    void this._do(() => postTeam('/api/admin/teams/set-member', this._csrf, { teamId: team.id, userId: m.userId, ...perms }))
  }
}
customElements.define('managed-admin-teams', ManagedAdminTeams)

export { ManagedAdminBundles, ManagedAdminReports, ManagedAdminRepos, ManagedAdminScans, ManagedAdminTeams, ManagedAdminUsers }
