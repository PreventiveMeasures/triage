// The code page: a repository, a revision and a directory picked as Create a
// bundle picks them (RepositoryBrowser), opened in the code viewer
// (ui/view/repository-code.js) at the revision's commit, whole or at a file.
import { html, nothing, unsafeCSS } from 'lit'
import { sourceFileIcon } from '../view/source-file-icon.js'
import { ManagedPage } from './page.js'
import { adminNavigation } from './navigation.js'
import { RepositoryBrowser } from './repository-browser.js'
import commonStyles from './styles/common.css'
import styles from './styles/repository-code.css'

export class ManagedRepositoryCode extends RepositoryBrowser {
  static styles = [...RepositoryBrowser.styles, unsafeCSS(styles)]
  static properties = { ...RepositoryBrowser.properties, _scoped: { state: true }, _opening: { state: true } }

  constructor() {
    super()
    this._scoped = false
    this._opening = false
  }

  // A directory the reader's grants reach only part of lists those parts
  // alone, and opens none (handleRepositoryCode).
  showDirectory(data) {
    this._scoped = data?.scoped === true
  }

  // The directory browsed, at its commit, Code on `file` (its path in the
  // repository) where one is picked. Navigation replaces this page.
  open(file = null) {
    const repo = this.repository()
    if (!repo || !/^[a-f\d]{40}$/iu.test(this._commit) || this._scoped || this._loading) return
    const prefix = this._path ? `${this._path}/` : ''
    this._opening = true
    this.dispatchEvent(new CustomEvent('managed-repository-code-open', { bubbles: true, composed: true, detail: {
      repoId: repo.repoId, repo: repo.fullName, commit: this._commit.toLowerCase(), path: this._path,
      ...file?.startsWith(prefix) ? { file: file.slice(prefix.length) } : {},
    } }))
  }

  render() {
    const ready = Boolean(this.repository()) && /^[a-f\d]{40}$/iu.test(this._commit) && this._entries != null && !this._loading && !this._error
    const where = this._path || this.repository()?.fullName || 'this directory'
    return html`<p class="intro ui-hint">Choose a repository and revision, then open a directory’s files, or one of them, in the code viewer.</p>
      <div ?inert=${this._opening}>
      ${this.renderSource()}
      ${this.renderBrowser(entry => entry.type === 'file' && !this._scoped
        ? html`<button type="button" class="file-tile file" @click=${() => this.open(entry.path)}>${sourceFileIcon(entry.name)}<span data-tooltip-truncated data-tooltip=${entry.path}>${entry.name}</span></button>`
        : html`<span class="file-tile unsupported" data-tooltip=${`${entry.path} (${entry.type})`}>${sourceFileIcon(entry.name)}<span>${entry.name}</span></span>`)}
      <div class="code-actions">
        <p class="note ui-hint" role="status">${this._scoped ? 'Your teams reach only some of this directory. Open one of the directories it lists.'
          : ready ? html`Opens every file under <code>${where}</code> at <code>${this._commit.slice(0, 7)}</code>.` : nothing}</p>
        <button type="button" class="btn primary" ?disabled=${!ready || this._scoped || this._opening} @click=${() => this.open()}>${this._opening ? 'Opening…' : 'Open code'}</button>
      </div>
      </div>`
  }
}

customElements.define('managed-repository-code', ManagedRepositoryCode)

// The code page, among the manage pages, for admins and managers: what they
// may browse, they may read.
export class ManagedAdminCode extends ManagedPage {
  static properties = { ...ManagedPage.properties, repoId: { attribute: false }, installTooltips: { attribute: false } }
  static styles = [unsafeCSS(commonStyles)]

  constructor() {
    super()
    this.repoId = null
    this.installTooltips = null
  }

  render() {
    return html`<div class="wrap">${adminNavigation('manage-code', this._role, this.allowShare)}
      <h1 class="sr-only">Code</h1>
      <managed-repository-code .initialRepoId=${this.repoId ?? null} .installTooltips=${this.installTooltips}></managed-repository-code>
    </div>`
  }
}

customElements.define('managed-admin-code', ManagedAdminCode)
