// Managed admin UI bundle — its own esbuild entry (out/client-admin.js),
// loaded lazily and ONLY when an admin opens it (see view/client-admin.js +
// the sidebar "Manage users" row). None of this ships in the main view bundle,
// nor to non-admin / e2e / standalone sessions. First component: the users
// list, shown in a modal dialog.
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
    dialog {
      border: 1px solid var(--border); border-radius: 8px; padding: 0;
      min-width: 22rem; max-width: min(34rem, 92vw); max-height: 80vh;
      background: var(--surface, var(--bg)); color: var(--text);
      box-shadow: 0 8px 30px rgb(0 0 0 / .3);
    }
    dialog::backdrop { background: rgb(0 0 0 / .45); }
    header {
      display: flex; align-items: center; justify-content: space-between;
      padding: .55rem .35rem .55rem .8rem; border-bottom: 1px solid var(--border);
    }
    h2 { margin: 0; font-size: .92rem; font-weight: 600; }
    .close { background: transparent; border: 0; color: var(--muted); font-size: 1rem; padding: .25rem .5rem; line-height: 1; }
    .close:hover { color: var(--text); }
    .users { list-style: none; margin: 0; padding: .35rem; max-height: 62vh; overflow-y: auto; }
    .users li { display: flex; align-items: center; gap: .5rem; padding: .4rem .5rem; border-radius: 4px; }
    .users li + li { border-top: 1px solid rgb(from var(--text) r g b / .06); }
    .u-login { font-weight: 600; font-size: .85rem; }
    .u-name { color: var(--muted); font-size: .8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .u-admin {
      margin-left: auto; flex-shrink: 0; font-size: .64rem; text-transform: uppercase;
      letter-spacing: .04em; color: var(--accent);
      border: 1px solid var(--accent); border-radius: 999px; padding: .05rem .4rem;
    }
    .msg { color: var(--muted); padding: 1.1rem; font-size: .85rem; }
    .msg.error { color: var(--critical, #c00); }
  `

  constructor() {
    super()
    this._users = null
    this._error = null
  }

  async open() {
    document.body.append(this)
    await this.updateComplete
    this.renderRoot.querySelector('dialog')?.showModal()
    try { this._users = await fetchUsers() }
    catch (err) { this._error = String(err?.message ?? err) }
  }

  _dialog() { return this.renderRoot.querySelector('dialog') }

  render() {
    return html`<dialog @close=${() => this.remove()} @click=${(e) => this._onClick(e)}>
      <header>
        <h2>Users</h2>
        <button type="button" class="close" aria-label="Close" @click=${() => this._dialog()?.close()}>✕</button>
      </header>
      ${this._error == null
        ? (this._users == null
          ? html`<p class="msg">Loading…</p>`
          : this._list())
        : html`<p class="msg error">Couldn't load users: ${this._error}</p>`}
    </dialog>`
  }

  _list() {
    if (this._users.length === 0) return html`<p class="msg">No users yet.</p>`
    return html`<ul class="users">${this._users.map((u) => html`<li>
      <span class="u-login">${u.login}</span>
      ${u.name ? html`<span class="u-name">${u.name}</span>` : nothing}
      ${u.isAdmin ? html`<span class="u-admin">admin</span>` : nothing}
    </li>`)}</ul>`
  }

  // Click on the dialog element itself (the backdrop area, not its content)
  // closes it.
  _onClick(e) {
    if (e.target === this._dialog()) this._dialog()?.close()
  }
}
customElements.define('managed-admin-users', ManagedAdminUsers)

export function openAdminUsers() {
  return new ManagedAdminUsers().open()
}
