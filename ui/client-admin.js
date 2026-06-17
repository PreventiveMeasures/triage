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
// X-Report-Filename header, CSRF via the double-submit token. The server stores
// the bytes + records the metadata/attribution. Throws with the status word the
// row surfaces (e.g. 413 → too large).
async function uploadReport(file, csrfToken) {
  const headers = { 'content-type': file.type || 'application/json', 'x-report-filename': encodeURIComponent(file.name) }
  if (csrfToken) headers['x-csrf-token'] = csrfToken
  const res = await fetch('/api/admin/reports', { method: 'POST', credentials: 'same-origin', headers, body: file })
  if (!res.ok) throw new Error(res.status === 413 ? 'too large' : `HTTP ${res.status}`)
  return res.json()
}

async function deleteReport(id, csrfToken) {
  const headers = csrfToken ? { 'x-csrf-token': csrfToken } : {}
  const res = await fetch(`/api/admin/reports/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin', headers })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

// Human byte size (B / KB / MB) for the report rows.
function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return ''
  if (n < 1024) return `${n} B`
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1_048_576).toFixed(1)} MB`
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
  }

  static styles = css`
    :host { display: block; padding: 1.5rem clamp(1rem, 4vw, 2.5rem); color: var(--text); }
    .wrap { max-width: 48rem; margin: 0 auto; }
    .head { display: flex; align-items: center; gap: 1rem; margin: 0 0 .75rem; }
    h1 { font-size: 1.15rem; font-weight: 600; margin: 0; user-select: none; }
    .upload {
      margin-left: auto; flex-shrink: 0; font: inherit; font-size: .85rem; font-weight: 600;
      color: var(--bg); background: var(--accent); border: none; cursor: pointer;
      border-radius: 6px; padding: .35rem .7rem; white-space: nowrap;
    }
    .upload:hover { opacity: .9; }
    .upload:disabled { opacity: .55; cursor: default; }
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
  }

  connectedCallback() {
    super.connectedCallback()
    void this._load()
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
    return html`<div class="wrap">
      <div class="head">
        <h1>Reports</h1>
        <button type="button" class="upload" ?disabled=${this._busy} @click=${() => this._pickFiles()}>
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
      return html`<p class="msg">No reports uploaded yet. Use “Upload report” to add a findings report
        (JSON, markdown, or CSV) for the server to operate on.</p>`
    }
    return html`<p class="hint">Reports stored on the server.</p>
      <ul class="reports">${reports.map((r) => this._row(r))}</ul>`
  }

  _row(r) {
    const who = r.uploadedByLogin ? `by ${r.uploadedByLogin}` : 'uploader removed'
    const when = Number.isFinite(r.uploadedAt) ? new Date(r.uploadedAt).toLocaleString() : ''
    const meta = [who, when, formatBytes(r.byteSize)].filter(Boolean).join(' · ')
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

  // Open a file picker (hidden input, created on demand) and upload whatever is
  // chosen — sequentially, so one failure stops cleanly.
  _pickFiles() {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.addEventListener('change', () => { void this._upload([...input.files]) }, { once: true })
    input.click()
  }

  async _upload(files) {
    if (files.length === 0 || this._busy) return
    this._busy = true
    this._error = null
    try {
      for (const file of files) await uploadReport(file, this._csrf)
    } catch (err) {
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

export { ManagedAdminReports, ManagedAdminRepos, ManagedAdminUsers }
