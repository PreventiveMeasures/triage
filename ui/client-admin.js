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

// GitHub repo glyph (book-with-bookmark), tinted via currentColor.
const REPO_ICON = html`<svg class="repo-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
  <path d="M2 2.75A2.75 2.75 0 0 1 4.75 0h7.5a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75H4.5a1 1 0 0 0 0 2h8a.75.75 0 0 1 0 1.5h-8A2.5 2.5 0 0 1 2 13V2.75Zm2.75-.25a1.25 1.25 0 0 0-1.25 1.25v7.32c.317-.114.66-.07 1 .18V2.5h-.5a.25.25 0 0 0 .75 0Zm6.75 0H5.5v8.5h6V2.5Z"/>
</svg>`

// Connected GitHub repositories — full-view page for admin/manage. Read-only:
// the list comes from the GitHub App's installation tokens (see
// server-managed/github-app.ts); "Connect a repository" hands off to GitHub's
// App-install page. Own chunk, so it fetches its own data (no main-bundle state).
class ManagedAdminRepos extends LitElement {
  static properties = {
    _data: { state: true },
    _error: { state: true },
  }

  static styles = css`
    :host { display: block; padding: 1.5rem clamp(1rem, 4vw, 2.5rem); color: var(--text); }
    .wrap { max-width: 48rem; margin: 0 auto; }
    .head { display: flex; align-items: center; gap: 1rem; margin: 0 0 1rem; }
    h1 { font-size: 1.15rem; font-weight: 600; margin: 0; user-select: none; }
    .connect {
      margin-left: auto; flex-shrink: 0; font-size: .85rem; font-weight: 600;
      color: var(--bg); background: var(--accent); text-decoration: none;
      border-radius: 6px; padding: .35rem .7rem; white-space: nowrap;
    }
    .connect:hover { opacity: .9; }
    .repos { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .repos li { display: flex; align-items: center; gap: .6rem; padding: .55rem .85rem; }
    .repos li + li { border-top: 1px solid var(--border); }
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
    code { font-size: .85em; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 0 .25em; }
  `

  constructor() {
    super()
    this._data = null
    this._error = null
  }

  connectedCallback() {
    super.connectedCallback()
    void this._load()
  }

  async _load() {
    this._error = null
    this._data = null
    try {
      this._data = await fetchRepositories()
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
      ${this._body()}
    </div>`
  }

  _body() {
    if (this._error != null) return html`<p class="msg error">Couldn't load repositories: ${this._error}</p>`
    if (this._data == null) return html`<p class="msg">Loading…</p>`
    if (!this._data.configured) {
      return html`<p class="msg">The GitHub App isn't configured on this server. An operator needs to set
        <code>GITHUB_APP_ID</code>, <code>GITHUB_APP_PRIVATE_KEY</code>, and <code>GITHUB_APP_SLUG</code>,
        granting the App the repository <strong>Contents: Read-only</strong> permission.</p>`
    }
    const repos = Array.isArray(this._data.repositories) ? this._data.repositories : []
    if (repos.length === 0) {
      return html`<p class="msg">No repositories connected yet. Use “Connect a repository” to install the
        GitHub App on the repositories you want to read.</p>`
    }
    return html`<ul class="repos">${repos.map((r) => this._row(r))}</ul>`
  }

  _row(r) {
    return html`<li>
      ${REPO_ICON}
      <span class="full-name">${r.fullName}</span>
      ${r.private ? html`<span class="badge">private</span>` : nothing}
      ${r.htmlUrl ? html`<a class="open" href=${r.htmlUrl} target="_blank" rel="noopener noreferrer">open</a>` : nothing}
    </li>`
  }
}
customElements.define('managed-admin-repos', ManagedAdminRepos)

export { ManagedAdminRepos, ManagedAdminUsers }
