import { html, nothing, unsafeCSS } from 'lit'
import { requestGithubIssue } from '../../../client/managed/issues.js'
import { AppDialog, openAppDialog } from './app-dialog.js'
import { createIssueDraft, editIssueDraft, toggleIssueDraftSection } from './issue-draft.js'
import styles from './managed-issue-dialog.css'

const ERRORS = {
  'github-unavailable': 'GitHub could not be reached. Try checking again.',
  'github-issue-forbidden': 'GitHub did not permit issue creation. Check your repository access and authorization.',
  'github-create-uncertain': 'GitHub may have created this issue. Check the repository before trying again.',
  'github-create-failed': 'GitHub could not create the issue. Check the title and description before trying again.',
  'unauthenticated': 'Your session expired. Sign in again before creating an issue.',
  'workspace-changed': 'Your workspace access changed. Reopen the finding before creating an issue.',
  'bad-issue-repository': 'The finding’s repository changed. Reopen the finding before creating an issue.',
  'no-finding': 'This finding is no longer available in this workspace.',
}

class ManagedIssueDialog extends AppDialog {
  static styles = [...AppDialog.styles, unsafeCSS(styles)]
  static properties = { teamId: { attribute: false }, context: { attribute: false }, session: { attribute: false },
    formUrl: { attribute: false }, title: { state: true }, body: { state: true }, prepared: { state: true },
    busy: { state: true }, creating: { state: true }, message: { state: true }, uncertain: { state: true }, createdUrl: { state: true },
    createdIssue: { state: true }, detailsUnavailable: { state: true }, sections: { state: true } }
  constructor() {
    super(); this.title = ''; this.body = ''; this.prepared = null; this.busy = false
    this.creating = false; this.message = ''; this.uncertain = false; this.createdUrl = ''; this.createdIssue = null; this.detailsUnavailable = false
    this.sections = []
  }
  beforeOpen() {
    if (this.finding) Object.assign(this, createIssueDraft(this.finding, this.draftOptions))
    void this.check(true)
  }
  editBody(body) { Object.assign(this, editIssueDraft(this, body)) }
  toggleSection(id, selected) { Object.assign(this, toggleIssueDraftSection(this, id, selected)) }
  current() {
    return !this._settled && this.isCurrent()
  }
  fallbackUrl() {
    const url = new URL(this.formUrl)
    url.searchParams.set('title', this.title); url.searchParams.set('body', this.body)
    if (this.prepared?.labels) url.searchParams.set('labels', this.prepared.labels.join(','))
    return url.href
  }
  async check(redirect = false) {
    if (this.busy || !this.current()) return
    this.busy = true; this.message = ''
    try {
      const prepared = await requestGithubIssue(this.teamId, this.context, this.session.csrfToken)
      if (!this.current()) return
      this.prepared = prepared
      this.uncertain = false
      if (prepared.mode === 'existing') { this.onCreated?.(prepared.url); window.location.assign(prepared.url) }
      if (redirect && prepared.mode === 'form') window.location.assign(this.fallbackUrl())
    } catch (error) {
      if (!this.uncertain && !['pending', 'created-unavailable'].includes(this.prepared?.mode)) this.prepared = null
      this.message = ERRORS[error.message] ?? 'Unable to check this issue. Please retry.'
    }
    finally { this.busy = false }
  }
  async create() {
    if (this.busy || this.uncertain || this.createdUrl || this.prepared?.mode !== 'api') return
    if (!this.current()) { this.message = ERRORS['workspace-changed']; this.prepared = null; return }
    this.busy = true; this.creating = true; this.message = ''
    try {
      const result = await requestGithubIssue(this.teamId, this.context, this.session.csrfToken, { title: this.title, body: this.body })
      if (!this.current()) return
      if (result.mode === 'existing') { this.onCreated?.(result.url); window.location.assign(result.url) }
      else if (result.url) { this.createdUrl = result.url; this.createdIssue = result.issue; this.detailsUnavailable = result.detailsUnavailable === true; this.onCreated?.(result.url) }
      else this.prepared = result
    } catch (error) {
      if (error.message === 'github-authorization-required') {
        this.prepared = { mode: 'authorize', authorizationPath: '/api/oauth/github/issues/login' }
      } else {
        this.uncertain = error.message === 'github-create-uncertain'
        if (['workspace-changed', 'bad-issue-repository', 'no-team', 'no-report', 'no-finding', 'unauthenticated', 'forbidden'].includes(error.message)) this.prepared = null
        this.message = ERRORS[error.message] ?? 'Could not create this issue. Check the title, description, and repository access.'
      }
    } finally { this.busy = false; this.creating = false }
  }
  render() {
    const issue = this.createdIssue, prepared = this.prepared
    const savedWithoutAccess = prepared?.mode === 'created-unavailable'
    const created = this.createdUrl || savedWithoutAccess
    const pending = this.uncertain || prepared?.mode === 'pending'
    const editingDisabled = this.creating || pending
    const canUseForm = !this.busy && !pending && prepared?.mode === 'form'
    return html`<dialog aria-labelledby="issue-dialog-title" @close=${this._onClose} @cancel=${event => { if (this.creating) event.preventDefault() }}>
      <header><h3 id="issue-dialog-title">${created ? 'Issue created' : 'Create a GitHub issue'}</h3></header>
      <div class="dialog-content">
      <p class="nwd-intro">${created ? 'Created' : 'Create'} in <strong>${this.context?.repository}</strong> as <strong>@${this.session?.login}</strong>.</p>
      ${this.createdUrl ? html`<section class="created-issue" aria-label="Created GitHub issue">
        <div class="issue-heading"><span class=${`issue-status ${issue?.status ?? 'open'} ${issue?.stateReason ?? ''}`}>${issue?.status === 'closed' ? issue.stateReason === 'not_planned' ? 'Not planned' : issue.stateReason === 'duplicate' ? 'Duplicate' : issue.stateReason === 'completed' ? 'Completed' : 'Closed' : 'Open'}</span>
          <span class="issue-number">${issue?.number ? `#${issue.number}` : ''}</span></div>
        <h4><a href=${this.createdUrl} target="_blank" rel="noopener">${issue?.title ?? this.title}</a></h4>
        <p class="nwd-note">Opened by @${issue?.author ?? this.session?.login}</p>
        ${issue?.labels?.length ? html`<div class="issue-labels">${issue.labels.map(label => html`<span>${label}</span>`)}</div>` : nothing}
        <div class="issue-description">${this.renderBody ? this.renderBody(issue?.description ?? this.body) : issue?.description ?? this.body}</div>
        <p class="nwd-note ui-hint">Linked permanently to this finding. The Issue button will open this issue next time.</p>
        ${this.detailsUnavailable ? html`<p class="nwd-note">GitHub’s latest details could not be loaded. The issue was created and its link is saved.</p>` : nothing}
      </section>` : savedWithoutAccess ? html`<p role="status">The issue was created and linked permanently to this finding. Its details cannot be shown because workspace access could not be confirmed. Check its status again once workspace access is available.</p>` : html`
        <label>Title<input class="nwd-input" maxlength="256" .value=${this.title} ?disabled=${editingDisabled} @input=${event => { this.title = event.target.value }}></label>
        <div class="description-heading">
          <label for="issue-description">Description</label>
          ${this.sections.length > 0 ? html`<div class="description-sections" role="group" aria-label="Include in description">
            ${this.sections.map(section => html`<label><input type="checkbox" .checked=${section.selected}
              ?disabled=${editingDisabled} @change=${event => this.toggleSection(section.id, event.target.checked)}>${section.label}</label>`)}
          </div>` : nothing}
        </div>
        <p id="description-help" class="nwd-note description-help ui-hint">${this.sections.length > 0 ? 'Add or remove sections above. Your edits are kept when toggling them.' : 'Edit the description before creating the issue.'}</p>
        <textarea id="issue-description" class="nwd-input" maxlength="65536" .value=${this.body}
          aria-describedby="description-help" ?disabled=${editingDisabled} @input=${event => this.editBody(event.target.value)}></textarea>
        ${prepared?.labels?.length ? html`<p class="nwd-note">Labels: ${prepared.labels.join(', ')}</p>` : nothing}
        ${prepared?.mode === 'permissions' ? html`<p>Ask a repository owner to approve the app’s Issues read and write permission.
          ${prepared.authorizationPath ? html`<a href=${prepared.authorizationPath} target="_blank" rel="noopener">Review repository permissions</a>` : nothing}</p>` : nothing}
        ${prepared?.mode === 'authorize' ? html`<p><a href=${prepared.authorizationPath} target="_blank" rel="noopener">Authorize GitHub</a>, then check authorization here.</p>` : nothing}
        ${prepared?.mode === 'pending' ? html`<p role="status">An issue is being created, or its creation could not be confirmed. Check its status before continuing; another issue will not be created.</p>` : nothing}
        ${prepared?.mode === 'unavailable' ? html`<p role="status">This finding already has a managed issue in a repository outside this workspace.</p>` : nothing}
      `}
      ${!this.createdUrl && this.message ? html`<p class="nwd-note" role="status">${this.message}</p>` : nothing}
      ${!this.createdUrl && this.busy ? html`<p role="status">${this.creating ? 'Creating issue…' : 'Checking repository access…'}</p>` : nothing}
      </div>
      <footer class="nwd-actions">
        ${this.createdUrl ? html`<a href=${this.createdUrl} target="_blank" rel="noopener">Open issue on GitHub</a>`
          : !this.busy && pending ? html`<a href=${prepared?.repositoryUrl ?? `https://github.com/${this.context?.repository}/issues`} target="_blank" rel="noopener">Check repository issues</a>`
          : canUseForm ? html`<a href=${this.fallbackUrl()} target="_blank" rel="noopener">Use GitHub form</a>` : nothing}
        <span class="nwd-spacer"></span>
        ${!this.createdUrl && prepared?.mode !== 'unavailable' ? prepared?.mode === 'api' && !this.uncertain
          ? html`<button class="primary" ?disabled=${this.busy || !this.title.trim()} @click=${this.create}>Create issue</button>`
          : html`<button ?disabled=${this.busy} @click=${() => this.check()}>${pending || savedWithoutAccess ? 'Check issue status' : 'Check authorization'}</button>` : nothing}
        <button ?disabled=${this.creating} @click=${() => this._finish(null)}>${created ? 'Close' : 'Cancel'}</button>
      </footer>
    </dialog>`
  }
}
customElements.define('managed-issue-dialog', ManagedIssueDialog)
export function openManagedIssueDialog(props) { return openAppDialog('managed-issue-dialog', props) }
