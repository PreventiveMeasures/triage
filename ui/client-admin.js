// Managed admin UI bundle — its own esbuild entry (out/client-admin.js), loaded
// lazily and ONLY when an admin/manage user opens one of its pages (the sidebar
// account menu rows). None of this ships in the main view bundle, nor to
// unprivileged / e2e / standalone sessions. Two pages, each a full-view custom
// element created by render.js:
//   <managed-admin-users>  — the users list with per-user role pickers
//                            (currentView 'admin-users', admin only)
//   <managed-admin-repos>  — the connected GitHub repositories list
//                            (currentView 'manage-repos', admin|manage)
//
// This is a SEPARATE chunk, so importing the main bundle's `state` would get a
// duplicated (empty) copy — the current user (for the CSRF token + self-disable)
// is fetched here from /api/auth/session instead.
import { LitElement, css, html, nothing } from 'lit'
import { ROLES } from '../common/managed/roles.ts'
import { VISIBILITY_PERMISSION_LABELS } from '../common/managed/permissions.ts'

async function fetchSession() {
  const res = await fetch('/api/auth/session', { credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!res.ok) return null
  const body = await res.json()
  return { id: body?.user?.id ?? null, csrfToken: typeof body?.csrfToken === 'string' ? body.csrfToken : null }
}

async function fetchUsers() {
  const res = await fetch('/api/admin/users', { credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  return Array.isArray(body?.users) ? body.users : []
}

async function setRole(userId, role, csrfToken) {
  const headers = { 'content-type': 'application/json' }
  if (csrfToken) headers['x-csrf-token'] = csrfToken
  const res = await fetch('/api/admin/set-role', {
    method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ userId, role }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

class ManagedAdminUsers extends LitElement {
  static properties = {
    _users: { state: true },
    _error: { state: true },
  }

  static styles = css`
    :host { display: block; padding: 1.5rem clamp(1rem, 4vw, 2.5rem); color: var(--text); }
    .wrap { max-width: 48rem; margin: 0 auto; }
    h1 { font-size: 1.15rem; font-weight: 600; margin: 0 0 1rem; user-select: none; }
    .users { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .users li { display: flex; align-items: center; gap: .7rem; padding: .55rem .85rem; }
    .users li + li { border-top: 1px solid var(--border); }
    .avatar {
      position: relative; flex-shrink: 0; width: 28px; height: 28px;
      border-radius: 50%; overflow: hidden; background: var(--accent);
      display: inline-grid; place-items: center; user-select: none;
    }
    .avatar > span { font-size: .8rem; font-weight: 600; color: var(--bg); text-transform: uppercase; }
    .avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .avatar img.broken { display: none; }
    .who { display: flex; flex-direction: column; min-width: 0; }
    .login { font-weight: 600; font-size: .9rem; }
    .name { color: var(--muted); font-size: .8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .role {
      margin-left: auto; flex-shrink: 0; font: inherit; font-size: .82rem;
      color: var(--text); background: var(--bg);
      border: 1px solid var(--border); border-radius: 6px; padding: .2rem .4rem;
    }
    .role:disabled { opacity: .55; }
    .msg { color: var(--muted); font-size: .9rem; }
    .msg.error { color: var(--critical, #c00); }
  `

  constructor() {
    super()
    this._users = null
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
      const [session, users] = await Promise.all([fetchSession(), fetchUsers()])
      this._me = session?.id ?? null
      this._csrf = session?.csrfToken ?? null
      this._users = users
    } catch (err) {
      this._error = String(err?.message ?? err)
    }
  }

  render() {
    return html`<div class="wrap">
      <h1>Users</h1>
      ${this._error == null
        ? (this._users == null ? html`<p class="msg">Loading…</p>` : this._list())
        : html`<p class="msg error">Couldn't load users: ${this._error}</p>`}
    </div>`
  }

  _list() {
    if (this._users.length === 0) return html`<p class="msg">No users yet.</p>`
    return html`<ul class="users">${this._users.map((u) => this._row(u))}</ul>`
  }

  _row(u) {
    const initial = (u.login?.[0] ?? '?').toUpperCase()
    const isSelf = u.id === this._me
    return html`<li>
      <span class="avatar">
        <span>${initial}</span>
        <img alt="" src=${`/api/avatar/${encodeURIComponent(u.id)}`} @error=${(e) => e.currentTarget.classList.add('broken')}>
      </span>
      <span class="who">
        <span class="login">${u.login}</span>
        ${u.name ? html`<span class="name">${u.name}</span>` : nothing}
      </span>
      <select class="role" ?disabled=${isSelf}
        title=${isSelf ? 'You can’t change your own role' : 'Change role'}
        @change=${(e) => this._changeRole(u, e.target.value, e.target)}>
        ${ROLES.map((r) => html`<option value=${r} ?selected=${r === u.role}>${r}</option>`)}
      </select>
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
}
customElements.define('managed-admin-users', ManagedAdminUsers)

async function fetchRepositories() {
  const res = await fetch('/api/admin/repositories', { credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// Toggle whether a repo is in the operate-on set (the server verifies access +
// records the read context, or drops the row). CSRF via the double-submit token.
async function selectRepository(repoId, selected, csrfToken) {
  const headers = { 'content-type': 'application/json' }
  if (csrfToken) headers['x-csrf-token'] = csrfToken
  const res = await fetch('/api/admin/repositories/select', {
    method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify({ repoId, selected }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

// GitHub repo glyph (book-with-bookmark), tinted via currentColor.
const REPO_ICON = html`<svg class="repo-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
  <path d="M2 2.75A2.75 2.75 0 0 1 4.75 0h7.5a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75H4.5a1 1 0 0 0 0 2h8a.75.75 0 0 1 0 1.5h-8A2.5 2.5 0 0 1 2 13V2.75Zm2.75-.25a1.25 1.25 0 0 0-1.25 1.25v7.32c.317-.114.66-.07 1 .18V2.5h-.5a.25.25 0 0 0 .75 0Zm6.75 0H5.5v8.5h6V2.5Z"/>
</svg>`

// Repositories — full-view page for admin/manage, in two tabs:
//   "Manage repositories" (default) — only repos connected through the GitHub
//      App (installed), i.e. the ones whose contents we can actually read.
//   "Select repositories" — every reachable repo (PUBLIC via the login token +
//      PRIVATE via the installed App) with a checkbox to add/remove it from the
//      operate-on set; the server records enough context to read each one.
// "Connect a repository" installs the App. Own chunk, so it fetches its own data
// (session for the CSRF token + the repo list); no main-bundle state.
class ManagedAdminRepos extends LitElement {
  static properties = {
    _data: { state: true },
    _error: { state: true },
    _tab: { state: true },
  }

  static styles = css`
    :host { display: block; padding: 1.5rem clamp(1rem, 4vw, 2.5rem); color: var(--text); }
    .wrap { max-width: 48rem; margin: 0 auto; }
    .head { display: flex; align-items: center; gap: 1rem; margin: 0 0 .75rem; }
    h1 { font-size: 1.15rem; font-weight: 600; margin: 0; user-select: none; }
    .connect {
      margin-left: auto; flex-shrink: 0; font-size: .85rem; font-weight: 600;
      color: var(--bg); background: var(--accent); text-decoration: none;
      border-radius: 6px; padding: .35rem .7rem; white-space: nowrap;
    }
    .connect:hover { opacity: .9; }
    .tabs { display: flex; gap: .25rem; margin: 0 0 1rem; border-bottom: 1px solid var(--border); }
    .tab {
      font: inherit; font-size: .85rem; font-weight: 600; color: var(--muted);
      background: none; border: none; border-bottom: 2px solid transparent;
      margin-bottom: -1px; padding: .4rem .55rem; cursor: pointer; user-select: none;
    }
    .tab:hover { color: var(--text); }
    .tab.active { color: var(--text); border-bottom-color: var(--accent); }
    .hint { color: var(--muted); font-size: .82rem; margin: 0 0 .8rem; }
    .repos { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .repos li { display: flex; align-items: center; gap: .6rem; padding: .55rem .85rem; }
    .repos li + li { border-top: 1px solid var(--border); }
    .select { flex-shrink: 0; width: 16px; height: 16px; accent-color: var(--accent); cursor: pointer; }
    .repo-icon { flex-shrink: 0; color: var(--muted); }
    .full-name { font-weight: 600; font-size: .9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge {
      flex-shrink: 0; font-size: .7rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: .03em; color: var(--muted); border: 1px solid var(--border);
      border-radius: 999px; padding: .05rem .4rem;
    }
    .open { margin-left: auto; flex-shrink: 0; font-size: .82rem; color: var(--accent); text-decoration: none; }
    .open:hover { text-decoration: underline; }
    .msg { color: var(--muted); font-size: .9rem; line-height: 1.5; }
    .msg.error { color: var(--critical, #c00); }
  `

  constructor() {
    super()
    this._data = null
    this._error = null
    this._csrf = null
    this._tab = 'manage' // 'manage' (installed only) | 'select' (all + checkboxes)
  }

  connectedCallback() {
    super.connectedCallback()
    void this._load()
  }

  async _load() {
    this._error = null
    this._data = null
    try {
      const [session, data] = await Promise.all([fetchSession(), fetchRepositories()])
      this._csrf = session?.csrfToken ?? null
      this._data = data
    } catch (err) {
      this._error = String(err?.message ?? err)
    }
  }

  render() {
    const url = this._data?.installUrl
    return html`<div class="wrap">
      <div class="head">
        <h1>Repositories</h1>
        ${url ? html`<a class="connect" href=${url} target="_blank" rel="noopener noreferrer">Connect a repository</a>` : nothing}
      </div>
      <div class="tabs" role="tablist">
        <button type="button" role="tab" class="tab ${this._tab === 'manage' ? 'active' : ''}"
          aria-selected=${this._tab === 'manage'} @click=${() => { this._tab = 'manage' }}>Manage repositories</button>
        <button type="button" role="tab" class="tab ${this._tab === 'select' ? 'active' : ''}"
          aria-selected=${this._tab === 'select'} @click=${() => { this._tab = 'select' }}>Select repositories</button>
      </div>
      ${this._body()}
    </div>`
  }

  _body() {
    if (this._error != null) return html`<p class="msg error">Couldn't load repositories: ${this._error}</p>`
    if (this._data == null) return html`<p class="msg">Loading…</p>`
    const repos = Array.isArray(this._data.repositories) ? this._data.repositories : []
    if (repos.length === 0 && this._data.tokenMissing) {
      return html`<p class="msg">We don't have current GitHub access for your account. Please
        <strong>log out and log back in</strong> to grant repository access.</p>`
    }
    return this._tab === 'select' ? this._selectView(repos) : this._manageView(repos)
  }

  // Default tab — only repositories connected through the GitHub App (installed),
  // the ones whose contents we can read.
  _manageView(repos) {
    const installed = repos.filter((r) => r.installed)
    if (installed.length === 0) {
      return html`<p class="msg">No repositories connected yet. ${this._data.installUrl
        ? html`Use “Connect a repository” to install the GitHub App on the repositories you want to read.`
        : html`Install the GitHub App on the repositories you want to read.`}</p>`
    }
    return html`<p class="hint">Connected through the GitHub App — we can read these repositories.</p>
      <ul class="repos">${installed.map((r) => this._row(r, false))}</ul>`
  }

  // "Select repositories" tab — every reachable repo, with a checkbox to add it
  // to / remove it from the operate-on set.
  _selectView(repos) {
    if (repos.length === 0) {
      return html`<p class="msg">No repositories found. ${this._data.installUrl
        ? html`Use “Connect a repository” to install the GitHub App on the private repositories you want.`
        : html`Public repositories you own appear here.`}</p>`
    }
    return html`
      ${this._data.tokenMissing
        ? html`<p class="hint">Some public repositories may be hidden — log out and back in to refresh GitHub access.</p>`
        : nothing}
      <p class="hint">Check a repository to operate on it — we'll read its contents.</p>
      <ul class="repos">${repos.map((r) => this._row(r, true))}</ul>`
  }

  _row(r, selectable) {
    return html`<li>
      ${selectable
        ? html`<input type="checkbox" class="select" .checked=${r.selected === true}
            title=${r.selected ? 'Selected — remove from the operate-on set' : 'Select this repository to operate on'}
            @change=${(e) => this._toggle(r, e.target)}>`
        : nothing}
      ${REPO_ICON}
      <span class="full-name">${r.fullName}</span>
      ${r.private ? html`<span class="badge">private</span>` : nothing}
      ${r.htmlUrl ? html`<a class="open" href=${r.htmlUrl} target="_blank" rel="noopener noreferrer">open</a>` : nothing}
    </li>`
  }

  async _toggle(r, el) {
    const next = el.checked
    try {
      await selectRepository(r.id, next, this._csrf)
      r.selected = next
    } catch (err) {
      console.warn('admin: repo selection failed:', err)
      el.checked = !next // revert the box; server rejected the change
    }
    this.requestUpdate() // refresh the row (checked state + title) from r.selected
  }
}
customElements.define('managed-admin-repos', ManagedAdminRepos)

async function fetchReports() {
  const res = await fetch('/api/admin/reports', { credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// Upload one report file: the raw bytes as the body, the display name in the
// X-Report-Filename header, an optional repo link in X-Repo-Id, CSRF via the
// double-submit token. The server stores the bytes + records the
// metadata/attribution + auto-links the bundle. Throws with the status word the
// row surfaces (e.g. 413 → too large).
async function uploadReport(file, csrfToken, repoId) {
  const headers = { 'content-type': file.type || 'application/json', 'x-report-filename': encodeURIComponent(file.name) }
  if (csrfToken) headers['x-csrf-token'] = csrfToken
  if (repoId != null) headers['x-repo-id'] = String(repoId)
  const res = await fetch('/api/admin/reports', { method: 'POST', credentials: 'same-origin', headers, body: file })
  if (!res.ok) throw new Error(res.status === 413 ? 'too large' : `HTTP ${res.status}`)
  return res.json()
}

async function deleteReport(id, csrfToken) {
  const headers = csrfToken ? { 'x-csrf-token': csrfToken } : {}
  const res = await fetch(`/api/admin/reports/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin', headers })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

// Human byte size (B / KB / MB) for the report / bundle rows.
function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return ''
  if (n < 1024) return `${n} B`
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1_048_576).toFixed(1)} MB`
}

// Shared upload-page chrome (reports + bundles): an optional repo picker — only
// shown when the workspace has selected repos — plus the file-picker trigger.
// `selected` is the chosen repo id (number) or '' for none.
function repoPickerTemplate(repos, selected, onChange) {
  if (!Array.isArray(repos) || repos.length === 0) return nothing
  return html`<select class="repo-select" title="Link uploads to a repository"
    @change=${(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}>
    <option value="" ?selected=${selected === ''}>No repo</option>
    ${repos.map((r) => html`<option value=${r.repoId} ?selected=${r.repoId === selected}>${r.fullName}</option>`)}
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

// Document glyph (file-with-lines), tinted via currentColor.
const REPORT_ICON = html`<svg class="report-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
  <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 10 4.25V1.5Zm7.75.689V4.25c0 .138.112.25.25.25h2.061ZM4.5 8.75A.75.75 0 0 1 5.25 8h5.5a.75.75 0 0 1 0 1.5h-5.5A.75.75 0 0 1 4.5 8.75Zm0 2.5a.75.75 0 0 1 .75-.75h5.5a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1-.75-.75Z"/>
</svg>`

// Reports — full-view page for admin/manage. Uploads a report (any findings
// format — JSON / markdown / CSV — archived as-is for the server to operate on)
// and lists what's stored, with per-report download + delete and uploader
// attribution. Own chunk, so it fetches its own data (session for the CSRF token
// + the report list); no main-bundle state.
class ManagedAdminReports extends LitElement {
  static properties = {
    _data: { state: true },
    _error: { state: true },
    _busy: { state: true },
    _dragOver: { state: true },
  }

  static styles = css`
    :host { display: block; position: relative; padding: 1.5rem clamp(1rem, 4vw, 2.5rem); color: var(--text); }
    .wrap { max-width: 48rem; margin: 0 auto; }
    .dropzone {
      position: absolute; inset: .6rem; z-index: 5; display: grid; place-items: center;
      border: 2px dashed var(--accent); border-radius: 10px;
      background: rgb(from var(--bg) r g b / .9); color: var(--accent);
      font-size: 1rem; font-weight: 600; pointer-events: none;
    }
    .head { display: flex; align-items: center; gap: 1rem; margin: 0 0 .75rem; }
    h1 { font-size: 1.15rem; font-weight: 600; margin: 0; user-select: none; }
    .upload {
      margin-left: auto; flex-shrink: 0; font: inherit; font-size: .85rem; font-weight: 600;
      color: var(--bg); background: var(--accent); border: none; cursor: pointer;
      border-radius: 6px; padding: .35rem .7rem; white-space: nowrap;
    }
    .upload:hover { opacity: .9; }
    .upload:disabled { opacity: .55; cursor: default; }
    .repo-select {
      margin-left: auto; flex-shrink: 0; font: inherit; font-size: .82rem;
      color: var(--text); background: var(--bg);
      border: 1px solid var(--border); border-radius: 6px; padding: .2rem .4rem; max-width: 16rem;
    }
    .repo-select + .upload { margin-left: .5rem; }
    .hint { color: var(--muted); font-size: .82rem; margin: 0 0 .8rem; }
    .reports { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .reports li { display: flex; align-items: center; gap: .6rem; padding: .55rem .85rem; }
    .reports li + li { border-top: 1px solid var(--border); }
    .report-icon { flex-shrink: 0; color: var(--muted); }
    .who { display: flex; flex-direction: column; min-width: 0; }
    .filename { font-weight: 600; font-size: .9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta { color: var(--muted); font-size: .78rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .actions { margin-left: auto; flex-shrink: 0; display: flex; gap: .7rem; align-items: center; }
    .download { font-size: .82rem; color: var(--accent); text-decoration: none; }
    .download:hover { text-decoration: underline; }
    .delete {
      font: inherit; font-size: .82rem; color: var(--critical, #c00); background: none;
      border: none; cursor: pointer; padding: 0;
    }
    .delete:hover { text-decoration: underline; }
    .msg { color: var(--muted); font-size: .9rem; line-height: 1.5; }
    .msg.error { color: var(--critical, #c00); }
  `

  constructor() {
    super()
    this._data = null
    this._error = null
    this._csrf = null
    this._busy = false
    this._repoId = '' // '' = no repo link; otherwise a selected repo id
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
      const [session, data] = await Promise.all([fetchSession(), fetchReports()])
      this._csrf = session?.csrfToken ?? null
      this._data = data
    } catch (err) {
      this._error = String(err?.message ?? err)
    }
  }

  render() {
    return html`
      ${this._dragOver ? html`<div class="dropzone">Drop reports to upload</div>` : nothing}
      <div class="wrap">
      <div class="head">
        <h1>Reports</h1>
        ${repoPickerTemplate(this._data?.repos, this._repoId, (v) => { this._repoId = v })}
        <button type="button" class="upload" ?disabled=${this._busy} @click=${() => pickFiles((files) => void this._upload(files))}>
          ${this._busy ? 'Uploading…' : 'Upload report'}
        </button>
      </div>
      ${this._body()}
    </div>`
  }

  _body() {
    if (this._error != null) return html`<p class="msg error">Couldn't load reports: ${this._error}</p>`
    if (this._data == null) return html`<p class="msg">Loading…</p>`
    const reports = Array.isArray(this._data.reports) ? this._data.reports : []
    if (reports.length === 0) {
      return html`<p class="msg">No reports uploaded yet. Drag &amp; drop files here, or use “Upload report”,
        to add a findings report (JSON, markdown, or CSV) for the server to operate on.</p>`
    }
    return html`<p class="hint">Reports stored on the server.</p>
      <ul class="reports">${reports.map((r) => this._row(r))}</ul>`
  }

  _row(r) {
    const who = r.uploadedByLogin ? `by ${r.uploadedByLogin}` : 'uploader removed'
    const when = Number.isFinite(r.uploadedAt) ? new Date(r.uploadedAt).toLocaleString() : ''
    // bundle: linked filename when present; else note the report declared a
    // bundle that isn't uploaded yet (so the link is pending).
    const bundle = r.bundleFilename ? `bundle: ${r.bundleFilename}`
      : (r.bundleIntegrity ? 'bundle: (not uploaded)' : null)
    const meta = [who, when, formatBytes(r.byteSize), r.repoFullName ? `repo: ${r.repoFullName}` : null, bundle]
      .filter(Boolean).join(' · ')
    return html`<li>
      ${REPORT_ICON}
      <span class="who">
        <span class="filename">${r.filename}</span>
        <span class="meta">${meta}</span>
      </span>
      <span class="actions">
        <a class="download" href=${`/api/admin/reports/${encodeURIComponent(r.id)}`}>download</a>
        <button type="button" class="delete" @click=${() => this._delete(r)}>delete</button>
      </span>
    </li>`
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
        const repoId = this._repoId === '' ? null : this._repoId
        await uploadReport(file, this._csrf, repoId)
      }
    } catch (err) {
      this._queue = [] // fail-fast: drop the rest of the batch (matches the old behaviour)
      this._error = `Upload failed: ${String(err?.message ?? err)}`
    } finally {
      this._busy = false
      await this._load() // refresh the list (and surface any partial success)
    }
  }

  async _delete(r) {
    if (!globalThis.confirm?.(`Delete “${r.filename}”? This can't be undone.`)) return
    try {
      await deleteReport(r.id, this._csrf)
    } catch (err) {
      this._error = `Delete failed: ${String(err?.message ?? err)}`
    }
    await this._load()
  }
}
customElements.define('managed-admin-reports', ManagedAdminReports)

async function fetchBundles() {
  const res = await fetch('/api/admin/bundles', { credentials: 'same-origin', headers: { accept: 'application/json' } })
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
  const res = await fetch('/api/admin/bundles', { method: 'POST', credentials: 'same-origin', headers, body: file })
  if (!res.ok) throw new Error(res.status === 413 ? 'too large' : `HTTP ${res.status}`)
  return res.json()
}

async function deleteBundle(id, csrfToken) {
  const headers = csrfToken ? { 'x-csrf-token': csrfToken } : {}
  const res = await fetch(`/api/admin/bundles/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin', headers })
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

  static styles = css`
    :host { display: block; position: relative; padding: 1.5rem clamp(1rem, 4vw, 2.5rem); color: var(--text); }
    .wrap { max-width: 48rem; margin: 0 auto; }
    .dropzone {
      position: absolute; inset: .6rem; z-index: 5; display: grid; place-items: center;
      border: 2px dashed var(--accent); border-radius: 10px;
      background: rgb(from var(--bg) r g b / .9); color: var(--accent);
      font-size: 1rem; font-weight: 600; pointer-events: none;
    }
    .head { display: flex; align-items: center; gap: 1rem; margin: 0 0 .75rem; }
    h1 { font-size: 1.15rem; font-weight: 600; margin: 0; user-select: none; }
    .upload {
      flex-shrink: 0; font: inherit; font-size: .85rem; font-weight: 600;
      color: var(--bg); background: var(--accent); border: none; cursor: pointer;
      border-radius: 6px; padding: .35rem .7rem; white-space: nowrap;
    }
    .upload:hover { opacity: .9; }
    .upload:disabled { opacity: .55; cursor: default; }
    .repo-select {
      margin-left: auto; flex-shrink: 0; font: inherit; font-size: .82rem;
      color: var(--text); background: var(--bg);
      border: 1px solid var(--border); border-radius: 6px; padding: .2rem .4rem; max-width: 16rem;
    }
    .repo-select + .upload { margin-left: .5rem; }
    .head > .upload:only-of-type { margin-left: auto; }
    .hint { color: var(--muted); font-size: .82rem; margin: 0 0 .8rem; }
    .reports { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .reports li { display: flex; align-items: center; gap: .6rem; padding: .55rem .85rem; }
    .reports li + li { border-top: 1px solid var(--border); }
    .report-icon { flex-shrink: 0; color: var(--muted); }
    .who { display: flex; flex-direction: column; min-width: 0; }
    .filename { font-weight: 600; font-size: .9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta { color: var(--muted); font-size: .78rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge {
      flex-shrink: 0; font-size: .7rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: .03em; color: var(--muted); border: 1px solid var(--border);
      border-radius: 999px; padding: .05rem .4rem;
    }
    .actions { margin-left: auto; flex-shrink: 0; display: flex; gap: .7rem; align-items: center; }
    .download { font-size: .82rem; color: var(--accent); text-decoration: none; }
    .download:hover { text-decoration: underline; }
    .delete {
      font: inherit; font-size: .82rem; color: var(--critical, #c00); background: none;
      border: none; cursor: pointer; padding: 0;
    }
    .delete:hover { text-decoration: underline; }
    .msg { color: var(--muted); font-size: .9rem; line-height: 1.5; }
    .msg.error { color: var(--critical, #c00); }
  `

  constructor() {
    super()
    this._data = null
    this._error = null
    this._csrf = null
    this._busy = false
    this._repoId = ''
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
      <div class="head">
        <h1>Bundles</h1>
        ${repoPickerTemplate(this._data?.repos, this._repoId, (v) => { this._repoId = v })}
        <button type="button" class="upload" ?disabled=${this._busy} @click=${() => pickFiles((files) => void this._upload(files))}>
          ${this._busy ? 'Uploading…' : 'Upload bundle'}
        </button>
      </div>
      ${this._body()}
    </div>`
  }

  _body() {
    if (this._error != null) return html`<p class="msg error">Couldn't load bundles: ${this._error}</p>`
    if (this._data == null) return html`<p class="msg">Loading…</p>`
    const bundles = Array.isArray(this._data.bundles) ? this._data.bundles : []
    if (bundles.length === 0) {
      return html`<p class="msg">No bundles uploaded yet. Drag &amp; drop files here, or use “Upload bundle”,
        to add a sourcemap or stasis archive for the server to operate on; reports auto-link by content hash.</p>`
    }
    return html`<p class="hint">Bundles stored on the server.</p>
      <ul class="reports">${bundles.map((b) => this._row(b))}</ul>`
  }

  _row(b) {
    const who = b.uploadedByLogin ? `by ${b.uploadedByLogin}` : 'uploader removed'
    const when = Number.isFinite(b.uploadedAt) ? new Date(b.uploadedAt).toLocaleString() : ''
    const meta = [who, when, formatBytes(b.byteSize), b.repoFullName ? `repo: ${b.repoFullName}` : null]
      .filter(Boolean).join(' · ')
    return html`<li title=${b.integrity ?? ''}>
      ${BUNDLE_ICON}
      <span class="who">
        <span class="filename">${b.filename}</span>
        <span class="meta">${meta}</span>
      </span>
      ${b.kind ? html`<span class="badge">${b.kind}</span>` : nothing}
      <span class="actions">
        <a class="download" href=${`/api/admin/bundles/${encodeURIComponent(b.id)}`}>download</a>
        <button type="button" class="delete" @click=${() => this._delete(b)}>delete</button>
      </span>
    </li>`
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
        const repoId = this._repoId === '' ? null : this._repoId
        await uploadBundle(file, this._csrf, repoId)
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

async function fetchTeams() {
  const res = await fetch('/api/admin/teams', { credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// POST a team mutation (create / delete / link / unlink). CSRF via the
// double-submit token. Surfaces 409 (duplicate name) as a friendly word.
async function postTeam(path, csrfToken, body) {
  const headers = { 'content-type': 'application/json' }
  if (csrfToken) headers['x-csrf-token'] = csrfToken
  const res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers, body: JSON.stringify(body) })
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

  static styles = css`
    :host { display: block; padding: 1.5rem clamp(1rem, 4vw, 2.5rem); color: var(--text); }
    .wrap { max-width: 48rem; margin: 0 auto; }
    .head { display: flex; align-items: center; gap: .5rem; margin: 0 0 1rem; }
    h1 { font-size: 1.15rem; font-weight: 600; margin: 0 auto 0 0; user-select: none; }
    input, select {
      font: inherit; font-size: .82rem; color: var(--text); background: var(--bg);
      border: 1px solid var(--border); border-radius: 6px; padding: .25rem .4rem;
    }
    .new-name { width: 12rem; }
    .btn {
      font: inherit; font-size: .82rem; font-weight: 600; color: var(--bg); background: var(--accent);
      border: none; border-radius: 6px; padding: .3rem .6rem; cursor: pointer; white-space: nowrap;
    }
    .btn:hover { opacity: .9; }
    .btn:disabled { opacity: .55; cursor: default; }
    .team { border: 1px solid var(--border); border-radius: 8px; padding: .85rem; margin: 0 0 1rem; }
    .team-head { display: flex; align-items: center; gap: .6rem; margin: 0 0 .6rem; }
    .team-name { font-weight: 600; font-size: 1rem; }
    .rename-input { width: 12rem; }
    .sub { margin: .5rem 0 0; }
    .sub-title { font-size: .72rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 .3rem; }
    .links { list-style: none; margin: 0 0 .4rem; padding: 0; }
    .links li { display: flex; align-items: center; gap: .6rem; padding: .25rem 0; }
    .ln { font-size: .88rem; }
    .path { color: var(--muted); font-size: .82rem; }
    .perms { margin-left: auto; display: flex; gap: .8rem; }
    .perm { display: inline-flex; align-items: center; gap: .25rem; font-size: .8rem; color: var(--muted); user-select: none; }
    .add-row { display: flex; align-items: center; gap: .4rem; margin: .3rem 0 0; flex-wrap: wrap; }
    .add-row select { max-width: 16rem; }
    .x { font: inherit; font-size: .8rem; color: var(--critical, #c00); background: none; border: none; cursor: pointer; padding: 0; }
    .x:hover { text-decoration: underline; }
    .delete { margin-left: auto; }
    .muted { color: var(--muted); font-size: .82rem; margin: 0 0 .3rem; }
    .msg { color: var(--muted); font-size: .9rem; }
    .msg.error { color: var(--critical, #c00); }
  `

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
        <h1>Teams</h1>
        <input class="new-name" type="text" placeholder="New team name" maxlength="100"
          @keydown=${(e) => { if (e.key === 'Enter') this._create() }}>
        <button class="btn" ?disabled=${this._busy} @click=${() => this._create()}>Create</button>
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
    return html`<div class="team">
      <div class="team-head">
        ${this._renamingId === team.id
          ? html`<input class="rename-input" type="text" .value=${team.name} maxlength="100"
              @keydown=${(e) => this._renameKey(e, team)}>
            <button class="btn" ?disabled=${this._busy} @click=${(e) => this._saveRename(team, e)}>save</button>
            <button class="x" @click=${() => { this._renamingId = null }}>cancel</button>`
          : html`<span class="team-name">${team.name}</span>
            <button class="x" @click=${() => { this._renamingId = team.id }}>rename</button>
            <button class="x delete" @click=${() => this._deleteTeam(team)}>delete team</button>`}
      </div>
      <div class="sub">
        <div class="sub-title">Repositories</div>
        ${team.repos.length === 0 ? html`<p class="muted">No repositories linked.</p>`
          : html`<ul class="links">${team.repos.map((r) => this._repoRow(team, r))}</ul>`}
        ${this._addRepoRow(team)}
      </div>
      <div class="sub">
        <div class="sub-title">Members</div>
        ${team.members.length === 0 ? html`<p class="muted">No members.</p>`
          : html`<ul class="links">${team.members.map((m) => this._memberRow(team, m))}</ul>`}
        ${this._addMemberRow(team)}
      </div>
    </div>`
  }

  _repoRow(team, r) {
    return html`<li>
      <span class="ln">${r.fullName}${r.path ? html` <span class="path">/${r.path}</span>` : nothing}</span>
      <button class="x" @click=${() => this._do(() => postTeam('/api/admin/teams/remove-repo', this._csrf, { teamId: team.id, repoId: r.repoId }))}>remove</button>
    </li>`
  }

  _addRepoRow(team) {
    const repos = Array.isArray(this._data.repos) ? this._data.repos : []
    if (repos.length === 0) return html`<p class="muted">No selected repositories to link — pick some on “Manage repositories”.</p>`
    const linked = new Set(team.repos.map((r) => r.repoId))
    return html`<div class="add-row">
      <select class="add-repo-sel">
        <option value="">Add repository…</option>
        ${repos.map((r) => html`<option value=${r.repoId}>${r.fullName}${linked.has(r.repoId) ? ' — update path' : ''}</option>`)}
      </select>
      <input class="add-repo-path" type="text" placeholder="subpath (optional)" maxlength="500">
      <button class="btn" @click=${(e) => this._addRepo(team, e)}>add</button>
    </div>`
  }

  _memberRow(team, m) {
    const perms = Array.isArray(this._data.permissions) ? this._data.permissions : []
    return html`<li>
      <span class="ln">${m.login}</span>
      <span class="perms">
        ${perms.map((p) => html`<label class="perm">
          <input type="checkbox" .checked=${m[p] === true}
            @change=${(e) => this._togglePerm(team, m, p, e.target.checked)}>
          ${VISIBILITY_PERMISSION_LABELS[p] ?? p}
        </label>`)}
      </span>
      <button class="x" @click=${() => this._do(() => postTeam('/api/admin/teams/remove-member', this._csrf, { teamId: team.id, userId: m.userId }))}>remove</button>
    </li>`
  }

  _addMemberRow(team) {
    const users = Array.isArray(this._data.users) ? this._data.users : []
    const member = new Set(team.members.map((m) => m.userId))
    return html`<div class="add-row">
      <select class="add-member-sel">
        <option value="">Add member…</option>
        ${users.map((u) => html`<option value=${u.id} ?disabled=${member.has(u.id)}>${u.login}${member.has(u.id) ? ' (member)' : ''}</option>`)}
      </select>
      <button class="btn" @click=${(e) => this._addMember(team, e)}>add</button>
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

export { ManagedAdminBundles, ManagedAdminReports, ManagedAdminRepos, ManagedAdminTeams, ManagedAdminUsers }
