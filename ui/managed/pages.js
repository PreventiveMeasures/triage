import { getPreviewRole, managedFetch } from '../../client/managed/request.js'
// Manage custom elements, registered by the lazy client-managed.js entry.
// Keep application state in the main view bundle; these pages use authenticated
// API requests and composed events to communicate with their host.
import { LitElement, css, html, nothing } from 'lit'
import { unsafeHTML } from 'lit/directives/unsafe-html.js'
import { ROLES } from '../../common/managed/roles.ts'
import { VISIBILITY_PERMISSION_LABELS } from '../../common/managed/permissions.ts'
import { REPORT_LOGOS } from '../view/report-logos.js'
import { BUNDLE_ICON_SVG } from '../view/icons.js'
import '../view/scan-model-picker.js'

async function fetchSession() {
  const res = await managedFetch('/api/auth/session', { credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!res.ok) return null
  const body = await res.json()
  return {
    id: body?.user?.id ?? null,
    role: typeof body?.user?.role === 'string' ? body.user.role : 'none',
    csrfToken: typeof body?.csrfToken === 'string' ? body.csrfToken : null,
  }
}

const ADMIN_PAGE_HEADER_STYLES = css`
  .head { display: flex; align-items: center; gap: .6rem; min-height: 2.1rem; margin-bottom: .55rem; }
  .breadcrumb { display: inline-flex; align-items: center; gap: .35rem; flex: 0 0 auto; }
  .breadcrumb-manage { padding: .22rem .35rem; border: 1px solid transparent; border-radius: 5px; color: var(--muted); background: transparent; font: inherit; font-size: .82rem; cursor: pointer; }
  .breadcrumb-manage:hover { color: var(--text); background: var(--surface-active); border-color: var(--border); }
  .breadcrumb-manage:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .breadcrumb-separator { color: var(--muted); font-size: 1rem; }
  .head h1 { margin: 0; font-size: 1.65rem; font-weight: 600; letter-spacing: -.035em; }
`

const SCAN_MODE_ICONS = {
  dependencies: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4" cy="8" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="12" cy="12" r="2"/><path d="M6 8h2M10.2 5.3 6 7.3M10.2 10.7 6 8.7"/></svg>`,
  code: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5.5 3-3 5 3 5M10.5 3l3 5-3 5M9 2.5 7 13.5"/></svg>`,
  agentic: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 1.8.8 4.4L12.5 8l-3.7 1.8L8 14.2l-.8-4.4L3.5 8l3.7-1.8Z"/><path d="m13 2 .25 1.25L14.5 3.5 13.25 3.25 13 2ZM3 11.5l.2 1 .95.2-.95.2-.2 1-.2-1-.95-.2.95-.2Z"/></svg>`,
  report: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 1.8h5l3 3V14H4zM9 1.8V5h3M6 8h4M6 10.5h4"/></svg>`,
}

function adminBackButton() {
  return html`<span class="breadcrumb"><button type="button" class="breadcrumb-manage" @click=${() => {
    document.dispatchEvent(new CustomEvent('managed-admin-navigate', {
      detail: { view: 'manage' }, bubbles: true, composed: true,
    }))
  }}>Manage</button><span class="breadcrumb-separator" aria-hidden="true">›</span></span>`
}

function openAdminPage(view) {
  document.dispatchEvent(new CustomEvent('managed-admin-navigate', {
    detail: { view }, bubbles: true, composed: true,
  }))
}

const ADMIN_PEOPLE_STYLES = css`
  :host { display: block; padding: clamp(1.5rem, 4vw, 2.5rem) clamp(1rem, 4vw, 2.5rem); color: var(--text); container-type: inline-size; }
  * { box-sizing: border-box; }
  .wrap { max-width: 68rem; margin: 0 auto; }
  .head { gap: .65rem; margin-bottom: .45rem; }
  h1 { font-size: 1.65rem; font-weight: 600; letter-spacing: -.035em; }
  .intro { margin: 0 0 1.6rem; color: var(--muted); font-size: .85rem; line-height: 1.5; }
  .count { display: inline-grid; place-items: center; min-width: 1.45rem; height: 1.45rem; padding: 0 .4rem; border-radius: 5px; background: var(--surface-active); color: var(--muted); font-size: .72rem; font-weight: 500; font-variant-numeric: tabular-nums; }
  button, input, select { font: inherit; }
  button, select, input[type="checkbox"] { cursor: default; }
  button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  input:not([type="checkbox"]), select { min-width: 0; height: 2rem; padding: .3rem .55rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font-size: .8rem; }
  input::placeholder { color: var(--muted); }
  input[type="checkbox"] { margin: 0; width: .85rem; height: .85rem; accent-color: var(--accent); }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: .35rem; height: 2rem; padding: 0 .7rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font-size: .78rem; font-weight: 500; white-space: nowrap; }
  .btn:hover:not(:disabled) { background: var(--surface-active); border-color: var(--muted); }
  .btn.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
  .btn.primary:hover:not(:disabled) { filter: brightness(1.1); }
  button:disabled, select:disabled { opacity: .5; }
  .icon-btn { display: inline-grid; place-items: center; flex: 0 0 auto; width: 1.8rem; height: 1.8rem; padding: 0; border: 1px solid transparent; border-radius: 5px; color: var(--muted); background: transparent; }
  .icon-btn:hover:not(:disabled) { color: var(--text); background: var(--surface-active); }
  .icon-btn.danger:hover:not(:disabled) { color: var(--critical, #e5534b); background: rgb(from var(--critical, #e5534b) r g b / .1); }
  .icon-btn svg, .btn svg { width: .9rem; height: .9rem; }
  .avatar { position: relative; display: inline-grid; place-items: center; flex: 0 0 auto; width: 2rem; height: 2rem; border-radius: 50%; overflow: hidden; background: var(--surface-active); color: var(--muted); font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif; font-size: .8rem; font-weight: 600; user-select: none; }
  .avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .avatar img.broken { display: none; }
  .msg { margin: 1rem 0; color: var(--muted); font-size: .85rem; line-height: 1.5; }
  .msg.error { color: var(--critical, #e5534b); }
  @container (max-width: 32rem) { .intro { margin-left: 0; } }
`

function adminAvatar(id, login) {
  return html`<span class="avatar" aria-hidden="true">
    <span>${(login?.[0] ?? '?').toUpperCase()}</span>
    ${getPreviewRole() ? nothing : html`<img alt="" src=${`/api/avatar/${encodeURIComponent(id)}`} @error=${(e) => e.currentTarget.classList.add('broken')}>`}
  </span>`
}

const ADMIN_EDIT_ICON = html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 2 4 4-8 8H2v-4l8-8Zm-1 1 4 4"/></svg>`
const ADMIN_DELETE_ICON = html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4h12M6 4V2h4v2M4 4l.6 10h6.8L12 4M6.5 7v4m3-4v4"/></svg>`
const ADMIN_REMOVE_ICON = html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg>`
const ADMIN_PLUS_ICON = html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>`
const ADMIN_ROLE_LABELS = { admin: 'Admin', manage: 'Manager', triage: 'Triage', view: 'Viewer', none: 'No access' }
const ADMIN_ROLE_DESCRIPTIONS = {
  admin: 'Manage workspace access and teams',
  manage: 'Manage content and scans',
  triage: 'Review and triage findings',
  view: 'Read-only access',
  none: 'No workspace access',
}

class ManagedAdminHome extends LitElement {
  static properties = { _role: { state: true } }

  static styles = css`
    :host { display: block; padding: clamp(1.5rem, 5vw, 3rem) clamp(1rem, 4vw, 2.5rem); color: var(--text); }
    .wrap { max-width: 68rem; margin: 0 auto; }
    h1 { margin: 0; font-size: clamp(1.7rem, 4vw, 2.35rem); font-weight: 600; letter-spacing: -.04em; }
    .intro { max-width: 38rem; margin: .55rem 0 1.7rem; color: var(--muted); line-height: 1.5; }
    .pages { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .55rem; margin: 0; padding: 0; list-style: none; }
    .pages li:last-child { grid-column: 1 / -1; }
    .page {
      display: flex; align-items: center; gap: .8rem; width: 100%;
      padding: .85rem 1rem; color: var(--text); background: var(--surface);
      border: 1px solid var(--border); border-radius: 9px; text-align: left;
      font: inherit; cursor: default; transition: background .12s, border-color .12s;
    }
    .page:hover { background: var(--surface-active); border-color: var(--muted); }
    .page:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .page-icon { display: grid; place-items: center; width: 2rem; height: 2rem; flex: 0 0 auto; color: var(--accent); background: rgb(from var(--accent) r g b / .1); border-radius: 6px; }
    .page-icon svg { width: 1.05rem; height: 1.05rem; }
    .page-icon .file-icon { width: 1.15rem; height: 1.15rem; }
    .page-icon .brand-deepview { --brand-bg: #2563eb; --brand-fg: #fff; }
    .page-icon .brand-claude { --brand-bg: #d97757; --brand-fg: #fff; }
    .page-icon .brand-codex { --brand-bg: #fff; --brand-fg: #000; }
    .page-icon .brand-vercel { --brand-bg: #000; --brand-fg: #fff; }
    .page-icon .brand-piolium { --brand-bg: #fbb829; --brand-fg: #1c1b19; }
    .page-icon .file-icon .bg { fill: var(--brand-bg); }
    .page-icon .file-icon .fg { fill: var(--brand-fg); }
    .page-icon .file-icon:is(.brand-codex, .brand-vercel) .bg { stroke: var(--brand-fg); stroke-width: .5; }
    .page-copy { display: flex; min-width: 0; flex-direction: column; gap: .15rem; }
    .page-copy strong { font-size: .9rem; font-weight: 600; }
    .page-copy span { color: var(--muted); font-size: .76rem; }
    .arrow { width: 1rem; height: 1rem; margin-left: auto; color: var(--muted); flex: 0 0 auto; }
    @media (max-width: 42rem) { .pages { grid-template-columns: 1fr; } .pages li:last-child { grid-column: auto; } }
  `

  constructor() {
    super()
    this._role = null
  }

  connectedCallback() {
    super.connectedCallback()
    void fetchSession().then((session) => {
      this._role = session?.role ?? 'none'
      return session
    })
  }

  render() {
    const makePage = (view, title, text, icon) => ({ view, title, text, icon })
    const rows = [
      [this._role === 'admin' ? makePage('admin-users', 'Users', 'Review accounts and assign roles.', 'users') : null, this._role === 'admin' ? makePage('manage-teams', 'Teams', 'Organize repositories, members, and access.', 'team') : null],
      [this._role === 'admin' ? makePage('manage-repos', 'Repositories', 'Connect and select source repositories.', 'repo') : null, makePage('manage-bundles', 'Bundles', 'Manage source bundles and sourcemaps.', 'bundle')],
      [['admin', 'manage'].includes(this._role) ? makePage('manage-scans', 'Scans', 'Run and monitor scans from stored bundles.', 'scan') : null, makePage('manage-reports', 'Reports', 'Review reports stored for your teams.', 'report')],
      [makePage('manage-history', 'History', 'Review workspace activity and triage changes.', 'history')],
    ]
    const intro = 'Choose a page.'
    return html`<div class="wrap">
      <h1>Manage</h1>
      <p class="intro">${intro}</p>
      <nav aria-label="Management pages"><ul class="pages">
        ${rows.flat().filter(Boolean).map((page) => html`<li><button type="button" class="page" @click=${() => openAdminPage(page.view)}>
          <span class="page-icon" aria-hidden="true">${this._icon(page.icon)}</span>
          <span class="page-copy"><strong>${page.title}</strong><span>${page.text}</span></span>
          <svg class="arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>
        </button></li>`)}
      </ul></nav>
    </div>`
  }

  _icon(kind) {
    if (kind === 'bundle') return unsafeHTML(BUNDLE_ICON_SVG)
    const paths = {
      users: 'M3.25 7.25a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Zm9.5 0a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5ZM1 13.25c0-1.8 1.1-3 2.75-3s2.75 1.2 2.75 3M9.5 13.25c0-1.8 1.1-3 2.75-3S15 11.45 15 13.25M8 8.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm-3 5c0-2 1.2-3.5 3-3.5s3 1.5 3 3.5',
      repo: 'M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12.5v-9Zm3 2h6m-6 3h6m-6 3h3',
      report: 'M4 1.5h5l3 3v10H4v-13Zm5 0v3h3m-6 3h4m-4 2h4m-4 2h3',
      bundle: 'm8 1 5 2.8v8.4L8 15l-5-2.8V3.8L8 1Zm-5 2.8 5 2.8 5-2.8M8 6.6V15',
      history: 'M8 2a6 6 0 1 0 6 6M8 4.5V8l2.25 1.5M10.5 2H14v3.5',
      team: 'M8 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm-4 5c0-2 1.7-3 4-3s4 1 4 3M2 7h2m8 0h2M8 1v2m0 9v2',
      scan: 'M3 3.5h10v9H3zM5.5 6h5M5.5 8h5M5.5 10h3',
    }
    return html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d=${paths[kind] ?? paths.report}/></svg>`
  }
}
customElements.define('managed-admin-home', ManagedAdminHome)

async function fetchHistory() {
  const res = await managedFetch('/api/admin/history', { credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  if (!Array.isArray(body?.history)) throw new Error('No history returned')
  return body.history
}

async function fetchAccessibleReportIds() {
  try {
    const res = await managedFetch('/api/teams', { credentials: 'same-origin', headers: { accept: 'application/json' } })
    if (!res.ok) return new Set()
    const body = await res.json()
    return new Set((Array.isArray(body?.teams) ? body.teams : []).flatMap((team) => Array.isArray(team.reports) ? team.reports.map((report) => report.id) : []))
  } catch { return new Set() }
}

class ManagedAdminHistory extends LitElement {
  static properties = { _history: { state: true }, _role: { state: true }, _allowedReports: { state: true }, _error: { state: true }, _filter: { state: true }, _query: { state: true } }

  static styles = [ADMIN_PAGE_HEADER_STYLES, css`
    :host { display: block; min-height: 100%; padding: clamp(1.5rem, 4vw, 2.5rem) clamp(1rem, 4vw, 2.5rem); color: var(--text); }
    * { box-sizing: border-box; }
    .wrap { max-width: 68rem; margin: 0 auto; }
    .intro { margin: 0 0 1rem; color: var(--muted); font-size: .82rem; line-height: 1.5; }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: .55rem; margin: 0 0 .8rem; }
    .toolbar input, .toolbar select { height: 2rem; padding: .28rem .55rem; border: 1px solid var(--border); border-radius: 5px; color: var(--text); background: var(--bg); font: inherit; font-size: .74rem; }
    .toolbar input { flex: 1 1 20rem; min-width: 12rem; }
    .toolbar select { flex: 0 1 10rem; min-width: 9rem; }
    .history { overflow: hidden; border: 1px solid var(--border); border-radius: 9px; background: var(--surface); }
    .row { display: grid; grid-template-columns: 4.75rem minmax(8rem, 10rem) minmax(0, 1fr) auto; align-items: center; gap: .7rem; padding: .52rem .8rem; min-height: 2.45rem; }
    .row + .row { border-top: 1px solid var(--border); }
    .kind { width: fit-content; padding: .14rem .38rem; border: 1px solid var(--border); border-radius: 999px; color: var(--muted); font-size: .62rem; font-weight: 600; text-transform: capitalize; }
    .kind.triage { color: var(--accent); border-color: rgb(from var(--accent) r g b / .35); background: rgb(from var(--accent) r g b / .08); }
    .actor { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: .72rem; }
    .copy { display: grid; grid-template-columns: minmax(9rem, auto) minmax(0, 1fr); min-width: 0; align-items: baseline; gap: .45rem; }
    .action { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .76rem; }
    .detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: .67rem; }
    time { color: var(--muted); font-size: .68rem; white-space: nowrap; }
    .empty, .msg { margin: 0; padding: 1.2rem; color: var(--muted); font-size: .8rem; line-height: 1.5; }
    .msg.error { color: var(--critical, #c00); }
    @media (max-width: 46rem) { .row { grid-template-columns: 4.5rem 8rem minmax(0, 1fr) auto; } .copy { grid-template-columns: minmax(8rem, auto) minmax(0, 1fr); } }
    @media (max-width: 38rem) { .row { grid-template-columns: auto minmax(0, 1fr) auto; } .row .actor { grid-column: 2; grid-row: 2; } .row .copy { grid-column: 2; grid-row: 1; } time { grid-column: 3; grid-row: 1 / 3; } }
  `]

  constructor() {
    super()
    this._history = null
    this._role = null
    this._allowedReports = null
    this._error = null
    this._filter = 'all'
    this._query = ''
    this._onActorFilter = (event) => {
      const actor = event.detail?.actor
      if (typeof actor !== 'string' || actor.length === 0) return
      this._query = actor
      this._filter = 'all'
    }
  }

  connectedCallback() {
    super.connectedCallback()
    document.addEventListener('managed-history-filter', this._onActorFilter)
    void this._load()
  }

  disconnectedCallback() {
    document.removeEventListener('managed-history-filter', this._onActorFilter)
    super.disconnectedCallback()
  }

  async _load() {
    try {
      const session = await fetchSession()
      this._role = session?.role ?? 'none'
      this._history = await fetchHistory()
      this._allowedReports = this._role === 'manage' ? await fetchAccessibleReportIds() : null
    } catch (err) {
      this._error = String(err?.message ?? err)
    }
  }

  render() {
    const all = Array.isArray(this._history) ? this._history : []
    const history = this._role === 'manage'
      ? all.filter((entry) => entry.kind === 'triage' && (this._allowedReports == null || this._allowedReports.has(entry.reportId)))
      : all
    const query = this._query.trim().toLocaleLowerCase()
    const searched = query.length === 0 ? history : history.filter((entry) => historySearchText(entry).includes(query))
    const filtered = this._filter === 'all' ? searched : searched.filter((entry) => entry.kind === this._filter)
    return html`<div class="wrap">
      <div class="head">${adminBackButton()}<h1>History</h1>${this._history ? html`<span class="count">${filtered.length}</span>` : nothing}</div>
      <p class="intro">${this._role === 'admin' ? 'All workspace actions, including uploads, access changes, scans, and triage.' : 'Triage history for reports you can access.'}</p>
      ${this._history == null ? nothing : html`<div class="toolbar" role="search"><input type="search" aria-label="Search history" placeholder="Search actions, users, repositories, reports…" .value=${this._query} @input=${(event) => { this._query = event.target.value }}><select aria-label="Filter history by type" .value=${this._filter} @change=${(event) => { this._filter = event.target.value }}><option value="all">All activity</option><option value="triage">Triage</option><option value="visibility">Visibility</option><option value="upload">Uploads</option><option value="scan">Scans</option></select></div>`}
      ${this._error ? html`<p class="msg error">Couldn’t load history: ${this._error}</p>` : this._history == null ? html`<p class="msg">Loading…</p>` : filtered.length === 0 ? html`<div class="history"><p class="empty">No history available yet.</p></div>` : html`<div class="history" aria-label="Workspace history">${filtered.map((entry) => this._row(entry))}</div>`}
    </div>`
  }

  _row(entry) {
    const detail = [entry.repo ?? entry.repository, entry.report, entry.finding].filter(Boolean).join(' · ')
    return html`<div class="row"><span class=${`kind ${entry.kind ?? ''}`}>${entry.kind ?? 'activity'}</span><span class="actor">${entry.actor ?? entry.user ?? 'Unknown user'}</span><span class="copy"><span class="action">${entry.action ?? 'updated workspace data'}</span>${detail ? html`<span class="detail">${detail}</span>` : nothing}</span><time>${entry.when ?? ''}</time></div>`
  }
}
customElements.define('managed-admin-history', ManagedAdminHistory)

function historySearchText(entry) {
  return Object.entries(entry ?? {}).flatMap(([key, value]) => {
    if (value == null) return []
    if (typeof value === 'object') return [key, JSON.stringify(value)]
    return [key, String(value)]
  }).join(' ').toLocaleLowerCase()
}

async function fetchUsers() {
  const res = await managedFetch('/api/admin/users', { credentials: 'same-origin', headers: { accept: 'application/json' } })
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

class ManagedAdminUsers extends LitElement {
  static properties = {
    _users: { state: true },
    _teams: { state: true },
    _error: { state: true },
  }

  static styles = [ADMIN_PAGE_HEADER_STYLES, ADMIN_PEOPLE_STYLES, css`
    .wrap { max-width: 68rem; margin: 0 auto; }
    .intro { margin-bottom: 1rem; font-size: .78rem; }
    .directory { border: 1px solid var(--border); border-radius: 9px; overflow: hidden; background: var(--surface); }
    .list-head, .users li { display: grid; grid-template-columns: minmax(12rem, 1fr) minmax(15rem, 1.15fr) 6.4rem 6.8rem 7rem; gap: .75rem; padding: .45rem .7rem; align-items: center; }
    .list-head { color: var(--muted); font-size: .62rem; font-weight: 500; border-bottom: 1px solid var(--border); }
    .users { list-style: none; margin: 0; padding: 0; }
    .users li + li { border-top: 1px solid var(--border); }
    .person { display: flex; align-items: center; gap: .5rem; min-width: 0; }
    .avatar { width: 1.65rem; height: 1.65rem; font-size: .65rem; }
    .who { display: grid; gap: .05rem; min-width: 0; }
    .name { display: flex; align-items: center; gap: .35rem; font-size: .78rem; font-weight: 500; }
    .name-text, .login { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .login { color: var(--muted); font-size: .65rem; }
    .last-seen, .last-activity { display: grid; gap: .08rem; color: var(--muted); font-size: .61rem; font-variant-numeric: tabular-nums; }
    .last-seen time, .last-activity time { color: var(--text); }
    .activity-link { display: block; min-width: 0; padding: .15rem .2rem; border: 0; border-radius: 4px; color: inherit; background: transparent; text-align: left; }
    .activity-link:hover { color: var(--accent); background: rgb(from var(--accent) r g b / .08); }
    .you { padding: .05rem .35rem; border-radius: 4px; color: var(--accent); background: rgb(from var(--accent) r g b / .1); font-size: .65rem; font-weight: 500; }
    .memberships { display: grid; gap: .18rem; min-width: 0; }
    .team-access { display: flex; align-items: center; justify-content: flex-start; gap: .5rem; min-width: 0; color: var(--muted); font-size: .64rem; line-height: 1.35; }
    .team-access strong { color: var(--text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .team-perms { display: inline-flex; gap: .3rem; white-space: nowrap; }
    .permission-granted { color: var(--accent); }
    .permission-denied { color: var(--critical, #e5534b); }
    .no-team { color: var(--muted); font-size: .67rem; }
    .access { display: flex; align-items: center; min-width: 0; }
    .role { width: 100%; height: 1.7rem; font-size: .72rem; }
    .self-note { margin: .7rem 0; color: var(--muted); font-size: .73rem; }
    @container (max-width: 46rem) {
      .list-head, .users li { grid-template-columns: minmax(10rem, 1fr) minmax(11rem, 1fr) 5.5rem 5.7rem 6.2rem; gap: .45rem; padding-left: .55rem; padding-right: .55rem; }
      .last-seen, .last-activity { font-size: .57rem; }
    }
    @container (max-width: 33rem) {
      .list-head { display: none; }
      .users li { grid-template-columns: minmax(0, 1fr) 6.2rem; gap: .3rem .6rem; }
      .memberships { grid-column: 1 / -1; grid-row: 3; padding-left: 2.15rem; }
      .last-seen { grid-column: 1; grid-row: 2; padding-left: 2.15rem; display: flex; flex-wrap: wrap; gap: .3rem; }
      .last-activity { grid-column: 1; grid-row: 4; padding-left: 2.15rem; display: flex; flex-wrap: wrap; gap: .3rem; }
      .activity-link { grid-column: 1; grid-row: 4; padding-left: 2rem; }
      .access { grid-column: 2; grid-row: 1 / 3; }
    }
  `]

  constructor() {
    super()
    this._users = null
    this._teams = null
    this._error = null
    this._me = null
    this._csrf = null
  }

  connectedCallback() {
    super.connectedCallback()
    void this._load()
  }

  async _load() {
    this._error = null
    this._users = null
    try {
      const [session, users, teamData] = await Promise.all([fetchSession(), fetchUsers(), fetchTeams()])
      this._me = session?.id ?? null
      this._csrf = session?.csrfToken ?? null
      this._users = users
      this._teams = Array.isArray(teamData?.teams) ? teamData.teams : []
    } catch (err) {
      this._error = String(err?.message ?? err)
    }
  }

  render() {
    return html`<div class="wrap">
      <div class="head">${adminBackButton()}<h1>Users</h1>${this._users ? html`<span class="count">${this._users.length}</span>` : nothing}</div>
      <p class="intro">Manage workspace access and roles.</p>
      ${this._error == null
        ? (this._users == null ? html`<p class="msg">Loading…</p>` : this._list())
        : html`<p class="msg error">Couldn't load users: ${this._error}</p>`}
    </div>`
  }

  _list() {
    if (this._users.length === 0) return html`<p class="msg">No users yet.</p>`
    return html`<div class="directory">
      <div class="list-head" aria-hidden="true"><span>Account</span><span>Team access</span><span>Last seen</span><span>Last activity</span><span>Role</span></div>
      <ul class="users">${this._users.map((u) => this._row(u))}</ul>
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
          return html`<span class="team-access"><strong>${team.name}</strong><span class="team-perms">${['dependencies', 'security'].map((permission) => html`<span class=${member[permission] === true ? 'permission-granted' : 'permission-denied'}>${member[permission] === true ? '+' : '−'} ${permission === 'dependencies' ? 'Deps' : 'Security'}</span>`)}</span></span>`
        })}
      </span>
      <span class="last-seen" aria-label=${userTimeLabel(u.lastSeenAt)}>${userTime(u.lastSeenAt)}</span>
      <button type="button" class="activity-link" aria-label=${`Show activity by ${u.login}`} @click=${() => this._showActivity(u.login)}><span class="last-activity" aria-label=${`Last activity ${userTimeLabel(userActivityAt(u)).replace(/^Last seen /u, '')}`}>${userTime(userActivityAt(u))}</span></button>
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
      await setRole(u.id, role, this._csrf)
      u.role = role
    } catch (err) {
      console.warn('admin: set role failed:', err)
      selectEl.value = prev
    }
    this.requestUpdate()
  }

  _showActivity(login) {
    document.dispatchEvent(new CustomEvent('managed-admin-navigate', {
      detail: { view: 'manage-history', actor: login }, bubbles: true, composed: true,
    }))
  }
}
customElements.define('managed-admin-users', ManagedAdminUsers)

// The connected list is served from stored configuration; discovery runs only
// for the installed/public pickers. Both responses are searched and paged by the server.
async function fetchRepositories(scope, query, page, signal) {
  const params = new URLSearchParams({ scope, q: query, page: String(page), limit: '20' })
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

// GitHub repo glyph (book-with-bookmark), tinted via currentColor.
const REPO_ICON = html`<svg class="repo-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
  <path d="M2 2.75A2.75 2.75 0 0 1 4.75 0h7.5a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75H4.5a1 1 0 0 0 0 2h8a.75.75 0 0 1 0 1.5h-8A2.5 2.5 0 0 1 2 13V2.75Zm2.75-.25a1.25 1.25 0 0 0-1.25 1.25v7.32c.317-.114.66-.07 1 .18V2.5h-.5a.25.25 0 0 0 .75 0Zm6.75 0H5.5v8.5h6V2.5Z"/>
</svg>`

// Only the connected set loads on entry. Private/public discovery is opt-in,
// and each connected repository has its own page for configuration.
class ManagedAdminRepos extends LitElement {
  static properties = {
    _data: { state: true },
    _error: { state: true },
    _actionError: { state: true },
    _scope: { state: true },
    _query: { state: true },
    _page: { state: true },
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

  static styles = [ADMIN_PAGE_HEADER_STYLES, ADMIN_PEOPLE_STYLES, css`
    .wrap { max-width: 68rem; margin: 0 auto; }
    .head { flex-wrap: wrap; }
    .head h1 { overflow-wrap: anywhere; }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin: 1.25rem 0 .85rem; }
    .search { flex: 1 1 14rem; max-width: 25rem; margin-right: auto; }
    .search input { width: 100%; }
    .owners { display: grid; gap: 1rem; }
    .owner-head { display: flex; align-items: center; gap: .5rem; margin: 0 0 .35rem; padding-left: .7rem; color: var(--muted); font-size: .72rem; font-weight: 500; }
    .owner-icon { display: grid; place-items: center; width: 1.3rem; height: 1.3rem; border-radius: 4px; background: var(--surface-active); text-transform: uppercase; font-size: .65rem; }
    .repos { margin: 0; padding: 0; list-style: none; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface); }
    .repos li + li { border-top: 1px solid var(--border); }
    .repo-row { display: flex; align-items: center; gap: .65rem; width: 100%; min-height: 2.65rem; padding: .38rem .7rem; text-align: left; }
    button.repo-row { border: 0; background: transparent; color: var(--text); cursor: default; }
    button.repo-row:hover { background: var(--surface-active); }
    button.repo-row:focus-visible { outline-offset: -2px; }
    .repo-icon { width: 1rem; height: 1rem; flex: 0 0 auto; color: var(--muted); }
    .repo-copy { display: flex; align-items: baseline; gap: .55rem; flex: 1; min-width: 0; }
    .repo-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .8rem; font-weight: 500; }
    .repo-meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: .68rem; }
    .repo-meta::before { content: '·'; margin-right: .55rem; color: var(--border-strong, var(--muted)); }
    .arrow { width: 1rem; height: 1rem; flex: 0 0 auto; color: var(--muted); }
    .connected { display: inline-flex; align-items: center; gap: .25rem; flex: 0 0 auto; color: var(--muted); font-size: .68rem; white-space: nowrap; }
    .connected svg { width: .85rem; height: .85rem; }
    .access-note { display: flex; align-items: center; gap: .85rem; padding: .85rem 1rem; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
    .access-note p { flex: 1; margin: 0; color: var(--muted); font-size: .78rem; line-height: 1.5; }
    a.btn { color: var(--text); text-decoration: none; cursor: default; }
    .empty { padding: 2.5rem 1rem; border: 1px solid var(--border); border-radius: 8px; text-align: center; }
    .empty strong { display: block; margin-bottom: .4rem; font-size: .9rem; font-weight: 500; }
    .empty p { margin: 0; color: var(--muted); font-size: .8rem; }
    .loading { min-height: 8rem; display: grid; place-items: center; color: var(--muted); font-size: .8rem; }
    .pagination { display: flex; align-items: center; gap: .5rem; margin-top: .85rem; }
    .pagination span { margin-right: auto; color: var(--muted); font-size: .72rem; font-variant-numeric: tabular-nums; }
    .section { margin-top: 1.5rem; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface); }
    .section h2 { margin: 0; padding: .8rem 1rem; border-bottom: 1px solid var(--border); font-size: .85rem; font-weight: 500; }
    .settings-row { display: flex; align-items: center; gap: 1rem; padding: 1rem; }
    .settings-copy { flex: 1; min-width: 0; }
    .settings-copy strong { font-size: .83rem; font-weight: 500; }
    .settings-copy p { margin: .25rem 0 0; color: var(--muted); font-size: .76rem; line-height: 1.5; }
    .settings-row + .settings-row { border-top: 1px solid var(--border); }
    .btn.danger { color: var(--critical, #e5534b); }
    .error { color: var(--critical, #e5534b); }
    .status-line { display: inline-flex; align-items: center; gap: .35rem; color: var(--muted); font-size: .72rem; }
    .status-line.inactive { color: var(--warning, #d19a24); }
    .data-section { margin-top: 1.5rem; }
    .data-section h2 { margin: 0 0 .5rem; font-size: .85rem; font-weight: 500; }
    .data-list { margin: 0; padding: 0; list-style: none; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .data-list li { display: flex; align-items: baseline; gap: .5rem; padding: .5rem .75rem; font-size: .75rem; }
    .data-list li + li { border-top: 1px solid var(--border); }
    .data-list strong { min-width: 0; overflow-wrap: anywhere; font-weight: 500; }
    .data-list span { margin-left: auto; color: var(--muted); font-size: .68rem; white-space: nowrap; }
    .data-empty { margin: 0; color: var(--muted); font-size: .75rem; }
    .dialog-backdrop { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: 1rem; background: rgb(0 0 0 / .65); }
    .dialog { width: min(40rem, 100%); max-height: min(42rem, calc(100vh - 2rem)); overflow: auto; padding: 1.25rem; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); box-shadow: 0 1rem 3rem rgb(0 0 0 / .35); }
    .dialog.small { width: min(28rem, 100%); }
    .dialog h2 { margin: 0; font-size: 1.05rem; font-weight: 600; }
    .dialog-copy { margin: .55rem 0 1rem; color: var(--muted); font-size: .78rem; line-height: 1.5; }
    .dialog-data { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; margin: 0 0 1rem; }
    .dialog-data section { min-width: 0; padding: .65rem; border: 1px solid var(--border); border-radius: 7px; }
    .dialog-data h3 { margin: 0 0 .4rem; font-size: .72rem; font-weight: 600; }
    .dialog-data ul { max-height: 9rem; overflow: auto; margin: 0; padding-left: 1rem; color: var(--muted); font-size: .7rem; }
    .dialog-data li { margin: .2rem 0; overflow-wrap: anywhere; }
    .confirm-line { display: flex; align-items: flex-start; gap: .5rem; margin: .7rem 0; color: var(--text); font-size: .76rem; line-height: 1.4; }
    .confirm-line input { flex: 0 0 auto; margin-top: .15rem; accent-color: var(--accent); }
    .confirm-name { width: 100%; margin-top: .15rem; padding: .45rem .55rem; border: 1px solid var(--border); border-radius: 5px; background: var(--bg); color: var(--text); font: inherit; font-size: .78rem; }
    .dialog-actions { display: flex; justify-content: flex-end; gap: .5rem; margin-top: 1rem; }
    .dialog-actions .danger { color: var(--critical, #e5534b); border-color: rgb(from var(--critical, #e5534b) r g b / .4); }
    @container (max-width: 35rem) {
      .intro { margin-left: 0; }
      .search { flex-basis: 100%; max-width: none; }
      .access-note, .settings-row { flex-wrap: wrap; }
      .access-note p, .settings-copy { flex-basis: 100%; }
      .head h1 { font-size: 1.35rem; }
      .repo-copy { gap: .35rem; }
      .repo-meta { max-width: 45%; }
      .dialog-data { grid-template-columns: 1fr; }
    }
  `]

  constructor() {
    super()
    this._data = null
    this._error = null
    this._actionError = null
    this._csrf = null
    this._scope = 'connected'
    this._query = ''
    this._page = 1
    this._loading = true
    this._busy = null
    this._detail = null
    this._impact = null
    this._impactLoading = false
    this._removeOpen = false
    this._acknowledge = false
    this._deleteTriage = false
    this._confirmName = ''
    this._request = null
    this._impactRequest = null
    this._searchTimer = null
  }

  connectedCallback() {
    super.connectedCallback()
    void this._load()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._request?.abort()
    this._impactRequest?.abort()
    clearTimeout(this._searchTimer)
  }

  async _load() {
    this._request?.abort()
    const request = new AbortController()
    this._request = request
    this._loading = true
    this._error = null
    try {
      const [session, data] = await Promise.all([
        this._csrf ? null : fetchSession(),
        fetchRepositories(this._scope, this._query, this._page, request.signal),
      ])
      if (request.signal.aborted) return
      if (session) this._csrf = session.csrfToken
      this._data = data
      // Removing the last item on a page can move the last page backwards.
      const lastPage = Math.max(1, Math.ceil(data.total / 20))
      if (this._page > lastPage) {
        this._page = lastPage
        void this._load()
      }
    } catch (err) {
      if (!request.signal.aborted) this._error = String(err?.message ?? err)
    } finally {
      if (this._request === request) this._loading = false
    }
  }

  _open(scope) {
    clearTimeout(this._searchTimer)
    this._scope = scope
    this._query = ''
    this._page = 1
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

  _search(value) {
    this._query = value
    this._page = 1
    this._request?.abort()
    clearTimeout(this._searchTimer)
    this._loading = true
    this._searchTimer = setTimeout(() => { void this._load() }, 200)
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
        if (this._detail) { this._detail = null; this._actionError = null }
        else this._open('connected')
      }}>Repositories</button>
      <span class="breadcrumb-separator" aria-hidden="true">›</span>
    </span>`
  }

  _openDetail(repo) {
    this._detail = repo
    this._actionError = null
    this._impact = null
    this._removeOpen = false
    this._acknowledge = false
    this._deleteTriage = false
    this._confirmName = ''
    this._impactLoading = true
    this._impactRequest?.abort()
    const request = new AbortController()
    this._impactRequest = request
    void fetchRepositoryImpact(repo.id, request.signal).then((impact) => {
      if (!request.signal.aborted && this._impactRequest === request) this._impact = impact
      return impact
    }).catch((err) => {
      if (!request.signal.aborted) this._actionError = `Couldn't load repository data: ${err?.message ?? err}`
    }).finally(() => {
      if (this._impactRequest === request) this._impactLoading = false
    })
  }

  render() {
    if (this._detail) return this._detailPage(this._detail)
    const connected = this._scope === 'connected'
    const title = connected ? 'Repositories' : `Add ${this._scope} repository`
    return html`<div class="wrap">
      <div class="head">
        ${connected ? adminBackButton() : this._back()}
        <h1>${title}</h1>
        ${connected && this._data ? html`<span class="count">${this._data.connectedCount} connected</span>` : nothing}
      </div>
      <p class="intro">${connected
        ? 'Manage connected repositories and their settings.'
        : this._scope === 'installed'
          ? 'Choose a repository the GitHub App can read. Installed repositories can be public or private.'
          : 'Choose a public repository your GitHub account is involved with. Random public repositories are not listed.'}</p>
      ${!connected && this._scope === 'installed' ? html`<div class="access-note">
        <p>Installed repositories are readable through the GitHub App. Install it on a repository or organization to make it available here.</p>
        ${this._data?.installUrl ? html`<a class="btn" href=${this._data.installUrl} target="_blank" rel="noopener noreferrer">Configure GitHub access</a>` : nothing}
      </div>` : nothing}
      <div class="toolbar">
        <label class="search"><input type="search" aria-label=${connected ? 'Search connected repositories' : `Search ${this._scope} repositories`} placeholder="Search by repository or owner…" .value=${this._query} @input=${(e) => this._search(e.target.value)}></label>
        ${connected ? html`
          <button type="button" class="btn" @click=${() => this._open('installed')}>${this._accessIcon('private')} Add installed repository</button>
          <button type="button" class="btn" @click=${() => this._open('public')}>${this._accessIcon('public')} Add your public repository</button>
        ` : html`<button type="button" class="btn" ?disabled=${this._loading} @click=${() => { void this._load() }}>Refresh</button>`}
      </div>
      ${this._actionError ? html`<p class="msg error" role="alert">${this._actionError}</p>` : nothing}
      <div aria-busy=${this._loading}>${this._body()}</div>
    </div>`
  }

  _body() {
    if (this._error) return html`<p class="msg error" role="alert">Couldn't load repositories: ${this._error}</p><button type="button" class="btn" @click=${() => { void this._load() }}>Try again</button>`
    if (this._loading || !this._data) return html`<div class="loading" role="status">Loading repositories…</div>`
    const repos = this._data.repositories ?? []
    return html`
      ${this._data.tokenMissing && this._scope === 'public' ? html`<p class="msg">Log out and back in to refresh your GitHub membership access.</p>` : nothing}
      ${repos.length > 0 ? html`<div class="owners">${this._groupRepos(repos).map(([owner, ownerRepos]) => html`
        <section aria-label=${owner}>
          <h2 class="owner-head"><span class="owner-icon" aria-hidden="true">${owner[0] ?? '?'}</span>${owner}</h2>
          <ul class="repos">${ownerRepos.map((repo) => this._row(repo))}</ul>
        </section>`)}</div>` : html`<div class="empty">
        <strong>${this._query ? 'No matching repositories' : this._scope === 'connected' ? 'No connected repositories yet' : `No ${this._scope} repositories available`}</strong>
        <p>${this._query ? 'Try a different repository or owner name.' : this._scope === 'connected' ? 'Add an installed or public repository to get started.' : this._scope === 'installed' ? 'Install the GitHub App, then refresh this list.' : 'Public repositories associated with your GitHub account will appear here.'}</p>
      </div>`}
      ${this._data.total > 20 ? html`<nav class="pagination" aria-label="Repository pages">
        <span>${(this._page - 1) * 20 + 1}–${Math.min(this._page * 20, this._data.total)} of ${this._data.total}</span>
        <button type="button" class="btn" ?disabled=${this._page === 1} @click=${() => { this._page--; void this._load() }}>Previous</button>
        <button type="button" class="btn" ?disabled=${this._page * 20 >= this._data.total} @click=${() => { this._page++; void this._load() }}>Next</button>
      </nav>` : nothing}
    `
  }

  _groupRepos(repos) {
    const groups = new Map()
    for (const repo of repos) {
      const owner = repo.fullName.split('/')[0]
      if (!groups.has(owner)) groups.set(owner, [])
      groups.get(owner).push(repo)
    }
    return [...groups]
  }

  _row(repo) {
    const label = repo.fullName.slice(repo.fullName.indexOf('/') + 1)
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
    if (repo.installed) return repo.private ? 'Private · GitHub App' : 'Public · GitHub App'
    return 'Public · GitHub membership'
  }

  _detailPage(repo) {
    const active = repo.active !== false
    const reports = this._impact?.reports ?? []
    const bundles = this._impact?.bundles ?? []
    return html`<div class="wrap">
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
        ${this._impactLoading ? html`<p class="data-empty">Loading attached reports and bundles…</p>` : this._impact == null
          ? html`<p class="data-empty">Attached data could not be loaded.</p><button type="button" class="btn" @click=${() => this._openDetail(repo)}>Try again</button>` : html`
          <div class="dialog-data">
            <section><h3>Reports (${reports.length})</h3>${reports.length > 0 ? html`<ul>${reports.map((report) => html`<li>${report.filename}${report.repoDirectory ? ` · ${report.repoDirectory}` : nothing}</li>`)}</ul>` : html`<p class="data-empty">No reports attached.</p>`}</section>
            <section><h3>Bundles (${bundles.length})</h3>${bundles.length > 0 ? html`<ul>${bundles.map((bundle) => html`<li>${bundle.filename}</li>`)}</ul>` : html`<p class="data-empty">No bundles attached.</p>`}</section>
          </div>`}
      </section>
      <section class="section" aria-label="Permanent repository removal">
        <h2>Permanent removal</h2>
        <div class="settings-row"><div class="settings-copy"><strong>Delete repository and stored data</strong><p>Deactivation is reversible. Permanent removal deletes this repository’s attached reports and bundles; it cannot be undone.</p></div>
          <button type="button" class="btn danger" ?disabled=${this._busy != null || this._impactLoading || this._impact == null} @click=${() => { this._removeOpen = true; this._acknowledge = false; this._deleteTriage = false; this._confirmName = '' }}>Remove permanently</button>
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
        <label class="confirm-line"><input type="checkbox" .checked=${this._acknowledge} @change=${(event) => { this._acknowledge = event.target.checked }}>I understand this permanently deletes the repository connection${hasAttached ? ', reports, and bundles' : ''}.</label>
        ${(this._impact?.triageCount ?? 0) > 0 ? html`<label class="confirm-line"><input type="checkbox" .checked=${this._deleteTriage} @change=${(event) => { this._deleteTriage = event.target.checked }}>Also delete ${this._impact.triageCount} triage entr${this._impact.triageCount === 1 ? 'y' : 'ies'} belonging only to this repository.</label>` : nothing}
        ${hasAttached ? html`<label class="confirm-line">Type <strong>${repo.fullName}</strong> to confirm.<input class="confirm-name" type="text" autocomplete="off" .value=${this._confirmName} @input=${(event) => { this._confirmName = event.target.value }}></label>` : nothing}
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
      await selectRepository(repo.id, active, this._csrf)
      if (!this.isConnected) return
      if (this._detail?.id === repo.id) this._detail = { ...this._detail, active }
      if (this._data) {
        this._data = { ...this._data, repositories: this._data.repositories.map((entry) => entry.id === repo.id ? { ...entry, active } : entry) }
      }
      if (this._scope !== 'connected') await this._load()
    } catch (err) {
      const verb = active ? (repo.active === false ? 'reactivate' : 'add') : 'deactivate'
      this._actionError = `Couldn't ${verb} ${repo.fullName}: ${err?.message ?? err}`
    } finally {
      this._busy = null
    }
  }

  _canRemove(repo) {
    if (this._busy != null || this._impactLoading || this._impact?.repoId !== repo.id || !this._acknowledge) return false
    const hasAttached = this._impact.reports.length > 0 || this._impact.bundles.length > 0
    return !hasAttached || this._confirmName === repo.fullName
  }

  async _remove(repo) {
    if (!this._canRemove(repo)) return
    this._busy = repo.id
    this._actionError = null
    try {
      await removeRepository(repo.id, repo.fullName, this._deleteTriage, this._csrf)
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

async function fetchReports() {
  const res = await managedFetch('/api/admin/reports', { credentials: 'same-origin', headers: { accept: 'application/json' } })
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

// A repo <select>'s options: "No repository" + each selected repo, with
// `current` (a repo id, or null/'' for none) preselected. Shared by the upload
// picker and the per-row attach control.
function repoOptions(repos, current) {
  return html`
    <option value="" ?selected=${current == null || current === ''}>No repository</option>
    ${repos.map((r) => html`<option value=${r.repoId} ?selected=${Number(current) === r.repoId}>${r.fullName}</option>`)}`
}

// Bundle upload picker: a labelled dropdown setting which repository a new
// bundle attaches to. Bundles have no repository header of their own, so this
// explicit choice is intentionally separate from report upload.
function repoPickerTemplate(repos, selected, onChange, label = 'Repository for new bundles') {
  if (!Array.isArray(repos) || repos.length === 0) return nothing
  return html`<label class="repo-picker">
    <span class="repo-picker-label">${label}</span>
    <select class="repo-select" @change=${(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}>
      ${repoOptions(repos, selected)}
    </select>
  </label>`
}

// Per-row attach control: change which repo an already-stored report / bundle is
// attached to (or none). `onPick` gets the repo id, or null to detach.
function repoRowSelect(repos, current, onPick) {
  if (!Array.isArray(repos) || repos.length === 0) return nothing
  return html`<select class="repo-attach" aria-label="Attach to a repository"
    @change=${(e) => onPick(e.target.value === '' ? null : Number(e.target.value))}>
    ${repoOptions(repos, current)}
  </select>`
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

// Reports are uploaded with their own repository metadata. New reports remain
// hidden until an admin previews and publishes them; the list never asks the
// uploader to repeat a repo or directory already present in the report header.
class ManagedAdminReports extends LitElement {
  static properties = {
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

  static styles = [ADMIN_PAGE_HEADER_STYLES, css`
    :host { display: block; position: relative; flex: 1 1 auto; padding: clamp(1.5rem, 4vw, 2.5rem) clamp(1rem, 4vw, 2.5rem); color: var(--text); container-type: inline-size; }
    * { box-sizing: border-box; }
    .wrap { max-width: 68rem; margin: 0 auto; }
    .dropzone { position: absolute; inset: .6rem; z-index: 5; display: grid; place-items: center; border: 2px dashed var(--accent); border-radius: 10px; background: rgb(from var(--bg) r g b / .9); color: var(--accent); font-size: 1rem; font-weight: 600; pointer-events: none; }
    .drop-card { display: flex; align-items: center; flex-wrap: wrap; gap: .7rem; margin: 0 0 1.2rem; padding: .7rem .8rem; border: 1px dashed var(--border); border-radius: 8px; background: rgb(from var(--surface) r g b / .55); }
    .drop-card strong { display: block; font-size: .78rem; font-weight: 600; }
    .drop-card .drop-copy > span { display: block; margin-top: .12rem; color: var(--muted); font-size: .7rem; }
    .drop-icon { display: grid; place-items: center; width: 1.8rem; height: 1.8rem; flex: 0 0 auto; border-radius: 5px; color: var(--accent); background: rgb(from var(--accent) r g b / .1); }
    .drop-icon svg { width: 1rem; height: 1rem; }
    .drop-copy { min-width: 0; }
    .drop-browse { margin-left: auto; flex: 0 0 auto; padding: .3rem .55rem; border: 1px solid var(--border); border-radius: 5px; color: var(--text); background: var(--bg); font: inherit; font-size: .72rem; }
    .head { display: flex; align-items: center; gap: .65rem; margin: 0 0 .45rem; }
    h1 { margin: 0; font-size: 1.65rem; font-weight: 600; letter-spacing: -.035em; }
    .head-actions { display: flex; align-items: center; gap: .5rem; margin-left: auto; }
    .upload, .action { display: inline-flex; align-items: center; justify-content: center; min-height: 2rem; padding: .3rem .65rem; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); font: inherit; font-size: .78rem; font-weight: 500; white-space: nowrap; cursor: default; }
    .upload { border-color: var(--accent); background: var(--accent); color: var(--bg); font-weight: 600; }
    .upload:disabled, .action:disabled { opacity: .5; }
    .upload:hover:not(:disabled), .action:hover:not(:disabled) { background: var(--surface-active); }
    .upload:hover:not(:disabled) { filter: brightness(1.08); }
    .intro { max-width: 44rem; margin: 0 0 1.4rem; color: var(--muted); font-size: .85rem; line-height: 1.5; }
    .hint { margin: 0 0 .7rem; color: var(--muted); font-size: .75rem; }
    .reports { display: grid; gap: .5rem; margin: 0; padding: 0; list-style: none; }
    .report { overflow: hidden; border: 1px solid var(--border); border-radius: 9px; background: var(--surface); }
    .report-main { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: .55rem; padding: .42rem .6rem; }
    .report-logo { display: grid; place-items: center; flex: 0 0 auto; width: 1.5rem; height: 1.5rem; border-radius: 5px; overflow: hidden; }
    .report-logo svg { width: 1.2rem; height: 1.2rem; }
    .report-logo.brand-deepview { --brand-bg: #2563eb; --brand-fg: #fff; background: var(--brand-bg); }
    .report-logo.brand-claude { --brand-bg: #d97757; --brand-fg: #fff; background: var(--brand-bg); }
    .report-logo.brand-codex { --brand-bg: #fff; --brand-fg: #000; background: var(--brand-bg); }
    .report-logo.brand-vercel { --brand-bg: #000; --brand-fg: #fff; background: var(--brand-bg); }
    .report-logo.brand-piolium { --brand-bg: #fbb829; --brand-fg: #1c1b19; background: var(--brand-bg); }
    .report-logo.generic { color: var(--muted); background: var(--surface-active); border: 1px solid var(--border); }
    .report-logo .fg { fill: var(--brand-fg); }
    .report-logo .bg { fill: var(--brand-bg); }
    .report-logo.brand-codex .bg, .report-logo.brand-vercel .bg { stroke: var(--brand-fg); stroke-width: .5; }
    .report-copy { display: grid; flex: 1; min-width: 0; gap: .08rem; }
    .report-name { font-size: .78rem; font-weight: 600; overflow-wrap: anywhere; }
    .report-location { color: var(--muted); font-size: .66rem; overflow-wrap: anywhere; }
    .report-meta { display: flex; flex-wrap: nowrap; align-items: center; gap: .22rem .4rem; min-width: 0; overflow: hidden; color: var(--muted); font-size: .62rem; line-height: 1.25; }
    .report-meta > span { min-width: 0; }
    .report-meta > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .report-meta .report-location { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status { display: inline-flex; align-items: center; width: fit-content; padding: .1rem .35rem; border: 1px solid var(--border); border-radius: 4px; font-size: .65rem; font-weight: 500; }
    .status.hidden { color: var(--muted); }
    .status.visible { color: var(--accent); border-color: rgb(from var(--accent) r g b / .35); background: rgb(from var(--accent) r g b / .08); }
    .report-actions { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: .25rem; margin-left: auto; }
    .report-actions .action { min-height: 1.7rem; padding: .2rem .44rem; font-size: .68rem; }
    .report-actions a { color: var(--accent); text-decoration: none; }
    .report-actions a:hover { text-decoration: underline; }
    .preview { border-top: 1px solid var(--border); padding: .7rem .85rem .8rem 3.35rem; }
    .preview pre { max-height: 16rem; overflow: auto; margin: 0; padding: .65rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--muted); font: .7rem/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .preview-loading { color: var(--muted); font-size: .75rem; }
    .location-editor { display: grid; grid-template-columns: minmax(0, 1fr) minmax(10rem, .7fr) auto; align-items: end; gap: .5rem; padding: .7rem .85rem .8rem 3.35rem; border-top: 1px solid var(--border); background: rgb(from var(--bg) r g b / .35); }
    .location-field { display: grid; gap: .25rem; min-width: 0; }
    .location-field label { color: var(--muted); font-size: .68rem; }
    .location-field select, .location-field input { width: 100%; min-width: 0; height: 2rem; padding: .3rem .45rem; border: 1px solid var(--border); border-radius: 5px; color: var(--text); background: var(--bg); font: inherit; font-size: .74rem; }
    .location-actions { display: flex; gap: .35rem; }
    .empty { padding: 2.5rem 1rem; border: 1px solid var(--border); border-radius: 8px; text-align: center; }
    .empty strong { display: block; margin-bottom: .4rem; font-size: .9rem; font-weight: 500; }
    .empty p, .msg { margin: 0; color: var(--muted); font-size: .8rem; line-height: 1.5; }
    .msg.error { color: var(--critical, #c00); }
    @container (max-width: 40rem) { .head { flex-wrap: wrap; } .head-actions { width: 100%; margin-left: 0; } .report-main { grid-template-columns: auto minmax(0, 1fr); } .report-actions { grid-column: 2; width: auto; margin-left: 0; justify-content: flex-start; } .report-meta { flex-wrap: wrap; } .preview, .location-editor { padding-left: .85rem; } .location-editor { grid-template-columns: 1fr; align-items: stretch; } }
  `]

  constructor() {
    super()
    this._data = null
    this._error = null
    this._csrf = null
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

  async _load() {
    this._cancelPreview()
    this._error = null
    this._data = null
    try {
      const [session, data] = await Promise.all([fetchSession(), fetchReports()])
      this._csrf = session?.csrfToken ?? null
      this._data = data
    } catch (err) { this._error = String(err?.message ?? err) }
  }

  render() {
    return html`
      ${this._dragOver ? html`<div class="dropzone">Drop reports to upload</div>` : nothing}
      <div class="wrap">
        <div class="head">${adminBackButton()}<h1>Reports</h1></div>
        <p class="intro">Upload reports. New reports stay hidden until you make them visible.</p>
        <div class="drop-card"><span class="drop-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10V2m0 0L5 5m3-3 3 3M3 9v3.5A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V9"/></svg></span><span class="drop-copy"><strong>Drop reports here</strong><span>Reports can be dropped anywhere on this page, or selected from your computer.</span></span><button type="button" class="drop-browse" ?disabled=${this._busy} @click=${() => pickFiles((files) => void this._upload(files))}>${this._busy ? 'Uploading…' : 'Browse files'}</button></div>
        ${this._body()}
      </div>`
  }

  _body() {
    if (this._error != null) return html`<p class="msg error">Couldn't load reports: ${this._error}</p>`
    if (this._data == null) return html`<p class="msg">Loading…</p>`
    const reports = Array.isArray(this._data.reports) ? this._data.reports : []
    if (reports.length === 0) return html`<div class="empty"><strong>No reports uploaded yet</strong><p>Drop a report here or browse files above.</p></div>`
    return html`<p class="hint">${reports.length} stored ${reports.length === 1 ? 'report' : 'reports'}</p><ul class="reports">${reports.map((report) => this._row(report))}</ul>`
  }

  _row(report) {
    const analyzer = report.analyzer ?? report.source ?? report.producer ?? 'default'
    const logo = REPORT_LOGOS[analyzer] ?? REPORT_LOGOS.default
    const canAssignLocation = report.repoEmbedded !== true
    const canMakeVisible = report.repoEmbedded === true || report.repoId != null
    const location = report.repoFullName ? `${report.repoFullName}${report.repoDirectory ? `/${report.repoDirectory}` : ''}` : 'No repository assigned'
    const when = Number.isFinite(report.uploadedAt) ? new Date(report.uploadedAt).toLocaleString() : ''
    const meta = [report.uploadedByLogin ? `by ${report.uploadedByLogin}` : 'uploader removed', when, formatBytes(report.byteSize)].filter(Boolean).join(' · ')
    return html`<li class="report">
      <div class="report-main">
        ${unsafeHTML(logo)}
        <span class="report-copy"><span class="report-name">${report.filename}</span><span class="report-meta"><span class=${`status ${report.visible ? 'visible' : 'hidden'}`}>${report.visible ? 'Visible' : 'Hidden'}</span><span class="report-location">${location}</span><span>${meta}</span></span></span>
        <span class="report-actions">${canAssignLocation ? html`<button type="button" class="action" @click=${() => this._openLocation(report)}>${report.repoId == null ? 'Set location' : 'Change location'}</button>` : nothing}<button type="button" class="action" @click=${() => void this._togglePreview(report)}>${this._preview === report.id ? 'Hide preview' : 'Preview'}</button>${report.visible ? html`<button type="button" class="action" @click=${() => void this._setVisible(report, false)}>Hide</button>` : html`<button type="button" class="action" ?disabled=${!canMakeVisible} @click=${() => void this._setVisible(report, true)}>Make visible</button>`}<a class="action" href=${`/api/admin/reports/${encodeURIComponent(report.id)}`}>Download</a><button type="button" class="action" @click=${() => this._delete(report)}>Delete</button></span>
      </div>
      ${this._preview === report.id ? html`<div class="preview">${this._previewLoading === report.id ? html`<span class="preview-loading">Loading preview…</span>` : html`<pre>${this._previewText ?? ''}</pre>`}</div>` : nothing}
      ${this._locationReport === report.id ? this._locationEditor(report) : nothing}
    </li>`
  }

  _openLocation(report) {
    this._locationReport = report.id
    this._locationRepo = report.repoId ?? null
    this._locationDirectory = report.repoDirectory ?? ''
    this._error = null
  }

  _locationEditor(report) {
    const repos = Array.isArray(this._data?.repos) ? this._data.repos : []
    return html`<div class="location-editor"><div class="location-field"><label for=${`report-repo-${report.id}`}>Repository</label><select id=${`report-repo-${report.id}`} .value=${this._locationRepo == null ? '' : String(this._locationRepo)} @change=${(e) => { this._locationRepo = e.target.value === '' ? null : Number(e.target.value) }}>${repoOptions(repos, this._locationRepo)}</select></div><div class="location-field"><label for=${`report-dir-${report.id}`}>Directory (optional)</label><input id=${`report-dir-${report.id}`} type="text" placeholder="Repository root" .value=${this._locationDirectory} @input=${(e) => { this._locationDirectory = e.target.value }}></div><div class="location-actions"><button type="button" class="action" @click=${() => { this._locationReport = null }}>Cancel</button><button type="button" class="action" ?disabled=${this._locationBusy || this._locationRepo == null} @click=${() => void this._saveLocation(report)}>Save</button></div></div>`
  }

  async _saveLocation(report) {
    if (this._locationRepo == null || this._locationBusy) return
    this._locationBusy = true
    try {
      await setReportRepo(report.id, this._locationRepo, this._locationDirectory.trim(), this._csrf)
      this._locationReport = null
      await this._load()
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
    this._previewLoading = report.id
    try {
      const res = await managedFetch(`/api/admin/reports/${encodeURIComponent(report.id)}`, { credentials: 'same-origin', signal: request.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      if (isCurrent()) this._previewText = text.slice(0, 4000) + (text.length > 4000 ? '\n…' : '')
    } catch (err) { if (isCurrent()) this._previewText = `Preview unavailable: ${err?.message ?? err}` }
    finally { if (isCurrent()) this._previewLoading = null }
  }

  async _setVisible(report, visible) {
    try {
      await setReportVisible(report.id, visible, this._csrf)
      report.visible = visible
      this.requestUpdate()
    } catch (err) { this._error = `Couldn't change report visibility: ${String(err?.message ?? err)}` }
  }

  async _upload(files) {
    if (files.length === 0) return
    this._queue.push(...files)
    if (this._busy) return
    this._busy = true
    this._error = null
    try {
      while (this._queue.length > 0) await uploadReport(this._queue.shift(), this._csrf, this._repoId, this._repoDirectory.trim())
    } catch (err) { this._queue = []; this._error = `Upload failed: ${String(err?.message ?? err)}` }
    finally { this._busy = false; await this._load() }
  }

  async _delete(report) {
    if (!globalThis.confirm?.(`Delete “${report.filename}”? This can't be undone.`)) return
    try { await deleteReport(report.id, this._csrf) }
    catch (err) { this._error = `Delete failed: ${String(err?.message ?? err)}` }
    await this._load()
  }
}
customElements.define('managed-admin-reports', ManagedAdminReports)

async function fetchBundles() {
  const res = await managedFetch('/api/admin/bundles', { credentials: 'same-origin', headers: { accept: 'application/json' } })
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
  if (!res.ok) throw new Error(res.status === 413 ? 'too large' : `HTTP ${res.status}`)
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
class ManagedAdminBundles extends LitElement {
  static properties = {
    _data: { state: true },
    _error: { state: true },
    _busy: { state: true },
    _dragOver: { state: true },
  }

  static styles = [ADMIN_PAGE_HEADER_STYLES, css`
    :host { display: block; position: relative; padding: clamp(1.5rem, 4vw, 2.5rem) clamp(1rem, 4vw, 2.5rem); color: var(--text); container-type: inline-size; }
    * { box-sizing: border-box; }
    .wrap { max-width: 68rem; margin: 0 auto; }
    .head { margin-bottom: .4rem; }
    h1 { font-size: 1.65rem; letter-spacing: -.035em; }
    button, select { font: inherit; cursor: default; }
    button:focus-visible, a:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    .intro { margin: 0 0 1rem; color: var(--muted); font-size: .8rem; line-height: 1.45; }
    .dropzone { position: absolute; inset: .6rem; z-index: 5; display: grid; place-items: center; border: 2px dashed var(--accent); border-radius: 10px; background: rgb(from var(--bg) r g b / .94); color: var(--accent); font-size: 1rem; font-weight: 600; pointer-events: none; }
    .upload-panel { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: .55rem 1rem; padding: .7rem .8rem; margin-bottom: 1rem; border: 1px dashed color-mix(in srgb, var(--border) 70%, var(--muted)); border-radius: 8px; background: var(--surface); }
    .upload-copy { display: grid; gap: .25rem; }
    .upload-copy strong { font-size: .87rem; font-weight: 600; }
    .upload-copy > span { color: var(--muted); font-size: .72rem; }
    .upload-controls { display: flex; align-items: end; gap: .65rem; }
    .repo-picker { display: grid; gap: .3rem; min-width: 0; }
    .repo-picker-label { color: var(--muted); font-size: .67rem; }
    .repo-select, .repo-attach { min-width: 0; width: 100%; height: 2rem; padding: .25rem .5rem; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 5px; font-size: .74rem; }
    .repo-select { max-width: 18rem; }
    .drop-browse { height: 2rem; flex-shrink: 0; padding: .3rem .75rem; border: 1px solid var(--accent); border-radius: 5px; color: var(--bg); background: var(--accent); font-size: .74rem; font-weight: 600; }
    .drop-browse:hover:not(:disabled) { filter: brightness(1.08); }
    .drop-browse:disabled { opacity: .5; }
    .section-head { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: .5rem; margin-bottom: .6rem; }
    .section-head h2 { margin: 0; font-size: .85rem; font-weight: 600; }
    .summary { display: flex; flex-wrap: wrap; align-items: center; gap: .75rem; color: var(--muted); font-size: .7rem; font-variant-numeric: tabular-nums; }
    .unassigned { color: var(--high, #d97732); }
    .bundles { margin: 0; padding: 0; list-style: none; }
    .bundle-groups { display: grid; gap: .65rem; }
    .bundle-group { overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
    .bundle-group-head { display: flex; align-items: center; justify-content: space-between; gap: .6rem; padding: .45rem .7rem; border-bottom: 1px solid var(--border); }
    .bundle-group-head strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .74rem; font-weight: 600; }
    .bundle-group-head span { color: var(--muted); font-size: .67rem; }
    .bundle-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(10rem, 15rem) auto; align-items: center; gap: .75rem; padding: .42rem .65rem; }
    .bundle-row + .bundle-row { border-top: 1px solid var(--border); }
    .identity { display: flex; align-items: flex-start; min-width: 0; gap: .5rem; }
    .bundle-icon { display: grid; place-items: center; width: 1.45rem; height: 1.45rem; flex-shrink: 0; color: var(--muted); }
    .bundle-icon svg { width: 1rem; height: 1rem; }
    .who { display: grid; min-width: 0; gap: .12rem; }
    .filename { font-size: .82rem; font-weight: 600; overflow-wrap: anywhere; }
    .meta { display: flex; flex-wrap: wrap; gap: .2rem .5rem; color: var(--muted); font-size: .62rem; line-height: 1.35; }
    .kind { color: var(--text); }
    .bundle-location { display: grid; gap: .18rem; min-width: 0; }
    .bundle-location-label { color: var(--muted); font-size: .6rem; }
    .actions { display: flex; gap: .2rem; }
    .action { display: grid; place-items: center; width: 1.65rem; height: 1.65rem; padding: .35rem; border: 1px solid transparent; border-radius: 5px; background: transparent; color: var(--muted); text-decoration: none; }
    .action svg { width: 1rem; height: 1rem; }
    .action:hover { color: var(--text); border-color: var(--border); background: var(--surface); }
    .action.danger:hover { color: var(--critical, #e5534b); }
    .msg { padding: 1rem 0; margin: 0; color: var(--muted); font-size: .8rem; }
    .msg.error { color: var(--critical, #e5534b); }
    @container (max-width: 46rem) { .upload-panel { grid-template-columns: 1fr; } .upload-controls { justify-content: space-between; } .repo-picker { flex: 1; } .repo-select { max-width: none; } .bundle-row { grid-template-columns: minmax(0, 1fr) auto; gap: .5rem; } .bundle-location { grid-column: 1; padding-left: 2.4rem; } .actions { grid-column: 2; grid-row: 1 / 3; } }
    @container (max-width: 24rem) { .upload-controls { flex-wrap: wrap; } .repo-picker { flex-basis: 100%; } }
  `]

  constructor() {
    super()
    this._data = null
    this._error = null
    this._csrf = null
    this._busy = false
    this._repoId = null // null = no repo link; otherwise a selected repo id (for new uploads)
    this._dragOver = false
    this._teardownDrop = null
    this._queue = [] // files awaiting upload; a drop during an in-flight upload joins it
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

  async _load() {
    this._error = null
    this._data = null
    try {
      const [session, data] = await Promise.all([fetchSession(), fetchBundles()])
      this._csrf = session?.csrfToken ?? null
      this._data = data
    } catch (err) {
      this._error = String(err?.message ?? err)
    }
  }

  render() {
    return html`
      ${this._dragOver ? html`<div class="dropzone">Drop bundles to upload</div>` : nothing}
      <div class="wrap">
        <div class="head">${adminBackButton()}<h1>Bundles</h1></div>
        <p class="intro">Source bundles and sourcemaps for your repositories.</p>
        <section class="upload-panel" aria-label="Upload bundles">
          <div class="upload-copy"><strong>Drop bundles here</strong><span>Choose a repository for your uploads.</span></div>
          <div class="upload-controls">${repoPickerTemplate(this._data?.repos, this._repoId, (v) => { this._repoId = v }, 'Repository')}<button type="button" class="drop-browse" ?disabled=${this._busy} @click=${() => pickFiles((files) => void this._upload(files))}>${this._busy ? 'Uploading…' : 'Browse files'}</button></div>
        </section>
        ${this._body()}
      </div>`
  }

  _body() {
    if (this._error != null) return html`<p class="msg error">Couldn't load bundles: ${this._error}</p>`
    if (this._data == null) return html`<p class="msg">Loading…</p>`
    const bundles = Array.isArray(this._data.bundles) ? this._data.bundles : []
    const unassigned = bundles.filter((bundle) => bundle.repoId == null).length
    const bytes = bundles.reduce((sum, bundle) => sum + (Number.isFinite(bundle.byteSize) ? bundle.byteSize : 0), 0)
    const groups = Map.groupBy(bundles, (bundle) => bundle.repoFullName || 'Unattached')
    return html`<div class="section-head"><h2>Stored bundles</h2><span class="summary"><span>${bundles.length} ${bundles.length === 1 ? 'bundle' : 'bundles'}</span><span>${formatBytes(bytes)}</span>${unassigned ? html`<span class="unassigned">${unassigned} unattached</span>` : nothing}</span></div>
      ${bundles.length > 0 ? html`<div class="bundle-groups">${[...groups].toSorted(([a], [b]) => a === 'Unattached' ? 1 : b === 'Unattached' ? -1 : a.localeCompare(b)).map(([name, items]) => html`<section class="bundle-group"><div class="bundle-group-head"><strong>${name}</strong><span>${items.length} ${items.length === 1 ? 'bundle' : 'bundles'}</span></div><ul class="bundles">${items.map((b) => this._row(b))}</ul></section>`)}</div>` : html`<p class="msg">No bundles uploaded yet.</p>`}`
  }

  _row(b) {
    const when = Number.isFinite(b.uploadedAt) ? new Date(b.uploadedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''
    return html`<li class="bundle-row">
      <span class="identity"><span class="bundle-icon" aria-hidden="true">${BUNDLE_ICON}</span><span class="who">
        <span class="filename">${b.filename}</span>
        <span class="meta"><span class="kind">${b.kind === 'stasis' ? 'Stasis' : 'Sourcemaps'}</span><span>${formatBytes(b.byteSize)}</span><span>${when}</span>${b.uploadedByLogin ? html`<span>@${b.uploadedByLogin}</span>` : nothing}</span>
      </span></span>
      <span class="bundle-location">${repoRowSelect(this._data?.repos, b.repoId, (repoId) => this._setRepo(b, repoId))}</span>
      <span class="actions">
        <a class="action" aria-label=${`Download ${b.filename}`} href=${`/api/admin/bundles/${encodeURIComponent(b.id)}`}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8m-3-3 3 3 3-3M3 11v3h10v-3"/></svg></a>
        <button type="button" class="action danger" aria-label=${`Delete ${b.filename}`} @click=${() => this._delete(b)}>${ADMIN_REMOVE_ICON}</button>
      </span>
    </li>`
  }

  async _setRepo(b, repoId) {
    try {
      await setBundleRepo(b.id, repoId, this._csrf)
    } catch (err) {
      this._error = `Couldn't change repo: ${String(err?.message ?? err)}`
    }
    await this._load()
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
        await uploadBundle(file, this._csrf, this._repoId)
      }
    } catch (err) {
      this._queue = [] // fail-fast: drop the rest of the batch (matches the old behaviour)
      this._error = `Upload failed: ${String(err?.message ?? err)}`
    } finally {
      this._busy = false
      await this._load()
    }
  }

  async _delete(b) {
    if (!globalThis.confirm?.(`Delete “${b.filename}”? Linked reports will keep their pending link.`)) return
    try {
      await deleteBundle(b.id, this._csrf)
    } catch (err) {
      this._error = `Delete failed: ${String(err?.message ?? err)}`
    }
    await this._load()
  }
}
customElements.define('managed-admin-bundles', ManagedAdminBundles)

// The scan page is deliberately UI-first for now. The managed API will own
// bundle discovery, reason metadata, file previews, scan execution, and report
// persistence; these fixtures keep the flow reviewable before those endpoints
// exist and exercise the same states the real response will provide.
const SCAN_PACKAGE_NAMES = ['@acme/auth', '@acme/billing', '@acme/catalog', '@acme/checkout', '@acme/config', '@acme/crypto', '@acme/data', '@acme/identity', '@acme/notifications', '@acme/payments', '@acme/search', '@acme/storage', '@acme/telemetry', '@acme/ui', '@acme/users', '@acme/webhooks']
const SCAN_LARGE_BUNDLE_FILES = Array.from({ length: 128 }, (_, index) => {
  const module = SCAN_PACKAGE_NAMES[index % SCAN_PACKAGE_NAMES.length]
  const bytes = 9_000 + ((index * 7_300) % 48_000)
  return { path: `packages/${module.slice(6)}/src/file-${String(index + 1).padStart(3, '0')}.ts`, size: `${Math.round(bytes / 1024)} KB`, bytes, module }
})

const SCAN_REPOSITORY_FIXTURES = [
  { id: 'repo-checkout', label: 'acme/checkout' },
  { id: 'repo-worker', label: 'acme/worker-service' },
  { id: 'unattached', label: 'Unattached' },
]

const SCAN_BUNDLE_FIXTURES = [
  {
    id: 'bundle-checkout', filename: 'checkout.stasis', repoId: 'repo-checkout', repo: 'acme/checkout', size: '48.2 MB', files: [
      { path: 'src/auth/session.ts', size: '82 KB', bytes: 82_000, module: '@acme/auth' },
      { path: 'src/payments/checkout.ts', size: '74 KB', bytes: 74_000, module: '@acme/payments' },
      { path: 'src/api/routes.ts', size: '61 KB', bytes: 61_000, module: '@acme/api' },
      { path: 'src/users/permissions.ts', size: '42 KB', bytes: 42_000, module: '@acme/users' },
      { path: 'src/crypto/tokens.ts', size: '36 KB', bytes: 36_000, module: '@acme/crypto' },
      { path: 'src/db/queries.ts', size: '29 KB', bytes: 29_000, module: '@acme/database' },
      { path: 'src/webhooks/stripe.ts', size: '22 KB', bytes: 22_000, module: '@acme/payments' },
      { path: 'src/config/env.ts', size: '13 KB', bytes: 13_000, module: '@acme/config' },
      ...SCAN_LARGE_BUNDLE_FILES,
    ],
    reasons: [
      { id: 'all', label: 'All', fileModules: null },
      { id: 'run', label: 'run', fileModules: null },
      { id: 'app', label: 'app', fileModules: ['@acme/auth', '@acme/payments', '@acme/api', '@acme/users', '@acme/crypto', '@acme/config', ...SCAN_PACKAGE_NAMES] },
    ],
  },
  {
    id: 'bundle-worker', filename: 'worker.stasis', repoId: 'repo-worker', repo: 'acme/worker-service', size: '16.7 MB', files: [
      { path: 'worker/queue.ts', size: '54 KB', bytes: 54_000, module: 'queue' },
      { path: 'worker/handlers/process.ts', size: '48 KB', bytes: 48_000, module: 'handlers' },
      { path: 'worker/handlers/retry.ts', size: '31 KB', bytes: 31_000, module: 'handlers' },
      { path: 'worker/secrets.ts', size: '19 KB', bytes: 19_000, module: 'secrets' },
      { path: 'worker/metrics.ts', size: '12 KB', bytes: 12_000, module: 'metrics' },
    ],
    reasons: [{ id: 'all', label: 'All', fileModules: null }, { id: 'run', label: 'run', fileModules: ['queue', 'handlers', 'secrets', 'metrics'] }, { id: 'app', label: 'app', fileModules: ['queue', 'handlers', 'metrics'] }],
  },
  {
    id: 'bundle-unattached', filename: 'detached-preview.stasis', repoId: 'unattached', repo: 'Unattached', size: '6.4 MB', files: [
      { path: 'src/index.ts', size: '31 KB', bytes: 31_000, module: 'preview' },
      { path: 'src/loader.ts', size: '24 KB', bytes: 24_000, module: 'preview' },
      { path: 'src/manifest.ts', size: '18 KB', bytes: 18_000, module: 'preview' },
      { path: 'src/worker.ts', size: '15 KB', bytes: 15_000, module: 'worker' },
    ],
    reasons: [{ id: 'all', label: 'All', fileModules: null }, { id: 'run', label: 'run', fileModules: ['preview', 'worker'] }],
  },
]

const SCAN_REPORT_FIXTURES = [
  { id: 'report-checkout', filename: 'managed-fixture.json', repoId: 'repo-checkout', repo: 'acme/checkout', directory: '', analyzer: 'deepsec', size: '318 KB' },
  { id: 'report-worker', filename: 'managed-worker.json', repoId: 'repo-worker', repo: 'acme/worker-service', directory: 'services/worker', analyzer: 'codex-security', size: '342 KB' },
  { id: 'report-api', filename: 'managed-api.json', repoId: 'repo-checkout', repo: 'acme/checkout', directory: 'packages/api', analyzer: 'claude-security', size: '356 KB' },
  { id: 'report-unattached', filename: 'detached-preview.json', repoId: 'unattached', repo: 'Unattached', directory: '', analyzer: 'deepsec', size: '284 KB' },
]

const SCAN_FIXTURES = [
  { id: 'scan-104', bundleId: 'bundle-checkout', bundleName: 'checkout.stasis', reason: 'app', status: 'completed', createdAt: 'Today, 09:42', duration: '4m 18s', files: 5, reportSaved: true },
  { id: 'scan-103', bundleId: 'bundle-worker', bundleName: 'worker.stasis', reason: 'All', status: 'running', createdAt: 'Today, 09:51', duration: '1m 06s', files: 5, reportSaved: false },
  { id: 'scan-102', bundleId: 'bundle-checkout', bundleName: 'checkout.stasis', reason: 'run', status: 'stopped', createdAt: 'Yesterday, 17:20', duration: '38s', files: 4, reportSaved: false },
]

function cloneScanFixtures() {
  return SCAN_BUNDLE_FIXTURES.map((bundle) => ({
    ...bundle,
    files: bundle.files.map((file) => ({ ...file })),
    reasons: bundle.reasons.map((reason) => ({ ...reason, fileModules: reason.fileModules ? [...reason.fileModules] : null })),
  }))
}

const MANAGED_SCAN_STYLES = css`
  :host { display: block; min-height: 100%; padding: clamp(1.1rem, 3vw, 2rem) clamp(1rem, 4vw, 2.5rem); color: var(--text); }
  * { box-sizing: border-box; }
  .wrap { max-width: 68rem; margin: 0 auto; }
  .head { display: flex; align-items: center; gap: .65rem; margin-bottom: .35rem; }
  h1 { margin: 0; font-size: 1.65rem; font-weight: 600; letter-spacing: -.035em; }
  .head-tabs { display: inline-flex; margin-left: .7rem; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .head-tabs button { border: 0; border-right: 1px solid var(--border); padding: .25rem .6rem; color: var(--muted); background: transparent; font: inherit; font-size: .75rem; }
  .head-tabs button:last-child { border-right: 0; }
  .head-tabs button.active { color: var(--text); background: var(--surface-active); }
  .head-tabs button:hover { color: var(--text); }
  .head-actions { margin-left: auto; display: flex; gap: .45rem; }
  button, select, input { font: inherit; }
  button { cursor: default; }
  button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .intro { margin: 0 0 1.15rem; max-width: 52rem; color: var(--muted); font-size: .82rem; line-height: 1.5; }
  .intro span { display: block; }
  .notice { margin: 0 0 1rem; padding: .55rem .7rem; border: 1px solid rgb(from var(--accent) r g b / .35); border-radius: 7px; color: var(--text); background: rgb(from var(--accent) r g b / .08); font-size: .78rem; }
  .setup { display: grid; gap: .85rem; }
  .panel { border: 1px solid var(--border); border-radius: 9px; background: var(--surface); overflow: hidden; }
  .panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: .7rem; padding: .72rem .9rem; border-bottom: 1px solid var(--border); }
  .panel-head h2 { margin: 0; font-size: .86rem; font-weight: 600; }
  .panel-head p { margin: 0; color: var(--muted); font-size: .72rem; }
  .bundle-choice { display: grid; grid-template-columns: minmax(16rem, 1.2fr) minmax(0, 1fr); gap: 1rem; align-items: end; padding: .85rem .9rem; }
  .field { display: grid; gap: .3rem; min-width: 0; }
  .field label, .scope-field > span { color: var(--muted); font-size: .68rem; }
  select { min-width: 0; height: 2rem; padding: .28rem .5rem; border: 1px solid var(--border); border-radius: 5px; color: var(--text); background: var(--bg); font-size: .76rem; }
  .bundle-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .5rem; }
  .metric { min-width: 0; padding: .45rem .55rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); }
  .metric strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .78rem; font-variant-numeric: tabular-nums; }
  .metric span { display: block; margin-top: .12rem; color: var(--muted); font-size: .63rem; }
  .mode-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: .45rem; padding: .7rem .9rem .85rem; }
    .mode-option { display: grid; gap: .25rem; min-width: 0; padding: .55rem .6rem; border: 1px solid var(--border); border-radius: 6px; color: var(--muted); background: var(--bg); text-align: left; }
    .mode-title { display: flex; align-items: center; gap: .35rem; min-width: 0; }
    .mode-title svg { width: .95rem; height: .95rem; flex: 0 0 auto; color: var(--muted); }
    .mode-option strong { color: var(--text); font-size: .75rem; font-weight: 600; }
  .mode-option span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .63rem; }
  .mode-option.active { border-color: rgb(from var(--accent) r g b / .55); background: rgb(from var(--accent) r g b / .1); }
    .mode-option.active strong, .mode-option.active .mode-title svg { color: var(--accent); }
  .subtype-wrap { border-top: 1px solid var(--border); background: rgb(from var(--accent) r g b / .025); animation: submenu-in .16s ease-out both; }
  .subtype-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .45rem; padding: .7rem .9rem .45rem; }
  @keyframes submenu-in { from { opacity: 0; transform: translateY(-.2rem); } to { opacity: 1; transform: translateY(0); } }
  .subtype-option { display: grid; gap: .12rem; padding: .42rem .55rem; border: 1px solid var(--border); border-radius: 5px; color: var(--muted); background: var(--bg); text-align: left; }
  .subtype-option strong { color: var(--text); font-size: .72rem; font-weight: 500; }
  .subtype-option span { font-size: .62rem; }
  .subtype-option.active { border-color: rgb(from var(--accent) r g b / .55); background: rgb(from var(--accent) r g b / .1); }
  .subtype-option.active strong { color: var(--accent); }
  .subtype-help { margin: 0; padding: .15rem .9rem .72rem; color: var(--muted); font-size: .68rem; line-height: 1.4; }
  .source-choice { display: grid; grid-template-columns: minmax(12rem, .8fr) minmax(16rem, 1.2fr); gap: .7rem; align-items: end; padding: .85rem .9rem; }
  .source-choice .bundle-stats { grid-column: 1 / -1; }
  .choice-empty { display: flex; align-items: center; height: 2rem; padding: .28rem .5rem; border: 1px dashed var(--border); border-radius: 5px; color: var(--muted); background: var(--bg); font-size: .72rem; }
  .report-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .report-option { display: flex; align-items: center; gap: .55rem; min-width: 0; padding: .65rem .75rem; border-bottom: 1px solid var(--border); }
  .report-option:nth-child(odd) { border-right: 1px solid var(--border); }
  .report-option input { width: .85rem; height: .85rem; flex: 0 0 auto; accent-color: var(--accent); }
  .report-option .report-logo { width: 1.35rem; height: 1.35rem; flex: 0 0 auto; }
  .report-option .report-logo svg { width: .9rem; height: .9rem; }
  .report-option-copy { display: grid; gap: .15rem; min-width: 0; }
  .report-option-copy strong, .report-option-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .report-option-copy strong { font-size: .72rem; font-weight: 600; }
  .report-option-copy span { color: var(--muted); font-size: .64rem; }
  .scope-head { display: flex; align-items: baseline; justify-content: space-between; gap: .7rem; padding: .72rem .9rem; border-bottom: 1px solid var(--border); }
  .scope-head h2 { margin: 0; font-size: .86rem; font-weight: 600; }
  .scope-head p { margin: 0; color: var(--muted); font-size: .7rem; font-variant-numeric: tabular-nums; }
  .scope-toolbar { display: flex; gap: .65rem; padding: .7rem .9rem; border-bottom: 1px solid var(--border); }
  .scope-field { display: grid; flex: 0 1 13rem; gap: .3rem; min-width: 0; }
  .scope-summary-field { flex: 1 1 18rem; }
  .scope-selection { display: flex; align-items: baseline; gap: .4rem; height: 2rem; padding: .32rem .5rem; border: 1px solid var(--border); border-radius: 5px; background: var(--bg); }
  .scope-selection strong { font-size: .78rem; font-variant-numeric: tabular-nums; }
  .scope-selection span { color: var(--muted); font-size: .7rem; }
  .scope-grid { display: grid; grid-template-columns: minmax(13rem, .75fr) minmax(0, 1.25fr); min-height: 0; }
  .scope-pane { min-width: 0; }
  .scope-pane + .scope-pane { border-left: 1px solid var(--border); }
  .pane-head { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; padding: .55rem .75rem; border-bottom: 1px solid var(--border); }
  .pane-head strong { font-size: .72rem; font-weight: 600; }
  .pane-head span { color: var(--muted); font-size: .65rem; font-variant-numeric: tabular-nums; }
  .package-list { max-height: 22rem; overflow: auto; }
  .package-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: .45rem; width: 100%; padding: .42rem .7rem; border: 0; border-bottom: 1px solid var(--border); color: var(--text); background: transparent; text-align: left; }
  .package-row:hover { background: var(--surface-active); }
  .package-row input, .file input { width: .85rem; height: .85rem; accent-color: var(--accent); }
  .package-name, .package-size { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .package-name { font-size: .7rem; }
  .package-size { color: var(--muted); font-size: .64rem; font-variant-numeric: tabular-nums; }
  .package-row.excluded .package-name { color: var(--muted); text-decoration: line-through; }
  .file-panel { min-width: 0; }
  .file-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); max-height: 22rem; overflow: auto; }
  .file { display: flex; align-items: center; gap: .45rem; min-width: 0; padding: .5rem .75rem; border-bottom: 1px solid var(--border); }
  .file:nth-child(odd) { border-right: 1px solid var(--border); }
  .file input { flex: 0 0 auto; }
  .file-copy { min-width: 0; }
  .file-path { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .72rem; }
  .file-meta { display: block; margin-top: .1rem; color: var(--muted); font-size: .66rem; }
  .excluded .file-path { color: var(--muted); text-decoration: line-through; }
  .file-foot { display: flex; justify-content: space-between; gap: .6rem; padding: .6rem .8rem; color: var(--muted); font-size: .7rem; }
  .options { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 1rem; position: relative; z-index: 2; overflow: visible; padding: .85rem .9rem 1rem; }
  .options-grid { display: grid; grid-column: 1 / -1; gap: .7rem; min-width: 0; }
  .checks { display: flex; flex-wrap: wrap; grid-column: 2; grid-row: 3; align-items: center; justify-content: flex-end; gap: .8rem 1.1rem; margin-top: 1rem; }
  .check { display: inline-flex; align-items: center; gap: .4rem; color: var(--text); font-size: .75rem; }
  .check input { width: .85rem; height: .85rem; accent-color: var(--accent); }
  .switch { display: inline-flex; align-items: center; gap: .45rem; color: var(--text); font-size: .74rem; cursor: default; }
  .switch input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .switch-track { position: relative; width: 2rem; height: 1.1rem; border-radius: 999px; background: var(--surface-active); transition: background .12s; }
  .switch-track::after { content: ''; position: absolute; top: .15rem; left: .15rem; width: .8rem; height: .8rem; border-radius: 50%; background: var(--muted); transition: transform .12s, background .12s; }
  .switch input:checked + .switch-track { background: rgb(from var(--accent) r g b / .4); }
  .switch input:checked + .switch-track::after { transform: translateX(.9rem); background: var(--accent); }
  .switch input:focus-visible + .switch-track { outline: 2px solid var(--accent); outline-offset: 2px; }
  .effort-switch { display: grid; grid-template-columns: auto auto auto; align-items: center; column-gap: .85rem; row-gap: .35rem; width: fit-content; max-width: 100%; margin-top: 1rem; color: var(--muted); font-size: .74rem; }
  .effort-switch-label { color: var(--text); font-weight: 600; line-height: 1.2; }
  .effort-switch small { grid-column: 1 / -1; margin: .1rem 0 0; color: var(--muted); font-size: .7rem; line-height: 1.35; }
  .effort-switch-control { position: relative; display: inline-flex; align-items: center; justify-content: center; }
  .effort-switch-control input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .effort-switch .switch-track { display: block; position: relative; width: 3rem; height: 1.6rem; border-radius: 999px; background: var(--surface-active); box-shadow: inset 0 0 0 1px var(--border); transition: background .15s, box-shadow .15s; }
  .effort-switch .switch-track::after { content: ''; position: absolute; top: .2rem; left: .2rem; width: 1.2rem; height: 1.2rem; border-radius: 50%; background: var(--muted); box-shadow: 0 1px 2px rgb(0 0 0 / .3); transition: transform .15s, background .15s; }
  .effort-switch-control input:checked + .switch-track { background: rgb(from var(--accent) r g b / .4); box-shadow: inset 0 0 0 1px rgb(from var(--accent) r g b / .75); }
  .effort-switch-control input:checked + .switch-track::after { transform: translateX(1.4rem); background: var(--accent); }
  .effort-switch-control input:focus-visible + .switch-track { outline: 2px solid var(--accent); outline-offset: 3px; }
  .options-footer { display: flex; grid-column: 1; grid-row: 3; align-items: center; gap: .7rem; min-width: 0; margin-top: 1rem; }
  .agentic-fields { display: grid; grid-template-columns: minmax(13rem, .65fr) minmax(0, 1.35fr); gap: .7rem; padding: .85rem .9rem 1rem; }
  textarea { min-width: 0; resize: vertical; padding: .4rem .5rem; border: 1px solid var(--border); border-radius: 5px; color: var(--text); background: var(--bg); font: inherit; font-size: .76rem; }
  .run { padding: .48rem .8rem; border: 0; border-radius: 6px; color: var(--bg); background: var(--accent); font-size: .8rem; font-weight: 600; }
  .run:disabled { opacity: .45; }
  .summary { color: var(--muted); font-size: .74rem; }
  .history { display: grid; gap: .6rem; }
  .scan-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 1rem; padding: .85rem .9rem; }
  .scan-row + .scan-row { border-top: 1px solid var(--border); }
  .scan-main { min-width: 0; }
  .scan-title { display: flex; align-items: center; gap: .45rem; min-width: 0; }
  .scan-title strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .82rem; }
  .scan-meta { display: block; margin-top: .25rem; color: var(--muted); font-size: .7rem; }
  .status { display: inline-flex; align-items: center; gap: .3rem; padding: .15rem .4rem; border-radius: 999px; font-size: .66rem; font-weight: 600; text-transform: capitalize; }
  .status::before { content: ''; width: .4rem; height: .4rem; border-radius: 50%; background: currentColor; }
  .status.running { color: var(--accent); background: rgb(from var(--accent) r g b / .1); }
  .status.completed { color: #48b878; background: rgb(72 184 120 / .1); }
  .status.stopped { color: var(--muted); background: var(--surface-active); }
  .scan-actions { display: flex; align-items: center; gap: .45rem; }
  .action { padding: .35rem .55rem; border: 1px solid var(--border); border-radius: 5px; color: var(--text); background: var(--bg); font-size: .72rem; white-space: nowrap; }
  .action:hover { border-color: var(--muted); background: var(--surface-active); }
  .empty { margin: 0; padding: 1.2rem; color: var(--muted); font-size: .8rem; }
  @media (max-width: 48rem) { .bundle-choice, .source-choice { grid-template-columns: 1fr; gap: .7rem; } .source-choice .bundle-stats { grid-column: auto; } .scope-grid { grid-template-columns: 1fr; } .scope-pane + .scope-pane { border-top: 1px solid var(--border); border-left: 0; } .agentic-fields { grid-template-columns: 1fr; } }
  @media (max-width: 42rem) { .options { display: block; } .checks { justify-content: flex-start; margin-top: .8rem; } .options-footer { margin-top: .8rem; } }
  @media (max-width: 34rem) { .mode-grid, .report-list { grid-template-columns: 1fr 1fr; } .scope-toolbar { flex-direction: column; } .scope-field { flex-basis: auto; } .file-list { grid-template-columns: 1fr; } .file:nth-child(odd) { border-right: 0; } .scan-row { grid-template-columns: 1fr; gap: .55rem; } .scan-actions { justify-content: flex-start; } .head-tabs { margin-left: 0; } }
`

class ManagedAdminScans extends LitElement {
  static properties = {
    _tab: { state: true },
    _mode: { state: true },
    _bundles: { state: true },
    _repositories: { state: true },
    _reports: { state: true },
    _scans: { state: true },
    _selectedRepoId: { state: true },
    _selectedBundleId: { state: true },
    _selectedReportIds: { state: true },
    _reason: { state: true },
    _excluded: { state: true },
    _excludedModules: { state: true },
    _prompt: { state: true },
    _options: { state: true },
    _notice: { state: true },
  }

  static styles = [ADMIN_PAGE_HEADER_STYLES, MANAGED_SCAN_STYLES]

  constructor() {
    super()
    this._tab = 'new'
    this._mode = 'code'
    this._bundles = cloneScanFixtures()
    this._repositories = SCAN_REPOSITORY_FIXTURES.map((repo) => ({ ...repo }))
    this._reports = SCAN_REPORT_FIXTURES.map((report) => ({ ...report }))
    this._scans = SCAN_FIXTURES.map((scan) => ({ ...scan }))
    this._selectedRepoId = this._bundles[0]?.repoId ?? 'unattached'
    this._selectedBundleId = this._bundles[0]?.id ?? null
    this._selectedReportIds = new Set([this._reports[0]?.id].filter(Boolean))
    this._reason = this._bundles[0]?.reasons[0]?.id ?? ''
    this._excluded = new Set()
    this._excludedModules = new Set()
    this._prompt = ''
    this._options = { analyzer: 'generic', model: null, effort: null, cached: false, isolate: false }
    this._notice = null
    this._timers = new Set()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    for (const timer of this._timers) clearTimeout(timer)
    this._timers.clear()
  }

  get _repo() { return this._repositories.find((repo) => repo.id === this._selectedRepoId) ?? this._repositories[0] }

  get _repoBundles() { return this._bundles.filter((bundle) => bundle.repoId === this._selectedRepoId) }

  get _bundle() { return this._bundles.find((bundle) => bundle.id === this._selectedBundleId) ?? this._repoBundles[0] }

  get _reasonData() { return this._bundle?.reasons.find((reason) => reason.id === this._reason) ?? this._bundle?.reasons[0] }

  _packageLabel(module) { return module.startsWith('@') ? module : `@acme/${module}` }

  get _files() {
    const reason = this._reasonData
    const modules = reason?.fileModules
    return (this._bundle?.files ?? []).filter((file) => modules == null || modules.includes(file.module)).toSorted((a, b) => b.bytes - a.bytes)
  }

  render() {
    return html`<div class="wrap">
      <div class="head">${adminBackButton()}<h1>Scans</h1>
        <div class="head-tabs" role="tablist" aria-label="Scan views">
          <button class=${this._tab === 'new' ? 'active' : ''} role="tab" aria-selected=${this._tab === 'new'} @click=${() => { this._tab = 'new' }}>New scan</button>
          <button class=${this._tab === 'history' ? 'active' : ''} role="tab" aria-selected=${this._tab === 'history'} @click=${() => { this._tab = 'history' }}>Scan history</button>
        </div>
      </div>
      <p class="intro">Choose a bundle and start a scan. Save the report when it finishes.</p>
      ${this._notice ? html`<p class="notice" role="status">${this._notice}</p>` : nothing}
      ${this._tab === 'new' ? this._newScan() : this._history()}
    </div>`
  }

  _newScan() {
    const mode = this._mode
    const bundle = this._bundle
    const files = mode === 'code' ? this._files : (bundle?.files ?? [])
    const excluded = this._excluded
    const excludedModules = this._excludedModules
    const included = files.filter((file) => !excluded.has(file.path) && !excludedModules.has(file.module))
    const modules = [...new Set(files.map((file) => file.module))].toSorted((a, b) => {
      const sizeA = files.filter((file) => file.module === a).reduce((sum, file) => sum + file.bytes, 0)
      const sizeB = files.filter((file) => file.module === b).reduce((sum, file) => sum + file.bytes, 0)
      return sizeB - sizeA || this._packageLabel(a).localeCompare(this._packageLabel(b))
    })
    const moduleCounts = new Map(modules.map((module) => [module, files.filter((file) => file.module === module).length]))
    const moduleSizes = new Map(modules.map((module) => [module, files.filter((file) => file.module === module).reduce((sum, file) => sum + file.bytes, 0)]))
    const previewFiles = files.slice(0, 80)
    const includedPackages = modules.filter((module) => !excludedModules.has(module)).length
    const selectedReports = this._reports.filter((report) => this._selectedReportIds.has(report.id))
    return html`<div class="setup">
      <section class="panel mode-panel" aria-labelledby="scan-mode-heading">
        <div class="panel-head"><h2 id="scan-mode-heading">Scan mode</h2><p>Choose what the server should analyze</p></div>
        <div class="mode-grid" role="tablist" aria-label="Scan mode">
          ${[['dependencies', 'Dependency alerts', 'Revalidate incoming alerts against actual code'], ['code', 'Code', 'Run a full scan of the codebase'], ['agentic', 'Agentic', 'Free-form analysis with your instructions'], ['report', 'Report', 'Refine and deduplicate existing reports']].map(([id, label, text]) => html`<button type="button" role="tab" aria-selected=${mode === id} class=${`mode-option ${mode === id ? 'active' : ''}`} @click=${() => this._changeMode(id)}><span class="mode-title">${SCAN_MODE_ICONS[id]}<strong>${label}</strong></span><span>${text}</span></button>`)}
        </div>
        ${mode === 'code' ? html`<div class="subtype-wrap"><div class="subtype-options" role="radiogroup" aria-label="Code subtype">${[['security', 'Security', 'Security findings only.'], ['generic', 'Generic', 'Free-form code scan: wide-scoped, most results.'], ['correctness', 'Correctness', 'Guided correctness scan.']].map(([id, label, text]) => html`<button type="button" role="radio" aria-checked=${this._options.analyzer === id} class=${`subtype-option ${this._options.analyzer === id ? 'active' : ''}`} @click=${() => this._setOption('analyzer', id)}><strong>${label}</strong><span>${text}</span></button>`)}</div><p class="subtype-help">Focusing controls how effort is spent: while Generic can also find security issues, a focused Security scan is likely to find more.</p></div>` : nothing}
      </section>
      ${mode === 'report' ? this._reportInputPanel(selectedReports) : this._sourcePanel(bundle, files)}
      ${mode === 'code' ? html`<section class="panel scope-panel">
        <div class="scope-head"><h2>Code scope</h2><p>${included.length} of ${files.length} files · ${includedPackages} of ${modules.length} packages included</p></div>
        <div class="scope-toolbar"><label class="scope-field"><span>Scope</span><select id="scan-reason" aria-label="Choose scan scope" .value=${this._reason === 'all' ? '' : this._reason} @change=${(e) => this._changeReason(e)}><option value="">All files</option>${(bundle?.reasons ?? []).filter((reason) => reason.id !== 'all').map((reason) => html`<option value=${reason.id}>${reason.label ?? reason.id}</option>`)}</select></label><div class="scope-field scope-summary-field"><span>Selection</span><div class="scope-selection"><strong>${included.length}</strong><span>files ready to scan</span></div></div></div>
        <div class="scope-grid"><section class="scope-pane package-pane" aria-label="Packages in bundle"><div class="pane-head"><strong>Packages</strong><span>${modules.length} total · sorted by size</span></div><div class="package-list">${modules.map((module) => { const count = moduleCounts.get(module) ?? 0; const includedCount = files.filter((file) => file.module === module && !excluded.has(file.path)).length; const isIncluded = !excludedModules.has(module); return html`<label class=${`package-row ${isIncluded ? '' : 'excluded'}`} title=${`${count} files · ${formatBytes(moduleSizes.get(module) ?? 0)}`}><input type="checkbox" .checked=${isIncluded} @change=${(_event) => this._toggleModule(module)}><span class="package-name">${this._packageLabel(module)}</span><span class="package-size">${formatBytes(moduleSizes.get(module) ?? 0)} · ${includedCount}/${count}</span></label>` })}</div></section><section class="scope-pane file-panel" aria-label="Largest files in bundle"><div class="pane-head"><strong>Largest files</strong><span>showing ${previewFiles.length} of ${files.length}</span></div>${files.length === 0 ? html`<p class="empty">The server did not return files for this selection.</p>` : html`<div class="file-list">${previewFiles.map((file) => { const isIncluded = !excluded.has(file.path) && !excludedModules.has(file.module); return html`<label class=${`file ${isIncluded ? '' : 'excluded'}`}><input type="checkbox" .checked=${isIncluded} @change=${(e) => this._toggleFile(file, e.target.checked)}><span class="file-copy"><span class="file-path" title=${file.path}>${file.path}</span><span class="file-meta">${file.size} · ${this._packageLabel(file.module)}</span></span></label>` })}</div>`}</section></div>
      </section>` : nothing}
      ${mode === 'agentic' ? html`<section class="panel agentic-panel"><div class="panel-head"><h2>Agentic scope</h2><p>The selected scope chooses the graphs the server will use</p></div><div class="agentic-fields"><label class="field"><span>Scope</span><select id="scan-agentic-scope" aria-label="Choose agentic scope" .value=${this._reason === 'all' ? '' : this._reason} @change=${(e) => this._changeReason(e)}><option value="">All graphs</option>${(bundle?.reasons ?? []).filter((reason) => reason.id !== 'all').map((reason) => html`<option value=${reason.id}>${reason.label ?? reason.id}</option>`)}</select></label><label class="field prompt-field"><span>Prompt</span><textarea rows="3" placeholder="What should the agent focus on?" .value=${this._prompt} @input=${(e) => { this._prompt = e.target.value }}></textarea></label></div></section>` : nothing}
      ${this._optionsPanel(mode, bundle, mode === 'report' ? selectedReports.length : included.length)}
    </div>`
  }

  _sourcePanel(bundle, files) {
    const bundles = this._repoBundles
    return html`<section class="panel source-panel"><div class="panel-head"><h2>Source</h2><p>${this._repo?.label ?? 'Repository'} · ${bundles.length} ${bundles.length === 1 ? 'bundle' : 'bundles'}</p></div><div class="source-choice"><label class="field"><span>Repository</span><select aria-label="Choose repository" .value=${this._selectedRepoId ?? ''} @change=${(e) => this._selectRepoById(e.target.value)}>${this._repositories.map((repo) => html`<option value=${repo.id}>${repo.label}</option>`)}</select></label><label class="field"><span>Bundle</span>${bundles.length > 0 ? html`<select aria-label="Choose bundle" .value=${bundle?.id ?? ''} @change=${(e) => this._selectBundleById(e.target.value)}>${bundles.map((item) => html`<option value=${item.id}>${item.filename} · ${item.size} · ${item.files.length} files</option>`)}</select>` : html`<div class="choice-empty">No stored bundles for this repository.</div>`}</label><div class="bundle-stats" aria-label="Bundle statistics"><div class="metric"><strong>${bundle?.size ?? '—'}</strong><span>bundle size</span></div><div class="metric"><strong>${files.length}</strong><span>files</span></div><div class="metric"><strong>${new Set(files.map((file) => file.module)).size}</strong><span>packages</span></div></div></div></section>`
  }

  _reportInputPanel(selectedReports) {
    return html`<section class="panel report-inputs"><div class="panel-head"><h2>Reports</h2><p>${selectedReports.length} selected · choose one or more inputs</p></div><div class="report-list">${this._reports.map((report) => { const logo = REPORT_LOGOS[report.analyzer] ?? REPORT_LOGOS.default; const location = report.repo === 'Unattached' ? 'Unattached' : `${report.repo}${report.directory ? `/${report.directory}` : ''}`; return html`<label class="report-option"><input type="checkbox" .checked=${this._selectedReportIds.has(report.id)} @change=${(e) => this._toggleReport(report.id, e.target.checked)}>${unsafeHTML(logo)}<span class="report-option-copy"><strong>${report.filename}</strong><span>${location} · ${report.size}</span></span></label>` })}</div></section>`
  }

  _optionsPanel(mode, bundle, count) {
    const summary = mode === 'report' ? `${count} reports selected` : `${bundle?.filename ?? 'No bundle selected'} · ${count} files will be analyzed`
    const disabled = mode === 'report' ? count === 0 : bundle == null || count === 0
    return html`<section class="panel options"><div class="options-grid"><scan-model-picker ?has-extra=${mode === 'code'} .value=${this._options.model} .effort=${this._options.effort} @model-change=${(event) => { this._options = { ...this._options, model: event.detail.model, effort: event.detail.effort } }}>${mode === 'code' ? html`<label slot="effort-extra" class="effort-switch"><span class="effort-switch-label">List</span><span class="effort-switch-control"><input type="checkbox" .checked=${this._options.isolate} @change=${(e) => this._setOption('isolate', e.target.checked)}><span class="switch-track" aria-hidden="true"></span></span><span class="effort-switch-label">Isolate</span><small>deeper search at ~10x the tokens spent</small></label>` : nothing}</scan-model-picker></div><div class="options-footer"><button type="button" class="run" ?disabled=${disabled} @click=${() => this._runScan()}>Run scan</button><span class="summary">${summary}</span></div><div class="checks"><label class="switch"><input type="checkbox" .checked=${this._options.cached} @change=${(e) => this._setOption('cached', e.target.checked)}><span class="switch-track" aria-hidden="true"></span><span>Offline mode</span></label></div></section>`
  }

  _history() {
    return html`<section class="panel history"><div class="panel-head"><h2>Scan history</h2><p>${this._scans.length} scans</p></div>${this._scans.length === 0 ? html`<p class="empty">No scans yet.</p>` : this._scans.map((scan) => this._scanRow(scan))}</section>`
  }

  _scanRow(scan) {
    const reportAction = scan.status === 'completed'
      ? (scan.reportSaved ? html`<button type="button" class="action" @click=${() => this._deleteSavedReport(scan)}>Delete saved report</button>` : html`<button type="button" class="action" @click=${() => this._saveReport(scan)}>Save report</button>`)
      : nothing
    return html`<div class="scan-row"><div class="scan-main"><div class="scan-title"><strong>${scan.bundleName}</strong><span class=${`status ${scan.status}`}>${scan.status}</span></div><span class="scan-meta">${scan.reason} · ${scan.files} files · ${scan.createdAt}${scan.duration ? ` · ${scan.duration}` : ''}${scan.reportSaved ? ' · Report saved' : scan.status === 'completed' ? ' · Report available' : ''}</span></div><span class="scan-actions">${reportAction}${scan.status === 'running' ? html`<button type="button" class="action" @click=${() => this._stopScan(scan)}>Stop</button>` : nothing}${scan.status === 'stopped' ? html`<button type="button" class="action" @click=${() => this._restartScan(scan)}>Restart as new scan</button>` : nothing}</span><span aria-hidden="true"></span></div>`
  }

  _selectBundle(bundle) {
    this._selectedRepoId = bundle.repoId
    this._selectedBundleId = bundle.id
    this._reason = bundle.reasons[0]?.id ?? ''
    this._excluded = new Set()
    this._excludedModules = new Set()
    this._notice = null
  }

  _selectBundleById(id) {
    const bundle = this._bundles.find((candidate) => candidate.id === id)
    if (bundle != null) this._selectBundle(bundle)
  }

  _selectRepoById(id) {
    this._selectedRepoId = id
    const bundle = this._bundles.find((candidate) => candidate.repoId === id)
    this._selectedBundleId = bundle?.id ?? null
    this._reason = bundle?.reasons[0]?.id ?? ''
    this._excluded = new Set()
    this._excludedModules = new Set()
    this._notice = null
  }

  _changeMode(mode) {
    if (!['dependencies', 'code', 'agentic', 'report'].includes(mode) || mode === this._mode) return
    this._mode = mode
    this._excluded = new Set()
    this._excludedModules = new Set()
    this._notice = null
  }

  _toggleReport(id, selected) {
    const next = new Set(this._selectedReportIds)
    if (selected) next.add(id)
    else next.delete(id)
    this._selectedReportIds = next
  }

  _changeReason(e) {
    this._reason = e.target.value
    this._excluded = new Set()
    this._excludedModules = new Set()
  }

  _toggleFile(file, included) {
    const next = new Set(this._excluded)
    if (included) next.delete(file.path)
    else next.add(file.path)
    this._excluded = next
  }

  _toggleModule(module) {
    const next = new Set(this._excludedModules)
    if (next.has(module)) next.delete(module)
    else next.add(module)
    this._excludedModules = next
  }

  _setOption(key, value) {
    this._options = { ...this._options, [key]: value }
  }

  _runScan() {
    const mode = this._mode
    const bundle = this._bundle
    const reports = this._reports.filter((report) => this._selectedReportIds.has(report.id))
    const files = mode === 'code'
      ? this._files.filter((file) => !this._excluded.has(file.path) && !this._excludedModules.has(file.module))
      : (bundle?.files ?? [])
    if (mode === 'report' && reports.length === 0) return
    if (mode !== 'report' && (!bundle || files.length === 0)) return
    const scan = { id: `scan-${Date.now()}`, mode, bundleId: bundle?.id ?? null, bundleName: mode === 'report' ? `${reports.length} selected reports` : bundle.filename, reason: mode === 'agentic' ? this._reasonData?.label ?? 'All graphs' : mode === 'report' ? 'Report' : mode === 'code' ? this._reasonData?.label ?? 'All files' : 'Dependencies', status: 'running', createdAt: 'Just now', duration: '', files: mode === 'report' ? reports.length : files.length, reportSaved: false, isolate: mode === 'code' && this._options.isolate, model: this._options.model, effort: this._options.effort }
    this._scans = [scan, ...this._scans]
    this._tab = 'history'
    this._notice = 'Scan started. The server will update its status as work progresses.'
    const timer = setTimeout(() => {
      this._timers.delete(timer)
      if (scan.status !== 'running') return
      scan.status = 'completed'
      scan.duration = '2m 14s'
      this._notice = 'Scan completed. Its report is ready to save.'
      this.requestUpdate()
    }, 2200)
    this._timers.add(timer)
  }

  _stopScan(scan) {
    if (scan.status !== 'running') return
    scan.status = 'stopped'
    scan.duration = scan.duration || 'stopped by user'
    this._notice = 'Scan stopped. It cannot continue, but you can restart it as a new scan.'
    this.requestUpdate()
  }

  _restartScan(scan) {
    if (scan.mode === 'report') {
      this._mode = 'report'
      this._selectedReportIds = new Set(this._reports.slice(0, Math.max(1, scan.files)).map((report) => report.id))
      this._tab = 'new'
      this._notice = 'New report scan settings restored from the stopped run.'
      return
    }
    this._selectedBundleId = scan.bundleId
    const bundle = this._bundle
    this._mode = scan.mode ?? 'dependencies'
    this._selectedRepoId = bundle?.repoId ?? this._selectedRepoId
    this._reason = bundle?.reasons.find((reason) => reason.label === scan.reason)?.id ?? bundle?.reasons[0]?.id ?? ''
    this._excluded = new Set()
    this._excludedModules = new Set()
    this._tab = 'new'
    this._notice = 'New scan settings restored from the stopped run.'
  }

  _saveReport(scan) {
    scan.reportSaved = true
    this._notice = 'Report saved. You can delete it from Reports and save this completed scan again.'
    this.requestUpdate()
  }

  _deleteSavedReport(scan) {
    scan.reportSaved = false
    this._notice = 'Saved report deleted. The completed scan can be saved again.'
    this.requestUpdate()
  }
}
customElements.define('managed-admin-scans', ManagedAdminScans)

async function fetchTeams() {
  const res = await managedFetch('/api/admin/teams', { credentials: 'same-origin', headers: { accept: 'application/json' } })
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
// fetches its own data (session for CSRF + the teams payload).
class ManagedAdminTeams extends LitElement {
  static properties = {
    _data: { state: true },
    _error: { state: true },
    _busy: { state: true },
    _renamingId: { state: true },
  }

  static styles = [ADMIN_PAGE_HEADER_STYLES, ADMIN_PEOPLE_STYLES, css`
    .create-team { display: flex; align-items: center; gap: .5rem; margin-bottom: 1.2rem; }
    .create-team label { color: var(--muted); font-size: .78rem; margin-right: .25rem; }
    .new-name { width: 15rem; }
    .team { border: 1px solid var(--border); border-radius: 9px; margin-bottom: 1rem; background: var(--surface); overflow: hidden; }
    .team-head { display: flex; align-items: center; gap: .65rem; min-height: 3.6rem; padding: .8rem 1rem; border-bottom: 1px solid var(--border); }
    .team-icon { display: grid; place-items: center; flex: 0 0 auto; width: 1.9rem; height: 1.9rem; border-radius: 6px; background: rgb(from var(--accent) r g b / .1); color: var(--accent); }
    .team-icon svg { width: 1.05rem; height: 1.05rem; }
    .team-name { margin: 0; min-width: 0; font-size: 1rem; font-weight: 600; letter-spacing: -.015em; overflow-wrap: anywhere; }
    .team-actions { display: flex; gap: .25rem; margin-left: auto; }
    .rename-input { flex: 1; max-width: 22rem; width: 0; }
    .team-body { display: grid; grid-template-columns: minmax(0, .85fr) minmax(0, 1.15fr); }
    .sub { min-width: 0; padding: 1rem; }
    .sub + .sub { border-left: 1px solid var(--border); }
    .sub-title { display: flex; align-items: center; gap: .45rem; margin: 0; font-size: .82rem; font-weight: 600; }
    .sub-title .count { height: 1.1rem; min-width: 1.1rem; font-size: .65rem; padding: 0 .3rem; }
    .sub-description { display: flex; flex-direction: column; gap: .12rem; margin: .35rem 0 .65rem; color: var(--muted); font-size: .72rem; line-height: 1.4; }
    .links { list-style: none; margin: 0 0 .5rem; padding: 0; }
    .links li { display: flex; align-items: center; gap: .5rem; min-height: 2.9rem; padding: .5rem 0; }
    .links li + li { border-top: 1px solid var(--border); }
    .repo-icon { flex: 0 0 auto; color: var(--muted); width: .95rem; height: .95rem; }
    .repo-copy { display: flex; min-width: 0; flex-direction: column; gap: .2rem; }
    .ln { min-width: 0; font-size: .8rem; font-weight: 500; overflow-wrap: anywhere; }
    .path { color: var(--muted); font-family: var(--mono); font-size: .7rem; overflow-wrap: anywhere; }
    .repo-row .icon-btn { margin-left: auto; }
    .links .member-row { display: grid; grid-template-columns: minmax(0, 1fr) auto 1.8rem; gap: .45rem; }
    .member { display: flex; align-items: center; gap: .45rem; min-width: 0; }
    .member .avatar { width: 1.6rem; height: 1.6rem; font-size: .65rem; }
    .perms { display: flex; flex-wrap: wrap; gap: .3rem; }
    .perm { display: inline-flex; align-items: center; gap: .3rem; padding: .3rem .4rem; border: 1px solid var(--border); border-radius: 5px; font-size: .67rem; color: var(--muted); user-select: none; }
    .perm:has(:checked) { color: var(--text); background: rgb(from var(--accent) r g b / .07); border-color: rgb(from var(--accent) r g b / .2); }
    .perm:has(:disabled) { opacity: .5; }
    .add-row { display: flex; align-items: center; gap: .4rem; padding-top: .55rem; }
    .add-row select { flex: 1; width: 0; }
    .add-repo-path { flex: .75; width: 0; }
    .add-row .btn { flex: 0 0 auto; }
    .muted { color: var(--muted); font-size: .78rem; margin: .75rem 0; }
    @container (max-width: 57rem) {
      .team-body { grid-template-columns: 1fr; }
      .sub + .sub { border-left: 0; border-top: 1px solid var(--border); }
      .add-row { max-width: 36rem; }
    }
    @container (max-width: 32rem) {
      .create-team { flex-wrap: wrap; }
      .create-team label { flex-basis: 100%; }
      .new-name { flex: 1; width: 0; }
      .team-head, .sub { padding-left: .75rem; padding-right: .75rem; }
      .links .member-row { grid-template-columns: minmax(0, 1fr) 1.8rem; }
      .perms { grid-row: 2; padding-left: 2.05rem; }
      .member-row > .icon-btn { grid-column: 2; grid-row: 1; }
      .add-row { flex-wrap: wrap; }
      .add-repo-sel { flex-basis: calc(100% - 4rem) !important; }
      .add-repo-path { order: 1; flex-basis: 100%; }
    }
  `]

  constructor() {
    super()
    this._data = null
    this._error = null
    this._csrf = null
    this._busy = false
    this._renamingId = null
  }

  connectedCallback() {
    super.connectedCallback()
    void this._load()
  }

  async _load() {
    this._error = null
    try {
      const [session, data] = await Promise.all([fetchSession(), fetchTeams()])
      this._csrf = session?.csrfToken ?? null
      this._data = data
    } catch (err) {
      this._error = String(err?.message ?? err)
    }
  }

  // Run a mutation then reload; surfaces failures on the page.
  async _do(fn) {
    if (this._busy) return
    this._busy = true
    this._error = null
    try { await fn() } catch (err) { this._error = String(err?.message ?? err) }
    finally { this._busy = false; await this._load() }
  }

  render() {
    return html`<div class="wrap">
      <div class="head">
        ${adminBackButton()}
        <h1>Teams</h1>
        ${this._data?.teams ? html`<span class="count">${this._data.teams.length}</span>` : nothing}
      </div>
      <p class="intro">Group repositories and give members access to the findings they need.</p>
      <div class="create-team">
        <label for="new-team-name">New team</label>
        <input id="new-team-name" class="new-name" type="text" placeholder="Team name" maxlength="100" ?disabled=${this._busy}
          @keydown=${(e) => { if (e.key === 'Enter') this._create() }}>
        <button class="btn primary" ?disabled=${this._busy} @click=${() => this._create()}>${ADMIN_PLUS_ICON} Create team</button>
      </div>
      ${this._body()}
    </div>`
  }

  _body() {
    if (this._error != null && this._data == null) return html`<p class="msg error">Couldn't load teams: ${this._error}</p>`
    if (this._data == null) return html`<p class="msg">Loading…</p>`
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
        <p class="sub-description"><span>Membership includes the scan’s standard non-security findings.</span><span>Add underlying dependency or security findings per member.</span></p>
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
      <button class="icon-btn danger" aria-label=${`Remove ${r.fullName} from ${team.name}`} ?disabled=${this._busy} @click=${() => this._do(() => postTeam('/api/admin/teams/remove-repo', this._csrf, { teamId: team.id, repoId: r.repoId }))}>${ADMIN_REMOVE_ICON}</button>
    </li>`
  }

  _addRepoRow(team) {
    const repos = Array.isArray(this._data.repos) ? this._data.repos : []
    if (repos.length === 0) return html`<p class="muted">No selected repositories to link — pick some on “Manage repositories”.</p>`
    const linked = new Set(team.repos.map((r) => r.repoId))
    return html`<div class="add-row">
      <select class="add-repo-sel" aria-label=${`Repository to add to ${team.name}`} ?disabled=${this._busy}>
        <option value="">Add repository…</option>
        ${repos.map((r) => html`<option value=${r.repoId}>${r.fullName}${linked.has(r.repoId) ? ' — update path' : ''}</option>`)}
      </select>
      <input class="add-repo-path" type="text" placeholder="Path (optional)" aria-label=${`Repository path in ${team.name} (optional)`} maxlength="500" ?disabled=${this._busy}>
      <button class="btn" aria-label=${`Add repository to ${team.name}`} ?disabled=${this._busy} @click=${(e) => this._addRepo(team, e)}>${ADMIN_PLUS_ICON} Add</button>
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
      <select class="add-member-sel" aria-label=${`Member to add to ${team.name}`} ?disabled=${this._busy}>
        <option value="">Add member…</option>
        ${users.map((u) => html`<option value=${u.id} ?disabled=${member.has(u.id)}>${u.login}${member.has(u.id) ? ' (member)' : ''}</option>`)}
      </select>
      <button class="btn" aria-label=${`Add member to ${team.name}`} ?disabled=${this._busy} @click=${(e) => this._addMember(team, e)}>${ADMIN_PLUS_ICON} Add</button>
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
    const repoId = Number(row?.querySelector('.add-repo-sel')?.value)
    if (!Number.isSafeInteger(repoId) || repoId <= 0) return
    const path = row?.querySelector('.add-repo-path')?.value ?? ''
    void this._do(() => postTeam('/api/admin/teams/set-repo', this._csrf, { teamId: team.id, repoId, path }))
  }

  _addMember(team, e) {
    const userId = e.target.closest('.add-row')?.querySelector('.add-member-sel')?.value
    if (!userId) return
    void this._do(() => postTeam('/api/admin/teams/set-member', this._csrf, { teamId: team.id, userId }))
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
