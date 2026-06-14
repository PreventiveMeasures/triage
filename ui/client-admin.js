// Managed admin UI bundle — its own esbuild entry (out/client-admin.js), loaded
// lazily and ONLY when an admin opens it (the sidebar "Manage users" row, which
// navigates to the 'admin-users' view). None of this ships in the main view
// bundle, nor to non-admin / e2e / standalone sessions. First page: the users
// list, rendered as a full view by <managed-admin-users> (created by render.js
// when currentView is 'admin-users').
import { LitElement, css, html, nothing } from 'lit'

async function fetchUsers() {
  const res = await fetch('/api/admin/users', { credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  return Array.isArray(body?.users) ? body.users : []
}

class ManagedAdminUsers extends LitElement {
  static properties = {
    _users: { state: true },
    _error: { state: true },
  }

  static styles = css`
    :host { display: block; padding: 1.5rem clamp(1rem, 4vw, 2.5rem); color: var(--text); }
    .wrap { max-width: 48rem; margin: 0 auto; }
    h1 { font-size: 1.15rem; font-weight: 600; margin: 0 0 1rem; }
    .users { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .users li { display: flex; align-items: center; gap: .7rem; padding: .6rem .85rem; }
    .users li + li { border-top: 1px solid var(--border); }
    .avatar {
      position: relative; flex-shrink: 0; width: 28px; height: 28px;
      border-radius: 50%; overflow: hidden; background: var(--accent);
      display: inline-grid; place-items: center;
    }
    .avatar > span { font-size: .8rem; font-weight: 600; color: var(--bg); text-transform: uppercase; }
    .avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .avatar img.broken { display: none; }
    .who { display: flex; flex-direction: column; min-width: 0; }
    .login { font-weight: 600; font-size: .9rem; }
    .name { color: var(--muted); font-size: .8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .admin {
      margin-left: auto; flex-shrink: 0; font-size: .64rem; text-transform: uppercase;
      letter-spacing: .04em; color: var(--accent);
      border: 1px solid var(--accent); border-radius: 999px; padding: .05rem .45rem;
    }
    .msg { color: var(--muted); font-size: .9rem; }
    .msg.error { color: var(--critical, #c00); }
  `

  constructor() {
    super()
    this._users = null
    this._error = null
  }

  connectedCallback() {
    super.connectedCallback()
    void this._load()
  }

  async _load() {
    this._error = null
    this._users = null
    try { this._users = await fetchUsers() }
    catch (err) { this._error = String(err?.message ?? err) }
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
    return html`<li>
      <span class="avatar">
        <span>${initial}</span>
        <img alt="" src=${`/api/avatar/${encodeURIComponent(u.id)}`} @error=${(e) => e.currentTarget.classList.add('broken')}>
      </span>
      <span class="who">
        <span class="login">${u.login}</span>
        ${u.name ? html`<span class="name">${u.name}</span>` : nothing}
      </span>
      ${u.isAdmin ? html`<span class="admin">admin</span>` : nothing}
    </li>`
  }
}
customElements.define('managed-admin-users', ManagedAdminUsers)

export { ManagedAdminUsers }
