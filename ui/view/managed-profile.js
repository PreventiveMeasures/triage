import { LitElement, html, nothing } from 'lit'
import { live } from 'lit/directives/live.js'
import { chooseProfileAccounts, fetchProfile, getPreviewRole, unlinkGithubAccount } from './client-managed.js'

// Where linking another GitHub account starts (server-managed/github-link-oauth.ts):
// a top-level navigation to GitHub and back to this page.
const LINK_PATH = '/api/oauth/github/link'

// Why GitHub's answer could not be linked, as the server names it on return.
const LINK_ERRORS = {
  'github-account-own': 'That is the account you sign in with. On GitHub, pick or add the other account to link.',
  'github-account-registered': 'That GitHub account has signed in here before, so it is a user of its own and cannot be linked.',
  'github-account-linked': 'That GitHub account is already linked to another user.',
  'github-authorization-declined': 'Linking was cancelled on GitHub.',
  'invalid-oauth-state': 'The link request expired or was started from another session. Try again.',
}

const linkedDate = time => new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

// The signed-in user's profile: their avatar and name, and the GitHub accounts
// linked to theirs, which of them the displayed name and avatar come from. The
// login always stays the sign-in account's.
export class ManagedProfile extends LitElement {
  static properties = { session: { attribute: false }, linkError: { attribute: false },
    _profile: { state: true }, _pending: { state: true }, _busy: { state: true }, _error: { state: true }, _avatarRevision: { state: true } }
  constructor() { super(); this._profile = null; this._avatarRevision = 0; this._controller = new AbortController() }
  createRenderRoot() { return this }
  disconnectedCallback() { super.disconnectedCallback(); this._controller.abort(); this._key = null }
  // An admin viewing as this user, and the console preview, change nothing.
  get _readOnly() { return Boolean(this.session?.viewer) || getPreviewRole() !== null }
  async _load() {
    const key = this._key
    this._busy = true
    this._error = null
    try {
      const profile = await fetchProfile({ signal: this._controller.signal })
      if (key === this._key) this._profile = profile
    } catch (error) { if (key === this._key && error.name !== 'AbortError') this._error = error.message }
    finally { if (key === this._key) this._busy = false }
  }
  async _change(work) {
    if (this._busy || this._readOnly) return
    const key = this._key
    this._busy = true
    this._error = null
    try {
      const profile = await work(this.session.csrfToken, { signal: this._controller.signal })
      if (key !== this._key) return
      const avatarChanged = profile.avatarAccount !== this._profile?.avatarAccount
      if (avatarChanged) this._avatarRevision++
      this._profile = profile
      // The account control shows the displayed name and avatar too.
      document.dispatchEvent(new CustomEvent('managed-profile-change', { detail: { userId: this.session.id, name: profile.name, avatarChanged } }))
    } catch (error) { if (key === this._key && error.name !== 'AbortError') this._error = error.message }
    finally { if (key === this._key) { this._busy = false; this._pending = null } }
  }
  // The choice shows as made while it saves, and reverts if it fails.
  _choose(kind, id) {
    if (this._busy || this._readOnly) return Promise.resolve()
    this._pending = { [`${kind}Account`]: id }
    return this._change((csrfToken, options) => chooseProfileAccounts({ [kind]: id }, csrfToken, options))
  }
  _unlink(account) {
    return this._change((csrfToken, options) => unlinkGithubAccount(account.id, csrfToken, options))
  }
  // The avatar a user id serves is the chosen one; `own` asks for the sign-in
  // account's. The revision refetches the chosen one once it changes.
  _avatar(id, { own = false, initial, large = false } = {}) {
    const src = `/api/avatar/${encodeURIComponent(id)}${own ? '?own' : this._avatarRevision ? `?v=${this._avatarRevision}` : ''}`
    return html`<span class=${`managed-profile-avatar${large ? ' is-large' : ''}`} aria-hidden="true">
      <span>${(initial[0] ?? '?').toUpperCase()}</span>
      ${getPreviewRole() ? nothing : html`<img alt="" src=${src} @error=${e => e.currentTarget.classList.add('broken')}>`}</span>`
  }
  _account({ id, login, name, linkedAt }, profile) {
    const own = id === null
    const disabled = this._busy || this._readOnly
    return html`<tr>
      <td><span class="managed-profile-account">${this._avatar(own ? this.session.id : id, { own, initial: login })}
        <span><a href=${`https://github.com/${encodeURIComponent(login)}`} target="_blank" rel="noreferrer">@${login}</a>
          <span class="managed-profile-muted">${own ? 'Sign-in account' : linkedAt === null ? 'Linked' : `Linked ${linkedDate(linkedAt)}`}</span></span></span></td>
      <td><label class="managed-profile-choice"><input type="radio" name="managed-profile-name" .checked=${live(profile.nameAccount === id)} ?disabled=${disabled}
          aria-label=${`Use @${login}'s name`} @change=${() => this._choose('name', id)}>
        ${name ? html`<span>${name}</span>` : html`<span class="managed-profile-muted">No name</span>`}</label></td>
      <td><label class="managed-profile-choice"><input type="radio" name="managed-profile-avatar" .checked=${live(profile.avatarAccount === id)} ?disabled=${disabled}
          aria-label=${`Use @${login}'s avatar`} @change=${() => this._choose('avatar', id)}><span class="managed-profile-muted">Avatar</span></label></td>
      <td>${own ? nothing : html`<button type="button" class="npm-review-button" ?disabled=${disabled}
        aria-label=${`Unlink @${login}`} @click=${() => this._unlink({ id, login })}>Unlink</button>`}</td>
    </tr>`
  }
  render() {
    const key = JSON.stringify([this.session?.id, this.session?.role])
    if (key !== this._key) {
      this._controller.abort()
      this._controller = new AbortController()
      this._key = key
      this._profile = null
      void this._load()
    }
    const profile = this._profile
    const login = profile?.login ?? this.session?.login ?? ''
    const name = profile ? profile.name : this.session?.name ?? null
    const linkError = this.linkError ? LINK_ERRORS[this.linkError] ?? `Could not link the account (${this.linkError}).` : null
    return html`<section class="managed-profile">
      <header class="managed-profile-card">
        ${this._avatar(this.session?.id ?? '', { initial: login, large: true })}
        <div><h1>${name || `@${login}`}</h1>${name ? html`<p class="managed-profile-muted">@${login}</p>` : nothing}</div>
      </header>
      ${linkError ? html`<p class="managed-profile-error" role="alert">${linkError}</p>` : nothing}
      ${this._error ? html`<p class="managed-profile-error" role="alert">${this._error}</p>` : nothing}
      <section class="managed-profile-section" aria-labelledby="managed-profile-accounts">
        <h2 id="managed-profile-accounts">GitHub accounts</h2>
        <p class="managed-profile-muted">You sign in as @${login}. Your name and avatar can come from any of your accounts.
          A linked account cannot sign in or register here.</p>
        ${profile ? html`<table class="managed-profile-accounts">
          <thead><tr><th scope="col">Account</th><th scope="col">Name</th><th scope="col">Avatar</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
          <tbody>${[{ id: null, login: profile.login, name: profile.githubName, linkedAt: null }, ...profile.accounts]
            .map(account => this._account(account, { ...profile, ...this._pending }))}</tbody>
        </table>` : nothing}
        ${this._readOnly ? html`<p class="managed-profile-muted">${this.session?.viewer ? 'Viewing as another user is read only.' : 'The preview changes nothing.'}</p>`
          : html`<a class="npm-review-button npm-review-primary" href=${LINK_PATH}>Link GitHub account</a>
            <p class="managed-profile-muted">GitHub asks which account to link: pick or add the other account there.</p>`}
      </section>
    </section>`
  }
}
customElements.define('managed-profile', ManagedProfile)
